#!/usr/bin/env node
/**
 * Frame-time benchmark driver for the WebGL2 3D memory graph (issue #62 acceptance).
 *
 * Boots the web dev server and headless Chrome (SwiftShader software GPU), opens the
 * feature showcase in demo mode (?graphSize=N&bench=1), waits for the page to publish
 * its measured frame times, and prints one JSON line per graph size.
 *
 * Zero dependencies: relies on Node >= 22 globals (fetch, WebSocket).
 *
 * Usage: node scripts/memory-graph-frame-bench.mjs [size ...]   (default: 2000 50000)
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.BENCH_PORT || 4911);
const CDP_PORT = Number(process.env.BENCH_CDP_PORT || 9333);
const BENCH_FRAMES = Number(process.env.BENCH_FRAMES || 600);
const SIZES = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [2000, 50000];
const ROOT = new URL("..", import.meta.url).pathname;

// BENCH_GPU=1 runs on the machine's real GPU via ANGLE/GL instead of the
// SwiftShader software rasterizer; the reported renderer string records which one
// actually rendered each run.
const useGpu = process.env.BENCH_GPU === "1";
const chromeFlags = [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  "--remote-debugging-address=127.0.0.1",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  ...(useGpu ? ["--use-angle=gl", ...(process.env.BENCH_VSYNC === "1" ? [] : ["--disable-gpu-vsync"])] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
  "--hide-scrollbars",
  "--window-size=1280,900",
  `--user-data-dir=/tmp/spaceapp-bench-chrome-profile${useGpu ? "-gpu" : ""}`,
  "about:blank",
];

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) fail(new Error(message.error.message)); else ok(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    };
    socket.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((ok, fail) => {
          const id = nextId++;
          pending.set(id, { resolve: ok, reject: fail });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      onEvent(listener) { listeners.push(listener); },
      close() { socket.close(); },
    });
    socket.onerror = () => reject(new Error("CDP websocket connection failed"));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return result?.result?.value;
}

async function runBench(cdp, size, timeoutMs) {
  const url = `http://127.0.0.1:${PORT}/feature.html?feature=memory&graphSize=${size}&bench=1&benchFrames=${BENCH_FRAMES}`;
  console.error(`[bench] graphSize=${size} navigating ...`);
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await evaluate(cdp, "document.title");
    if (typeof title === "string" && title.startsWith("BENCH:")) {
      const bench = JSON.parse(title.slice("BENCH:".length));
      const info = await evaluate(cdp, `JSON.stringify({
        renderer: (() => { const canvas = document.querySelector(".memory-3d-surface canvas"); const gl = canvas?.getContext("webgl2"); if (!gl) return "canvas2d"; const ext = gl.getExtension("WEBGL_debug_renderer_info"); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "webgl2"; })(),
        userAgent: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        memoryGb: navigator.deviceMemory || null,
      })`);
      return { size, ...bench, ...JSON.parse(info) };
    }
    await delay(500);
  }
  throw new Error(`graphSize=${size}: no BENCH result within ${timeoutMs / 1000}s`);
}

async function main() {
  let vite = null;
  let chrome = null;
  try {
    vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: `${ROOT}apps/web`, stdio: "ignore" });
    await waitForHttp(`http://127.0.0.1:${PORT}/feature.html`, 60000, "vite dev server");
    console.error(`[bench] vite ready on port ${PORT}`);
    chrome = spawn("google-chrome", chromeFlags, { stdio: "ignore" });
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000, "chrome devtools endpoint");
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("no CDP page target");
    const cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    cdp.onEvent((message) => {
      if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params.exceptionDetails;
        console.error("[bench] page exception:", detail?.text, detail?.exception?.description ?? "");
      }
      if (message.method === "Runtime.consoleAPICalled" && String(message.params.type) === "debug") {
        console.error("[page]", message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      }
    });
    for (const size of SIZES) {
      const result = await runBench(cdp, size, size > 20000 ? Number(process.env.BENCH_TIMEOUT_MS || 900000) : 120000);
      console.log("RESULT " + JSON.stringify(result));
    }
  } finally {
    try { chrome?.kill("SIGTERM"); } catch {}
    try { vite?.kill("SIGTERM"); } catch {}
    await delay(500);
    try { chrome?.kill("SIGKILL"); } catch {}
    try { vite?.kill("SIGKILL"); } catch {}
  }
}

main().catch((error) => {
  console.error("[bench] FAILED:", error.message);
  process.exitCode = 1;
});

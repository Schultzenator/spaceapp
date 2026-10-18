import type { MemoryCamera3D } from "./memory-3d.js";
import { parseColorHex } from "./memory-graph-3d-core.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryPoint3D } from "./memory-3d.js";

/**
 * WebGL2 renderer for the 3D memory graph. Nodes draw as GPU points sized by the same
 * perspective factor the Canvas 2D renderer used, edges as one batched line list, and
 * depth is resolved by the GPU depth buffer, so no frame sorts or scans all nodes.
 * No rendering dependency is added: raw WebGL2 with two small programs.
 */

const NODE_VERTEX = `#version 300 es
in vec3 aPosition;
in vec3 aColor;
in float aSize;
in float aGlow;
in float aDim;
uniform float uYawCos, uYawSin, uPitchCos, uPitchSin, uScale, uZoom, uWidth, uHeight, uDpr;
out vec3 vColor;
out float vAlpha;
out float vGlow;
void main() {
  float x = aPosition.x * uYawCos + aPosition.z * uYawSin;
  float depth = -aPosition.x * uYawSin + aPosition.z * uYawCos;
  float y = aPosition.y * uPitchCos - depth * uPitchSin;
  float z = aPosition.y * uPitchSin + depth * uPitchCos;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float sx = uWidth / 2.0 + x * uScale * uZoom * perspective;
  float sy = uHeight / 2.0 - y * uScale * uZoom * perspective;
  gl_Position = vec4(sx / uWidth * 2.0 - 1.0, 1.0 - sy / uHeight * 2.0, clamp(z * uScale / 650.0, -0.95, 0.95), 1.0);
  gl_PointSize = max(1.0, aSize * perspective * sqrt(uZoom)) * uDpr * (aGlow > 0.5 ? 2.6 : 1.0);
  vColor = aColor;
  vAlpha = aDim > 0.5 ? 0.2 : clamp(perspective, 0.4, 1.0);
  vGlow = aGlow;
}`;

const NODE_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
in float vGlow;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (vGlow > 0.5) {
    if (r2 > 1.0) discard;
    fragColor = vec4(vColor, vAlpha * pow(1.0 - r2, 1.6));
  } else {
    if (r2 > 1.0) discard;
    fragColor = vec4(vColor, vAlpha);
  }
}`;

const EDGE_VERTEX = `#version 300 es
in vec3 aPosition;
in vec3 aColor;
uniform float uYawCos, uYawSin, uPitchCos, uPitchSin, uScale, uZoom, uWidth, uHeight;
out vec3 vColor;
void main() {
  float x = aPosition.x * uYawCos + aPosition.z * uYawSin;
  float depth = -aPosition.x * uYawSin + aPosition.z * uYawCos;
  float y = aPosition.y * uPitchCos - depth * uPitchSin;
  float z = aPosition.y * uPitchSin + depth * uPitchCos;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  float sx = uWidth / 2.0 + x * uScale * uZoom * perspective;
  float sy = uHeight / 2.0 - y * uScale * uZoom * perspective;
  gl_Position = vec4(sx / uWidth * 2.0 - 1.0, 1.0 - sy / uHeight * 2.0, clamp(z * uScale / 650.0, -0.95, 0.95), 1.0);
  vColor = aColor;
}`;

const EDGE_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, 1.0); }`;

export interface GraphGeometry {
  count: number;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  glows: Float32Array;
  dims: Float32Array;
  edgeCount: number;
  edgePositions: Float32Array;
  edgeColors: Float32Array;
}

/**
 * Packs nodes, edges, colors and highlight state into typed arrays. Focus changes only
 * rewrite the small per-node attribute slices, never the whole geometry.
 */
export function buildGraphGeometry(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>, coordinates: Map<string, MemoryPoint3D>, focusId: string | null): GraphGeometry {
  const count = nodes.length;
  const positionsOut = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const glows = new Float32Array(count);
  const dims = new Float32Array(count);
  const neighbors = new Set<string>();
  if (focusId) for (const edge of edges) { if (edge.source === focusId) neighbors.add(edge.target); if (edge.target === focusId) neighbors.add(edge.source); }
  // Only a handful of distinct palette strings exist; parsing them once keeps the
  // 150k-edge repack comfortably inside the main-thread long-task budget.
  const rgbCache = new Map<string, [number, number, number]>();
  const cachedRgb = (hex: string): [number, number, number] => {
    let rgb = rgbCache.get(hex);
    if (!rgb) { rgb = parseColorHex(hex); rgbCache.set(hex, rgb); }
    return rgb;
  };
  for (let i = 0; i < count; i++) {
    const node = nodes[i]!;
    const point = coordinates.get(node.id);
    if (point) { positionsOut[i * 3] = point.x; positionsOut[i * 3 + 1] = point.y; positionsOut[i * 3 + 2] = point.z; }
    const highlighted = node.id === focusId;
    const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const base = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
    sizes[i] = base * (highlighted ? 1.5 : 1);
    const rgb = cachedRgb(highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad");
    colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
    glows[i] = root || highlighted ? 1 : 0;
    dims[i] = focusId && !highlighted && !neighbors.has(node.id) ? 1 : 0;
  }
  const edgePositions = new Float32Array(edges.length * 6);
  const edgeColors = new Float32Array(edges.length * 6);
  let edgeCount = 0;
  for (const edge of edges) {
    const a = coordinates.get(edge.source), b = coordinates.get(edge.target);
    if (!a || !b) continue;
    edgePositions[edgeCount * 6] = a.x; edgePositions[edgeCount * 6 + 1] = a.y; edgePositions[edgeCount * 6 + 2] = a.z;
    edgePositions[edgeCount * 6 + 3] = b.x; edgePositions[edgeCount * 6 + 4] = b.y; edgePositions[edgeCount * 6 + 5] = b.z;
    const incident = edge.source === focusId || edge.target === focusId;
    const rgb = cachedRgb(incident ? "#98dafa" : focusId ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343");
    for (let v = 0; v < 2; v++) { edgeColors[edgeCount * 6 + v * 3] = rgb[0]; edgeColors[edgeCount * 6 + v * 3 + 1] = rgb[1]; edgeColors[edgeCount * 6 + v * 3 + 2] = rgb[2]; }
    edgeCount++;
  }
  return { count, positions: positionsOut, colors, sizes, glows, dims, edgeCount, edgePositions, edgeColors };
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

export class MemoryGraphGlRenderer {
  readonly gl: WebGL2RenderingContext;
  private nodeProgram: WebGLProgram;
  private edgeProgram: WebGLProgram;
  private nodeBuffers: Record<"position" | "color" | "size" | "glow" | "dim", WebGLBuffer> = {} as never;
  private edgeBuffers: Record<"position" | "color", WebGLBuffer> = {} as never;
  private capacity = 0;
  private edgeCapacity = 0;
  private count = 0;
  private edgeCount = 0;

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const link = (vertex: string, fragment: string): WebGLProgram => {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      return program;
    };
    this.nodeProgram = link(NODE_VERTEX, NODE_FRAGMENT);
    this.edgeProgram = link(EDGE_VERTEX, EDGE_FRAGMENT);
    for (const key of ["position", "color", "size", "glow", "dim"] as const) this.nodeBuffers[key] = gl.createBuffer()!;
    for (const key of ["position", "color"] as const) this.edgeBuffers[key] = gl.createBuffer()!;
  }

  /** Returns null when WebGL2 is unavailable, so the caller keeps the Canvas 2D fallback. */
  static create(canvas: HTMLCanvasElement): MemoryGraphGlRenderer | null {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true }) as WebGL2RenderingContext | null;
    if (!gl) return null;
    try { return new MemoryGraphGlRenderer(gl); } catch { return null; }
  }

  isContextLost(): boolean { return this.gl.isContextLost(); }

  /** Uploads the packed geometry; grows GPU buffers only when the graph got larger. */
  setGeometry(geometry: GraphGeometry): void {
    const gl = this.gl;
    this.count = geometry.count;
    this.edgeCount = geometry.edgeCount;
    const grow = this.capacity < geometry.count;
    if (grow) this.capacity = Math.max(geometry.count, this.capacity);
    const upload = (buffer: WebGLBuffer, data: Float32Array, elements: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      if (grow) gl.bufferData(gl.ARRAY_BUFFER, this.capacity * elements * 4, gl.DYNAMIC_DRAW);
      if (data.length) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    };
    upload(this.nodeBuffers.position, geometry.positions, 3);
    upload(this.nodeBuffers.color, geometry.colors, 3);
    upload(this.nodeBuffers.size, geometry.sizes, 1);
    upload(this.nodeBuffers.glow, geometry.glows, 1);
    upload(this.nodeBuffers.dim, geometry.dims, 1);
    const edgeGrow = this.edgeCapacity < geometry.edgeCount;
    if (edgeGrow) this.edgeCapacity = Math.max(geometry.edgeCount, this.edgeCapacity);
    const uploadEdge = (buffer: WebGLBuffer, data: Float32Array, elements: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      if (edgeGrow) gl.bufferData(gl.ARRAY_BUFFER, this.edgeCapacity * elements * 4, gl.DYNAMIC_DRAW);
      if (data.length) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    };
    uploadEdge(this.edgeBuffers.position, geometry.edgePositions, 6);
    uploadEdge(this.edgeBuffers.color, geometry.edgeColors, 6);
  }

  /** One frame: edges below nodes, GPU depth testing, no CPU-side sort. */
  render(camera: MemoryCamera3D, scale: number, width: number, height: number, dpr: number, background: readonly number[]): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(background[0]!, background[1]!, background[2]!, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    const uniforms = (program: WebGLProgram) => {
      gl.useProgram(program);
      gl.uniform1f(gl.getUniformLocation(program, "uYawCos"), Math.cos(camera.yaw));
      gl.uniform1f(gl.getUniformLocation(program, "uYawSin"), Math.sin(camera.yaw));
      gl.uniform1f(gl.getUniformLocation(program, "uPitchCos"), Math.cos(camera.pitch));
      gl.uniform1f(gl.getUniformLocation(program, "uPitchSin"), Math.sin(camera.pitch));
      gl.uniform1f(gl.getUniformLocation(program, "uScale"), scale);
      gl.uniform1f(gl.getUniformLocation(program, "uZoom"), camera.zoom);
      gl.uniform1f(gl.getUniformLocation(program, "uWidth"), width);
      gl.uniform1f(gl.getUniformLocation(program, "uHeight"), height);
    };
    if (this.edgeCount > 0) {
      uniforms(this.edgeProgram);
      gl.depthMask(false);
      this.bindAttributes(this.edgeProgram, [["aPosition", this.edgeBuffers.position, 3], ["aColor", this.edgeBuffers.color, 3]]);
      gl.drawArrays(gl.LINES, 0, this.edgeCount * 2);
      gl.depthMask(true);
    }
    if (this.count > 0) {
      uniforms(this.nodeProgram);
      gl.uniform1f(gl.getUniformLocation(this.nodeProgram, "uDpr"), dpr);
      this.bindAttributes(this.nodeProgram, [["aPosition", this.nodeBuffers.position, 3], ["aColor", this.nodeBuffers.color, 3], ["aSize", this.nodeBuffers.size, 1], ["aGlow", this.nodeBuffers.glow, 1], ["aDim", this.nodeBuffers.dim, 1]]);
      gl.drawArrays(gl.POINTS, 0, this.count);
    }
  }

  private bindAttributes(program: WebGLProgram, attributes: ReadonlyArray<[name: string, buffer: WebGLBuffer, size: number]>): void {
    const gl = this.gl;
    for (const [name, buffer, size] of attributes) {
      const location = gl.getAttribLocation(program, name);
      if (location < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const key of Object.keys(this.nodeBuffers) as Array<keyof typeof this.nodeBuffers>) gl.deleteBuffer(this.nodeBuffers[key]);
    for (const key of Object.keys(this.edgeBuffers) as Array<keyof typeof this.edgeBuffers>) gl.deleteBuffer(this.edgeBuffers[key]);
    gl.deleteProgram(this.nodeProgram);
    gl.deleteProgram(this.edgeProgram);
  }
}

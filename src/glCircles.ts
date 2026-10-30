// 圆极多时 Canvas 2D 逐个描边太慢：用 WebGL2 实例化渲染，一个四边形一个圆，片元着色器画抗锯齿圆环。
// 画到离屏画布上，再由 2D 画布 drawImage 合成，图层顺序和录制都不受影响。

const VS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 circ;
uniform vec2 uRes;
uniform float uWidth;
out vec2 vLocal;
out float vR;
void main() {
  float ext = circ.z + uWidth;
  vec2 p = circ.xy + corner * ext;
  vLocal = corner * ext;
  vR = circ.z;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vR;
uniform float uWidth;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  float a = clamp(uWidth * 0.5 + 0.5 - abs(length(vLocal) - vR), 0.0, 1.0);
  if (a <= 0.0) discard;
  outColor = vec4(uColor.rgb * uColor.a * a, uColor.a * a);
}`;

export class GLCircles {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private inst: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private uRes: WebGLUniformLocation;
  private uWidth: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;
  lost = false;

  static create(): GLCircles | null {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
      return gl ? new GLCircles(canvas, gl) : null;
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', () => (this.lost = true));

    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    this.uRes = gl.getUniformLocation(prog, 'uRes')!;
    this.uWidth = gl.getUniformLocation(prog, 'uWidth')!;
    this.uColor = gl.getUniformLocation(prog, 'uColor')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** circles 为设备像素下的 [cx, cy, r] 三元组 */
  draw(w: number, h: number, circles: Float32Array, count: number, lineWidth: number, rgba: [number, number, number, number]) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count === 0) return;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, circles.subarray(0, count * 3), gl.DYNAMIC_DRAW);
    gl.uniform2f(this.uRes, w, h);
    gl.uniform1f(this.uWidth, lineWidth);
    gl.uniform4f(this.uColor, rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }
}

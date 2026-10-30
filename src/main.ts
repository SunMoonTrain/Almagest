import 'katex/dist/katex.min.css';
import './style.css';
import katex from 'katex';
import { CIRCLE_PRESETS, DETAIL, DETAIL_KEYS, JUMP_FAST_WEIGHT, TARGET_LONG_SIDE, type DetailKey } from './core/presets';
import { DEMO_CURVES } from './core/curves';
import { circleLimit, countForEnergy, energyKept, termsOf, traceCurve } from './core/fourier';
import { coefficientsJSON, desmosText, equationLatex, type EqForm, type EqOptions } from './core/equation';
import { runPipeline, type PipelineInput, type PipelineOptions, type PipelineResult } from './core/pipeline';
import { traceColors, type TraceColors } from './core/colorize';
import { GLCircles } from './glCircles';
import { encodeGif } from './gif';
import PipelineWorker from './worker?worker&inline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Source =
  | { kind: 'image'; name: string; canvas: HTMLCanvasElement; rgba: Uint8ClampedArray; w: number; h: number; hash: string }
  | { kind: 'curve'; name: string; id: string };

/** 每画一圈的秒数 */
const SPEEDS = [60, 30, 20, 12, 8, 4, 2];
/** 没有 WebGL 时只画半径最大的这么多个圆 */
const MAX_DRAWN_CIRCLES = 200;
const FOLLOW_ZOOM = 6;
const BG = '#0a0d16';
const CIRCLE_RGBA: [number, number, number, number] = [143 / 255, 176 / 255, 1, 0.22];
const CIRCLE_RGBA_CSS = 'rgba(143,176,255,0.22)';
const TRACE_CSS = '#ffd27a';
const JUMP_CSS = 'rgba(255,210,122,0.28)';
/** loop：画一圈的帧数；hold：画完后定格的帧数（逐渐加圆模式定格更久） */
const GIF = { size: 480, loop: 120, hold: 25, growHold: 50, delayMs: 50 };
/** 公式超过这么多项时折叠显示 */
const FOLD_OVER = 12;
const FOLD_SHOW = 8;

const state = {
  source: null as Source | null,
  mode: 'edge' as 'edge' | 'silhouette',
  detail: 'medium' as DetailKey,
  tree: false,
  jumpFast: false,
  /** 单线：闭运算 + 骨架化，把描线两侧的平行双边并成一条中心线 */
  lineMode: 'double' as 'double' | 'single',
  lineRadius: DETAIL.medium.lineRadius,
  circleMode: 'energy' as 'energy' | 'count',
  /** CIRCLE_PRESETS 的下标；−1 表示滑块自定义 */
  preset: 1,
  M: 1,
  form: 'complex' as EqForm,
  expanded: false,
  result: null as PipelineResult | null,
  trace: null as { x: Float64Array; y: Float64Array } | null,
  /** 原图色模式下每个采样点的颜色；单色模式为 null */
  colors: null as TraceColors | null,
  colorCss: [] as (string | null)[],
};

const view = {
  circles: true,
  arrows: true,
  image: true,
  target: false,
  follow: false,
  grow: false,
  jumps: 'dashed' as 'dashed' | 'hidden' | 'solid',
  color: 'mono' as 'mono' | 'source',
  colorOffset: 4,
  liftDark: true,
  minL: 0.45,
};

const anim = {
  pos: 0,
  playing: true,
  speedIdx: 3,
  // 每个圆一个单位复数「转子」e^{ikt}，每帧乘一次 e^{ikΔt}
  rr: new Float64Array(0),
  ri: new Float64Array(0),
  sr: new Float64Array(0),
  si: new Float64Array(0),
  nodesX: new Float64Array(1),
  nodesY: new Float64Array(1),
  camX: 0,
  camY: 0,
  zoom: 1,
  growM: 1,
  growTick: 0,
  growHold: 0,
  growTrace: null as { x: Float64Array; y: Float64Array } | null,
  recorder: null as MediaRecorder | null,
  scrubbing: false,
  exportingGif: false,
};

const stats = { circlesDrawn: 0, frame: 0, layerRedraws: 0 };

// ---------- Worker 与缓存 ----------

// Worker 内联进主脚本（构建时转成 Blob URL）。双击打开的单文件版（file://）里浏览器不允许
// 启动 Blob URL 的 Worker，这时以及 Worker 出错时，改在主线程算（算的时候界面会停顿一下）。
const pending = new Map<number, { input: PipelineInput; opts: PipelineOptions; resolve: (r: PipelineResult) => void; reject: (e: Error) => void }>();
let reqId = 0;
const cache = new Map<string, PipelineResult>();
let worker: Worker | null = location.protocol === 'file:' ? null : new PipelineWorker();

if (worker) {
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      if (m.id === reqId) setBusy(`正在计算：${m.stage}…`);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'done') p.resolve(m.result);
    else p.reject(new Error(m.message));
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    const waiting = [...pending.entries()];
    pending.clear();
    for (const [, p] of waiting) computeHere(p.input, p.opts).then(p.resolve, p.reject);
  };
}

/** 在主线程算：先让出一帧，让「正在计算」的提示画出来 */
function computeHere(input: PipelineInput, opts: PipelineOptions): Promise<PipelineResult> {
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(runPipeline(input, opts));
      } catch (err) {
        reject(err);
      }
    }, 30),
  );
}

function compute(id: number, input: PipelineInput, opts: PipelineOptions): Promise<PipelineResult> {
  if (!worker) return computeHere(input, opts);
  return new Promise((resolve, reject) => {
    pending.set(id, { input, opts, resolve, reject });
    worker!.postMessage({ id, input, opts });
  });
}

function setBusy(text: string | null, error = false) {
  const el = $('busy');
  el.hidden = text === null;
  el.textContent = text ?? '';
  el.classList.toggle('error', error);
}

async function recompute() {
  const src = state.source;
  if (!src) return;
  const opts: PipelineOptions = { detail: state.detail, tree: state.tree, jumpWeight: state.jumpFast ? JUMP_FAST_WEIGHT : 1 };
  if (singleLine()) opts.lineRadius = state.lineRadius;
  const srcKey = src.kind === 'image' ? `img:${src.hash}:${state.mode}` : `curve:${src.id}`;
  const key = [srcKey, opts.detail, opts.tree, opts.jumpWeight, opts.lineRadius ? `single${opts.lineRadius}` : 'double'].join('|');
  let res = cache.get(key);
  if (!res) {
    const id = ++reqId;
    setBusy('正在计算…');
    const input: PipelineInput =
      src.kind === 'image'
        ? { kind: 'image', w: src.w, h: src.h, rgba: src.rgba, mode: state.mode }
        : { kind: 'curve', chains: DEMO_CURVES.find((c) => c.id === src.id)!.make() };
    try {
      res = await compute(id, input, opts);
    } catch (err) {
      if (id === reqId) setBusy((err as Error).message, true);
      return;
    }
    if (id !== reqId) return; // 已被更新的请求取代
    cache.set(key, res);
  } else {
    ++reqId;
  }
  setBusy(null);
  state.result = res;
  anim.pos = 0;
  recolor();
  renderStats();
  applyM(resolveM());
}

/** 单线模式只对图片的边缘检测有意义 */
function singleLine(): boolean {
  return state.lineMode === 'single' && state.mode === 'edge' && state.source?.kind === 'image';
}

/** 实际取色偏移：单线模式下骨架在描线正中，d 至少要比 r 大 */
function colorOffset(): number {
  return singleLine() ? Math.max(view.colorOffset, Math.ceil(state.lineRadius) + 1) : view.colorOffset;
}

function recolor() {
  const res = state.result, src = state.source;
  state.colors = null;
  state.colorCss = [];
  const d = colorOffset();
  $('colorOffsetVal').textContent = d === view.colorOffset ? `${d} px` : `${d} px*`;
  $('colorOffsetVal').title = d === view.colorOffset ? '' : `单线模式下至少 r + 1 = ${d} px`;
  $('minLVal').textContent = view.liftDark ? view.minL.toFixed(2) : '关';
  if (view.color !== 'source' || !res || src?.kind !== 'image' || res.sampled.flipH === null) return;
  const c = traceColors(res.sampled, src.rgba, src.w, src.h, { offset: d, minL: view.liftDark ? view.minL : null });
  state.colors = c;
  // 低两位抹掉，相邻同色的段能合成一条路径
  state.colorCss = Array.from(c.ok, (ok, n) =>
    ok ? `rgb(${c.rgb[3 * n] & 0xfc},${c.rgb[3 * n + 1] & 0xfc},${c.rgb[3 * n + 2] & 0xfc})` : null,
  );
}

function updateSourceUI() {
  const img = state.source?.kind === 'image';
  document.querySelectorAll<HTMLButtonElement>('#lineMode button').forEach((b) => (b.disabled = !img || state.mode !== 'edge'));
  setSeg('lineMode', state.lineMode);
  $('lineRadiusRow').hidden = !singleLine();
  $<HTMLInputElement>('lineRadius').value = String(state.lineRadius);
  $('lineRadiusVal').textContent = `${state.lineRadius} px`;
  const srcBtn = document.querySelector<HTMLButtonElement>('#vColor button[data-v="source"]')!;
  srcBtn.disabled = !img;
  setSeg('vColor', view.color);
  $('colorOpts').hidden = view.color !== 'source' || !img;
}

function renderStats() {
  const res = state.result;
  if (!res) return;
  const { stats, spec } = res;
  const time = stats.timings.map(([k, ms]) => `${k} ${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`).join(' · ');
  $('stats').innerHTML =
    `链 ${stats.chains} 条 · 跳线 ${stats.jumps} 段（占总长 ${(stats.jumpRatio * 100).toFixed(1)}%）<br>` +
    `采样点 N = ${spec.N}<br>${time}`;
}

// ---------- 圆的数量 ----------

function resolveM(): number {
  const spec = state.result!.spec;
  const limit = circleLimit(spec);
  if (state.preset < 0) return Math.min(Math.max(1, state.M), limit);
  const p = CIRCLE_PRESETS[state.preset];
  return state.circleMode === 'energy' ? countForEnergy(spec, p.energy) : Math.min(p.count, limit);
}

function applyM(M: number) {
  const res = state.result;
  if (!res) return;
  const spec = res.spec;
  M = Math.min(Math.max(1, Math.round(M)), circleLimit(spec));
  state.M = M;
  state.trace = traceCurve(spec, M);
  anim.rr = new Float64Array(M);
  anim.ri = new Float64Array(M);
  anim.sr = new Float64Array(M);
  anim.si = new Float64Array(M);
  anim.nodesX = new Float64Array(M + 1);
  anim.nodesY = new Float64Array(M + 1);
  setSteps();
  calibrate();
  resetGrow();
  updateCircleUI();
  eqDirty = true;
}

function updateCircleUI() {
  const res = state.result;
  document.querySelectorAll<HTMLButtonElement>('#circlePreset button').forEach((b, i) => {
    const p = CIRCLE_PRESETS[i];
    b.classList.toggle('on', i === state.preset);
    b.innerHTML = `${p.label}<small>${state.circleMode === 'energy' ? `${+(p.energy * 100).toFixed(2)}%` : `${p.count} 个`}</small>`;
  });
  setSeg('circleMode', state.circleMode);
  if (!res) return;
  const limit = circleLimit(res.spec);
  const slider = $<HTMLInputElement>('mSlider');
  slider.value = String(Math.round((Math.log(state.M) / Math.log(Math.max(2, limit))) * 1000));
  const input = $<HTMLInputElement>('mInput');
  input.max = String(limit);
  if (document.activeElement !== input) input.value = String(state.M);
  const kept = energyKept(res.spec, state.M) * 100;
  const growing = view.grow ? ` · 演示中 <b>${anim.growM}</b>` : '';
  $('mReadout').innerHTML = `<b>${state.M}</b> 个圆 · 保留能量 ${kept >= 99.995 ? kept.toFixed(4) : kept.toFixed(2)}% · 上限 ${limit}${growing}`;
}

// ---------- 动画 ----------

function spf(): number {
  const N = state.result?.spec.N ?? 1;
  return N / (SPEEDS[anim.speedIdx] * 60);
}

function setSteps() {
  const spec = state.result?.spec;
  if (!spec) return;
  const dt = (2 * Math.PI * spf()) / spec.N;
  for (let j = 0; j < anim.sr.length; j++) {
    anim.sr[j] = Math.cos(spec.k[j] * dt);
    anim.si[j] = Math.sin(spec.k[j] * dt);
  }
}

/** 用三角函数重新校准转子，防止浮点误差累积。 */
function calibrate() {
  const spec = state.result?.spec;
  if (!spec) return;
  const t = (2 * Math.PI * anim.pos) / spec.N;
  for (let j = 0; j < anim.rr.length; j++) {
    anim.rr[j] = Math.cos(spec.k[j] * t);
    anim.ri[j] = Math.sin(spec.k[j] * t);
  }
}

function advance() {
  const spec = state.result!.spec;
  anim.pos += spf();
  if (anim.pos >= spec.N) {
    anim.pos -= spec.N;
    calibrate();
    if (anim.recorder) {
      anim.recorder.stop();
      anim.recorder = null;
      $('record').textContent = '录制一圈视频';
    }
    return;
  }
  const { rr, ri, sr, si } = anim;
  for (let j = 0; j < rr.length; j++) {
    const a = rr[j] * sr[j] - ri[j] * si[j];
    ri[j] = rr[j] * si[j] + ri[j] * sr[j];
    rr[j] = a;
  }
}

function resetGrow() {
  anim.growM = 1;
  anim.growTick = 0;
  anim.growHold = 0;
  anim.growTrace = view.grow && state.result ? traceCurve(state.result.spec, 1) : null;
}

/** 逐渐加圆的下一步：每步加约 6%，至少一个 */
const nextGrowM = (m: number, M: number) => Math.min(M, m + Math.max(1, Math.floor(m * 0.06)));

function growStep() {
  const spec = state.result!.spec;
  if (anim.growM < state.M) {
    if (++anim.growTick % 3 === 0) {
      anim.growM = nextGrowM(anim.growM, state.M);
      anim.growTrace = traceCurve(spec, anim.growM);
      updateCircleUI();
    }
  } else if (++anim.growHold > 150) {
    resetGrow();
    updateCircleUI();
  }
}

// ---------- 绘制 ----------

const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
let cssW = 0, cssH = 0, dpr = 1;
const glCircles = GLCircles.create();
let circleBuf = new Float32Array(0);

function resize() {
  dpr = window.devicePixelRatio || 1;
  cssW = canvas.clientWidth;
  cssH = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
}
new ResizeObserver(resize).observe(canvas);

/** 一帧画面需要的全部量；屏幕坐标 = (ox + z·x, oy − z·y)，单位是 CSS 像素 */
interface Scene {
  m: number;
  tr: { x: Float64Array; y: Float64Array };
  /** 笔迹揭开到第几个采样点 */
  end: number;
  /** 是否从最后一个采样点连到笔尖 */
  partial: boolean;
  penX: number;
  penY: number;
  z: number;
  ox: number;
  oy: number;
}

/** 箭头链：大的接在根部，小的在笔尖。useRotors = false 时直接用三角函数（离屏导出用）。 */
function computeNodes(m: number, pos: number, useRotors: boolean) {
  const spec = state.result!.spec;
  const nx = anim.nodesX, ny = anim.nodesY;
  const t = (2 * Math.PI * pos) / spec.N;
  let x = spec.c0re, y = spec.c0im;
  nx[0] = x;
  ny[0] = y;
  for (let j = 0; j < m; j++) {
    const c = useRotors ? anim.rr[j] : Math.cos(spec.k[j] * t);
    const s = useRotors ? anim.ri[j] : Math.sin(spec.k[j] * t);
    x += spec.re[j] * c - spec.im[j] * s;
    y += spec.re[j] * s + spec.im[j] * c;
    nx[j + 1] = x;
    ny[j + 1] = y;
  }
}

function draw() {
  // 画布不可见（尺寸为 0）时不画，否则 WebGL 离屏画布也是 0×0，drawImage 会抛错让动画循环中断
  if (canvas.width < 1 || canvas.height < 1 || cssW < 1 || cssH < 1) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const res = state.result;
  const tr = view.grow ? anim.growTrace : state.trace;
  if (!res || !tr) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cssW, cssH);
    return;
  }
  const N = res.spec.N;
  const m = view.grow ? anim.growM : state.M;
  computeNodes(m, anim.pos, true);
  const penX = anim.nodesX[m], penY = anim.nodesY[m];

  // 镜头：平滑地放大并跟随笔尖
  const base = (Math.min(cssW, cssH) * 0.42) / 100;
  const targetZoom = view.follow ? FOLLOW_ZOOM : 1;
  anim.zoom += (targetZoom - anim.zoom) * 0.12;
  const followAmt = (anim.zoom - 1) / (FOLLOW_ZOOM - 1);
  anim.camX += (penX * followAmt - anim.camX) * 0.25;
  anim.camY += (penY * followAmt - anim.camY) * 0.25;
  const z = base * anim.zoom;
  paint(ctx, cssW, cssH, dpr, {
    m,
    tr,
    end: view.grow ? N : Math.floor(anim.pos),
    partial: !view.grow,
    penX,
    penY,
    z,
    ox: cssW / 2 - z * anim.camX,
    oy: cssH / 2 + z * anim.camY,
  });
}

/** g 的当前变换须为 scale(ratio)；W、H 为 CSS 像素。 */
function paint(g: CanvasRenderingContext2D, W: number, H: number, ratio: number, sc: Scene) {
  const res = state.result!;
  const N = res.spec.N;
  const { z, ox, oy } = sc;
  const sx = (v: number) => ox + z * v;
  const sy = (v: number) => oy - z * v;
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);

  // 原图叠底
  const src = state.source;
  if (view.image && src?.kind === 'image' && res.sampled.flipH !== null) {
    const s = res.sampled;
    const k = z * s.scale;
    g.save();
    g.globalAlpha = 0.22;
    g.setTransform(ratio * k, 0, 0, ratio * k, ratio * (ox - k * s.cx), ratio * (oy - k * (s.flipH! - s.cy)));
    g.drawImage(src.canvas, 0, 0);
    g.restore();
  }

  g.lineCap = 'round';
  g.lineJoin = 'round';

  // 目标曲线
  if (view.target) {
    const s = res.sampled;
    g.beginPath();
    for (let n = 0; n < N; n++) g.lineTo(sx(s.x[n]), sy(s.y[n]));
    g.closePath();
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1;
    g.stroke();
  }

  // 笔迹：按 t 揭开；跳线所在区间画淡或隐藏
  if (state.colors) paintColoredTrace(g, W, H, ratio, sc);
  else strokeMonoTrace(g, sc);

  if (view.circles) drawCircles(g, W, H, ratio, sc);

  // 箭头
  const nx = anim.nodesX, ny = anim.nodesY;
  if (view.arrows) {
    g.beginPath();
    g.moveTo(sx(nx[0]), sy(ny[0]));
    for (let j = 1; j <= sc.m; j++) g.lineTo(sx(nx[j]), sy(ny[j]));
    g.strokeStyle = 'rgba(220,230,255,0.75)';
    g.lineWidth = 1.2;
    g.stroke();
    g.beginPath();
    for (let j = 0; j < Math.min(sc.m, 80); j++) {
      const ax = sx(nx[j]), ay = sy(ny[j]), bx = sx(nx[j + 1]), by = sy(ny[j + 1]);
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 10) continue;
      const hs = Math.min(7, len * 0.25);
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      g.moveTo(bx, by);
      g.lineTo(bx - hs * ux - hs * 0.45 * uy, by - hs * uy + hs * 0.45 * ux);
      g.lineTo(bx - hs * ux + hs * 0.45 * uy, by - hs * uy - hs * 0.45 * ux);
      g.closePath();
    }
    g.fillStyle = 'rgba(220,230,255,0.75)';
    g.fill();
  }

  g.beginPath();
  g.arc(sx(sc.penX), sy(sc.penY), 3, 0, 2 * Math.PI);
  g.fillStyle = '#fff4d6';
  g.fill();
}

/** 单色笔迹：整条重画（与加入原图色之前完全相同） */
function strokeMonoTrace(g: CanvasRenderingContext2D, sc: Scene) {
  const N = state.result!.spec.N;
  const { tr, z, ox, oy } = sc;
  const sx = (v: number) => ox + z * v;
  const sy = (v: number) => oy - z * v;
  const J = state.result!.sampled.jump;
  const solid = new Path2D();
  const dashed = new Path2D();
  let last = -1; // 0 实线 1 跳线 2 断开
  const kindOf = (i: number) => (J[i] && view.jumps !== 'solid' ? (view.jumps === 'hidden' ? 2 : 1) : 0);
  const segTo = (i: number, x1: number, y1: number) => {
    const kd = kindOf(i % N);
    if (kd === 2) {
      last = 2;
      return;
    }
    const path = kd === 0 ? solid : dashed;
    if (kd !== last) path.moveTo(sx(tr.x[i % N]), sy(tr.y[i % N]));
    path.lineTo(x1, y1);
    last = kd;
  };
  for (let i = 0; i < sc.end; i++) {
    const j = (i + 1) % N;
    segTo(i, sx(tr.x[j]), sy(tr.y[j]));
  }
  if (sc.partial) segTo(sc.end, sx(sc.penX), sy(sc.penY));
  g.setLineDash([4, 5]);
  g.strokeStyle = JUMP_CSS;
  g.lineWidth = 1.2;
  g.stroke(dashed);
  g.setLineDash([]);
  g.strokeStyle = TRACE_CSS;
  g.lineWidth = 2;
  g.stroke(solid);
}

/**
 * 原图色笔迹：画第 from 到 to 段。第 i 段从笔迹点 i 连到 i + 1，用第 i 个采样点的颜色；
 * 相邻同色的段合成一条路径。跳线不上色，按「跳线」选项画。
 */
function strokeColored(g: CanvasRenderingContext2D, sc: Scene, from: number, to: number) {
  const N = state.result!.spec.N;
  const J = state.result!.sampled.jump;
  const css = state.colorCss;
  const { tr, z, ox, oy } = sc;
  const X = (n: number) => ox + z * tr.x[n];
  const Y = (n: number) => oy - z * tr.y[n];
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (view.jumps !== 'hidden') {
    const p = new Path2D();
    let open = false;
    for (let i = from; i < to; i++) {
      const a = i % N;
      if (!J[a]) {
        open = false;
        continue;
      }
      if (!open) p.moveTo(X(a), Y(a));
      p.lineTo(X((i + 1) % N), Y((i + 1) % N));
      open = true;
    }
    g.setLineDash(view.jumps === 'dashed' ? [4, 5] : []);
    g.strokeStyle = view.jumps === 'dashed' ? JUMP_CSS : TRACE_CSS;
    g.lineWidth = view.jumps === 'dashed' ? 1.2 : 2;
    g.stroke(p);
    g.setLineDash([]);
  }
  g.lineWidth = 2;
  let i = from;
  while (i < to) {
    const a = i % N;
    if (J[a]) {
      i++;
      continue;
    }
    const color = css[a] ?? TRACE_CSS;
    g.beginPath();
    g.moveTo(X(a), Y(a));
    while (i < to && !J[i % N] && (css[i % N] ?? TRACE_CSS) === color) {
      g.lineTo(X((i + 1) % N), Y((i + 1) % N));
      i++;
    }
    g.strokeStyle = color;
    g.stroke();
  }
}

/**
 * 常驻的笔迹层：画面不变时每帧只补画新揭开的几段；笔迹、颜色、镜头、尺寸或跳线样式变了，
 * 或者往回拖了时间轴，才整体重画。离屏导出（GIF）不走这一层，直接整条画。
 */
const traceLayer = {
  canvas: document.createElement('canvas'),
  tr: null as Scene['tr'] | null,
  colors: null as TraceColors | null,
  jumps: '',
  z: 0,
  ox: 0,
  oy: 0,
  drawn: 0,
};
const layerCtx = traceLayer.canvas.getContext('2d')!;

function paintColoredTrace(g: CanvasRenderingContext2D, W: number, H: number, ratio: number, sc: Scene) {
  const N = state.result!.spec.N;
  if (g !== ctx) {
    strokeColored(g, sc, 0, sc.end);
  } else {
    const L = traceLayer;
    const same =
      L.tr === sc.tr && L.colors === state.colors && L.jumps === view.jumps &&
      L.canvas.width === canvas.width && L.canvas.height === canvas.height &&
      Math.abs(L.z - sc.z) < 1e-6 && Math.abs(L.ox - sc.ox) < 1e-3 && Math.abs(L.oy - sc.oy) < 1e-3;
    if (!same || sc.end < L.drawn) {
      if (L.canvas.width !== canvas.width || L.canvas.height !== canvas.height) {
        L.canvas.width = canvas.width;
        L.canvas.height = canvas.height;
      }
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.clearRect(0, 0, L.canvas.width, L.canvas.height);
      layerCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
      Object.assign(L, { tr: sc.tr, colors: state.colors, jumps: view.jumps, z: sc.z, ox: sc.ox, oy: sc.oy, drawn: 0 });
      stats.layerRedraws++;
    }
    if (sc.end > L.drawn) {
      strokeColored(layerCtx, sc, L.drawn, sc.end);
      L.drawn = sc.end;
    }
    g.drawImage(L.canvas, 0, 0, W, H);
  }
  // 最后一个采样点到笔尖这一小段每帧都在变，直接画
  const e = sc.end % N;
  if (!sc.partial || state.result!.sampled.jump[e]) return;
  g.beginPath();
  g.moveTo(sc.ox + sc.z * sc.tr.x[e], sc.oy - sc.z * sc.tr.y[e]);
  g.lineTo(sc.ox + sc.z * sc.penX, sc.oy - sc.z * sc.penY);
  g.strokeStyle = state.colorCss[e] ?? TRACE_CSS;
  g.lineWidth = 2;
  g.stroke();
}

/**
 * 小于 0.5 像素的圆不画，但仍参与求和。有 WebGL2 时全部画出（只剔除完全在画面外的），
 * 否则退回 Canvas 2D，只画半径最大的 MAX_DRAWN_CIRCLES 个。
 */
function drawCircles(g: CanvasRenderingContext2D, W: number, H: number, ratio: number, sc: Scene) {
  const spec = state.result!.spec;
  const nx = anim.nodesX, ny = anim.nodesY;
  const useGL = glCircles !== null && !glCircles.lost;
  const lim = useGL ? sc.m : Math.min(sc.m, MAX_DRAWN_CIRCLES);
  if (!useGL) {
    g.beginPath();
    for (let j = 0; j < lim; j++) {
      const r = spec.r[j] * sc.z;
      if (r < 0.5) break;
      const cx = sc.ox + sc.z * nx[j], cy = sc.oy - sc.z * ny[j];
      g.moveTo(cx + r, cy);
      g.arc(cx, cy, r, 0, 2 * Math.PI);
    }
    g.strokeStyle = CIRCLE_RGBA_CSS;
    g.lineWidth = 1;
    g.stroke();
    stats.circlesDrawn = lim;
    return;
  }
  if (circleBuf.length < lim * 3) circleBuf = new Float32Array(lim * 3);
  let count = 0;
  for (let j = 0; j < lim; j++) {
    const r = spec.r[j] * sc.z;
    if (r < 0.5) break;
    const cx = sc.ox + sc.z * nx[j], cy = sc.oy - sc.z * ny[j];
    // 剔除：圆环完全在画面外，或画面完全落在圆内
    if (cx + r < 0 || cx - r > W || cy + r < 0 || cy - r > H) continue;
    const far = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
    if (far < r - 1) continue;
    circleBuf[3 * count] = cx * ratio;
    circleBuf[3 * count + 1] = cy * ratio;
    circleBuf[3 * count + 2] = r * ratio;
    count++;
  }
  stats.circlesDrawn = count;
  if (count === 0) return;
  glCircles.draw(Math.round(W * ratio), Math.round(H * ratio), circleBuf, count, ratio, CIRCLE_RGBA);
  g.drawImage(glCircles.canvas, 0, 0, W, H);
  stats.circlesDrawn = count;
}

/**
 * 离屏渲染并编码为 GIF，沿用「显示」里的全部选项。普通模式画完整一圈后定格；
 * 逐渐加圆模式下圆数每帧加约 6%（与屏幕上同一节奏），加满后定格。
 */
async function exportGif() {
  const res = state.result, tr = state.trace;
  if (!res || !tr || anim.exportingGif) return;
  const M = state.M, spec = res.spec, N = spec.N;
  const grow = view.grow;
  const ms: number[] = [];
  if (grow) {
    for (let m = 1; m < M; m = nextGrowM(m, M)) ms.push(m);
    ms.push(M);
  }
  const frames = grow ? ms.length + GIF.growHold : GIF.loop + GIF.hold;
  // 每帧的圆数、笔尖位置、笔迹揭开到哪里
  const at = (f: number) => {
    if (grow) return { m: ms[Math.min(f, ms.length - 1)], pos: ((f * N) / GIF.loop) % N, done: true };
    return f < GIF.loop ? { m: M, pos: (f * N) / GIF.loop, done: false } : { m: M, pos: 0, done: true };
  };
  let traceM = M, trace = tr;
  const btn = $<HTMLButtonElement>('exportGif');
  anim.exportingGif = true;
  btn.disabled = true;
  try {
    const blob = await encodeGif(
      { size: GIF.size, frames, delayMs: GIF.delayMs, paletteFrames: grow ? [frames - 1] : [GIF.loop / 2, frames - 1] },
      (g, S, f) => {
        const { m, pos, done } = at(f);
        if (m !== traceM) {
          traceM = m;
          trace = m === M ? tr : traceCurve(spec, m);
        }
        computeNodes(m, pos, false);
        const penX = anim.nodesX[m], penY = anim.nodesY[m];
        const z = ((S * 0.42) / 100) * (view.follow ? FOLLOW_ZOOM : 1);
        const camX = view.follow ? penX : 0, camY = view.follow ? penY : 0;
        paint(g, S, S, 1, {
          m, tr: trace, end: done ? N : Math.floor(pos), partial: !done, penX, penY, z,
          ox: S / 2 - z * camX, oy: S / 2 + z * camY,
        });
      },
      (done, total) => {
        btn.textContent = `生成中 ${Math.round((done / total) * 100)}%`;
        return state.result === res && state.M === M;
      },
    );
    if (blob) {
      download(blob, 'almagest.gif');
      toast(`已导出 GIF（${(blob.size / 1024 / 1024).toFixed(1)} MB）`);
    } else {
      toast('圆数或图片变了，GIF 导出已中止');
    }
  } finally {
    anim.exportingGif = false;
    btn.disabled = false;
    btn.textContent = '导出 GIF';
  }
}

const timeline = $<HTMLInputElement>('timeline');
function frame() {
  if (state.result) {
    if (anim.playing && !anim.scrubbing) advance();
    if (view.grow) growStep();
    if (!anim.scrubbing) timeline.value = String(Math.round((anim.pos / state.result.spec.N) * 1000));
    $('tval').textContent = `t = ${((2 * Math.PI * anim.pos) / state.result.spec.N).toFixed(2)}`;
  }
  if (eqDirty) renderEquation();
  draw();
  if (++stats.frame % 20 === 0) {
    const how = glCircles && !glCircles.lost ? 'WebGL2' : `Canvas 2D（最多 ${MAX_DRAWN_CIRCLES} 个）`;
    const circles = view.circles ? `圆渲染：${how} · 本帧画了 ${stats.circlesDrawn} 个` : '';
    const layer = state.colors ? `原图色笔迹层：整体重画过 ${stats.layerRedraws} 次` : '';
    $('drawInfo').textContent = [circles, layer].filter(Boolean).join(' · ');
  }
  requestAnimationFrame(frame);
}

// ---------- 公式 ----------

let eqDirty = false;

function eqOptions(): EqOptions {
  const clamp = (v: number) => Math.min(8, Math.max(0, Math.round(v) || 0));
  return { rDigits: clamp(+$<HTMLInputElement>('rDigits').value), phiDigits: clamp(+$<HTMLInputElement>('pDigits').value) };
}

function currentTerms() {
  const spec = state.result!.spec;
  return { c0: { re: spec.c0re, im: spec.c0im }, terms: termsOf(spec, state.M) };
}

function renderEquation() {
  eqDirty = false;
  const el = $('eq');
  if (!state.result) {
    el.textContent = '';
    return;
  }
  const { c0, terms } = currentTerms();
  const fold = !state.expanded && terms.length > FOLD_OVER;
  const tex = equationLatex(state.form, c0, terms, { ...eqOptions(), limit: fold ? FOLD_SHOW : undefined });
  katex.render(tex, el, { displayMode: true, throwOnError: false });
  const expand = $<HTMLButtonElement>('expand');
  expand.hidden = terms.length <= FOLD_OVER;
  expand.textContent = state.expanded ? '收起' : '展开全部';
  const unit = state.form === 'trig' ? '个频率' : '项';
  const count = state.form === 'trig' ? new Set(terms.map((t) => Math.abs(t.k))).size : terms.length;
  $('eqNote').textContent =
    (fold ? `⋯ 共 ${count} ${unit}，只显示前 ${FOLD_SHOW} ${unit}；复制按钮永远给完整公式。` : `共 ${count} ${unit}。`) +
    ' t ∈ [0, 2π)，坐标已归一化（最长半边 = 100）。';
}

// ---------- 输入 ----------

function fnv(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 预处理：缩放到长边 800，透明区域铺白。 */
function fromDrawable(img: CanvasImageSource, iw: number, ih: number, name: string): Source {
  const s = TARGET_LONG_SIDE / Math.max(iw, ih);
  const w = Math.max(1, Math.round(iw * s));
  const h = Math.max(1, Math.round(ih * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;
  return { kind: 'image', name, canvas: c, rgba, w, h, hash: fnv(rgba) };
}

async function loadFile(file: File) {
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件');
    return;
  }
  try {
    const bmp = await createImageBitmap(file);
    setSource(fromDrawable(bmp, bmp.width, bmp.height, file.name || '粘贴的图片'));
  } catch {
    toast('无法读取这张图片');
  }
}

function textSource(text: string): Source {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = (px: number) => `700 ${px}px "Times New Roman", "Songti SC", "SimSun", serif`;
  g.font = font(100);
  const w100 = Math.max(1, g.measureText(text).width);
  const px = Math.min(420, (700 / w100) * 100);
  c.width = TARGET_LONG_SIDE;
  c.height = Math.round(Math.max(px * 1.5, 240));
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  g.font = font(px);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2);
  return fromDrawable(c, c.width, c.height, `文字「${text}」`);
}

function setSource(src: Source, mode?: 'edge' | 'silhouette') {
  state.source = src;
  if (mode) state.mode = mode;
  $('sourceName').textContent = src.name;
  setSeg('mode', state.mode);
  updateSourceUI();
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach((b) => (b.disabled = src.kind === 'curve'));
  document.querySelectorAll<HTMLButtonElement>('#curves button').forEach((b) => b.classList.toggle('on', src.kind === 'curve' && b.dataset.v === src.id));
  recompute();
}

// ---------- 控件 ----------

function setSeg(id: string, v: string) {
  document.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}

function onSeg(id: string, fn: (v: string) => void) {
  $(id).addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.disabled || b.dataset.v === undefined) return;
    fn(b.dataset.v);
    setSeg(id, b.dataset.v);
  });
}

function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout((toast as unknown as { t: number }).t);
  (toast as unknown as { t: number }).t = window.setTimeout(() => (el.hidden = true), 2600);
}

async function copy(text: string, msg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast('复制失败：浏览器没有授予剪贴板权限');
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setupControls() {
  $('detail').innerHTML = DETAIL_KEYS.map((k) => `<button data-v="${k}">${DETAIL[k].label}<small>σ ${DETAIL[k].sigma}</small><small>N ${DETAIL[k].N}</small></button>`).join('');
  $('circlePreset').innerHTML = CIRCLE_PRESETS.map((_, i) => `<button data-v="${i}"></button>`).join('');
  $('curves').innerHTML = DEMO_CURVES.map((c) => `<button data-v="${c.id}">${c.label}</button>`).join('');

  setSeg('detail', state.detail);
  setSeg('tour', state.tree ? 'tree' : 'greedy');
  setSeg('vJumps', view.jumps);
  updateSourceUI();
  setSeg('eqForm', state.form);
  updateCircleUI();

  onSeg('mode', (v) => {
    state.mode = v as typeof state.mode;
    updateSourceUI();
    recompute();
  });
  onSeg('detail', (v) => {
    state.detail = v as DetailKey;
    state.lineRadius = DETAIL[state.detail].lineRadius;
    updateSourceUI();
    recompute();
  });
  onSeg('lineMode', (v) => {
    state.lineMode = v as typeof state.lineMode;
    updateSourceUI();
    recompute();
  });
  const lineRadius = $<HTMLInputElement>('lineRadius');
  lineRadius.addEventListener('input', () => ($('lineRadiusVal').textContent = `${lineRadius.value} px`));
  lineRadius.addEventListener('change', () => {
    state.lineRadius = +lineRadius.value;
    recompute();
  });
  onSeg('tour', (v) => {
    state.tree = v === 'tree';
    recompute();
  });
  $<HTMLInputElement>('jumpFast').addEventListener('change', (e) => {
    state.jumpFast = (e.target as HTMLInputElement).checked;
    recompute();
  });
  onSeg('circlePreset', (v) => {
    state.preset = +v;
    applyM(resolveM());
  });
  onSeg('circleMode', (v) => {
    state.circleMode = v as typeof state.circleMode;
    if (state.preset < 0) state.preset = 1;
    if (state.result) applyM(resolveM());
    else updateCircleUI();
  });
  $<HTMLInputElement>('mSlider').addEventListener('input', (e) => {
    if (!state.result) return;
    const limit = circleLimit(state.result.spec);
    const v = +(e.target as HTMLInputElement).value / 1000;
    state.preset = -1;
    applyM(Math.round(Math.exp(v * Math.log(Math.max(2, limit)))));
  });
  $<HTMLInputElement>('mInput').addEventListener('change', (e) => {
    if (!state.result) return;
    state.preset = -1;
    applyM(+(e.target as HTMLInputElement).value || 1);
  });

  const bindView = (id: string, key: 'circles' | 'arrows' | 'image' | 'target' | 'follow' | 'grow') =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => {
      view[key] = (e.target as HTMLInputElement).checked;
      if (key === 'grow') {
        resetGrow();
        updateCircleUI();
      }
    });
  bindView('vCircles', 'circles');
  bindView('vArrows', 'arrows');
  bindView('vImage', 'image');
  bindView('vTarget', 'target');
  bindView('vFollow', 'follow');
  bindView('vGrow', 'grow');
  onSeg('vJumps', (v) => (view.jumps = v as typeof view.jumps));
  onSeg('vColor', (v) => {
    view.color = v as typeof view.color;
    updateSourceUI();
    recolor();
  });
  const colorInput = (id: string, apply: (el: HTMLInputElement) => void) => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      apply(el);
      recolor();
    });
  };
  colorInput('colorOffset', (el) => (view.colorOffset = +el.value));
  colorInput('minL', (el) => (view.minL = +el.value));
  colorInput('liftDark', (el) => (view.liftDark = el.checked));

  const play = $('play');
  const setPlaying = (p: boolean) => {
    anim.playing = p;
    play.textContent = p ? '❚❚' : '▶';
  };
  play.addEventListener('click', () => setPlaying(!anim.playing));
  timeline.addEventListener('pointerdown', () => (anim.scrubbing = true));
  timeline.addEventListener('input', () => {
    if (!state.result) return;
    anim.pos = (+timeline.value / 1000) * state.result.spec.N;
    calibrate();
  });
  const endScrub = () => {
    anim.scrubbing = false;
    calibrate();
  };
  timeline.addEventListener('pointerup', endScrub);
  timeline.addEventListener('change', endScrub);
  $<HTMLInputElement>('speed').addEventListener('input', (e) => {
    anim.speedIdx = +(e.target as HTMLInputElement).value;
    setSteps();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      setPlaying(!anim.playing);
    }
  });

  onSeg('eqForm', (v) => {
    state.form = v as EqForm;
    eqDirty = true;
  });
  $('rDigits').addEventListener('input', () => (eqDirty = true));
  $('pDigits').addEventListener('input', () => (eqDirty = true));
  $('expand').addEventListener('click', () => {
    state.expanded = !state.expanded;
    eqDirty = true;
  });
  $('copyTex').addEventListener('click', () => {
    if (!state.result) return;
    const { c0, terms } = currentTerms();
    copy(equationLatex(state.form, c0, terms, eqOptions()), `已复制完整 LaTeX（${terms.length} 项）`);
  });
  $('copyDesmos').addEventListener('click', () => {
    if (!state.result) return;
    const { c0, terms } = currentTerms();
    copy(desmosText(c0, terms, eqOptions()), '已复制 Desmos 参数式：粘贴后把 t 的范围设为 0 到 2π');
  });
  $('exportJson').addEventListener('click', () => {
    const res = state.result;
    if (!res) return;
    const { c0, terms } = currentTerms();
    const s = res.sampled;
    const json = coefficientsJSON({ N: s.N, scale: s.scale, center: { x: s.cx, y: s.cy }, imageHeight: s.flipH }, c0, terms);
    download(new Blob([json], { type: 'application/json' }), 'almagest-coefficients.json');
  });
  $('exportGif').addEventListener('click', exportGif);
  $('record').addEventListener('click', () => {
    if (!state.result) return;
    if (anim.recorder) {
      anim.recorder.stop();
      anim.recorder = null;
      $('record').textContent = '录制一圈视频';
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      toast('这个浏览器不支持录制画布');
      return;
    }
    const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(canvas.captureStream(60), mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      const type = rec.mimeType || 'video/webm';
      download(new Blob(chunks, { type }), `almagest.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    };
    anim.pos = 0;
    calibrate();
    setPlaying(true);
    rec.start();
    anim.recorder = rec;
    $('record').textContent = '停止录制';
    toast('录制中，画完一圈自动停止并下载');
  });

  // 输入
  $<HTMLInputElement>('file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadFile(f);
    (e.target as HTMLInputElement).value = '';
  });
  const useText = () => {
    const t = $<HTMLInputElement>('text').value.trim();
    if (t) setSource(textSource(t), 'silhouette');
  };
  $('textBtn').addEventListener('click', useText);
  $('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') useText();
  });
  $('curves').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    const c = DEMO_CURVES.find((d) => d.id === b?.dataset.v);
    if (c) setSource({ kind: 'curve', name: `示例曲线：${c.label}`, id: c.id });
  });
  const drop = $('drop');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    drop.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      drop.hidden = true;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.hidden = true;
    const f = e.dataTransfer?.files[0];
    if (f) loadFile(f);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const f = item?.getAsFile();
    if (f) loadFile(f);
  });
}

setupControls();
resize();
setSource(textSource('π'), 'silhouette');
requestAnimationFrame(frame);

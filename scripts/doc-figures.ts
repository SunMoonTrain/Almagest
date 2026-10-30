// 生成 docs/pipeline.md 用到的插图：npx vite-node scripts/doc-figures.ts
// 「真实数据」的图来自对一张合成笑脸图跑真实流水线；其余是示意图。
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { canny, toGray } from '../src/core/edges';
import { cleanChains, traceChains, type Chain } from '../src/core/chains';
import { greedyTour } from '../src/core/tour';
import { resample } from '../src/core/resample';
import { computeSpectrum, countForEnergy, traceCurve } from '../src/core/fourier';
import { runPipeline } from '../src/core/pipeline';
import { DEMO_CURVES } from '../src/core/curves';
import { CIRCLE_PRESETS, DETAIL } from '../src/core/presets';

const OUT = 'docs/img';
mkdirSync(OUT, { recursive: true });

// ---------- 小工具 ----------

const INK = '#1f2328', MUTED = '#6e7781', GRID = '#d0d7de', TRACE = '#d97706';
const BLUE = '#2563eb', LBLUE = '#93c5fd', RED = '#dc2626', LRED = '#fecaca', GREEN = '#16a34a', PALE = '#e5e7eb';
const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif" font-size="13" fill="${INK}">
<defs>
<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>
<marker id="arrs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>
</defs>
<rect width="${w}" height="${h}" rx="8" fill="#ffffff"/>
${body}
</svg>
`;
}
const text = (x: number, y: number, s: string, a: Record<string, string | number> = {}) =>
  `<text x="${f1(x)}" y="${f1(y)}"${Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('')}>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>`;
const title = (x: number, y: number, s: string) => text(x, y, s, { 'font-size': 14, 'font-weight': 600 });
const line = (x1: number, y1: number, x2: number, y2: number, a = '') =>
  `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" ${a}/>`;
const poly = (pts: [number, number][], a: string, close = false) =>
  `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])},${f1(p[1])}`).join('')}${close ? 'Z' : ''}" fill="none" ${a}/>`;
const rect = (x: number, y: number, w: number, h: number, a: string) => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" ${a}/>`;
const circ = (x: number, y: number, r: number, a: string) => `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" ${a}/>`;
const save = (name: string, s: string) => writeFileSync(`${OUT}/${name}`, s);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** 8 位灰度 PNG */
function pngGray(w: number, h: number, g: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = g[y * w + x];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

// ---------- 合成一张笑脸图并跑真实流水线 ----------

const W = 400, H = 400;
function dark(x: number, y: number): boolean {
  const r = Math.hypot(x - 200, y - 200);
  if (r >= 150 && r <= 162) return true; // 脸
  if (Math.hypot(x - 145, y - 160) <= 18 || Math.hypot(x - 255, y - 160) <= 18) return true; // 眼睛
  const rs = Math.hypot(x - 200, y - 205);
  const a = (Math.atan2(y - 205, x - 200) * 180) / Math.PI;
  return rs >= 82 && rs <= 96 && a >= 25 && a <= 155; // 嘴
}
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const grayImg = new Uint8Array(W * H);
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let cov = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) cov += +dark(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
    const noise = (rnd() + rnd() + rnd() - 1.5) * 12;
    const v = Math.max(0, Math.min(255, Math.round(245 - (215 * cov) / 9 + noise)));
    grayImg[y * W + x] = v;
    rgba.set([v, v, v, 255], 4 * (y * W + x));
  }
}

const P = DETAIL.medium;
const diag = Math.hypot(W, H);
const edge = canny(toGray(rgba, W, H), P.sigma, P.highPct, P.lowRatio);
const chains = cleanChains(traceChains(edge, W, H), { minLen: P.minLenFrac * diag, tol: P.tol, maxChains: P.maxChains, spurLen: 3, joinDist: 2 });
const tour = greedyTour(chains);
const sampled = resample(tour, P.N, H, 1);
const spec = computeSpectrum(sampled.x, sampled.y);
const presetM = CIRCLE_PRESETS.map((p) => countForEnergy(spec, p.energy));
console.log('chains', chains.length, 'presets M', presetM);

const edgeImg = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) edgeImg[i] = edge[i] ? 0 : 255;

/** 世界坐标 → 像素坐标 */
const toPix = (x: number, y: number): [number, number] => [x / sampled.scale + sampled.cx, H - (y / sampled.scale + sampled.cy)];
const hue = (i: number) => `hsl(${(i * 67) % 360},70%,42%)`;

function chainPaths(cs: Chain[], k: number, ox: number, oy: number): string {
  return cs
    .map((c, i) => {
      const pts: [number, number][] = [];
      for (let j = 0; j < c.pts.length; j += 2) pts.push([ox + c.pts[j] * k, oy + c.pts[j + 1] * k]);
      return poly(pts, `stroke="${hue(i)}" stroke-width="1.6"`, c.closed);
    })
    .join('\n');
}
function tourPaths(k: number, ox: number, oy: number): string {
  const n = tour.pts.length / 2;
  let solid = '', jumps = '';
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [ox + tour.pts[2 * i] * k, oy + tour.pts[2 * i + 1] * k];
    const b = [ox + tour.pts[2 * j] * k, oy + tour.pts[2 * j + 1] * k];
    if (tour.jump[i]) jumps += line(a[0], a[1], b[0], b[1], `stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#arr)"`);
    else solid += `M${f1(a[0])},${f1(a[1])}L${f1(b[0])},${f1(b[1])}`;
  }
  return `<path d="${solid}" stroke="${TRACE}" stroke-width="1.6" fill="none"/>${jumps}`;
}
/** 按 sampled.jump 分成实线和跳线两条路径（与应用里「淡色虚线」一致） */
function curvePaths(xs: Float64Array, ys: Float64Array, step: number, k: number, ox: number, oy: number, solidAttr: string, jumpAttr: string | null): string {
  const n = xs.length;
  let solid = '', jump = '';
  let last = -1;
  for (let i = 0; i < n; i += step) {
    const j = (i + step) % n;
    const isJ = sampled.jump[i] ? 1 : 0;
    const [ax, ay] = toPix(xs[i], ys[i]);
    const [bx, by] = toPix(xs[j], ys[j]);
    const seg = `${isJ === last ? '' : `M${f1(ox + ax * k)},${f1(oy + ay * k)}`}L${f1(ox + bx * k)},${f1(oy + by * k)}`;
    if (isJ) jump += seg;
    else solid += seg;
    last = isJ;
  }
  return `<path d="${solid}" fill="none" stroke-linejoin="round" ${solidAttr}/>` + (jumpAttr ? `<path d="${jump}" fill="none" ${jumpAttr}/>` : '');
}
function tracePath(M: number, k: number, ox: number, oy: number, width = 1.6): string {
  const tr = traceCurve(spec, M);
  return curvePaths(tr.x, tr.y, 2, k, ox, oy, `stroke="${TRACE}" stroke-width="${width}"`, `stroke="${TRACE}" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="3 3"`);
}
function targetPath(k: number, ox: number, oy: number): string {
  return curvePaths(sampled.x, sampled.y, 4, k, ox, oy, `stroke="${GRID}" stroke-width="3"`, null);
}

// 流水线六格
{
  const S = 220, k = S / W, cw = 240, ch = 262;
  const cell = (i: number) => [10 + (i % 3) * cw, 10 + Math.floor(i / 3) * ch];
  const frame = (x: number, y: number) => rect(x, y + 24, S, S, `fill="#fafafa" stroke="${GRID}"`);
  const caps = [
    '① 输入（灰度）',
    '② Canny 边缘',
    `③ 串成 ${chains.length} 条链（一条一色）`,
    '④ 一笔画（虚线 = 跳线）',
    `⑤ 重采样（N = ${P.N}，只画 1/32）`,
    `⑥ 用 ${presetM[3]} 个圆重建`,
  ];
  let body = '';
  caps.forEach((c, i) => {
    const [x, y] = cell(i);
    body += title(x, y + 16, c) + frame(x, y);
  });
  let [x, y] = cell(0);
  body += `<image x="${x}" y="${y + 24}" width="${S}" height="${S}" href="${dataUri(pngGray(W, H, grayImg))}"/>`;
  [x, y] = cell(1);
  body += `<image x="${x}" y="${y + 24}" width="${S}" height="${S}" href="${dataUri(pngGray(W, H, edgeImg))}" style="image-rendering:pixelated"/>`;
  [x, y] = cell(2);
  body += chainPaths(chains, k, x, y + 24);
  [x, y] = cell(3);
  body += tourPaths(k, x, y + 24);
  [x, y] = cell(4);
  for (let n = 0; n < sampled.N; n += 32) {
    const [px, py] = toPix(sampled.x[n], sampled.y[n]);
    body += circ(x + px * k, y + 24 + py * k, 1.6, `fill="${sampled.jump[n] ? MUTED : TRACE}"`);
  }
  [x, y] = cell(5);
  body += targetPath(k, x, y + 24) + tracePath(presetM[3], k, x, y + 24, 1.4);
  save('stages.svg', svg(740, 2 * ch + 6, body));
}

// 不同圆数的重建
{
  const S = 170, k = S / W;
  let body = '';
  CIRCLE_PRESETS.forEach((p, i) => {
    const x = 12 + i * 182, y = 10;
    body += title(x, y + 16, `${p.label} · ${p.energy * 100}% · M = ${presetM[i]}`);
    body += rect(x, y + 26, S, S, `fill="#fafafa" stroke="${GRID}"`);
    body += targetPath(k, x, y + 26) + tracePath(presetM[i], k, x, y + 26, 1.2);
  });
  body += text(12, 232, '灰色粗线 = 目标曲线，橙线 = 只用前 M 个圆画出的曲线，淡橙虚线 = 跳线段。圆按半径从大到小排，截断就是只取前 M 个。', { fill: MUTED, 'font-size': 12 });
  save('fourier-m.svg', svg(740, 244, body));
}

// 能量曲线
{
  const x0 = 70, x1 = 470, y0 = 40, y1 = 260, lim = spec.N / 2;
  const X = (M: number) => x0 + ((x1 - x0) * Math.log10(M)) / Math.log10(lim);
  const Y = (e: number) => y1 - ((y1 - y0) * Math.min(7, -Math.log10(Math.max(1e-7, 1 - e)))) / 7;
  let body = title(20, 24, `保留能量 vs 圆数（笑脸图，N = ${spec.N}，纵轴按「还差多少」取对数）`);
  for (const [e, s] of [[0, '0%'], [0.9, '90%'], [0.99, '99%'], [0.999, '99.9%'], [0.9999, '99.99%'], [0.99999, '99.999%'], [0.999999, '99.9999%'], [0.9999999, '99.99999%']] as [number, string][]) {
    body += line(x0, Y(e), x1, Y(e), `stroke="${PALE}"`) + text(x0 - 8, Y(e) + 4, s, { 'text-anchor': 'end', 'font-size': 11, fill: MUTED });
  }
  for (const M of [1, 10, 100, 1000]) {
    if (M > lim) continue;
    body += line(X(M), y0, X(M), y1, `stroke="${PALE}"`) + text(X(M), y1 + 16, String(M), { 'text-anchor': 'middle', 'font-size': 11, fill: MUTED });
  }
  body += text((x0 + x1) / 2, y1 + 34, '圆的数量 M（对数）', { 'text-anchor': 'middle', 'font-size': 12, fill: MUTED });
  const pts: [number, number][] = [];
  for (let M = 1; M <= lim; M = Math.max(M + 1, Math.round(M * 1.03))) pts.push([X(M), Y(spec.cum[M - 1] / spec.total)]);
  body += poly(pts, `stroke="${BLUE}" stroke-width="2"`);
  CIRCLE_PRESETS.forEach((p, i) => {
    const M = presetM[i];
    const px = X(M), py = Y(spec.cum[M - 1] / spec.total);
    body += circ(px, py, 4, `fill="${TRACE}"`) + text(px + 7, py + 14, `${p.label} M=${M}`, { 'font-size': 11 });
  });
  const notes = [
    '能量 = 所有圆的 r² 之和（不含 c₀）。',
    '帕塞瓦尔定理：它等于采样点到重心',
    '距离平方的平均，所以是衡量误差的',
    '自然尺度。',
    '',
    '「按能量」档：二分查找累计能量，',
    '取刚好达到目标比例的最少圆数。',
    '同样 99%，简单图形几个圆就够，',
    '复杂照片可能要上百个。',
    '',
    `上限 N/2 = ${lim}：圆再多，高频就会混叠。`,
  ];
  notes.forEach((s, i) => (body += text(500, 60 + i * 20, s, { 'font-size': 12 })));
  save('energy.svg', svg(760, 310, body));
}

// ---------- 示意图 ----------

// Canny：非极大值抑制 + 双阈值
{
  let body = title(20, 26, '① 非极大值抑制：沿梯度方向只留峰值') + title(420, 26, '② 双阈值 + 滞后连接');
  const base = 230, Hh = 150;
  const v1 = [0.15, 0.3, 0.6, 1.0, 0.7, 0.35, 0.15];
  v1.forEach((v, i) => {
    const x = 40 + i * 50;
    body += rect(x, base - v * Hh, 36, v * Hh, i === 3 ? `fill="${BLUE}"` : `fill="${PALE}" stroke="${GRID}"`);
  });
  body += text(40 + 3 * 50 + 18, base - Hh - 8, '比两侧都大 → 保留', { 'text-anchor': 'middle', fill: BLUE, 'font-size': 12 });
  body += text(40 + 18, base - 0.15 * Hh - 8, '置 0', { 'text-anchor': 'middle', fill: MUTED, 'font-size': 11 });
  body += line(40, base + 16, 376, base + 16, `stroke="${INK}" marker-end="url(#arr)"`);
  body += text(208, base + 36, '垂直于边缘的一排像素（梯度方向，取 4 个方向之一）', { 'text-anchor': 'middle', 'font-size': 12, fill: MUTED });
  body += text(208, base + 54, '结果：粗边缘变成 1 像素宽', { 'text-anchor': 'middle', 'font-size': 12 });

  const v2 = [0.2, 0.5, 0.6, 0.9, 0.7, 0.55, 0.45, 0.15, 0.1, 0.5, 0.55, 0.4, 0.2, 0.1];
  const high = 0.8, low = 0.32;
  v2.forEach((v, i) => {
    const x = 430 + i * 24;
    const fill = v >= high ? BLUE : v >= low ? (i >= 1 && i <= 6 ? LBLUE : LRED) : PALE;
    body += rect(x, base - v * Hh, 18, v * Hh, `fill="${fill}"`);
  });
  body += line(425, base - high * Hh, 770, base - high * Hh, `stroke="${INK}" stroke-dasharray="5 3"`);
  body += line(425, base - low * Hh, 770, base - low * Hh, `stroke="${INK}" stroke-dasharray="2 3"`);
  body += text(430, base + 20, '沿着边缘走的一串像素', { 'font-size': 12, fill: MUTED });
  const leg: [string, string][] = [[BLUE, '强：直接算边缘'], [LBLUE, '弱，但连着强的 → 保留'], [LRED, '弱且孤立 → 丢掉']];
  leg.forEach(([c, s], i) => {
    body += rect(430, base + 34 + i * 20, 12, 12, `fill="${c}"`) + text(447, base + 45 + i * 20, s, { 'font-size': 12 });
  });
  body += line(600, base + 40, 626, base + 40, `stroke="${INK}" stroke-dasharray="5 3"`) + text(632, base + 45, '高阈值：梯度强度百分位', { 'font-size': 12 });
  body += text(632, base + 63, '（中档取第 90 百分位）', { 'font-size': 11, fill: MUTED });
  body += line(600, base + 80, 626, base + 80, `stroke="${INK}" stroke-dasharray="2 3"`) + text(632, base + 85, '低阈值 = 0.4 × 高', { 'font-size': 12 });
  save('canny.svg', svg(790, 330, body));
}

// 串链：像素分类
{
  const C = 26, ox = 24, oy = 44, cols = 14, rows = 10;
  const pix: [number, number][] = [
    [6, 9], [6, 8], [6, 7], [6, 6], [6, 5],
    [5, 4], [4, 3], [3, 2], [2, 1], [1, 0],
    [7, 4], [8, 3], [9, 2], [10, 1], [11, 0],
    [9, 4],
  ];
  const on = new Set(pix.map(([x, y]) => `${x},${y}`));
  const nb = (x: number, y: number) => {
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && on.has(`${x + dx},${y + dy}`)) c++;
    return c;
  };
  let body = title(20, 26, '串链：按邻居个数给边缘像素分类，再沿着走');
  for (let y = 0; y <= rows; y++) body += line(ox, oy + y * C, ox + cols * C, oy + y * C, `stroke="${PALE}"`);
  for (let x = 0; x <= cols; x++) body += line(ox + x * C, oy, ox + x * C, oy + rows * C, `stroke="${PALE}"`);
  for (const [x, y] of pix) {
    const n = nb(x, y);
    const fill = n === 1 ? GREEN : n === 2 ? '#fdba74' : RED;
    body += rect(ox + x * C + 1, oy + y * C + 1, C - 2, C - 2, `fill="${fill}"`);
  }
  const cen = (p: [number, number]): [number, number] => [ox + (p[0] + 0.5) * C, oy + (p[1] + 0.5) * C];
  const chainsDemo: { pts: [number, number][]; label: string; spur?: boolean }[] = [
    { pts: [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5]], label: '1' },
    { pts: [[11, 0], [10, 1], [9, 2], [8, 3]], label: '2' },
    { pts: [[9, 4], [8, 3]], label: '3', spur: true },
    { pts: [[6, 9], [6, 8], [6, 7], [6, 6], [6, 5]], label: '4' },
    { pts: [[8, 3], [7, 4], [6, 5]], label: '5' },
  ];
  for (const c of chainsDemo) {
    body += poly(c.pts.map(cen), `stroke="${c.spur ? RED : INK}" stroke-width="2" ${c.spur ? 'stroke-dasharray="3 2"' : ''}`);
    const m = cen(c.pts[Math.floor((c.pts.length - 1) / 2)]);
    const off = c.label === '5' ? [-14, 14] : c.label === '3' ? [16, 8] : [14, -10];
    body += circ(m[0] + off[0], m[1] + off[1], 9, `fill="#fff" stroke="${c.spur ? RED : INK}"`);
    body += text(m[0] + off[0], m[1] + off[1] + 4, c.label, { 'text-anchor': 'middle', 'font-size': 11, fill: c.spur ? RED : INK });
  }
  const lx = 410;
  const leg: [string, string][] = [[GREEN, '端点：1 个邻居'], ['#fdba74', '普通点：2 个邻居'], [RED, '交叉点：≥ 3 个邻居']];
  leg.forEach(([c, s], i) => (body += rect(lx, 52 + i * 24, 14, 14, `fill="${c}"`) + text(lx + 22, 64 + i * 24, s)));
  const steps = [
    '走法（8 邻域）：',
    '1. 从每个端点出发，走到端点或交叉点为止 → 链 1–4',
    '2. 再从每个交叉点的每个没走过的分支出发 → 链 5',
    '3. 还没走过的像素必然成环 → 闭合链',
    '',
    '清理：',
    '• 链 3 一头连交叉点、一头悬空、长 < 3 像素',
    '   → 当毛刺剪掉',
    '• 端点相距 ≤ 2 像素的链首尾接上（2 和 5、',
    '   1 和 4 都在交叉点相遇，会被接成更长的链）',
    '',
    '细化后又删掉了台阶拐角像素，所以普通线上',
    '每个点恰好 2 个邻居，不会到处是假交叉点。',
  ];
  steps.forEach((s, i) => (body += text(lx, 144 + i * 19, s, { 'font-size': 12, ...(s.endsWith('：') ? { 'font-weight': 600 } : {}) })));
  save('chains.svg', svg(790, 400, body));
}

// 清理：接断线 / 过滤 / 简化
{
  let body = title(20, 26, '接断线') + title(280, 26, '过滤') + title(540, 26, '简化（道格拉斯-普克）');
  // 接断线
  body += poly([[30, 170], [60, 140], [100, 128], [128, 124]], `stroke="${hue(0)}" stroke-width="2.4"`);
  body += poly([[136, 122], [170, 112], [205, 85], [230, 60]], `stroke="${hue(1)}" stroke-width="2.4"`);
  body += circ(132, 123, 13, `fill="none" stroke="${MUTED}" stroke-dasharray="3 2"`);
  body += text(132, 158, '端点相距 ≤ 2 像素', { 'text-anchor': 'middle', 'font-size': 12 });
  body += text(30, 205, '→ 合成一条链，少一次跳线', { 'font-size': 12 });
  body += text(30, 225, '（也会顺便把首尾相接的链标成闭环）', { 'font-size': 11, fill: MUTED });
  // 过滤
  const lens = [[300, 60, 500, 60], [300, 90, 470, 90], [300, 120, 420, 120], [300, 150, 330, 150], [345, 150, 360, 150], [380, 150, 390, 150]];
  lens.forEach(([a, b, c, d], i) => {
    const keep = i < 3;
    body += line(a, b, c, d, keep ? `stroke="${hue(i)}" stroke-width="2.4"` : `stroke="${MUTED}" stroke-width="2.4" stroke-dasharray="2 3"`);
  });
  body += text(400, 150 + 4, '× 太短', { fill: RED, 'font-size': 12 });
  body += text(290, 185, '链长 < 对角线 × 最短比例 → 丢掉', { 'font-size': 12 });
  body += text(290, 205, '再按长度排序，只留最长的 K 条', { 'font-size': 12 });
  body += text(290, 225, '（中档：1%，K = 150）', { 'font-size': 11, fill: MUTED });
  // 简化
  const stair: [number, number][] = [];
  let sx = 560, sy = 170;
  for (let i = 0; i < 9; i++) {
    stair.push([sx, sy]);
    sx += 12;
    stair.push([sx, sy]);
    if (i % 2 === 0) {
      sy -= 12;
      stair.push([sx, sy]);
    }
  }
  const a = stair[0], b = stair[stair.length - 1];
  const nx = -(b[1] - a[1]), ny = b[0] - a[0], nl = Math.hypot(nx, ny), tol = 10;
  body += `<path d="M${a[0] + (nx / nl) * tol},${a[1] + (ny / nl) * tol}L${b[0] + (nx / nl) * tol},${b[1] + (ny / nl) * tol}L${b[0] - (nx / nl) * tol},${b[1] - (ny / nl) * tol}L${a[0] - (nx / nl) * tol},${a[1] - (ny / nl) * tol}Z" fill="#fef3c7"/>`;
  body += poly(stair, `stroke="${MUTED}" stroke-width="1.2"`);
  stair.forEach((p) => (body += circ(p[0], p[1], 2, `fill="${MUTED}"`)));
  body += line(a[0], a[1], b[0], b[1], `stroke="${TRACE}" stroke-width="2.4"`);
  body += text(550, 205, '像素台阶上所有点都在容差带内', { 'font-size': 12 });
  body += text(550, 225, '→ 中间点全删，只留两端（中档容差 1 px）', { 'font-size': 12 });
  save('cleanup.svg', svg(790, 245, body));
}

// 剪影：大津阈值 + 行进方块
{
  let body = title(20, 26, '① 大津法：自动找黑白分界') + title(400, 26, '② 行进方块：沿黑白交界描出闭合边界');
  const bins = 32;
  const hist = Array.from({ length: bins }, (_, i) => 60 * Math.exp(-(((i - 7) / 3) ** 2)) + 100 * Math.exp(-(((i - 24) / 2.5) ** 2)) + 3);
  let best = -1, thr = 0;
  const tot = hist.reduce((s, v) => s + v, 0), sumAll = hist.reduce((s, v, i) => s + v * i, 0);
  let wB = 0, sB = 0;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    sB += t * hist[t];
    const wF = tot - wB;
    if (!wF) break;
    const d = wB * wF * (sB / wB - (sumAll - sB) / wF) ** 2;
    if (d > best) { best = d; thr = t; }
  }
  const base = 230, bw = 10;
  hist.forEach((v, i) => (body += rect(30 + i * bw, base - v * 1.5, bw - 1, v * 1.5, `fill="${i <= thr ? INK : PALE}"`)));
  const tx = 30 + (thr + 1) * bw - 0.5;
  body += line(tx, 50, tx, base, `stroke="${RED}" stroke-width="2"`);
  body += text(tx + 6, 62, '阈值：使两类的类间方差最大', { fill: RED, 'font-size': 12 });
  body += text(30, base + 18, '暗', { 'font-size': 11, fill: MUTED }) + text(30 + bins * bw, base + 18, '亮', { 'font-size': 11, fill: MUTED, 'text-anchor': 'end' });
  body += text(30, base + 40, '灰度直方图（先高斯模糊）。边框多数是暗的就黑白对调，', { 'font-size': 12 });
  body += text(30, base + 58, '保证「前景」是图形而不是背景。', { 'font-size': 12 });

  const mask = ['000000', '011100', '011110', '001100', '000000'];
  const U = 44, ox = 420, oy = 50;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) {
    const v = mask[y][x] === '1';
    body += circ(ox + x * U, oy + y * U, 7, v ? `fill="${INK}"` : `fill="#fff" stroke="${MUTED}"`);
  }
  const contour: [number, number][] = [[1, 0.5], [2, 0.5], [3, 0.5], [3.5, 1], [4, 1.5], [4.5, 2], [4, 2.5], [3.5, 3], [3, 3.5], [2, 3.5], [1.5, 3], [1, 2.5], [0.5, 2], [0.5, 1]];
  body += poly(contour.map(([x, y]) => [ox + x * U, oy + y * U] as [number, number]), `stroke="${TRACE}" stroke-width="2.4"`, true);
  contour.forEach(([x, y]) => (body += circ(ox + x * U, oy + y * U, 3, `fill="${TRACE}"`)));
  body += rect(ox + 3 * U, oy + 1 * U, U, U, `fill="none" stroke="${BLUE}" stroke-width="1.5" stroke-dasharray="4 3"`);
  body += text(ox + 4 * U + 10, oy + 1 * U - 4, '一个 2×2 格：看四角黑白（16 种）', { 'font-size': 11, fill: BLUE });
  body += text(420, base + 40, '每个格按四角查表连一小段，端点取在格边中点；', { 'font-size': 12 });
  body += text(420, base + 58, '小段首尾相接成闭合折线。洞的边界也会被描出来。', { 'font-size': 12 });
  save('silhouette.svg', svg(790, 300, body));
}

// 一笔画：贪心 / 2-opt / 树形
{
  let body = title(20, 26, '① 贪心：每次去最近的入口') + title(280, 26, '② 2-opt：倒序一段，解开交叉') + title(540, 26, '③ 树形往返（备选）');
  const ch = (pts: [number, number][], c: string, closed = false) => poly(pts, `stroke="${c}" stroke-width="2.6" marker-end="url(#arr)"`, closed);
  const jump = (a: [number, number], b: [number, number], extra = '') =>
    line(a[0], a[1], b[0], b[1], `stroke="${MUTED}" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#arr)" ${extra}`);
  // 贪心
  body += ch([[40, 80], [120, 80]], hue(0));
  body += circ(120, 80, 4, `fill="${INK}"`) + text(108, 70, '出口', { 'font-size': 11 });
  body += poly([[160, 130], [230, 70]], `stroke="${hue(1)}" stroke-width="2.6"`);
  body += circ(190, 215, 30, `fill="none" stroke="${hue(2)}" stroke-width="2.6"`);
  body += line(120, 80, 230, 70, `stroke="${PALE}" stroke-width="1.2"`) + line(120, 80, 175, 189, `stroke="${PALE}" stroke-width="1.2"`);
  body += jump([120, 80], [158, 128]) + text(150, 112, '最近', { 'font-size': 11, fill: MUTED, 'text-anchor': 'end' });
  body += text(20, 272, '开放链两端都能当入口（反着走），', { 'font-size': 12 });
  body += text(20, 290, '闭环的任一顶点都能当入口。用网格查最近。', { 'font-size': 12 });
  // 2-opt
  const T = (p: [number, number], dy: number): [number, number] => [300 + p[0], dy + p[1]];
  const draw2 = (dy: number, seq: [string, [number, number], [number, number]][]) => {
    let out = '';
    seq.forEach(([name, a, b], i) => {
      out += ch([T(a, dy), T(b, dy)], hue('ABCD'.indexOf(name)));
      const mid = T([(a[0] + b[0]) / 2, a[1]], dy);
      out += text(mid[0], mid[1] + (a[1] < 40 ? -6 : 16), name, { 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 600 });
      out += jump(T(b, dy), T(seq[(i + 1) % seq.length][1], dy));
    });
    return out;
  };
  body += text(280, 50, '之前：A → C → B → D，跳线交叉', { 'font-size': 12 });
  body += draw2(66, [['A', [10, 10], [70, 10]], ['C', [110, 70], [170, 70]], ['B', [170, 10], [110, 10]], ['D', [70, 70], [10, 70]]]);
  body += text(280, 172, '之后：把 [C, B] 倒序、各自掉头', { 'font-size': 12 });
  body += draw2(188, [['A', [10, 10], [70, 10]], ['B', [110, 10], [170, 10]], ['C', [170, 70], [110, 70]], ['D', [70, 70], [10, 70]]]);
  body += text(280, 296, '总跳线变短就接受；最多跑 200 ms', { 'font-size': 12 });
  // 树形
  body += ch([[560, 70], [740, 70]], hue(0));
  body += ch([[580, 130], [580, 200]], hue(1));
  body += ch([[720, 120], [760, 190]], hue(2));
  body += line(560, 70, 580, 130, `stroke="${MUTED}" stroke-width="1.4" stroke-dasharray="4 3" marker-start="url(#arr)" marker-end="url(#arr)"`);
  body += line(740, 70, 720, 120, `stroke="${MUTED}" stroke-width="1.4" stroke-dasharray="4 3" marker-start="url(#arr)" marker-end="url(#arr)"`);
  const tnotes = ['链之间连最小生成树，深度优先走：', '父链走到头 → 跳到子链 → 子链来回', '→ 跳回 → 父链反着走回来。', '每条跳线正反各走一次、自身重合，', '所以看不出跳线；代价是总长约翻倍。'];
  tnotes.forEach((s, i) => (body += text(540, 222 + i * 17, s, { 'font-size': 12 })));
  save('tour.svg', svg(790, 310, body));
}

// 重采样
{
  const rowY = [86, 186];
  let body = title(20, 26, '按弧长等距取 N 个点（示意：N = 32，只画一段）');
  const segs = [{ a: 40, b: 280, jump: false }, { a: 280, b: 400, jump: true }, { a: 400, b: 640, jump: false }];
  const labels = ['跳线权重 1：跳线上的点和线上一样密，笔在跳线上耗时', '开启「跳线加速」（权重 0.3）：跳线只算 0.3 倍长度，笔很快掠过'];
  [1, 0.3].forEach((wgt, r) => {
    const y = rowY[r];
    body += text(40, y - 30, labels[r], { 'font-size': 12 });
    for (const s of segs) body += line(s.a, y, s.b, y, s.jump ? `stroke="${MUTED}" stroke-dasharray="4 3" stroke-width="1.4"` : `stroke="${TRACE}" stroke-width="3"`);
    const L = segs.reduce((acc, s) => acc + (s.b - s.a) * (s.jump ? wgt : 1), 0);
    const n = 32;
    for (let i = 0; i < n; i++) {
      let d = (i * L) / n;
      for (const s of segs) {
        const len = (s.b - s.a) * (s.jump ? wgt : 1);
        if (d < len || s === segs[segs.length - 1]) {
          const x = s.a + d / (s.jump ? wgt : 1);
          body += circ(x, y, 3.2, `fill="${s.jump ? '#fff' : TRACE}" stroke="${s.jump ? MUTED : TRACE}" stroke-width="1.4"`);
          break;
        }
        d -= len;
      }
    }
  });
  body += text(660, rowY[0] + 4, '链', { fill: TRACE, 'font-size': 12 });
  body += text(330, rowY[1] + 24, '跳线', { fill: MUTED, 'font-size': 12, 'text-anchor': 'middle' });
  body += text(40, 236, '先做 y 翻转（图片 y 朝下，数学 y 朝上）、平移到包围盒中心、缩放到最长半边 = 100，再按累计弧长线性插值。', { 'font-size': 12, fill: MUTED });
  save('resample.svg', svg(790, 252, body));
}

// 本轮套均轮
{
  const star = DEMO_CURVES.find((d) => d.id === 'star')!;
  const r = runPipeline({ kind: 'curve', chains: star.make() }, { detail: 'medium', tree: false, jumpWeight: 1 });
  const s = r.spec, N = s.N, M = 4, frac = 0.18;
  const k = 1.6, cx = 215, cy = 220;
  const X = (x: number) => cx + k * x, Y = (y: number) => cy - k * y;
  let body = title(20, 26, `本轮套均轮：五角星的前 ${M} 个圆，t = ${frac} × 2π 时`);
  const target: [number, number][] = [];
  for (let n = 0; n < N; n += 4) target.push([X(r.sampled.x[n]), Y(r.sampled.y[n])]);
  body += poly(target, `stroke="${PALE}" stroke-width="3"`, true);
  const tr = traceCurve(s, M);
  const done: [number, number][] = [];
  for (let n = 0; n <= Math.floor(frac * N); n += 2) done.push([X(tr.x[n]), Y(tr.y[n])]);
  body += poly(done, `stroke="${TRACE}" stroke-width="2.4"`);
  const t = 2 * Math.PI * frac;
  let x = s.c0re, y = s.c0im;
  body += circ(X(x), Y(y), 3, `fill="${INK}"`) + text(X(x) + 6, Y(y) + 16, 'c₀（重心）', { 'font-size': 11, fill: MUTED });
  for (let j = 0; j < M; j++) {
    const c = Math.cos(s.k[j] * t), sn = Math.sin(s.k[j] * t);
    const nx = x + s.re[j] * c - s.im[j] * sn, ny = y + s.re[j] * sn + s.im[j] * c;
    body += circ(X(x), Y(y), s.r[j] * k, `fill="none" stroke="${BLUE}" stroke-opacity="${j === 0 ? 0.55 : 0.4}"`);
    body += line(X(x), Y(y), X(nx), Y(ny), `stroke="${INK}" stroke-width="1.6" marker-end="url(#arrs)"`);
    x = nx;
    y = ny;
  }
  body += circ(X(x), Y(y), 4, `fill="${TRACE}"`) + text(X(x) + 8, Y(y) - 6, '笔尖', { 'font-size': 12, fill: TRACE });
  const terms = Array.from({ length: M }, (_, j) => `k = ${s.k[j] > 0 ? '+' : ''}${s.k[j]}，r = ${s.r[j].toFixed(1)}`);
  const notes = [
    'z(t) = c₀ + Σ cₖ·e^(ikt)，cₖ = rₖ·e^(iφₖ)',
    '',
    '每一项 = 一个转动的箭头（画出来就是一个圆）：',
    '• 半径 rₖ = |cₖ|',
    '• 转速 k：t 走完一圈，它转 |k| 圈',
    '• k > 0 逆时针，k < 0 顺时针',
    '• 初始角 φₖ = arg cₖ',
    '',
    '箭头按半径从大到小首尾相接，',
    '最后一个箭头的尖就是笔。',
    '',
    `这 ${M} 个圆（大 → 小）：`,
    ...terms.map((s) => '   ' + s),
  ];
  notes.forEach((s, i) => (body += text(440, 56 + i * 19, s, { 'font-size': 12 })));
  save('epicycles.svg', svg(790, 420, body));
}

console.log('done');

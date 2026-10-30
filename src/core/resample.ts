// 第四步：按弧长重采样，让笔匀速走完全程。
import type { Tour } from './tour';

export interface Sampled {
  N: number;
  x: Float64Array;
  y: Float64Array;
  /** 采样点在输入上的坐标（y 翻转、归一化之前；图片输入即缩放后原图的像素坐标），取色用 */
  px: Float64Array;
  py: Float64Array;
  /** jump[n] = 1 表示第 n 个采样点落在跳线上 */
  jump: Uint8Array;
  /** 世界坐标 = (像素坐标 − 中心) × scale */
  scale: number;
  cx: number;
  cy: number;
  /** 图片高度（做过 y 翻转时），数学曲线输入时为 null */
  flipH: number | null;
}

export function resample(tour: Tour, N: number, flipH: number | null, jumpWeight = 1): Sampled {
  const P = tour.pts.length / 2;
  const xs = new Float64Array(P);
  const ys = new Float64Array(P);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < P; i++) {
    const x = tour.pts[2 * i];
    // 图片 y 轴朝下，数学 y 轴朝上
    const y = flipH === null ? tour.pts[2 * i + 1] : flipH - tour.pts[2 * i + 1];
    xs[i] = x;
    ys[i] = y;
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const half = Math.max((maxx - minx) / 2, (maxy - miny) / 2) || 1;
  const scale = 100 / half;
  for (let i = 0; i < P; i++) {
    xs[i] = (xs[i] - cx) * scale;
    ys[i] = (ys[i] - cy) * scale;
  }

  const cum = new Float64Array(P + 1);
  for (let i = 0; i < P; i++) {
    const j = (i + 1) % P;
    const len = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    cum[i + 1] = cum[i] + len * (tour.jump[i] ? jumpWeight : 1);
  }
  const L = cum[P];

  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const jump = new Uint8Array(N);
  const raw = tour.pts;
  let seg = 0;
  for (let n = 0; n < N; n++) {
    const s = (n * L) / N;
    while (seg < P - 1 && cum[seg + 1] <= s) seg++;
    const len = cum[seg + 1] - cum[seg];
    const u = len > 0 ? (s - cum[seg]) / len : 0;
    const j = (seg + 1) % P;
    x[n] = xs[seg] + (xs[j] - xs[seg]) * u;
    y[n] = ys[seg] + (ys[j] - ys[seg]) * u;
    px[n] = raw[2 * seg] + (raw[2 * j] - raw[2 * seg]) * u;
    py[n] = raw[2 * seg + 1] + (raw[2 * j + 1] - raw[2 * seg + 1]) * u;
    jump[n] = tour.jump[seg] ? 1 : 0;
  }
  return { N, x, y, px, py, jump, scale, cx, cy, flipH };
}

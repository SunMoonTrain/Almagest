// 第五步：傅里叶系数。只算一次、按半径降序排好；圆数量档位只做截断。
import { fft } from './fft';

/** 结构数组形式，方便在 Worker 和主线程之间零拷贝传递。不含 c_0。 */
export interface Spectrum {
  N: number;
  c0re: number;
  c0im: number;
  k: Int32Array;
  re: Float64Array;
  im: Float64Array;
  r: Float64Array;
  phi: Float64Array;
  /** cum[j] = 前 j+1 个圆的 r² 之和 */
  cum: Float64Array;
  /** 所有 r² 之和（不含 c_0） */
  total: number;
}

export interface Term {
  k: number;
  re: number;
  im: number;
  r: number;
  phi: number;
}

export function computeSpectrum(zr: Float64Array, zi: Float64Array): Spectrum {
  const N = zr.length;
  const re = zr.slice();
  const im = zi.slice();
  fft(re, im);
  for (let m = 0; m < N; m++) {
    re[m] /= N;
    im[m] /= N;
  }
  const order: number[] = [];
  for (let m = 1; m < N; m++) order.push(m);
  const rad = new Float64Array(N);
  for (let m = 0; m < N; m++) rad[m] = Math.hypot(re[m], im[m]);
  order.sort((a, b) => rad[b] - rad[a]);

  const n = order.length;
  const spec: Spectrum = {
    N,
    c0re: re[0],
    c0im: im[0],
    k: new Int32Array(n),
    re: new Float64Array(n),
    im: new Float64Array(n),
    r: new Float64Array(n),
    phi: new Float64Array(n),
    cum: new Float64Array(n),
    total: 0,
  };
  let acc = 0;
  for (let j = 0; j < n; j++) {
    const m = order[j];
    // 下标换算：m < N/2 → k = m，否则 k = m − N（顺时针的圆）
    spec.k[j] = m < N / 2 ? m : m - N;
    spec.re[j] = re[m];
    spec.im[j] = im[m];
    spec.r[j] = rad[m];
    spec.phi[j] = Math.atan2(im[m], re[m]);
    acc += rad[m] * rad[m];
    spec.cum[j] = acc;
  }
  spec.total = acc;
  return spec;
}

/** 圆数上限：N 至少是圆数的 2 倍，否则高频混叠。 */
export function circleLimit(spec: Spectrum): number {
  return Math.min(spec.k.length, spec.N / 2);
}

/** 保留能量比例达到 frac 所需的最少圆数。 */
export function countForEnergy(spec: Spectrum, frac: number): number {
  const limit = circleLimit(spec);
  if (spec.total === 0) return 1;
  const target = frac * spec.total;
  let lo = 0;
  let hi = limit - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spec.cum[mid] >= target) hi = mid;
    else lo = mid + 1;
  }
  return Math.max(1, lo + 1);
}

export function energyKept(spec: Spectrum, M: number): number {
  if (spec.total === 0 || M <= 0) return spec.total === 0 ? 1 : 0;
  return spec.cum[Math.min(M, spec.cum.length) - 1] / spec.total;
}

export function termsOf(spec: Spectrum, M: number): Term[] {
  const out: Term[] = [];
  const n = Math.min(M, spec.k.length);
  for (let j = 0; j < n; j++) {
    out.push({ k: spec.k[j], re: spec.re[j], im: spec.im[j], r: spec.r[j], phi: spec.phi[j] });
  }
  return out;
}

/** 笔迹预计算：把前 M 个系数放回数组，做一次逆变换，得到 N 个笔迹点。 */
export function traceCurve(spec: Spectrum, M: number): { x: Float64Array; y: Float64Array } {
  const N = spec.N;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  re[0] = spec.c0re;
  im[0] = spec.c0im;
  const n = Math.min(M, spec.k.length);
  for (let j = 0; j < n; j++) {
    const k = spec.k[j];
    const m = k < 0 ? k + N : k;
    re[m] = spec.re[j];
    im[m] = spec.im[j];
  }
  fft(re, im, true);
  return { x: re, y: im };
}

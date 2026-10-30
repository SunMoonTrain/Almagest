// 按原图颜色给笔迹上色：每个采样点沿法线向两侧偏移取色，在 OKLab 里平滑。
// 第 n 个笔迹点（逆 FFT 的第 n 个输出）直接用第 n 个采样点的颜色，所以圆数变化时不用重算。
import type { Sampled } from './resample';

export interface ColorOptions {
  /** 沿法线向两侧的取色偏移（像素） */
  offset: number;
  /** 最低亮度（OKLab L，0–1）；null 表示不提亮 */
  minL: number | null;
  /** 滑动平均窗口（采样点个数） */
  window?: number;
}

export interface TraceColors {
  /** N × 3 的 sRGB */
  rgb: Uint8Array;
  /** ok[n] = 1 表示第 n 点取到了颜色；0（跳线或没找到）用默认笔迹颜色 */
  ok: Uint8Array;
}

/** 比这暗的颜色当作描线本身，不取 */
const BLACK_L = 0.2;
/** 两侧都无效时最多再往外走几步 */
const EXTRA_STEPS = 3;

const toLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const LIN = Float64Array.from({ length: 256 }, (_, i) => toLin(i));
const fromLin = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = LIN[r], lg = LIN[g], lb = LIN[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function traceColors(s: Sampled, rgba: Uint8ClampedArray, w: number, h: number, o: ColorOptions): TraceColors {
  const N = s.N;
  const L = new Float64Array(N), A = new Float64Array(N), B = new Float64Array(N);
  const ok = new Uint8Array(N);
  const step = Math.max(1.5, o.offset / 2);

  /** 取 (x, y) 处的颜色；无效（出界、透明、近黑）返回 null */
  const pick = (x: number, y: number): [number, number, number] | null => {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
    const p = 4 * (iy * w + ix);
    if (rgba[p + 3] < 128) return null;
    const lab = rgbToOklab(rgba[p], rgba[p + 1], rgba[p + 2]);
    return lab[0] < BLACK_L ? null : lab;
  };

  for (let n = 0; n < N; n++) {
    if (s.jump[n]) continue;
    const a = (n - 2 + N) % N, b = (n + 2) % N;
    let tx = s.px[b] - s.px[a], ty = s.py[b] - s.py[a];
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-9) {
      tx /= tl;
      ty /= tl;
    } else {
      tx = 1;
      ty = 0;
    }
    const nx = -ty, ny = tx;
    for (let k = 0; k <= EXTRA_STEPS; k++) {
      const d = o.offset + k * step;
      const c1 = pick(s.px[n] + nx * d, s.py[n] + ny * d);
      const c2 = pick(s.px[n] - nx * d, s.py[n] - ny * d);
      if (!c1 && !c2) continue;
      // 两侧都有效时取饱和度（OKLab 色度）更高的一侧
      const c = !c2 || (c1 && Math.hypot(c1[1], c1[2]) >= Math.hypot(c2[1], c2[2])) ? c1! : c2;
      L[n] = c[0];
      A[n] = c[1];
      B[n] = c[2];
      ok[n] = 1;
      break;
    }
  }

  // 沿曲线滑动平均，不跨越跳线、不混入没取到颜色的点
  const half = Math.floor((o.window ?? 5) / 2);
  const rgb = new Uint8Array(N * 3);
  for (let n = 0; n < N; n++) {
    if (!ok[n]) continue;
    let sl = L[n], sa = A[n], sb = B[n], cnt = 1;
    for (const dir of [-1, 1]) {
      for (let k = 1; k <= half; k++) {
        const m = (n + dir * k + N) % N;
        if (s.jump[m]) break;
        if (!ok[m]) continue;
        sl += L[m];
        sa += A[m];
        sb += B[m];
        cnt++;
      }
    }
    let l = sl / cnt;
    // 深色背景上看得见：亮度提到下限，色相和色度不变
    if (o.minL !== null && l < o.minL) l = o.minL;
    const [r, g, bb] = oklabToRgb(l, sa / cnt, sb / cnt);
    rgb[3 * n] = r;
    rgb[3 * n + 1] = g;
    rgb[3 * n + 2] = bb;
  }
  return { rgb, ok };
}

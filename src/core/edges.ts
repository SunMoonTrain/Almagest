// 第一步：预处理与边缘提取（Canny），以及剪影模式用的大津法二值化。

export interface Gray {
  w: number;
  h: number;
  data: Float32Array;
}

/** 转灰度；透明区域铺成白色。 */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    data[i] = lum * a + 255 * (1 - a);
  }
  return { w, h, data };
}

export function gaussianBlur(g: Gray, sigma: number): Gray {
  if (sigma <= 0) return g;
  const { w, h, data } = g;
  const rad = Math.ceil(sigma * 3);
  const kernel = new Float32Array(2 * rad + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + rad] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        acc += data[row + xx] * kernel[i + rad];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        acc += tmp[yy * w + x] * kernel[i + rad];
      }
      out[y * w + x] = acc;
    }
  }
  return { w, h, data: out };
}

/** 返回 1 像素宽的边缘图（0/1）。阈值按梯度强度的百分位自适应。 */
export function canny(g: Gray, sigma: number, highPct: number, lowRatio: number): Uint8Array {
  const { w, h } = g;
  const b = gaussianBlur(g, sigma).data;
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);
  let max = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1] + b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1];
      const gy = -b[i - w - 1] - 2 * b[i - w] - b[i - w + 1] + b[i + w - 1] + 2 * b[i + w] + b[i + w + 1];
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > max) max = m;
      let a = Math.atan2(gy, gx);
      if (a < 0) a += Math.PI;
      const deg = (a * 180) / Math.PI;
      dir[i] = deg < 22.5 || deg >= 157.5 ? 0 : deg < 67.5 ? 1 : deg < 112.5 ? 2 : 3;
    }
  }
  const edge = new Uint8Array(w * h);
  if (max === 0) return edge;

  // 非极大值抑制：沿梯度方向只保留峰值
  const off = [1, w + 1, w, w - 1];
  const nms = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m === 0) continue;
      const o = off[dir[i]];
      if (m > mag[i - o] && m >= mag[i + o]) nms[i] = m;
    }
  }

  // 高阈值取全图梯度强度的百分位，并设下限防止平坦图片满屏噪点
  const BINS = 1024;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < w * h; i++) hist[Math.min(BINS - 1, Math.floor((mag[i] / max) * BINS))]++;
  const target = highPct * w * h;
  let acc = 0;
  let bin = 0;
  for (; bin < BINS; bin++) {
    acc += hist[bin];
    if (acc >= target) break;
  }
  const high = Math.max(((bin + 1) / BINS) * max, 0.08 * max);
  const low = high * lowRatio;

  // 双阈值 + 滞后连接
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (nms[i] >= high && !edge[i]) {
      edge[i] = 1;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        const jx = j % w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = jx + dx;
            if (nx < 0 || nx >= w) continue;
            const n = j + dy * w + dx;
            if (n < 0 || n >= w * h) continue;
            if (!edge[n] && nms[n] >= low) {
              edge[n] = 1;
              stack.push(n);
            }
          }
        }
      }
    }
  }

  // 画面边框不算边缘
  clearBorder(edge, w, h, 2);
  thin(edge, w, h);
  return edge;
}

function clearBorder(img: Uint8Array, w: number, h: number, m: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < m || y < m || x >= w - m || y >= h - m) img[y * w + x] = 0;
    }
  }
}

/**
 * Zhang-Suen 细化，再去掉 4 连通台阶上的多余拐角像素，
 * 保证串链时普通点恰好 2 个邻居，不会到处是假交叉点。
 */
export function thin(img: Uint8Array, w: number, h: number): void {
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!img[i]) continue;
          const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1];
          const p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A =
            (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) +
            (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
          if (A !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(i);
        }
      }
      for (const d of del) img[d] = 0;
      if (del.length) changed = true;
    }
  }
  // 台阶拐角：两个相互垂直的 4 邻居都在、对面两侧和对角都空 → 删掉不影响连通
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!img[i]) continue;
      const N = img[i - w], E = img[i + 1], S = img[i + w], W = img[i - 1];
      const NE = img[i - w + 1], SE = img[i + w + 1], SW = img[i + w - 1], NW = img[i - w - 1];
      if (
        (N && E && !S && !W && !SW) ||
        (E && S && !N && !W && !NW) ||
        (S && W && !N && !E && !NE) ||
        (W && N && !S && !E && !SE)
      ) {
        img[i] = 0;
      }
    }
  }
}

export function otsu(g: Gray): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.data.length; i++) hist[Math.max(0, Math.min(255, Math.round(g.data[i])))]++;
  const total = g.data.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, best = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr + 0.5;
}

/** 剪影模式：大津法二值化，前景为与边框颜色相反的那一类。 */
export function silhouetteMask(g: Gray, sigma: number): Uint8Array {
  const b = gaussianBlur(g, sigma);
  const thr = otsu(b);
  const { w, h, data } = b;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = data[i] < thr ? 1 : 0;
  let border = 0, dark = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        border++;
        dark += mask[y * w + x];
      }
    }
  }
  if (dark > border / 2) for (let i = 0; i < w * h; i++) mask[i] ^= 1;
  return mask;
}

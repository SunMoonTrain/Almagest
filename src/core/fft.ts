// 原地迭代基 2 快速傅里叶变换。旋转因子按长度缓存，避免递推累积浮点误差。

interface Table {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const tables = new Map<number, Table>();

function table(n: number): Table {
  let t = tables.get(n);
  if (t) return t;
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let j = 0; j < half; j++) {
    cos[j] = Math.cos((2 * Math.PI * j) / n);
    sin[j] = Math.sin((2 * Math.PI * j) / n);
  }
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  tables.set(n, t);
  return t;
}

/**
 * inverse = false：X_m = Σ x_n e^{-2πi mn/N}
 * inverse = true ：x_n = Σ X_m e^{+2πi mn/N}（不除以 N）
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n < 1 || (n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的整数次幂');
  if (n === 1) return;
  const { cos, sin, rev } = table(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const s = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = s * sin[k];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

import { describe, expect, it } from 'vitest';
import { canny, mergeParallelEdges, pruneSpurs, toGray } from '../src/core/edges';
import { runPipeline } from '../src/core/pipeline';
import { greedyTour } from '../src/core/tour';
import { resample, type Sampled } from '../src/core/resample';
import { oklabToRgb, rgbToOklab, traceColors } from '../src/core/colorize';
import { DETAIL } from '../src/core/presets';

type RGB = [number, number, number];

/** w×h 白底图；paint(x, y) 返回该像素颜色（不返回则保持白） */
function image(w: number, h: number, paint: (x: number, y: number) => RGB | undefined): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y) ?? [255, 255, 255];
      rgba.set([...c, 255], 4 * (y * w + x));
    }
  }
  return rgba;
}

/** 横贯画面的一条 5 像素粗的黑色横线 */
const W = 160, H = 80;
const bar = image(W, H, (x, y) => (x >= 20 && x < 140 && y >= 38 && y < 43 ? [0, 0, 0] : undefined));

const columnHits = (edge: Uint8Array, x: number) => {
  let n = 0;
  for (let y = 0; y < H; y++) n += edge[y * W + x];
  return n;
};

function endpoints(img: Uint8Array, w: number, h: number): number {
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!img[y * w + x]) continue;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && img[(y + dy) * w + x + dx]) c++;
      if (c === 1) n++;
    }
  }
  return n;
}

describe('单线模式', () => {
  const p = DETAIL.medium;
  const edge = canny(toGray(bar, W, H), p.sigma, p.highPct, p.lowRatio);

  it('Canny 在粗线两侧各给一条边（双线）', () => {
    expect(columnHits(edge, 80)).toBe(2);
  });

  it('闭运算 + 骨架化后只剩一条中心线', () => {
    const single = mergeParallelEdges(edge, W, H, 3);
    expect(columnHits(single, 80)).toBe(1);
    let y0 = -1;
    for (let y = 0; y < H; y++) if (single[y * W + 80]) y0 = y;
    expect(Math.abs(y0 - 40)).toBeLessThanOrEqual(1);
  });

  it('剪毛刺：从交叉点伸出的短枝删掉，长枝保留', () => {
    const w = 60, h = 40;
    const make = (branch: number) => {
      const img = new Uint8Array(w * h);
      for (let x = 5; x < 55; x++) img[20 * w + x] = 1;
      for (let k = 1; k <= branch; k++) img[(20 - k) * w + 30] = 1;
      return img;
    };
    const short = make(4);
    expect(pruneSpurs(short, w, h, 6)).toBe(true);
    expect(endpoints(short, w, h)).toBe(2);
    const long = make(12);
    expect(pruneSpurs(long, w, h, 6)).toBe(false);
    expect(endpoints(long, w, h)).toBe(3);
  });

  it('流水线：单线得到一条开放链，双线得到闭合的轮廓', () => {
    const opts = { detail: 'medium' as const, tree: false, jumpWeight: 1 };
    const dbl = runPipeline({ kind: 'image', w: W, h: H, rgba: bar, mode: 'edge' }, opts);
    const sgl = runPipeline({ kind: 'image', w: W, h: H, rgba: bar, mode: 'edge' }, { ...opts, lineRadius: 3 });
    expect(dbl.stats.chains).toBe(1);
    expect(sgl.stats.chains).toBe(1);
    // 双线是绕粗线一圈的闭环，不需要跳线；单线是一条开放的中心线，回到起点要跳一次
    expect(dbl.stats.jumpRatio).toBeLessThan(0.01);
    expect(sgl.stats.jumpRatio).toBeGreaterThan(0.3);
  });
});

describe('原图色', () => {
  it('OKLab 往返', () => {
    for (const c of [[255, 0, 0], [12, 200, 90], [30, 30, 30], [255, 255, 255]] as RGB[]) {
      expect(oklabToRgb(...rgbToOklab(...c))).toEqual(c);
    }
  });

  it('重采样记下原图像素坐标，和归一化坐标一一对应', () => {
    const res = runPipeline({ kind: 'image', w: W, h: H, rgba: bar, mode: 'edge' }, { detail: 'medium', tree: false, jumpWeight: 1 });
    const s = res.sampled;
    for (let n = 0; n < s.N; n += 97) {
      expect(s.x[n] / s.scale + s.cx).toBeCloseTo(s.px[n], 6);
      expect(s.y[n] / s.scale + s.cy).toBeCloseTo(H - s.py[n], 6);
    }
  });

  /** 一条竖直的、来回走的线（x = 50），法线是水平方向 */
  function verticalSampled(N: number): Sampled {
    const s: Sampled = {
      N, x: new Float64Array(N), y: new Float64Array(N), px: new Float64Array(N), py: new Float64Array(N),
      jump: new Uint8Array(N), scale: 1, cx: 0, cy: 0, flipH: 60,
    };
    for (let n = 0; n < N; n++) {
      const u = n < N / 2 ? n / (N / 2) : 2 - n / (N / 2);
      s.px[n] = 50;
      s.py[n] = 10 + 40 * u;
    }
    return s;
  }

  it('描线在黑线正中：取两侧颜色，选饱和度更高的一侧', () => {
    // 左边红、右边白，中间 3 像素黑线
    const rgba = image(100, 60, (x) => (x >= 49 && x <= 51 ? [0, 0, 0] : x < 49 ? [220, 30, 30] : undefined));
    const s = verticalSampled(64);
    const c = traceColors(s, rgba, 100, 60, { offset: 4, minL: null });
    for (let n = 4; n < 28; n++) {
      expect(c.ok[n]).toBe(1);
      expect(c.rgb[3 * n]).toBeGreaterThan(180);
      expect(c.rgb[3 * n + 1]).toBeLessThan(80);
    }
  });

  it('两侧都是黑的：往外走几步也找不到就不上色；跳线不上色', () => {
    const rgba = image(100, 60, (x) => (x >= 30 && x <= 70 ? [0, 0, 0] : undefined));
    const s = verticalSampled(64);
    s.jump[40] = 1;
    const c = traceColors(s, rgba, 100, 60, { offset: 4, minL: null });
    expect(c.ok[10]).toBe(0);
    expect(c.ok[40]).toBe(0);
  });

  it('外面几步找得到颜色时用外面的', () => {
    // 黑线宽 11 像素：偏移 4 落在黑上，再往外走几步才到蓝色
    const rgba = image(100, 60, (x) => (x >= 45 && x <= 55 ? [0, 0, 0] : [40, 90, 220]));
    const c = traceColors(verticalSampled(64), rgba, 100, 60, { offset: 4, minL: null });
    expect(c.ok[10]).toBe(1);
    expect(c.rgb[30 + 2]).toBeGreaterThan(c.rgb[30]);
  });

  it('最低亮度：暗色提亮、色相不变', () => {
    const navy: RGB = [20, 28, 70];
    const rgba = image(100, 60, (x) => (x >= 49 && x <= 51 ? [0, 0, 0] : navy));
    const s = verticalSampled(64);
    const plain = traceColors(s, rgba, 100, 60, { offset: 4, minL: null });
    const lifted = traceColors(s, rgba, 100, 60, { offset: 4, minL: 0.5 });
    const lab = (c: typeof plain, n: number) => rgbToOklab(c.rgb[3 * n], c.rgb[3 * n + 1], c.rgb[3 * n + 2]);
    const [L0, a0, b0] = lab(plain, 10);
    const [L1, a1, b1] = lab(lifted, 10);
    expect(L0).toBeLessThan(0.5);
    expect(L1).toBeCloseTo(0.5, 1);
    expect(Math.atan2(b1, a1)).toBeCloseTo(Math.atan2(b0, a0), 1);
  });

  it('沿曲线平滑：红蓝交界处出现过渡色', () => {
    // 线的上半段左侧红、下半段左侧蓝
    const rgba = image(100, 60, (x, y) => (x >= 49 && x <= 51 ? [0, 0, 0] : x < 49 ? (y < 30 ? [220, 30, 30] : [30, 30, 220]) : undefined));
    const s = verticalSampled(64);
    const raw = traceColors(s, rgba, 100, 60, { offset: 4, minL: null, window: 1 });
    const smooth = traceColors(s, rgba, 100, 60, { offset: 4, minL: null, window: 5 });
    // 第 16 点在 y = 30 附近
    const jumpRaw = Math.abs(raw.rgb[3 * 15] - raw.rgb[3 * 17]);
    const jumpSmooth = Math.abs(smooth.rgb[3 * 15] - smooth.rgb[3 * 16]) + Math.abs(smooth.rgb[3 * 16] - smooth.rgb[3 * 17]);
    expect(jumpRaw).toBeGreaterThan(100);
    expect(Math.max(Math.abs(smooth.rgb[3 * 15] - smooth.rgb[3 * 16]), Math.abs(smooth.rgb[3 * 16] - smooth.rgb[3 * 17]))).toBeLessThan(jumpRaw);
    expect(jumpSmooth).toBeGreaterThan(0);
  });

  it('关闭时与原来一致：不传 lineRadius 的流水线结果不变', () => {
    const tour = greedyTour([{ pts: [0, 0, 10, 0, 10, 10, 0, 10], closed: true }]);
    const s = resample(tour, 64, null);
    expect(Array.from(s.px.slice(0, 4))).toEqual(Array.from(s.x.slice(0, 4)).map((v) => v / s.scale + s.cx));
  });
});

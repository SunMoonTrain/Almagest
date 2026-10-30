import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { DEMO_CURVES } from '../src/core/curves';
import { greedyTour, treeTour } from '../src/core/tour';
import { resample } from '../src/core/resample';
import { computeSpectrum, countForEnergy, traceCurve, termsOf } from '../src/core/fourier';
import { complexLatex, phaseLatex, trigLatex, desmosText } from '../src/core/equation';
import { runPipeline } from '../src/core/pipeline';
import type { Chain } from '../src/core/chains';

const curve = (id: string) => DEMO_CURVES.find((c) => c.id === id)!.make();

function spectrumOf(chains: Chain[], N: number) {
  const tour = greedyTour(chains);
  const s = resample(tour, N, null);
  return { s, spec: computeSpectrum(s.x, s.y) };
}

function jumpRuns(jump: Uint8Array): number {
  let runs = 0;
  for (let i = 0; i < jump.length; i++) if (jump[i] && !jump[(i - 1 + jump.length) % jump.length]) runs++;
  return runs;
}

describe('数学核心', () => {
  it('正圆：只有 k = 1 一项显著非零', () => {
    const { spec } = spectrumOf(curve('circle'), 1024);
    expect(spec.k[0]).toBe(1);
    expect(spec.r[0]).toBeCloseTo(100, 1);
    expect(spec.r[1] / spec.r[0]).toBeLessThan(1e-3);
  });

  it('顺时针的圆：k = −1', () => {
    const c = curve('circle')[0];
    const pts: number[] = [];
    for (let i = c.pts.length - 2; i >= 0; i -= 2) pts.push(c.pts[i], c.pts[i + 1]);
    const { spec } = spectrumOf([{ pts, closed: true }], 1024);
    expect(spec.k[0]).toBe(-1);
  });

  it('正方形：非零系数只出现在 k ≡ 1 (mod 4)', () => {
    const { spec } = spectrumOf(curve('square'), 1024);
    for (let j = 0; j < spec.k.length; j++) {
      if ((((spec.k[j] - 1) % 4) + 4) % 4 !== 0) expect(spec.r[j]).toBeLessThan(1e-9);
    }
  });

  it('两个分开的圆：恰好两段跳线', () => {
    const tour = greedyTour(curve('two-circles'));
    const s = resample(tour, 2048, null);
    expect(jumpRuns(s.jump)).toBe(2);
  });

  it('树形往返：闭合、跳线重合', () => {
    const tour = treeTour(curve('two-circles'));
    const n = tour.pts.length;
    expect(tour.pts[0]).toBeCloseTo(tour.pts[n - 2]);
    expect(tour.pts[1]).toBeCloseTo(tour.pts[n - 1]);
  });

  it('M = N 时逆变换与采样点误差 < 1e-9', () => {
    const { s, spec } = spectrumOf(curve('heart'), 1024);
    const t = traceCurve(spec, spec.N);
    let err = 0;
    for (let n = 0; n < spec.N; n++) err = Math.max(err, Math.hypot(t.x[n] - s.x[n], t.y[n] - s.y[n]));
    expect(err).toBeLessThan(1e-9);
  });

  it('帕塞瓦尔定理：Σ r² = mean |z|²', () => {
    const { s, spec } = spectrumOf(curve('star'), 2048);
    let mean = 0;
    for (let n = 0; n < spec.N; n++) mean += s.x[n] ** 2 + s.y[n] ** 2;
    mean /= spec.N;
    const sum = spec.total + spec.c0re ** 2 + spec.c0im ** 2;
    expect(Math.abs(sum - mean) / mean).toBeLessThan(1e-12);
  });

  it('能量档位单调', () => {
    const { spec } = spectrumOf(curve('star'), 2048);
    const ms = [0.9, 0.99, 0.999, 0.9999].map((f) => countForEnergy(spec, f));
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]);
  });
});

describe('方程生成器', () => {
  const c0 = { re: 1.2, im: -0.4 };
  const terms = [
    { k: 1, re: 0, im: 0, r: 58.3, phi: 0.52 },
    { k: -1, re: 0, im: 0, r: 21.7, phi: 0 },
    { k: 3, re: 0, im: 0, r: 9.4, phi: -1.07 },
    { k: 1, re: 0, im: 0, r: 4, phi: 0.001 },
  ];
  const o = { rDigits: 1, phiDigits: 2 };

  it('格式化规则', () => {
    const s = complexLatex(c0, terms, o);
    expect(s).toContain('(1.2 - 0.4i)');
    expect(s).toContain('58.3\\,e^{i(t + 0.52)}');
    expect(s).toContain('21.7\\,e^{-it}');
    expect(s).toContain('9.4\\,e^{i(3t - 1.07)}');
    expect(s).toContain('4.0\\,e^{it}');
    expect(s).not.toMatch(/\+ -/);
  });

  it('KaTeX 能渲染所有形式', () => {
    const { spec } = spectrumOf(curve('star'), 1024);
    const ts = termsOf(spec, 40);
    const c = { re: spec.c0re, im: spec.c0im };
    for (const f of [complexLatex, phaseLatex, trigLatex]) {
      expect(() => katex.renderToString(f(c, ts, o), { throwOnError: true, displayMode: true })).not.toThrow();
      expect(() => katex.renderToString(f(c, ts, { ...o, limit: 8 }), { throwOnError: true })).not.toThrow();
    }
    expect(desmosText(c, ts, o)).toMatch(/^\(.*cos\(.*, .*sin\(.*\)$/);
  });

  it('三角级数与复数形式是同一条曲线', () => {
    const { spec } = spectrumOf(curve('heart'), 512);
    const ts = termsOf(spec, 30);
    // 用高精度生成后数值求值对比
    const tex = trigLatex({ re: spec.c0re, im: spec.c0im }, ts, { rDigits: 10, phiDigits: 10, perLine: 1000 });
    const xLine = tex.split('\n')[1];
    const evalLine = (line: string, t: number) => {
      const body = line.replace(/^.*&= /, '').replace(/ \\\\$/, '');
      const js = body
        .replace(/\\(cos|sin) (\d*)t/g, (_, fn, m) => `*Math.${fn}(${m || 1}*${t})`)
        .replace(/ /g, '');
      return Function(`return ${js}`)() as number;
    };
    const tr = traceCurve(spec, 30);
    for (const n of [0, 37, 200]) {
      const t = (2 * Math.PI * n) / spec.N;
      expect(evalLine(xLine, t)).toBeCloseTo(tr.x[n], 6);
    }
  });
});

function discImage(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (w / 3) ** 2;
      const p = 4 * (y * w + x);
      rgba[p] = rgba[p + 1] = rgba[p + 2] = inside ? 0 : 255;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

describe('图片流水线', () => {
  for (const mode of ['silhouette', 'edge'] as const) {
    it(`实心圆盘（${mode}）→ 主导项 |k| = 1`, () => {
      const res = runPipeline({ kind: 'image', w: 200, h: 200, rgba: discImage(200, 200), mode }, { detail: 'medium', tree: false, jumpWeight: 1 });
      expect(Math.abs(res.spec.k[0])).toBe(1);
      expect(res.spec.cum[0] / res.spec.total).toBeGreaterThan(0.99);
      expect(res.stats.chains).toBeGreaterThanOrEqual(1);
    });
  }
});

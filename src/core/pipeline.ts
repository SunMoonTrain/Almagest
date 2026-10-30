// 上半段流水线：边缘提取 → 串链 → 一笔画 → 重采样 → 傅里叶。结果按「图片哈希 + 细致度」缓存。
import { canny, silhouetteMask, toGray } from './edges';
import { cleanChains, finalizeChains, marchingSquares, traceChains, type Chain } from './chains';
import { greedyTour, treeTour } from './tour';
import { resample, type Sampled } from './resample';
import { computeSpectrum, type Spectrum } from './fourier';
import { DETAIL, type DetailKey } from './presets';

export type PipelineInput =
  | { kind: 'image'; w: number; h: number; rgba: Uint8ClampedArray; mode: 'edge' | 'silhouette' }
  | { kind: 'curve'; chains: Chain[] };

export interface PipelineOptions {
  detail: DetailKey;
  tree: boolean;
  jumpWeight: number;
}

export interface PipelineStats {
  chains: number;
  jumps: number;
  jumpRatio: number;
  timings: [string, number][];
}

export interface PipelineResult {
  sampled: Sampled;
  spec: Spectrum;
  stats: PipelineStats;
}

export function runPipeline(
  input: PipelineInput,
  opts: PipelineOptions,
  onStage: (stage: string) => void = () => {},
): PipelineResult {
  const p = DETAIL[opts.detail];
  const timings: [string, number][] = [];
  let t0 = performance.now();
  const lap = (name: string) => {
    const t = performance.now();
    timings.push([name, t - t0]);
    t0 = t;
  };

  let chains: Chain[];
  let flipH: number | null = null;
  if (input.kind === 'image') {
    const { w, h } = input;
    const diag = Math.hypot(w, h);
    onStage('边缘提取');
    const gray = toGray(input.rgba, w, h);
    if (input.mode === 'silhouette') {
      const loops = marchingSquares(silhouetteMask(gray, p.sigma), w, h);
      lap('剪影');
      onStage('串链');
      chains = finalizeChains(loops, p.minLenFrac * diag, p.tol, p.maxChains);
    } else {
      const edge = canny(gray, p.sigma, p.highPct, p.lowRatio);
      lap('边缘');
      onStage('串链');
      chains = cleanChains(traceChains(edge, w, h), {
        minLen: p.minLenFrac * diag,
        tol: p.tol,
        maxChains: p.maxChains,
        spurLen: 3,
        joinDist: 2,
      });
    }
    lap('串链');
    flipH = h;
  } else {
    chains = input.chains;
  }
  if (chains.length === 0) throw new Error('没有找到可用的线条，换个细致度或改用剪影模式试试');

  onStage('一笔画');
  const tour = opts.tree ? treeTour(chains) : greedyTour(chains);
  lap('一笔画');

  let jumps = 0, jumpLen = 0, total = 0;
  const P = tour.pts.length / 2;
  for (let i = 0; i < P; i++) {
    const j = (i + 1) % P;
    const L = Math.hypot(tour.pts[2 * j] - tour.pts[2 * i], tour.pts[2 * j + 1] - tour.pts[2 * i + 1]);
    total += L;
    if (tour.jump[i] && L > 0.5) {
      jumps++;
      jumpLen += L;
    }
  }

  onStage('重采样');
  const sampled = resample(tour, p.N, flipH, opts.jumpWeight);
  lap('重采样');
  onStage('傅里叶变换');
  const spec = computeSpectrum(sampled.x, sampled.y);
  lap('傅里叶');

  return { sampled, spec, stats: { chains: chains.length, jumps, jumpRatio: total ? jumpLen / total : 0, timings } };
}

export function transferables(r: PipelineResult): Transferable[] {
  const s = r.sampled, c = r.spec;
  return [s.x.buffer, s.y.buffer, s.jump.buffer, c.k.buffer, c.re.buffer, c.im.buffer, c.r.buffer, c.phi.buffer, c.cum.buffer];
}

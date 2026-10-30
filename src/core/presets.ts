// 两组档位。数值是技术方案里的起始值，需要拿真实图片继续调。

export type DetailKey = 'coarse' | 'medium' | 'fine';

export interface DetailPreset {
  label: string;
  /** 高斯模糊半径 σ（像素） */
  sigma: number;
  /** 高阈值：梯度强度百分位 */
  highPct: number;
  lowRatio: number;
  /** 最短链长，占对角线比例 */
  minLenFrac: number;
  /** 折线简化容差（像素） */
  tol: number;
  maxChains: number;
  N: number;
  /** 单线模式的闭运算半径 r（像素，按缩放后的图算） */
  lineRadius: number;
}

export const DETAIL: Record<DetailKey, DetailPreset> = {
  coarse: { label: '粗', sigma: 3.0, highPct: 0.95, lowRatio: 0.4, minLenFrac: 0.05, tol: 2.0, maxChains: 30, N: 2048, lineRadius: 3 },
  medium: { label: '中', sigma: 1.5, highPct: 0.9, lowRatio: 0.4, minLenFrac: 0.01, tol: 1.0, maxChains: 150, N: 4096, lineRadius: 2 },
  fine: { label: '细', sigma: 0.8, highPct: 0.8, lowRatio: 0.4, minLenFrac: 0.002, tol: 0.5, maxChains: 600, N: 8192, lineRadius: 1.5 },
};

export const DETAIL_KEYS: DetailKey[] = ['coarse', 'medium', 'fine'];

export interface CirclePreset {
  label: string;
  /** 保留 r_k² 总和的比例（不含 c_0） */
  energy: number;
  count: number;
}

export const CIRCLE_PRESETS: CirclePreset[] = [
  { label: '草图', energy: 0.9, count: 10 },
  { label: '轮廓', energy: 0.99, count: 50 },
  { label: '精细', energy: 0.999, count: 200 },
  { label: '极致', energy: 0.9999, count: 1000 },
];

/** 预处理：图片缩放到长边约 800 像素 */
export const TARGET_LONG_SIDE = 800;
/** 跳线加速开启时，跳线长度的权重 */
export const JUMP_FAST_WEIGHT = 0.3;

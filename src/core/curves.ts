// 开发台阶 1：手写参数曲线当输入（数学坐标，y 朝上）。
import type { Chain } from './chains';

function param(f: (t: number) => [number, number], n = 720): Chain {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = f((2 * Math.PI * i) / n);
    pts.push(x, y);
  }
  return { pts, closed: true };
}

function polygon(vs: [number, number][]): Chain {
  return { pts: vs.flat(), closed: true };
}

export interface DemoCurve {
  id: string;
  label: string;
  make: () => Chain[];
}

export const DEMO_CURVES: DemoCurve[] = [
  { id: 'circle', label: '圆', make: () => [param((t) => [100 * Math.cos(t), 100 * Math.sin(t)])] },
  { id: 'square', label: '正方形', make: () => [polygon([[-1, -1], [1, -1], [1, 1], [-1, 1]])] },
  {
    id: 'heart',
    label: '爱心',
    make: () => [
      param((t) => [
        16 * Math.sin(t) ** 3,
        13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      ]),
    ],
  },
  {
    id: 'cardioid',
    label: '心形线',
    make: () => [param((t) => [(1 - Math.cos(t)) * Math.cos(t), (1 - Math.cos(t)) * Math.sin(t)])],
  },
  {
    id: 'star',
    label: '五角星',
    make: () => {
      const vs: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 1 : 0.4;
        vs.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return [polygon(vs)];
    },
  },
  {
    id: 'two-circles',
    label: '两个圆',
    make: () => [
      param((t) => [-60 + 40 * Math.cos(t), 40 * Math.sin(t)], 360),
      param((t) => [60 + 40 * Math.cos(t), 40 * Math.sin(t)], 360),
    ],
  },
];

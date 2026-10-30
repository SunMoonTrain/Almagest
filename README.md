# Almagest

任意图片 → 一笔画闭合曲线 → 圆套圆（本轮均轮）绘制动画 → 可复制的参数方程。设计见 [技术方案](图片转托勒密圆绘制工具%20·%20技术方案.md)。

管线逐步讲解（带插图）见 [docs/pipeline.md](docs/pipeline.md)。

```bash
npm install
npm run dev     # 开发服务器
npm test        # 技术方案里的测试用例
npm run build   # 产出 dist/，纯静态，可直接托管
```

## 代码结构

流水线每一步都是 `src/core/` 下的纯函数，上半段（随「边缘细致度」重跑）在 Web Worker 里执行并按「图片哈希 + 档位」缓存，下半段（随「圆的数量」变化）在主线程即时计算。

| 文件 | 步骤 |
| --- | --- |
| `edges.ts` | 1. 预处理、Canny（百分位自适应阈值 + 细化）、剪影模式的大津法二值化 |
| `chains.ts` | 2. 串链、剪毛刺、接断线、最短链长过滤、道格拉斯-普克简化；剪影模式的行进方块法 |
| `tour.ts` | 3. 一笔画：贪心 + 2-opt，或最小生成树往返；输出跳线标记 |
| `resample.ts` | 4. y 翻转、归一化（最长半边 = 100）、按弧长重采样 |
| `fft.ts` / `fourier.ts` | 5. 系数（按半径降序）、能量截断、逆变换预计算笔迹 |
| `src/main.ts` | 6. 动画（转子 + 每圈校准）、交互、导出 |
| `src/glCircles.ts` | 圆的 WebGL2 实例化渲染（不可用时退回 Canvas 2D） |
| `src/gif.ts` | 导出 GIF（全局调色板，离屏逐帧渲染） |
| `equation.ts` | 7. 复数 / 相位 / 三角级数三种 LaTeX、Desmos 文本、系数 JSON |
| `presets.ts` | 两组档位的数值 |
| `scripts/doc-figures.ts` | 生成 `docs/img/` 下的插图：`npx vite-node scripts/doc-figures.ts` |

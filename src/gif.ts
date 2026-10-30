// 导出动图：离屏逐帧渲染一整圈，整段动画共用一张全局调色板，避免逐帧闪色。
import { GIFEncoder, applyPalette, quantize } from 'gifenc';

export interface GifOptions {
  size: number;
  /** 画一圈的帧数 */
  frames: number;
  /** 画完后定格的帧数 */
  holdFrames: number;
  delayMs: number;
}

/**
 * paint(g, size, progress) 把 progress ∈ [0, 1] 时刻的画面画到 g 上；
 * progress = 1 表示整条曲线画完。onProgress 返回 false 时中止。
 */
export async function encodeGif(
  o: GifOptions,
  paint: (g: CanvasRenderingContext2D, size: number, progress: number) => void,
  onProgress: (done: number, total: number) => boolean,
): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = c.height = o.size;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const grab = (p: number) => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    paint(g, o.size, p);
    return g.getImageData(0, 0, o.size, o.size).data;
  };

  // 调色板取自「画到一半」和「画完」两帧：前者圆和箭头最多，后者笔迹最全
  const a = grab(0.5), b = grab(1);
  const sample = new Uint8ClampedArray(a.length + b.length);
  sample.set(a);
  sample.set(b, a.length);
  const palette = quantize(sample, 256);

  const gif = GIFEncoder();
  const total = o.frames + o.holdFrames;
  for (let f = 0; f < total; f++) {
    const p = f < o.frames ? f / o.frames : 1;
    const index = applyPalette(grab(p), palette);
    gif.writeFrame(index, o.size, o.size, f === 0 ? { palette, delay: o.delayMs, repeat: 0 } : { delay: o.delayMs });
    if (f % 4 === 3) {
      if (!onProgress(f + 1, total)) return null;
      await new Promise((r) => setTimeout(r));
    }
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

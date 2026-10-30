// 导出动图：离屏逐帧渲染，整段动画共用一张全局调色板，避免逐帧闪色。
import { GIFEncoder, applyPalette, quantize } from 'gifenc';

export interface GifOptions {
  size: number;
  frames: number;
  delayMs: number;
  /** 用来生成调色板的帧（应选圆、箭头、笔迹都多的帧） */
  paletteFrames: number[];
}

/** paint(g, size, f) 把第 f 帧画到 g 上。onProgress 返回 false 时中止。 */
export async function encodeGif(
  o: GifOptions,
  paint: (g: CanvasRenderingContext2D, size: number, f: number) => void,
  onProgress: (done: number, total: number) => boolean,
): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = c.height = o.size;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const grab = (f: number) => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    paint(g, o.size, f);
    return g.getImageData(0, 0, o.size, o.size).data;
  };

  const shots = o.paletteFrames.map(grab);
  const sample = new Uint8ClampedArray(shots.reduce((s, a) => s + a.length, 0));
  let off = 0;
  for (const a of shots) {
    sample.set(a, off);
    off += a.length;
  }
  const palette = quantize(sample, 256);

  const gif = GIFEncoder();
  for (let f = 0; f < o.frames; f++) {
    const index = applyPalette(grab(f), palette);
    gif.writeFrame(index, o.size, o.size, f === 0 ? { palette, delay: o.delayMs, repeat: 0 } : { delay: o.delayMs });
    if (f % 4 === 3) {
      if (!onProgress(f + 1, o.frames)) return null;
      await new Promise((r) => setTimeout(r));
    }
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

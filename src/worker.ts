// 上半段放进后台线程，算的时候界面不卡。
import { runPipeline, transferables, type PipelineInput, type PipelineOptions } from './core/pipeline';

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<{ id: number; input: PipelineInput; opts: PipelineOptions }>) => {
  const { id, input, opts } = e.data;
  try {
    const result = runPipeline(input, opts, (stage) => ctx.postMessage({ id, type: 'progress', stage }));
    ctx.postMessage({ id, type: 'done', result }, transferables(result));
  } catch (err) {
    ctx.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

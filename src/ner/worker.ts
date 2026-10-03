import { env, pipeline } from '@huggingface/transformers';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { nerSpans, type NerPipe } from './run';
import type { Span } from '../core/types';

export type ToWorker = { type: 'init'; modelBase: string; models: string[] } | { type: 'run'; id: number; text: string } | { type: 'cancel'; id: number };
export type FromWorker =
  | { type: 'ready' }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'partial'; id: number; spans: Awaited<ReturnType<typeof nerSpans>>; done: number; total: number }
  | { type: 'result'; id: number; spans: Awaited<ReturnType<typeof nerSpans>> }
  | { type: 'error'; id?: number; message: string };

const post = (m: FromWorker) => postMessage(m);
let pipes: NerPipe[] = [];
const cancelled = new Set<number>(); // запуски, результат которых уже не нужен (текст изменили)
const cache = new Map<string, Span[]>(); // части текста, которые уже считали (см. nerSpans); воркер пересоздаётся при смене моделей

async function init(modelBase: string, models: string[]) {
  env.allowRemoteModels = false; // nothing may leave the machine
  env.allowLocalModels = true;
  env.localModelPath = modelBase; // a path, not a URL: transformers.js only probes local files for paths
  env.useWasmCache = false; // the default would wrap the wasm loader into a blob: URL
  // models sit in the Cache API under their path and are never revalidated: the cache name carries the models' hash from the build,
  // so a new model is downloaded again and the old copy deleted. In dev models change in place, so no cache at all
  env.useBrowserCache = __MODELS__ !== 'dev';
  env.cacheKey = `obliviate-models-${__MODELS__}`;
  try {
    for (const k of await caches.keys()) if (k !== env.cacheKey && /^(transformers-cache|obliviate-models-)/.test(k)) await caches.delete(k);
  } catch { /* no Cache API: nothing to clean */ }
  const wasm = env.backends.onnx.wasm!;
  wasm.wasmPaths = { mjs: new URL(mjsUrl, import.meta.url).href, wasm: new URL(wasmUrl, import.meta.url).href };
  // threads need cross-origin isolation: on GitHub Pages public/coi-sw.js provides it, otherwise one thread
  wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

  const files = new Map<string, [number, number]>();
  const progress_callback = (p: { status: string; name?: string; file?: string; loaded?: number; total?: number }) => {
    // the weights are nearly all of the download; until every model's weights have started, guess the rest from the ones seen
    if (p.status !== 'progress' || !p.file?.endsWith('.onnx')) return;
    files.set(p.name ?? '', [p.loaded ?? 0, p.total ?? 0]);
    let loaded = 0, total = 0;
    for (const [l, t] of files.values()) { loaded += l; total += t; }
    post({ type: 'progress', loaded, total: (total / files.size) * models.length });
  };
  pipes = (await Promise.all(
    models.map((m) => pipeline('token-classification', m, { dtype: 'q8', device: 'wasm', progress_callback })),
  )) as unknown as NerPipe[];
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      await init(m.modelBase, m.models);
      post({ type: 'ready' });
    } else if (m.type === 'cancel') {
      cancelled.add(m.id);
    } else if (pipes.length) {
      const id = m.id;
      if (cache.size > 2000) cache.clear();
      const spans = await nerSpans(pipes, m.text, (part, done, total) => post({ type: 'partial', id, spans: part, done, total }), () => cancelled.has(id), cache);
      if (!cancelled.delete(id)) post({ type: 'result', id, spans });
    }
  } catch (err) {
    post({ type: 'error', id: m.type === 'run' ? m.id : undefined, message: String((err as Error)?.message ?? err) });
  }
};

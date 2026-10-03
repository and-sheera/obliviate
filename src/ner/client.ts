import type { Span } from '../core/types';
import type { FromWorker, ToWorker } from './worker';

/** Ход анализа: найденное к этому моменту, сколько частей текста готово из скольких */
export type Progress = (spans: Span[], done: number, total: number) => void;
export type NerState = 'off' | 'loading' | 'ready' | 'error';

/** Lazy wrapper around the NER worker: nothing is downloaded until `load()`. */
export class Ner {
  state: NerState = 'off';
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, { ok: (s: Span[]) => void; fail: (e: Error) => void; part?: Progress }>();
  private running?: number; // запуск, который ещё идёт
  private boot?: Promise<void>;

  /** folders in public/models; several vote (see nerSpans) */
  models = ['ner'];

  constructor(private onChange: (state: NerState, info?: string) => void) {}

  private set(state: NerState, info?: string) {
    this.state = state;
    this.onChange(state, info);
  }

  load(): Promise<void> {
    if (this.boot) return this.boot;
    this.set('loading', '0%');
    this.boot = new Promise<void>((ok, fail) => {
      const w = (this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'ready') { this.set('ready'); ok(); }
        else if (m.type === 'progress') this.set('loading', m.total ? `${Math.round((m.loaded / m.total) * 100)}%` : '');
        else if (m.type === 'partial') this.pending.get(m.id)?.part?.(this.acc(m.id, m.spans), m.done, m.total);
        else if (m.type === 'result') { this.pending.get(m.id)?.ok(m.spans); this.pending.delete(m.id); }
        else {
          const err = new Error(m.message);
          if (m.id === undefined) { this.set('error', m.message); fail(err); }
          else { this.pending.get(m.id)?.fail(err); this.pending.delete(m.id); }
        }
      };
      w.onerror = (e) => { this.set('error', e.message); fail(new Error(e.message)); };
      w.postMessage({ type: 'init', modelBase: new URL('models/', document.baseURI).pathname, models: this.models } satisfies ToWorker);
    });
    return this.boot;
  }

  unload() {
    this.worker?.terminate();
    this.worker = this.boot = undefined;
    for (const p of this.pending.values()) p.fail(new Error('stopped'));
    this.pending.clear();
    this.partials.clear();
    this.running = undefined;
    this.set('off');
  }

  private partials = new Map<number, Span[]>();
  private acc(id: number, more: Span[]) {
    const all = [...(this.partials.get(id) ?? []), ...more];
    this.partials.set(id, all);
    return all;
  }

  /** Новый запуск отменяет предыдущий: пока человек печатает, считать старый текст незачем */
  detect(text: string, part?: Progress): Promise<Span[]> {
    if (this.state !== 'ready' || !this.worker) return Promise.resolve([]);
    if (this.running !== undefined) {
      this.worker.postMessage({ type: 'cancel', id: this.running } satisfies ToWorker);
      this.pending.get(this.running)?.fail(new Error('stopped'));
      this.pending.delete(this.running);
      this.partials.delete(this.running);
    }
    const id = (this.running = this.nextId++);
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok: (s) => { this.partials.delete(id); if (this.running === id) this.running = undefined; ok(s); }, fail, part });
      this.worker!.postMessage({ type: 'run', id, text } satisfies ToWorker);
    });
  }
}

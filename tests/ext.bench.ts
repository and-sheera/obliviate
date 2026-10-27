// npm run test:ext — the same app pipeline on two independent Russian PII benchmarks (node scripts/fetch-bench.mjs downloads them).
// SYSTEMS=rules,guess,ner,ner+ner-c3-v2+ner-conv: which detectors to compare (`rules`, `guess` — no model, or folders of public/models joined by +). Prints a table, asserts nothing.
//   recall  — share of gold NAME / ID / CONTACT spans that got ≥ 80 % of their letters and digits hidden
//   stray   — detected fragments that touch no gold span at all (a place or an address counts as gold)
//   clean   — share of texts without personal data where nothing was found
import { describe, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { env, pipeline } from '@huggingface/transformers';
import { collect } from '../src/core/mask';
import { guess } from '../src/core/guess';
import { nerSpans, type NerPipe } from '../src/ner/run';
import type { Span } from '../src/core/types';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;

interface Case { text: string; spans: Array<{ start: number; end: number; type: 'NAME' | 'ID' | 'CONTACT' | 'PLACE' }> }
const load = (f: string): Case[] => {
  const p = new URL(`ext/${f}.json`, import.meta.url).pathname;
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};
const sets = { redmadrobot: load('redmadrobot'), hivetrace: load('hivetrace') };

const SYSTEMS = (process.env.SYSTEMS ?? 'rules').split(',');
const KINDS = ['NAME', 'ID', 'CONTACT'] as const;

/** `detect(text)` for a system: the rules alone, or the rules and the models listed after the first name */
async function detector(system: string): Promise<(text: string) => Promise<Span[]>> {
  if (system === 'rules') return async (t) => collect(t, {});
  if (system === 'guess') return async (t) => collect(t, { extra: guess(t) });
  const models = system.split('+');
  const pipes = await Promise.all(models.map(async (m) => (await pipeline('token-classification', m, { dtype: 'q8' })) as unknown as NerPipe));
  return async (t) => collect(t, { extra: await nerSpans(pipes, t) });
}

const covered = (c: Case['spans'][number], text: string, spans: Span[]) => {
  let n = 0, all = 0;
  for (let p = c.start; p < c.end; p++) {
    if (!/[\p{L}\p{N}]/u.test(text[p])) continue;
    all++;
    if (spans.some((s) => s.start <= p && p < s.end)) n++;
  }
  return all === 0 || n / all >= 0.8;
};
const pct = (a: number, b: number) => (b ? `${String(Math.round((100 * a) / b)).padStart(3)}% ${`(${a}/${b})`.padEnd(11)}` : '—'.padEnd(16));

describe.skipIf(!sets.redmadrobot.length)('external PII benchmarks', () => {
  for (const system of SYSTEMS) {
    it(system, async () => {
      const detect = await detector(system);
      const rows: string[] = [];
      for (const [name, cases] of Object.entries(sets)) {
        const hit = { NAME: 0, ID: 0, CONTACT: 0 }, tot = { NAME: 0, ID: 0, CONTACT: 0 };
        let stray = 0, found = 0, clean = 0, none = 0;
        const t0 = performance.now();
        for (const c of cases) {
          const spans = await detect(c.text);
          for (const g of c.spans) if (g.type !== 'PLACE') { tot[g.type]++; if (covered(g, c.text, spans)) hit[g.type]++; }
          for (const s of spans) { found++; if (!c.spans.some((g) => g.start < s.end && s.start < g.end)) stray++; }
          if (!c.spans.length) { none++; if (!spans.length) clean++; }
        }
        rows.push(`${system.padEnd(24)} ${name.padEnd(12)} ` + KINDS.map((k) => `${k} ${pct(hit[k], tot[k])}`).join(' ') + `stray ${pct(stray, found)} clean ${pct(clean, none)} ${((performance.now() - t0) / 1000).toFixed(0)}s`);
      }
      console.log('\n' + rows.join('\n'));
    }, 3_600_000);
  }
});

// npm run test:ner — runs the REAL model (public/models/ner) in Node over tests/texts.ts.
// NER_MODEL=ner-x picks another one, NER_MODEL=ner,ner-c3-v2,ner-conv makes them vote like the app's accurate mode.
// Measures what the user actually gets (regex + heuristics + model):
//   recall     — share of expected people / companies that got hidden
//   precision  — share of hidden fragments that were supposed to be hidden
//   clean      — share of ordinary texts where nothing at all got hidden
import { describe, it, expect } from 'vitest';
import { env, pipeline } from '@huggingface/transformers';
import { positives, negatives } from './texts';
import { nerSpans, type NerPipe } from '../src/ner/run';
import { collect } from '../src/core/mask';
import type { Span } from '../src/core/types';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;

const MIN = { recallPerson: 0.9, recallOrg: 0.85, precision: 0.9, clean: 0.95 };

const at = (text: string, needle: string): number[] => {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  if (!out.length) throw new Error(`bad case: "${needle}" is not in "${text}"`);
  return out;
};

/** every occurrence has ≥ 80 % of its letters hidden */
const hidden = (text: string, needle: string, spans: Span[]) =>
  at(text, needle).every((i) => {
    let n = 0;
    for (let p = i; p < i + needle.length; p++) {
      if (/\s/.test(text[p]) || spans.some((s) => s.start <= p && p < s.end)) n++;
    }
    return n / needle.length >= 0.8;
  });

const overlaps = (s: Span, text: string, needles: string[]) =>
  needles.some((n) => at(text, n).some((i) => i < s.end && s.start < i + n.length));

const pct = (a: number, b: number) => (b ? `${a}/${b} = ${((a / b) * 100).toFixed(0)}%` : '—');
const one = (t: string) => t.replace(/\n/g, ' ⏎ ');

describe('NER quality (real model)', () => {
  it('people and companies are hidden, ordinary text is not', async () => {
    const models = (process.env.NER_MODEL ?? 'ner').split(',');
    const pipes = await Promise.all(models.map(async (m) => (await pipeline('token-classification', m, { dtype: 'q8' })) as unknown as NerPipe));
    const run = async (text: string) => collect(text, { extra: await nerSpans(pipes, text) }).filter((s) => !(s.source === 'ner' && s.type === 'LOC')); // places are a noisy extra, not measured

    const found = { PERSON: 0, ORG: 0 }, total = { PERSON: 0, ORG: 0 };
    const byKind = new Map<string, [number, number]>();
    let right = 0, all = 0;
    const misses: string[] = [], wrong: string[] = [], info: string[] = [];

    for (const c of positives) {
      const spans = await run(c.text);
      const expected: Array<['PERSON' | 'ORG', string]> = [
        ...(c.per ?? []).map((p) => ['PERSON', p] as ['PERSON', string]),
        ...(c.org ?? []).map((o) => ['ORG', o] as ['ORG', string]),
      ];
      for (const [type, needle] of expected) {
        const ok = hidden(c.text, needle, spans);
        if (c.info) { if (!ok) info.push(`miss ${type} "${needle}"  ←  ${one(c.text)}`); continue; }
        total[type]++;
        const k = byKind.get(c.kind) ?? [0, 0];
        k[1]++;
        if (ok) { found[type]++; k[0]++; }
        else misses.push(`${type.padEnd(6)} "${needle}"  ←  ${one(c.text)}\n         got: ${spans.map((s) => `${s.type}:${s.text}`).join(' | ') || '∅'}`);
        byKind.set(c.kind, k);
      }
      if (c.info) continue;
      const allowed = [...expected.map(([, n]) => n), ...(c.hide ?? []), ...(c.maybe ?? [])];
      for (const s of spans) {
        all++;
        if (overlaps(s, c.text, allowed) && !overlaps(s, c.text, c.keep ?? [])) right++;
        else wrong.push(`${s.type.padEnd(8)} "${s.text}"  (${s.source})  in  ${one(c.text)}`);
      }
    }

    let clean = 0, counted = 0;
    const dirty: string[] = [];
    for (const n of negatives) {
      const spans = await run(n.text);
      if (!n.info) counted++;
      if (!spans.length) { if (!n.info) clean++; continue; }
      const line = `${n.kind.padEnd(16)} ${spans.map((s) => `${s.type}:"${s.text}" (${s.source})`).join(', ')}  in  ${one(n.text)}`;
      (n.info ? info : dirty).push(line);
    }

    const rP = found.PERSON / total.PERSON, rO = found.ORG / total.ORG, prec = right / all, cl = clean / counted;
    console.log(
      [
        '',
        `recall PERSON  ${pct(found.PERSON, total.PERSON)}   (min ${MIN.recallPerson * 100}%)`,
        `recall ORG     ${pct(found.ORG, total.ORG)}   (min ${MIN.recallOrg * 100}%)`,
        `precision      ${pct(right, all)}   (min ${MIN.precision * 100}%)`,
        `clean texts    ${pct(clean, counted)}   (min ${MIN.clean * 100}%)`,
        '',
        'recall by kind: ' + [...byKind].map(([k, [a, b]]) => `${k} ${pct(a, b)}`).join(', '),
        '',
        `MISSED (${misses.length}):`, ...misses,
        '',
        `HIDDEN BY MISTAKE in texts with names (${wrong.length}):`, ...wrong,
        '',
        `HIDDEN IN ORDINARY TEXTS (${dirty.length}):`, ...dirty,
        '',
        `INFO — not counted (${info.length}):`, ...info,
        '',
      ].join('\n'),
    );
    expect.soft(rP, 'recall PERSON').toBeGreaterThanOrEqual(MIN.recallPerson);
    expect.soft(rO, 'recall ORG').toBeGreaterThanOrEqual(MIN.recallOrg);
    expect.soft(prec, 'precision').toBeGreaterThanOrEqual(MIN.precision);
    expect.soft(cl, 'clean ordinary texts').toBeGreaterThanOrEqual(MIN.clean);
  }, 600_000);
});

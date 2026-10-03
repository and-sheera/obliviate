// npm run test:big — tests/big.ts through what the user gets: rules only, then «Быстро» and «Точно» with the real models.
// BIG_MODELS=… (see MODES) to compare other models.
// Report per text: who/what was missed, what was hidden by mistake, which case forms ended up as separate rows.
// Fails only on what does not depend on the model: secrets left in place, ordinary texts touched by the rules.
import { describe, it, expect } from 'vitest';
import { env, pipeline } from '@huggingface/transformers';
import { bigCases, bigNegatives, type BigCase, type Entity } from './big';
import { nerSpans, type NerPipe } from '../src/ner/run';
import { collect } from '../src/core/mask';
import { entityKey } from '../src/core/replace';
import type { Span } from '../src/core/types';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('../public/models/', import.meta.url).pathname;

// BIG_MODELS="ner-c3-v2|ner,ner-c3-v2,ner-conv" compares other models: modes split by |, models within a mode by ,
const MODES: Array<[string, string[]]> = process.env.BIG_MODELS
  ? process.env.BIG_MODELS.split('|').map((m) => [m, m.split(',')])
  : [['без модели', []], ['Быстро', ['ner']], ['Точно', ['ner', 'ner-c3-v2', 'ner-conv']]];

const at = (text: string, needle: string): number[] => {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  if (!out.length) throw new Error(`bad case: "${needle}" is not in the text`);
  return out;
};
/** every occurrence has ≥ 80 % of its letters hidden */
const hidden = (text: string, needle: string, spans: Span[]) =>
  at(text, needle).every((i) => {
    let n = 0;
    for (let p = i; p < i + needle.length; p++) if (/\s/.test(text[p]) || spans.some((s) => s.start <= p && p < s.end)) n++;
    return n / needle.length >= 0.8;
  });
const over = (s: Span, text: string, needle: string) => at(text, needle).some((i) => i < s.end && s.start < i + needle.length);
/** the rows (entity keys) the occurrences of `e` ended up in; a span that belongs to another entity («Широков Д.А.» for «Широков») is not its row */
const rows = (c: BigCase, e: Entity, spans: Span[]) => {
  const others = c.entities.filter((x) => x !== e).flatMap((x) => x.forms).filter((f) => !e.forms.some((g) => g.includes(f)));
  return new Set(spans.filter((s) => e.forms.some((f) => over(s, c.text, f)) && !others.some((f) => over(s, c.text, f))).map((s) => entityKey(s.type, s.value)));
};
/** ООО «X», ПАО X, компания X: the rules see it without the model */
const marked = (text: string, form: string) =>
  at(text, form).some((i) => /(?:ООО|ПАО|ЗАО|ОАО|АО|ГК|компани\p{L}*)[ \t]*«?$|«$/u.test(text.slice(Math.max(0, i - 24), i)));
const pct = (a: number, b: number) => (b ? `${a}/${b} ${String(Math.round((a / b) * 100)).padStart(3)}%` : '—');

type Tally = Record<string, [number, number]>;
const add = (t: Tally, k: string, ok: boolean) => { const v = (t[k] ??= [0, 0]); v[1]++; if (ok) v[0]++; };

function check(c: BigCase, spans: Span[], t: Tally, log: string[]) {
  const lines: string[] = [];
  for (const e of c.entities) {
    const missed = e.forms.filter((f) => !hidden(c.text, f, spans));
    const kind = c.english ? `${e.type} (англ.)` : e.type === 'ORG' ? (marked(c.text, e.forms[0]) ? 'ORG с ООО/«»' : 'ORG без признаков') : e.type;
    add(t, kind, !missed.length);
    if (missed.length) lines.push(`   ✗ ${e.type.padEnd(6)} ${missed.join(', ')}`);
    else if (e.forms.length > 1) {
      const r = rows(c, e, spans);
      add(t, 'падежи в одной строке', r.size === 1);
      if (r.size > 1) lines.push(`   ⇄ ${e.type.padEnd(6)} ${e.forms.join(' / ')} → ${r.size} строки: ${[...r].join(' | ')}`);
    }
  }
  for (const s of c.secrets ?? []) {
    const ok = hidden(c.text, s.value, spans);
    add(t, 'секреты и контакты', ok);
    if (!ok) lines.push(`   ✗ ${s.type.padEnd(6)} ${s.value}`);
  }
  const allowed = [...c.entities.flatMap((e) => e.forms), ...(c.secrets ?? []).map((s) => s.value), ...(c.maybe ?? [])];
  for (const s of spans) {
    const bad = !allowed.some((a) => over(s, c.text, a)) || (c.keep ?? []).some((k) => over(s, c.text, k));
    add(t, 'точность (найдено по делу)', !bad);
    if (bad) lines.push(`   ⚠ лишнее ${s.type}: "${s.text}" (${s.source})`);
  }
  log.push(`${lines.length ? '•' : '✓'} ${c.title}`, ...lines);
}

describe('long texts in many styles', () => {
  for (const [mode, models] of MODES) {
    it(mode, async () => {
      const pipes = await Promise.all(models.map(async (m) => (await pipeline('token-classification', m, { dtype: 'q8' })) as unknown as NerPipe));
      const run = async (text: string) => collect(text, { extra: pipes.length ? await nerSpans(pipes, text) : [] });
      const t: Tally = {}, log: string[] = [];
      const t0 = performance.now();
      for (const c of bigCases) {
        const spans = await run(c.text);
        check(c, spans, t, log);
        if (!pipes.length) for (const s of c.secrets ?? []) expect.soft(hidden(c.text, s.value, spans), `${c.title}: ${s.type} ${s.value}`).toBe(true);
      }
      for (const n of bigNegatives) {
        const spans = await run(n.text);
        add(t, 'обычные тексты без находок', !spans.length);
        log.push(`${spans.length ? '•' : '✓'} [обычный] ${n.title}`, ...spans.map((s) => `   ⚠ лишнее ${s.type}: "${s.text}" (${s.source})`));
        if (!pipes.length) expect.soft(spans.map((s) => s.text), `${n.title}: rules found something`).toEqual([]);
      }
      const order = ['PERSON', 'ORG с ООО/«»', 'ORG без признаков', 'LOC', 'секреты и контакты', 'падежи в одной строке', 'точность (найдено по делу)', 'обычные тексты без находок', 'PERSON (англ.)', 'ORG (англ.)', 'LOC (англ.)'];
      console.log([
        '', `══════ ${mode} ${models.length ? `(${models.join(' + ')})` : ''} · ${((performance.now() - t0) / 1000).toFixed(1)} с ══════`,
        ...order.filter((k) => t[k]).map((k) => `  ${k.padEnd(28)} ${pct(...t[k])}`),
        '', ...log, '',
      ].join('\n'));
    }, 600_000);
  }
});

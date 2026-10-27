// Regression on texts of different styles (tests/styles/*.txt, sources in the README there): wiki articles, a law, classics, news, a forum.
// 1. tests/styles.ts: what is certain (people found; headings, ordinary words and companies left alone) — fails at once, names the culprit.
// 2. a snapshot of everything found, tests/styles/found/<text>.txt — a change of the detector shows up as a diff; `-u` accepts it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { collect } from '../src/core/mask';
import { guess } from '../src/core/guess';
import { entityKey } from '../src/core/replace';
import { styles } from './styles';
import type { Span } from '../src/core/types';

const dir = new URL('styles/', import.meta.url).pathname;
const names = readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort();

/** at least 80 % of the letters of every occurrence are inside a found span (the same measure as tests/ner.bench.ts) */
function hidden(text: string, needle: string, spans: Span[]): boolean {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) at.push(i);
  if (!at.length) throw new Error(`bad case: "${needle}" is not in the text`);
  return at.every((i) => {
    let n = 0, all = 0;
    for (let p = i; p < i + needle.length; p++) if (/\p{L}/u.test(text[p])) { all++; if (spans.some((s) => s.start <= p && p < s.end)) n++; }
    return n / all >= 0.8;
  });
}
/** the occurrence of `needle` that stands alone as a word (not "Историю" for "История") is hidden */
const someHidden = (text: string, needle: string, spans: Span[]) =>
  [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, 'gu'))].some((m) => spans.some((s) => s.start <= m.index! && m.index! + needle.length <= s.end && s.end - s.start <= needle.length + 1));

/** one line per entity (all its case forms), in the order of the text: "PERSON ×3 Кутузова / Кутузов" */
function summary(text: string, spans: Span[]): string {
  const g = new Map<string, { type: string; n: number; forms: Set<string> }>();
  for (const s of spans) {
    const k = entityKey(s.type, s.value);
    const e = g.get(k) ?? { type: s.type, n: 0, forms: new Set<string>() };
    e.n++; e.forms.add(s.text.replace(/\s+/g, ' '));
    g.set(k, e);
  }
  return [...g.values()].map((e) => `${e.type.padEnd(7)} ×${String(e.n).padStart(2)}  ${[...e.forms].join(' / ')}`).join('\n') + '\n';
}

describe('texts of different styles', () => {
  it('has a case for every text', () => expect(Object.keys(styles).sort()).toEqual(names));
  for (const name of names) {
    describe(name, () => {
      const text = readFileSync(`${dir}${name}.txt`, 'utf8').normalize('NFC');
      const spans = collect(text, { extra: guess(text) });
      const c = styles[name] ?? {};
      it('hides the people that are certain', () => {
        expect((c.per ?? []).filter((n) => !hidden(text, n, spans))).toEqual([]);
      });
      it('leaves headings and ordinary words alone', () => {
        expect((c.keep ?? []).filter((n) => someHidden(text, n, spans))).toEqual([]);
        if (c.none) expect(spans.map((s) => s.text)).toEqual([]);
      });
      it('finds what it found before', async () => {
        await expect(summary(text, spans)).toMatchFileSnapshot(`styles/found/${name}.txt`);
      });
    });
  }
});

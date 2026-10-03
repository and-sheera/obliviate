// Realistic texts without the model: what the regex layer, the heuristics and the dictionary must find on their own.
// "Hidden" = gone once everything the app offers is replaced (see replaceAll).
import { describe, it, expect } from 'vitest';
import { positives, negatives, declensions, type TextCase } from './texts';
import { replaceAll } from './all';
import type { Term } from '../src/core/types';

const short = (t: string) => (t.length > 70 ? `${t.slice(0, 67)}…` : t).replace(/\n/g, ' ⏎ ');

/** every occurrence of `needle` in the original must be gone from the masked text */
function expectHidden(original: string, masked: string, needle: string) {
  expect(original, `bad case: "${needle}" is not in the text`).toContain(needle);
  expect(masked, `not hidden: "${needle}"`).not.toContain(needle);
}

function expectKept(original: string, masked: string, needle: string) {
  expect(original, `bad case: "${needle}" is not in the text`).toContain(needle);
  const want = original.split(needle).length - 1;
  expect(masked.split(needle).length - 1, `hidden by mistake: "${needle}"`).toBe(want);
}

describe('ordinary texts: nothing is offered (no model)', () => {
  for (const n of negatives) {
    it(`${n.kind}: ${short(n.text)}`, () => {
      expect(replaceAll(n.text)).toBe(n.text);
    });
  }
});

describe('texts with people and companies (no model)', () => {
  for (const c of positives) {
    it(`${c.kind}: ${short(c.text)}`, () => {
      const m = replaceAll(c.text);
      for (const h of c.hide ?? []) expectHidden(c.text, m, h);
      for (const k of c.keep ?? []) expectKept(c.text, m, k);
    });
  }
});

// The fallback when the model misses someone: the user adds the name to the dictionary.
// Every occurrence must go, and nothing from `keep` may go with it.
describe('texts with people and companies, names in the dictionary', () => {
  const dictFor = (c: TextCase): Term[] => [
    ...(c.per ?? []).map((term) => ({ term, type: 'PERSON' as const })),
    ...(c.org ?? []).map((term) => ({ term, type: 'ORG' as const })),
  ];
  for (const c of positives.filter((c) => c.per?.length || c.org?.length)) {
    it(`${c.kind}: ${short(c.text)}`, () => {
      const m = replaceAll(c.text, dictFor(c));
      for (const h of [...(c.per ?? []), ...(c.org ?? []), ...(c.hide ?? [])]) expectHidden(c.text, m, h);
      for (const k of c.keep ?? []) expectKept(c.text, m, k);
    });
  }
});

describe('dictionary: every case form is found as the same entity', () => {
  for (const d of declensions) {
    it(`${d.term}: ${d.forms.join(', ')}`, () => {
      const text = [d.term, ...d.forms].join('; ');
      const m = replaceAll(text, [{ term: d.term, type: d.type }]);
      const parts = m.split('; ');
      const leaked = parts.filter((p) => !/^\[[A-Z_]+_\d+\]$/.test(p));
      expect(leaked, 'forms left as is').toEqual([]);
      expect(new Set(parts).size, `one placeholder for all forms, got: ${m}`).toBe(1);
    });
    if (d.not?.length) {
      it(`${d.term}: not ${d.not.join(', ')}`, () => {
        const text = d.not!.join('; ');
        expect(replaceAll(text, [{ term: d.term, type: d.type }])).toBe(text);
      });
    }
  }
});

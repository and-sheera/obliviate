import type { Span, Term } from './types';

const CYR = /[Ѐ-ӿ]/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Case endings a Russian name/company can take. "ов"/"ев" are deliberately absent:
// they are part of surnames, so "Иван" must not match "Иванов".
const END =
  'ами|ями|ыми|ими|ого|его|ому|ему|ием|ией|ию|ии|ия|ой|ей|ёй|ою|ею|ом|ем|ём|ам|ям|ах|ях|ым|им|ых|их|ую|юю|ая|яя|ое|ее|ые|ие|ий|ый|ью|[аяуюеыиьйё]';
const V = 'аеёиоуыэюяьй';

/** nominative form → the part that stays constant across cases: Сергей → Серге, Ромашка → Ромашк, Белая → Бел */
export function matchStem(w: string): string {
  if (/(?:ск|цк)(?:ий|ой|ая|ое|ие)$/i.test(w)) return w.slice(0, -2);
  if (w.length >= 5 && /(?:ой|ый|ий|ая|яя)$/i.test(w)) return w.slice(0, -2);
  if (w.length >= 4 && new RegExp(`[${V}]$`, 'i').test(w)) return w.slice(0, -1);
  return w;
}

/** the vowel that drops out in other cases: Павел → Павл(а), Лев → Льв(а), Орёл → Орл(а) */
function fleeting(w: string): string | null {
  const m = new RegExp(`^(.*[^${V}])[еёо]([^${V}])$`, 'i').exec(w);
  if (!m || w.length > 6) return null;
  return m[1] + (/л$/i.test(m[1]) && /[её]/i.test(w[m[1].length]) ? 'ь' : '') + m[2];
}

/** е and ё are the same letter in practice: Пётр / Петра, Фёдор / Федора */
const yo = (s: string) => s.replace(/[её]/gi, '[её]');

function word(w: string): string {
  if (!CYR.test(w)) return esc(w);
  const stem = matchStem(w);
  // the term's own ending is always allowed ("Шевченко", "Касперского"), a bare "-о" otherwise is not ("Сорокин" ≠ "Сорокино")
  const main = yo(esc(stem)) + `(?:${END}|${yo(esc(w.slice(stem.length)))})?`;
  const alt = fleeting(w);
  return alt ? `(?:${main}|${yo(esc(alt))}(?:${END}))` : main;
}

const compiled = new Map<string, RegExp>();
function regexFor(term: string): RegExp {
  let re = compiled.get(term);
  if (!re) {
    const body = term.split(/\s+/).map(word).join('\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu');
    compiled.set(term, re);
  }
  return re;
}

export function findDictionary(text: string, dict: Term[]): Span[] {
  const out: Span[] = [];
  for (const { term: raw, type } of dict) {
    const term = raw.trim();
    if (!term) continue;
    for (const m of text.matchAll(regexFor(term))) {
      out.push({
        start: m.index!, end: m.index! + m[0].length, type,
        text: m[0], value: term, source: 'dict', prio: 80,
      });
    }
  }
  return out;
}

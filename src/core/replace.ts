import { matchStem } from './dictionary';
import type { Span, Type } from './types';

const CYR = /[Ѐ-ӿ]/;
const words = (s: string) => s.trim().split(/\s+/);
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

const LOOKALIKE: Record<string, string> = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', 'ë': 'е' };
/** spellings that look the same: "ё" as е + ◌̈ (PDFs, macOS), latin "x", "a", "ë" inside a russian word, soft hyphens and zero-width spaces */
function lookSame(word: string): string {
  const w = word.normalize('NFC').replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '');
  return CYR.test(w) ? w.replace(/[aeopcxykë]/gi, (c) => LOOKALIKE[c.toLowerCase()]) : w;
}

/** Identity of a word across case forms: Иванов/Иванову/Ивановым → иванов, Сергей/Сергея → серг */
function keyStem(word: string): string {
  let w = fold(lookSame(word));
  if (!CYR.test(w)) return w;
  for (let i = 0; i < 3; i++) {
    const n = w.replace(/(?:ами|ями|ом|ем|ам|ям|ах|ях|ым|им|ых|их|ми|[аеиоуыэюяьй])$/u, '');
    if (n.length < 3 || n === w) break;
    w = n;
  }
  return w;
}

const STEMMED = new Set<Type>(['PERSON', 'ORG', 'LOC']);
const CASE_INSENSITIVE = new Set<Type>(['EMAIL', 'HOST', 'MAC', 'TELEGRAM']);

/** Same entity in any case form → same key → one row in the list, one replacement. */
export function entityKey(type: Type, value: string): string {
  if (STEMMED.has(type)) return `${type}:${words(value).map(keyStem).join(' ')}`;
  return `${type}:${CASE_INSENSITIVE.has(type) ? value.toLowerCase() : value}`;
}

/**
 * One word of the replacement takes the case ending the original word has here: Сбербанк→Комбанк, so Сбербанка→Комбанка.
 * Only when both decline alike (same ending in the base form: Сбербанк/Комбанк, Ромашка/Звезда), and never initials or latin.
 * ponytail: no morphology — a different declension ("Ромашка" → "Лилия") stays in its base form rather than become "Лилиу".
 */
function inflectWord(to: string, here: string, base: string): string {
  if (here === base || to.includes('.') || !CYR.test(to)) return to;
  const stem = matchStem(base), toStem = matchStem(to);
  if (fold(base.slice(stem.length)) !== fold(to.slice(toStem.length)) || !fold(here).startsWith(fold(stem))) return to;
  return toStem + here.slice(stem.length);
}

/** The replacement written for `base`, put into the case form `here`: ("Иван И.", "Ивану Иванову", "Иван Иванов") → "Ивану И." */
export function inflect(to: string, here: string, base: string): string {
  if (here === base || !to) return to;
  const h = words(here), b = words(base), t = words(to);
  if (h.length !== b.length) return to;
  if (t.length === b.length) return t.map((w, i) => inflectWord(w, h[i], b[i])).join(' ');
  return [...t.slice(0, -1), inflectWord(t[t.length - 1], h[h.length - 1], b[b.length - 1])].join(' ');
}

/** What the "replace with" field starts with. `n` keeps two different emails from becoming the same one. Empty: the human makes it up. */
export function suggest(type: Type, value: string, n = 1): string {
  switch (type) {
    case 'PERSON': {
      // "Иван Иванов" → "Иван И.", "Иванов И.И." → "И. И.И.", "Иванов" → "И."
      const ws = words(value), initials = ws.some((w) => w.includes('.'));
      return ws.map((w, i) => (w.includes('.') || (i === 0 && !initials && ws.length > 1) ? w : `${w[0]}.`)).join(' ');
    }
    case 'EMAIL': return `user${n}@example.com`;
    case 'PHONE': return `+7 900 000-00-${String(n).padStart(2, '0')}`;
    case 'TELEGRAM': return `user${n}`; // the span is the name after "@", the "@" stays in the text
    case 'IP': return value.includes(':') ? `2001:db8::${n}` : `192.0.2.${n}`;
    case 'MAC': return `00:00:5E:00:53:${n.toString(16).padStart(2, '0').toUpperCase()}`;
    case 'HOST': return `host${n}.example`;
    case 'LOGIN': return `user${n}`;
    case 'PASSWORD': case 'SECRET': return '********';
    case 'PRIVATE_KEY': return '[закрытый ключ]';
    case 'API_KEY': case 'TOKEN': return `${/^[A-Za-z]+[-_]/.exec(value)?.[0] ?? ''}…XXXX`; // "sk-…XXXX": the kind of key stays readable
    default: return '';
  }
}

/** a replacement and the form it was written for, so other case forms can be inflected from it */
export interface Choice { to: string; from: string }

/** Replace the spans `choose` picks; everything else stays as it is. `ranges` — where the replacements are in the result. */
export function replace(text: string, spans: Span[], choose: (sp: Span) => Choice | null) {
  let out = '', pos = 0;
  const ranges: Array<[number, number]> = [];
  for (const sp of spans) {
    const c = choose(sp);
    if (!c?.to) continue;
    const v = inflect(c.to, sp.text, c.from);
    out += text.slice(pos, sp.start);
    ranges.push([out.length, out.length + v.length]);
    out += v;
    pos = sp.end;
  }
  return { text: out + text.slice(pos), ranges };
}

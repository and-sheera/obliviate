import { matchStem } from './dictionary';
import { TYPES, type Type } from './types';

/**
 * Tags mode: everything found becomes a tag "[PERSON_1]", the reply of the neural network is turned back into the words.
 * The case travels as the ending after "|": "Передай Андрею" → "[PERSON_1|ю]", and back: stem of the canonical form + "ю".
 */

/** one hidden thing: its tag and the forms it was seen in; `canon` is the form that looks most like the nominative: the stem and endings are taken from it */
export interface TagEntry { tag: string; type: Type; canon: string; forms: string[]; loose?: boolean }
export interface TagTable { next: Partial<Record<Type, number>>; byKey: Record<string, TagEntry> }
export const newTable = (): TagTable => ({ next: {}, byKey: {} });

type Range = [number, number];
const CYR = /[Ѐ-ӿ]/;
const ENDING = /^[Ѐ-ӿ]{1,3}$/;
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
const DECLINED = new Set<Type>(['PERSON', 'ORG', 'LOC']);

/**
 * How much a word looks like the nominative, lower is closer: 0 Иван, Андрей, Иванов; 1 Анна, Мария, Шевченко; 2 Ивану, Марии, Иванов**ой**; 3 Иваном, Ивановым, Марией.
 * A guess by the ending, no dictionary: "Максим" and "Андреем" tie with it, then the shorter wins.
 */
function wordRank(w: string): number {
  const l = fold(w);
  if (!CYR.test(l) || l.includes('.')) return 0;
  if (/ией$/.test(l) || (l.length >= 5 && /(?:ами|ями|ого|его|ому|ему|ым|ом)$/.test(l))) return 3;
  if (/ой$/.test(l)) return 2;
  if (/[ая]$/.test(l)) return 1;
  if (/о$/.test(l)) return 1; // indeclinable: Шевченко, Токио
  return /[уюеыиэ]$/.test(l) ? 2 : 0;
}
/** of several forms of one thing the one that looks most like the nominative has the lowest rank */
export const formRank = (form: string): number => form.split(/\s+/).reduce((n, w) => n + wordRank(w), 0);

/**
 * endings of the words of `form` against `canon` ('' = the word is canonical); null: cannot be said that way (another number of words, a vanishing vowel: Павел → Павлу).
 * A canonical word that looks like an oblique case ("Андрею") has its ending written too: the network must see the case, "[PERSON_1]" alone would read as the nominative.
 */
function endings(canon: string, form: string): string[] | null {
  const c = canon.split(/\s+/), f = form.split(/\s+/);
  if (c.length !== f.length) return null;
  const out: string[] = [];
  for (const [i, w] of c.entries()) {
    const same = fold(w) === fold(f[i]);
    if (same && wordRank(w) < 2) { out.push(''); continue; }
    const stem = matchStem(w);
    if (!CYR.test(w) || w.includes('.') || !fold(f[i]).startsWith(fold(stem))) { if (same) { out.push(''); continue; } return null; }
    const e = f[i].slice(stem.length).toLowerCase();
    if (!e && same) { out.push(''); continue; }
    if (!ENDING.test(e)) return null;
    out.push(e);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/**
 * The tag for this thing in this form. A thing keeps its number for good, so a new prompt of the same session can be answered by the same table.
 * `canon`: the form of this text that looks most like the nominative (formRank); a better one than the table has replaces it, the stem is the same.
 * ponytail: with only "Андрею" seen, "[PERSON_1]" alone comes back as it (marked to double-check). Needs morphology to do better.
 */
export function tagFor(t: TagTable, key: string, type: Type, canon: string, form: string): string {
  form = form.replace(/\s+/g, ' ');
  let e = t.byKey[key];
  if (!e) {
    const n = (t.next[type] = (t.next[type] ?? 0) + 1);
    e = t.byKey[key] = { tag: `${type}_${n}`, type, canon: canon.replace(/\s+/g, ' '), forms: [] };
    e.forms.push(e.canon);
  }
  canon = canon.replace(/\s+/g, ' ');
  if (formRank(canon) < formRank(e.canon) && canon.split(' ').length === e.canon.split(' ').length) {
    e.canon = canon;
    if (!e.forms.some((x) => fold(x) === fold(canon))) e.forms.push(canon);
  }
  if (!e.forms.some((x) => fold(x) === fold(form))) e.forms.push(form);
  const en = DECLINED.has(type) ? endings(e.canon, form) : [];
  if (!en) { e.loose = true; return `[${e.tag}]`; }
  return `[${e.tag}${en.map((x) => `|${x}`).join('')}]`;
}

const T = TYPES.join('|');
// "[PERSON_1|ю]", "[ person_1 | ю ]", "[PERSON_1]-ю", bare "PERSON_1" (the network dropped the brackets; bare ones take no "|": it is a table separator too)
const TAG = new RegExp(
  String.raw`\[\s*(${T})_(\d+)((?:\s*\|\s*\p{L}{0,4})*)\s*\](?:-([Ѐ-ӿ]{1,3}))?|(?<![\p{L}\p{N}_])(${T})_(\d+)(?!\d)(?:-([Ѐ-ӿ]{1,3}))?`,
  'giu',
);

/** the words of `e` with the endings put on; doubt: an ending that does not fit, or a form never seen with this thing */
function restore(e: TagEntry, ends: string[]): { value: string; doubt: boolean } {
  let doubt = false;
  const value = e.canon.split(/\s+/).map((w, i) => {
    const x = ends[i];
    if (!x) return w;
    if (!CYR.test(w) || w.includes('.') || !ENDING.test(x)) { doubt = true; return w; }
    return matchStem(w) + x;
  }).join(' ');
  const changed = ends.some(Boolean);
  // without an ending it is the canonical form; if that is no nominative ("Андрею") or not told by endings (Павел → Павлу), the network may have meant another
  return { value, doubt: doubt || (changed ? !e.forms.some((f) => fold(f) === fold(value)) : !!e.loose || e.canon.split(/\s+/).some((w) => wordRank(w) >= 2)) };
}

export interface Untagged {
  text: string;
  /** where the words are in `text`, and which of them to double-check */
  ranges: Range[];
  unsure: Range[];
  /** where the tags were in the input */
  tags: Range[];
  /** tags the table does not know: left as they are (another session?) */
  unknown: number;
}

/** The reply with the tags turned back into the words. */
export function untag(text: string, t: TagTable): Untagged {
  const by = new Map(Object.values(t.byKey).map((e) => [e.tag, e]));
  const r: Untagged = { text: '', ranges: [], unsure: [], tags: [], unknown: 0 };
  let pos = 0;
  for (const m of text.matchAll(TAG)) {
    const e = by.get(`${(m[1] ?? m[5]).toUpperCase()}_${m[2] ?? m[6]}`);
    r.text += text.slice(pos, m.index);
    pos = m.index + m[0].length;
    r.tags.push([m.index, pos]);
    const at = r.text.length;
    if (!e) { r.text += m[0]; r.unknown++; r.unsure.push([at, r.text.length]); continue; }
    const hyphen = m[4] ?? m[7];
    const words = e.canon.split(/\s+/).length;
    const ends = hyphen ? [...Array<string>(words - 1).fill(''), hyphen.toLowerCase()] : (m[3] ?? '').split('|').slice(1).map((x) => x.trim().toLowerCase());
    const { value, doubt } = restore(e, ends);
    r.text += value;
    r.ranges.push([at, r.text.length]);
    if (doubt) r.unsure.push([at, r.text.length]);
  }
  r.text += text.slice(pos);
  return r;
}

import { detect, resolve } from './detect';
import { findDictionary } from './dictionary';
import { entityKey } from './replace';
import type { Span, Term, Type } from './types';

export interface Sources {
  /** words to find in every case form: the global dictionary and what the user selected in this text */
  dict?: Term[];
  /** spans from other detectors (NER) */
  extra?: Span[];
}

/** Everything that could be replaced, non-overlapping and ordered. Nothing is replaced until the user says so. */
export function collect(text: string, { dict = [], extra = [] }: Sources): Span[] {
  const found = [...detect(text), ...findDictionary(text, dict), ...extra];
  return resolve(oneType([...found, ...everywhere(text, found)]));
}

const SECRETS = new Set<Type>(['PASSWORD', 'SECRET', 'API_KEY', 'TOKEN']);
/** a login that cannot be an ordinary word: svc_auth, user42 — but not "admin" */
const spreads = (s: Span) =>
  s.source === 'ner' || (s.source === 'regex' && s.text.length >= 4 && (SECRETS.has(s.type) || (s.type === 'LOGIN' && /[\d_.]/.test(s.text))));

/**
 * The model finds "Роман" in one line and misses it in the next; a password found in a config is also in the log below it:
 * offer every whole-word occurrence of what was found.
 */
function everywhere(text: string, spans: Span[]): Span[] {
  const found = new Map<string, Span>();
  for (const s of spans) if (spreads(s) && !found.has(s.text)) found.set(s.text, s);
  const out: Span[] = [];
  for (const [v, s] of found) {
    for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + v.length)) {
      if (!/[\p{L}\p{N}]/u.test(text[i - 1] ?? '') && !/[\p{L}\p{N}]/u.test(text[i + v.length] ?? '')) out.push({ ...s, start: i, end: i + v.length });
    }
  }
  return out;
}

const NAMED = new Set<Type>(['PERSON', 'ORG', 'LOC']);
/** «Озона» — место, «Озоном» — человек: one word, one type in the whole text. The rules and the dictionary outvote the model. */
function oneType(spans: Span[]): Span[] {
  const votes = new Map<string, Map<Type, number>>();
  const key = (s: Span) => entityKey('ORG', s.value);
  for (const s of spans) {
    if (!NAMED.has(s.type)) continue;
    const v = votes.get(key(s)) ?? new Map<Type, number>();
    v.set(s.type, (v.get(s.type) ?? 0) + (s.source === 'ner' ? 1 : 100));
    votes.set(key(s), v);
  }
  return spans.map((s) => {
    if (s.source !== 'ner' || !NAMED.has(s.type)) return s;
    const [type] = [...votes.get(key(s))!].reduce((a, b) => (b[1] > a[1] ? b : a));
    return type === s.type ? s : { ...s, type };
  });
}

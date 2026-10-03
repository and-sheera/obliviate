import { suggest } from './replace';
import { TYPES, type DictEntry, type Span, type Term, type Type } from './types';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
}

const DICT = 'obliviate:replace';
// v1 kept sessions (placeholder ↔ original, in plain text) and an "always hide" dictionary without replacements
const OLD_DICT = 'obliviate:dict';
const OLD = ['obliviate:sessions', 'obliviate:current', OLD_DICT];

function readJson(st: KV, key: string): unknown {
  try {
    return JSON.parse(st.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

const isType = (t: unknown): t is Type => TYPES.includes(t as Type);

export function loadDict(st: KV): DictEntry[] {
  let raw = readJson(st, DICT);
  if (!Array.isArray(raw)) {
    // the old dictionary becomes the new one: names get initials, companies wait for a replacement in the settings
    const old = readJson(st, OLD_DICT);
    raw = Array.isArray(old) ? old.map((d) => d && { ...d, replacement: isType(d.type) ? suggest(d.type, String(d.term ?? '')) : '' }) : [];
    if (Array.isArray(old)) st.setItem(DICT, JSON.stringify(raw));
  }
  for (const k of OLD) st.removeItem?.(k);
  return (raw as DictEntry[]).filter((d) => d && typeof d.term === 'string' && isType(d.type) && typeof d.replacement === 'string');
}

export const saveDict = (st: KV, d: DictEntry[]): void => st.setItem(DICT, JSON.stringify(d));

/** what is picked in the current text: replace the word (in every case form) with `to`, or don't (`on: false`) */
export type Pick = { to: string; from: string; on: boolean };
/** the text and what was picked in it: survive a reload */
export interface Session {
  text: string;
  picks: Array<[string, Pick]>;
  terms: Term[];
  /** rows joined by hand ("Зида" → "Зина"): entity key → the key of the row it joined */
  aliases?: Array<[string, string]>;
  /** what the model found in `text` (finished analysis only), in which mode and with which models (`fast@<hash>`): no need to run it again after a reload */
  ner?: { mode: string; spans: Span[] };
}

// IndexedDB, not localStorage: a text can be megabytes, localStorage holds ~5 MB for everything. Without it (private mode) nothing is kept.
function idb(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((ok, fail) => {
    const open = indexedDB.open('obliviate', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = op(db.transaction('kv', mode).objectStore('kv'));
      r.onsuccess = () => { db.close(); ok(r.result); };
      r.onerror = () => { db.close(); fail(r.error); };
    };
  });
}

export const loadSession = (): Promise<Session | null> =>
  idb('readonly', (s) => s.get('session')).then((v) => (v as Session) ?? null, () => null);
export const saveSession = (session: Session): Promise<unknown> => idb('readwrite', (s) => s.put(session, 'session')).catch(() => null);


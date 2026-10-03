import { collect } from '../src/core/mask';
import { entityKey, replace } from '../src/core/replace';
import type { Span, Term } from '../src/core/types';

/** what the user gets after replacing everything the app offers: each entity → [TYPE_N], one number per entity in all its case forms */
export function replaceAll(text: string, dict: Term[] = [], extra: Span[] = []): string {
  const names = new Map<string, string>();
  const count: Record<string, number> = {};
  return replace(text, collect(text, { dict, extra }), (sp) => {
    const k = entityKey(sp.type, sp.value);
    if (!names.has(k)) names.set(k, `[${sp.type}_${(count[sp.type] = (count[sp.type] ?? 0) + 1)}]`);
    return { to: names.get(k)!, from: sp.text };
  }).text;
}

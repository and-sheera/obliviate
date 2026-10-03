import type { Span } from '../core/types';
import { aggregate, type RawToken } from './aggregate';

/** what `pipeline('token-classification', …)` looks like to us */
export type NerPipe = (text: string, opts: { ignore_labels: string[] }) => Promise<RawToken[]>;

const MAX_CHUNK = 800; // chars; comfortably under the model's 512 tokens
const MIN_CHUNK = 600;

/** a newline may end a part if the line before it hashes to 0 mod 2 (blank lines always do) */
function marked(text: string, nl: number): boolean {
  let h = 0;
  for (let i = text.lastIndexOf('\n', nl - 1) + 1; i < nl; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0) % 2 === 0;
}

/**
 * split on newlines (or spaces as a last resort) so entities are rarely cut.
 * Parts end at marked newlines, which depend on the text around them and not on where the part began:
 * an edit changes only the parts next to it, and the rest come from the cache (see nerSpans).
 */
export function chunk(text: string): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + MAX_CHUNK, text.length);
    let nl = text.indexOf('\n', pos + MIN_CHUNK);
    while (nl >= 0 && nl < end - 1 && !marked(text, nl)) nl = text.indexOf('\n', nl + 1);
    if (nl >= 0 && nl < end - 1) end = nl + 1;
    else if (end < text.length) {
      const cut = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (cut > pos + MAX_CHUNK / 2) end = cut + 1;
    }
    const part = text.slice(pos, end);
    if (/\p{L}/u.test(part)) out.push({ offset: pos, text: part });
    pos = end;
  }
  return out;
}

/**
 * "Ну", "Слушай", "Будешь" open a sentence with a capital (speech-to-text capitalises every cue), and the model takes them for names.
 * If the same text also has the word in lowercase, it is an ordinary word. Only at sentence start, so "встретил Романа… читаю роман" is safe.
 */
export function ordinaryWords(text: string): (s: Span) => boolean {
  const lower = new Set(text.match(/(?<![\p{L}-])\p{Ll}\p{L}*(?:-\p{L}+)*/gu));
  return (s) => {
    if (/\s/.test(s.text) || !lower.has(s.text.toLowerCase())) return false;
    const before = (s.start < 10 ? '\n' : '') + text.slice(Math.max(0, s.start - 10), s.start);
    return /[.!?…\]:—\n][\s"«(]*$/.test(before);
  };
}

/** "Катя: я до обеда", "Катюх, скинь", "Лейле — добавить алерт": someone addressed or speaking. "Подожди.", "Будешь с ним" never look like this */
const addressed = (text: string, s: Span) => s.type === 'PERSON' && /^[ \t]*[,:!—–]/.test(text.slice(s.end));

/**
 * Several models vote: a span stays when at least `k` models found something overlapping it.
 * One model trusts itself; three keep what two of them agree on — or a name in an address, or a latin name, that one of them found.
 */
export function vote(perModel: Span[][], text = '', k = Math.floor(perModel.length / 2) + 1): Span[] {
  const seen = new Set<string>();
  return perModel.flat().flatMap((c) => {
    const key = `${c.start}:${c.end}:${c.type}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const agree = perModel.filter((m) => m.some((s) => s.start < c.end && c.start < s.end)).length;
    // latin got through aggregate() only as Title Case in an english line, and only one of the models knows english
    const keep = agree >= k || addressed(text, c) || (/[A-Za-z]/.test(c.text) && !/[\u0400-\u04FF]/.test(c.text));
    // how sure we are: the model's own confidence × the share of models that agree (the table sorts by it)
    return keep ? [{ ...c, score: (c.score ?? 1) * (agree / perModel.length) }] : [];
  });
}

/**
 * Спаны всего текста. Текст идёт по частям, и после каждой части вызывается `onChunk`
 * (части этой порции, сколько частей готово, сколько всего), чтобы интерфейс показывал ход работы.
 * `stop` позволяет прервать работу между частями, если текст уже изменили.
 * Несколько моделей голосуют по каждой части (см. `vote`).
 * `cache` (текст части → итог голосования) пропускает части, которые уже считали: после правки пересчитываются только соседние с ней.
 */
export async function nerSpans(
  pipes: NerPipe[],
  text: string,
  onChunk?: (spans: Span[], done: number, total: number) => void,
  stop?: () => boolean,
  cache?: Map<string, Span[]>,
): Promise<Span[]> {
  const out: Span[] = [];
  const parts = chunk(text);
  const ordinary = ordinaryWords(text);
  for (const [i, c] of parts.entries()) {
    if (stop?.()) break;
    let voted = cache?.get(c.text);
    if (!voted) {
      const perModel: Span[][] = [];
      for (const pipe of pipes) perModel.push(aggregate(c.text, await pipe(c.text, { ignore_labels: [] })));
      voted = vote(perModel, c.text);
      cache?.set(c.text, voted);
    }
    const found = voted.map((s) => ({ ...s, start: s.start + c.offset, end: s.end + c.offset })).filter((s) => !ordinary(s));
    out.push(...found);
    onChunk?.(found, i + 1, parts.length);
  }
  return out;
}

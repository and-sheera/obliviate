import { describe, expect, it } from 'vitest';
import { chunk, nerSpans, type NerPipe } from '../src/ner/run';

// Поддельная модель: ничего не находит, только считает вызовы — нам важен ход работы, а не качество.
const fakePipe = (calls: string[]): NerPipe => async (text) => { calls.push(text); return []; };
const longText = Array.from({ length: 6 }, (_, i) => `Абзац ${i}: ${'слово '.repeat(120)}`).join('\n');

describe('nerSpans: ход работы по частям', () => {
  // Проверяет, что после каждой части текста вызывается колбэк с номером готовой части и общим числом частей.
  it('сообщает прогресс после каждой части', async () => {
    const calls: string[] = [];
    const seen: Array<[number, number]> = [];
    await nerSpans([fakePipe(calls)], longText, (_s, done, total) => seen.push([done, total]));
    const total = chunk(longText).length;
    expect(total).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => [i + 1, total]));
  });

  // Проверяет, что работу можно прервать между частями (текст изменили) и лишние части не считаются.
  it('останавливается, когда просят прервать', async () => {
    const calls: string[] = [];
    await nerSpans([fakePipe(calls)], longText, undefined, () => calls.length >= 1);
    expect(calls).toHaveLength(1);
  });

  // Проверяет, что без колбэков функция работает как раньше и возвращает все найденные места.
  it('работает без колбэков', async () => {
    const calls: string[] = [];
    await expect(nerSpans([fakePipe(calls)], longText)).resolves.toEqual([]);
    expect(calls).toHaveLength(chunk(longText).length);
  });
});

describe('nerSpans: кеш частей', () => {
  // Чат из разных строк: правка в середине должна менять только соседние части, остальные границы на месте.
  const chat = Array.from({ length: 80 }, (_, i) => `Катя ${i}: обсудили задачу номер ${i * 7}, завтра созвон в ${i % 12} часов`).join('\n');
  const edited = chat.replace('задачу номер 280', 'задачу номер 280 и ещё одну про отчёт');

  // Проверяет, что после правки в середине длинного текста меняется не больше двух частей.
  it('правка сдвигает границы только рядом с собой', () => {
    const before = new Set(chunk(chat).map((p) => p.text));
    const changed = chunk(edited).filter((p) => !before.has(p.text));
    expect(chunk(chat).length).toBeGreaterThan(5);
    expect(changed.length).toBeLessThanOrEqual(2);
  });

  // Проверяет, что повторный анализ с кешем зовёт модель только для изменённых частей.
  it('модель считает только изменённые части', async () => {
    const calls: string[] = [];
    const cache = new Map();
    await nerSpans([fakePipe(calls)], chat, undefined, undefined, cache);
    calls.length = 0;
    await nerSpans([fakePipe(calls)], edited, undefined, undefined, cache);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});

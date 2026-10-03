import { describe, it, expect } from 'vitest';
import { collect } from '../src/core/mask';
import { entityKey, inflect, replace, suggest, type Choice } from '../src/core/replace';
import type { Span } from '../src/core/types';

describe('inflect: the replacement takes the case form of the original', () => {
  it('same declension: the ending moves over', () => {
    expect(['Сбербанк', 'Сбербанка', 'Сбербанку', 'Сбербанком', 'Сбербанке'].map((h) => inflect('Комбанк', h, 'Сбербанк')))
      .toEqual(['Комбанк', 'Комбанка', 'Комбанку', 'Комбанком', 'Комбанке']);
    expect(inflect('Звезда', 'Ромашкой', 'Ромашка')).toBe('Звездой');
    expect(inflect('Петров', 'Иванову', 'Иванов')).toBe('Петрову');
  });
  it('initials and latin stay as written', () => {
    expect(inflect('Иван И.', 'Ивану Иванову', 'Иван Иванов')).toBe('Ивану И.');
    expect(inflect('Acme', 'Сбербанка', 'Сбербанк')).toBe('Acme');
  });
  it('a different declension stays in its base form rather than become nonsense', () => {
    expect(inflect('Лилия', 'Ромашку', 'Ромашка')).toBe('Лилия');
  });
  it('a different number of words: only the last word declines', () => {
    expect(inflect('Ромашка Плюс', 'Ромашке', 'Ромашка')).toBe('Ромашка Плюс');
    expect(inflect('Альфа Банк', 'Сбербанка', 'Сбербанк')).toBe('Альфа Банка');
  });
  it('works from any written form, not only the nominative', () => {
    expect(inflect('Ивану И.', 'Иван Иванов', 'Ивану Иванову')).toBe('Иван И.');
  });
});

describe('suggest: what the "replace with" field starts with', () => {
  it('people keep the first word and initials of the rest', () => {
    expect(suggest('PERSON', 'Иван Иванов')).toBe('Иван И.');
    expect(suggest('PERSON', 'Анна Сергеевна Петрова')).toBe('Анна С. П.');
    expect(suggest('PERSON', 'Иванов')).toBe('И.');
    expect(suggest('PERSON', 'Иванов И.И.')).toBe('И. И.И.'); // the surname never survives
  });
  it('a telegram name: the "@" is not part of the span and stays in the text', () => {
    const text = 'пиши @anna_k_pm';
    const sp = collect(text, {});
    expect(replace(text, sp, (s) => ({ to: suggest(s.type, s.value), from: s.text })).text).toBe('пиши @user1');
  });
  it('contacts and secrets get safe placeholders, numbered so they stay distinct', () => {
    expect(suggest('EMAIL', 'a@b.ru', 2)).toBe('user2@example.com');
    expect(suggest('PHONE', '+7 903 555-11-22', 3)).toBe('+7 900 000-00-03');
    expect(suggest('IP', '10.0.0.1', 4)).toBe('192.0.2.4');
    expect(suggest('API_KEY', 'sk-proj-abc123')).toBe('sk-…XXXX');
    expect(suggest('PASSWORD', 'hunter2')).toBe('********');
  });
  it('companies and places are made up by the human', () => {
    expect(suggest('ORG', 'Сбербанк')).toBe('');
    expect(suggest('LOC', 'Москва')).toBe('');
  });
});

describe('replace', () => {
  const text = 'Иван Иванов из Сбербанка написал Ивану Иванову, ключ sk-proj-Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7b';
  const dict = [{ term: 'Иван Иванов', type: 'PERSON' as const }, { term: 'Сбербанк', type: 'ORG' as const }];
  const spans = collect(text, { dict });
  const by = (m: Record<string, Choice>) => (sp: Span) => m[entityKey(sp.type, sp.value)] ?? null;

  it('nothing is replaced unless chosen', () => {
    expect(replace(text, spans, () => null)).toEqual({ text, ranges: [] });
  });
  it('a choice covers every case form; ranges point at the replacements in the result', () => {
    const r = replace(text, spans, by({
      [entityKey('ORG', 'Сбербанк')]: { to: 'Комбанк', from: 'Сбербанк' },
      [entityKey('PERSON', 'Иван Иванов')]: { to: 'Иван И.', from: 'Иван Иванов' },
    }));
    expect(r.text).toBe('Иван И. из Комбанка написал Ивану И., ключ sk-proj-Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7b');
    expect(r.ranges.map(([a, b]) => r.text.slice(a, b))).toEqual(['Иван И.', 'Комбанка', 'Ивану И.']);
  });
  it('an empty replacement is no replacement', () => {
    expect(replace(text, spans, () => ({ to: '', from: '' })).text).toBe(text);
  });
});

describe('entityKey: spellings that look the same are one row', () => {
  it('decomposed ё, latin look-alikes, soft hyphen, zero-width space', () => {
    const key = entityKey('PERSON', 'Лёха');
    for (const w of ['Ле\u0308ха', 'Л\u00ebха', 'Лёxa', 'Лё\u00adха', 'Лё\u200bха', 'Лёхе']) expect(entityKey('PERSON', w), JSON.stringify(w)).toBe(key);
    expect(entityKey('PERSON', 'Alex')).toBe('PERSON:alex'); // latin names stay latin
  });
});

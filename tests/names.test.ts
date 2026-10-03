import { describe, it, expect } from 'vitest';
import { justName, similarKeys } from '../src/core/names';
import { entityKey } from '../src/core/replace';

describe('justName: by a first name alone nobody can be told', () => {
  it('first names in any case form, colloquial ones, a name with an initial, initials only', () => {
    for (const v of ['Даня', 'Дане', 'Лёха', 'Лёхой', 'Катюх', 'Иван И.', 'Ивану И.', 'И. И.', 'Наташей', 'Michael']) expect(justName(v), v).toBe(true);
  });
  it('a surname, a patronymic or an unknown word: a person to hide', () => {
    for (const v of ['Иван Иванов', 'Георгий Павлович', 'Иванов И.И.', 'Ким', 'Ли', 'Хабибуллин', 'Иванова', 'Петрову', 'Sarah Connor']) expect(justName(v), v).toBe(false);
  });
});

describe('similarKeys: probably one entity misspelt', () => {
  const k = (v: string, t: 'PERSON' | 'ORG' = 'PERSON') => entityKey(t, v);
  it('one letter replaced, added, dropped or swapped', () => {
    for (const [a, b] of [['Зина', 'Зида'], ['Иванов', 'Ивонов'], ['Хабибуллин', 'Хабибулин'], ['Петров', 'Петорв'], ['Зине', 'Зиде']]) expect(similarKeys(k(a), k(b)), `${a}/${b}`).toBe(true);
    expect(similarKeys(k('Ромашка', 'ORG'), k('Ромащка', 'ORG')), 'Ромашка/Ромащка').toBe(true); // «Ромашко» is the same row already: same stem
    expect(similarKeys(k('Зина Петровна Иванова'), k('Зида Петровна Ивонова'))).toBe(true); // word by word
  });
  it('two known names, more than one edit, too short, another type: not offered', () => {
    for (const [a, b] of [['Ваня', 'Таня'], ['Дима', 'Дина'], ['Иван', 'Иванов'], ['Ли', 'Лу'], ['Зина', 'Зина']]) expect(similarKeys(k(a), k(b)), `${a}/${b}`).toBe(false);
    expect(similarKeys(k('Зина'), k('Зида', 'ORG'))).toBe(false);
    expect(similarKeys(k('Ваня Петров'), k('Таня Петров'))).toBe(false); // two people with one surname
    expect(similarKeys(k('Зина Иванова'), k('Зина'))).toBe(false); // another number of words is another row on purpose
    expect(similarKeys('EMAIL:a1@b.ru', 'EMAIL:a2@b.ru')).toBe(false);
  });
});


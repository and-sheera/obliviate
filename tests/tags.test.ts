import { describe, it, expect } from 'vitest';
import { formRank, newTable, tagFor, untag } from '../src/core/tags';

const person = (t = newTable()) => (key: string, canon: string, form: string) => tagFor(t, key, 'PERSON', canon, form);

describe('tagFor: one thing, one number; the case is the ending', () => {
  it('the same thing in other cases keeps its number, the ending travels', () => {
    const f = person();
    expect(['Андрей', 'Андрею', 'Андреем', 'Андрея'].map((x) => f('PERSON:андре', 'Андрей', x)))
      .toEqual(['[PERSON_1]', '[PERSON_1|ю]', '[PERSON_1|ем]', '[PERSON_1|я]']);
    expect(f('PERSON:петр', 'Пётр', 'Пётр')).toBe('[PERSON_2]');
  });
  it('several words: an ending for each, canonical ones are empty', () => {
    const f = person();
    expect(f('k', 'Андрей Иванов', 'Андрея Иванова')).toBe('[PERSON_1|я|а]');
    expect(f('k', 'Андрей Иванов', 'Андрей Иванову')).toBe('[PERSON_1||у]');
    expect(f('k', 'Андрей Иванов', 'Андрею Иванов')).toBe('[PERSON_1|ю]');
  });
  it('what has no cases carries no endings', () => {
    const t = newTable();
    expect(tagFor(t, 'e', 'EMAIL', 'a@b.ru', 'a@b.ru')).toBe('[EMAIL_1]');
    expect(tagFor(t, 'k', 'API_KEY', 'sk-x', 'sk-x')).toBe('[API_KEY_1]');
    expect(person(t)('s', 'Шевченко', 'Шевченко')).toBe('[PERSON_1]');
  });
  it('a form that cannot be told by an ending (vanishing vowel, another count of words, initials) goes without one and is marked loose', () => {
    const t = newTable(), f = person(t);
    expect(f('p', 'Павел', 'Павлу')).toBe('[PERSON_1]');
    expect(f('i', 'Иван Иванов', 'Ивану')).toBe('[PERSON_2]');
    expect(f('j', 'Иван И.', 'Ивану И.')).toBe('[PERSON_3|у]');
    expect(f('j', 'Иван И.', 'Ивану Е.')).toBe('[PERSON_3]');
    expect(t.byKey.p.loose).toBe(true);
  });
});

describe('untag: the reply back into the words', () => {
  const t = newTable(), f = person(t);
  f('a', 'Андрей', 'Андрей'); f('a', 'Андрей', 'Андрею');
  f('i', 'Андрей Иванов', 'Андрея Иванова');
  tagFor(t, 'm', 'LOC', 'Москва', 'Москва'); tagFor(t, 'm', 'LOC', 'Москва', 'Москве');
  tagFor(t, 'e', 'EMAIL', 'a@b.ru', 'a@b.ru');
  const back = (s: string) => untag(s, t);

  it('stem of the canonical form plus the ending', () => {
    expect(back('Напишите [PERSON_1|ю] в [LOC_1|е], [PERSON_1] ответит на a@b.ru.').text).toBe('Напишите Андрею в Москве, Андрей ответит на a@b.ru.');
    expect(back('[PERSON_2|я|а] нет').text).toBe('Андрея Иванова нет');
    expect(back('почта [EMAIL_1]').text).toBe('почта a@b.ru');
  });
  it('where the words are, to paint them', () => {
    const r = back('к [PERSON_1|ю]!');
    expect(r.ranges).toEqual([[2, 8]]);
    expect(r.tags).toEqual([[2, 14]]);
    expect(r.unsure).toEqual([]);
  });
  it('the network is sloppy: spaces, case, dropped brackets, hyphen ending', () => {
    expect(back('[ person_1 | ю ] и PERSON_1 и [PERSON_1]-ю').text).toBe('Андрею и Андрей и Андрею');
    expect(back('[LOC_1]-е').text).toBe('Москве');
    expect(back('[PERSON_2]-а').text).toBe('Андрей Иванова');
  });
  it('a table separator is not a tag', () => {
    expect(back('| PERSON_1 | Роль |').text).toBe('| Андрей | Роль |');
    expect(back('MY_PERSON_1 и PERSON_12').text).toBe('MY_PERSON_1 и PERSON_12');
  });
  it('an ending never seen with this thing is to double-check; seen or canonical ones are not', () => {
    expect(back('[PERSON_1|у]').unsure).toEqual([[0, 6]]);
    expect(back('[PERSON_1|ю] [PERSON_1]').unsure).toEqual([]);
    expect(back('[PERSON_1|ёжик]').text).toBe('Андрей');
    expect(back('[PERSON_1|ёжик]').unsure).toEqual([[0, 6]]);
  });
  it('a loose thing is to double-check even without an ending', () => {
    const u = newTable();
    person(u)('p', 'Павел', 'Павел'); person(u)('p', 'Павел', 'Павлу');
    expect(untag('[PERSON_1]', u).unsure).toEqual([[0, 5]]);
  });
  it('a tag the table does not know stays as it is and is counted', () => {
    const r = back('[PERSON_9|ю] и [ORG_1]');
    expect(r.text).toBe('[PERSON_9|ю] и [ORG_1]');
    expect(r.unknown).toBe(2);
    expect(r.unsure.length).toBe(2);
  });
});

describe('the whole way: found → tags → back', async () => {
  const { collect } = await import('../src/core/mask');
  const { guess } = await import('../src/core/guess');
  const { entityKey, replace } = await import('../src/core/replace');

  /** what main.ts does in tags mode: one canonical form per row (the shortest), a tag per span */
  function hide(text: string, t = newTable()) {
    const spans = collect(text, { extra: guess(text) });
    const canon = new Map<string, string>();
    for (const s of spans) {
      const k = entityKey(s.type, s.value), c = canon.get(k);
      if (!c || formRank(s.text) < formRank(c) || (formRank(s.text) === formRank(c) && s.text.length < c.length)) canon.set(k, s.text);
    }
    const r = replace(text, spans, (s) => ({ to: tagFor(t, entityKey(s.type, s.value), s.type, canon.get(entityKey(s.type, s.value))!, s.text), from: s.text }));
    return { ...r, table: t };
  }

  it('cases come back as they were, and nothing hidden is left in the prompt', () => {
    const text = 'Привет! Передай Андрею, что Иван Петров ждёт письма от Ивана Петрова на i.petrov@acme-corp.ru. Иван Петров из Москвы, в Москве холодно.';
    const { text: prompt, table } = hide(text);
    expect(prompt).not.toMatch(/Андре|Петров|Москв|acme/);
    expect(prompt).toMatch(/\[PERSON_\d\|ю\]/);
    expect(untag(prompt, table).text).toBe(text);
  });
  it('the second prompt of the session keeps the numbers', () => {
    const first = hide('Андрей написал Ивану Петрову.');
    const second = hide('Иван Петров ответил Андрею.', first.table);
    const ids = (s: string) => s.match(/PERSON_\d/g);
    expect(ids(first.text)![0]).toBe(ids(second.text)![1]);
    expect(untag(second.text, second.table).text).toBe('Иван Петров ответил Андрею.');
  });
});

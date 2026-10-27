import { describe, it, expect } from 'vitest';
import { corpus } from './corpus';
import { replaceAll } from './all';
import { detect } from '../src/core/detect';
import { findDictionary } from '../src/core/dictionary';
import { collect } from '../src/core/mask';
import { loadDict, saveDict, type KV } from '../src/core/storage';
import type { Span } from '../src/core/types';
import { aggregate, type RawToken } from '../src/ner/aggregate';
import { chunk, ordinaryWords, vote } from '../src/ner/run';

const memStorage = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

describe('corpus: everything that must be offered is found, nothing else', () => {
  for (const c of corpus) {
    it(c.name, () => {
      const r = replaceAll(c.text, c.dict);
      if (c.noop) expect(r).toBe(c.text);
      for (const h of c.hide ?? []) expect(r, `not found: ${h}`).not.toContain(h);
      for (const k of c.keep ?? []) expect(r, `found by mistake: ${k}`).toContain(k);
      for (const p of c.has ?? []) expect(r).toContain(p);
      for (const p of c.notHas ?? []) expect(r).not.toContain(p);
      expect(replaceAll(r, c.dict), 'replacements are not found again').toBe(r);
    });
  }
});

describe('whole corpus as one long message', () => {
  const cases = corpus.filter((c) => !c.noop);
  const dict = corpus.flatMap((c) => c.dict ?? []);
  // deterministic shuffle so a failure is reproducible
  const shuffled = (seed: number) => {
    const a = [...cases];
    for (let i = a.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  it.each([1, 2, 3])('order %i: everything is still found', (seed) => {
    const list = shuffled(seed);
    const m = replaceAll(list.map((c) => c.text).join('\n\n'), dict);
    // a string found in one case may legitimately stay in another ("postgres" login vs `image: postgres:16`)
    const alone = list.map((c) => replaceAll(c.text, dict));
    for (const [i, c] of list.entries()) {
      for (const h of c.hide ?? []) {
        if (alone.some((t, j) => j !== i && t.includes(h))) continue;
        expect(m, `not found: ${h}`).not.toContain(h);
      }
    }
  });
});

describe('overlap resolution', () => {
  it('longest span wins; a dictionary hit inside an email does not leak the local part', () => {
    expect(replaceAll('m.sokolova@bigshop.ru', [{ term: 'BigShop', type: 'ORG' }])).toBe('[EMAIL_1]');
  });
  it('equal length: manual > dict > regex > ner', () => {
    expect(replaceAll('a@b.ru', [{ term: 'a@b.ru', type: 'ORG' }])).toBe('[ORG_1]');
  });
  it('spans never overlap', () => {
    const spans = collect('curl -u admin:pass http://u:p@10.0.0.1/x?token=abcdefgh1234 ivan@corp.ru', {});
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });
});

describe('dictionary', () => {
  const f = (text: string, term: string, type: 'PERSON' | 'ORG' = 'PERSON') => findDictionary(text, [{ term, type }]).map((s) => s.text);
  it('matches inflections but not other words', () => {
    expect(f('Иван, Ивана, Ивану, Иваном, Иване', 'Иван')).toEqual(['Иван', 'Ивана', 'Ивану', 'Иваном', 'Иване']);
    expect(f('Иванович Иванов Иванка', 'Иван')).toEqual([]);
  });
  it('multiword terms match with any whitespace and inflect every word', () => {
    expect(f('Ивану\nПетрову', 'Иван Петров')).toEqual(['Ивану\nПетрову']);
  });
  it('value is the canonical term, text is what was found', () => {
    const [s] = findDictionary('у Ивана', [{ term: 'Иван', type: 'PERSON' }]);
    expect([s.text, s.value, s.source]).toEqual(['Ивана', 'Иван', 'dict']);
  });
  it('ignores blank terms', () => {
    expect(findDictionary('abc', [{ term: '  ', type: 'ORG' }])).toEqual([]);
  });
  it('latin terms need exact word boundaries', () => {
    expect(f('Acme, acme.com, Acmeology, xacme', 'Acme', 'ORG')).toEqual(['Acme', 'acme']);
  });
});

describe('detect', () => {
  it('a closing paren after a phone is not part of it', () => {
    expect(replaceAll('клиент (+7 (903) 555-11-22) звонил')).toBe('клиент ([PHONE_1]) звонил');
  });
  const types = (t: string) => detect(t).map((s) => `${s.type}:${s.text}`);
  it('returns typed spans with correct offsets', () => {
    const t = 'мыло a@b.ru тут';
    const [s] = detect(t);
    expect([s.type, s.start, s.end, t.slice(s.start, s.end)]).toEqual(['EMAIL', 5, 11, 'a@b.ru']);
  });
  it('kv rule reports only the value', () => {
    expect(types('password: "hunter2"')).toEqual(['PASSWORD:hunter2']);
  });
  it("docker's -u uid:gid is not a login", () => {
    expect(types('docker run -u 1000:1000 -p 8080:80 nginx')).toEqual([]);
  });
  it('a card number is found by Luhn, 16 digits that fail it are not', () => {
    expect(types('4111 1111 1111 1111')).toEqual(['CARD:4111 1111 1111 1111']);
    expect(types('4111 1111 1111 1112')).toEqual([]);
  });
  it('a key=value inside the value of an ordinary word is still found', () => {
    expect(types('не свети их: DB_PASSWORD=Qwerty!2024secure')).toEqual(['PASSWORD:Qwerty!2024secure']);
  });
  it('a login in front of an ip (in front of a host the whole thing is an email anyway)', () => {
    expect(types('ssh deploy@10.12.4.21')).toEqual(['LOGIN:deploy', 'IP:10.12.4.21']);
    expect(types('noreply@localhost, a@b.ru')).toEqual(['EMAIL:a@b.ru']);
  });
  it('two-letter surnames only next to two initials', () => {
    expect(types('Е.В. Ли и Ли Е.В. пришли')).toEqual(['PERSON:Е.В. Ли', 'PERSON:Ли Е.В.']);
    expect(types('По А.Б. Иванову и На В.Г.')).toEqual(['PERSON:А.Б. Иванову']);
  });
});

describe('collect', () => {
  const ner = (text: string, w: string, type: Span['type'], from = 0): Span => {
    const start = text.indexOf(w, from);
    return { start, end: start + w.length, type, text: w, value: w, source: 'ner', prio: 10 };
  };
  it('a secret found once is hidden everywhere; a plain login like admin is not', () => {
    const text = 'DATABASE_URL=postgres://svc_auth:Old_Pa55w0rd@pg.corp/db\nfailed for user "svc_auth", admin вошёл, пароль Old_Pa55w0rd\ncurl -u admin:x1';
    const got = collect(text, {}).map((s) => s.text);
    expect(got.filter((t) => t === 'svc_auth')).toHaveLength(2);
    expect(got.filter((t) => t === 'Old_Pa55w0rd')).toHaveLength(2);
    expect(got.filter((t) => t === 'admin')).toHaveLength(1);
  });
  it('one word, one type: the model is outvoted by the majority and by the rules', () => {
    const text = 'ребята из Озона. С Озоном завтра. Озон молчит.';
    const spans = collect(text, { extra: [ner(text, 'Озона', 'LOC'), ner(text, 'Озоном', 'PERSON'), ner(text, 'Озон', 'LOC', 30)] });
    expect(spans.map((s) => `${s.type}:${s.text}`)).toEqual(['LOC:Озона', 'LOC:Озоном', 'LOC:Озон']);
  });
});

describe('storage', () => {
  it('tolerates corrupt storage', () => {
    const st = memStorage();
    st.setItem('obliviate:replace', '{oops');
    expect(loadDict(st)).toEqual([]);
  });
  it('round-trips the dictionary of replacements', () => {
    const st = memStorage();
    saveDict(st, [{ term: 'Сбербанк', type: 'ORG', replacement: 'Комбанк' }]);
    expect(loadDict(st)).toEqual([{ term: 'Сбербанк', type: 'ORG', replacement: 'Комбанк' }]);
  });
  it('v1 data: the old dictionary migrates, sessions with originals in plain text are deleted', () => {
    const st = memStorage();
    st.setItem('obliviate:dict', JSON.stringify([{ term: 'Иван Иванов', type: 'PERSON' }, { term: 'Ромашка', type: 'ORG' }]));
    st.setItem('obliviate:sessions', '[{"id":"x","entries":{}}]');
    st.setItem('obliviate:current', 'x');
    expect(loadDict(st)).toEqual([
      { term: 'Иван Иванов', type: 'PERSON', replacement: 'Иван И.' },
      { term: 'Ромашка', type: 'ORG', replacement: '' },
    ]);
    expect([...st.data.keys()]).toEqual(['obliviate:replace']);
  });
});

describe('performance', () => {
  it('handles ~300 KB of mixed text quickly', () => {
    const chunk = corpus.map((c) => c.text).join('\n');
    const big = chunk.repeat(Math.ceil(300_000 / chunk.length));
    const t0 = performance.now();
    replaceAll(big, [{ term: 'Иванов', type: 'PERSON' }]);
    expect(performance.now() - t0).toBeLessThan(4000);
  });
  it('no catastrophic backtracking on hostile input', () => {
    const t0 = performance.now();
    detect('+' + '1 '.repeat(20000) + '\n' + 'a'.repeat(50000) + '@' + '.a'.repeat(20000) + '\n' + '1:'.repeat(20000));
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('ner aggregate (synthetic tokens)', () => {
  const T = (s: string): RawToken[] =>
    s.split(' ').map((x) => {
      const [word, entity = 'O', score = '0.99'] = x.split('/');
      return { word, entity, score: Number(score) };
    });
  const got = (text: string, tokens: string) => aggregate(text, T(tokens)).map((s) => `${s.type}:${s.text}`);

  it('groups B-/I- tokens into one span with correct offsets', () => {
    const text = 'Привет, Иван Петров работает.';
    const [s] = aggregate(text, T('привет/O ,/O иван/B-PER петров/I-PER работает/O ./O'));
    expect([s.type, s.start, s.end, s.source]).toEqual(['PERSON', 8, 19, 'ner']);
  });
  it('glues wordpieces back into whole words', () => {
    expect(got('в Ромашке', 'в/O ро/B-LOC ##маш/I-LOC ##ке/I-LOC')).toEqual(['LOC:Ромашке']);
  });
  it('a new B- starts a new entity', () => {
    expect(got('Ромашка Лютик', 'ромашка/B-LOC лютик/B-LOC')).toEqual(['LOC:Ромашка', 'LOC:Лютик']);
  });
  it('is blind to case, ё/е and й/и differences between text and tokenizer', () => {
    expect(got('Фёдор Гайдай', 'федор/B-PER гаидаи/I-PER')).toEqual(['PERSON:Фёдор Гайдай']);
  });
  it('survives [UNK] and special tokens', () => {
    expect(got('🚀 Иван', '[CLS]/O [UNK]/O иван/B-PER [SEP]/O')).toEqual(['PERSON:Иван']);
  });
  it('drops latin spans in a russian line, keeps them in an english one', () => {
    expect(got('Java и TCP', 'java/B-LOC и/O tcp/B-LOC')).toEqual([]);
    expect(got('Пишу на Java для Acme Corp', 'пишу/O на/O java/B-LOC для/O acme/B-LOC corp/I-LOC')).toEqual([]);
    expect(got('Call with Sarah Connor from Acme Corp', 'call/O with/O sarah/B-PER connor/I-PER from/O acme/B-LOC corp/I-LOC')).toEqual(['PERSON:Sarah Connor', 'LOC:Acme']);
    expect(got('SELECT id FROM orders WHERE status', 'select/B-LOC id/I-LOC from/O orders/O where/B-LOC status/I-LOC')).toEqual([]);
    expect(got('WARN TomcatWebServer: Tomcat started on port', 'warn/B-LOC tomcat/B-LOC ##web/I-LOC ##server/I-LOC :/O tomcat/B-LOC started/I-LOC on/I-LOC port/I-LOC')).toEqual([]);
  });
  it('drops bare legal forms and trims quotes', () => {
    expect(got('ПАО «Ромашка»', 'пао/B-LOC «/I-LOC рома/B-LOC ##шка/I-LOC »/O')).toEqual(['LOC:Ромашка']);
  });
  it('trims lowercase words and greetings around a person', () => {
    expect(got('Уважаемый Алексей Викторович привет', 'уважаемыи/B-PER алексеи/I-PER викторович/I-PER привет/I-PER')).toEqual([
      'PERSON:Алексей Викторович',
    ]);
    expect(got('Здравствуйте!', 'здравствуите/B-PER !/I-PER')).toEqual([]);
    expect(got('Отто Шмидт', 'отто/B-PER шмидт/I-PER')).toEqual(['PERSON:Отто Шмидт']);
    expect(got('Доброслав', 'доброслав/B-PER')).toEqual(['PERSON:Доброслав']);
    expect(got('Напиши ей', 'на/B-PER/0.98 ##пи/B-PER/0.89 ##ши/I-PER/0.86 ей/O')).toEqual([]);
    expect(got('Решетников Иван', 'решетников/B-PER иван/I-PER')).toEqual(['PERSON:Решетников Иван']);
  });
  it('drops low-confidence groups', () => {
    expect(got('Напиши', 'на/B-PER/0.61 ##пи/I-PER/0.61')).toEqual([]);
  });
  it('never glues a speaker tag to the next word', () => {
    expect(got('[Роман] Коммитить', '[/O роман/B-PER ]/I-PER коммитить/I-PER')[0]).toBe('PERSON:Роман');
  });
  it('a capitalised sentence opener that the text also has in lowercase is an ordinary word', () => {
    const text = 'Угу. Ну да, ну. Олег, привет. [Роман] Ну и роман. Встретил Романа.';
    const at = (w: string, from = 0) => ({ start: text.indexOf(w, from), text: w }) as Span;
    const ordinary = ordinaryWords(text);
    expect(ordinary(at('Ну'))).toBe(true);
    expect(ordinary(at('Ну', 30))).toBe(true); // after "[Роман] "
    expect(ordinary(at('Угу'))).toBe(false); // no lowercase "угу" in the text
    expect(ordinary(at('Олег'))).toBe(false);
    expect(ordinary(at('Роман'))).toBe(false); // a speaker tag, not a sentence start
  });
  it('what the model found once is hidden everywhere, whole words only', () => {
    const text = 'Роман: привет. Тут Роман ушёл. Романтика!';
    const ner: Span = { start: 0, end: 5, type: 'PERSON', text: 'Роман', value: 'Роман', source: 'ner', prio: 10 };
    expect(collect(text, { extra: [ner] }).map((s) => s.start)).toEqual([0, 19]);
  });
  it('several models: a span stays when most of them found it', () => {
    const sp = (start: number, end: number): Span => ({ start, end, type: 'PERSON', text: '', value: '', source: 'ner', prio: 10 });
    const got = (perModel: Span[][]) => vote(perModel).map((s) => [s.start, s.end]);
    expect(got([[sp(0, 5)]])).toEqual([[0, 5]]); // one model trusts itself
    expect(got([[sp(0, 5), sp(10, 14)], [sp(0, 5)], [sp(20, 22)]])).toEqual([[0, 5]]); // 2 of 3, duplicates dropped
    expect(got([[sp(0, 12)], [sp(0, 5)], []])).toEqual([[0, 12], [0, 5]]); // overlapping is agreeing; resolve() keeps the longer
  });
  it('the score is the confidence times the share of models that agree', () => {
    const sp = (start: number, end: number, score: number): Span => ({ start, end, type: 'PERSON', text: 'Иван', value: '', source: 'ner', prio: 10, score });
    const got = vote([[sp(0, 4, 0.9)], [sp(0, 4, 0.8)], [sp(10, 14, 0.9)]], 'Иван ходил Иван').map((s) => [s.start, Number(s.score!.toFixed(2))]);
    expect(got).toEqual([[0, 0.6]]); // 2 of 3 agree (the same span from the 2nd model is a duplicate); found by one model only is dropped
  });
  it('one model is enough for a name someone is addressed by, and for a latin name', () => {
    const text = 'Катя: привет. Подожди. Лейле — алерт';
    const sp = (w: string): Span => ({ start: text.indexOf(w), end: text.indexOf(w) + w.length, type: 'PERSON', text: w, value: w, source: 'ner', prio: 10 });
    expect(vote([[sp('Катя'), sp('Подожди'), sp('Лейле')], [], []], text).map((s) => s.text)).toEqual(['Катя', 'Лейле']);
    const en = 'Call Sarah Connor today';
    expect(vote([[{ start: 5, end: 17, type: 'PERSON', text: 'Sarah Connor', value: 'Sarah Connor', source: 'ner', prio: 10 }], [], []], en)).toHaveLength(1); // only one model knows english
  });
  it('long runs of spaces do not throw the token cursor off', () => {
    const text = 'г. Екатеринбург' + ' '.repeat(40) + '«15» апреля, директор Лебедев';
    expect(got(text, 'г/O ./O екатеринбург/B-LOC «/O 15/O »/O апреля/O ,/O директор/O лебедев/B-PER')).toEqual(['LOC:Екатеринбург', 'PERSON:Лебедев']);
  });
  it('glues a surname to the first name, and parts around a hyphen', () => {
    expect(got('Кузнецова Валерия Игоревна', 'кузнецова/B-PER валерия/B-PER игоревна/I-PER')).toEqual(['PERSON:Кузнецова Валерия Игоревна']);
    expect(got('из Волга-Ресурс', 'из/O волга/B-LOC -/O ресурс/B-LOC')).toEqual(['LOC:Волга-Ресурс']);
    expect(got('в Комсомольске-на-Амуре', 'в/O комсомольске/B-LOC -/B-LOC на/B-LOC -/B-LOC амуре/B-LOC')).toEqual(['LOC:Комсомольске-на-Амуре']);
    expect(got('Ким, Ли', 'ким/B-PER ,/O ли/B-PER')).toEqual(['PERSON:Ким', 'PERSON:Ли']);
    expect(got('Олеговна (ИП', 'олеговна/B-PER (/I-PER ип/B-PER')).toEqual(['PERSON:Олеговна']);
    expect(got('группы ИВТ-21 Горбунов', 'группы/O ивт/B-LOC -/B-LOC 21/B-LOC горбунов/B-PER')).toEqual(['PERSON:Горбунов']);
    expect(got('юриста Волга-Ресурса', 'юриста/O волга/B-LOC/0.5 -/B-LOC/0.88 ресурс/B-LOC/0.97 ##а/I-LOC/0.9')).toEqual(['LOC:Волга-Ресурса']); // one weak part
  });
  it('never crosses a sentence end, a signature line or a slash; initials stay', () => {
    expect(got('Марина. Марин', 'марина/B-PER ./I-PER марин/I-PER')).toEqual(['PERSON:Марина', 'PERSON:Марин']);
    expect(got('Ю.С. Воронцов', 'ю/B-PER ./I-PER с/I-PER ./I-PER воронцов/I-PER')).toEqual(['PERSON:Ю.С. Воронцов']);
    expect(got('«Вектор» ____ Ю', '«/B-LOC вектор/I-LOC »/I-LOC _/I-LOC _/I-LOC _/I-LOC _/I-LOC ю/I-LOC')).toEqual(['LOC:Вектор']);
  });
  it('trims prepositions and conjunctions at the edges, in any case', () => {
    expect(got('С Озоном', 'с/B-PER озоном/I-PER')).toEqual(['PERSON:Озоном']);
    expect(got('Там Кирилл всё сделал', 'там/B-PER кирилл/I-PER все/O сделал/O')).toEqual(['PERSON:Кирилл']);
    expect(got('Северсталь и Ростех', 'северсталь/B-LOC и/I-LOC ростех/B-LOC')).toEqual(['LOC:Северсталь', 'LOC:Ростех']);
    expect(got('в Комсомольске на', 'в/O комсомольске/B-LOC на/B-LOC')).toEqual(['LOC:Комсомольске']);
  });
  it('does not look for organisations: what the model tags as one is a plain word', () => {
    expect(got('Звонил в МТС', 'звонил/O в/O мтс/B-ORG')).toEqual([]);
    expect(got('ПАО «Ромашка»', 'пао/B-ORG «/I-ORG рома/B-ORG ##шка/I-ORG »/O')).toEqual([]);
    expect(got('Работаю в Яндексе, жду Ивана', 'работаю/O в/O яндексе/B-ORG ,/O жду/O ивана/B-PER')).toEqual(['PERSON:Ивана']);
  });
  it('a heading in capitals is a place only when it is one; address abbreviations are not entities', () => {
    expect(got('ЧЕРЕПОВЕЦ, 12 марта', 'череповец/B-LOC ,/O 12/O марта/O')).toEqual(['LOC:ЧЕРЕПОВЕЦ']);
    expect(got('ул. Малышева, наб. реки Мойки', 'ул/B-LOC ./O малышева/B-LOC ,/O наб/B-LOC ./O реки/O мойки/B-LOC')).toEqual(['LOC:Малышева', 'LOC:Мойки']);
  });
  it('chunks long text on newlines without losing characters', () => {
    const text = ('строка с текстом '.repeat(20) + '\n').repeat(10);
    const parts = chunk(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    for (const p of parts) expect(text.startsWith(p.text, p.offset)).toBe(true);
  });
});

describe('numbers with a check digit', () => {
  const found = (text: string) => detect(text).filter((s) => s.type === 'CARD' || s.type === 'DOC').map((s) => s.text);
  it('finds cards, ИНН, СНИЛС, ОГРН by checksum and passports by context', () => {
    expect(found('оплата картой 5536913745628392')).toEqual(['5536913745628392']);
    expect(found('карта 4276 1234 5678 9014')).toEqual(['4276 1234 5678 9014']);
    expect(found('списалось с 5469234567890122')).toEqual(['5469234567890122']);
    expect(found('мой ИНН 771299779788')).toEqual(['771299779788']);
    expect(found('СНИЛС: 222-643-344 36')).toEqual(['222-643-344 36']);
    expect(found('ОГРН 5027739001230')).toEqual(['5027739001230']);
    expect(found('паспорт 4516728934')).toEqual(['4516728934']);
    expect(found('паспорт серия 77 14, номер 345678')).toEqual(['77 14', '345678']);
  });
  it('leaves ordinary numbers alone', () => {
    expect(found('заказ 5536913745628391 оформлен')).toEqual([]); // fails Luhn
    expect(found('тел. 8 916 123-45-67, сумма 1 234 567 890 руб.')).toEqual([]);
    expect(found('версия 2024-10-06, артикул 12345678901')).toEqual([]);
  });
});

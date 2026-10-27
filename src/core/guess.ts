import lex from './lexicon.json';
import { isName, isNameExact } from './names';
import { keyStem } from './replace';
import { AMBIGUOUS, FUNCTION_WORDS, STOP, isStop, norm } from '../ner/aggregate';
import { ordinaryWords } from '../ner/run';
import type { Span, Type } from './types';

// People and places without a model: a capitalised word that is not at the start of a sentence is a proper noun,
// and the OpenCorpora lexicon (scripts/build_lexicon.py) says what kind. At the start of a sentence only a word the lexicon or its shape vouches for counts.
// Companies are not looked for at all: there is no telling them from the rest of the capitalised words, and a wrong highlight costs more than a missed one.
// What the user marks by hand or puts into the dictionary is another matter, that is theirs.

const sets = { name: new Set(lex.name), surn: new Set(lex.surn), geo: new Set(lex.geo), en: new Set(lex.en) };
for (const g of ['федерац', 'российск']) sets.geo.add(g);

// "Мария Ивановна", "Иванович"; surname endings that no ordinary word has (Иванов, Петровой, Ковалёвым; not -ин: "машина")
const PATRONYMIC = /(?:ович|евич|ьич|овна|евна|ична)(?:а|у|ем|ом|е|ой)?$/iu;
const SHORT_PATRONYMIC = /^.{2,}ич(?:а|у|ем|ом|е)?$/u; // "Лукич", "Ильич": a patronymic, but "Кирпич" too, so only next to a first name
// in lowercase chat only the endings of a surname, not of the adjectives ("тестовых", "кодовом")
// a place word that may as well be a surname ("Покровской", "Белова"): it stays with the person next to it
const SURNAMELIKE = /(?:ск|цк)(?:ий|ой|ого|ому|им|ом|ая|ую)$|(?:ов|ев|ёв|ин|ын)(?:а|у|ым|ом|е)?$/iu;
const LOWER_SURNAME = /^.{3,}(?:ов|ев|ёв)(?:а|у)?$/iu; // not -ой: "торговой маркой"
const SURNAME_SHAPE = /^.{3,}(?:ов|ев|ёв)(?:а|у|ым|ом|е|ой|ых)?$|^.{3,}(?:енко|швили|дзе)$/iu;
const PLACE_ACRONYMS = new Set(['СССР', 'США', 'ЮАР', 'ОАЭ', 'РФ', 'СНГ', 'КНР', 'КНДР']);
// the calendar: months, weekdays, holidays (a capital in "Мае", "День Победы" is a headline's, not a name's)
const CALENDAR = /^(?:январ|феврал|март|апрел|ма[йеяю]|июн|июл|август|сентябр|октябр|ноябр|декабр|понедельник|вторник|сред[аыуе]|четверг|пятниц|суббот|воскресень|рождеств|пасх|маслениц|новый|нового|новым|день|дня|дне)/iu;
// God and the Church, a capital by reverence
const MORE_STOP = new Set('бог господь христос отечество родина герой'.split(' '));
// the stop words in every case: "Заказчик", "Заказчику", "Заказчика"
const STOP_STEMS = new Set([...STOP, ...MORE_STOP].map(keyStem));

const WORD = /(?<![\p{L}\p{N}-])(?:[А-ЯЁ][а-яё\u0301]+[А-ЯЁ][а-яёА-ЯЁ\u0301]*|[А-ЯЁ]{2,6}|[А-ЯЁ][а-яё\u0301]+(?:-[А-ЯЁ]?[а-яё\u0301]+)*)(?![\p{L}\p{N}\u0301])/gu;
// "]": a speaker's tag, "[Евгений С.] Вызываем…"; "=", "#": the headings of wiki and markdown
const BEFORE_SENTENCE = /(?:^|[.!?…:;\n•>—–\]=#])[\s"«“„'(\[*_=#-]*$/u;

/** `firm`: the word is vouched for by its own shape (a first name, a patronymic, -ов); the rest of the lexicon also holds ordinary words ("Агент", "Нажимаем") */
interface Word { start: number; end: number; text: string; type: Type | null; score: number; sentence: boolean; firm: boolean }

function classify(word: string): { type: Type | null; score: number; firm: boolean } {
  const w = word.replace(/\u0301/g, ''); // the stress mark of "Серге́й"
  const key = keyStem(w);
  // НАТО, МТС: an acronym is no name, even when a rare first name or a river spells it; of the acronyms only the places are of interest
  if (/^[А-ЯЁ]{2,6}$/u.test(w)) return { type: PLACE_ACRONYMS.has(w) ? 'LOC' : null, score: 0.8, firm: true };
  if (PATRONYMIC.test(w)) return { type: 'PERSON', score: 0.95, firm: true };
  // "Германия" and "Герман" stem alike: a place only in the endings a person's name does not have
  // "Китай", "Афин" are also rare names, "Германия" stems like "Герман"; but "Мария", "Орехов", "Иван" are no places
  const person = isName(w) || sets.name.has(key) || sets.surn.has(key);
  const surnameish = SURNAME_SHAPE.test(w) || /^.{3,}(?:ин|ын)(?:а|у|ым|ом|е)?$/u.test(w);
  if (sets.geo.has(key) && !isNameExact(w) && !surnameish && (!person || /(?:и[яюи]|ией)$/iu.test(w) || !isName(w))) return { type: 'LOC', score: 0.8, firm: false };
  const name = isName(w) || sets.name.has(key);
  // the lexicon's first names hold "История", "Метод", "Власта": at the start of a sentence only the plain first names count
  if (name || sets.surn.has(key)) return { type: 'PERSON', score: 0.85, firm: isName(w) || SURNAME_SHAPE.test(w) }; // a surname of the lexicon that also has the shape is no ordinary word
  if (SHORT_PATRONYMIC.test(w)) return { type: 'PERSON', score: 0.7, firm: false };
  if (SURNAME_SHAPE.test(w) || /^.{3,}(?:ин|ын)(?:а|у|ым|ом|е)?$/u.test(w)) return { type: 'PERSON', score: 0.7, firm: false }; // "Вызова", "Основа" look the same
  return { type: null, score: 0, firm: false };
}

/** "меня зовут анна смирнова", "у михаила соколова": chat written in lowercase — two or three neighbouring words that are a first name, a surname or a patronymic */
function lowercaseNames(text: string): Span[] {
  const kind = (w: string) => {
    const k = keyStem(w);
    return PATRONYMIC.test(w) ? 'P' : isName(w) ? 'N' : sets.surn.has(k) || LOWER_SURNAME.test(w) ? 'S' : '';
  };
  const out: Span[] = [];
  let run: Array<{ start: number; end: number; k: string }> = [];
  const flush = () => {
    // two different kinds at least: "анна смирнова", "дмитрий петрович иванов"; two first names are not a person
    if (run.length > 1 && new Set(run.map((w) => w.k)).size > 1) {
      const v = text.slice(run[0].start, run[run.length - 1].end);
      out.push({ start: run[0].start, end: run[0].start + v.length, type: 'PERSON', text: v, value: v, source: 'ner', prio: 10, score: 0.75 });
    }
    run = [];
  };
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_-])[а-яё]{3,}(?![\p{L}\p{N}_-])/gu)) {
    const k = kind(m[0]), prev = run[run.length - 1];
    if (prev && !/^[ \t]+$/.test(text.slice(prev.end, m.index!))) flush();
    if (k) run.push({ start: m.index!, end: m.index! + m[0].length, k });
    else flush();
  }
  flush();
  return out;
}

/** "Ivan" → "иван", "Yuriy" → "юрий": enough to look a latin spelling up among the russian names */
const cyr = (w: string) =>
  w.toLowerCase().replace(/shch/g, 'щ').replace(/sh/g, 'ш').replace(/ch/g, 'ч').replace(/zh/g, 'ж').replace(/kh/g, 'х').replace(/ts/g, 'ц')
    .replace(/yu|iu/g, 'ю').replace(/ya|ia/g, 'я').replace(/yo/g, 'ё').replace(/ye/g, 'е').replace(/x/g, 'кс')
    .replace(/[a-z]/g, (c) => 'абкдефгхийклмнопкрстувв_йз'[c.charCodeAt(0) - 97]);
/** "Konstantin Vlasov", "IVAN PETROV": two or three capitalised latin words, one of them a first name (English, or a russian one in latin letters) */
function latinNames(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_.-])[A-Z][A-Za-z'-]{2,}(?:[ \t]+[A-Z][A-Za-z'-]{2,}){1,2}(?![\p{L}\p{N}_-])/gu)) {
    if (m[0].split(/[ \t]+/).some((w) => sets.en.has(w.toLowerCase()) || sets.name.has(keyStem(cyr(w))))) {
      out.push({ start: m.index!, end: m.index! + m[0].length, type: 'PERSON', text: m[0], value: m[0], source: 'ner', prio: 10, score: 0.7 });
    }
  }
  return out;
}

const LOOKALIKE: Record<string, string> = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', Y: 'У' };
/** "Лёхa" with a latin "a" inside a russian word (speech-to-text, OCR): the same text, letter for letter, with the russian ones */
const unlook = (text: string) => text.replace(/\p{L}+/gu, (w) => (/[а-яё]/i.test(w) ? w.replace(/[aeopcxykABEKMHOPCTXY]/g, (c) => LOOKALIKE[c]) : w));

/** The same shape as the model's spans (source 'ner'), so the rest of the app does not care where they came from. */
export function guess(original: string): Span[] {
  const text = unlook(original);
  const seen = new Set<string>();
  return find(text)
    .sort((a, b) => a.start - b.start)
    .filter((s) => !seen.has(`${s.start}:${s.end}`) && !!seen.add(`${s.start}:${s.end}`)) // two rules may find the same word
    .map((s) => ({ ...s, text: original.slice(s.start, s.end), value: original.slice(s.start, s.end) }));
}

function find(text: string): Span[] {
  const words: Word[] = [];
  const midSentence = new Set<string>(); // capitalised somewhere inside a sentence: a proper noun, so also at the start of another
  // lines where every word is capitalised are headings ("Цели Проекта"): what the lexicon does not know there is not a name
  const heading = new Map<number, boolean>();
  const isHeading = (at: number) => {
    const from = text.lastIndexOf('\n', at - 1) + 1;
    let h = heading.get(from);
    if (h === undefined) {
      const line = text.slice(from, (text.indexOf('\n', at) + 1 || text.length + 1) - 1);
      const ws = line.match(/\p{L}{3,}/gu) ?? [];
      heading.set(from, (h = ws.length >= 2 && ws.every((x) => /^\p{Lu}/u.test(x)) || !/\p{Ll}/u.test(line)));
    }
    return h;
  };
  let weakEnd = -1; // end of the last ordinary word dropped from the line: the word right behind it is dropped with it ("Обзор Рынка")
  for (const m of text.matchAll(WORD)) {
    const at = m.index!, end = at + m[0].length;
    const before = text.slice(Math.max(0, at - 12), at);
    if (!/\p{Ll}/u.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, text.indexOf('\n', at) + 1 || text.length))) continue; // capitals only: a shout, not a name
    if (isStop(m[0]) || FUNCTION_WORDS.has(norm(m[0])) || STOP_STEMS.has(keyStem(m[0]))) continue;
    if (CALENDAR.test(m[0])) { weakEnd = end; continue; }
    let c = classify(m[0]);
    // a line of one word ("== История ==", "Метод") is a heading, unless it is a plain first name
    if (c.type && !/[^\s=#*_-]/.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at) + text.slice(end, (text.indexOf('\n', end) + 1 || text.length + 1) - 1)) && !isName(m[0]) && !PATRONYMIC.test(m[0])) c = { type: null, score: 0, firm: false };
    // a quoted title ("вебинар «Налоги для малого бизнеса»") starts like a sentence; a quoted brand ("«Пятёрочке»") does not
    const title = /[«"“„]$/.test(before) && /^[ \t]+\p{Ll}/u.test(text.slice(end, end + 3));
    const sentence = BEFORE_SENTENCE.test(before) || /(?:^|\s)[A-Z]{3,}[ \t]+$/.test(before) || title || (weakEnd >= 0 && /^[ \t]*$/.test(text.slice(weakEnd, at)));
    if (!c.type && (sentence || isHeading(at))) weakEnd = end;
    if (!sentence) midSentence.add(norm(m[0]));
    words.push({ start: at, end, text: m[0], sentence, ...c });
  }

  // at the start of a sentence only what vouches for itself counts: its own shape, or the same word capitalised in the middle of a sentence elsewhere
  const known = (w: Word) => (!!w.type && (!w.sentence || w.firm || midSentence.has(norm(w.text)))) || vouched.has(w);
  // at the start of a sentence two neighbours vouch for each other: "Ларри Маквой", "Лука Лукич", "Аммос Федорович"
  const adjacent = (a: Word, b: Word | undefined) => !!b && /^[ \t]+$/.test(text.slice(a.end, b.start));
  const nameLike = (w: Word) => isName(w.text) || sets.name.has(keyStem(w.text));
  const vouched = new Set<Word>();
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (!w.sentence || AMBIGUOUS.has(norm(w.text)) || !adjacent(w, next)) return;
    const pair = (w.type === 'PERSON' && (next!.type === 'PERSON' || (nameLike(w) && next!.type !== 'LOC')))
      || (!w.type && next!.type === 'PERSON' && next!.firm && PATRONYMIC.test(next!.text));
    if (pair) { vouched.add(w); if (next!.sentence) vouched.add(next!); }
  });
  const out: Span[] = [];
  const flush = (run: Word[]) => {
    if (!run.length) return;
    const strong = run.filter(known);
    const first = run[0];
    // a lone ambiguous word is a name only when someone is addressed: "Вера, привет"
    if (run.length === 1 && AMBIGUOUS.has(norm(first.text)) && !/^[ \t]*[,!]/.test(text.slice(first.end, first.end + 3))) return;
    const typed = strong.filter((w) => w.type);
    const people = typed.filter((w) => w.type === 'PERSON');
    // capitalised words that are neither a person nor a place ("Обзор Рынка", "Сибирские Дали", a company) are nothing; next to a person they are a part of the name
    const type: Type | null = people.length ? 'PERSON' : typed.length && typed.every((w) => w.type === 'LOC') ? 'LOC' : null;
    if (!type) return;
    const score = Math.min(...typed.map((w) => w.score));
    // "Председателя Правительства Российской Федерации": only the place is a place
    if (type === 'LOC' && strong.length < run.length) {
      for (const w of strong) out.push({ start: w.start, end: w.end, type, text: w.text, value: w.text, source: 'ner', prio: 10, score });
      return;
    }
    const v = text.slice(first.start, run[run.length - 1].end);
    out.push({ start: first.start, end: first.start + v.length, type, text: v, value: v, source: 'ner', prio: 10, score });
  };

  let run: Word[] = [];
  for (const w of words) {
    const prev = run[run.length - 1];
    // words of one entity sit on one line, separated by spaces; a sentence start with nothing known about it begins nothing
    const apart = !!prev?.type && !!w.type && (prev.type === 'LOC') !== (w.type === 'LOC') && (prev.type === 'PERSON' || w.type === 'PERSON') && !SURNAMELIKE.test(prev.type === 'LOC' ? prev.text : w.text); // "Белоруссии Светланы Тихановской"
    if (prev && (apart || !/^[ \t]+$/.test(text.slice(prev.end, w.start)) || run.length >= 4 || (w.sentence && !known(w)))) { flush(run); run = []; }
    if (w.sentence && !known(w) && !midSentence.has(norm(w.text))) continue;
    run.push(w);
  }
  flush(run);
  const ordinary = ordinaryWords(text);
  return [...out.filter((s) => !ordinary(s)), ...lowercaseNames(text), ...latinNames(text)];
}

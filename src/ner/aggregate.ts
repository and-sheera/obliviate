import type { Span, Type } from '../core/types';

/** one token as returned by transformers.js token-classification with `ignore_labels: []` */
export interface RawToken {
  entity: string; // 'O' | 'B-PER' | 'I-ORG' …
  score: number;
  word: string; // wordpiece, continuation pieces start with '##'
}

const CLASS: Record<string, Type> = { PER: 'PERSON', ORG: 'ORG', MEDIA: 'ORG', LOC: 'LOC', GEOPOLIT: 'LOC' };

/** groups scoring below this are noise */
export const MIN_SCORE = 0.7;
/** …but two or more capitalised cyrillic words tagged as a person are a name + surname even when the model hesitates */
const MIN_SCORE_FULL_NAME = 0.55;

const LEGAL_FORM = /^(?:ООО|ОАО|ЗАО|ПАО|АО|ИП|НКО|ФГУП|МУП|LLC|Ltd|Inc|GmbH|общество с ограниченной ответственностью|(?:публичное |закрытое |открытое )?акционерное общество|индивидуальный предприниматель)$/i;
/** capitalised words that open letters, chats and prompts and get tagged as names */
const OPENERS =
  'уважаем(?:ый|ая|ые|ого|ой|ому)|дорог(?:ой|ая|ие|ого|ому)|здравствуй(?:те)?|привет(?:ствую)?|добр(?:ый|ая|ое|ого)|' +
  'звонил[аи]?|звонит|спасибо|пожалуйста|господин|госпожа|коллеги?|от|кому|тема|помоги(?:те)?|' +
  // imperatives: "Напиши функцию…", "Объясните…" — whole words only, so "Решетников" survives
  '(?:напиш|объясн|расскаж|сдела|провер|отправ|подскаж|покаж|созда|состав|перепиш|перевед|исправ|найд|скаж|придума|сформулир|' +
  'опиш|прив[её]д|продолж|улучш|оптимизир|добав|удал|реш|посчита|вычисл|сравн|проанализир|суммир|подготов|сгенерир|выведи|запиш|измени|верни|' +
  'скин|позвон|напомн|глян|переда|спрос|напиш|оцен)' +
  '(?:и|ите|ь|ьте|й|йте)';
const NOT_NAMES = new RegExp(`^(?:${OPENERS})$`, 'iu');
const SPECIAL = /^\[(?:CLS|SEP|PAD|MASK)\]$/;

/** capitalised ordinary words the model takes for names or companies: roles, form labels, family, acronyms */
const STOP = new Set(
  (
    // family
    'мама мамы маме маму папа папы папе папу бабушка дедушка сын дочь брат сестра тетя дядя муж жена ' +
    // roles
    'истец истица ответчик заказчик исполнитель подрядчик поставщик покупатель продавец клиент курьер провайдер техподдержка ' +
    'поддержка бухгалтерия бухгалтер юрист директор менеджер бот пользователь оператор админ администратор сотрудник кандидат ' +
    'студент учитель пациент пациентка арендатор арендодатель врач водитель коллеги коллега ' +
    // form and letter labels
    'тел моб факс фио лид контакт организация тема кому от копия адрес телефон почта дата должность отправлено получатель ' +
    'отправитель суть итоги протокол приказ заявление заявка обращение отзыв подпись согласовано утверждаю важно внимание ' +
    // address abbreviations
    'ул пр пер наб просп ш бул пл д кв корп стр обл пос мкр ' +
    // common nouns
    'банк фонд тендер токен логин пароль ключ секрет компания фирма договор счет отчет проект команда отдел офис онлайн ок окей ' +
    'сервис приложение группа витамин ' +
    // english legal forms
    'llc inc ltd corp co gmbh plc ' +
    // acronyms that are not companies
    'ндс инн кпп усн осно енвд ндфл тз кп лпр огрн огрнип бик кбк снилс оквэд гост снип жкх рф вуз ип ооо пао ао зао оао нко гк ' +
    'тк ук коап апк гпк hr pr it егэ огэ дтп пк по ос ии чп то'
  ).split(' '),
);
const norm = (w: string) => w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}]/gu, '');
const isStop = (w: string) => STOP.has(norm(w)) || NOT_NAMES.test(norm(w));

/** words that are names only next to a patronymic/surname or in an address: "Вера Павловна", "Слава, привет" — not "Вера в себя" */
const AMBIGUOUS = new Set('вера надежда любовь лев роза слава мир победа звезда правда заря радость сила воля жизнь весна мила лада'.split(' '));

/** 1 UTF-16 unit → 1 unit, so offsets stay valid: lowercase, й→и, ё→е */
function fold(s: string): string {
  let o = '';
  for (let i = 0; i < s.length; i++) o += s[i].normalize('NFD')[0].toLowerCase()[0];
  return o;
}

interface Word { start: number; end: number; cls: string | null; begin: boolean; score: number }

/** walk the tokens over the text and give each word its character range */
function alignWords(text: string, tokens: RawToken[]): Word[] {
  const hay = fold(text);
  const words: Word[] = [];
  let cursor = 0;
  let prevEnd = -1;
  for (const t of tokens) {
    if (SPECIAL.test(t.word)) continue;
    const piece = t.word.startsWith('##');
    const needle = fold(piece ? t.word.slice(2) : t.word);
    if (!needle || t.word === '[UNK]') continue;
    while (/\s/.test(hay[cursor] ?? '')) cursor++; // the tokenizer drops whitespace: 30 spaces of a right-aligned date must not throw the cursor off
    const at = hay.indexOf(needle, cursor);
    if (at < 0 || at - cursor > 20) continue; // unknown char or a wrong far match: skip, keep the cursor
    cursor = at + needle.length;
    if (piece && words.length && at === prevEnd) {
      words[words.length - 1].end = cursor; // same word, the first piece decides the label
    } else {
      // 'B-PER' / 'I-PER', or plain 'PER' in models tagged without B-/I-
      const [p, cls] = t.entity === 'O' ? ['O', null] : t.entity.includes('-') ? t.entity.split(/-(.+)/) : ['I', t.entity];
      words.push({ start: at, end: cursor, cls: cls ? (CLASS[cls] ? cls : null) : null, begin: p === 'B', score: t.score });
    }
    prevEnd = cursor;
  }
  return words;
}

const isLower = (w: string) => w[0] === w[0].toLowerCase() && w[0] !== w[0].toUpperCase();
/** words the model glues to an entity: prepositions ("С Озоном", "Про Тимофея", "Северсталь и") and what opens a spoken cue ("Там Кирилл", "Вот Лёха") */
const FUNCTION_WORDS = new Set(
  ('и в во с со на по про о об обо у к ко от до из за для при без а но или ' +
    'там тут здесь вот вон ну да нет так это ещё уже потом тогда сейчас кстати короче слушай значит просто даже тоже только вообще ' +
    // not «ли»: Ли is a surname
    'конечно наверное я ты он она оно мы вы они его ее их ему ей им кто что где когда как если чтобы поэтому хотя ведь же бы').split(' '),
);

/** trim quotes and service words around the entity, then decide whether anything name-like is left */
function tidy(text: string, s: number, e: number, type: Type): [number, number] | null {
  while (s < e && !/[\p{L}\p{N}]/u.test(text[s])) s++;
  while (e > s && !/[\p{L}\p{N}]/u.test(text[e - 1])) e--;
  const ws = [...text.slice(s, e).matchAll(/\S+/g)].map((m) => [s + m.index!, s + m.index! + m[0].length, m[0]] as const);
  // names are capitalised; lowercase edges like "… Козловой привет" are not part of them (companies may be: "Газпром нефти")
  const edge = (w: string) => isStop(w) || FUNCTION_WORDS.has(norm(w)) || (type === 'PERSON' && isLower(w));
  let a = 0, b = ws.length;
  while (a < b && edge(ws[a][2])) a++;
  while (b > a && edge(ws[b - 1][2])) b--;
  if (a === b) return null;
  s = ws[a][0]; e = ws[b - 1][1];
  while (s < e && !/[\p{L}\p{N}]/u.test(text[s])) s++; // «Волга-Ресурс»
  while (e > s && !/[\p{L}\p{N}]/u.test(text[e - 1])) e--;

  const v = text.slice(s, e);
  // latin in a russian line is code, SQL, Java, TCP; in an english line a name is Title Case ("Sarah Connor", not "SELECT id", "TomcatWebServer")
  if (v.length < 2 || LEGAL_FORM.test(v)) return null;
  if (!/[\u0400-\u04FF]/.test(v) && !(english(lineAt(text, s)) && v.split(/\s+/).every((w) => /^[A-Z][a-z]+(?:-[A-Z][a-z]+)*$/.test(w)))) return null;
  if (v.includes('№') || /^-\d/.test(text.slice(e)) || /-\d+$/.test(v)) return null; // "Договор № 17", "ИВТ-21"
  if (type === 'ORG' && !/\p{Lu}/u.test(v)) return null; // "страхового возмещения"
  // a heading in capitals ("ХАРАКТЕРИСТИКА", "РЕКВИЗИТЫ И ПОДПИСИ СТОРОН") is not a company; short acronyms (МТС) and "ООО «X»" (rules) are safe
  if (type === 'ORG' && v.replace(/[^\p{L}]/gu, '').length >= 6 && !/\p{Ll}/u.test(lineAt(text, s))) return null;
  if (b - a === 1 && AMBIGUOUS.has(norm(v)) && !/^[ \t]*[,!]/.test(text.slice(e))) return null;
  return [s, e];
}

/** english prose: mostly latin, with ordinary lowercase words ("with", "from") — not "Java и TCP" */
const english = (line: string) =>
  (line.match(/[A-Za-z]/g)?.length ?? 0) > 2 * (line.match(/[\u0400-\u04FF]/g)?.length ?? 0) && (line.match(/(?<![\w.])[a-z]{2,}\b/g)?.length ?? 0) >= 2;
const lineAt = (text: string, i: number) => text.slice(text.lastIndexOf('\n', i - 1) + 1, (text.indexOf('\n', i) + 1 || text.length + 1) - 1);

/**
 * An entity never spans lines, speaker tags, labels, signature lines and sentences:
 * "Лаптев Никита⏎Копия: …", "[Роман] Ну", "«ДатаВектор» ____ / Ю.С.", "Марина. Марин" — but "Ю.С. Воронцов" and "г. Москва" stay whole.
 */
function breaks(text: string, cur: { start: number; end: number }, w: Word): boolean {
  if (/[\n[\]:_/@|]/.test(text.slice(cur.end, w.end))) return true;
  const upto = text.slice(cur.start, w.start);
  return /[.!?…]["»”)]*\s+$/u.test(upto) && !/(?:^|[^\p{L}])\p{L}\.\s+$/u.test(upto);
}

/**
 * The model starts a new entity where there is none: "Кузнецова | Валерия Игоревна" (a first name after a surname),
 * "Волга | Ресурс", "Санкт | Петербург", "Комсомольске | на | Амуре" (after a hyphen). Glue them back.
 */
function glue(text: string, spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const b of spans) {
    const a = out[out.length - 1], gap = a ? text.slice(a.end, b.start) : '';
    if (a && a.type === b.type && (/^-(?:\p{Ll}{1,3}-)?$/u.test(gap) || (a.type === 'PERSON' && /^[ \t]+$/.test(gap)))) {
      a.end = b.end;
      a.text = a.value = text.slice(a.start, a.end);
      a.score = Math.min(a.score ?? 1, b.score ?? 1);
    } else out.push({ ...b });
  }
  return out;
}

export function aggregate(text: string, tokens: RawToken[], minScore = MIN_SCORE): Span[] {
  const out: Span[] = [];
  let cur: { cls: string; start: number; end: number; scores: number[] } | null = null;
  const flush = () => {
    const fullName = cur?.cls === 'PER' && (text.slice(cur.start, cur.end).match(/(?:^|\s)[А-ЯЁ][а-яё]+/g)?.length ?? 0) >= 2;
    if (cur && cur.scores.reduce((a, b) => a + b, 0) / cur.scores.length >= (fullName ? Math.min(minScore, MIN_SCORE_FULL_NAME) : minScore)) {
      // "г. Новосибирск" is a city whatever the model says
      const type = /(?:^|[^\p{L}])(?:г\.|город\p{L}*)[ \t]*$/iu.test(text.slice(Math.max(0, cur.start - 10), cur.start)) ? 'LOC' : CLASS[cur.cls];
      const r = tidy(text, cur.start, cur.end, type);
      if (r) {
        const v = text.slice(r[0], r[1]);
        out.push({ start: r[0], end: r[1], type, text: v, value: v, source: 'ner', prio: 10, score: cur.scores.reduce((a, b) => a + b, 0) / cur.scores.length });
      }
    }
    cur = null;
  };
  for (const w of alignWords(text, tokens)) {
    if (!w.cls) { flush(); continue; }
    // a B- joined to the entity by a hyphen is the same word: "Волга|-|Ресурса", "Санкт|-|Петербург"
    const hyphen = !!cur && w.start === cur.end && (text[w.start] === '-' || text[cur.end - 1] === '-');
    if (!cur || (w.begin && !hyphen) || cur.cls !== w.cls || breaks(text, cur, w)) {
      flush();
      cur = { cls: w.cls, start: w.start, end: w.end, scores: [w.score] };
    } else {
      cur.end = w.end;
      cur.scores.push(w.score);
    }
  }
  flush();
  return glue(text, out);
}

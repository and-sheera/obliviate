import type { Span, Type } from './types';

const P_SPECIFIC = 60; // provider-shaped keys, credentials in context
const P_GENERIC = 50; // email / phone / ip …

const PLACEHOLDER = /^\[?[A-Z][A-Z_]*_\d+\]?$/;

type Ok = (value: string, start: number, text: string) => boolean;
interface Rule {
  re: RegExp;
  type: Type;
  prio: number;
  group?: number;
  ok?: Ok;
}

const mk = (start: number, end: number, type: Type, text: string, prio: number): Span => ({
  start, end, type, text, value: text, source: 'regex', prio,
});

function run(text: string, rules: Rule[], out: Span[]): void {
  for (const r of rules) {
    for (const m of text.matchAll(r.re)) {
      const idx = m.indices?.[r.group ?? 0];
      if (!idx) continue;
      const [s, e] = idx;
      const v = text.slice(s, e);
      if (r.ok && !r.ok(v, s, text)) continue;
      out.push(mk(s, e, r.type, v, r.prio));
    }
  }
}

// ───────────── sanity filters ─────────────

const digits = (v: string) => v.replace(/\D/g, '').length;

const okEmail: Ok = (v) => {
  const dom = v.slice(v.lastIndexOf('@') + 1).toLowerCase();
  if (/(^|\.)example\.(com|org|net|edu)$/.test(dom)) return false;
  if (/\.(example|test|invalid|localhost)$/.test(dom)) return false;
  // "icon@2x.png"
  return !/\.(png|jpe?g|gif|svg|webp|bmp|ico|css|m?js|tsx?|json|html?|md|txt)$/.test(dom);
};

const NOT_IPS = new Set(['0.0.0.0', '255.255.255.255', '8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9']);
const okIPv4: Ok = (v, start, text) => {
  const o = v.split('.').map(Number);
  if (o[0] === 127 || NOT_IPS.has(v)) return false;
  if (o.every((n) => n < 10)) return false; // 1.2.3.4 — almost surely a version
  // "v1.2.3.40", "версия 10.2.3.4", "пункт 3.2.1.15", "раздел 12.3.4.5"
  return !/(?:\bv|version|ver\.?|верси\p{L}*|пункт\p{L}*|подпункт\p{L}*|пп?\.|раздел\p{L}*|разд\.|глав\p{L}*|гл\.|стать\p{L}*|ст\.|част\p{L}*|ч\.|§)[ \t]*$/iu.test(
    text.slice(Math.max(0, start - 14), start),
  );
};

const okIPv6: Ok = (v) => /\d/.test(v); // "Cafe::Add" is not an address

const okPhone: Ok = (v) => {
  const n = digits(v);
  return n >= 10 && n <= 15;
};

const okTelegram: Ok = (v, start, text) => {
  if (/[_\d]/.test(v)) return true;
  const line = text.slice(text.lastIndexOf('\n', start) + 1, start);
  return /(?:telegram|телеграм\p{L}*|тг|tg)[^\n]{0,30}$/iu.test(line);
};

const okBearer: Ok = (v) => /[\d.]/.test(v) && !PLACEHOLDER.test(v);

const okNotPlaceholder: Ok = (v) => !PLACEHOLDER.test(v);

// ───────────── rules ─────────────

const K = P_SPECIFIC;
const G = P_GENERIC;

const KEYS: Rule[] = [
  { re: /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}(?![A-Za-z0-9])/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gd, type: 'API_KEY', prio: K },
  { re: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/gd, type: 'API_KEY', prio: K },
  { re: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/gd, type: 'API_KEY', prio: K }, // telegram bot
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/gd, type: 'TOKEN', prio: K },
  { re: /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{16,})/gid, type: 'TOKEN', prio: K, group: 1, ok: okBearer },
  { re: /Authorization["']?[ \t]*[:=][ \t]*["']?Basic[ \t]+([A-Za-z0-9+/]{8,}={0,2})/gid, type: 'TOKEN', prio: K, group: 1 },
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?![\s\S]))/gd,
    type: 'PRIVATE_KEY', prio: K,
  },
  // sql
  { re: /\b(?:IDENTIFIED[ \t]+BY|PASSWORD)[ \t]+'([^'\n]+)'/gid, type: 'PASSWORD', prio: K, group: 1, ok: okNotPlaceholder },
];

const CONTACTS: Rule[] = [
  {
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/gd,
    type: 'EMAIL', prio: G, ok: okEmail,
  },
  // +country code, up to 4 groups
  { re: /(?<![\w+])\+\d{1,3}(?:[  .-]?(?:\(\d{2,4}\)|\d{2,4})){2,4}(?!\d)/gd, type: 'PHONE', prio: G, ok: okPhone },
  // 8 916 123-45-67, 89161234567
  { re: /(?<![\w+])[78][ ()-]*\d{3}[ ()-]*\d{3}[ -]*\d{2}[ -]*\d{2}(?!\d)/gd, type: 'PHONE', prio: G, ok: okPhone },
  // (495) 123-45-67
  { re: /(?<!\w)\(\d{3,5}\)[ ]?\d{2,3}[ -]\d{2}[ -]\d{2}(?!\d)/gd, type: 'PHONE', prio: G },
  { re: /(?<![A-Za-z0-9_])t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/gd, type: 'TELEGRAM', prio: G, group: 1 },
  {
    re: /(?<![\p{L}\p{N}_@.\/-])@([A-Za-z][A-Za-z0-9_]{4,31})(?![\p{L}\p{N}_\/(-]|\.[\p{L}\p{N}])/gdu,
    type: 'TELEGRAM', prio: G, group: 1, ok: okTelegram,
  },
];

const H = '[0-9A-Fa-f]{1,4}';
const NETWORK: Rule[] = [
  {
    re: /(?<!\w)(?<!\d\.)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/gd,
    type: 'IP', prio: G, ok: okIPv4,
  },
  { re: new RegExp(`(?<![\\w:])(?:${H}:){7}${H}(?![\\w:])`, 'gd'), type: 'IP', prio: G, ok: okIPv6 },
  { re: new RegExp(`(?<![\\w:])(?:${H}:){1,6}(?::${H}){1,6}(?![\\w:])`, 'gd'), type: 'IP', prio: G, ok: okIPv6 },
  { re: new RegExp(`(?<![\\w:])(?:${H}:){1,7}:(?![\\w:])`, 'gd'), type: 'IP', prio: G, ok: okIPv6 },
  { re: new RegExp(`(?<![\\w:])::(?:${H}:){1,5}${H}(?![\\w:])`, 'gd'), type: 'IP', prio: G, ok: okIPv6 },
  { re: /(?<![\w:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![\w:-])/gd, type: 'MAC', prio: G + 5 },
  {
    re: /(?<![\p{L}\p{N}_.\-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:local|internal|corp|lan|intra|intranet|home|private|localdomain)(?![\p{L}\p{N}_-]|\.\p{L})/gdiu,
    type: 'HOST', prio: G,
  },
  // ssh deploy@10.12.4.21, admin@build.corp: a login in front of an address (an email needs a real domain; noreply@localhost is a placeholder)
  {
    re: /(?<![\w.%+@-])([A-Za-z_][\w.-]{0,31})@(?=(?:\d{1,3}\.){3}\d{1,3}(?![\d.])|(?:[a-z0-9-]+\.)+(?:local|internal|corp|lan|intra|intranet|home|private|localdomain)\b)/gdi,
    type: 'LOGIN', prio: G, group: 1,
  },
];

// ───────────── names by form (no model, no dictionary) ─────────────

const LEGAL = 'ООО|ОАО|ЗАО|ПАО|АО|НКО';
const CAP = '[А-ЯЁA-Z][\\p{L}\\p{N}-]+';
const SURNAME = '[А-ЯЁ][а-яё]{2,}(?:-[А-ЯЁ][а-яё]+)?';
const OPEN_Q = '[«"“„]';
const QUOTED = '([^»"”“\\n]{2,60})[»"”]';

// Words that open "компании X" or "X А." without being a name
const ROLES = /^(?:заказчик|исполнител|подрядчик|субподрядчик|поставщик|покупател|продав|арендатор|арендодател|клиент|сторон|агент|принципал|лицензиар|лицензиат|работодател|работник|оператор|пользовател|участник)/i;
const okCompany: Ok = (v) => !PLACEHOLDER.test(v) && !ROLES.test(v);

// "Приложение А.", "Вариант В.", "Витамин С.", "Корпус Б." — a noun + letter, not a surname + initial.
// The noun may take a short ending, but not a surname suffix: "Шаг А." is not a name, "Шагов А." is.
const NOT_SURNAMES = new RegExp(
  '^(?:' +
    'приложени|вариант|витамин|корпус|групп|раздел|пункт|подпункт|глав|част|таблиц|рисун|схем|литер|строени|класс|тип|уровен|' +
    'категори|сери|модел|блок|подъезд|секци|форм|план|этап|шаг|стать|том|книг|ответ|вопрос|задач|пример|лист|отдел|сектор|зон|' +
    'этаж|квартир|дом|офис|комнат|кабинет|параграф|абзац|гепатит|сорт|позици|вход|выход|колонк|строк|столб|ряд|ячейк|режим|' +
    'склад|цех|участ|лини|маршрут|поток|курс|семестр|урок|модул|тариф|пакет|образ|приказ|протокол|акт|счёт|счет|договор' +
    ')(?!ов|ев|ёв|ин|ын)[а-яё]{0,2}$',
  'i',
);
const okSurname: Ok = (v) => !NOT_SURNAMES.test(v.split(/\s/)[0]);

const NAMES: Rule[] = [
  // ООО «Ромашка», АО "Северсталь"
  { re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${LEGAL})[ \\t]*${OPEN_Q}${QUOTED}`, 'gdu'), type: 'ORG', prio: K, group: 1, ok: okNotPlaceholder },
  // ПАО Сбербанк
  { re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${LEGAL})[ \\t]+(${CAP})`, 'gdu'), type: 'ORG', prio: K, group: 1, ok: okCompany },
  // компания «Альфа Логистик», фирмой «Стройком», ГК «Самолёт», банк «Открытие», фонд «Подари жизнь»
  {
    re: new RegExp(
      `(?<![\\p{L}\\p{N}])(?:[кК]омпани\\p{L}*|[фФ]ирм\\p{L}*|[оО]рганизаци\\p{L}*|[кК]орпораци\\p{L}*|ГК|[гГ]рупп\\p{L}*[ \\t]+компаний|` +
        `[хХ]олдинг\\p{L}*|[фФ]онд\\p{L}*|[бБ]анк\\p{L}*|[аА]гентств\\p{L}*|[сС]туди\\p{L}*)[ \\t]*${OPEN_Q}${QUOTED}`,
      'gdu',
    ),
    type: 'ORG', prio: K, group: 1, ok: okNotPlaceholder,
  },
  // компании Ланит, Компания Яндекс, фирмой Вектор, в организации Сибирские Дали
  {
    re: new RegExp(
      `(?<![\\p{L}\\p{N}])(?:[кК]омпани(?:я|и|ю|ей)|[фФ]ирм(?:а|ы|у|ой|е)|[оО]рганизаци(?:я|и|ю|ей)|[кК]орпораци(?:я|и|ю|ей))[ \\t]+(${CAP}(?:[ \\t]+[А-ЯЁ][\\p{L}-]+)?)`,
      'gdu',
    ),
    type: 'ORG', prio: K, group: 1, ok: okCompany,
  },
  // ИП Сидоров, ИП Семенова Ольга Викторовна
  { re: new RegExp(`(?<![\\p{L}\\p{N}])ИП[ \\t]+(${SURNAME}(?:[ \\t]+[А-ЯЁ][а-яё]+){0,2})`, 'gdu'), type: 'PERSON', prio: K, group: 1 },
  // Иванов И.И., Петровой А. С.  (the space after the last initial is not part of the name)
  { re: new RegExp(`(?<![\\p{L}\\p{N}])${SURNAME}[ \\t]+[А-ЯЁ]\\.(?:[ \\t]?[А-ЯЁ]\\.)?`, 'gdu'), type: 'PERSON', prio: K, ok: okSurname },
  // И.И. Иванов
  { re: new RegExp(`(?<![\\p{L}\\p{N}])[А-ЯЁ]\\.[ \\t]?[А-ЯЁ]\\.[ \\t]?${SURNAME}`, 'gdu'), type: 'PERSON', prio: K },
  // two-letter surnames only with two initials: Е.В. Ли, Ли Е.В. (not "По А.Б.", "На В.Г.")
  { re: /(?<![\p{L}\p{N}])[А-ЯЁ]\.[ \t]?[А-ЯЁ]\.[ \t]?[А-ЯЁ][а-яё](?![\p{L}\p{N}])/gdu, type: 'PERSON', prio: K },
  { re: /(?<![\p{L}\p{N}])(?!(?:По|На|За|Из|От|До|Со|Ко|Во|Об|Не|Ни|Но|Да|Же|То|Уж|Он|Мы|Вы|Их|Ее|Её|Ей|Ах|Ох)[ \t])[А-ЯЁ][а-яё][ \t]+[А-ЯЁ]\.[ \t]?[А-ЯЁ]\./gdu, type: 'PERSON', prio: K },
];

// ───────────── credentials by context ─────────────

const STOP_VALUES = new Set(
  ('true false null nil none undefined string str int integer number bool boolean required optional empty yes no on off ' +
    'todo tbd object array any void value env ' +
    // prose in docs: "Пароль: не менее 8 символов", "Логин: не указан"
    'не нет да любой любая любое пустой пусто обязателен обязательно').split(' '),
);

function okValue(v: string, type: Type): boolean {
  if (!v || PLACEHOLDER.test(v)) return false;
  if (/^[*•x.#_-]+$/i.test(v)) return false;
  if (/^[$<%{[]/.test(v)) return false;
  if (/^(?:process|os|env|System|Environment|secrets?|config|settings|self|this|ctx|vault)\./i.test(v)) return false;
  if (v.includes('(')) return false;
  if (STOP_VALUES.has(v.toLowerCase())) return false;
  // "Ключ: регулярность", "Токен: единица текста" — a plain russian word is prose, not a secret
  if (type === 'SECRET' || type === 'API_KEY') return v.length >= 6 && !/^[\u0400-\u04FF]+$/.test(v);
  if (type === 'LOGIN') return v.length >= 2 && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v);
  return true;
}

const STOP_LAST = new Set(
  ('length len min max field type policy required hint label placeholder file path url env name id expires expiry ttl ' +
    'endpoint header prefix regex pattern rules rule strength count version enabled disabled').split(' '),
);
const PASS_TOKEN = /^(?:pass|passwd|password|passphrase|pwd|парол\p{L}*)$/u;
const LOGIN_LAST = new Set(['login', 'username', 'user', 'usr', 'uname', 'логин', 'юзер']);

const classified = new Map<string, Type | null>();
function classify(key: string): Type | null {
  let t = classified.get(key);
  if (t === undefined) classified.set(key, (t = computeType(key)));
  return t;
}
function computeType(key: string): Type | null {
  const tok = key
    .replace(/(\p{Ll}|\d)(\p{Lu})/gu, '$1_$2')
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  if (!tok.length) return null;
  const last = tok[tok.length - 1];
  if (tok.length > 1 && last === 'name' && tok[tok.length - 2] === 'user') return 'LOGIN';
  if (STOP_LAST.has(last)) return null;
  const adj = (a: string, b: string) => tok.some((x, i) => x === a && tok[i + 1] === b);
  if (tok.some((x) => PASS_TOKEN.test(x))) return 'PASSWORD';
  if (tok.includes('apikey') || adj('api', 'key') || adj('access', 'key')) return 'API_KEY';
  if (
    tok.some((x) => ['secret', 'token', 'credential', 'credentials', 'токен', 'секрет', 'ключ'].includes(x)) ||
    adj('private', 'key') || adj('auth', 'key')
  ) return 'SECRET';
  return LOGIN_LAST.has(last) ? 'LOGIN' : null;
}

const KV = /(?<![\p{L}\p{N}_.\-])([\p{L}\p{N}_.\-]+)(["']?[ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;&"'}]+)/gdu;
const KEY_FIRST = /^[\p{L}\p{N}_.\-]+["']?[ \t]*[:=]/u;

function kv(text: string, out: Span[], base = -1): void {
  for (const m of text.matchAll(KV)) {
    const type = classify(m[1]);
    // "не свети их: DB_PASSWORD=…": the value of an ordinary word is itself a key=value (one level deep, "1:1:1:…" must not recurse)
    if (!type) { if (base < 0 && KEY_FIRST.test(m[3])) kv(m[3], out, m.indices![3]![0]); continue; }
    let [s, e] = m.indices![3]!;
    s += Math.max(base, 0); e += Math.max(base, 0);
    let v = m[3];
    if (PLACEHOLDER.test(v)) continue;
    if (v[0] === '"' || v[0] === "'") {
      s++; e--; v = v.slice(1, -1);
    } else {
      const t = v.replace(/[.)\]]+$/, '');
      e -= v.length - t.length; v = t;
    }
    // "User: Привет! Как дела?" is a chat transcript, not a login
    if (type === 'LOGIN' && /^(?:user|usr)$/i.test(m[1]) && /[\u0400-\u04FF]/.test(v)) continue;
    if (okValue(v, type)) out.push(mk(s, e, type, v, K));
  }
}

// «пароль от админки: "…"», «пароль от wifi — …»
const NATURAL =
  /(?<![\p{L}\p{N}_])(парол[ьяюеи]|password|passwd|pwd|pass|логин|login|username|user[ \t]?name)(?:[ \t]+(?:от|для|к|to|for|of)[ \t]+[^\s:=,;]+)?[ \t]*([:=]|—|–|-)[ \t]*("[^"\n]*"|'[^'\n]*'|«[^»\n]*»|[^\s,;&"'}]+)/giud;

function natural(text: string, out: Span[]): void {
  for (const m of text.matchAll(NATURAL)) {
    const type: Type = /парол|pass|pwd/i.test(m[1]) ? 'PASSWORD' : 'LOGIN';
    let [s, e] = m.indices![3]!;
    let v = m[3];
    if (PLACEHOLDER.test(v)) continue;
    if (/^["'«]/.test(v)) {
      s++; e--; v = v.slice(1, -1);
    } else {
      const t = v.replace(/[.)\]]+$/, '');
      e -= v.length - t.length; v = t;
    }
    // a dash is also prose punctuation: "пароль — это набор символов"
    if (m[2] !== ':' && m[2] !== '=' && !/\d|[^\p{L}\s]/u.test(v)) continue;
    if (okValue(v, type)) out.push(mk(s, e, type, v, K));
  }
}

// scheme://user:password@host
const CONN = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:@\/?#"'<>]*):([^\s@\/?#"'<>]+)@/gid;

function conn(text: string, out: Span[]): void {
  for (const m of text.matchAll(CONN)) {
    const [u0, u1] = m.indices![1]!;
    const [p0, p1] = m.indices![2]!;
    if (!PLACEHOLDER.test(m[2])) {
      out.push(mk(p0, p1, 'PASSWORD', m[2], K));
    }
    if (m[1] && !PLACEHOLDER.test(m[1])) out.push(mk(u0, u1, 'LOGIN', m[1], K));
  }
}

// curl -u user:password, --user user:password   (docker's -u 1000:1000 is uid:gid, not a login)
const CLI_USER = /(?<![\w-])(?:-u|--user)[ \t]+["']?([^\s:'"]+):([^\s'"]+)["']?/gd;

function cliUser(text: string, out: Span[]): void {
  for (const m of text.matchAll(CLI_USER)) {
    if (/^\d+$/.test(m[1]) && /^\d+$/.test(m[2])) continue;
    if (PLACEHOLDER.test(m[1]) || PLACEHOLDER.test(m[2])) continue;
    const [u0, u1] = m.indices![1]!;
    const [p0, p1] = m.indices![2]!;
    out.push(mk(u0, u1, 'LOGIN', m[1], K), mk(p0, p1, 'PASSWORD', m[2], K));
  }
}

// ───────────── overlap resolution ─────────────

/**
 * Non-overlapping subset: the longest span wins (hiding more is the safe side),
 * ties go to higher prio, then to the one listed first.
 */
export function resolve(spans: Span[]): Span[] {
  const all = spans.filter((s) => s.end > s.start);
  if (!all.length) return [];
  let maxEnd = 0;
  for (const s of all) if (s.end > maxEnd) maxEnd = s.end;
  const order = all
    .map((_, i) => i)
    .sort((a, b) => {
      const x = all[a], y = all[b];
      return (
        y.end - y.start - (x.end - x.start) ||
        y.prio - x.prio ||
        a - b
      );
    });
  const used = new Uint8Array(maxEnd);
  const out: Span[] = [];
  for (const i of order) {
    const s = all[i];
    let hit = false;
    for (let p = s.start; p < s.end; p++) if (used[p]) { hit = true; break; }
    if (hit) continue;
    used.fill(1, s.start, s.end);
    out.push(s);
  }
  return out.sort((a, b) => a.start - b.start);
}

export function detect(text: string): Span[] {
  if (!text) return [];
  const out: Span[] = [];
  run(text, KEYS, out);
  conn(text, out);
  cliUser(text, out);
  // "https://ghp_…@github.com", "user:s3cret@host.com" — the email regex must not eat a credential and the host with it
  const credentials = out.slice();
  kv(text, out);
  natural(text, out);
  const contacts: Span[] = [];
  run(text, CONTACTS, contacts);
  for (const c of contacts) {
    if (c.type === 'EMAIL' && credentials.some((p) => p.start < c.end && c.start < p.end)) continue;
    out.push(c);
  }
  run(text, NETWORK, out);
  run(text, NAMES, out);
  return resolve(out);
}

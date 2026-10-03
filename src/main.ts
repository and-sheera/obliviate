import './style.css';
import * as monaco from '../node_modules/monaco-editor/esm/vs/editor/editor.api.js';
import '../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import '../node_modules/monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import EditorWorker from '../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker';

import { collect } from './core/mask';
import { entityKey, replace, suggest, type Choice } from './core/replace';
import { justName, similarKeys } from './core/names';
import { loadDict, loadSession, saveDict, saveSession, type KV, type Pick } from './core/storage';
import { TYPES, TYPE_LABEL, type DictEntry, type Span, type Term, type Type } from './core/types';
import { Ner } from './ner/client';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Потоки для модели требуют cross-origin isolation; на GitHub Pages её даёт public/coi-sw.js. При первом заходе — одна перезагрузка
if (!crossOriginIsolated && 'serviceWorker' in navigator) {
  try {
    if (!sessionStorage.getItem('obliviate:coi')) {
      sessionStorage.setItem('obliviate:coi', '1'); // не больше одной перезагрузки, даже если изоляция не получилась
      navigator.serviceWorker.register('coi-sw.js').then(() => navigator.serviceWorker.ready).then(() => location.reload(), () => {});
    }
  } catch { /* sessionStorage недоступен: без потоков */ }
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const debounce = (fn: () => void, ms: number) => {
  let t: number | undefined;
  return () => { clearTimeout(t); t = window.setTimeout(fn, ms); };
};

// ───────────── storage: localStorage when it works, memory otherwise ─────────────
const st: KV = (() => {
  try {
    localStorage.setItem('obliviate:probe', '1');
    localStorage.removeItem('obliviate:probe');
    return localStorage;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  }
})();

// Словарь замен — в localStorage; текст и решения по нему — в IndexedDB (см. loadSession), чтобы пережить перезагрузку
let dict: DictEntry[] = loadDict(st);
const persistDict = () => saveDict(st, dict);
/** выбор человека в этом тексте: на что заменить слово (во всех падежах); `on: false` — не заменять, даже если слово есть в словаре */
let picks = new Map<string, Pick>();
/** слова, выделенные вручную в этом тексте: ищутся во всех падежах, как словарь */
let terms: Term[] = [];
/** строки, объединённые вручную («Зида» → «Зина», опечатка): ключ слова → ключ строки, к которой его присоединили */
let aliases = new Map<string, string>();
/** новый текст — с чистого листа (словарь остаётся) */
const forget = () => { picks = new Map(); terms = []; aliases = new Map(); selected = new Set(); activeKey = ''; };

// ───────────── editors ─────────────
const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => (dark.matches ? 'obliviate-dark' : 'obliviate-light');

// Свои темы редактора: фон как у карточки, стандартную подсветку различий не рисуем — замены подсвечиваем сами
const themeColors = (bg: string) => ({
  'editor.background': bg, 'editor.lineHighlightBackground': '#00000000', 'editor.lineHighlightBorder': '#00000000',
  'diffEditor.insertedTextBackground': '#00000000', 'diffEditor.insertedLineBackground': '#00000000',
  'diffEditor.removedTextBackground': '#00000000', 'diffEditor.removedLineBackground': '#00000000',
  'diffEditor.diagonalFill': '#00000000', 'diffEditor.border': '#00000000',
});
monaco.editor.defineTheme('obliviate-light', { base: 'vs', inherit: true, rules: [], colors: themeColors('#ffffff') });
monaco.editor.defineTheme('obliviate-dark', { base: 'vs-dark', inherit: true, rules: [], colors: themeColors('#171a21') });

function makeDiff(el: HTMLElement) {
  const diff = monaco.editor.createDiffEditor(el, {
    originalEditable: true, readOnly: true, automaticLayout: true, renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: false, enableSplitViewResizing: false, renderIndicators: false, renderMarginRevertIcon: false, renderGutterMenu: false,
    minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false, renderOverviewRuler: false, ignoreTrimWhitespace: false,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif', fontSize: 14, lineHeight: 22,
    lineNumbers: 'off', glyphMargin: false, folding: false, lineDecorationsWidth: 16, lineNumbersMinChars: 0,
    padding: { top: 12, bottom: 12 }, renderLineHighlight: 'none', scrollbar: { verticalScrollbarSize: 10 },
  });
  // у левой (редактируемой) половины Monaco сам добавляет поле слева — уравниваем отступы текста в обеих половинах
  diff.getOriginalEditor().updateOptions({ lineDecorationsWidth: 0 });
  diff.getModifiedEditor().updateOptions({ lineDecorationsWidth: 22 });
  diff.getOriginalEditor().updateOptions({ overviewRulerLanes: 1, hideCursorInOverviewRuler: true, overviewRulerBorder: false });
  const original = monaco.editor.createModel('', 'plaintext');
  const modified = monaco.editor.createModel('', 'plaintext');
  diff.setModel({ original, modified });
  return { diff, original, modified, editor: diff.getOriginalEditor() };
}

const hide = makeDiff($('#diffHide'));
monaco.editor.setTheme(theme());
dark.addEventListener('change', () => monaco.editor.setTheme(theme()));
const marks = hide.editor.createDecorationsCollection([]);
const marksBack = hide.diff.getModifiedEditor().createDecorationsCollection([]); // замены в «Что уйдёт в нейросеть»

const setValue = (m: monaco.editor.ITextModel, v: string) => { if (m.getValue() !== v) m.setValue(v); };
// Замена текста пользователя с возможностью отмены (Ctrl/⌘+Z), чтобы «Очистить» и «Вставить» не стирали работу безвозвратно
const replaceText = (m: monaco.editor.ITextModel, v: string) =>
  m.pushEditOperations([], [{ range: m.getFullModelRange(), text: v }], () => null);

// ───────────── NER ─────────────
let nerFor = ''; // the text the spans below belong to
let nerList: Span[] = [];
let nerDone = ''; // the text the analysis finished for (partial results don't count: they aren't saved)

// Полоса состояния модели: загрузка → запуск → анализ текста по частям → готово
function setModel(state: 'loading' | 'busy' | 'ready' | 'error' | 'off', text: string, pct?: number) {
  $('#modelDot').dataset.state = state;
  $('#modelText').textContent = text;
  const bar = $('#modelBar');
  bar.hidden = state !== 'loading' && state !== 'busy';
  bar.classList.toggle('indeterminate', pct === undefined);
  bar.style.setProperty('--p', `${pct ?? 0}%`);
  $('#modelRetry').hidden = state !== 'error';
}
let nerTook = ''; // сколько занял последний анализ: по этому числу видно, помогло ли ускорение
const nerIdle = () => setModel('ready', nerFor && nerFor === hide.original.getValue() ? `Модель готова · имён и компаний: ${nerList.filter((x) => x.source === 'ner').length}${nerTook}` : 'Модель готова');

const ner = new Ner((state, info) => {
  if (state === 'loading') {
    // 100% скачано, но движок ещё собирается — показываем это отдельно, иначе кажется, что всё зависло
    if (info === '100%') setModel('loading', 'Запуск модели…');
    else setModel('loading', info ? `Загрузка модели ${info}` : 'Загрузка модели…', info ? parseInt(info) : undefined);
  } else if (state === 'ready') { nerIdle(); refresh(); }
  else if (state === 'error') setModel('error', `Ошибка модели: ${info}`);
  else setModel('off', 'Модель остановлена');
});
$('#modelRetry').onclick = () => { ner.unload(); ner.load().catch(() => {}); };

// «Точно» (по умолчанию) — три модели голосуют (см. nerSpans), «Быстро» — одна; выбор в полосе модели, запоминается
const NER_MODE = 'obliviate:nerMode';
const NER_MODELS: Record<string, string[]> = { fast: ['ner'], accurate: ['ner', 'ner-c3-v2', 'ner-conv'] };
const nerMode = $<HTMLSelectElement>('#nerMode');
nerMode.value = st.getItem(NER_MODE) === 'fast' ? 'fast' : 'accurate';
ner.models = NER_MODELS[nerMode.value];
nerMode.onchange = () => {
  st.setItem(NER_MODE, nerMode.value);
  ner.models = NER_MODELS[nerMode.value];
  nerFor = nerDone = ''; nerList = [];
  ner.unload();
  ner.load().catch(() => {});
  refresh();
};

let lastNerPaint = 0;
const runNer = debounce(async () => {
  const text = hide.original.getValue();
  if (ner.state !== 'ready' || !text.trim() || nerFor === text) return;
  try {
    const t0 = performance.now();
    const spans = await ner.detect(text, (part, done, total) => {
      if (hide.original.getValue() !== text) return; // текст уже изменили — эти части устарели
      nerFor = text; nerList = part;
      setModel('busy', `Анализ текста: ${done} из ${total} · имён и компаний: ${part.length}`, Math.round((done / total) * 100));
      // длинный текст: не перерисовываем всё на каждую часть, а лишь несколько раз в секунду
      if (done === total || performance.now() - lastNerPaint > 250) { lastNerPaint = performance.now(); refresh(); }
    });
    if (hide.original.getValue() !== text) return;
    nerFor = nerDone = text; nerList = spans;
    nerTook = ` · ${((performance.now() - t0) / 1000).toFixed(1).replace('.', ',')} с`;
    nerIdle();
    refresh();
  } catch { /* worker stopped, cancelled or failed: the regex/dictionary result stays */ }
}, 400);

// ───────────── найденное и замены ─────────────
// Найденные слова сгруппированы по сущности: одно слово во всех падежах — одна строка, одна замена
type Group = {
  key: string; sp: Span; n: number;
  /** форма, для которой предлагается замена: самая короткая из встреченных, чаще всего именительный падеж */
  base: string;
  /** на что заменить сейчас: выбор в этом тексте, иначе словарь */
  to: string;
  on: boolean;
  dict?: DictEntry;
  /** насколько уверены, что это оно (см. confOf); по ней таблица сортируется по умолчанию */
  conf: number;
  /** как слово встречается в тексте: «Ивану», «Иваном» — видно, что они в этой строке */
  forms: Set<string>;
  /** просто имя («Даня», «Иван И.»): по нему человека не узнать — в таблице ниже разделителя, общая галочка его не трогает */
  plain: boolean;
  /** ключи слов в этой строке: больше одного — строки объединяли вручную */
  members: Set<string>;
  /** похожие строки, вероятно опечатки того же («Зина» / «Зида»): стоят рядом, их можно объединить */
  alike: Group[];
};
type SortCol = 'type' | 'word' | 'n';
let spans: Span[] = [];
let groups: Group[] = [];
let byKey = new Map<string, Group>();
let outKeys: string[] = []; // чья замена стоит в каждом из outRanges
let outRanges: Array<[number, number]> = [];
let activeKey = ''; // слово, вхождения которого сейчас разглядываем
let activeIdx = 0; // какое по счёту вхождение выбрано
let query = '';
let typeFilter: Type | '' = '';
let sort: { col: SortCol; dir: 1 | -1 } | null = null;
// Секреты: если их не заменить, утечка самая опасная — такие строки подсвечиваем красным
const DANGEROUS = new Set<Type>(['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PRIVATE_KEY']);

const replaced = (g: Group) => g.on && !!g.to.trim();
const keyOf = (sp: Span) => { const k = entityKey(sp.type, sp.value); return aliases.get(k) ?? k; };
/** словарь и выделенное — решение человека; правила (почта, ключи, ООО «X», Иванов И.И.) почти не ошибаются; модель — её уверенность × доля согласных моделей */
const confOf = (sp: Span) => (sp.source === 'ner' ? sp.score ?? 0.5 : sp.source === 'regex' ? 2 : 3);
const dictFor = (key: string) => dict.find((d) => entityKey(d.type, d.term) === key);
/** заготовка для поля замены; номер — чтобы две разные почты не стали одной */
const suggestFor = (g: Group) => suggest(g.sp.type, g.base, groups.filter((x) => x !== g && x.sp.type === g.sp.type && replaced(x)).length + 1);
/** форма, для которой написана замена: из неё склоняются остальные */
const fromOf = (g: Group) => picks.get(g.key)?.from ?? g.dict?.term ?? g.base;

/** заголовок строки: самая короткая форма (обычно именительный падеж); из равных — известное имя: в «Зиде / Зины» опечатка скорее «Зиде» */
const better = (form: string, base: string) => form.length < base.length || (form.length === base.length && justName(form) && !justName(base));

function buildGroups() {
  byKey = new Map();
  const chosen = new Set<string>(); // выделенные вручную: человек сам решил, что это прятать
  for (const sp of spans) {
    const key = keyOf(sp);
    if (sp.source === 'dict' || sp.source === 'manual') chosen.add(key);
    const form = sp.text.replace(/\s+/g, ' ');
    const g = byKey.get(key);
    // строка, к которой присоединили другую, остаётся собой: её тип и её слово, а не того, что раньше встретилось в тексте
    if (g && entityKey(sp.type, sp.value) === key && entityKey(g.sp.type, g.sp.value) !== key) g.sp = sp;
    if (g) { g.n++; g.forms.add(form); g.members.add(entityKey(sp.type, sp.value)); g.conf = Math.max(g.conf, confOf(sp)); if (!g.dict && better(sp.text, g.base)) g.base = sp.text; continue; }
    const d = dictFor(key), p = picks.get(key);
    // слово из словаря показываем так, как оно там записано: «Сбербанк → Комбанк», а не «Сбербанка → Комбанк»
    byKey.set(key, {
      key, sp, n: 1, base: d?.term ?? sp.text, dict: d, to: p?.to ?? d?.replacement ?? '', on: p ? p.on : !!d?.replacement,
      conf: confOf(sp), forms: new Set([form]), plain: false, members: new Set([entityKey(sp.type, sp.value)]), alike: [],
    });
  }
  groups = [...byKey.values()];
  for (const g of groups) g.plain = g.sp.type === 'PERSON' && !g.dict && !chosen.has(g.key) && justName(g.base);
  // похожие строки одного типа — кандидаты на объединение (сравниваем каждое слово строки, их немного)
  for (const [i, a] of groups.entries()) {
    for (const b of groups.slice(i + 1)) {
      if (a.sp.type === b.sp.type && [...a.members].some((x) => [...b.members].some((y) => similarKeys(x, y)))) { a.alike.push(b); b.alike.push(a); }
    }
  }
}

function choiceFor(sp: Span): Choice | null {
  const g = byKey.get(keyOf(sp))!;
  if (!replaced(g)) return null;
  outKeys.push(g.key);
  return { to: g.to, from: fromOf(g) };
}

function refresh() {
  const raw = hide.original.getValue();
  const text = raw.normalize('NFC');
  // "ё" as е + ◌̈ (text from PDFs on macOS) looks the same but breaks the dictionary and the model; the change event calls refresh again
  if (text !== raw) return void replaceText(hide.original, text);
  spans = collect(text, { dict: [...dict, ...terms], extra: nerFor === text ? nerList : [] });
  buildGroups();
  outKeys = [];
  const res = replace(text, spans, choiceFor);
  outRanges = res.ranges;
  setValue(hide.modified, res.text);
  drawFound();
  if (activeKey) syncOcc();
  paintMarks();
  runNer();
  if (restored) saveSoon();
}
let restored = false; // пока сохранённый текст не прочитан, не сохраняем: пустой стартовый текст затёр бы его
const saveSoon = debounce(() => {
  const text = hide.original.getValue();
  return saveSession({ text, picks: [...picks], terms, aliases: [...aliases], ner: nerDone === text ? { mode: `${nerMode.value}@${__MODELS__}`, spans: nerList } : undefined });
}, 500);

/** «Зида» — опечатка «Зины», «Сбер» — это «Сбербанк»: строки `others` присоединяются к `g` — одна строка, одна замена на все написания и падежи */
function joinRows(g: Group, others: Group[]) {
  for (const o of others) {
    for (const m of o.members) aliases.set(m, g.key);
    for (const [k, v] of aliases) if (v === o.key) aliases.set(k, g.key);
    if (!picks.has(g.key) && picks.has(o.key)) picks.set(g.key, picks.get(o.key)!);
    picks.delete(o.key);
  }
  refresh();
}
// ───────────── выбор строк для объединения ─────────────
// Кружок слева от слова (не галочка «заменить»): отметили две и больше — внизу списка «Объединить»; присоединяются к верхней из выбранных
let selected = new Set<string>();
function joinSelected() {
  // в порядке таблицы; выбранные, скрытые поиском или фильтром, тоже участвуют
  const rows = [...new Set([...visible(), ...groups])].filter((g) => selected.has(g.key));
  selected = new Set();
  if (rows.length > 1) joinRows(rows[0], rows.slice(1)); else drawFound();
}
$('#joinGo').onclick = joinSelected;
$('#joinCancel').onclick = () => { selected = new Set(); drawFound(); };
$('#found').addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected.size) { e.stopPropagation(); selected = new Set(); drawFound(); } });

/** объединили зря — снова отдельные строки */
function splitJoined(g: Group) {
  for (const [k, v] of aliases) if (v === g.key) aliases.delete(k);
  refresh();
}

/** заменять слово на `to` (во всех падежах) или перестать */
function setPick(g: Group, to: string, on: boolean) {
  picks.set(g.key, { to, from: fromOf(g), on });
  refresh();
}
function toggle(g: Group) {
  if (g.on) return setPick(g, g.to, false);
  const to = g.to || suggestFor(g);
  setPick(g, to, true);
  if (!to) focusRepl(g.key); // компанию и место человек придумывает сам
}
const focusRepl = (key: string) => {
  const i = document.querySelector<HTMLInputElement>(`#found [data-key="${CSS.escape(key)}"][data-role="repl"]`);
  i?.focus(); i?.select();
};

// ───────────── таблица «Можно заменить» ─────────────
const SORT_BY: Record<SortCol, (a: Group, b: Group) => number> = {
  type: (a, b) => TYPE_LABEL[a.sp.type].localeCompare(TYPE_LABEL[b.sp.type], 'ru'),
  word: (a, b) => a.base.localeCompare(b.base, 'ru'),
  n: (a, b) => a.n - b.n,
};
function visible() {
  const rows = groups.filter((g) => (!typeFilter || g.sp.type === typeFilter) && `${g.base} ${[...g.forms].join(' ')} ${g.to} ${TYPE_LABEL[g.sp.type]}`.toLowerCase().includes(query));
  // по умолчанию сверху то, в чём уверены больше всего (0.97 и 0.98 — одно и то же «уверены»); при равенстве — что чаще, дальше порядок в тексте
  if (sort) { const { col, dir } = sort; rows.sort((a, b) => dir * SORT_BY[col](a, b)); }
  else rows.sort((a, b) => Math.round(b.conf * 10) - Math.round(a.conf * 10) || b.n - a.n);
  return rows;
}

function drawFound() {
  // таблица перерисовывается при каждом изменении — запоминаем, где был фокус (и курсор в поле замены), чтобы клавиатура не «теряла» место
  const focused = document.activeElement as HTMLElement | null;
  const inRows = focused?.closest('#found tbody') ? { ...focused.dataset } : null;
  const caret = focused instanceof HTMLInputElement && focused.type === 'text' ? [focused.selectionStart, focused.selectionEnd] as const : null;
  const filterFocus = focused?.closest('#typeFilter') ? focused.dataset.type ?? '' : null;

  // фильтр по типам со счётчиками (только те типы, что нашлись)
  const counts = new Map<Type, number>();
  for (const g of groups) counts.set(g.sp.type, (counts.get(g.sp.type) ?? 0) + 1);
  if (typeFilter && !counts.has(typeFilter)) typeFilter = '';
  const chip = (type: Type | '', label: string, n: number) => {
    const b = document.createElement('button');
    b.dataset.type = type;
    b.setAttribute('aria-pressed', String(typeFilter === type));
    const num = Object.assign(document.createElement('b'), { textContent: String(n) });
    b.append(`${label} `, num);
    b.onclick = () => { typeFilter = typeFilter === type ? '' : type; drawFound(); };
    return b;
  };
  $('#typeFilter').replaceChildren(...(counts.size > 1 ? [chip('', 'Все', groups.length), ...TYPES.filter((t) => counts.has(t)).map((t) => chip(t, TYPE_LABEL[t], counts.get(t)!))] : []));

  // итог: сколько заменено и не остался ли открытым секрет (просто имена не в счёт)
  const real = groups.filter((g) => !g.plain);
  const done = real.filter(replaced).length;
  const risky = groups.filter((g) => !replaced(g) && DANGEROUS.has(g.sp.type)).length;
  const summary = $('#foundCount');
  summary.textContent = !groups.length ? '' : `заменено ${done} из ${real.length}${risky ? ` · секретов не заменено: ${risky}` : ''}`;
  summary.classList.toggle('risk', risky > 0);

  const all = visible();
  const rows = all.filter((g) => !g.plain), plain = all.filter((g) => g.plain);
  $('#foundEmpty').textContent = all.length ? '' : groups.length ? 'По запросу ничего нет.' : 'Пока ничего. Вставьте текст или откройте пример — здесь появится то, что стоит заменить.';

  // общая галочка: отмечена, если заменяется всё показанное; «–», если часть
  const box = $<HTMLInputElement>('#foundAll');
  const rowsOn = rows.filter((g) => g.on).length;
  box.disabled = !rows.length;
  box.checked = rows.length > 0 && rowsOn === rows.length;
  box.indeterminate = rowsOn > 0 && rowsOn < rows.length;

  for (const th of document.querySelectorAll<HTMLElement>('#found th[aria-sort]')) {
    const col = th.querySelector<HTMLElement>('[data-sort]')?.dataset.sort;
    th.setAttribute('aria-sort', sort && sort.col === col ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  }

  /** `like`: строка, под которой стоит эта похожая — с ней её можно объединить */
  const row = (g: Group, like?: Group) => {
    const { key, sp, n } = g;
    const done = replaced(g);
    const risk = !done && DANGEROUS.has(sp.type);
    const tr = document.createElement('tr');
    tr.className = `t-${sp.type}${selected.has(key) ? ' picked' : ''}${done ? ' on' : ''}${g.on && !done ? ' need' : ''}${risk ? ' risk' : ''}${key === activeKey ? ' active' : ''}`;

    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = g.on;
    box.dataset.key = key; box.dataset.role = 'box';
    box.setAttribute('aria-label', `Заменять «${g.base}»`);
    box.onchange = () => toggle(g);

    const go = document.createElement('button');
    go.className = 'go';
    go.dataset.key = key; go.dataset.role = 'go';
    go.textContent = g.base.replace(/\s+/g, ' ');
    go.title = `${g.base}\n${risk ? 'Секрет не заменён! ' : ''}Показать в тексте${g.dict ? ' · есть в словаре замен' : ''}${like ? `\nПохоже на «${like.base}» (строка выше)` : ''}`;
    go.onclick = () => (key === activeKey ? stepOcc(1) : openWord(key));

    // поле замены: ввод сразу заменяет во всех местах, пустое поле — не заменять; Tab в пустом поле принимает заготовку
    const hint = suggestFor(g);
    const repl = document.createElement('input');
    repl.type = 'text'; repl.className = 'repl'; repl.value = g.to;
    repl.dataset.key = key; repl.dataset.role = 'repl';
    repl.placeholder = hint || 'на что заменить';
    repl.setAttribute('aria-label', `На что заменить «${g.base}»`);
    repl.oninput = () => { picks.set(key, { to: repl.value, from: fromOf(g), on: !!repl.value.trim() }); refreshSoon(); };
    repl.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go.focus(); }
      else if (e.key === 'Tab' && !e.shiftKey && !repl.value && hint) { e.preventDefault(); setPick(g, hint, true); focusRepl(key); }
    };

    const cell = (cls: string, ...c: (Node | string)[]) => { const td = document.createElement('td'); td.className = cls; td.append(...c); return td; };
    const badge = Object.assign(document.createElement('span'), { className: 'badge', textContent: TYPE_LABEL[sp.type] });
    const at = key === activeKey && n > 1 ? `${activeIdx + 1}/${n}` : `×${n}`;
    const others = [...g.forms].filter((f) => f !== g.base.replace(/\s+/g, ' '));
    const forms = Object.assign(document.createElement('div'), { className: 'forms', textContent: others.join(' · ') });
    // действия со строкой — иконки справа от слова: подпись в узкой колонке переносилась бы на три строки
    const act = (icon: string, label: string, fn: () => void) => {
      const b = Object.assign(document.createElement('button'), { className: 'row-act', title: label, onclick: fn });
      b.setAttribute('aria-label', label);
      b.innerHTML = `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="${icon}"/></svg>`;
      return b;
    };
    // «связать»: выбрать строку, чтобы объединить с другими (переключатель, не галочка «заменить»)
    const picked = selected.has(key);
    const pick = act('M8 14v-4M8 10l-4-4V2M8 10l4-4V2',
      picked ? 'Не объединять эту строку' : 'Выбрать, чтобы объединить с другими строками',
      () => { if (selected.has(key)) selected.delete(key); else selected.add(key); drawFound(); });
    pick.classList.add('pick');
    pick.setAttribute('aria-pressed', String(picked));
    pick.dataset.key = key; pick.dataset.role = 'sel';
    // поверх правого края слова: появляются при наведении и ничего не сдвигают
    const acts = el('span', 'row-acts');
    acts.append(pick, ...(g.members.size > 1 ? [act('M8 2v4M8 6l-4 4v4M8 6l4 4v4', 'Разделить: объединили зря — снова отдельные строки', () => splitJoined(g))] : []));
    const line = Object.assign(document.createElement('div'), { className: 'wline' });
    if (g.dict) {
      const book = el('span', 'dict-ico');
      book.title = 'Из словаря замен';
      book.innerHTML = '<svg class="ico" viewBox="0 0 16 16" aria-label="Из словаря замен"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10H4.5A1.5 1.5 0 0 0 3 13.5z"/><path d="M3 13.5A1.5 1.5 0 0 0 4.5 15H13v-3"/><path d="M6 5h4"/></svg>';
      line.append(book);
    }
    line.append(go, acts);
    const under: Node[] = others.length ? [forms] : [];
    const hit = Object.assign(document.createElement('label'), { className: 'hit' });
    hit.append(box);
    tr.append(cell('c', hit), cell('', badge), cell('w', line, ...under), cell('n', at), cell('r', repl));
    return tr;
  };
  const sep = document.createElement('tr');
  sep.className = 'sep';
  sep.append(Object.assign(document.createElement('td'), { colSpan: 5, textContent: 'Просто имена — по ним человека не узнать, можно не заменять' }));
  // похожие строки («Зина» / «Зида») — сразу под первой из них, даже если одна из них «просто имя», а другая нет
  const shown = new Set(all), placed = new Set<Group>();
  const place = (list: Group[]) => list.flatMap((g) => {
    if (placed.has(g)) return [];
    const alike = g.alike.filter((o) => shown.has(o) && !placed.has(o));
    placed.add(g); alike.forEach((o) => placed.add(o));
    return [row(g), ...alike.map((o) => row(o, g))];
  });
  const top = place(rows), bottom = place(plain);
  $('#found tbody').replaceChildren(...top, ...(bottom.length ? [sep, ...bottom] : []));

  // выбранные для объединения: строк могло стать меньше (текст изменили)
  for (const k of selected) if (!byKey.has(k)) selected.delete(k);
  $('#joinBar').hidden = !selected.size;
  $('#joinCount').textContent = selected.size === 1 ? 'Выбрана 1 строка — отметьте ещё' : `Выбрано строк: ${selected.size}`;
  $<HTMLButtonElement>('#joinGo').disabled = selected.size < 2;

  const again = (sel: string) => $<HTMLElement>(sel)?.focus();
  if (inRows) {
    again(`#found tbody [data-key="${CSS.escape(inRows.key ?? '')}"][data-role="${inRows.role}"]`);
    const i = document.activeElement;
    if (caret && i instanceof HTMLInputElement && i.type === 'text') i.setSelectionRange(caret[0], caret[1]);
  } else if (filterFocus !== null) again(`#typeFilter [data-type="${filterFocus}"]`);
}
const refreshSoon = debounce(refresh, 150);

const occurrences = (key: string) => spans.filter((sp) => keyOf(sp) === key);
const rangeOf = (m: monaco.editor.ITextModel, start: number, end: number) => {
  const a = m.getPositionAt(start), b = m.getPositionAt(end);
  return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
};

// Заменить все показанные строки (учитывает поиск и фильтр) или снять замену со всех
function setVisible(on: boolean) {
  let skipped = 0;
  for (const g of visible().filter((x) => !x.plain)) {
    if (!on) { if (g.on) picks.set(g.key, { to: g.to, from: fromOf(g), on: false }); continue; }
    if (g.on) continue;
    const to = g.to || suggestFor(g);
    if (!to) { skipped++; continue; }
    picks.set(g.key, { to, from: fromOf(g), on: true });
    g.to = to; g.on = true; // следующая заготовка того же типа получит следующий номер
  }
  refresh();
  if (skipped) toast(`Без замены пропущено: ${skipped} (компании и места) — впишите, на что их заменить`);
}
$('#foundAll').onchange = () => setVisible(!visible().filter((g) => !g.plain).every((g) => g.on));
$<HTMLInputElement>('#foundSearch').oninput = (e) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); drawFound(); };
for (const b of document.querySelectorAll<HTMLButtonElement>('#found [data-sort]')) {
  b.onclick = () => {
    const col = b.dataset.sort as SortCol;
    sort = sort?.col !== col ? { col, dir: 1 } : sort.dir === 1 ? { col, dir: -1 } : null; // по возрастанию → по убыванию → по уверенности
    drawFound();
  };
}
// Клавиатура: ↑/↓ — между строками, Пробел на слове — переключить галочку
const tbody = $<HTMLTableSectionElement>('#found tbody');
tbody.onkeydown = (e) => {
  const el = e.target as HTMLElement;
  if (!el.dataset.role) return;
  const tr = el.closest('tr')!;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    let next: Element | null = tr; // мимо разделителя «Просто имена»
    do next = e.key === 'ArrowDown' ? next.nextElementSibling : next.previousElementSibling;
    while (next && !next.querySelector(`[data-role="${el.dataset.role}"]`));
    next?.querySelector<HTMLElement>(`[data-role="${el.dataset.role}"]`)?.focus();
  } else if (e.key === ' ' && el.dataset.role === 'go') {
    e.preventDefault();
    tr.querySelector<HTMLInputElement>('[data-role="box"]')!.click();
  }
};
tbody.onkeyup = (e) => { if (e.key === ' ' && (e.target as HTMLElement).dataset.role === 'go') e.preventDefault(); }; // пробел на кнопке иначе «нажмёт» её при отпускании

// ───────────── все вхождения слова ─────────────
// Клик по слову: в тексте сразу подсвечены все его места, под таблицей список с контекстом, ↑/↓ листают — редактор едет следом
function openWord(key: string, idx = 0) {
  if (!occurrences(key).length) return;
  activeKey = key; activeIdx = idx;
  syncOcc();
  drawFound();
  paintMarks();
  reveal();
  if (occurrences(key).length > 1) $('#occList').focus({ preventScroll: true });
}
function stepOcc(d: number) {
  const n = occurrences(activeKey).length;
  if (!n) return;
  activeIdx = (activeIdx + d + n) % n;
  syncOcc(); drawFound(); paintMarks(); reveal();
}
function closeOcc() {
  const key = activeKey;
  activeKey = '';
  $('#occ').hidden = true;
  drawFound(); paintMarks();
  document.querySelector<HTMLElement>(`#found [data-key="${CSS.escape(key)}"][data-role="go"]`)?.focus();
}
function reveal() {
  const sp = occurrences(activeKey)[activeIdx];
  if (!sp) return;
  const r = rangeOf(hide.original, sp.start, sp.end);
  hide.editor.setPosition(r.getStartPosition());
  hide.editor.revealRangeInCenter(r, monaco.editor.ScrollType.Smooth);
}

// Список вхождений: строка текста + кусок вокруг слова. Перерисовывается и при правке текста
function syncOcc() {
  const list = occurrences(activeKey);
  if (!list.length) { activeKey = ''; $('#occ').hidden = true; return; }
  activeIdx = Math.min(activeIdx, list.length - 1);
  const text = hide.original.getValue();
  $('#occ').hidden = list.length < 2; // одно вхождение — списка не нужно, оно и так подсвечено
  const base = byKey.get(activeKey)?.base ?? list[0].text;
  $('#occTitle').textContent = `Вхождения «${base.length > 22 ? `${base.slice(0, 21)}…` : base}»`;
  $('#occPos').textContent = `${activeIdx + 1} из ${list.length}`;
  $('#occList').replaceChildren(...list.map((sp, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `occ${i}`;
    li.setAttribute('aria-selected', String(i === activeIdx));
    // контекст берём только из той же строки: переносы строк в одну полоску не склеиваем
    const lineStart = text.lastIndexOf('\n', sp.start - 1) + 1;
    const lineEnd = (text.indexOf('\n', sp.end) + 1 || text.length + 1) - 1;
    const from = Math.max(lineStart, sp.start - 16), to = Math.min(lineEnd, sp.end + 60);
    const mark = Object.assign(document.createElement('mark'), { textContent: text.slice(sp.start, sp.end) });
    li.append(
      Object.assign(document.createElement('span'), { className: 'ln', textContent: String(hide.original.getPositionAt(sp.start).lineNumber) }),
      Object.assign(document.createElement('span'), { className: 'ctx' }),
    );
    li.lastElementChild!.append((from > lineStart ? '…' : '') + text.slice(from, sp.start), mark, text.slice(sp.end, to) + (to < lineEnd ? '…' : ''));
    li.onclick = () => { activeIdx = i; syncOcc(); drawFound(); paintMarks(); reveal(); };
    return li;
  }));
  $('#occList').setAttribute('aria-activedescendant', `occ${activeIdx}`);
  $(`#occ${activeIdx}`)?.scrollIntoView({ block: 'nearest' });
}
$('#occPrev').onclick = () => stepOcc(-1);
$('#occNext').onclick = () => stepOcc(1);
$('#occClose').onclick = closeOcc;
$('#occList').onkeydown = (e) => {
  const k = e.key;
  if (k === 'ArrowDown' || k === 'j') stepOcc(1);
  else if (k === 'ArrowUp' || k === 'k') stepOcc(-1);
  else if (k === 'Enter') hide.editor.focus();
  else if (k === 'Escape') closeOcc();
  else return;
  e.preventDefault();
};

// Подсветка: слева найденное подчёркнуто, заменённое залито; выбранное слово — ярко со всеми местами. Справа — замены
function paintMarks() {
  marks.set(spans.map((sp) => {
    const key = keyOf(sp);
    const same = activeKey !== '' && key === activeKey;
    const idx = same ? occurrences(key).indexOf(sp) : -1;
    const g = byKey.get(key)!;
    const cls = same ? `hl hl-same${idx === activeIdx ? ' hl-focus' : ''}` : `hl t-${sp.type}${replaced(g) ? '' : ' suggest'}${g.plain && !replaced(g) ? ' just-name' : ''}${activeKey ? ' dim' : ''}`;
    return {
      range: rangeOf(hide.original, sp.start, sp.end),
      options: { inlineClassName: cls, overviewRuler: same ? { color: '#5b5bd6', position: monaco.editor.OverviewRulerLane.Full } : undefined },
    };
  }));
  // то же слово справа: его замены по местам совпадают с местами слева, поэтому номер выбранного места общий
  let i = 0;
  marksBack.set(outRanges.map(([a, b], j) => {
    const mine = outKeys[j] === activeKey;
    return { range: rangeOf(hide.modified, a, b), options: { inlineClassName: mine ? `hl hl-same${i++ === activeIdx ? ' hl-focus' : ''}` : 'ph' } };
  }));
}

hide.original.onDidChangeContent(debounce(refresh, 120));
hide.original.onDidChangeContent(() => ($('#emptyHide').hidden = !!hide.original.getValue()));

// ───────────── словарь замен ─────────────
/** положить замену в словарь (или обновить её там) */
function toDict(term: string, type: Type, replacement: string) {
  const key = entityKey(type, term);
  const d = dict.find((x) => entityKey(x.type, x.term) === key);
  if (d) d.replacement = replacement; else dict.push({ term, type, replacement });
  persistDict();
  picks.delete(key); // теперь это решение словаря, а не только этого текста
  renderDict(); refresh();
  if (replacement) toast(`В словаре: «${shorten(term, 24)}» → «${shorten(replacement, 24)}» — будет заменяться в любом тексте`);
}

// ───────────── подсказка у выделения и у найденных слов ─────────────
// Один плавающий блок у текста: на выделении предлагает заменить его, на найденном слове — заменить или передумать
let tipMode: 'select' | 'word' | null = null;
let tipAt: monaco.IPosition | null = null;
let alsoDict = false; // «и в словарь» помним между подсказками
let hoverSpan: Span | undefined;
let mouseDown = false;
let tipTimer: number | undefined, hideTimer: number | undefined, selTimer: number | undefined;

// Блок лежит прямо в странице (а не внутри редактора): иначе его обрезает половина окна и мышь, ушедшая на него, «уходит» из редактора
const tipEl = Object.assign(document.createElement('div'), { className: 'tip', hidden: true });
document.body.append(tipEl);
// клик по подсказке не должен снимать выделение в тексте и уводить фокус из редактора — кроме клика в поле замены
tipEl.addEventListener('mousedown', (e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); });
tipEl.onmouseenter = () => clearTimeout(hideTimer);
tipEl.onmouseleave = () => scheduleHideTip();

function placeTip(at: monaco.IPosition, mode: 'select' | 'word', ...body: Node[]) {
  clearTimeout(hideTimer);
  tipEl.replaceChildren(...body);
  tipAt = at; tipMode = mode;
  tipEl.hidden = false;
  positionTip();
}
// Над словом, а если сверху нет места — под ним; по горизонтали не выходит за край окна
function positionTip() {
  if (!tipAt) return;
  const p = hide.editor.getScrolledVisiblePosition(tipAt);
  const box = hide.editor.getDomNode()!.getBoundingClientRect();
  if (!p || p.top < 0 || p.top > box.height) return hideTip(); // слово уехало за край при прокрутке
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const above = box.top + p.top - h - 2;
  tipEl.style.top = `${above < 8 ? box.top + p.top + p.height + 2 : above}px`;
  tipEl.style.left = `${Math.max(8, Math.min(box.left + p.left, innerWidth - w - 8))}px`;
}
function hideTip() {
  clearTimeout(tipTimer); clearTimeout(hideTimer);
  hoverSpan = undefined;
  if (!tipMode) return;
  tipMode = null; tipAt = null;
  tipEl.hidden = true;
  tipEl.replaceChildren();
}
// подсказка у слова пропадает, когда мышь ушла и со слова, и с подсказки (небольшая задержка, чтобы успеть дойти до неё); пока в ней печатают — не пропадает
function scheduleHideTip() {
  clearTimeout(tipTimer);
  if (tipMode !== 'word' || tipEl.contains(document.activeElement)) return;
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideTip, 350);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') =>
  Object.assign(document.createElement(tag), { className: cls, textContent: text });
const typeRow = (types: Type[], current: Type | null, pick: (t: Type) => void) => {
  const row = el('div', 'tip-types');
  for (const t of types) {
    const b = el('button', `tip-type t-${t}`, TYPE_LABEL[t]);
    b.dataset.type = t;
    b.setAttribute('aria-pressed', String(t === current));
    b.onclick = () => pick(t);
    row.append(b);
  }
  return row;
};
const shorten = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/** поле «на что заменить» + кнопка; Enter = кнопка */
function replaceRow(value: string, placeholder: string, done: (to: string) => void) {
  const row = el('form', 'tip-replace');
  const input = Object.assign(document.createElement('input'), { type: 'text', value, placeholder, autocomplete: 'off' });
  input.setAttribute('aria-label', 'На что заменить');
  row.append(input, el('button', 'tip-act main', 'Заменить'));
  row.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) done(input.value.trim()); else input.focus(); };
  return { row, input };
}
const dictBox = () => {
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: alsoDict });
  box.onchange = () => (alsoDict = box.checked);
  const label = el('label', 'check small-text');
  label.append(box, ' и в словарь замен');
  label.title = 'Заменять это слово так же в любом тексте';
  return label;
};

const SELECTABLE: Type[] = ['PERSON', 'ORG', 'LOC', 'SECRET', 'LOGIN'];
function showSelectionTip(focus = false) {
  const sel = hide.editor.getSelection();
  // кавычки и знаки по краям не часть слова: двойной клик по «Вектора» выделяет его вместе с кавычками
  const term = sel && !sel.isEmpty() ? hide.original.getValueInRange(sel).trim().replace(/^[«"'„“(\[]+|[»"'”)\].,:;!?]+$/g, '') : '';
  // слишком длинное или многострочное выделение — это не «слово», подсказка только мешала бы
  if (!sel || !term || term.length > 120 || term.includes('\n') || (!hide.editor.hasTextFocus() && !focus)) return;
  let type: Type = 'PERSON';
  const { row, input } = replaceRow(suggest(type, term), 'на что заменить', (to) => {
    if (!terms.some((d) => d.term === term && d.type === type)) terms.push({ term, type });
    picks.set(entityKey(type, term), { to, from: term, on: true });
    hide.editor.setPosition(sel.getEndPosition()); // снять выделение, иначе подсказка появится снова
    hideTip();
    if (alsoDict) toDict(term, type, to); else refresh();
  });
  // тип меняет заготовку (если её ещё не переписали) и то, как слово ищется в других падежах
  const types = typeRow(SELECTABLE, type, (t) => {
    if (input.value === suggest(type, term)) input.value = suggest(t, term);
    type = t;
    for (const b of types.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.type === t));
    input.focus();
  });
  types.prepend(el('span', 'tip-sub', 'Это:'));
  placeTip(sel.getStartPosition(), 'select', el('div', 'tip-title', `Заменить «${shorten(term, 30)}»`), row, types, dictBox());
  if (focus) { input.focus(); input.select(); }
}

function showWordTip(sp: Span) {
  if (tipMode === 'select') return;
  const key = keyOf(sp);
  const g = byKey.get(key);
  if (!g) return;
  const done = replaced(g);

  // всё в одной компактной карточке: что это → на что заменить → что ещё можно сделать
  const title = el('div', 'tip-title');
  title.append(
    el('span', `badge t-${sp.type}`, TYPE_LABEL[sp.type]),
    el('span', 'tip-word', shorten(sp.text, 28)),
    el('span', 'tip-sub', done ? `→ ${shorten(g.to, 24)}` : 'не заменяется'),
  );
  const { row } = replaceRow(g.to || suggestFor(g), 'на что заменить', (to) => {
    hideTip();
    if (alsoDict) toDict(g.dict?.term ?? g.base, sp.type, to); else setPick(g, to, true);
  });

  const act = (text: string, run: () => void, hint = '') => {
    const b = el('button', 'tip-act', text);
    if (hint) b.title = hint;
    b.onclick = () => { hideTip(); run(); };
    return b;
  };
  const acts = el('div', 'tip-actions');
  if (done) acts.append(act('Не заменять', () => setPick(g, g.to, false), g.dict ? 'Только в этом тексте: в словаре замена остаётся' : ''));
  acts.append(act(g.n > 1 ? `Все места · ${g.n}` : 'Показать', () => openWord(key, Math.max(0, occurrences(key).indexOf(sp)))));

  // не тот тип: от типа зависят заготовка и поиск других падежей
  const types = typeRow(SELECTABLE.filter((t) => t !== sp.type), null, (t) => {
    hideTip();
    if (!terms.some((d) => d.term === g.base && d.type === t)) terms.push({ term: g.base, type: t });
    refresh();
  });
  types.prepend(el('span', 'tip-sub', 'Это:'));

  placeTip(hide.original.getPositionAt(sp.start), 'word', title, row, dictBox(), acts, types);
}

const queueSelectionTip = (ms: number) => { clearTimeout(selTimer); selTimer = window.setTimeout(() => showSelectionTip(), ms); };
hide.editor.onMouseDown(() => { mouseDown = true; clearTimeout(selTimer); hideTip(); });
hide.editor.onMouseUp(() => { mouseDown = false; queueSelectionTip(60); });
// выделение с клавиатуры (Shift+стрелки): подсказка через паузу, чтобы не мелькала на каждом нажатии
hide.editor.onDidChangeCursorSelection(() => { if (tipMode === 'select') hideTip(); if (!mouseDown) queueSelectionTip(350); });
hide.editor.onDidChangeModelContent(hideTip);
hide.editor.onDidScrollChange(() => { if (tipMode) positionTip(); });
addEventListener('resize', hideTip);
hide.editor.onMouseMove((e) => {
  if (mouseDown || tipMode === 'select' || tipEl.contains(document.activeElement)) return;
  const over = e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && e.target.range;
  const off = over ? hide.original.getOffsetAt(e.target.range!.getStartPosition()) : -1;
  const sp = over ? spans.find((x) => x.start <= off && off < x.end) : undefined;
  if (!sp) { clearTimeout(tipTimer); hoverSpan = undefined; scheduleHideTip(); return; }
  if (sp.start === hoverSpan?.start) { clearTimeout(hideTimer); return; }
  hoverSpan = sp;
  clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => showWordTip(sp), 250);
});
hide.editor.onMouseLeave(() => { clearTimeout(tipTimer); hoverSpan = undefined; scheduleHideTip(); });
// клавиатура: Alt+Enter — заменить выделенное (фокус сразу в поле замены), Esc закрывает подсказку (или список вхождений)
hide.editor.addAction({
  id: 'obliviate.tip', label: 'Заменить выделенное', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Enter],
  run: () => showSelectionTip(true),
});
tipEl.onkeydown = (e) => { if (e.key === 'Escape') { hideTip(); hide.editor.focus(); } };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (tipMode) hideTip();
  else if (activeKey && !$('#occ').contains(document.activeElement)) closeOcc();
});

// ───────────── clipboard ─────────────
async function toClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast('Браузер не дал доступ к буферу — выделите текст справа и скопируйте вручную');
    return false;
  }
}
async function fromClipboard(into: monaco.editor.ITextModel) {
  try {
    const text = await navigator.clipboard.readText();
    forget();
    replaceText(into, text);
  } catch {
    toast('Браузер не дал доступ к буферу — вставьте вручную (Ctrl/⌘+V) в левое окно');
  }
}

// ───────────── файлы: кнопка «Открыть файл» и перетаскивание в окно ─────────────
/** UTF-8, UTF-16 по BOM, иначе Windows-1251 — так часто сохранены русские .srt и .txt; null — файл не текстовый */
function decode(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  if (b.includes(0)) return null; // docx, pdf, картинка
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1251').decode(b); }
}
async function openFiles(files: File[]) {
  const texts = await Promise.all(files.map(async (f) => decode(new Uint8Array(await f.arrayBuffer()))));
  const bad = files.filter((_, i) => texts[i] === null).map((f) => f.name);
  if (bad.length) toast(`Не текстовый файл: ${bad.join(', ')}`);
  const ok = texts.filter((t) => t !== null);
  if (!ok.length) return;
  forget();
  replaceText(hide.original, ok.join('\n\n'));
}
const fileInput = $<HTMLInputElement>('#file');
$('#open').onclick = $('#emptyOpen').onclick = () => fileInput.click();
fileInput.onchange = () => { openFiles([...fileInput.files!]); fileInput.value = ''; };

// перехватываем раньше Monaco, иначе он вставит имя файла в текст; рамка видна, пока файл над окном
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
let dragDepth = 0;
const dropping = (on: boolean) => document.body.classList.toggle('dropping', on);
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropping(true); } }, true);
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropping(false); } }, true);
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer!.dropEffect = 'copy'; }, true);
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.stopPropagation();
  dragDepth = 0; dropping(false);
  openFiles([...e.dataTransfer!.files]);
}, true);

// ───────────── ширина «Можно заменить»: тянется разделителем, как панели в редакторе ─────────────
const SIDE = 'obliviate:side';
const work = $('#paneHide'), split = $('#split'), side = $('#paneHide > aside');
const setSide = (px: number) => { work.style.setProperty('--side', `${Math.round(px)}px`); split.ariaValueNow = String(Math.round(side.offsetWidth)); };
const saveSide = () => st.setItem(SIDE, String(side.offsetWidth));
if (Number(st.getItem(SIDE))) setSide(Number(st.getItem(SIDE)));
split.onpointerdown = (e) => {
  e.preventDefault(); // без выделения текста во время перетаскивания
  split.setPointerCapture(e.pointerId);
  const left = work.getBoundingClientRect().left;
  split.onpointermove = (m) => setSide(m.clientX - left - split.offsetWidth / 2);
  split.onpointerup = () => { split.onpointermove = split.onpointerup = null; saveSide(); };
};
split.onkeydown = (e) => {
  const d = { ArrowLeft: -24, ArrowRight: 24 }[e.key];
  if (!d) return;
  e.preventDefault();
  setSide(side.offsetWidth + d);
  saveSide();
};
split.ondblclick = () => { work.style.removeProperty('--side'); st.removeItem?.(SIDE); };

let toastTimer: number | undefined;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.textContent = ''), 4000);
}

const COPY_LABEL = 'Скопировать результат';
let copyTimer: number | undefined;
$('#copy').onclick = async () => {
  if (!hide.original.getValue().trim()) return toast('Нечего копировать');
  const risky = groups.filter((g) => !replaced(g) && DANGEROUS.has(g.sp.type)).length;
  if (risky && !confirm(`В тексте остались незаменённые секреты (ключи, пароли): ${risky}. Всё равно скопировать?`)) return;
  if (!(await toClipboard(hide.modified.getValue()))) return;
  const b = $('#copy');
  b.textContent = 'Скопировано ✓'; b.classList.add('done');
  clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => { b.textContent = COPY_LABEL; b.classList.remove('done'); }, 1600);
  toast(outRanges.length ? `Заменено мест: ${outRanges.length}` : 'Ничего не заменено — скопирован исходный текст');
};

const EXAMPLE =
  'Привет! Клиент Иван Петров (i.petrov@acme-corp.ru, +7 916 123-45-67) из ООО «Ромашка» не может войти.\n' +
  'Сервер 10.20.30.40, логин: admin, пароль: Zx9!kLm2.\n' +
  'OPENAI_API_KEY=sk-proj-Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3gH6jK9m\n' +
  'Помоги написать ответ Ивану Петрову и объясни, в чём может быть проблема.';
$('#paste').onclick = $('#emptyPaste').onclick = () => fromClipboard(hide.original);
$('#example').onclick = $('#emptyExample').onclick = () => { forget(); replaceText(hide.original, EXAMPLE); };
$('#clear').onclick = () => {
  forget();
  replaceText(hide.original, '');
  toast('Очищено. Вернуть текст: Ctrl/⌘+Z');
  hide.editor.focus();
};

// ───────────── настройки ─────────────
const TYPES_FOR_DICT: Type[] = ['PERSON', 'ORG', 'LOC', 'SECRET', 'PASSWORD', 'LOGIN', 'API_KEY', 'HOST', 'EMAIL', 'PHONE'];
$<HTMLSelectElement>('#dictType').append(...TYPES_FOR_DICT.map((t) => new Option(TYPE_LABEL[t], t)));

// строка словаря: тип · что → на что (правится прямо здесь) · удалить
function renderDict() {
  $('#dict').replaceChildren(...dict.map((d) => {
    const li = document.createElement('li');
    if (!d.replacement.trim()) li.className = 'need';
    const word = el('span', 'word', d.term);
    word.title = d.term;
    const to = Object.assign(document.createElement('input'), { type: 'text', className: 'repl', value: d.replacement, placeholder: 'на что — пока пусто, не заменяется' });
    to.setAttribute('aria-label', `На что заменять «${d.term}»`);
    to.onchange = () => { d.replacement = to.value.trim(); persistDict(); li.classList.toggle('need', !d.replacement); refresh(); };
    const del = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Удалить' });
    del.setAttribute('aria-label', `Удалить «${d.term}»`);
    del.onclick = () => { dict = dict.filter((z) => z !== d); persistDict(); renderDict(); refresh(); };
    li.append(el('span', `badge t-${d.type}`, TYPE_LABEL[d.type]), word, el('span', 'arrow', '→'), to, del);
    return li;
  }));
}

const dictDlg = $<HTMLDialogElement>('#dictDlg');
$('#dictBtn').onclick = () => dictDlg.showModal();
$('#closeDict').onclick = () => dictDlg.close();
dictDlg.onclick = (e) => { if (e.target === dictDlg) dictDlg.close(); }; // клик по затемнённому фону закрывает окно

// новая запись: заготовка замены подставляется сама, пока её не переписали
const dictTerm = $<HTMLInputElement>('#dictTerm'), dictType = $<HTMLSelectElement>('#dictType'), dictTo = $<HTMLInputElement>('#dictTo');
let autoTo = '';
const fillTo = () => { if (dictTo.value === autoTo) dictTo.value = autoTo = suggest(dictType.value as Type, dictTerm.value.trim()); };
dictTerm.oninput = dictType.onchange = fillTo;
$<HTMLFormElement>('#dictForm').onsubmit = (e) => {
  e.preventDefault();
  const term = dictTerm.value.trim();
  if (!term) return dictTerm.focus();
  toDict(term, dictType.value as Type, dictTo.value.trim());
  dictTerm.value = dictTo.value = autoTo = '';
  dictTerm.focus();
};

setModel('loading', 'Загрузка модели…', 0);
ner.load().catch(() => {}); // модель скачивается всегда; ошибка показывается в полосе состояния
renderDict();
// текст и решения по нему с прошлого раза (если пользователь не успел начать новый)
loadSession().then((saved) => {
  if (saved?.text && !hide.original.getValue()) {
    picks = new Map(saved.picks);
    aliases = new Map(saved.aliases ?? []);
    terms = saved.terms ?? [];
    if (saved.ner?.mode === `${nerMode.value}@${__MODELS__}`) { nerFor = nerDone = saved.text; nerList = saved.ner.spans; }
    setValue(hide.original, saved.text);
  }
}).finally(() => { restored = true; refresh(); });

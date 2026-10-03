import { entityKey } from './replace';

// Common first names, full and colloquial, in the nominative; other case forms match through entityKey ("Дане", "Лёхой").
// Surnames and patronymics are deliberately absent: "Иван Иванов", "Георгий Павлович" identify a person, "Иван", "Даня", "Иван И." do not.
const LIST = `
Александр Алексей Альберт Анатолий Андрей Антон Аркадий Арсений Арсен Артём Артемий Артур Богдан Борис Вадим Валентин Валерий Василий
Вениамин Виктор Виталий Владимир Владислав Владлен Всеволод Вячеслав Геннадий Георгий Герман Глеб Гордей Григорий Давид Даниил Данил
Демид Денис Дмитрий Евгений Егор Елисей Ефим Захар Иван Игнат Игорь Илья Кирилл Константин Лев Леонид Максим Марк Матвей Мирон Михаил
Никита Николай Олег Остап Павел Пётр Платон Прохор Родион Роман Ростислав Руслан Савелий Святослав Семён Сергей Станислав Степан Тарас
Тимофей Тимур Трофим Фёдор Феликс Филипп Эдуард Эмиль Эрик Юлиан Юрий Яков Ян Ярослав
Адам Азат Айдар Алан Амир Арслан Ахмед Ашот Аслан Гарик Данияр Ерлан Ильдар Ильнур Камиль Магомед Марат Мурат Нурлан Олжас Равиль Рамиль
Ренат Ринат Рустам Тагир Шамиль Эльдар
Саша Саня Санёк Сашка Шура Лёша Лёха Лёшка Алёша Толя Толик Андрюха Андрюша Антоша Тоша Аркаша Сеня Тёма Боря Вадик Валера Вася Васёк
Витя Витёк Виталик Вова Вовка Вовчик Володя Влад Владик Слава Славик Гена Геша Гоша Жора Гриша Даня Данька Дэн Денчик Дима Димка Димас
Димон Митя Женя Женёк Егорка Ваня Ванька Ванёк Илюша Илюха Киря Костя Костик Лёва Лёня Макс Миша Мишаня Миха Никитос Коля Колян Колька
Олежка Паша Пашка Петя Петька Рома Ромка Ромчик Русик Сёма Серёжа Серёга Стас Стасик Стёпа Тима Тимоха Федя Эдик Юра Юрка Ярик Яша
Александра Алина Алла Алёна Алиса Альбина Анастасия Ангелина Анна Антонина Арина Валентина Валерия Варвара Василиса Вера Вероника
Виктория Галина Дарья Диана Ева Евгения Екатерина Елена Елизавета Жанна Зинаида Злата Зоя Инна Ирина Карина Кира Кристина Ксения
Лариса Лидия Лилия Любовь Людмила Майя Маргарита Марина Мария Милана Надежда Наталья Наталия Нелли Нина Оксана Олеся Ольга Полина Раиса
Регина Римма Светлана Снежана София Софья Стефания Таисия Тамара Татьяна Ульяна Эвелина Элина Эльвира Эльмира Юлия Яна Ярослава
Айгуль Айдана Алия Асель Гульнара Динара Зарина Камила Лейла Мадина Сабина Фатима Зульфия
Аля Алёнка Настя Ася Аня Анечка Анька Нюра Варя Валя Лера Ника Вика Галя Даша Дашка Дина Катя Катюша Катюха Катька Лена Ленка Лиза
Лизка Зина Ира Ирка Иришка Ксюша Ксюха Лара Лида Лиля Люба Люда Мила Рита Маша Машка Маруся Надя Наташа Наташка Ната Оля Олька Поля
Света Светка Соня Сонька Тома Таня Танька Тася Уля Юля Юлька
John Michael David Mark James Robert Peter Paul Tom Daniel Chris Alex Mike Sarah Kate Anna Maria Emma Olivia Olga
`;

let keys: Set<string> | undefined;
const nameKeys = () => (keys ??= new Set(LIST.trim().split(/\s+/).map((n) => entityKey('PERSON', n))));
const isName = (w: string) => nameKeys().has(entityKey('PERSON', w));
const INITIALS = /^(?:\p{Lu}\.)+$/u;

/** "Даня", "Лёхе", "Иван И.", "И. И.": nobody can be told by it — no surname, no patronymic, nothing unknown */
export function justName(value: string): boolean {
  const ws = value.trim().split(/\s+/);
  return ws.every((w) => INITIALS.test(w) || isName(w)) && ws.some((w) => isName(w) || ws.length > 1);
}

/** one edit apart: a letter replaced, added, dropped, or two neighbours swapped */
function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const NAMED = /^(?:PERSON|ORG|LOC):/;
/**
 * Two rows that are probably one entity misspelt: "Зина" / "Зида", "Иванов" / "Ивонов" (entity keys, so case forms are already one).
 * Two different known first names are two people: "Ваня" / "Таня".
 */
export function similarKeys(a: string, b: string): boolean {
  if (!NAMED.test(a) || a.slice(0, a.indexOf(':')) !== b.slice(0, b.indexOf(':'))) return false;
  // word by word: "Зина Петровна Иванова" / "Зида Петровна Ивонова" — every word the same or one edit apart
  const xs = a.slice(a.indexOf(':') + 1).split(' '), ys = b.slice(b.indexOf(':') + 1).split(' ');
  if (xs.length !== ys.length) return false;
  const names = nameKeys(), pk = (k: string) => `PERSON:${k}`;
  let differ = 0;
  for (const [i, x] of xs.entries()) {
    const y = ys[i];
    if (x === y) continue;
    if (Math.min(x.length, y.length) < 3 || !oneEdit(x, y) || (names.has(pk(x)) && names.has(pk(y)))) return false;
    differ++;
  }
  return differ > 0;
}


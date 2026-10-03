export const TYPES = [
  'PERSON', 'ORG', 'LOC',
  'EMAIL', 'PHONE', 'TELEGRAM',
  'IP', 'MAC', 'HOST',
  'API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'LOGIN', 'PRIVATE_KEY',
] as const;
export type Type = (typeof TYPES)[number];

/** Понятные человеку названия типов для интерфейса (в самом тексте остаются [PERSON_1] и т. п.) */
export const TYPE_LABEL: Record<Type, string> = {
  PERSON: 'Имя', ORG: 'Компания', LOC: 'Место',
  EMAIL: 'Почта', PHONE: 'Телефон', TELEGRAM: 'Телеграм',
  IP: 'IP-адрес', MAC: 'MAC-адрес', HOST: 'Сервер',
  API_KEY: 'Ключ доступа', TOKEN: 'Токен', SECRET: 'Секрет', PASSWORD: 'Пароль', LOGIN: 'Логин', PRIVATE_KEY: 'Закрытый ключ',
};

export type Source = 'manual' | 'dict' | 'regex' | 'ner';

export interface Span {
  start: number;
  end: number;
  type: Type;
  /** exact text of the span in the input */
  text: string;
  /** canonical value: the dictionary term, else `text` */
  value: string;
  source: Source;
  /** tie-break when two spans have the same length: higher wins */
  prio: number;
  /** the model's mean confidence (ner only) */
  score?: number;
}

/** global dictionary: every case form of `term` is replaced with `replacement` (an empty one is kept but not applied) */
export interface DictEntry extends Term {
  replacement: string;
}

/** a word to look for in every case form */
export interface Term {
  term: string;
  type: Type;
}

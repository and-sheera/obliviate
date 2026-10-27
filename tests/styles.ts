// What must hold on the texts of tests/styles (sources: tests/styles/README.md), written down after reading what the detector finds.
// Not the whole truth about these texts: only what is certain. Everything else is in the snapshots tests/styles/found/*.txt,
// whose diff shows what a change of the detector did (npx vitest run tests/styles.test.ts -u accepts it).
export interface StyleCase {
  /** names (as written in the text) that must be hidden */
  per?: string[];
  /** words that must never be hidden: headings, ordinary words with a capital, interjections, and companies (they are not looked for) */
  keep?: string[];
  /** nothing at all may be found: a clean text */
  none?: true;
}

export const styles: Record<string, StyleCase> = {
  // lowercase chat: a company in lowercase is found, its names ("оля", "дядя слава") are out of reach; the snapshot shows that nothing else is found
  'forum-dialogues': { keep: ['сбербанк'] },
  'law-constitution': { keep: ['Статья', 'Президент', 'Государственной Думой'] },
  'lit-chekhov': { per: ['Очумелов', 'Хрюкина', 'Пичугина', 'Жигалова'] },
  'lit-gogol': { per: ['Артемий Филиппович', 'Лука Лукич', 'Антон Антонович', 'Анна Кирилловна', 'Иван Кириллович'], keep: ['Ну'] },
  'lit-tolstoy': { per: ['Кутузова', 'Багратиону', 'Наполеона'] },
  'news-wikinews-0': { per: ['Андраник Маргарян', 'Эмиля Лахуда'], keep: ['Медиамакс'] },
  'news-wikinews-1': { keep: ['РЕН ТВ'] },
  'news-wikinews-2': { per: ['Скотт Моррисон'] },
  'wiki-biography': { per: ['Сергей Павлович Королёв', 'Юрием Гагариным', 'Павла Яковлевича Королёва', 'Николай Яковлевич Москаленко'], keep: ['Биография', 'Детство', 'НКВД'] },
  'wiki-city': { keep: ['История', 'Этимология'] },
  'wiki-company': { per: ['Аркадий Волож', 'Илья Сегалович'], keep: ['Яндекс', 'Сбербанк'] },
  'wiki-football': { per: ['Владимир Фалин', 'Юрий Морозов', 'Виталий Мутко', 'Леонид Генусов'], keep: ['Вопрос', 'Зенита'] },
  'wiki-science': { keep: ['Bayer', 'Применение', 'Лечение'] },
  'wiki-tech': { per: ['Ларри Маквой', 'Эндрю Триджелл'], keep: ['Метод', 'Возможности', 'Особенности'] },
};

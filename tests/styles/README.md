# Texts of different styles (regression)

Excerpts of 2–6 KB, kept to watch the detector (`src/core/guess.ts`) over a change: `npx vitest run tests/styles.test.ts`.
What must hold is in [`../styles.ts`](../styles.ts); everything the detector finds is in `found/*.txt` (a diff of these files is the regression;
`-u` accepts a change after you have looked at it). A new text: put it here, add a line to `styles.ts`, run with `-u`, read `found/<text>.txt`.

| file | style | source | licence |
|---|---|---|---|
| `wiki-company`, `wiki-biography`, `wiki-city`, `wiki-football`, `wiki-science`, `wiki-tech` | encyclopedia: Яндекс; Королёв, Сергей Павлович; Новосибирск; Зенит; Ацетилсалициловая кислота; Git | [ru.wikipedia.org](https://ru.wikipedia.org), beginning of the article | CC BY-SA 4.0, authors in the page history |
| `law-constitution` | law: the preamble and articles 83–… | [Конституция Российской Федерации, ru.wikisource.org](https://ru.wikisource.org/wiki/Конституция_Российской_Федерации) | an official text, not an object of copyright (Civil Code of the RF, art. 1259) |
| `lit-chekhov` | prose, a dialogue in a market square: «Хамелеон», А. П. Чехов, 1884 | [ru.wikisource.org](https://ru.wikisource.org/wiki/Хамелеон_(Чехов)) | public domain |
| `lit-gogol` | a play, speakers' labels: «Ревизор», Н. В. Гоголь, 1836, act I | [ru.wikisource.org](https://ru.wikisource.org/wiki/Ревизор_(Гоголь)/Действие_I) | public domain |
| `lit-tolstoy` | a novel, patronymics and ranks: «Война и мир», Л. Н. Толстой, vol. 1 | [ru.wikisource.org](https://ru.wikisource.org/wiki/Война_и_мир_(Толстой)/Том_I/Часть_I/Глава_I) | public domain |
| `news-wikinews-0` | news, 2001: «Президент Ливана и премьер-министр Армении заявили о необходимости развития экономического сотрудничества» | PanARMENIAN.Net via [ru.wikinews.org](https://ru.wikinews.org) | CC BY 3.0 |
| `news-wikinews-1` | news, 2021: «Власти Абу-Даби освободили прилетающих россиян от обязательного карантина», А. Малышева | Klops.ru via ru.wikinews.org | CC BY-SA 4.0 |
| `news-wikinews-2` | news, 2016: «Власти Австралии боятся, что местное ранчо размером с четыре Крыма купят китайцы» | NEWSru.com via ru.wikinews.org | CC BY 4.0 |
| `forum-dialogues` | informal chat in lowercase, no names to find (28 question–answer pairs, offensive ones left out) | [Den4ikAI/russian_dialogues](https://huggingface.co/datasets/Den4ikAI/russian_dialogues) | MIT |

Missing on purpose: texts with personal data of real people (letters, chats, contracts) — they would not be free to publish.
The synthetic ones are in `../texts.ts`; the minutes of a real meeting (an `.srt` of 118 KB) was the first test of this kind and lives in an untracked `example.txt`.

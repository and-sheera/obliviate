import { describe, it, expect } from 'vitest';
import { guess } from '../src/core/guess';

const found = (text: string) => guess(text).map((s) => `${s.type}:${s.text}`);

describe('people and places without a model', () => {
  it('finds people by the lexicon, the patronymic and the surname ending', () => {
    expect(found('Позвони Ивану Петрову завтра.')).toEqual(['PERSON:Ивану Петрову']);
    expect(found('Кузнецова Валерия Игоревна подписала договор.')).toEqual(['PERSON:Кузнецова Валерия Игоревна']);
    expect(found('Пришёл Ковалёв и сел.')).toEqual(['PERSON:Ковалёв']);
  });
  it('finds a person at the start of a sentence only when something vouches for them', () => {
    expect(found('Иванов пришёл.')).toEqual(['PERSON:Иванов']);
    expect(found('Причина в том, что Запуск отложили.')).toEqual([]); // a capital in the middle of a sentence is a proper noun, but neither a person nor a place
    expect(found('Запуск отложили.')).toEqual([]);
  });
  it('knows places', () => {
    expect(found('Мы летим в Москву, а потом в Сочи.')).toEqual(['LOC:Москву', 'LOC:Сочи']);
    expect(found('Договор подписан в США и в СССР.')).toEqual(['LOC:США', 'LOC:СССР']);
  });
  it('does not look for companies, however well known, anywhere in the sentence or in lowercase', () => {
    expect(found('Сбербанк объявил о выплате дивидендов.')).toEqual([]);
    expect(found('Договор с КамАЗом и МТС подписан, Тинькофф и Альфа-Банк снизили ставки.')).toEqual([]);
    expect(found('сбербанк опять не работает, написал в вайлдберриз')).toEqual([]);
    expect(found('Что лучше: Яндекс Маркет или Озон?')).toEqual([]);
    expect(found('база клиентов «Детского мира» и команда «Ростелекома»')).toEqual([]);
    expect(found('Позвонил в ООО «Ромашка» и АО Северсталь, пишу в Газпром.')).toEqual([]);
  });
  it('leaves headings, questions, the calendar and ordinary words alone', () => {
    expect(found('Цели Проекта\nЗадачи Команды')).toEqual([]);
    expect(found('Как открыть вклад? Какие документы нужны?')).toEqual([]);
    expect(found('В Январе много выходных, День Победы отмечают 9 мая.')).toEqual([]);
    expect(found('Нужно 32 ГБ памяти, группа ИВТ-21.')).toEqual([]);
    expect(found('Спасибо, Заказчику всё отправили.')).toEqual([]);
  });
  it('knows a speaker\'s tag, so the first word of a cue is a sentence start', () => {
    expect(found('[Евгений С.] Вызываем там обновление.\n[Андрей Ш.] Нажимаем копировать. Агент готов.')).toEqual(['PERSON:Евгений', 'PERSON:Андрей']);
  });
  it('reads a latin letter inside a russian word as the russian one', () => {
    expect(found('сказал Лёхa Шерстнёв, короче')).toEqual(['PERSON:Лёхa Шерстнёв']);
  });
  it('finds names written in lowercase and in latin', () => {
    expect(found('меня зовут анна смирнова, пишу про паспорт')).toEqual(['PERSON:анна смирнова']);
    expect(found('Автор Konstantin Vlasov выложил код')).toEqual(['PERSON:Konstantin Vlasov']);
    expect(found('Установи Visual Studio Code')).toEqual([]);
    expect(found('нужны тестовых данных и кодовой базе')).toEqual([]);
    expect(found('привет, дмитрий козлов и татьяну козлову')).toEqual(['PERSON:дмитрий козлов', 'PERSON:татьяну козлову']);
    expect(found('под торговой маркой')).toEqual([]);
  });
});

// Память + интервальное повторение (spaced repetition, схема Лейтнера).
// Всё хранится в localStorage. Правильные слова уходят на длинные интервалы,
// ошибочные возвращаются скоро и дополнительно переспрашиваются внутри сессии.

import { settings } from './config.js';

const LS_KEY = 'engwords_memory_v1';

// Интервалы по "коробкам" (в минутах). Чем выше коробка — тем реже повтор.
const BOX_INTERVALS_MIN = [1, 10, 60, 360, 1440, 4320, 10080]; // 1м,10м,1ч,6ч,1д,3д,7д
const MAX_BOX = BOX_INTERVALS_MIN.length - 1;
const KNOWN_BOX = 4; // с этой коробки считаем слово "выученным"

// Через сколько ДРУГИХ слов переспросить ошибочное слово внутри сессии.
const REASK_AFTER = 3;

function now() { return Date.now(); }

let store = load();
let itemsAsked = 0;            // счётчик заданных слов за сессию
let sessionQueue = [];         // [{en, after}] — внутрисессионные переспросы
let lastAskedEn = null;        // чтобы не задавать то же слово два раза подряд

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return raw.words ? raw : { words: {}, themes: [] };
  } catch {
    return { words: {}, themes: [] };
  }
}

function persist() {
  localStorage.setItem(LS_KEY, JSON.stringify(store));
}

export function resetSession() {
  itemsAsked = 0;
  sessionQueue = [];
  lastAskedEn = null;
}

// Добавить/получить слово.
export function addWord(en, ru, theme = '') {
  en = en.toLowerCase().trim();
  ru = ru.toLowerCase().trim();
  if (!store.words[en]) {
    store.words[en] = {
      en, ru, theme,
      box: 0,
      due: now(),
      correct: 0,
      wrong: 0,
      seen: 0,
      created: now(),
      lastSeen: 0,
    };
    if (theme) {
      store.themes.unshift(theme);
      store.themes = store.themes.slice(0, 12);
    }
    persist();
  }
  return store.words[en];
}

// Записать результат ответа.
export function recordResult(en, correct) {
  en = en.toLowerCase().trim();
  const w = store.words[en];
  if (!w) return;
  w.seen++;
  w.lastSeen = now();
  if (correct) {
    w.correct++;
    w.box = Math.min(w.box + 1, MAX_BOX);
  } else {
    w.wrong++;
    w.box = Math.max(w.box - 1, 0);
    // переспросить это слово ещё раз внутри текущей сессии
    sessionQueue.push({ en, after: itemsAsked + REASK_AFTER });
  }
  w.due = now() + BOX_INTERVALS_MIN[w.box] * 60 * 1000;
  persist();
}

// Выбрать следующую цель.
// Возвращает {type:'review', word} либо {type:'new'} (приложение сгенерит слово).
export function pickNext() {
  itemsAsked++;

  // 1) Внутрисессионный переспрос ошибочного слова.
  const ready = sessionQueue.findIndex(q => q.after <= itemsAsked && q.en !== lastAskedEn);
  if (ready !== -1) {
    const { en } = sessionQueue.splice(ready, 1)[0];
    if (store.words[en]) {
      lastAskedEn = en;
      return { type: 'review', word: store.words[en] };
    }
  }

  // 2) Слова, которые "подошли" по времени.
  const due = Object.values(store.words)
    .filter(w => w.due <= now() && w.en !== lastAskedEn)
    .sort((a, b) => a.due - b.due);

  const haveWords = Object.keys(store.words).length > 0;

  // Решаем: новое слово или повторение.
  // Если накопилось много просроченных — приоритет повторению.
  let wantNew;
  if (!haveWords) wantNew = true;
  else if (due.length >= 5) wantNew = false;
  else if (due.length === 0) wantNew = true;
  else wantNew = Math.random() < (settings.newWordRatio ?? 0.3);

  if (!wantNew && due.length) {
    lastAskedEn = due[0].en;
    return { type: 'review', word: due[0] };
  }
  return { type: 'new' };
}

export function markAsked(en) {
  lastAskedEn = en.toLowerCase().trim();
}

// Список уже виденных слов (для анти-повтора при генерации новых).
export function seenEnglish(limit = 60) {
  return Object.values(store.words)
    .sort((a, b) => b.created - a.created)
    .slice(0, limit)
    .map(w => w.en);
}

export function recentThemes(limit = 6) {
  return store.themes.slice(0, limit);
}

// Статистика для интерфейса.
export function stats() {
  const all = Object.values(store.words);
  return {
    total: all.length,
    known: all.filter(w => w.box >= KNOWN_BOX).length,
    learning: all.filter(w => w.box >= 1 && w.box < KNOWN_BOX).length,
    fresh: all.filter(w => w.box === 0).length,
    dueNow: all.filter(w => w.due <= now()).length,
  };
}

// Экспорт / импорт всей памяти (бэкап).
export function exportJSON() {
  return JSON.stringify(store, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  if (!data.words) throw new Error('Неверный формат файла');
  store = { words: data.words, themes: data.themes || [] };
  persist();
}

export function wipe() {
  store = { words: {}, themes: [] };
  persist();
  resetSession();
}

// Клиент локального XTTS-сервера. Никаких фолбэков — только XTTS.
// Текст с миксом языков (рус + англ) режется на куски по алфавиту,
// каждый озвучивается на своём языке тем же голосом, и куски играют по порядку.

import { settings } from './config.js';

let stopped = false;
let currentAudio = null;

// Проверка, что локальный сервер жив. Бросает ошибку, если нет.
export async function health() {
  const res = await fetch(settings.ttsUrl + '/health', { method: 'GET' });
  if (!res.ok) throw new Error('TTS health ' + res.status);
  return res.json();
}

export async function getSpeakers() {
  const res = await fetch(settings.ttsUrl + '/speakers', { method: 'GET' });
  if (!res.ok) throw new Error('TTS speakers ' + res.status);
  const d = await res.json();
  return d.speakers || [];
}

// Озвучить текст. Возвращает промис, который резолвится после полного проигрывания.
export async function speak(text) {
  stopped = false;
  const segments = splitByLang(text);
  for (const seg of segments) {
    if (stopped) break;
    const blob = await synth(seg.text, seg.lang);
    if (stopped) break;
    await playBlob(blob);
  }
}

export function stopSpeaking() {
  stopped = true;
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    currentAudio = null;
  }
}

async function synth(text, lang) {
  const res = await fetch(settings.ttsUrl + '/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: lang, speaker: settings.speaker }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('TTS ' + res.status + ': ' + t.slice(0, 200));
  }
  return res.blob();
}

function playBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio playback error')); };
    audio.play().catch(reject);
  });
}

// Разбивка текста на сегменты по языку.
// Кириллица -> 'ru', латиница -> 'en'. Пунктуация/пробелы/цифры цепляются к текущему сегменту.
export function splitByLang(text) {
  const tokens = text.match(/[Ѐ-ӿ]+|[A-Za-z]+|[^Ѐ-ӿA-Za-z]+/g) || [];
  const segs = [];
  let cur = null;
  for (const tok of tokens) {
    let lang = null;
    if (/[Ѐ-ӿ]/.test(tok)) lang = 'ru';
    else if (/[A-Za-z]/.test(tok)) lang = 'en';

    if (lang === null) {
      // пунктуация/пробел/цифры — приклеиваем к текущему сегменту
      if (cur) cur.text += tok;
      else cur = { lang: 'ru', text: tok };
      continue;
    }
    if (cur && cur.lang === lang) {
      cur.text += tok;
    } else {
      if (cur) segs.push(cur);
      cur = { lang, text: tok };
    }
  }
  if (cur) segs.push(cur);
  return segs.filter(s => s.text.trim().length > 0);
}

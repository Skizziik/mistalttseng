// Распознавание речи через встроенный в браузер Web Speech API.
// Работает в Chrome/Edge (на Windows 11 — отлично). Требует HTTPS или localhost.
// Хендс-фри: само определяет, что ты замолчал.

import { settings } from './config.js';

let recognizer = null;

export function isSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Слушать одну реплику. onInterim(text) — живые промежуточные результаты.
// Возвращает промис с финальным текстом (может быть пустым, если ничего не услышал).
export function listen({ onInterim, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { reject(new Error('SPEECH_NOT_SUPPORTED')); return; }

    const r = new SR();
    recognizer = r;
    r.lang = settings.recogLang || 'en-US';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;

    let finalText = '';
    let lastInterim = '';
    let done = false;
    let timer = null;

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      recognizer = null;
      try { r.stop(); } catch {}
      resolve(value.trim());
    };

    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      lastInterim = interim;
      if (onInterim) onInterim((finalText + ' ' + interim).trim());
    };

    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') {
        finish(finalText || lastInterim);
      } else if (!done) {
        done = true;
        clearTimeout(timer);
        recognizer = null;
        reject(new Error(e.error || 'speech-error'));
      }
    };

    r.onend = () => finish(finalText || lastInterim);

    try { r.start(); } catch (err) { reject(err); return; }

    // Страховочный таймаут на случай, если onend не сработает.
    timer = setTimeout(() => { try { r.stop(); } catch {} }, timeoutMs);
  });
}

// Прервать прослушивание (например, по кнопке "Стоп").
export function stopListening() {
  if (recognizer) {
    try { recognizer.abort(); } catch {}
    recognizer = null;
  }
}

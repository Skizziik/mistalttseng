// Клиент Mistral API. Вызывается напрямую из браузера (CORS разрешён Mistral).
import { settings } from './config.js';
import { NEW_WORD_SYSTEM, newWordDirective } from './prompts.js';

const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const TRANSCRIBE_ENDPOINT = 'https://api.mistral.ai/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = 'voxtral-mini-latest';

async function chat(messages, { json = true, maxTokens = 400, temperature = 0.6 } = {}) {
  if (!settings.mistralKey) throw new Error('NO_KEY');

  const body = {
    model: settings.model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + settings.mistralKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Mistral ' + res.status + ': ' + t.slice(0, 300));
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// Основной диалоговый вызов: на вход история сообщений, на выход — распарсенный JSON.
export async function chatJSON(messages, opts) {
  const content = await chat(messages, opts);
  return safeParse(content);
}

// Отдельный вызов: сгенерировать новое слово A2 (своя короткая сессия, не трогает историю диалога).
export async function generateWord(seenList, recentThemes) {
  const messages = [
    { role: 'system', content: NEW_WORD_SYSTEM },
    { role: 'user', content: newWordDirective(seenList, recentThemes) },
  ];
  const content = await chat(messages, { json: true, maxTokens: 80, temperature: 1.0 });
  const w = safeParse(content);
  if (!w.en || !w.ru) throw new Error('bad word from model: ' + content);
  return {
    en: String(w.en).trim().toLowerCase(),
    ru: String(w.ru).trim().toLowerCase(),
    theme: (w.theme || '').toString().trim().toLowerCase(),
  };
}

// Транскрипция аудио через Voxtral. lang='' => авто-определение (ловит смесь RU+EN).
export async function transcribe(blob, lang = '') {
  if (!settings.mistralKey) throw new Error('NO_KEY');
  const fd = new FormData();
  fd.append('model', TRANSCRIBE_MODEL);
  fd.append('file', blob, 'speech.wav');
  if (lang) fd.append('language', lang);

  const res = await fetch(TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + settings.mistralKey }, // Content-Type выставит браузер сам
    body: fd,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Mistral STT ' + res.status + ': ' + t.slice(0, 300));
  }
  const data = await res.json();
  return (data.text || '').trim();
}

function safeParse(content) {
  try {
    return JSON.parse(content);
  } catch {
    // На случай, если модель обернула в текст — выдёргиваем первый {...}.
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Не удалось разобрать JSON от модели: ' + content.slice(0, 200));
  }
}

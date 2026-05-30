// Клиент Mistral API. Вызывается напрямую из браузера (CORS разрешён Mistral).
// Есть троттлинг (паузы между запросами) и автоповтор при 429/5xx — чтобы не ловить
// rate limit бесплатного тарифа.
import { settings } from './config.js';
import { NEW_WORD_SYSTEM, newWordDirective } from './prompts.js';

const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const TRANSCRIBE_ENDPOINT = 'https://api.mistral.ai/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = 'voxtral-mini-latest';

const MIN_GAP_MS = 1100; // минимальный интервал между запросами к Mistral

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Последовательная очередь с выдержкой паузы между вызовами.
let gate = Promise.resolve();
let lastAt = 0;
function withGate(fn) {
  const run = async () => {
    const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return fn();
  };
  const next = gate.then(run, run);
  // не даём очереди застрять на ошибке
  gate = next.catch(() => {});
  return next;
}

// fetch с автоповтором на 429 и 5xx (экспоненциальный backoff, уважает Retry-After).
async function fetchRetry(url, init, tries = 4) {
  let last = 0;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, init);
    if (res.status === 429 || res.status >= 500) {
      last = res.status;
      const ra = parseFloat(res.headers.get('retry-after') || '');
      const backoff = ra > 0 ? ra * 1000 : Math.min(9000, 900 * Math.pow(2, i));
      await sleep(backoff);
      continue;
    }
    return res;
  }
  const e = new Error('Mistral ' + last + ': лимит запросов (повторы исчерпаны)');
  e.rateLimited = true;
  throw e;
}

async function chat(messages, { json = true, maxTokens = 400, temperature = 0.6 } = {}) {
  if (!settings.mistralKey) throw new Error('NO_KEY');

  const body = { model: settings.model, messages, max_tokens: maxTokens, temperature };
  if (json) body.response_format = { type: 'json_object' };

  const res = await withGate(() => fetchRetry(ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + settings.mistralKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Mistral ' + res.status + ': ' + t.slice(0, 300));
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

export async function chatJSON(messages, opts) {
  return safeParse(await chat(messages, opts));
}

// Резервный отдельный генератор слова (в основном цикле слово теперь приходит вместе
// с вопросом, но функция оставлена на всякий случай).
export async function generateWord(seenList, recentThemes) {
  const content = await chat([
    { role: 'system', content: NEW_WORD_SYSTEM },
    { role: 'user', content: newWordDirective(seenList, recentThemes) },
  ], { json: true, maxTokens: 80, temperature: 1.0 });
  const w = safeParse(content);
  if (!w.en || !w.ru) throw new Error('bad word from model: ' + content);
  return { en: String(w.en).trim().toLowerCase(), ru: String(w.ru).trim().toLowerCase(), theme: (w.theme || '').toString().trim().toLowerCase() };
}

// Транскрипция аудио через Voxtral. lang='' => авто-определение (ловит смесь RU+EN).
export async function transcribe(blob, lang = '') {
  if (!settings.mistralKey) throw new Error('NO_KEY');
  const fd = new FormData();
  fd.append('model', TRANSCRIBE_MODEL);
  fd.append('file', blob, 'speech.wav');
  if (lang) fd.append('language', lang);

  const res = await withGate(() => fetchRetry(TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + settings.mistralKey }, // boundary браузер выставит сам
    body: fd,
  }));
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
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Не удалось разобрать JSON от модели: ' + content.slice(0, 200));
  }
}

// Клиент локального XTTS-сервера. Никаких фолбэков — только XTTS.
// Фраза с миксом языков режется на куски по алфавиту (рус/англ), каждый кусок
// синтезируется на своём языке, затем все куски СКЛЕИВАЮТСЯ в один аудио-буфер и
// проигрываются единым потоком — без пауз и «прыжков» между кусками.

import { settings } from './config.js';

let audioCtx = null;
let currentSource = null;
let stopped = false;

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

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

// Озвучить текст. Промис резолвится после полного проигрывания.
export async function speak(text) {
  stopped = false;
  const segs = splitByLang(text);
  if (!segs.length) return;

  const c = ctx();
  if (c.state === 'suspended') await c.resume();

  // Синтез каждого куска -> декодирование в AudioBuffer.
  const buffers = [];
  for (const seg of segs) {
    if (stopped) return;
    const blob = await synth(seg.text, seg.lang);
    if (stopped) return;
    const arr = await blob.arrayBuffer();
    const buf = await c.decodeAudioData(arr);
    buffers.push(buf);
  }
  if (stopped || !buffers.length) return;

  const combined = concatBuffers(c, buffers);
  await playBuffer(c, combined);
}

export function stopSpeaking() {
  stopped = true;
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch {}
    currentSource = null;
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

// Склейка нескольких AudioBuffer в один (с маленькой паузой между кусками для разборчивости).
function concatBuffers(c, buffers) {
  const gap = Math.floor(c.sampleRate * 0.06); // 60 мс между кусками
  const channels = Math.max(...buffers.map(b => b.numberOfChannels));
  let total = 0;
  for (const b of buffers) total += b.length + gap;
  const out = c.createBuffer(channels, total, c.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const data = out.getChannelData(ch);
    let off = 0;
    for (const b of buffers) {
      const src = b.getChannelData(Math.min(ch, b.numberOfChannels - 1));
      data.set(src, off);
      off += b.length + gap;
    }
  }
  return out;
}

function playBuffer(c, buffer) {
  return new Promise((resolve) => {
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    currentSource = src;
    src.onended = () => { if (currentSource === src) currentSource = null; resolve(); };
    src.start();
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
      if (cur) cur.text += tok;
      else cur = { lang: 'ru', text: tok };
      continue;
    }
    if (cur && cur.lang === lang) cur.text += tok;
    else { if (cur) segs.push(cur); cur = { lang, text: tok }; }
  }
  if (cur) segs.push(cur);
  return segs.filter(s => s.text.trim().length > 0);
}

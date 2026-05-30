// Распознавание речи через Mistral Voxtral.
// Записываем реплику с микрофона (хендс-фри, автостоп по тишине) и шлём в Mistral.
// Voxtral многоязычный: по умолчанию язык не указываем — он сам ловит и русский,
// и английский, и их смесь.

import { settings } from './config.js';
import { transcribe } from './mistral.js';
import * as Rec from './recorder.js';

export function isSupported() {
  return Rec.isSupported();
}

// Послушать одну реплику и вернуть распознанный текст (или '' если тишина).
// onState('recording'|'transcribing') — для индикации в интерфейсе.
// onLevel(0..1) — громкость во время записи.
export async function listen({ onState, onLevel } = {}) {
  if (onState) onState('recording');
  const blob = await Rec.recordUtterance({ onLevel });
  if (!blob) return '';
  if (onState) onState('transcribing');
  const lang = settings.transcribeLang || ''; // '' => авто
  return await transcribe(blob, lang);
}

// Прервать (по кнопке "Стоп").
export function stopListening() {
  Rec.cancelRecording();
}

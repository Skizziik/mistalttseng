// Запись реплики с микрофона + детекция тишины (VAD) для хендс-фри.
// Пишем сырой PCM через WebAudio и кодируем в WAV (16-бит). WAV точно принимается
// транскрипцией Mistral, payload маленький. Голос определяется по громкости (RMS):
// как только ты замолчал на ~1.2 сек — запись останавливается сама.

let active = null; // ссылка на текущую запись для принудительной остановки

const SPEECH_RMS = 0.012;     // порог "есть речь"
const SILENCE_MS = 1200;      // столько тишины после речи => стоп
const MAX_MS = 20000;         // максимум на одну реплику
const NO_SPEECH_MS = 9000;    // если речь так и не началась — выходим пустым

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
            (window.AudioContext || window.webkitAudioContext));
}

// Записать одну реплику. onLevel(0..1) — для индикации громкости (опционально).
// Возвращает Blob(audio/wav) или null, если ничего не сказано.
export async function recordUtterance({ onLevel } = {}) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx, stream, source, processor;

  const stream0 = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  stream = stream0;

  // Просим 16 кГц; если браузер проигнорит — возьмём фактическую частоту в WAV-заголовок.
  ctx = new AC({ sampleRate: 16000 });
  if (ctx.state === 'suspended') await ctx.resume();
  source = ctx.createMediaStreamSource(stream);
  processor = ctx.createScriptProcessor(4096, 1, 1);

  const sampleRate = ctx.sampleRate;
  const chunks = [];
  let speechStarted = false;
  let lastVoice = 0;
  const t0 = Date.now();

  return await new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      try { processor.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      try { ctx.close(); } catch {}
      if (active === api) active = null;
    };

    const finish = (gotSpeech) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!gotSpeech || chunks.length === 0) { resolve(null); return; }
      resolve(encodeWav(chunks, sampleRate));
    };

    processor.onaudioprocess = (e) => {
      if (finished) return;
      const input = e.inputBuffer.getChannelData(0);
      // копируем (буфер переиспользуется браузером)
      chunks.push(new Float32Array(input));

      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      if (onLevel) onLevel(Math.min(1, rms * 8));

      const now = Date.now();
      if (rms > SPEECH_RMS) {
        speechStarted = true;
        lastVoice = now;
      }

      if (speechStarted && now - lastVoice > SILENCE_MS) { finish(true); return; }
      if (now - t0 > MAX_MS) { finish(speechStarted); return; }
      if (!speechStarted && now - t0 > NO_SPEECH_MS) { finish(false); return; }
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    const api = {
      stop: () => finish(speechStarted),
      cancel: () => { finished = true; cleanup(); resolve(null); },
    };
    active = api;
  });
}

export function stopRecording() { if (active) active.stop(); }
export function cancelRecording() { if (active) active.cancel(); }

// Float32-чанки -> WAV (PCM16, моно).
function encodeWav(chunks, sampleRate) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const pcm = new Int16Array(length);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      let s = Math.max(-1, Math.min(1, c[i]));
      pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buf);
  const wr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  wr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  wr(8, 'WAVE');
  wr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // моно
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) view.setInt16(off, pcm[i], true);
  return new Blob([view], { type: 'audio/wav' });
}

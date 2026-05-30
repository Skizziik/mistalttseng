// Главный модуль: связывает интерфейс, диалоговый цикл, голос, слух и память.
import { settings, updateSettings } from './js/config.js';
import { chatJSON, generateWord } from './js/mistral.js';
import * as TTS from './js/tts.js';
import * as STT from './js/stt.js';
import * as Mem from './js/memory.js';
import {
  SYSTEM_PROMPT, introDirective, askDirective, gradeDirective,
} from './js/prompts.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const orb = $('orb');
const startBtn = $('startBtn');
const statusText = $('statusText');
const interimEl = $('interim');
const logEl = $('log');

// ---------- Состояние ----------
let running = false;
let history = [];
let currentTarget = null;

const REPEAT_PROMPTS = ['Не расслышал, повтори?', 'Ещё раз, не уловил.', 'Скажи ещё разок.'];

// ---------- UI helpers ----------
function setOrb(state) { orb.className = 'orb ' + state; }
function setStatus(text) { statusText.textContent = text; }
function setInterim(text) { interimEl.textContent = text || ''; }

function logMsg(role, text, extra = '') {
  const div = document.createElement('div');
  div.className = 'msg ' + role + (extra ? ' ' + extra : '');
  div.textContent = text;
  logEl.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function renderStats() {
  const s = Mem.stats();
  $('stTotal').textContent = s.total;
  $('stKnown').textContent = s.known;
  $('stLearning').textContent = s.learning;
  $('stDue').textContent = s.dueNow;
}

// ---------- Голос ----------
async function say(text) {
  setOrb('speaking');
  setStatus('говорю…');
  logMsg('assistant', text);
  await TTS.speak(text);
}

// Запрос к модели с ведением истории. Возвращает распарсенный объект.
async function ask(directive) {
  setOrb('thinking');
  setStatus('думаю…');
  history.push({ role: 'user', content: directive });
  const res = await chatJSON(history, { maxTokens: 350, temperature: 0.6 });
  history.push({ role: 'assistant', content: JSON.stringify(res) });
  trimHistory();
  return res;
}

function trimHistory() {
  // оставляем системный промпт + последние ~14 сообщений
  if (history.length > 15) {
    history = [history[0], ...history.slice(history.length - 14)];
  }
}

// ---------- Цикл диалога ----------
async function turnAsk(isIntro) {
  const pick = Mem.pickNext();
  let word;
  if (pick.type === 'new') {
    setOrb('thinking');
    setStatus('подбираю слово…');
    const w = await generateWord(Mem.seenEnglish(), Mem.recentThemes());
    word = Mem.addWord(w.en, w.ru, w.theme);
    Mem.markAsked(word.en);
  } else {
    word = pick.word;
  }
  currentTarget = word;
  const directive = isIntro ? introDirective(word.ru) : askDirective(word.ru);
  const res = await ask(directive);
  await say(res.say);
}

async function doListen() {
  setOrb('listening');
  setStatus('слушаю… говори');
  setInterim('');
  const transcript = await STT.listen({
    onState: (s) => setStatus(s === 'transcribing' ? 'распознаю…' : 'слушаю… говори'),
    onLevel: (lvl) => { interimEl.textContent = '🎤 ' + '▁▂▃▄▅▆▇█'.charAt(Math.floor(lvl * 7)) || ''; },
  });
  setInterim('');
  return transcript;
}

async function gradeTurn(transcript) {
  const t = currentTarget;
  const res = await ask(gradeDirective(t.ru, t.en, transcript));
  if (res.mode === 'chat') {
    await say(res.say);
    return 'chat';
  }
  // помечаем прошлую реплику пользователя как верную/неверную
  const lastUser = [...logEl.querySelectorAll('.msg.user')].pop();
  if (lastUser) lastUser.classList.add(res.correct ? 'correct' : 'wrong');

  await say(res.say);
  Mem.recordResult(t.en, !!res.correct);
  renderStats();
  return 'graded';
}

async function runLoop() {
  await turnAsk(true); // приветствие + первое слово
  while (running) {
    const transcript = await doListen();
    if (!running) break;

    if (!transcript) {
      const p = REPEAT_PROMPTS[Math.floor(Math.random() * REPEAT_PROMPTS.length)];
      await say(p);
      continue; // переспросить то же слово
    }

    logMsg('user', transcript);
    const outcome = await gradeTurn(transcript);
    if (!running) break;
    if (outcome === 'graded') {
      await turnAsk(false); // следующее слово
    }
    // 'chat' -> просто слушаем снова то же слово
  }
}

// ---------- Старт / стоп ----------
async function startSession() {
  if (!settings.mistralKey) {
    openSettings();
    setStatus('Сначала вставь ключ Mistral в настройках.');
    return;
  }
  if (!STT.isSupported()) {
    setStatus('Браузер не поддерживает распознавание речи. Открой в Chrome или Edge.');
    return;
  }

  // Проверяем локальный XTTS — без фолбэков.
  setOrb('thinking');
  setStatus('проверяю локальный голос (XTTS)…');
  try {
    await TTS.health();
  } catch {
    setOrb('idle');
    setStatus('⚠ Локальный голос не отвечает. Запусти server/run.bat и проверь адрес в настройках.');
    logMsg('system', 'XTTS-сервер недоступен по ' + settings.ttsUrl + '. Запусти server/run.bat.');
    return;
  }

  running = true;
  Mem.resetSession();
  history = [{ role: 'system', content: SYSTEM_PROMPT }];
  startBtn.textContent = 'Стоп';
  startBtn.classList.add('running');

  try {
    await runLoop();
  } catch (e) {
    console.error(e);
    handleError(e);
  } finally {
    if (running) stopSession();
  }
}

function stopSession() {
  running = false;
  STT.stopListening();
  TTS.stopSpeaking();
  startBtn.textContent = 'Начать диалог';
  startBtn.classList.remove('running');
  setOrb('idle');
  setStatus('Остановлено. Жми «Начать», чтобы продолжить.');
  setInterim('');
}

function handleError(e) {
  const msg = String(e && e.message || e);
  if (msg.includes('NO_KEY')) {
    setStatus('Нет ключа Mistral — добавь в настройках.');
  } else if (msg.startsWith('Mistral')) {
    setStatus('Ошибка Mistral: ' + msg);
    logMsg('system', msg);
  } else if (msg.startsWith('TTS')) {
    setStatus('Локальный голос отвалился. Проверь, что server/run.bat запущен.');
    logMsg('system', msg);
  } else if (msg === 'not-allowed' || msg === 'service-not-allowed') {
    setStatus('Нет доступа к микрофону. Разреши его в браузере.');
  } else {
    setStatus('Ошибка: ' + msg);
    logMsg('system', msg);
  }
}

startBtn.addEventListener('click', () => {
  if (running) stopSession();
  else startSession();
});

// ============================================================
//  НАСТРОЙКИ
// ============================================================
function openSettings() {
  $('overlay').classList.remove('hidden');
  $('settingsPanel').classList.remove('hidden');
  // заполняем поля
  $('f_key').value = settings.mistralKey;
  $('f_ttsUrl').value = settings.ttsUrl;
  $('f_recog').value = settings.transcribeLang;
  $('f_ratio').value = Math.round((settings.newWordRatio ?? 0.3) * 100);
  $('ratioVal').textContent = $('f_ratio').value;
  populateSpeakers();
  checkTts();
}
function closeSettings() {
  $('overlay').classList.add('hidden');
  $('settingsPanel').classList.add('hidden');
}

$('settingsBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);
$('overlay').addEventListener('click', closeSettings);

$('f_ratio').addEventListener('input', (e) => { $('ratioVal').textContent = e.target.value; });

$('saveSettings').addEventListener('click', () => {
  updateSettings({
    mistralKey: $('f_key').value.trim(),
    ttsUrl: $('f_ttsUrl').value.trim().replace(/\/$/, ''),
    speaker: $('f_speaker').value || settings.speaker,
    transcribeLang: $('f_recog').value,
    newWordRatio: parseInt($('f_ratio').value, 10) / 100,
  });
  closeSettings();
  setStatus('Настройки сохранены.');
});

async function populateSpeakers() {
  const sel = $('f_speaker');
  // временно берём текущий адрес из поля
  const prevUrl = settings.ttsUrl;
  settings.ttsUrl = $('f_ttsUrl').value.trim().replace(/\/$/, '') || prevUrl;
  try {
    const speakers = await TTS.getSpeakers();
    sel.innerHTML = '';
    for (const s of speakers) {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      if (s === settings.speaker) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {
    sel.innerHTML = '<option value="' + settings.speaker + '">' + settings.speaker + ' (сервер не отвечает)</option>';
  } finally {
    settings.ttsUrl = prevUrl;
  }
}

async function checkTts() {
  const el = $('ttsStatus');
  const url = $('f_ttsUrl').value.trim().replace(/\/$/, '') || settings.ttsUrl;
  const prev = settings.ttsUrl;
  settings.ttsUrl = url;
  el.textContent = 'проверяю…'; el.className = 'muted';
  try {
    const h = await TTS.health();
    el.textContent = '✓ голос на связи' + (h.cuda ? ' (GPU)' : ' (CPU)');
    el.className = 'ok';
  } catch {
    el.textContent = '✕ не отвечает — запусти server/run.bat';
    el.className = 'bad';
  } finally {
    settings.ttsUrl = prev;
  }
}

$('f_ttsUrl').addEventListener('change', () => { checkTts(); populateSpeakers(); });
$('refreshSpeakers').addEventListener('click', populateSpeakers);

$('testVoice').addEventListener('click', async () => {
  const prev = { url: settings.ttsUrl, sp: settings.speaker };
  settings.ttsUrl = $('f_ttsUrl').value.trim().replace(/\/$/, '') || settings.ttsUrl;
  settings.speaker = $('f_speaker').value || settings.speaker;
  try {
    await TTS.speak('Привет! Это твой голос. The word is apple.');
  } catch (e) {
    alert('Не получилось озвучить: ' + e.message);
  } finally {
    settings.ttsUrl = prev.url; settings.speaker = prev.sp;
  }
});

// Память: экспорт/импорт/очистка
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([Mem.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'engwords-memory.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    Mem.importJSON(await file.text());
    renderStats();
    setStatus('Память импортирована.');
  } catch (err) {
    alert('Не удалось импортировать: ' + err.message);
  }
});
$('wipeBtn').addEventListener('click', () => {
  if (confirm('Точно стереть всю память слов? Это необратимо.')) {
    Mem.wipe();
    renderStats();
  }
});

// ---------- init ----------
renderStats();
if (!settings.mistralKey) {
  setStatus('Открой ⚙ настройки: вставь ключ Mistral и запусти локальный голос.');
}

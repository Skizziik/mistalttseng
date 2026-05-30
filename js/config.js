// Настройки приложения. Хранятся в localStorage браузера.
// Ключ Mistral НИКОГДА не попадает в репозиторий — только в твой браузер.

const LS_KEY = 'engwords_settings_v1';

const defaults = {
  mistralKey: '',
  model: 'mistral-large-latest',
  ttsUrl: 'http://localhost:8020',
  speaker: 'Ana Florence',
  recogLang: 'en-US',     // язык распознавания микрофона (ответы — на английском)
  newWordRatio: 0.3,      // доля новых слов против повторения выученных
};

export const settings = Object.assign({}, defaults, loadRaw());

function loadRaw() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveSettings() {
  localStorage.setItem(LS_KEY, JSON.stringify(settings));
}

export function updateSettings(patch) {
  Object.assign(settings, patch);
  saveSettings();
}

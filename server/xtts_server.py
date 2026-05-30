"""
Локальный TTS-сервер на базе XTTS-v2 (Coqui) для голосового тренажёра английского.

Запускается на твоём ПК (RTX 4060). Сайт на GitHub Pages обращается сюда по
http://localhost:8020 и получает озвучку. Поддерживает русский и английский
одной моделью.

Важно: сайт открыт по HTTPS, а сервер локальный по HTTP. Браузер считает
loopback (localhost / 127.0.0.1) безопасным origin, но для запроса в "приватную
сеть" требует, чтобы preflight-ответ содержал заголовок
Access-Control-Allow-Private-Network: true. Мы его добавляем сами.

Endpoints:
  GET  /health           -> {"ok": true, "model": "...", "speakers": [...], "sample_rate": 24000}
  GET  /speakers         -> {"speakers": [...]}
  POST /tts              -> audio/wav
       body: {"text": "...", "language": "en"|"ru", "speaker": "Ana Florence"}
"""

import io
import os
import sys
import wave
import threading

import numpy as np
from flask import Flask, request, Response, jsonify

# Соглашаемся с лицензией Coqui XTTS заранее, чтобы не было интерактивного вопроса.
os.environ.setdefault("COQUI_TOS_AGREED", "1")

PORT = int(os.environ.get("XTTS_PORT", "8020"))
MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"
DEFAULT_SPEAKER = os.environ.get("XTTS_SPEAKER", "Ana Florence")

print("Загружаю XTTS-v2... (первый запуск скачает модель ~1.8 ГБ, потом кешируется)")

import torch
from TTS.api import TTS

USE_CUDA = torch.cuda.is_available()
print(f"CUDA доступна: {USE_CUDA}" + (f" ({torch.cuda.get_device_name(0)})" if USE_CUDA else " — будет CPU (медленно)"))

tts = TTS(MODEL_NAME)
tts = tts.to("cuda" if USE_CUDA else "cpu")

# Частота дискретизации на выходе XTTS (обычно 24000).
try:
    SAMPLE_RATE = int(tts.synthesizer.output_sample_rate)
except Exception:
    SAMPLE_RATE = 24000


def list_speakers():
    """Список встроенных дикторов XTTS-v2."""
    try:
        sm = tts.synthesizer.tts_model.speaker_manager
        names = list(sm.name_to_id.keys()) if hasattr(sm, "name_to_id") else list(sm.speakers.keys())
        return sorted(names)
    except Exception as e:
        print("Не смог получить список дикторов:", e)
        return [DEFAULT_SPEAKER]


SPEAKERS = list_speakers()
if DEFAULT_SPEAKER not in SPEAKERS and SPEAKERS:
    DEFAULT_SPEAKER = SPEAKERS[0]
print(f"Готово. Дикторов: {len(SPEAKERS)}. По умолчанию: {DEFAULT_SPEAKER}")

# XTTS-модель не потокобезопасна — синтез делаем под локом.
_lock = threading.Lock()

app = Flask(__name__)


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    # Ключевой заголовок для запросов HTTPS-страницы в localhost (Private Network Access).
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


@app.route("/<path:_any>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def preflight(_any=None):
    return Response(status=204)


@app.route("/health", methods=["GET"])
def health():
    return jsonify(ok=True, model="xtts_v2", speakers=SPEAKERS,
                   default_speaker=DEFAULT_SPEAKER, sample_rate=SAMPLE_RATE, cuda=USE_CUDA)


@app.route("/speakers", methods=["GET"])
def speakers():
    return jsonify(speakers=SPEAKERS, default_speaker=DEFAULT_SPEAKER)


def to_wav_bytes(wav):
    """float32 [-1,1] -> WAV (PCM16) bytes."""
    arr = np.asarray(wav, dtype=np.float32)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.route("/tts", methods=["POST"])
def synth():
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    language = (data.get("language") or "en").strip().lower()
    speaker = data.get("speaker") or DEFAULT_SPEAKER

    if not text:
        return jsonify(error="empty text"), 400
    if language not in ("en", "ru"):
        language = "en"
    if speaker not in SPEAKERS:
        speaker = DEFAULT_SPEAKER

    try:
        with _lock:
            wav = tts.tts(text=text, speaker=speaker, language=language)
        return Response(to_wav_bytes(wav), mimetype="audio/wav")
    except Exception as e:
        print("Ошибка синтеза:", e, file=sys.stderr)
        return jsonify(error=str(e)), 500


if __name__ == "__main__":
    print(f"\nСервер слушает http://localhost:{PORT}")
    print("Оставь это окно открытым, пока пользуешься тренажёром.\n")
    # threaded=False — синтез всё равно последовательный, и так безопаснее для модели.
    app.run(host="127.0.0.1", port=PORT, threaded=True)

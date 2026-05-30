@echo off
REM ============================================================
REM  Запуск локального XTTS-v2 сервера для тренажёра английского
REM  Первый запуск: создаёт venv, ставит torch (CUDA) + зависимости.
REM  Последующие запуски: просто стартует сервер.
REM ============================================================
setlocal
cd /d "%~dp0"

if not exist ".venv" (
    echo [1/4] Создаю виртуальное окружение (Python 3.10)...
    REM coqui-tts стабильнее всего на 3.10/3.11; пробуем launcher, иначе обычный python.
    py -3.10 -m venv .venv 2>nul || py -3.11 -m venv .venv 2>nul || python -m venv .venv
    if errorlevel 1 (
        echo ОШИБКА: не найден Python 3.10/3.11. Установи с python.org и поставь галочку "Add to PATH".
        pause
        exit /b 1
    )

    call .venv\Scripts\activate.bat

    echo [2/4] Обновляю pip...
    python -m pip install --upgrade pip

    echo [3/4] Ставлю PyTorch с поддержкой CUDA 12.1 (под RTX 4060)...
    pip install torch --index-url https://download.pytorch.org/whl/cu121

    echo [4/4] Ставлю XTTS и зависимости сервера...
    pip install -r requirements.txt
) else (
    call .venv\Scripts\activate.bat
)

set COQUI_TOS_AGREED=1
echo.
echo Запускаю сервер. Закрой это окно, чтобы остановить.
echo.
python xtts_server.py

pause

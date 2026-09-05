"""Shared master on/off for each strategy bot, read from .env every call.
Controlled from the Settings page. A disabled bot skips trading (still may log)."""
from pathlib import Path
_ENV = Path(__file__).resolve().parent.parent / ".env"

def bot_enabled(name: str) -> bool:
    key = f"BOT_{name.upper()}_ENABLED"
    try:
        for line in _ENV.open():
            if line.startswith(key + "="):
                return line.strip().split("=", 1)[1].lower() != "false"
    except Exception:
        pass
    return True   # default on if unset

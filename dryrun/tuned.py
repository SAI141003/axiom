"""Live-read the auto-tuner's chosen knob values. Daemons call tuned(strat, knob,
default) each scan so nightly tuner decisions take effect without a restart.
Falls back to the daemon's own constant if the tuner hasn't ruled on it yet."""
import json
from pathlib import Path

_PARAMS = Path(__file__).resolve().parent.parent / ".data" / "tuned_params.json"


def tuned(strategy: str, knob: str, default):
    try:
        p = json.loads(_PARAMS.read_text())
        v = p.get(strategy, {}).get(knob, {}).get("value")
        return v if v is not None else default
    except Exception:
        return default

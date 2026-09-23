"""AXIOM's ears and voice — both running on this machine.

Ears: whisper.cpp (pywhispercpp) with OpenAI's MIT-licensed weights. Chrome's
own recogniser paraphrases — "Axiom" comes back "action", "yes Sai" comes back
"yes sign" — this writes down what was said.

Voice: Piper (MIT), the same open speech stack. edge-tts was a network call to
Microsoft for every sentence and measured 5.7-9.1 s on a cold phrase, which is
what made AXIOM feel slow; Piper renders the same sentence in 40-370 ms here.

Both models load once and stay warm. Nothing leaves the machine.

  .venv/bin/python signals/stt_server.py          (launchd: com.polymarket.stt, :5002)
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import wave
from pathlib import Path

# launchd gives us a bare PATH, so find ffmpeg where Homebrew actually put it
FFMPEG = shutil.which("ffmpeg") or next((p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if Path(p).exists()), "ffmpeg")

from aiohttp import web

ROOT = Path(__file__).resolve().parent.parent
MODEL = os.getenv("WHISPER_MODEL", str(ROOT / ".data" / "whisper" / "ggml-base.en.bin"))
PORT = int(os.getenv("STT_PORT", "5002"))
# the desk's own vocabulary, so the names it hears every day come back right
PROMPT = ("AXIOM. The Eye. The desk. Sai. Weather bot, flow bot, meme bot, options bot, "
          "oracle-lag, gamma-pulse, ccxt strategy, stocks bot, pre-market. Polymarket, Kraken, "
          "Hyperliquid. Open the Eye. Brief me. Pause trading.")

VOICE = os.getenv("PIPER_VOICE", str(ROOT / ".data" / "piper" / "en_GB-alan-medium.onnx"))

_model = None
_voice = None


def voice():
    global _voice
    if _voice is None:
        from piper import PiperVoice
        _voice = PiperVoice.load(VOICE)
    return _voice


def model():
    global _model
    if _model is None:
        from pywhispercpp.model import Model
        # the prompt and language belong to the model's params, not the call
        _model = Model(MODEL, print_realtime=False, print_progress=False, print_timestamps=False,
                       initial_prompt=PROMPT, language="en", n_threads=4,
                       suppress_blank=True, single_segment=False)
    return _model


async def h_transcribe(request: web.Request) -> web.Response:
    t0 = time.time()
    raw = await request.read()
    if not raw:
        return web.json_response({"error": "no audio"}, status=400)
    with tempfile.TemporaryDirectory() as d:
        src, wav = Path(d) / "in.webm", Path(d) / "in.wav"
        src.write_bytes(raw)
        try:
            subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(src),
                            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)],
                           check=True, timeout=20)
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": f"ffmpeg: {e}"}, status=503)
        try:
            segs = model().transcribe(str(wav))
            text = " ".join(s.text for s in segs).strip()
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": f"whisper: {str(e)[:160]}"}, status=503)
    return web.json_response({"text": text, "ms": int((time.time() - t0) * 1000),
                              "engine": "whisper.cpp", "model": Path(MODEL).name})


async def h_speak(request: web.Request) -> web.Response:
    """One sentence in, a WAV out. The dashboard asks for these one at a time
    while AXIOM is still talking, so this has to answer in well under a second."""
    t0 = time.time()
    body = await request.json()
    said = str(body.get("text") or "").strip()
    if not said:
        return web.json_response({"error": "no text"}, status=400)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        voice().synthesize_wav(said[:1200], w)
    wav = buf.getvalue()
    return web.Response(body=wav, content_type="audio/wav",
                        headers={"x-engine": "piper", "x-ms": str(int((time.time() - t0) * 1000))})


async def h_health(_: web.Request) -> web.Response:
    return web.json_response({"ok": Path(MODEL).exists(), "engine": "whisper.cpp",
                              "model": Path(MODEL).name, "warm": _model is not None,
                              "voice": {"ok": Path(VOICE).exists(), "engine": "piper",
                                        "model": Path(VOICE).name, "warm": _voice is not None}})


def main() -> None:
    app = web.Application(client_max_size=32 * 1024 * 1024)
    app.add_routes([web.get("/", h_health), web.post("/transcribe", h_transcribe), web.post("/speak", h_speak)])
    print(f"[stt] whisper.cpp + piper on :{PORT} — {Path(MODEL).name}, {Path(VOICE).name}", flush=True)
    model(); voice()          # load before the first utterance, not during it
    print("[stt] ears and voice warm", flush=True)
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()

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

import asyncio
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
PROMPT = ("AXIOM Sai Polymarket Kraken Hyperliquid oracle-lag gamma-pulse ccxt "
          "premarket weather bot flow bot meme bot options bot stocks bot")

VOICE = os.getenv("PIPER_VOICE", str(ROOT / ".data" / "piper" / "en_GB-alan-medium.onnx"))
# a shade slower than default and a little less jitter: the measured, unhurried
# delivery Sai asked for rather than a newsreader's clip
RATE = float(os.getenv("PIPER_RATE", "1.08"))       # >1 is slower
NOISE = float(os.getenv("PIPER_NOISE", "0.60"))     # lower is steadier
NOISE_W = float(os.getenv("PIPER_NOISE_W", "0.75"))

_model = None
_voice = None
# whisper.cpp holds the CPU for the length of a transcription. Run it off the
# event loop, one at a time, so a slow clip cannot stall every other request
# behind it — that is what turned a 105 ms transcription into ten seconds.
_lock = asyncio.Lock()


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


def _data_offset(raw: bytes) -> int:
    """Where the samples start — the fmt chunk is not always 16 bytes."""
    i = 12
    while i + 8 <= len(raw):
        cid = raw[i:i + 4]
        import struct
        (size,) = struct.unpack_from("<I", raw, i + 4)
        if cid == b"data":
            return i + 8
        i += 8 + size + (size & 1)
    return 44


def _is_ready_wav(raw: bytes) -> bool:
    """A 16 kHz mono 16-bit RIFF/WAVE needs no conversion."""
    if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return False
    import struct
    try:
        fmt, chans, rate, _, _, bits = struct.unpack_from("<HHIIHH", raw, 20)
        return fmt == 1 and chans == 1 and rate == 16000 and bits == 16
    except Exception:  # noqa: BLE001
        return False


async def h_transcribe(request: web.Request) -> web.Response:
    t0 = time.time()
    raw = await request.read()
    if not raw:
        return web.json_response({"error": "no audio"}, status=400)
    with tempfile.TemporaryDirectory() as d:
        src, wav = Path(d) / "in.src.wav", Path(d) / "in.wav"
        src.write_bytes(raw)
        # The dashboard already sends 16 kHz mono PCM, which is exactly what
        # whisper.cpp wants; spawning ffmpeg to convert it to itself cost a
        # process and the better part of a tenth of a second on every word.
        if _is_ready_wav(raw):
            # straight from bytes to samples: no temp file, no decoder, no ffmpeg
            try:
                import numpy as np
                pcm = np.frombuffer(raw[_data_offset(raw):], dtype="<i2").astype("float32") / 32768.0
                async with _lock:
                    segs = await asyncio.to_thread(model().transcribe, pcm)
                text = " ".join(x.text for x in segs).strip()
                return web.json_response({"text": text, "ms": int((time.time() - t0) * 1000),
                                          "engine": "whisper.cpp", "model": Path(MODEL).name})
            except Exception:  # noqa: BLE001
                wav = src
        else:
            try:
                subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(src),
                                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)],
                               check=True, timeout=20)
            except Exception as e:  # noqa: BLE001
                return web.json_response({"error": f"ffmpeg: {e}"}, status=503)
        try:
            async with _lock:
                segs = await asyncio.to_thread(model().transcribe, str(wav))
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
    from piper import SynthesisConfig

    def render() -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            voice().synthesize_wav(said[:1200], w, syn_config=SynthesisConfig(
                length_scale=RATE, noise_scale=NOISE, noise_w_scale=NOISE_W, normalize_audio=True))
        return buf.getvalue()

    # Piper holds the CPU too. Off the event loop, or a sentence being spoken
    # blocks the transcription of the next thing Sai says — and the other way
    # round, which is what made a 200 ms render take eleven seconds.
    wav = await asyncio.to_thread(render)
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
    # Loading the models is not the same as running them: onnxruntime and
    # whisper.cpp both build their compute graph on the first inference, which
    # cost seconds on Sai's first word after every restart. Run one of each now.
    import numpy as _np
    model().transcribe(_np.zeros(16000, dtype="float32"))
    _warm = io.BytesIO()
    with wave.open(_warm, "wb") as _w:
        voice().synthesize_wav("Ready.", _w)
    print("[stt] ears and voice warm", flush=True)
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()

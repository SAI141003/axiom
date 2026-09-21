"""Jev — TypeSafe AI's typed-judgment model — as a frozen, auditable judge.

Jev (TypeSafe AI, out of stealth 2026-09-15) is not a chat model: you send a
state and typed questions, it returns one calibrated answer per question in
~100 ms — a probability (noul), a choice with probabilities, or a score.
$0.042 per million input tokens, output free. No free tier.

What the desk takes from the jev-trade repos (jarrodwatts/jev-trader,
rikkooo/jev-trade, aowang-ai/jev-trade) is the *pattern*, not the venue:
freeze the judgment BEFORE the outcome is known, with a hash of exactly what
the model saw and the model version, then score it against the real outcome.
"Hit rate never stands alone" — every judgment lands in
logs/jev_judgments.jsonl and is Brier-scored when the market resolves.

No key → judge() returns None. Nothing is ever faked.

  TYPESAFE_AI_API_KEY=...   in .env
"""
from __future__ import annotations
import hashlib, json, os, time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "logs" / "jev_judgments.jsonl"
URL = "https://api.typesafe.ai/v1/systemone"
MODEL = os.getenv("JEV_MODEL", "jev-latest")


def _key() -> str | None:
    k = os.getenv("TYPESAFE_AI_API_KEY")
    if k:
        return k
    try:
        for line in (ROOT / ".env").open():
            if line.startswith("TYPESAFE_AI_API_KEY="):
                v = line.strip().split("=", 1)[1]
                return v or None
    except Exception:
        pass
    return None


def configured() -> bool:
    return _key() is not None


def judge(state: Any, questions: dict[str, dict], tag: str = "", timeout: float = 4.0) -> dict | None:
    """One Jev call. Returns {"answers", "model", "latency_ms", "usage", "hash", "ts"} or None if not configured / failed.
    The judgment is frozen to the ledger with a hash of the exact state and questions."""
    key = _key()
    if not key:
        return None
    import urllib.request
    body = json.dumps({"model": MODEL, "state": state, "questions": questions}).encode()
    h = hashlib.sha256(body).hexdigest()[:16]
    t0 = time.time()
    req = urllib.request.Request(URL, data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.load(r)
    except Exception as e:  # noqa: BLE001
        _write({"type": "jev_error", "ts": int(time.time()), "tag": tag, "hash": h, "error": str(e)[:160]})
        return None
    out = {"ts": int(t0), "tag": tag, "hash": h, "model": j.get("model"), "answers": j.get("answers", {}),
           "usage": j.get("usage"), "latency_ms": int((time.time() - t0) * 1000)}
    _write({"type": "jev_judgment", **out})
    return out


def score(tag: str, outcome: dict[str, float]) -> None:
    """Record the truth for a frozen judgment: outcome maps question_id → 1/0 (noul) so Brier can be computed."""
    _write({"type": "jev_outcome", "ts": int(time.time()), "tag": tag, "outcome": outcome})


def report() -> dict:
    """Brier score and calibration of every noul judgment that has an outcome."""
    rows = []
    try:
        rows = [json.loads(l) for l in LEDGER.open() if l.strip()]
    except Exception:
        return {"configured": configured(), "judgments": 0}
    judg = {r["tag"]: r for r in rows if r["type"] == "jev_judgment"}
    scored = []
    for r in rows:
        if r["type"] != "jev_outcome" or r["tag"] not in judg:
            continue
        j = judg[r["tag"]]
        for q, truth in r["outcome"].items():
            a = j["answers"].get(q, {})
            p = a.get("noul")
            if p is None:
                continue
            scored.append({"p": p, "y": truth, "ts": j["ts"], "ms": j["latency_ms"]})
    n = len(scored)
    brier = sum((s["p"] - s["y"]) ** 2 for s in scored) / n if n else None
    base = sum(s["y"] for s in scored) / n if n else None
    ref = base * (1 - base) if n else None          # Brier of always saying the base rate
    bins: dict[str, list] = {}
    for s in scored:
        bins.setdefault(f"{int(s['p'] * 10) / 10:.1f}", []).append(s["y"])
    calib = {k: {"n": len(v), "hit": round(sum(v) / len(v), 3)} for k, v in sorted(bins.items())}
    return {"configured": configured(), "judgments": len(judg), "scored": n, "brier": round(brier, 4) if brier is not None else None,
            "brier_base_rate": round(ref, 4) if ref is not None else None,
            "skill": (round(1 - brier / ref, 3) if brier is not None and ref else None),
            "p50_latency_ms": sorted(s["ms"] for s in scored)[n // 2] if n else None, "calibration": calib,
            "errors": sum(1 for r in rows if r["type"] == "jev_error")}


def _write(row: dict) -> None:
    try:
        LEDGER.parent.mkdir(exist_ok=True)
        with LEDGER.open("a") as f:
            f.write(json.dumps(row) + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    print(json.dumps(report(), indent=1))

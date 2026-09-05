"""
COUNCIL RESOLVER — Brier-scores the Council's OWN rulings against reality.

Research is clear: for a multi-agent judge to be trusted, its confidence must be
CALIBRATED and tracked, not asserted. Every ruling is logged
(logs/council_rulings.jsonl); this resolves the ones about a stock/crypto moving
UP over a day/week and scores them.

Resolves questions that name a ticker/BTC and a direction ("higher", "green",
"up", "close above"). Others (macro, business) resolve on their own timeline.

Writes .data/council_scorecard.json. Run nightly (overnight loop).
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "council_rulings.jsonl"
OUT = ROOT / ".data" / "council_scorecard.json"
UA = {"User-Agent": "Mozilla/5.0"}

TICKER = re.compile(r"\b([A-Z]{2,5})\b")
UP_WORDS = re.compile(r"\b(up|higher|green|rise|gain|above|beat|outperform)\b", re.I)
CRYPTO = {"BTC": "BTC-USD", "ETH": "ETH-USD", "BITCOIN": "BTC-USD"}


def quote_series(sym: str):
    try:
        req = urllib.request.Request(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1mo&interval=1d",
            headers=UA)
        r = json.load(urllib.request.urlopen(req, timeout=12))["chart"]["result"][0]
        closes = [c for c in r["indicators"]["quote"][0]["close"] if c is not None]
        return closes
    except Exception:
        return None


def resolvable(q: str):
    """Return (yahoo_symbol, wants_up) if the question is a directional asset call."""
    up = bool(UP_WORDS.search(q))
    for k, v in CRYPTO.items():
        if k in q.upper():
            return v, up
    m = TICKER.findall(q.upper())
    # skip common non-tickers
    stop = {"BTC", "ETH", "WILL", "THE", "FED", "AI", "CEO", "GDP", "IPO", "USD"}
    for t in m:
        if t not in stop:
            return t, up
    return None, up


def main() -> None:
    if not LOG.exists():
        print("[council-resolver] no rulings yet")
        return
    rows = [json.loads(l) for l in LOG.open() if l.strip()]
    now = time.time()
    changed = False
    for r in rows:
        if r.get("resolved"):
            continue
        age = now - r["ts"]
        if age < 20 * 3600 or age > 20 * 86400:          # too soon / too old
            continue
        sym, wants_up = resolvable(r["question"])
        if not sym:
            continue
        closes = quote_series(sym)
        if not closes or len(closes) < 3:
            continue
        # did it go up over the ~week since the ruling? (coarse but honest)
        went_up = closes[-1] > closes[max(0, len(closes) - 6)]
        # the ruling's P(YES) is P(the YES-side of the question). If the question
        # is "up" phrased, YES == up. Map decision to P(up).
        p_yes = r["probability"]
        p_up = p_yes if wants_up else 1 - p_yes
        outcome = 1 if went_up else 0
        correct = (r["decision"] == "YES") == (went_up == wants_up)
        r.update(resolved=True, went_up=went_up, correct=bool(correct),
                 brier=round((p_up - outcome) ** 2, 4), resolved_at=int(now))
        changed = True
        time.sleep(0.3)

    if changed:
        LOG.write_text("".join(json.dumps(r) + "\n" for r in rows))

    done = [r for r in rows if r.get("resolved") and "brier" in r]
    if done:
        n = len(done)
        acc = sum(1 for r in done if r.get("correct")) / n
        brier = sum(r["brier"] for r in done) / n
        oc = [r for r in done if r.get("overconfident")]
        OUT.write_text(json.dumps({
            "ts": int(now), "resolved": n,
            "accuracy": round(acc, 3), "brier": round(brier, 4),
            "verdict": "calibrated (beats 0.25 coin-flip)" if brier < 0.25 else "not yet calibrated",
            "overconfident_flagged": len(oc),
        }, indent=2))
        print(f"[council-resolver] {n} scored · accuracy {acc:.0%} · Brier {brier:.3f}")
    else:
        print(f"[council-resolver] {len([r for r in rows if not r.get('resolved')])} pending")


if __name__ == "__main__":
    main()

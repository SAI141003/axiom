"""
ALPHA FACTORS — daily cross-sectional scores from the HKUDS Vibe-Trading zoo
(460 registered alphas; we compute a curated, interpretable subset on our
stock watchlist). This is the repo's real power: a factor CONTEXT for every
stock decision, not a black-box signal.

Curated set (why each):
  academic_strev    short-term reversal — fades last week's move
  academic_high52w  proximity to 52-week high — momentum anchor
  academic_illiq    Amihud illiquidity — thin names move more per $
  academic_retskew  return skew — lottery-ness (relates to our longshot lesson)
  academic_carhart_mom  12-1 momentum — the classic
  alpha101_001..004     WorldQuant price-action alphas

Output: .data/alpha_factors.json {date, symbols, factors: {id: {sym: z}}}
Wired into the overnight loop. Consumers: premarket/options context, future
meta-labels. Run: .venv/bin/python signals/alpha_factors.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vibe_trading_repo" / "agent" / "src"))
sys.path.insert(0, str(ROOT / "vibe_trading_repo" / "agent"))

WATCHLIST = ["NVDA", "TSLA", "AAPL", "MSFT", "AMD", "GOOGL", "META", "MU",
             "QQQ", "SPY", "ONDS", "QS", "JOBY"]
# Use Vibe-Trading at real capacity: try the whole WorldQuant alpha101 zoo
# (101) + academic factors (10), and KEEP every one that computes cleanly on
# our OHLCV panel (~44 alpha101 + a few academic do). No hardcoded short list.
CANDIDATE_FACTORS = ([f"alpha101_{i:03d}" for i in range(1, 102)]
                     + ["academic_strev", "academic_illiq", "academic_retskew",
                        "academic_high52w", "academic_carhart_mom", "academic_mkt_rf"])
OUT = ROOT / ".data" / "alpha_factors.json"


def fetch_daily(sym: str) -> dict | None:
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?range=1y&interval=1d")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=15))
        r = d["chart"]["result"][0]
        q = r["indicators"]["quote"][0]
        return {"ts": r["timestamp"], **{k: q[k] for k in
                ("open", "high", "low", "close", "volume")}}
    except Exception:
        return None


def main() -> None:
    import pandas as pd
    from factors.registry import get_default_registry

    frames: dict[str, dict[str, pd.Series]] = {k: {} for k in
        ("open", "high", "low", "close", "volume")}
    for sym in WATCHLIST:
        d = fetch_daily(sym)
        if not d:
            continue
        idx = pd.to_datetime(pd.Series(d["ts"]), unit="s").dt.normalize()
        for k in frames:
            frames[k][sym] = pd.Series(d[k], index=idx).astype(float)
        time.sleep(0.2)

    panel = {k: pd.DataFrame(v).dropna(how="all") for k, v in frames.items()}
    n_syms = panel["close"].shape[1]
    if n_syms < 5:
        print(f"[alpha-factors] only {n_syms} symbols fetched — aborting")
        return

    reg = get_default_registry()
    out: dict[str, dict[str, float]] = {}
    for fid in CANDIDATE_FACTORS:
        try:
            df = reg.compute(fid, panel)
            last = df.dropna(how="all").iloc[-1]
            mu, sd = last.mean(), last.std()
            if last.notna().sum() >= 6 and sd and sd > 0:      # keep only clean factors
                out[fid] = {s: round(float((v - mu) / sd), 3)
                            for s, v in last.items() if pd.notna(v)}
        except Exception:
            pass                                                # silently skip incompatibles

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        "ts": int(time.time()),
        "date": str(panel["close"].index[-1].date()),
        "symbols": list(panel["close"].columns),
        "factors": out,
    }, indent=2))
    print(f"[alpha-factors] computed {len(out)}/{len(CANDIDATE_FACTORS)} factors "
          f"on {n_syms} symbols (Vibe-Trading zoo)")
    # top/bottom by short-term reversal as a sanity read
    if "academic_strev" in out:
        sr = sorted(out["academic_strev"].items(), key=lambda kv: -kv[1])
        print(f"  strev (fade candidates): top {sr[:2]} · bottom {sr[-2:]}")


if __name__ == "__main__":
    main()

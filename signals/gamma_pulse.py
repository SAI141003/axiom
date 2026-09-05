"""
GAMMA PULSE — the market's real intraday "pulse" for stocks & options.

Dealer option-hedging flow IS the pulse: where dealers are long gamma they hedge
AGAINST the move (buy dips / sell rips → mean-reversion, pinning); where they are
short gamma they hedge WITH it (sell dips / buy rips → amplification, trend & vol).
The zero-gamma flip is the switch between the two regimes.

This turns our live GEX layer (gamma_levels.gex_for) into an actionable read per
name — regime, the wall magnets (support/resistance), and the positioning it
implies for BOTH the stock and its options.

Research this is grounded in (real, cited — not "pulse trading"):
  • SqueezeMetrics, "The Implied Order Book / GEX" whitepaper (dealer gamma → flow).
  • Barbon & Buraschi (2020), "Gamma Fragility" — short-gamma zones amplify moves.
  • Ni, Pearson, Poteshman (2005) — option hedging pins the stock near big strikes.
  • Baltussen, Da, et al. on option-driven underlying autocorrelation.

Honest status: this is a regime/positioning indicator, not a proven money-printer.
Like weather & crypto, it must be forward-tested before it earns real capital —
predictions are logged to logs/gamma_pulse.jsonl for exactly that.

CLI: .venv/bin/python signals/gamma_pulse.py SPY [QQQ NVDA ...]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gamma_levels import gex_for

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "gamma_pulse.jsonl"
WATCH = ["SPY", "QQQ", "NVDA", "TSLA", "AAPL", "AMD", "MSFT", "META"]


def pulse(sym: str) -> dict | None:
    g = gex_for(sym)
    if not g or not g.get("spot"):
        return None
    spot = g["spot"]; cw = g.get("call_wall"); pw = g.get("put_wall"); zg = g.get("zero_gamma")
    below = zg is not None and spot < zg
    regime = "AMPLIFIED (short-gamma)" if below else "DAMPENED (long-gamma)"

    # distance to the wall magnets (as % of spot)
    d_cw = round((cw - spot) / spot * 100, 2) if cw else None
    d_pw = round((spot - pw) / spot * 100, 2) if pw else None

    if below:
        stock_read = "moves ACCELERATE — favor breakouts/trend; whipsaw risk both ways"
        option_read = "BUY GAMMA — long straddle/directional; realized vol tends to rise, so long options pay"
        vol = "expanding"
    else:
        stock_read = "moves get PINNED & mean-revert — fade extremes toward the walls"
        option_read = "SELL PREMIUM (defined-risk) — theta favored; pin toward the nearest big strike"
        vol = "compressing"

    # nearest magnet
    magnet = None
    if cw and pw:
        magnet = ("call wall " + str(cw) + " (resistance)") if (d_cw or 9) < (d_pw or 9) else ("put wall " + str(pw) + " (support)")

    return {
        "symbol": sym, "spot": round(spot, 2), "regime": regime, "short_gamma": below,
        "call_wall": cw, "put_wall": pw, "zero_gamma": zg,
        "dist_to_call_wall_pct": d_cw, "dist_to_put_wall_pct": d_pw,
        "nearest_magnet": magnet, "vol_regime": vol,
        "stock_play": stock_read, "option_play": option_read,
        "summary": f"{sym} ${round(spot,2)} · {regime} · support {pw} / resist {cw} · flip {zg}",
        "ts": int(time.time()),
    }


def scan(symbols: list[str]) -> list[dict]:
    out = []
    for s in symbols:
        p = pulse(s)
        if p:
            out.append(p)
            with LOG.open("a") as f:                 # log for later forward-testing
                f.write(json.dumps({"symbol": s, "spot": p["spot"], "regime": p["regime"],
                                    "short_gamma": p["short_gamma"], "resolved": False,
                                    "ts": p["ts"]}) + "\n")
        time.sleep(0.3)
    return out


if __name__ == "__main__":
    syms = [a.upper() for a in sys.argv[1:]] or WATCH
    LOG.parent.mkdir(exist_ok=True)
    res = scan(syms)
    for p in res:
        print(f"\n{p['summary']}")
        print(f"   STOCK:  {p['stock_play']}")
        print(f"   OPTIONS: {p['option_play']}")
        print(f"   nearest magnet: {p['nearest_magnet']} · vol {p['vol_regime']}")

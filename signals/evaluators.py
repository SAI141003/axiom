"""
EVALUATOR FRAMEWORK — OctoBot's signal pipeline, native to AXIOM.

OctoBot's core idea, distilled: Evaluators analyze market data and each emit a
number in [-1, +1] (−1 = strong bearish, +1 = strong bullish); a Strategy blends
them with weights into one net score; a Trading Mode turns that score into a
position decision (considering the position you already hold). This is the clean
seam our ~40 scattered signal modules were missing — anything that reads a price
window can be wrapped as an Evaluator and dropped into a Strategy.

Pure-stdlib TA (no heavy deps) so it's fast and trivially backtestable. Feed each
evaluator a context dict of parallel lists: {"close": [...], "high": [...],
"low": [...], "volume": [...]}. The most recent bar is the LAST element.
"""
from __future__ import annotations

import json
import math
import statistics
from dataclasses import dataclass, field
from pathlib import Path


def _clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _sma(xs: list[float], n: int) -> float:
    return sum(xs[-n:]) / n if len(xs) >= n else sum(xs) / len(xs)


# ── evaluators — each returns a signal in [-1, +1] ────────────────────────────
class Evaluator:
    name = "base"

    def evaluate(self, ctx: dict) -> float:   # pragma: no cover - interface
        raise NotImplementedError


class RSIEvaluator(Evaluator):
    """Wilder RSI. Overbought (>70) → bearish, oversold (<30) → bullish."""
    name = "rsi"

    def __init__(self, period: int = 14):
        self.period = period

    def evaluate(self, ctx: dict) -> float:
        c = ctx["close"]
        if len(c) < self.period + 1:
            return 0.0
        gains, losses = [], []
        for i in range(-self.period, 0):
            d = c[i] - c[i - 1]
            gains.append(max(d, 0.0)); losses.append(max(-d, 0.0))
        ag, al = sum(gains) / self.period, sum(losses) / self.period
        rsi = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
        return _clip((50 - rsi) / 30)   # 20→+1, 80→-1


class MACrossEvaluator(Evaluator):
    """Fast SMA vs slow SMA, scaled by the gap. Trend-following."""
    name = "ma_cross"

    def __init__(self, fast: int = 10, slow: int = 30):
        self.fast, self.slow = fast, slow

    def evaluate(self, ctx: dict) -> float:
        c = ctx["close"]
        if len(c) < self.slow:
            return 0.0
        f, s = _sma(c, self.fast), _sma(c, self.slow)
        return _clip(((f - s) / s) * 20)   # ~5% gap saturates


class MomentumEvaluator(Evaluator):
    """Return over a lookback, tanh-scaled. Classic time-series momentum."""
    name = "momentum"

    def __init__(self, lookback: int = 20):
        self.lookback = lookback

    def evaluate(self, ctx: dict) -> float:
        c = ctx["close"]
        if len(c) <= self.lookback:
            return 0.0
        return _clip(math.tanh((c[-1] / c[-self.lookback - 1] - 1) * 6))


class MeanReversionEvaluator(Evaluator):
    """Fade the last few bars — short-term reversal (Jegadeesh)."""
    name = "mean_reversion"

    def __init__(self, lookback: int = 5):
        self.lookback = lookback

    def evaluate(self, ctx: dict) -> float:
        c = ctx["close"]
        if len(c) <= self.lookback:
            return 0.0
        return _clip(-math.tanh((c[-1] / c[-self.lookback - 1] - 1) * 8))


class BollingerEvaluator(Evaluator):
    """Position within Bollinger bands. Above upper → sell, below lower → buy."""
    name = "bollinger"

    def __init__(self, period: int = 20, k: float = 2.0):
        self.period, self.k = period, k

    def evaluate(self, ctx: dict) -> float:
        c = ctx["close"]
        if len(c) < self.period:
            return 0.0
        mid = _sma(c, self.period)
        sd = statistics.pstdev(c[-self.period:]) or 1e-9
        z = (c[-1] - mid) / sd
        return _clip(-z / self.k)          # +2σ → -1, -2σ → +1


class OBVEvaluator(Evaluator):
    """On-Balance Volume slope — order-flow proxy from candle volume. Accumulation
    (OBV rising with price) → bullish; distribution → bearish. Backtestable stand-in
    for live CVD (which needs a real-time trade stream)."""
    name = "obv"

    def __init__(self, lookback: int = 20):
        self.lookback = lookback

    def evaluate(self, ctx: dict) -> float:
        c, v = ctx["close"], ctx["volume"]
        n = self.lookback
        if len(c) <= n or len(v) != len(c):
            return 0.0
        start = max(1, len(c) - 3 * n)      # bound cost: recent window only
        obv, series = 0.0, [0.0]
        for i in range(start, len(c)):
            obv += v[i] if c[i] > c[i - 1] else (-v[i] if c[i] < c[i - 1] else 0.0)
            series.append(obv)
        if len(series) <= n:
            return 0.0
        avgv = (sum(v[-n:]) / n) or 1e-9
        return _clip(math.tanh(((series[-1] - series[-n - 1]) / (avgv * n)) * 1.5))


class MFIEvaluator(Evaluator):
    """Money Flow Index — RSI weighted by volume (order/‘money’ flow). >80 overbought
    → bearish, <20 oversold → bullish."""
    name = "mfi"

    def __init__(self, period: int = 14):
        self.period = period

    def evaluate(self, ctx: dict) -> float:
        c, h, l, v = ctx["close"], ctx["high"], ctx["low"], ctx["volume"]
        n = self.period
        if len(c) < n + 1 or len(v) != len(c):
            return 0.0
        tp = [(h[i] + l[i] + c[i]) / 3 for i in range(len(c))]
        pos = neg = 0.0
        for i in range(-n, 0):
            flow = tp[i] * v[i]
            if tp[i] > tp[i - 1]:
                pos += flow
            elif tp[i] < tp[i - 1]:
                neg += flow
        mfi = 100.0 if neg == 0 else 100 - 100 / (1 + pos / neg)
        return _clip((50 - mfi) / 30)


class VolumeProfileEvaluator(Evaluator):
    """Volume Profile — the tool Imre Gams & Patrick Nill lean on. Builds a
    volume-by-price histogram over a window, finds the Point of Control (VPOC) and
    the 70% Value Area (VAH/VAL). Price accepted above the value area is
    overextended (fade down); below it is oversold (fade up); inside, a gentle pull
    toward the VPOC. Backtestable approximation from OHLCV (volume spread across
    each bar's high-low range)."""
    name = "volume_profile"

    def __init__(self, lookback: int = 60, bins: int = 40, value_area: float = 0.70):
        self.lookback, self.bins, self.va = lookback, bins, value_area

    def evaluate(self, ctx: dict) -> float:
        c, h, l, v = ctx["close"], ctx["high"], ctx["low"], ctx["volume"]
        n, b = self.lookback, self.bins
        if len(c) < n + 1 or len(v) != len(c):
            return 0.0
        lo, hi = min(l[-n:]), max(h[-n:])
        if hi <= lo:
            return 0.0
        width = (hi - lo) / b
        hist = [0.0] * b
        for i in range(-n, 0):
            bl = max(0, min(b - 1, int((l[i] - lo) / width)))
            bh = max(0, min(b - 1, int((h[i] - lo) / width)))
            share = v[i] / (bh - bl + 1)
            for k in range(bl, bh + 1):
                hist[k] += share
        poc = max(range(b), key=lambda k: hist[k])
        total, target = sum(hist), sum(hist) * self.va
        lo_b = hi_b = poc
        acc = hist[poc]
        while acc < target and (lo_b > 0 or hi_b < b - 1):
            left = hist[lo_b - 1] if lo_b > 0 else -1.0
            right = hist[hi_b + 1] if hi_b < b - 1 else -1.0
            if right >= left and hi_b < b - 1:
                hi_b += 1; acc += hist[hi_b]
            elif lo_b > 0:
                lo_b -= 1; acc += hist[lo_b]
            else:
                break
        val, vah, poc_px = lo + lo_b * width, lo + (hi_b + 1) * width, lo + (poc + 0.5) * width
        price = c[-1]
        va_w = (vah - val) or width
        if price > vah:
            return _clip(-(price - vah) / va_w)
        if price < val:
            return _clip((val - price) / va_w)
        return _clip((poc_px - price) / va_w * 0.5)


# ── strategy — blend evaluators into one net score ───────────────────────────
@dataclass
class Strategy:
    """Weighted blend of evaluators → net signal in [-1, +1] (OctoBot-style)."""
    name: str
    components: list[tuple[Evaluator, float]] = field(default_factory=list)

    def evaluate(self, ctx: dict) -> dict:
        wsum = sum(abs(w) for _, w in self.components) or 1.0
        parts, net = {}, 0.0
        for ev, w in self.components:
            v = ev.evaluate(ctx)
            parts[ev.name] = round(v, 4)
            net += v * w
        return {"net": round(_clip(net / wsum), 4), "components": parts}


# ── trading mode — score → position decision ─────────────────────────────────
@dataclass
class TradingMode:
    """Translate the net score into a target action, given the current position.
    Hysteresis: enter beyond ±enter, exit once it decays back inside ±exit."""
    strategy: Strategy
    enter: float = 0.15
    exit: float = 0.05
    allow_short: bool = False

    def decide(self, ctx: dict, position: str = "FLAT") -> dict:
        ev = self.strategy.evaluate(ctx)
        net = ev["net"]
        action = "HOLD"
        if position == "FLAT":
            if net >= self.enter:
                action = "LONG"
            elif net <= -self.enter and self.allow_short:
                action = "SHORT"
        elif position == "LONG":
            action = "CLOSE" if net < self.exit else "HOLD"
        elif position == "SHORT":
            action = "CLOSE" if net > -self.exit else "HOLD"
        return {"action": action, "net": net, "components": ev["components"]}


# ── evaluator registry (fixed params; the optimizer tunes only the weights) ──
def _registry() -> dict:
    return {"momentum": MomentumEvaluator(20), "ma_cross": MACrossEvaluator(10, 30),
            "mean_reversion": MeanReversionEvaluator(5), "rsi": RSIEvaluator(14),
            "bollinger": BollingerEvaluator(20, 2),
            "obv": OBVEvaluator(20), "mfi": MFIEvaluator(14),
            "volume_profile": VolumeProfileEvaluator(60, 40)}


def expanded_strategy(allow_short: bool = False) -> "TradingMode":
    """Default blend + order-flow evaluators (OBV, MFI) — the (c) edge experiment."""
    w = dict(_DEFAULT_WEIGHTS, obv=0.5, mfi=0.4)
    return TradingMode(build_strategy(w, "factor-blend+orderflow"),
                       enter=0.15, exit=0.05, allow_short=allow_short)


def volprofile_strategy(allow_short: bool = False) -> "TradingMode":
    """Order-flow blend + Volume Profile — the top-trader tool, tested honestly."""
    w = dict(_DEFAULT_WEIGHTS, obv=0.5, mfi=0.4, volume_profile=0.6)
    return TradingMode(build_strategy(w, "factor-blend+orderflow+volprofile"),
                       enter=0.15, exit=0.05, allow_short=allow_short)

# the benchmarked default; the optimizer overwrites .data/strategy_weights.json
_DEFAULT_WEIGHTS = {"momentum": 1.0, "ma_cross": 0.8, "mean_reversion": 0.5,
                    "rsi": 0.5, "bollinger": 0.4}
_TUNED = Path(__file__).resolve().parent.parent / ".data" / "strategy_weights.json"


def build_strategy(weights: dict, name: str = "factor-blend") -> Strategy:
    reg = _registry()
    return Strategy(name, [(reg[k], float(w)) for k, w in weights.items() if k in reg])


def default_strategy(allow_short: bool = False) -> TradingMode:
    """The live strategy — tuned weights + thresholds from disk if the optimizer
    has written them, else the benchmarked defaults."""
    weights, enter, exit_, name = dict(_DEFAULT_WEIGHTS), 0.15, 0.05, "factor-blend"
    if _TUNED.exists():
        try:
            cfg = json.loads(_TUNED.read_text())
            weights = cfg.get("weights", weights)
            enter, exit_ = float(cfg.get("enter", enter)), float(cfg.get("exit", exit_))
            name = cfg.get("name", "factor-blend-tuned")
        except Exception:
            pass
    return TradingMode(build_strategy(weights, name), enter=enter, exit=exit_, allow_short=allow_short)


if __name__ == "__main__":
    import random
    random.seed(1)
    closes = [100.0]
    for _ in range(120):
        closes.append(closes[-1] * (1 + random.gauss(0.001, 0.02)))
    ctx = {"close": closes, "high": closes, "low": closes, "volume": [1] * len(closes)}
    tm = default_strategy()
    print(tm.decide(ctx, "FLAT"))

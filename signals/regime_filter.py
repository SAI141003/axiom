"""
REGIME FILTER — the right tool for the regime.

The batch was blunt: our evaluator strategy WINS in bear/chop (beats buy-&-hold in
every down-fold) but LAGS a raging bull — not because it loses there, but because
it's only ~35% exposed while buy-&-hold rides the whole move. So don't fight the
bull; ride it. This overlay switches behaviour by regime:

  BULL   (price above a rising long SMA)  → hold long passively, capture the trend
  BEAR / CHOP (otherwise)                 → run the active evaluator strategy, which
                                            is where its downside-protection edge lives

That's "aggressive where it wins, don't-fight-it where it doesn't." Whether this
actually beats both the raw strategy AND buy-&-hold is an empirical question — the
experiment (backtest/experiments.py) answers it honestly, per cell.
"""
from __future__ import annotations

from dataclasses import dataclass

from signals.evaluators import Strategy, TradingMode, default_strategy, _sma


def trend_up(closes: list[float], slow: int = 50, slope_lb: int = 10) -> bool:
    """Confirmed uptrend: price above the slow SMA AND the slow SMA rising."""
    if len(closes) < slow + slope_lb + 1:
        return False
    sma_now = _sma(closes, slow)
    sma_prev = _sma(closes[:-slope_lb], slow)
    return closes[-1] > sma_now and sma_now > sma_prev


@dataclass
class RegimeTradingMode:
    """Wrap a base TradingMode; ride bulls passively, delegate bear/chop to it."""
    base: TradingMode
    slow: int = 50
    slope_lb: int = 10

    @property
    def strategy(self) -> Strategy:          # so the engine can report it
        return self.base.strategy

    def decide(self, ctx: dict, position: str = "FLAT") -> dict:
        if trend_up(ctx["close"], self.slow, self.slope_lb):
            action = "LONG" if position == "FLAT" else "HOLD"
            return {"action": action, "net": None, "regime": "bull", "components": {}}
        d = self.base.decide(ctx, position)
        d["regime"] = "bear/chop"
        return d


def regime_strategy(allow_short: bool = False) -> RegimeTradingMode:
    base = default_strategy(allow_short)
    base.strategy.name = "factor-blend+regime"
    return RegimeTradingMode(base)

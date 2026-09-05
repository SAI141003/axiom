"""
Market Microstructure Signals — Phase 3 & 9

Implements:
  1. Latency Decay: Edge_t = Edge_0 · e^(−λ·t_seconds)
     Signal alpha degrades as market participants react to the same information.

  2. OBI Gate: requires Orderbook Imbalance to confirm direction
     OBI = (BidVol − AskVol) / (BidVol + AskVol)
     YES trade allowed only when OBI > obi_gate_threshold (buy pressure)
     NO  trade allowed only when OBI < −obi_gate_threshold (sell pressure)

  3. EV Filter: Expected Value = P(win)·Profit − P(loss)·Loss
     After transaction costs (taker fee ≈ 1%), only accept EV > 0.

  4. VPIN (Volume-Synchronized Probability of Informed Trading):
     VPIN_bucket = |V_buy − V_sell| / V_total
     High VPIN → adverse selection risk → skip entry.
     Approximation: uses price-direction as Lee-Ready trade classifier.

  5. MicrostructureGate: combines all filters into a single approve() call.

References:
  - Easley, López de Prado, O'Hara (2012): "Flow Toxicity and Liquidity in a
    High-Frequency World" — VPIN and adverse selection
  - Kyle (1985): "Continuous Auctions and Insider Trading" — price impact
  - Cont, Kukanov, Stoikov (2014): "The Price Impact of Order Book Events"
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional


# ── 1. Latency Decay ──────────────────────────────────────────────────────────

def lambda_for_category(category: str) -> float:
    """
    Return the per-category latency decay constant λ (per second).
    Crypto moves in seconds; politics moves in hours.
    Values calibrated to half-life that matches typical news-to-price lag.
    """
    from core.config import cfg
    _MAP = {
        "crypto":    cfg.latency_decay_lambda_crypto,
        "sports":    cfg.latency_decay_lambda_sports,
        "politics":  cfg.latency_decay_lambda_politics,
        "ai":        cfg.latency_decay_lambda_ai,
        "science":   cfg.latency_decay_lambda_science,
        "technology": cfg.latency_decay_lambda_ai,   # same cadence as AI
    }
    return _MAP.get(category, cfg.latency_decay_lambda)


def latency_decay_factor(age_ms: float, lambda_per_s: float = 0.15) -> float:
    """
    Fraction of original edge remaining after age_ms milliseconds.
    Returns exp(−λ · t_seconds).
    λ=0.15/s → at 5s: 47% edge remains, at 10s: 22%, at 20s: 5%.
    """
    return math.exp(-lambda_per_s * age_ms / 1000.0)


def decayed_edge(edge0: float, age_ms: float, lambda_per_s: float = 0.15) -> float:
    """Apply exponential decay to a raw edge estimate."""
    return edge0 * latency_decay_factor(age_ms, lambda_per_s)


# ── 2. Expected Value Filter ──────────────────────────────────────────────────

_TAKER_FEE = 0.01   # fallback flat fee (overridden by clob_taker_fee below)


def clob_taker_fee(market_price: float, category: str = "crypto") -> float:
    """
    Polymarket CLOB v2 taker fee (April 2026).
    fee = peak_rate × 4 × p × (1 − p)

    Peak rates by category (config.py):
      crypto / sports : 1.80%  → max 1.80% at p=0.50
      politics / finance: 1.00% → max 1.00% at p=0.50
      geopolitical / world: 0.00% (fee-free)

    At p=0.50: fee = peak (worst case)
    At p=0.20: fee = peak × 4×0.20×0.80 = 0.64 × peak
    At p=0.05: fee = peak × 4×0.05×0.95 = 0.19 × peak

    Binary markets: YES and NO fees are identical since 4p(1−p) is symmetric.
    """
    from core.config import cfg
    cat = (category or "crypto").lower()
    if cat in ("geopolitical", "world"):
        return 0.0
    peak = {
        "crypto":   cfg.clob_fee_peak_crypto,
        "sports":   cfg.clob_fee_peak_sports,
        "politics": cfg.clob_fee_peak_politics,
        "finance":  cfg.clob_fee_peak_finance,
    }.get(cat, cfg.clob_fee_peak_other)
    p = max(0.01, min(0.99, market_price))
    return peak * 4.0 * p * (1.0 - p)


def clob_net_edge(
    gross_edge: float,
    market_price: float,
    category: str = "crypto",
    is_maker: bool = False,
) -> float:
    """
    Subtract CLOB fee from gross edge.
    Makers receive cfg.clob_maker_rebate_share (50%) of the taker fee back.

    gross_edge: model_prob - devigged_market_prob (before fees)
    Returns net edge that should be used for Kelly sizing and trade decisions.
    """
    from core.config import cfg
    fee = clob_taker_fee(market_price, category)
    if is_maker:
        fee *= (1.0 - cfg.clob_maker_rebate_share)
    return gross_edge - fee


def expected_value(
    p_win: float,
    price: float,
    size: float = 1.0,
    fee_rate: float = _TAKER_FEE,
) -> float:
    """
    EV = P(win) · (1/price − 1) · size − P(loss) · 1 · size − fee_rate · size
    Binary prediction market: buy YES at `price`, win (1 − price)/price per dollar.
    Returns EV per dollar of exposure.

    Use clob_taker_fee(price, category) for the fee_rate argument to get
    the accurate Polymarket CLOB v2 fee instead of the flat 1% default.
    """
    if price <= 0 or price >= 1:
        return -fee_rate
    profit_if_win = (1.0 - price) / price     # net return on investment
    loss_if_lose  = 1.0                        # lose the stake
    return p_win * profit_if_win - (1.0 - p_win) * loss_if_lose - fee_rate


def ev_is_positive(
    p_win: float,
    price: float,
    fee_rate: float = _TAKER_FEE,
) -> bool:
    return expected_value(p_win, price, fee_rate=fee_rate) > 0.0


# ── 3. OBI Gate ───────────────────────────────────────────────────────────────

def obi_confirms(obi: float, side: str, threshold: float = 0.10) -> bool:
    """
    Returns True when the orderbook imbalance is consistent with the trade direction.
    threshold=0.10: require at least 55% of visible liquidity on the trade side.
    Symmetry: if |obi| < threshold, do not gate (insufficient signal).
    """
    if abs(obi) < threshold:
        return True   # inconclusive — don't block on noisy OBI
    if side == "YES":
        return obi > threshold    # more bids than asks → buy pressure
    return obi < -threshold       # more asks than bids → sell pressure


# ── 4. VPIN Tracker ───────────────────────────────────────────────────────────

@dataclass
class VPINBucket:
    buy_vol: float = 0.0
    sell_vol: float = 0.0

    @property
    def total(self) -> float:
        return self.buy_vol + self.sell_vol

    @property
    def imbalance(self) -> float:
        if self.total <= 0:
            return 0.0
        return abs(self.buy_vol - self.sell_vol) / self.total


class VPINTracker:
    """
    Per-market rolling VPIN estimator.

    Uses Lee-Ready classification: price increase → buyer-initiated.
    Accumulates into fixed-size time buckets (default: 60 seconds each).
    VPIN = mean(bucket_imbalance) over the last N buckets.
    """

    def __init__(self, bucket_seconds: float = 60.0, window: int = 10) -> None:
        self._bucket_s   = bucket_seconds
        self._window     = window
        self._buckets: deque[VPINBucket] = deque(maxlen=window)
        self._current    = VPINBucket()
        self._bucket_start = time.time()
        self._prev_price: Optional[float] = None

    def update(self, price: float, volume: float = 1.0) -> None:
        """
        Record a price/volume tick. Volume defaults to 1.0 if unknown
        (tick count approximation).
        """
        now = time.time()

        # Rotate bucket on time boundary
        if now - self._bucket_start >= self._bucket_s:
            if self._current.total > 0:
                self._buckets.append(self._current)
            self._current     = VPINBucket()
            self._bucket_start = now

        # Lee-Ready classification
        if self._prev_price is not None:
            if price > self._prev_price:
                self._current.buy_vol  += volume
            elif price < self._prev_price:
                self._current.sell_vol += volume
            else:
                # Unchanged price: split 50/50
                self._current.buy_vol  += volume * 0.5
                self._current.sell_vol += volume * 0.5

        self._prev_price = price

    def vpin(self) -> float:
        """
        Rolling VPIN over completed buckets.
        Returns 0.0 if no complete buckets yet (safe default — no adverse selection signal).
        """
        if not self._buckets:
            return 0.0
        return sum(b.imbalance for b in self._buckets) / len(self._buckets)

    def is_toxic(self, threshold: float = 0.70) -> bool:
        """True when VPIN exceeds threshold — high informed-trading risk."""
        return self.vpin() >= threshold


# ── 5. Combined MicrostructureGate ───────────────────────────────────────────

@dataclass
class GateResult:
    approved: bool
    effective_edge: float     # edge after latency decay
    reason: str               # empty when approved


_vpin_trackers: dict[str, VPINTracker] = {}


def get_vpin_tracker(market_id: str) -> VPINTracker:
    if market_id not in _vpin_trackers:
        _vpin_trackers[market_id] = VPINTracker()
    return _vpin_trackers[market_id]


def microstructure_gate(
    market_id: str,
    side: str,
    edge: float,
    p_win: float,
    price: float,
    signal_age_ms: float,
    obi: Optional[float] = None,
    lambda_per_s: float = 0.15,
    obi_threshold: float = 0.10,
    vpin_threshold: float = 0.70,
    ev_fee_rate: float = _TAKER_FEE,
) -> GateResult:
    """
    Single gate that applies all microstructure filters in order:
      1. Latency decay — compute effective edge
      2. Decayed edge still above minimum (0.02)
      3. EV positive after fees
      4. OBI direction confirmation (if available)
      5. VPIN adverse selection check
    """
    # 1. Latency decay
    eff_edge = decayed_edge(edge, signal_age_ms, lambda_per_s)
    if eff_edge < 0.02:
        return GateResult(
            approved=False,
            effective_edge=eff_edge,
            reason=f"latency_decay: eff_edge={eff_edge:.4f} < 0.02 (age={signal_age_ms:.0f}ms)",
        )

    # 2. EV filter — use accurate CLOB v2 fee curve, not flat 1% approximation.
    # At p=0.50 crypto, fee=1.80%. Using 1% was too lenient and let negative-EV trades through.
    actual_fee = clob_taker_fee(price, "crypto")
    if not ev_is_positive(p_win, price, actual_fee):
        ev = expected_value(p_win, price, fee_rate=actual_fee)
        return GateResult(
            approved=False,
            effective_edge=eff_edge,
            reason=f"ev_filter: EV={ev:.4f} ≤ 0 (fee={actual_fee:.3f}) at price={price:.3f}",
        )

    # 3. OBI gate (only when OBI is supplied and strong enough to be meaningful)
    if obi is not None and not obi_confirms(obi, side, obi_threshold):
        return GateResult(
            approved=False,
            effective_edge=eff_edge,
            reason=f"obi_gate: obi={obi:.3f} disagrees with {side} side",
        )

    # 4. VPIN adversity check
    tracker = get_vpin_tracker(market_id)
    v = tracker.vpin()
    if v >= vpin_threshold:
        return GateResult(
            approved=False,
            effective_edge=eff_edge,
            reason=f"vpin_toxic: VPIN={v:.3f} ≥ threshold={vpin_threshold}",
        )

    return GateResult(approved=True, effective_edge=eff_edge, reason="")

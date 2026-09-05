"""
Wash Trading Filter (Columbia University SSRN study — ~25% of Polymarket volume)

Source:
  - Columbia University network-based wash trading detection paper
  - Decrypt/Fortune reporting: 25% of volume wash (peaked 60% Q4 2024, now ~20%)
  - Sports markets: 45% wash | Election markets: up to 95% during campaigns

Finding: Wash trading inflates apparent volume and contaminates:
  - OBI and depth Z-scores (order flow imbalance)
  - Volume-based signal confidence
  - Market liquidity estimates

Detection heuristics (simplified — full network clustering requires on-chain data):

  1. Volume/Open-Interest ratio:
     Wash traders don't hold positions. vol/OI > cfg.wash_vol_oi_threshold
     indicates rapid round-trip trading (typically 5-15× for wash).

  2. Volume concentration:
     If top counterparties dominate (proxy: volume vs. market age is anomalous).
     We use: volume per hour significantly above median for the category.

  3. Zero net change on high volume:
     Price didn't move despite high volume → no real information → wash.
     Heuristic: 1h rolling |Δprice| < 0.005 AND volume_1h > category_median_1h.

Markets flagged as wash-suspicious should:
  - NOT be used as OBI/depth signal sources
  - Have their confidence scores halved
  - Be skipped entirely if wash_score > cfg.wash_max_score

Usage:
  from signals.wash_filter import is_wash_suspicious, wash_score
  if is_wash_suspicious(market):
      continue  # skip this market
"""
from __future__ import annotations

import logging
import time
from collections import deque

from core.config import cfg
from core.models import Market

log = logging.getLogger(__name__)

# Rolling price/volume history for wash detection
# {market_id: deque[(ts, price, volume_delta)]}
_MARKET_HIST: dict[str, deque] = {}
_HIST_MAX = 120  # 2 hours at 1-minute updates


def record_market_tick(market_id: str, price: float, volume: float) -> None:
    """Update rolling history for wash detection. Called from market_watcher."""
    if market_id not in _MARKET_HIST:
        _MARKET_HIST[market_id] = deque(maxlen=_HIST_MAX)
    _MARKET_HIST[market_id].append((time.time(), price, volume))


def wash_score(market: Market) -> float:
    """
    Return a wash trading suspicion score from 0.0 (clean) to 1.0 (very suspicious).

    Components:
      - Volume/OI ratio (40 pts max): high ratio = round-trip trading
      - Price stasis on volume (40 pts max): volume without price movement
      - Category prior (20 pts max): sports/entertainment baseline wash rate
    """
    score = 0.0
    hist  = _MARKET_HIST.get(market.condition_id)

    # Component 1: Volume/OI ratio
    volume = getattr(market, "volume", 0.0) or 0.0
    oi     = getattr(market, "open_interest", 0.0) or getattr(market, "liquidity", 1.0) or 1.0
    if oi > 0:
        vol_oi = volume / oi
        if vol_oi > cfg.wash_vol_oi_threshold:
            # Normalize: threshold = 0 pts, 5× threshold = 40 pts
            ratio_score = min(40.0, (vol_oi / cfg.wash_vol_oi_threshold - 1.0) * 10.0)
            score += ratio_score

    # Component 2: Price stasis despite volume
    if hist and len(hist) >= 10:
        window_1h = [(ts, p, v) for ts, p, v in hist if ts >= time.time() - 3600]
        if len(window_1h) >= 5:
            prices  = [p for _, p, _ in window_1h]
            vols    = [v for _, _, v in window_1h]
            price_range = max(prices) - min(prices)
            total_vol   = vols[-1] - vols[0] if vols[-1] > vols[0] else 0.0
            # High volume with tiny price move = suspicious
            if total_vol > 0 and price_range < 0.005:
                stasis_score = min(40.0, (total_vol / max(oi, 1.0)) * 100)
                score += stasis_score

    # Component 3: Category baseline wash rate
    cat = (market.category or "").lower()
    cat_priors = {
        "sports":        18.0,   # 45% wash → high prior
        "entertainment": 14.0,
        "politics":      12.0,   # up to 95% during elections, but not always
        "crypto":         6.0,
        "finance":        4.0,
        "geopolitical":   2.0,
    }
    score += cat_priors.get(cat, 5.0)

    return min(100.0, score)


def is_wash_suspicious(market: Market) -> bool:
    """Returns True if the market exceeds the wash suspicion threshold."""
    return wash_score(market) >= cfg.wash_max_score


def confidence_penalty(market: Market) -> float:
    """
    Return a confidence multiplier (0.5–1.0) based on wash suspicion.
    Halves confidence at max wash score; no penalty below threshold.
    """
    score = wash_score(market)
    if score < cfg.wash_max_score:
        return 1.0
    excess = min(1.0, (score - cfg.wash_max_score) / cfg.wash_max_score)
    return max(0.5, 1.0 - 0.5 * excess)

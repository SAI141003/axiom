"""
Longshot NO Bias / YES Optimism Tax Scanner (Strategy: longshot_no_bias)

Source: jbecker.dev "Microstructure of Wealth Transfer in Prediction Markets"
        Stanford/Kalshi adverse selection paper (588M on-chain trades)
        Akey et al. SSRN:6443103

Finding: Retail traders systematically overbet YES, especially at low prices.
  - 1-cent YES contracts: −41% EV
  - Equivalent 1-cent NO contracts: +23% EV
  - EV gap at extremes: up to 64 percentage points
  - Entertainment: 4.79pp maker edge | Sports: 2.23pp | Politics: 1.02pp

Mechanism:
  When a market prices YES at p < cfg.longshot_yes_max (e.g., 0.20), retail
  over-buys YES due to "Optimism Tax" / longshot bias. The NO side is
  structurally undervalued. Passively posting NO limit orders extracts the
  behavioral surplus.

Edge formula:
  behavioral_edge = optimism_premium(yes_price, category)
  net_edge = behavioral_edge − clob_taker_fee(1 − yes_price, category)
  Threshold: net_edge > cfg.longshot_min_edge

Category multipliers (from empirical data):
  Entertainment: 4.79pp / Politics: 1.02pp / Sports: 2.23pp
  Finance/Crypto: 0.17pp (efficient, skip)
"""
from __future__ import annotations

import logging
import time
from typing import Optional

from core.config import cfg
from core.models import Market
from core.events import Channel, bus

log = logging.getLogger(__name__)

# Category-specific optimism premium at p=0.10 YES (scales with (1-2p) curvature)
# Source: Stanford/jbecker.dev empirical per-domain maker edges
_CATEGORY_PREMIUM: dict[str, float] = {
    "entertainment": 0.0479,
    "sports":        0.0223,
    "politics":      0.0102,
    "geopolitical":  0.0100,
    "other":         0.0080,
    "finance":       0.0017,
    "crypto":        0.0017,
}

# Minimum YES price for the bias to be meaningful (below 5¢ = near-zero, skip)
_MIN_YES = 0.05


def _optimism_premium(yes_price: float, category: str) -> float:
    """
    Empirical optimism premium for NO on a longshot market.
    Scales quadratically with p(1-p): peaks at p=0.10-0.15 for longshots.
    Base premium is at yes_price=0.10; scale for other prices.
    """
    base = _CATEGORY_PREMIUM.get((category or "").lower(), 0.008)
    # Scale by relative deviation from 0.10 anchor (less premium as price rises)
    scale = max(0.0, 1.0 - (yes_price - 0.05) / (cfg.longshot_yes_max - 0.05))
    return base * scale


async def scan_longshot_no(markets: list[Market]) -> list[dict]:
    """
    Scan markets for longshot NO bias opportunities.
    Returns ArbOpportunity-compatible dicts.
    """
    from match.negrisk_arb import clob_taker_fee
    from signals.calibration import calibrated_prob

    opps: list[dict] = []

    for m in markets:
        if not (m.category or "").lower() in _CATEGORY_PREMIUM:
            continue
        if m.yes_price < _MIN_YES or m.yes_price > cfg.longshot_yes_max:
            continue
        # Skip near-resolution — risk of being wrong is too high
        if m.end_date:
            try:
                from datetime import datetime, timezone
                end_dt = datetime.fromisoformat(m.end_date.replace("Z", "+00:00"))
                tau_h = max(0.0, (end_dt - datetime.now(timezone.utc)).total_seconds() / 3600)
            except Exception:
                tau_h = 999.0
        else:
            tau_h = 999.0

        if tau_h < cfg.longshot_min_tau_hours:
            continue

        yes_p = m.yes_price
        no_p  = 1.0 - yes_p

        premium  = _optimism_premium(yes_p, m.category)
        fee      = clob_taker_fee(no_p, m.category)
        net_edge = premium - fee

        if net_edge < cfg.longshot_min_edge:
            continue

        # Calibration correction: does the calibrated probability support this?
        cal_no = 1.0 - calibrated_prob(yes_p, m.category, tau_h)
        if cal_no < no_p:
            continue  # calibration says market might be right

        opp_id = f"ls_{m.condition_id[:10]}_{int(time.time())}"
        opps.append({
            "id":                   opp_id[:20],
            "strategy":             "longshot_no_bias",
            "market_a_id":          m.condition_id,
            "market_a_question":    m.question[:80],
            "market_a_side":        "NO",
            "market_a_price":       round(no_p, 4),
            "market_b_id":          "",
            "market_b_question":    "",
            "market_b_side":        "NO",
            "market_b_price":       round(no_p, 4),
            "edge":                 round(net_edge, 4),
            "confidence":           round(min(0.72, net_edge / 0.05), 3),
            "reason": (
                f"Optimism tax: YES={yes_p:.3f} premium={premium:.3f} "
                f"fee={fee:.3f} net={net_edge:.3f} cat={m.category} tau={tau_h:.0f}h"
            ),
            "action": f"POST NO limit @ {no_p:.3f} (longshot YES overbet)",
            "ts":           time.time(),
            "spot_price":   0.0,
            "strike_price": 0.0,
            "tau_hours":    round(tau_h, 1),
            "realized_vol": 0.0,
            "model_prob":   round(cal_no, 4),
        })

    if opps:
        log.info(
            "LongshotNO: %d opps (avg edge=+%.1f%%)",
            len(opps), sum(o["edge"] for o in opps) / len(opps) * 100,
        )
    return opps

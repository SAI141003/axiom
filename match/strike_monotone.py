"""
Cross-Market Strike Monotonicity Arbitrage

Mathematical basis:
  For two crypto binary markets with the same asset and expiry:
    M1: "Will BTC be above $K1 at T?" → P(S_T > K1)
    M2: "Will BTC be above $K2 at T?" → P(S_T > K2)

  If K1 < K2, then necessarily: P(S_T > K1) ≥ P(S_T > K2)
  (Being above a lower bar is always at least as likely as being above a higher bar)

  When market prices VIOLATE this:
    devigged(P1) < devigged(P2) with K1 < K2
  → The crowd mispriced at least one market.

  Trade: BUY the underpriced side. Both sides to close at fair value.
  This is model-free (no σ, no τ assumptions) — pure logical impossibility.

Practical notes:
  - Use devigged prices to remove the market-maker vig before comparison.
  - Require a minimum violation of 2% (noise filter — thin books can cause
    apparent violations that resolve without trading).
  - Same asset + same expiry window (within ±300s) required.
  - Never trade the same pair twice in the same window.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Optional

from core.config import cfg

log = logging.getLogger(__name__)

_SCANNED_PAIRS: set[str] = set()

_STRIKE_RE = re.compile(
    r'\$\s*([\d,]+(?:\.\d+)?)\s*[kK]|\$\s*([\d,]+(?:\.\d+)?)', re.I
)
_ASSET_RE = re.compile(r'\b(BTC|ETH|SOL|DOGE|AVAX|XRP|bitcoin|ethereum|solana)\b', re.I)

_ASSET_NORM = {
    "bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL",
    "btc": "BTC", "eth": "ETH", "sol": "SOL",
    "doge": "DOGE", "avax": "AVAX", "xrp": "XRP",
}


def _parse_strike(question: str) -> Optional[float]:
    q = question.replace(",", "")
    m = re.search(r'\$\s*([\d]+(?:\.\d+)?)\s*[kK]', q)
    if m:
        return float(m.group(1)) * 1000
    m = re.search(r'\$\s*([\d]{3,}(?:\.\d+)?)', q)
    if m:
        return float(m.group(1))
    return None


def _parse_asset(question: str) -> Optional[str]:
    m = _ASSET_RE.search(question)
    if m:
        return _ASSET_NORM.get(m.group(1).lower(), m.group(1).upper())
    return None


def _devig(yes: float, no: float) -> float:
    total = yes + no
    return yes / total if total > 0 else yes


def _pair_key(id1: str, id2: str, window_ts: int) -> str:
    a, b = sorted([id1, id2])
    return f"{a}:{b}:{window_ts}"


def scan_strike_monotonicity(markets: list) -> list[dict]:
    """
    Scan active markets for cross-strike monotonicity violations.

    Groups markets by (asset, expiry_window) and checks every pair of
    "above $K" markets for P(K_low) < P(K_high) violations.

    Returns ArbOpportunity-compatible dicts.
    """
    from datetime import datetime, timezone

    now = time.time()
    opps: list[dict] = []

    # Group markets: (asset, expiry_bucket_300s) → [(market, strike, devigged_yes)]
    groups: dict[tuple[str, int], list] = {}

    for m in markets:
        if not m.end_date:
            continue
        q_lower = m.question.lower()
        if not any(w in q_lower for w in ("above", "exceed", "over", "higher")):
            continue  # only "above $K" markets

        asset = _parse_asset(m.question)
        strike = _parse_strike(m.question)
        if not asset or not strike or strike <= 0:
            continue

        if m.yes_price <= 0.05 or m.yes_price >= 0.95:
            continue  # near-resolved — skip

        try:
            end_dt = datetime.fromisoformat(m.end_date.replace("Z", "+00:00"))
            secs_remaining = (end_dt - datetime.now(timezone.utc)).total_seconds()
        except Exception:
            continue

        if secs_remaining <= 0 or secs_remaining > 86400:
            continue  # expired or too far out

        bucket = int(end_dt.timestamp()) // 300  # 5-min window bucket
        key = (asset, bucket)
        if key not in groups:
            groups[key] = []
        groups[key].append((m, strike, _devig(m.yes_price, m.no_price)))

    # Check each group for violations
    for (asset, bucket), entries in groups.items():
        if len(entries) < 2:
            continue

        # Sort by strike ascending
        entries.sort(key=lambda x: x[1])

        for i in range(len(entries)):
            for j in range(i + 1, len(entries)):
                m1, k1, p1 = entries[i]   # lower strike
                m2, k2, p2 = entries[j]   # higher strike

                if k1 >= k2:
                    continue

                pkey = _pair_key(m1.condition_id, m2.condition_id, bucket)
                if pkey in _SCANNED_PAIRS:
                    continue

                # Violation: P(S>K_low) < P(S>K_high) — logically impossible
                violation = p2 - p1   # positive = violation
                if violation < 0.02:
                    continue  # no violation or too small to act on

                # The cheaper (underpriced) market is M1 (lower strike, should cost MORE)
                # BUY YES on M1 (at p1) because it's trading below p2 (wrong)
                # BUY NO on M2  (at 1-p2) because M2 is overpriced vs M1
                edge = round(violation - 0.01, 4)  # minus 1 execution cost tick
                if edge < 0.02:
                    continue

                _SCANNED_PAIRS.add(pkey)

                log.info(
                    "StrikeMonotone: %s K1=$%s P1=%.3f  K2=$%s P2=%.3f  "
                    "violation=%.3f  (P(>K_low) < P(>K_high) impossible)",
                    asset, f"{k1:,.0f}", p1, f"{k2:,.0f}", p2, violation,
                )

                opps.append({
                    "id":                f"sm_{m1.condition_id[:6]}_{m2.condition_id[:6]}_{int(now)}",
                    "strategy":          "strike_monotone",
                    "market_a_id":       m1.condition_id,
                    "market_a_question": m1.question[:80],
                    "market_a_side":     "YES",
                    "market_a_price":    round(m1.yes_price, 4),
                    "market_b_id":       m2.condition_id,
                    "market_b_question": m2.question[:80],
                    "market_b_side":     "NO",
                    "market_b_price":    round(m2.no_price, 4),
                    "edge":              edge,
                    "confidence":        round(min(0.90, violation / 0.05 * 0.75), 3),
                    "reason": (
                        f"Monotone violation: P({asset}>$ {k1:,.0f})={p1:.3f} < "
                        f"P({asset}>$ {k2:,.0f})={p2:.3f} — impossible"
                    ),
                    "action": (
                        f"BUY YES M1 @ {m1.yes_price:.3f}  +  BUY NO M2 @ {m2.no_price:.3f}"
                    ),
                    "ts":            now,
                    "spot_price":    0.0,
                    "strike_price":  k1,
                    "tau_hours":     0.0,
                    "realized_vol":  round(violation, 4),
                    "model_prob":    round(0.5 + violation / 2, 4),
                })

    return opps

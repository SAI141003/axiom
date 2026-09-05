"""
Chainlink Oracle Lag Arbitrage — 5-min and 15-min BTC/ETH/SOL Markets

Source:
  - Chainlink integration docs (updates every 10-30s or on 0.5% price deviation)
  - Practitioner analysis: medium.com/@benjamin.bigdev
  - Bot reportedly turned $313 → $438K exploiting this lag

Mechanism:
  Polymarket 5-min and 15-min crypto binary markets resolve using a Chainlink
  price snapshot at EXACTLY the window end timestamp. Chainlink lags real-time
  spot by 10-30 seconds. In the final cfg.oracle_lag_window_s (default: 45s) of
  a window, real-time Binance WebSocket spot price is the ground truth.

  If |spot_move_in_final_window| > cfg.oracle_lag_min_move (0.25%):
    - If spot moved UP decisively → current YES price < 1.0 → BUY YES
    - If spot moved DOWN decisively → current NO price < 1.0 → BUY NO

  The Chainlink oracle is highly likely to confirm the move that already happened.

  IMPORTANT: Cannot execute in final cfg.oracle_lag_execution_cutoff_s (10s)
  due to blockchain confirmation latency (2-5s) + CLOB processing (~2s).

Risk controls:
  - Only enter when market YES price is between [0.20, 0.80] (avoid near-resolved)
  - Maximum position: cfg.btc_max_bet_usd
  - Never trade the same market window twice
  - Abort if spot reverses before blockchain confirmation

Market detection heuristic:
  Match question patterns: "Will BTC be above $X" with end_date within
  cfg.oracle_lag_max_window_remaining_s seconds.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from typing import Optional

from core.config import cfg
from core.events import Channel, bus

log = logging.getLogger(__name__)

# Per-asset recent tick buffer: {asset: deque[(ts, price)]}
_TICK_BUFFER: dict[str, deque] = {}
_BUFFER_MAXLEN = 200

# Markets already traded in their current window to avoid double entry
_TRADED_WINDOWS: set[str] = set()

_ASSET_PATTERNS = {
    "BTC": re.compile(r"btc|bitcoin", re.I),
    "ETH": re.compile(r"eth(?!er)|ethereum", re.I),
    "SOL": re.compile(r"\bsol\b|solana", re.I),
}


def push_spot_tick(asset: str, price: float) -> None:
    """Feed a live spot tick for oracle lag calculations. Called from market_watcher."""
    asset = asset.upper()
    if asset not in _TICK_BUFFER:
        _TICK_BUFFER[asset] = deque(maxlen=_BUFFER_MAXLEN)
    _TICK_BUFFER[asset].append((time.time(), price))


def _spot_move_pct(asset: str, window_s: float) -> Optional[float]:
    """
    Return the % price change in the last window_s seconds for an asset.
    Returns None if insufficient data.
    """
    buf = _TICK_BUFFER.get(asset.upper())
    if not buf or len(buf) < 2:
        return None
    now = time.time()
    cutoff = now - window_s
    recent = [(ts, p) for ts, p in buf if ts >= cutoff]
    if len(recent) < 2:
        return None
    price_start = recent[0][1]
    price_end   = recent[-1][1]
    if price_start <= 0:
        return None
    return (price_end - price_start) / price_start


def _detect_asset(question: str) -> Optional[str]:
    for asset, pat in _ASSET_PATTERNS.items():
        if pat.search(question):
            return asset
    return None


def _window_key(market_id: str, window_end_ts: float) -> str:
    return f"{market_id}:{int(window_end_ts // 60)}"


async def scan_oracle_lag(markets: list) -> list[dict]:
    """
    Scan all markets for oracle lag opportunities in their final window.
    Returns ArbOpportunity-compatible dicts.
    """
    opps: list[dict] = []
    now = time.time()

    for m in markets:
        if not m.end_date:
            continue
        if m.yes_price < 0.20 or m.yes_price > 0.80:
            continue

        try:
            from datetime import datetime, timezone
            end_dt = datetime.fromisoformat(m.end_date.replace("Z", "+00:00"))
            secs_remaining = (end_dt - datetime.now(timezone.utc)).total_seconds()
        except Exception:
            continue

        # Only act in the final window
        if not (cfg.oracle_lag_execution_cutoff_s < secs_remaining <= cfg.oracle_lag_window_s):
            continue

        asset = _detect_asset(m.question)
        if asset is None:
            continue

        wkey = _window_key(m.condition_id, end_dt.timestamp())
        if wkey in _TRADED_WINDOWS:
            continue

        move = _spot_move_pct(asset, cfg.oracle_lag_window_s)
        if move is None or abs(move) < cfg.oracle_lag_min_move:
            continue

        # Strike detection: extract USD threshold from question
        from match.arbitrage import _extract_usd_threshold
        strike = _extract_usd_threshold(m.question)
        if strike is None:
            continue

        # Does spot current price agree with the direction?
        current_spot = _TICK_BUFFER.get(asset.upper())
        if not current_spot:
            continue
        spot_now = current_spot[-1][1]

        if move > 0 and spot_now > strike:
            # Spot moved up AND is above strike → YES will resolve 1
            side = "YES"
            price = m.yes_price
        elif move < 0 and spot_now < strike:
            # Spot moved down AND is below strike → NO will resolve 1
            side = "NO"
            price = 1.0 - m.yes_price
        else:
            continue

        if price > 0.92:
            continue  # already priced in

        edge = round(1.0 - price - 0.01, 4)  # gap to par minus execution cost
        if edge < cfg.oracle_lag_min_edge:
            continue

        _TRADED_WINDOWS.add(wkey)

        # Multi-factor confidence:
        # 1. Move size: larger move = more decisive oracle confirmation
        # 2. Distance-to-strike: deeper ITM/OTM = oracle outcome is clear
        # 3. Time remaining: fewer seconds = less time for reversal before snapshot
        move_factor     = min(1.0, abs(move) / (cfg.oracle_lag_min_move * 2.0))
        dist_pct        = abs(spot_now - strike) / max(strike, 1.0)
        dist_factor     = min(1.0, dist_pct / 0.005)   # 0.5% distance = full credit
        time_left       = secs_remaining - cfg.oracle_lag_execution_cutoff_s
        time_factor     = 1.0 - time_left / max(cfg.oracle_lag_window_s, 1.0)  # closer = higher
        confidence      = round(min(0.92, 0.50 + 0.20 * move_factor + 0.15 * dist_factor + 0.15 * time_factor), 3)

        opps.append({
            "id":                   f"ol_{m.condition_id[:8]}_{int(now)}",
            "strategy":             "oracle_lag",
            "market_a_id":          m.condition_id,
            "market_a_question":    m.question[:80],
            "market_a_side":        side,
            "market_a_price":       round(price, 4),
            "market_b_id":          "",
            "market_b_question":    "",
            "market_b_side":        side,
            "market_b_price":       round(price, 4),
            "edge":                 edge,
            "confidence":           confidence,
            "reason": (
                f"Chainlink lag: {asset} moved {move*100:+.2f}% in {cfg.oracle_lag_window_s:.0f}s "
                f"spot={spot_now:.0f} strike={strike:.0f} "
                f"secs_left={secs_remaining:.0f}"
            ),
            "action": (
                f"BUY {side} @ {price:.3f} (oracle will confirm {asset} "
                f"{'above' if side=='YES' else 'below'} {strike:.0f})"
            ),
            "ts":           now,
            "spot_price":   round(spot_now, 2),
            "strike_price": round(strike, 2),
            "tau_hours":    round(secs_remaining / 3600, 4),
            "realized_vol": round(abs(move), 6),
            "model_prob":   1.0,
        })
        log.info(
            "OracleLag: %s %s @ %.3f | %s move=%.2f%% secs_left=%.0f",
            m.condition_id[:8], side, price, asset, move * 100, secs_remaining,
        )

    return opps

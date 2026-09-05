"""
UMA Dispute Front-Running — Post-Filing LLM Resolution Prediction

Source:
  - arXiv:2604.15674 "Can LLMs Help Decentralized Dispute Arbitration?" (2025)
  - March 2025 governance attack ($7M, price 9% → 100%)
  - Reported accuracy: 89.6% once a dispute is raised

Mechanism:
  When a Polymarket market enters UMA dispute state (paused/disputed), the
  resolution is delayed 2+ hours and goes to UMA token-holder vote. LLMs achieve
  89.6% accuracy reproducing UMA's final outcome once a dispute is raised.

  Flow:
  1. Poll Gamma API for markets with game_status="disputed" or similar states
  2. When a new dispute is detected, query Claude to predict resolution
  3. If confidence ≥ cfg.uma_min_confidence, publish opportunity
  4. Edge: gap between current market price and the predicted resolution (0 or 1)

  Why this works:
    - The dispute market price is still live and tradeable
    - Most disputes are frivolous (89.6% resolve in the predictable direction)
    - 2+ hour window gives time to enter and wait

Resolution classification prompt:
  Claude evaluates the disputed question against available evidence and
  outputs YES or NO with a confidence float. Cached per market_id.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

import aiohttp

from core.config import cfg

log = logging.getLogger(__name__)

GAMMA_BASE = "https://gamma-api.polymarket.com"
_SCAN_INTERVAL = cfg.uma_dispute_scan_interval
_SEEN_DISPUTES: set[str] = set()   # condition_ids already acted on


async def _fetch_disputed_markets() -> list[dict]:
    """Fetch markets currently in a disputed/paused state from Gamma API."""
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{GAMMA_BASE}/markets",
                params={"game_status": "disputed", "limit": 50},
                headers={"Accept": "application/json"},
                timeout=aiohttp.ClientTimeout(total=8.0),
            ) as r:
                if r.status != 200:
                    return []
                data = await r.json()
                return data if isinstance(data, list) else data.get("markets", [])
    except Exception as exc:
        log.debug("UMADispute: fetch error: %s", exc)
        return []


async def _predict_resolution(question: str, description: str) -> tuple[str, float]:
    """
    Ask Claude to predict UMA resolution for a disputed market.
    Returns (side, confidence) where side is "YES" or "NO".
    Falls back to ("SKIP", 0) on any failure.
    """
    try:
        import anthropic
        client = anthropic.AsyncAnthropic()
        prompt = (
            f"A Polymarket prediction market is currently in UMA dispute.\n\n"
            f"Market question: {question}\n"
            f"Description: {description or 'No additional description.'}\n\n"
            f"Based on publicly available information and the wording of the question, "
            f"predict how UMA token holders will vote to resolve this market.\n\n"
            f"Respond with JSON only: {{\"resolution\": \"YES\" or \"NO\", "
            f"\"confidence\": 0.0-1.0, \"reasoning\": \"one sentence\"}}"
        )
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=120,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        # Extract JSON even if wrapped in markdown
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        parsed = json.loads(raw[start:end])
        side = parsed.get("resolution", "SKIP").upper()
        conf = float(parsed.get("confidence", 0.0))
        if side not in ("YES", "NO"):
            return "SKIP", 0.0
        return side, conf
    except Exception as exc:
        log.debug("UMADispute: LLM predict error: %s", exc)
        return "SKIP", 0.0


async def scan_uma_disputes() -> list[dict]:
    """
    Check for newly disputed markets, predict resolution, return opportunities.
    """
    disputed = await _fetch_disputed_markets()
    opps: list[dict] = []

    for m in disputed:
        condition_id = m.get("conditionId") or m.get("condition_id", "")
        if not condition_id or condition_id in _SEEN_DISPUTES:
            continue

        question    = m.get("question", "")
        description = m.get("description", "")
        yes_price   = float(m.get("bestBid") or m.get("yes_price") or 0.5)

        if not question:
            continue

        side, conf = await _predict_resolution(question, description)
        if side == "SKIP" or conf < cfg.uma_min_confidence:
            _SEEN_DISPUTES.add(condition_id)
            continue

        price = yes_price if side == "YES" else 1.0 - yes_price
        edge  = round((1.0 - price) * conf - 0.01, 4)  # expected value minus execution cost

        if edge <= 0:
            _SEEN_DISPUTES.add(condition_id)
            continue

        _SEEN_DISPUTES.add(condition_id)
        opps.append({
            "id":                   f"uma_{condition_id[:8]}_{int(time.time())}",
            "strategy":             "uma_dispute",
            "market_a_id":          condition_id,
            "market_a_question":    question[:80],
            "market_a_side":        side,
            "market_a_price":       round(price, 4),
            "market_b_id":          "",
            "market_b_question":    "",
            "market_b_side":        side,
            "market_b_price":       round(price, 4),
            "edge":                 edge,
            "confidence":           round(conf, 3),
            "reason": (
                f"UMA dispute detected — LLM predicts {side} "
                f"conf={conf:.0%} (89.6% empirical accuracy post-filing)"
            ),
            "action": f"BUY {side} @ {price:.3f} — UMA will resolve {side}",
            "ts":           time.time(),
            "spot_price":   0.0,
            "strike_price": 0.0,
            "tau_hours":    2.0,  # typical 2h UMA resolution window
            "realized_vol": 0.0,
            "model_prob":   round(conf, 4),
        })
        log.info(
            "UMADispute: %s → %s conf=%.0%% edge=+%.1f%%",
            condition_id[:8], side, conf, edge * 100,
        )

    return opps


class UMADisputeScanner:
    """Periodic scanner for UMA disputed markets."""

    async def run(self) -> None:
        from core.events import Channel, bus
        while True:
            await asyncio.sleep(_SCAN_INTERVAL)
            try:
                opps = await scan_uma_disputes()
                for opp in opps:
                    await bus.publish(Channel.ARB_OPPORTUNITY, opp)
            except Exception as exc:
                log.debug("UMADispute: scan error: %s", exc)


scanner = UMADisputeScanner()

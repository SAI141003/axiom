"""
Compound Layer — Nightly Self-Learning Review

Mirrors the BONEREAPER / CLAUDE × HERMES nightly loop:
  1. TRADE EXECUTES  — already running, logs to PostgreSQL all day
  2. NIGHTLY REVIEW  — load last N resolved trades, compute per-state EV,
                       win-rate by Markov state, EV breakdown
  3. STRATEGY UPDATE — use Claude Opus to analyze journal and output updated
                       params as JSON; write to Redis so next session is smarter

Updated params written to Redis (key: "cfg:live"):
  min_prob       — minimum p_model to enter a trade
  min_edge       — minimum edge threshold
  kelly_lambda   — risk-aversion shrinkage factor
  btc_persistence— minimum Markov persistence for BTC

Claude prompt structure (structured output):
  - Win/loss breakdown by Markov state (UP/DOWN)
  - EV per state: expected value given historical outcomes
  - Parameter suggestions with reasoning
  - Returns JSON: {min_prob, min_edge, kelly_lambda, btc_persistence, notes}

Schedule: asyncio loop that sleeps until cfg.nightly_review_hour, then fires.
Rate limit: at most once per 20 hours (prevents double-fire on restart).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Optional

from core.config import cfg
from persist import redis_state
from persist.db import get_resolved_signal_outcomes, get_brier_score

log = logging.getLogger(__name__)

_LAST_REVIEW_KEY = "nightly_review:last_run_ts"
_LIVE_CFG_KEY = "cfg:live"
_MIN_INTERVAL_S = 72_000  # 20 hours — prevent double-fire


async def _load_live_params() -> dict:
    """Load currently active params from Redis (falls back to cfg defaults)."""
    raw = await redis_state.cache_get(_LIVE_CFG_KEY)
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return {
        "min_prob":        cfg.materiality_threshold,
        "min_edge":        cfg.edge_threshold,
        "kelly_lambda":    cfg.kelly_lambda,
        "btc_persistence": cfg.markov_min_persistence,
    }


async def get_live_param(key: str, default: float) -> float:
    """Read a single live param from Redis. Used at signal evaluation time."""
    params = await _load_live_params()
    return float(params.get(key, default))


async def _analyze_with_claude(journal: list[dict], current_params: dict) -> Optional[dict]:
    """
    Send structured trade journal to Claude Opus for analysis.
    Returns updated param dict or None if API unavailable.
    Includes research digest from ResearchWorker so Claude sees recent papers.
    """
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=cfg.anthropic_api_key)

        win_trades = [t for t in journal if t.get("resolved_yes") == (1 if t.get("side") == "YES" else 0)]
        loss_trades = [t for t in journal if t not in win_trades]

        avg_win_p  = sum(t["p_model"] for t in win_trades)  / max(len(win_trades), 1)
        avg_loss_p = sum(t["p_model"] for t in loss_trades) / max(len(loss_trades), 1)
        win_rate   = len(win_trades) / max(len(journal), 1)
        avg_edge   = sum(t.get("edge", 0) for t in journal) / max(len(journal), 1)

        # Markov state breakdown
        up_trades   = [t for t in journal if t.get("markov_state") == "up"]
        down_trades = [t for t in journal if t.get("markov_state") == "down"]
        up_wr   = sum(1 for t in up_trades   if t.get("pnl", 0) > 0) / max(len(up_trades), 1)
        down_wr = sum(1 for t in down_trades if t.get("pnl", 0) > 0) / max(len(down_trades), 1)

        # Include research digest — lets Claude Opus reason about academic improvements
        research_section = ""
        try:
            from signals.research_advisor import research_digest
            digest = await research_digest(days=30, max_papers=5)
            if digest:
                research_section = f"\n\nRECENT ACADEMIC RESEARCH (from arXiv scan):\n{digest}"
        except Exception:
            pass

        prompt = f"""You are reviewing a Polymarket prediction market trading bot's performance journal.

CURRENT PARAMETERS:
- min_prob (materiality threshold): {current_params['min_prob']:.3f}
- min_edge: {current_params['min_edge']:.3f}
- kelly_lambda (risk aversion): {current_params['kelly_lambda']:.2f}
- btc_persistence (Markov threshold): {current_params['btc_persistence']:.3f}

LAST {len(journal)} RESOLVED TRADES:
- Win rate: {win_rate:.1%}
- Avg edge on winners: {avg_win_p:.3f}
- Avg edge on losers: {avg_loss_p:.3f}
- Mean edge traded: {avg_edge:.3f}
- Markov UP state win rate: {up_wr:.1%} ({len(up_trades)} trades)
- Markov DOWN state win rate: {down_wr:.1%} ({len(down_trades)} trades)
{research_section}

TASK: Analyze this performance and suggest parameter updates.
Rules:
- Only adjust params by max ±15% per night to prevent oscillation
- If win_rate > 0.70, consider lowering min_edge slightly (capturing more opportunities)
- If win_rate < 0.50, raise min_prob and min_edge
- If UP state win_rate >> DOWN state win_rate, raise btc_persistence
- kelly_lambda range: [0.8, 3.0]; min_prob range: [0.5, 0.75]; min_edge: [0.02, 0.08]
- If research suggests a concrete formula improvement, mention it in notes

Return ONLY valid JSON, no prose:
{{"min_prob": float, "min_edge": float, "kelly_lambda": float, "btc_persistence": float, "notes": "one line reason"}}"""

        msg = await client.messages.create(
            model="claude-opus-4-7-20251101",
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        return json.loads(raw.strip())

    except Exception as exc:
        log.warning("NightlyReview: Claude analysis failed: %s", exc)
        return None


async def run_review() -> dict:
    """
    Execute one full nightly review cycle.
    Returns summary dict with what changed.
    """
    log.info("NightlyReview: starting review")

    # Rate limit
    last_ts_raw = await redis_state.cache_get(_LAST_REVIEW_KEY)
    if last_ts_raw:
        elapsed = time.time() - float(last_ts_raw)
        if elapsed < _MIN_INTERVAL_S:
            log.info("NightlyReview: skipping, ran %.1fh ago", elapsed / 3600)
            return {"skipped": True, "reason": "rate_limit"}

    # Load trade journal
    rows = await get_resolved_signal_outcomes(limit=500)
    if len(rows) < cfg.nightly_review_min_trades:
        log.info("NightlyReview: only %d resolved trades, need %d — skipping",
                 len(rows), cfg.nightly_review_min_trades)
        return {"skipped": True, "reason": "insufficient_data"}

    current_params = await _load_live_params()

    # Run Claude analysis
    updated = await _analyze_with_claude(rows, current_params)
    if updated is None:
        log.warning("NightlyReview: no Claude response, keeping current params")
        return {"skipped": True, "reason": "claude_unavailable"}

    # Clamp all values to safe ranges before writing
    safe = {
        "min_prob":        max(0.50, min(0.75, float(updated.get("min_prob", current_params["min_prob"])))),
        "min_edge":        max(0.02, min(0.08, float(updated.get("min_edge", current_params["min_edge"])))),
        "kelly_lambda":    max(0.80, min(3.00, float(updated.get("kelly_lambda", current_params["kelly_lambda"])))),
        "btc_persistence": max(0.70, min(0.95, float(updated.get("btc_persistence", current_params["btc_persistence"])))),
    }
    notes = updated.get("notes", "")

    # Persist to Redis (TTL 25 hours — refreshed each night)
    await redis_state.cache_set(_LIVE_CFG_KEY, json.dumps(safe), ttl=90_000)
    await redis_state.cache_set(_LAST_REVIEW_KEY, str(time.time()), ttl=90_000)

    log.info(
        "NightlyReview: params updated | min_prob=%.3f min_edge=%.3f "
        "kelly_lambda=%.2f btc_persistence=%.3f | %s",
        safe["min_prob"], safe["min_edge"], safe["kelly_lambda"],
        safe["btc_persistence"], notes,
    )
    return {"updated": safe, "notes": notes, "n_trades": len(rows)}


class NightlyReviewWorker:
    """Background worker that fires the review loop at cfg.nightly_review_hour."""

    def __init__(self) -> None:
        self._running = False

    async def run(self) -> None:
        if not cfg.nightly_review_enabled:
            log.info("NightlyReview: disabled via config")
            return
        self._running = True
        log.info("NightlyReview: worker started (fires at %02d:00)", cfg.nightly_review_hour)
        while self._running:
            await self._sleep_until_review_hour()
            await run_review()

    async def _sleep_until_review_hour(self) -> None:
        now = datetime.now(timezone.utc)
        target_h = cfg.nightly_review_hour
        seconds_since_midnight = now.hour * 3600 + now.minute * 60 + now.second
        target_s = target_h * 3600
        if seconds_since_midnight >= target_s:
            # Already past today's review hour — sleep until tomorrow
            wait = 86_400 - seconds_since_midnight + target_s
        else:
            wait = target_s - seconds_since_midnight
        log.info("NightlyReview: sleeping %.1fh until %02d:00", wait / 3600, target_h)
        await asyncio.sleep(wait)

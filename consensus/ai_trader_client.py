"""
AI-Trader signal consensus layer.

Publishes signals to ai4trade.ai platform and monitors how many independent
agents copy the same signal within 30 seconds. Consensus from 3+ agents
increases Kelly fraction by cfg.kelly_consensus_bonus.

Also uses AI-Trader for parallel paper trading calibration — we publish
every signal and track the auto-settlement results to validate our
probability estimates without risking real capital.

API at https://api.ai4trade.ai:
  POST /auth/register  — one-time registration
  POST /copytrade/push — publish signal
  GET  /heartbeat      — poll for followers/copies (every 30s)
  GET  /positions      — track paper trading results
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

import aiohttp

from core.config import cfg
from core.models import Signal, SignalDirection

log = logging.getLogger(__name__)

_API_TOKEN: str | None = None
_SIGNAL_COPY_COUNTS: dict[str, int] = {}  # signal_id → copy count
_COPY_WINDOW_S = 30.0  # seconds to wait for consensus


async def _ensure_registered() -> bool:
    """Register with AI-Trader on first use. Returns True if authenticated."""
    global _API_TOKEN
    if _API_TOKEN:
        return True
    if not cfg.ai_trader_api_key:
        log.info("AI-Trader: no API key, consensus disabled")
        return False

    _API_TOKEN = cfg.ai_trader_api_key
    return True


async def publish_signal(signal: Signal) -> bool:
    """
    Publish a trading signal to AI-Trader platform.
    Returns True on success.
    """
    if not cfg.use_ai_trader_consensus:
        return False

    if not await _ensure_registered():
        return False

    action = "buy" if signal.direction == SignalDirection.BULLISH else "sell"
    payload = {
        "symbol": signal.market.condition_id,
        "action": action,
        "price": signal.target_price,
        "quantity": signal.approved_size,
        "note": f"edge={signal.edge:.3f} mat={signal.materiality:.2f} | {signal.reasoning[:100]}",
    }

    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=5),
            headers={"Authorization": f"Bearer {_API_TOKEN}"},
        ) as session:
            async with session.post(
                f"{cfg.ai_trader_base_url}/copytrade/push",
                json=payload,
            ) as resp:
                if resp.status in (200, 201):
                    _SIGNAL_COPY_COUNTS[signal.id] = 0
                    return True
                log.debug("AI-Trader: publish failed (status %d)", resp.status)
    except Exception as exc:
        log.debug("AI-Trader: publish error: %s", exc)

    return False


async def wait_for_consensus(signal: Signal, timeout_s: float = _COPY_WINDOW_S) -> int:
    """
    Wait up to timeout_s for other agents to copy this signal.
    Returns the number of copies (consensus count).
    """
    if not cfg.use_ai_trader_consensus or not _API_TOKEN:
        return 0

    deadline = time.time() + timeout_s
    last_count = 0

    while time.time() < deadline:
        await asyncio.sleep(5)  # poll every 5s
        count = await _get_copy_count(signal)
        if count >= 3:
            log.info("AI-Trader: consensus signal %d copies for '%s'",
                     count, signal.market.question[:40])
            return count
        last_count = count

    return last_count


async def _get_copy_count(signal: Signal) -> int:
    """Poll heartbeat to get current copy count for a signal."""
    if not _API_TOKEN:
        return 0
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=5),
            headers={"Authorization": f"Bearer {_API_TOKEN}"},
        ) as session:
            async with session.get(
                f"{cfg.ai_trader_base_url}/heartbeat",
                params={"signal_id": signal.id},
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    # Parse copy count from heartbeat response
                    copies = data.get("copies", data.get("followers", 0))
                    return int(copies)
    except Exception:
        pass
    return 0


class ConsensusTracker:
    """
    Background heartbeat poller — checks AI-Trader for replies,
    followers, and paper trading results for probability calibration.

    Paper trading: AI-Trader settles each published signal against the
    real market outcome using $100K simulated capital. We fetch these
    results every 5 minutes to validate our p_model estimates — a
    disagreement between paper PnL and our model flags miscalibration.
    """

    def __init__(self) -> None:
        self._paper_wins = 0
        self._paper_losses = 0
        self._paper_pnl_usd = 0.0

    async def run(self) -> None:
        if not cfg.use_ai_trader_consensus:
            return
        if not await _ensure_registered():
            return

        await asyncio.gather(
            self._heartbeat_loop(),
            self._paper_trade_sync_loop(),
        )

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                await self._poll_heartbeat()
            except Exception as exc:
                log.debug("ConsensusTracker: heartbeat error: %s", exc)

    async def _paper_trade_sync_loop(self) -> None:
        """Fetch paper trading results every 5 minutes for calibration."""
        while True:
            await asyncio.sleep(300)
            try:
                await self._sync_paper_positions()
            except Exception as exc:
                log.debug("ConsensusTracker: paper sync error: %s", exc)

    async def _poll_heartbeat(self) -> None:
        if not _API_TOKEN:
            return
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=5),
                headers={"Authorization": f"Bearer {_API_TOKEN}"},
            ) as session:
                async with session.get(f"{cfg.ai_trader_base_url}/heartbeat") as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        log.debug("AI-Trader heartbeat: %s", data)
        except Exception:
            pass

    async def _sync_paper_positions(self) -> None:
        """
        Fetch settled paper trades from AI-Trader /positions endpoint.
        Uses results to validate p_model calibration — paper PnL is a
        ground-truth signal on whether our probability estimates are correct.
        """
        if not _API_TOKEN:
            return
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10),
                headers={"Authorization": f"Bearer {_API_TOKEN}"},
            ) as session:
                async with session.get(
                    f"{cfg.ai_trader_base_url}/positions",
                    params={"status": "settled", "limit": 50},
                ) as resp:
                    if resp.status != 200:
                        return
                    data = await resp.json()

            positions = data if isinstance(data, list) else data.get("positions", [])
            new_wins = new_losses = 0
            for pos in positions:
                pnl = float(pos.get("pnl", pos.get("profit_loss", 0)))
                if pnl > 0:
                    new_wins += 1
                    self._paper_pnl_usd += pnl
                elif pnl < 0:
                    new_losses += 1
                    self._paper_pnl_usd += pnl

            self._paper_wins += new_wins
            self._paper_losses += new_losses

            total = self._paper_wins + self._paper_losses
            if total > 0:
                paper_win_rate = self._paper_wins / total
                log.info(
                    "AI-Trader paper: %d settled, win_rate=%.2f, pnl=$%.2f",
                    total, paper_win_rate, self._paper_pnl_usd,
                )
                # Warn if paper win rate drops below 45% — model may be miscalibrated
                if total >= 20 and paper_win_rate < 0.45:
                    log.warning(
                        "AI-Trader paper win_rate=%.2f < 0.45 — check p_model calibration",
                        paper_win_rate,
                    )
        except Exception as exc:
            log.debug("ConsensusTracker: paper sync failed: %s", exc)

    def get_paper_stats(self) -> dict:
        total = self._paper_wins + self._paper_losses
        return {
            "paper_wins": self._paper_wins,
            "paper_losses": self._paper_losses,
            "paper_win_rate": round(self._paper_wins / total, 3) if total else None,
            "paper_pnl_usd": round(self._paper_pnl_usd, 2),
        }

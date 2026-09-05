"""
MiroFish scenario simulation client.

MiroFish runs multi-agent world simulation: GraphRAG → agent personas →
parallel simulation → report generation.

Integration strategy (respects MiroFish's latency constraints):
  - MiroFish is NOT in the hot path (minutes of simulation time)
  - We pre-stage research for upcoming slow-resolution markets 24h ahead
  - Results are cached in Redis with 24h TTL
  - Signal engine checks cache; if hit, uses the probability estimate as
    an additional input to ensemble.py
  - A background task periodically identifies high-value uncertain markets
    and queues them for MiroFish simulation

API endpoints (MiroFish backend at cfg.mirofish_base_url):
  POST /api/simulate    — submit simulation request
  GET  /api/status/{id} — check status
  GET  /api/report/{id} — fetch completed report
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

import aiohttp

from core.config import cfg
from core.models import Market, SignalDirection
from persist import redis_state

log = logging.getLogger(__name__)

CACHE_TTL_S = 86400  # 24h


class MiroFishReport:
    """Parsed output from a MiroFish simulation."""

    def __init__(
        self,
        market_id: str,
        p_estimate: float,
        direction: SignalDirection,
        summary: str,
        confidence: float,
        generated_at: float,
    ) -> None:
        self.market_id = market_id
        self.p_estimate = p_estimate
        self.direction = direction
        self.summary = summary
        self.confidence = confidence
        self.generated_at = generated_at

    def to_dict(self) -> dict:
        return {
            "market_id": self.market_id,
            "p_estimate": self.p_estimate,
            "direction": self.direction.value,
            "summary": self.summary,
            "confidence": self.confidence,
            "generated_at": self.generated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "MiroFishReport":
        return cls(
            market_id=d["market_id"],
            p_estimate=d["p_estimate"],
            direction=SignalDirection(d["direction"]),
            summary=d["summary"],
            confidence=d["confidence"],
            generated_at=d["generated_at"],
        )


async def _get_cached_report(market_id: str) -> Optional[MiroFishReport]:
    """Check Redis for a cached MiroFish report."""
    try:
        raw = await redis_state.cache_get(f"mirofish:{market_id}")
        if raw:
            return MiroFishReport.from_dict(json.loads(raw))
    except Exception:
        pass
    return None


async def _cache_report(report: MiroFishReport) -> None:
    """Cache report in Redis."""
    try:
        await redis_state.cache_set(
            f"mirofish:{report.market_id}",
            json.dumps(report.to_dict()),
            ttl=CACHE_TTL_S,
        )
    except Exception as exc:
        log.debug("MiroFish: cache write error: %s", exc)


async def _submit_simulation(market: Market) -> Optional[str]:
    """Submit a simulation request to MiroFish. Returns simulation_id or None."""
    if not cfg.mirofish_base_url:
        return None

    seed_material = f"""
Prediction Market Research Request

Question: {market.question}
Market Category: {market.category}
Current YES Price: {market.yes_price:.2f} (implied {market.yes_price*100:.0f}% probability)
Market Volume: ${market.volume:,.0f}

Please simulate the relevant ecosystem of agents (experts, policymakers, market participants,
news commentators) and forecast the probability that this question resolves YES.
Focus on: key factors driving the outcome, consensus probability estimate, confidence level.
"""

    # MiroFish uses LLM_API_KEY / LLM_BASE_URL / LLM_MODEL_NAME as server env vars.
    # The simulation request only needs seed material and goal.
    # If running a local MiroFish instance, set those env vars to point at NVIDIA NIM:
    #   LLM_API_KEY=<nvidia_api_key>
    #   LLM_BASE_URL=https://integrate.api.nvidia.com/v1
    #   LLM_MODEL_NAME=google/gemma-4-31b-it
    payload = {
        "seed": seed_material,
        "goal": f"Estimate probability that the following resolves YES: {market.question}",
    }

    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30)
        ) as session:
            async with session.post(
                f"{cfg.mirofish_base_url}/api/simulate",
                json=payload,
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("simulation_id")
                else:
                    log.warning("MiroFish: submit failed (status %d)", resp.status)
    except Exception as exc:
        log.debug("MiroFish: submit error: %s", exc)
    return None


async def _poll_for_report(sim_id: str, timeout_s: float = 300) -> Optional[dict]:
    """Poll MiroFish for simulation completion. Returns raw report dict or None."""
    deadline = time.time() + timeout_s
    poll_interval = 10  # check every 10s

    while time.time() < deadline:
        await asyncio.sleep(poll_interval)
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10)
            ) as session:
                async with session.get(
                    f"{cfg.mirofish_base_url}/api/status/{sim_id}"
                ) as resp:
                    if resp.status != 200:
                        continue
                    data = await resp.json()

                if data.get("status") == "completed":
                    async with session.get(
                        f"{cfg.mirofish_base_url}/api/report/{sim_id}"
                    ) as resp:
                        if resp.status == 200:
                            return await resp.json()
        except Exception as exc:
            log.debug("MiroFish: poll error: %s", exc)

    return None


def _parse_report(market_id: str, raw: dict) -> MiroFishReport:
    """Extract probability estimate from MiroFish report."""
    report_text = raw.get("report", raw.get("summary", ""))

    # Extract probability from report text
    import re
    p_estimate = 0.5  # default if parsing fails

    patterns = [
        r"probability[:\s]+(\d+(?:\.\d+)?)\s*%",
        r"(\d+(?:\.\d+)?)\s*%\s*(?:probability|chance|likelihood)",
        r"p\s*=\s*0\.(\d+)",
        r"(\d+(?:\.\d+)?)\s*%\s+(?:YES|yes|resolve)",
    ]
    for pattern in patterns:
        match = re.search(pattern, report_text, re.IGNORECASE)
        if match:
            val_str = match.group(1)
            val = float(val_str)
            if val > 1:
                val /= 100
            p_estimate = max(0.05, min(0.95, val))
            break

    direction = SignalDirection.BULLISH if p_estimate > 0.5 else SignalDirection.BEARISH
    confidence = raw.get("confidence", 0.6)

    return MiroFishReport(
        market_id=market_id,
        p_estimate=p_estimate,
        direction=direction,
        summary=report_text[:500],
        confidence=float(confidence),
        generated_at=time.time(),
    )


async def get_report(market: Market) -> Optional[MiroFishReport]:
    """
    Get MiroFish report for a market.
    Returns cached version if available, or None if not yet computed.
    Does NOT block for simulation (that is done by the background pre-stager).
    """
    if not cfg.use_mirofish:
        return None
    return await _get_cached_report(market.condition_id)


async def pre_stage(market: Market) -> None:
    """
    Submit market to MiroFish for background simulation.
    Called by the compound worker for high-uncertainty markets.
    Results are cached when simulation completes.
    """
    if not cfg.use_mirofish:
        return

    # Don't re-simulate if we have a fresh report
    existing = await _get_cached_report(market.condition_id)
    if existing and (time.time() - existing.generated_at) < 43200:  # 12h
        return

    log.info("MiroFish: pre-staging simulation for '%s'", market.question[:60])

    sim_id = await _submit_simulation(market)
    if not sim_id:
        return

    # Poll in background (non-blocking)
    async def _wait_and_cache():
        raw = await _poll_for_report(sim_id, timeout_s=600)
        if raw:
            report = _parse_report(market.condition_id, raw)
            await _cache_report(report)
            log.info("MiroFish: cached report for '%s' (p=%.2f)", market.question[:50], report.p_estimate)

    asyncio.create_task(_wait_and_cache())


class MiroFishPreStager:
    """
    Background task that identifies high-value uncertain markets and
    queues them for MiroFish simulation.

    Criteria for pre-staging:
    - Market volume > $50K (worth the simulation cost)
    - YES price between 0.25 and 0.75 (maximum uncertainty)
    - No existing cached report
    - Resolution > 24h away (enough time for simulation)
    """

    async def run(self) -> None:
        while True:
            await asyncio.sleep(3600)  # check hourly
            try:
                await self._identify_and_stage()
            except Exception as exc:
                log.warning("MiroFishPreStager: error: %s", exc)

    async def _identify_and_stage(self) -> None:
        from persist.redis_state import get_all_markets

        markets = await get_all_markets()
        candidates = [
            m for m in markets
            if m.volume > 50_000
            and 0.25 <= m.yes_price <= 0.75
        ]

        log.info("MiroFishPreStager: %d candidates for simulation", len(candidates))

        # Stage up to 5 per cycle (cost control)
        for market in candidates[:5]:
            await pre_stage(market)
            await asyncio.sleep(2)  # don't flood MiroFish

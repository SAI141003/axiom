"""
Claude Haiku → Gemma 4 (NVIDIA NIM) news classifier.

Primary: NVIDIA NIM OpenAI-compatible endpoint (google/gemma-4-31b-it)
Fallback: Anthropic Claude Haiku (if nvidia_api_key is not set)

Both paths return the same ClassifierOutput. The switch is transparent
to all callers — ensemble.py, signal_worker.py, tests all unchanged.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)

from core.config import cfg
from core.models import ClassifierOutput, Market, NewsEvent, SignalDirection

log = logging.getLogger(__name__)

_OPENAI_CLIENT = None
_ANTHROPIC_CLIENT = None


def _get_nvidia_client():
    global _OPENAI_CLIENT
    if _OPENAI_CLIENT is None:
        from openai import AsyncOpenAI
        _OPENAI_CLIENT = AsyncOpenAI(
            api_key=cfg.nvidia_api_key,
            base_url=cfg.nvidia_base_url,
            timeout=20.0,  # Gemma 4 31B needs more headroom than smaller models
        )
    return _OPENAI_CLIENT


def _get_anthropic_client():
    global _ANTHROPIC_CLIENT
    if _ANTHROPIC_CLIENT is None:
        from anthropic import AsyncAnthropic
        _ANTHROPIC_CLIENT = AsyncAnthropic(api_key=cfg.anthropic_api_key)
    return _ANTHROPIC_CLIENT


def _use_nvidia() -> bool:
    return bool(cfg.nvidia_api_key)


SYSTEM_PROMPT = """You are a prediction market analyst. For each news event and market question, determine:
1. Whether the news makes the market MORE likely to resolve YES, MORE likely to resolve NO, or NOT RELEVANT.
2. How materially impactful the news is (0.0 = no impact, 1.0 = near-certain resolution).

Respond ONLY with valid JSON in this exact format:
{
  "direction": "bullish" | "bearish" | "neutral",
  "materiality": <float 0.0-1.0>,
  "reasoning": "<one sentence>"
}

Rules:
- "bullish" = news makes YES resolution more likely
- "bearish" = news makes NO resolution more likely
- "neutral" = news is not materially relevant to this market
- materiality ≥ 0.7: near-certain directional impact
- materiality 0.4-0.7: moderate impact
- materiality < 0.4: weak or ambiguous signal"""


USER_TEMPLATE = """MARKET QUESTION: {question}
CURRENT YES PRICE: {yes_price:.2f} (implied {prob:.0f}% probability)
MARKET VOLUME: ${volume:,.0f}
CATEGORY: {category}

NEWS HEADLINE: {headline}
SOURCE: {source}
PUBLISHED: {age_s:.0f}s ago

Classify this news event's impact on the market question above."""


def _build_user_msg(news: NewsEvent, market: Market) -> str:
    return USER_TEMPLATE.format(
        question=market.question,
        yes_price=market.yes_price,
        prob=market.yes_price * 100,
        volume=market.volume,
        category=market.category,
        headline=news.headline,
        source=news.source,
        age_s=news.age_ms / 1000,
    )


def _parse_response_text(text: str) -> dict:
    import ast
    text = text.strip()
    # Strip markdown fences
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1] if len(parts) > 1 else text
        if text.startswith("json"):
            text = text[4:]
    # Extract the first {...} block (models often add preamble text)
    start = text.find("{")
    end = text.rfind("}") + 1
    if start != -1 and end > start:
        text = text[start:end]
    # Try standard JSON first; fall back to ast.literal_eval for single-quote dicts
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return ast.literal_eval(text)


async def _classify_nvidia(news: NewsEvent, market: Market) -> Optional[dict]:
    """Call NVIDIA NIM (Gemma 4) via OpenAI-compatible SDK."""
    from openai import APIStatusError, APIConnectionError

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=5),
        retry=retry_if_exception_type((APIConnectionError, APIStatusError)),
        reraise=False,
    )
    async def _call():
        resp = await _get_nvidia_client().chat.completions.create(
            model=cfg.nvidia_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _build_user_msg(news, market)},
            ],
            temperature=0.0,
            max_tokens=200,
        )
        return _parse_response_text(resp.choices[0].message.content)

    return await _call()


async def _classify_anthropic(news: NewsEvent, market: Market) -> Optional[dict]:
    """Fallback: call Anthropic Claude Haiku."""
    from anthropic import APIStatusError, APIConnectionError

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=5),
        retry=retry_if_exception_type((APIConnectionError, APIStatusError)),
        reraise=False,
    )
    async def _call():
        resp = await _get_anthropic_client().messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=128,
            temperature=0.0,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": _build_user_msg(news, market)}],
        )
        return _parse_response_text(resp.content[0].text)

    return await _call()


async def classify(news: NewsEvent, market: Market) -> ClassifierOutput:
    """
    Classify news impact on a market question.
    Uses NVIDIA NIM (Gemma 4) when nvidia_api_key is set, else Anthropic Haiku.
    Returns ClassifierOutput. On any failure, returns neutral/0.0 (graceful degradation).
    """
    start = time.time()
    model_label = cfg.nvidia_model if _use_nvidia() else "claude-haiku-4-5-20251001"

    try:
        if _use_nvidia():
            result = await asyncio.wait_for(_classify_nvidia(news, market), timeout=25.0)
        else:
            result = await asyncio.wait_for(_classify_anthropic(news, market), timeout=8.0)

        if result is None:
            raise ValueError("null result from API")

        direction_str = result.get("direction", "neutral").lower()
        direction = {
            "bullish": SignalDirection.BULLISH,
            "bearish": SignalDirection.BEARISH,
        }.get(direction_str, SignalDirection.NEUTRAL)

        materiality = float(result.get("materiality", 0.0))
        materiality = max(0.0, min(1.0, materiality))

        return ClassifierOutput(
            direction=direction,
            materiality=materiality,
            reasoning=result.get("reasoning", ""),
            latency_ms=(time.time() - start) * 1000,
            model_used=model_label,
        )

    except asyncio.TimeoutError:
        log.warning("Classifier: NVIDIA timeout for %s — falling back to Anthropic", market.condition_id[:8])
    except Exception as exc:
        log.warning("Classifier: NVIDIA error (%s): %s — falling back to Anthropic", model_label, exc)

    # Fallback to Anthropic when NVIDIA fails/times out (only if key is available)
    if _use_nvidia() and cfg.anthropic_api_key:
        try:
            result = await asyncio.wait_for(_classify_anthropic(news, market), timeout=15.0)
            if result is not None:
                direction_str = result.get("direction", "neutral").lower()
                direction = {
                    "bullish": SignalDirection.BULLISH,
                    "bearish": SignalDirection.BEARISH,
                }.get(direction_str, SignalDirection.NEUTRAL)
                materiality = max(0.0, min(1.0, float(result.get("materiality", 0.0))))
                return ClassifierOutput(
                    direction=direction,
                    materiality=materiality,
                    reasoning=result.get("reasoning", ""),
                    latency_ms=(time.time() - start) * 1000,
                    model_used="claude-haiku-4-5-20251001 (fallback)",
                )
        except Exception as fb_exc:
            log.warning("Classifier: Anthropic fallback also failed: %s", fb_exc)

    return ClassifierOutput(
        direction=SignalDirection.NEUTRAL,
        materiality=0.0,
        reasoning="classification_failed",
        latency_ms=(time.time() - start) * 1000,
        model_used=model_label,
    )

"""
Research Advisor — Query Interface for the arXiv Knowledge Base

Provides two entry points:

  1. get_signal_suggestions(signal_file)
     Returns recent high-impact papers that could improve a specific signal file.
     Used by NightlyReviewWorker to include research findings in its Claude prompt.

  2. research_digest()
     Returns a formatted text summary of the top papers — included in the
     nightly review prompt so Claude Opus can reason about what to improve.

The underlying data comes from:
  - PostgreSQL research_papers table (populated by ResearchWorker weekly)
  - Redis _HIGH_SCORE_FLAG cache (populated by run_research_scan)

Both are read-only from this module. All writes go through ResearchWorker.
"""
from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)


async def get_signal_suggestions(signal_file: str, limit: int = 5) -> list[dict]:
    """
    Return high-impact papers applicable to a specific signal file.

    Example:
        papers = await get_signal_suggestions("heston_pricer.py")
        # Returns papers about Heston calibration, Kelly criterion, etc.
    """
    try:
        from persist.db import get_top_research_papers
        all_papers = await get_top_research_papers(limit=50)
        # Filter to papers that mention this signal file
        relevant = [
            p for p in all_papers
            if signal_file in (p.get("applicable_signals") or [])
            and float(p.get("improvement_score", 0)) >= 5.0
        ]
        return relevant[:limit]
    except Exception as exc:
        log.debug("research_advisor: get_signal_suggestions failed: %s", exc)
        return []


async def research_digest(days: int = 30, max_papers: int = 8) -> str:
    """
    Return a formatted text digest of recent high-impact papers.
    Included in the NightlyReviewWorker's Claude prompt so it can
    suggest code improvements grounded in academic research.

    Format example:
      === Recent Research Digest (last 30 days) ===

      [Score 8.5] Robust Kelly for Binary Prediction Markets (arxiv:2412.12345)
        Signals: heston_pricer.py, calibration.py
        Insight: f-hat correction for estimation variance improves Kelly 12%...
        Suggestion: Replace robust_kelly() with variance-shrunk estimator...
    """
    try:
        from persist.db import get_recent_research_papers
        papers = await get_recent_research_papers(days=days)
        papers = [p for p in papers if float(p.get("improvement_score", 0)) >= 5.0]
        papers = papers[:max_papers]
    except Exception as exc:
        log.debug("research_advisor: digest query failed: %s", exc)
        return ""

    if not papers:
        return ""

    lines = [f"=== Recent Research Digest (last {days} days) ===\n"]
    for p in papers:
        score = float(p.get("improvement_score", 0))
        signals = ", ".join(p.get("applicable_signals") or [])
        lines.append(
            f"[Score {score:.1f}] {p.get('title','')[:80]} (arxiv:{p.get('arxiv_id','')})\n"
            f"  Signals:    {signals or 'unknown'}\n"
            f"  Insight:    {p.get('key_insight','')[:200]}\n"
            f"  Suggestion: {p.get('concrete_suggestion','')[:200]}\n"
        )

    return "\n".join(lines)


async def get_pending_high_impact() -> list[dict]:
    """
    Return papers from Redis cache that exceeded the alert threshold
    during the last scan. Consumed by NightlyReviewWorker once, then
    the cache entry survives 7 days for follow-up queries.
    """
    try:
        from workers.research_worker import get_pending_suggestions
        return await get_pending_suggestions()
    except Exception as exc:
        log.debug("research_advisor: pending suggestions failed: %s", exc)
        return []

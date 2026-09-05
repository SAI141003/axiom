"""
Research Worker — Automated arXiv Knowledge Extraction

Inspired by LLMQuant/quant-mind (NeurIPS 2025) but adapted to use our
existing Claude API instead of OpenAI Agents SDK, and integrated directly
into the trading system so research insights flow back into signal parameters.

What it does (weekly, Sunday 3am):
  1. Searches arXiv across 6 topic areas that directly map to our signals
  2. Downloads and parses PDF → plain text (via pymupdf, same as quant-mind)
  3. Sends text to Claude with a structured extraction prompt
  4. Scores relevance 0-10 against our specific signal files
  5. Stores in PostgreSQL research_papers table
  6. Alerts (log + Redis flag) when improvement_score >= 8

Topic → Signal mapping:
  binary option / prediction market   →  heston_pricer.py, calibration.py
  Heston / stochastic vol calibration →  diffrax_calibrator.py, heston_pricer.py
  Kelly criterion / position sizing   →  heston_pricer.py:robust_kelly
  VPIN / order flow toxicity          →  order_flow_signal.py
  SABR / volatility smile             →  sabr_smile.py
  Polymarket / crowd wisdom           →  calibration.py, ensemble.py

Uses: arxiv (search + metadata), httpx (PDF download), pymupdf (PDF→text),
      anthropic (extraction), asyncpg (storage).
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import time
from datetime import datetime, timezone

import httpx

from core.config import cfg
from persist import redis_state
from persist.db import save_research_paper, get_recent_research_papers

log = logging.getLogger(__name__)

_LAST_RUN_KEY = "research_worker:last_run_ts"
_HIGH_SCORE_FLAG = "research_worker:high_score_papers"
_MIN_INTERVAL_S = 6 * 86400      # at most once per 6 days
_RUN_HOUR = 3                    # 3am local server time
_IMPROVEMENT_ALERT_THRESHOLD = 7.5   # score >= this → flag as actionable


# Topics to monitor — each searches arXiv with these terms.
# Mapped to the signal files they'd improve.
_SEARCH_TOPICS: list[dict] = [
    {
        "query": "binary option pricing digital option prediction market",
        "signals": ["heston_pricer.py", "calibration.py"],
        "max_results": 5,
    },
    {
        "query": "Heston model calibration stochastic volatility crypto options",
        "signals": ["diffrax_calibrator.py", "heston_pricer.py"],
        "max_results": 5,
    },
    {
        "query": "Kelly criterion fractional Kelly position sizing estimation uncertainty",
        "signals": ["heston_pricer.py"],
        "max_results": 4,
    },
    {
        "query": "VPIN order flow toxicity informed trading adverse selection",
        "signals": ["order_flow_signal.py", "microstructure.py"],
        "max_results": 4,
    },
    {
        "query": "SABR volatility smile calibration local stochastic volatility",
        "signals": ["sabr_smile.py"],
        "max_results": 4,
    },
    {
        "query": "prediction market calibration crowd wisdom Polymarket Kalshi",
        "signals": ["calibration.py", "ensemble.py"],
        "max_results": 4,
    },
]

# Extraction prompt — structured JSON output
_EXTRACTION_PROMPT = """You are a quantitative finance researcher reviewing an academic paper.
Extract the following information as compact JSON (no markdown, no extra text):

{{
  "key_formula": "<The most important mathematical formula or equation — LaTeX or plain text>",
  "key_insight": "<1-2 sentence summary of the main finding>",
  "improvement_score": <0-10 float, how much this would improve the signals listed below>,
  "concrete_suggestion": "<Specific code-level change or formula to implement, or 'none' if not applicable>",
  "applicable_signals": ["<signal_file.py>", ...]
}}

The trading system uses these Python signals:
{signal_context}

Target paper:
Title: {title}
Abstract: {abstract}
Paper text (first 4000 chars): {text_excerpt}

Scoring guide for improvement_score:
  9-10: Contains a concrete formula/algorithm that directly replaces current code with proven improvement
  7-8:  Contains a mathematical insight that would improve accuracy by >5%
  5-6:  Relevant research but incremental / already partially implemented
  3-4:  Tangentially related, unlikely to change the code
  0-2:  Not relevant to the listed signal files
"""

_SIGNAL_CONTEXT = """
- heston_pricer.py: Heston SDE, Lewis digital formula P(S_T>K), Bayesian particle filter, Robust Kelly Eq.4
- diffrax_calibrator.py: JAX/Diffrax Heston calibration via gradient descent
- sabr_smile.py: SABR Hagan 2002, β=0.5, L-BFGS-B calibration, Reiner-Rubinstein digital correction
- order_flow_signal.py: CVD z-score, VPIN (Easley-LdP-O'Hara 2012), OBI, Binance aggTrades
- calibration.py: Domain+horizon calibration slopes (arXiv:2602.19520), logit-space scaling
- ensemble.py: Signal ensemble with Gemma 4, Kronos, Heston; Multi-factor Kelly sizing
"""


async def _search_arxiv(query: str, max_results: int) -> list[dict]:
    """Search arXiv and return list of paper metadata dicts."""
    try:
        import arxiv
    except ImportError:
        log.warning("ResearchWorker: 'arxiv' not installed. Run: pip install arxiv")
        return []

    def _sync_search():
        client = arxiv.Client()
        search = arxiv.Search(
            query=query,
            max_results=max_results,
            sort_by=arxiv.SortCriterion.SubmittedDate,
            sort_order=arxiv.SortOrder.Descending,
        )
        return list(client.results(search))

    try:
        results = await asyncio.to_thread(_sync_search)
    except Exception as exc:
        log.warning("ResearchWorker: arXiv search failed '%s': %s", query, exc)
        return []

    papers = []
    for r in results:
        papers.append({
            "arxiv_id": r.entry_id.split("/")[-1].replace("v1", "").replace("v2", ""),
            "title": r.title,
            "authors": ", ".join(str(a) for a in r.authors[:5]),
            "abstract": r.summary[:1000],
            "published_at": r.published.date() if r.published else None,
            "url": r.pdf_url or r.entry_id,
            "pdf_url": r.pdf_url,
        })
    return papers


async def _fetch_pdf_text(pdf_url: str, max_chars: int = 8000) -> str:
    """Download PDF and extract plain text via pymupdf."""
    try:
        import fitz  # pymupdf
    except ImportError:
        log.debug("ResearchWorker: pymupdf not installed — using abstract only")
        return ""

    if not pdf_url:
        return ""

    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(pdf_url)
            if resp.status_code != 200:
                return ""
            pdf_bytes = resp.content

        doc = fitz.open(stream=io.BytesIO(pdf_bytes), filetype="pdf")
        text_parts = []
        char_count = 0
        for page in doc:
            t = page.get_text()
            text_parts.append(t)
            char_count += len(t)
            if char_count >= max_chars:
                break
        doc.close()
        return " ".join(text_parts)[:max_chars]

    except Exception as exc:
        log.debug("ResearchWorker: PDF fetch failed %s: %s", pdf_url, exc)
        return ""


async def _extract_with_claude(paper: dict, applicable_signals: list[str]) -> dict:
    """
    Send paper to Claude and extract structured knowledge.
    Returns enriched paper dict with key_formula, key_insight, score, suggestion.
    """
    try:
        import anthropic
    except ImportError:
        log.warning("ResearchWorker: anthropic not installed")
        return paper

    api_key = cfg.anthropic_api_key
    if not api_key:
        log.debug("ResearchWorker: no ANTHROPIC_API_KEY — skipping extraction")
        return paper

    text_excerpt = paper.get("_pdf_text", paper.get("abstract", ""))[:4000]
    prompt = _EXTRACTION_PROMPT.format(
        signal_context=_SIGNAL_CONTEXT,
        title=paper["title"],
        abstract=paper.get("abstract", ""),
        text_excerpt=text_excerpt,
    )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        msg = await asyncio.to_thread(
            lambda: client.messages.create(
                model="claude-haiku-4-5-20251001",  # fast + cheap for extraction
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
        )
        raw = msg.content[0].text.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        extracted = json.loads(raw)
        paper["key_formula"] = extracted.get("key_formula", "")
        paper["key_insight"] = extracted.get("key_insight", "")
        paper["improvement_score"] = float(extracted.get("improvement_score", 0))
        paper["concrete_suggestion"] = extracted.get("concrete_suggestion", "")
        paper["applicable_signals"] = extracted.get("applicable_signals", applicable_signals)
        return paper

    except Exception as exc:
        log.debug("ResearchWorker: Claude extraction failed for '%s': %s", paper["title"], exc)
        paper["improvement_score"] = 0.0
        paper["applicable_signals"] = applicable_signals
        return paper


async def _process_topic(topic: dict) -> list[dict]:
    """Search arXiv, fetch PDFs, extract knowledge for one topic."""
    papers = await _search_arxiv(topic["query"], topic["max_results"])
    results = []

    for paper in papers:
        # Fetch PDF text for richer extraction
        if paper.get("pdf_url"):
            paper["_pdf_text"] = await _fetch_pdf_text(paper["pdf_url"])
        else:
            paper["_pdf_text"] = ""

        # Extract structured knowledge via Claude
        paper = await _extract_with_claude(paper, topic["signals"])

        # Only keep papers with some relevance
        if paper.get("improvement_score", 0) >= 3.0:
            results.append(paper)
            log.debug(
                "ResearchWorker: %s | score=%.1f | %s",
                paper["arxiv_id"],
                paper.get("improvement_score", 0),
                paper["title"][:60],
            )

        # Small delay to avoid hammering APIs
        await asyncio.sleep(1.0)

    return results


async def run_research_scan() -> dict:
    """
    Full research scan: search all topics, extract, store, return summary.
    Called by ResearchWorker and can also be triggered manually.
    """
    log.info("ResearchWorker: starting weekly arXiv scan (%d topics)", len(_SEARCH_TOPICS))
    t0 = time.time()

    all_papers: list[dict] = []
    for topic in _SEARCH_TOPICS:
        topic_papers = await _process_topic(topic)
        all_papers.extend(topic_papers)
        await asyncio.sleep(2.0)   # pause between topics

    # Deduplicate by arxiv_id
    seen: set[str] = set()
    unique_papers = []
    for p in all_papers:
        if p["arxiv_id"] not in seen:
            seen.add(p["arxiv_id"])
            unique_papers.append(p)

    # Sort by score
    unique_papers.sort(key=lambda x: x.get("improvement_score", 0), reverse=True)

    # Store in PostgreSQL and count new ones
    new_count = 0
    high_score: list[dict] = []

    for paper in unique_papers:
        try:
            is_new = await save_research_paper(paper)
            if is_new:
                new_count += 1
                score = paper.get("improvement_score", 0)
                if score >= _IMPROVEMENT_ALERT_THRESHOLD:
                    high_score.append(paper)
                    log.warning(
                        "ResearchWorker: HIGH-IMPACT paper (score=%.1f): %s\n"
                        "  Signals: %s\n"
                        "  Insight: %s\n"
                        "  Suggestion: %s",
                        score,
                        paper["title"],
                        ", ".join(paper.get("applicable_signals", [])),
                        paper.get("key_insight", ""),
                        paper.get("concrete_suggestion", ""),
                    )
        except Exception as exc:
            log.debug("ResearchWorker: DB save failed for %s: %s", paper.get("arxiv_id"), exc)

    # Cache high-score papers in Redis for NightlyReviewWorker to include
    if high_score:
        summary_for_redis = [
            {
                "arxiv_id": p["arxiv_id"],
                "title": p["title"],
                "score": p.get("improvement_score", 0),
                "signals": p.get("applicable_signals", []),
                "insight": p.get("key_insight", ""),
                "suggestion": p.get("concrete_suggestion", ""),
            }
            for p in high_score
        ]
        await redis_state.cache_set(
            _HIGH_SCORE_FLAG,
            json.dumps(summary_for_redis),
            ttl=7 * 86400,  # 7 days
        )

    elapsed = time.time() - t0
    summary = {
        "papers_scanned":   len(unique_papers),
        "new_papers":       new_count,
        "high_score_count": len(high_score),
        "elapsed_s":        round(elapsed, 1),
        "top_papers":       [
            {"title": p["title"][:60], "score": p.get("improvement_score", 0)}
            for p in unique_papers[:5]
        ],
    }

    log.info(
        "ResearchWorker: scan complete — %d scanned, %d new, %d high-impact (%.0fs)",
        len(unique_papers), new_count, len(high_score), elapsed,
    )
    return summary


async def get_pending_suggestions() -> list[dict]:
    """Return high-impact papers cached in Redis (for NightlyReviewWorker)."""
    raw = await redis_state.cache_get(_HIGH_SCORE_FLAG)
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []


class ResearchWorker:
    """
    Weekly research worker — scans arXiv, extracts math with Claude,
    stores actionable insights in PostgreSQL.

    Runs every Sunday at _RUN_HOUR (3am). Rate-limited to once per 6 days
    to prevent double-fire on restarts. Findings are consumed by
    NightlyReviewWorker to surface actionable code suggestions.
    """

    async def run(self) -> None:
        log.info("ResearchWorker: started (weekly arXiv scan, runs Sunday %d:00)", _RUN_HOUR)

        # Wait for PostgreSQL to be ready
        await asyncio.sleep(15)

        while True:
            now = datetime.now(timezone.utc)
            # Only run on Sunday (weekday 6) at the configured hour
            should_run = (now.weekday() == 6 and now.hour == _RUN_HOUR)

            if should_run:
                last_raw = await redis_state.cache_get(_LAST_RUN_KEY)
                last_ts = float(last_raw) if last_raw else 0.0

                if (time.time() - last_ts) >= _MIN_INTERVAL_S:
                    await redis_state.cache_set(_LAST_RUN_KEY, str(time.time()), ttl=8 * 86400)
                    try:
                        await run_research_scan()
                    except Exception as exc:
                        log.error("ResearchWorker: scan failed: %s", exc, exc_info=True)

            # Check every hour — low overhead
            await asyncio.sleep(3600)

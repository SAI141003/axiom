"""
paper_sim.py — Live paper trading simulation. No Redis or PostgreSQL needed.

What it does:
  1. Fetches live niche markets from Polymarket Gamma API
  2. Pulls recent headlines from RSS feeds (same sources as production)
  3. Matches headlines to markets (BM25 + optional semantic)
  4. Runs Gemma 4 (NVIDIA NIM) classifier on each match
  5. Builds ensemble signals with Kelly sizing
  6. Prints a full report — what would have been traded and why

Usage:
  python paper_sim.py
  python paper_sim.py --markets 60 --headlines 30 --min-edge 0.04
"""
from __future__ import annotations

import argparse
import asyncio
import calendar
import logging
import time
from typing import Optional

import aiohttp
import feedparser
import httpx

# ── Bootstrap logging before any project imports ──────────────────────────────
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("paper_sim")

# ── Project imports (no Redis/PostgreSQL touched) ─────────────────────────────
from core.config import cfg
from core.models import ClassifierOutput, Market, NewsEvent, SignalDirection
from ingest.market_watcher import fetch_active_markets, filter_by_categories
from ingest.news_stream import WORLDMONITOR_FEEDS
from match.matcher import Matcher, bm25_score, extract_keywords
from signals.classifier import classify
from signals.ensemble import build_signal

# ─────────────────────────────────────────────────────────────────────────────

RSS_FEEDS = WORLDMONITOR_FEEDS[:10]  # first 10 feeds keep startup fast


async def _fetch_niche_markets(limit: int = 200) -> list[Market]:
    """
    Fetch active niche markets in our volume band ($500–$500K).
    Fetches 3× the requested limit (descending) to ensure the $1K–$500K
    band is well represented after filtering.
    """
    from ingest.market_watcher import _infer_category, _detect_linked_asset
    import json as _json

    # Fetch more than needed; high-volume markets come first, we keep middle band
    fetch_n = min(limit * 3, 500)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{cfg.polymarket_gamma_api}/markets",
                params={
                    "active": "true",
                    "closed": "false",
                    "limit": fetch_n,
                    "order": "volume",
                    "ascending": "false",
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        log.warning("Gamma API error: %s", exc)
        return []

    # Use a wide sim band: $500–$2M (less strict than production)
    sim_min = 500.0
    sim_max = 2_000_000.0

    markets: list[Market] = []
    for item in data:
        try:
            prices = _json.loads(item.get("outcomePrices", "[0.5,0.5]"))
            yes_price = float(prices[0]) if prices else 0.5
            no_price  = float(prices[1]) if len(prices) > 1 else 1 - yes_price
            volume = float(item.get("volume", 0))
            if volume < sim_min or volume > sim_max:
                continue
            if not item.get("active", False):
                continue
            tokens = []
            for t in item.get("tokens", []):
                tokens.append({
                    "token_id": t.get("token_id", t.get("tokenId", "")),
                    "outcome": t.get("outcome", "YES"),
                })
            question = item.get("question", "")
            market = Market(
                condition_id=item.get("conditionId", item.get("condition_id", "")),
                question=question,
                category=_infer_category(question, item.get("tags", [])),
                yes_price=yes_price,
                no_price=no_price,
                volume=volume,
                end_date=item.get("endDate", ""),
                active=True,
                tokens=tokens,
                linked_asset=_detect_linked_asset(question),
            )
            if market.condition_id and market.category in cfg.tracked_categories:
                markets.append(market)
        except Exception:
            pass
    return markets[:limit]

RESET  = "\033[0m"
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
DIM    = "\033[2m"


def _c(color: str, text: str) -> str:
    return f"{color}{text}{RESET}"


async def fetch_headlines(limit: int = 25) -> list[NewsEvent]:
    """Pull recent headlines from RSS feeds (same list as production)."""
    headlines: list[NewsEvent] = []
    seen: set[str] = set()

    async def _poll(url: str) -> None:
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=8)
            ) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        return
                    content = await resp.read()
            parsed = feedparser.parse(content)
            for entry in parsed.entries[:4]:
                headline = entry.get("title", "").strip()
                if not headline or len(headline) < 15 or headline in seen:
                    continue
                seen.add(headline)
                ts = time.time()
                if entry.get("published_parsed"):
                    ts = float(calendar.timegm(entry.published_parsed))
                headlines.append(NewsEvent(
                    headline=headline,
                    source=f"rss:{url.split('/')[2]}",
                    published_at=ts,
                    url=entry.get("link", ""),
                    content=entry.get("summary", ""),
                ))
        except Exception:
            pass

    await asyncio.gather(*[_poll(u) for u in RSS_FEEDS], return_exceptions=True)
    # Sort by recency, newest first
    headlines.sort(key=lambda e: e.published_at, reverse=True)
    return headlines[:limit]


def _age_str(ts: float) -> str:
    age_s = time.time() - ts
    if age_s < 60:
        return f"{age_s:.0f}s ago"
    if age_s < 3600:
        return f"{age_s/60:.0f}m ago"
    return f"{age_s/3600:.1f}h ago"


async def run_sim(
    market_limit: int = 60,
    headline_limit: int = 25,
    top_matches: int = 3,
    min_edge: float = 0.04,
    bankroll: float = 1000.0,
) -> None:
    t0 = time.time()

    print(f"\n{BOLD}{CYAN}{'═'*62}{RESET}")
    print(f"{BOLD}{CYAN}  POLYMARKET HFT — PAPER SIM  (Gemma 4 · NVIDIA NIM){RESET}")
    print(f"{BOLD}{CYAN}{'═'*62}{RESET}\n")

    # ── 1. Markets ────────────────────────────────────────────────────────────
    print(f"{BOLD}[1/4] Fetching live markets...{RESET}", flush=True)
    # Fetch ascending by volume so niche markets ($1K–$500K) appear first
    markets = await _fetch_niche_markets(limit=market_limit)
    print(f"      {_c(GREEN, str(len(markets)))} niche markets "
          f"(${cfg.min_volume_usd:,.0f}–${cfg.max_volume_usd:,.0f} volume)\n")

    if not markets:
        print(_c(RED, "  No markets returned. Check network / Gamma API."))
        return

    # ── 2. News ───────────────────────────────────────────────────────────────
    print(f"{BOLD}[2/4] Fetching RSS headlines...{RESET}", flush=True)
    headlines = await fetch_headlines(headline_limit)
    print(f"      {_c(GREEN, str(len(headlines)))} headlines pulled\n")

    if not headlines:
        print(_c(RED, "  No headlines fetched. Check network."))
        return

    # ── 3. Match ──────────────────────────────────────────────────────────────
    print(f"{BOLD}[3/4] Matching news → markets (BM25)...{RESET}", flush=True)
    pairs: list[tuple[NewsEvent, Market, float]] = []
    for news in headlines:
        hl_kws = extract_keywords(news.headline)
        for market in markets:
            mkt_kws = extract_keywords(market.question)
            score = bm25_score(hl_kws, mkt_kws)
            if score >= 0.05:
                pairs.append((news, market, score))

    # Keep top matches per headline
    pairs.sort(key=lambda x: x[2], reverse=True)
    seen_pairs: set[tuple[str, str]] = set()
    filtered: list[tuple[NewsEvent, Market, float]] = []
    headline_count: dict[str, int] = {}
    for news, market, score in pairs:
        key = (news.id, market.condition_id)
        if key in seen_pairs:
            continue
        if headline_count.get(news.id, 0) >= top_matches:
            continue
        seen_pairs.add(key)
        headline_count[news.id] = headline_count.get(news.id, 0) + 1
        filtered.append((news, market, score))

    print(f"      {_c(GREEN, str(len(filtered)))} (news, market) pairs to classify\n")

    if not filtered:
        print(_c(YELLOW, "  No matches found. Markets may not align with current news."))
        print(_c(DIM, "  Tip: try --markets 100 to widen the market pool."))
        return

    # ── 4. Classify + signal ──────────────────────────────────────────────────
    print(f"{BOLD}[4/4] Classifying with Gemma 4 (NVIDIA NIM)...{RESET}")
    print(f"      {_c(DIM, f'Model: {cfg.nvidia_model}')}\n")

    signals_fired: list[dict] = []
    suppressed: list[dict] = []
    errors = 0

    sem = asyncio.Semaphore(2)  # Gemma 4 31B is large — keep concurrency low

    async def _process(news: NewsEvent, market: Market, match_score: float) -> None:
        nonlocal errors
        async with sem:
            try:
                clf = await asyncio.wait_for(classify(news, market), timeout=40.0)
                signal = build_signal(
                    market=market,
                    news=news,
                    classification=clf,
                    bankroll=bankroll,
                )
                if signal and signal.edge >= min_edge:
                    signals_fired.append({
                        "signal": signal,
                        "clf": clf,
                        "news": news,
                        "match_score": match_score,
                    })
                else:
                    suppressed.append({
                        "news": news,
                        "market": market,
                        "clf": clf,
                        "reason": (
                            "neutral" if clf.direction == SignalDirection.NEUTRAL
                            else f"mat={clf.materiality:.2f}<{cfg.materiality_threshold}"
                            if clf.materiality < cfg.materiality_threshold
                            else f"edge={signal.edge:.3f}<{min_edge}" if signal else "no_signal"
                        ),
                    })
            except asyncio.TimeoutError:
                errors += 1
                log.warning("Timeout classifying %s", market.condition_id[:8])
            except Exception as exc:
                errors += 1
                log.warning("Error: %s", exc)

    tasks = [_process(n, m, s) for n, m, s in filtered]
    await asyncio.gather(*tasks)

    # ── Results ───────────────────────────────────────────────────────────────
    elapsed = time.time() - t0

    print(f"{'─'*62}")
    print(f"{BOLD}  SIGNALS  ({len(signals_fired)} fired / {len(filtered)} evaluated){RESET}\n")

    if not signals_fired:
        print(_c(YELLOW, "  No signals met edge threshold. Normal in quiet markets.\n"))
    else:
        total_exposure = 0.0
        for item in sorted(signals_fired, key=lambda x: x["signal"].edge, reverse=True):
            sig = item["signal"]
            clf = item["clf"]
            news = item["news"]
            total_exposure += sig.approved_size

            direction_color = GREEN if sig.side == "YES" else RED
            print(f"  {_c(BOLD, '●')} {_c(direction_color, sig.side):6s}  "
                  f"{_c(BOLD, sig.market.question[:52])}")
            print(f"    {_c(DIM, news.headline[:70])}")
            print(f"    {_c(DIM, _age_str(news.published_at))}  "
                  f"mat={_c(CYAN, f'{clf.materiality:.2f}')}  "
                  f"edge={_c(GREEN, f'{sig.edge:.3f}')}  "
                  f"p_model={_c(CYAN, f'{sig.p_model:.2f}')}  "
                  f"p_market={_c(DIM, f'{sig.p_market:.2f}')}")
            print(f"    Size: {_c(GREEN, f'${sig.approved_size:.2f}')}  "
                  f"Kelly: {sig.kelly_fraction:.2f}  "
                  f"match={item['match_score']:.2f}  "
                  f"{_c(DIM, clf.reasoning[:60])}")
            print()

        print(f"  Total estimated exposure: {_c(BOLD, f'${total_exposure:.2f}')} "
              f"(bankroll=${bankroll:.0f})\n")

    # ── Suppressed summary ────────────────────────────────────────────────────
    print(f"{'─'*62}")
    print(f"{BOLD}  SUPPRESSED  ({len(suppressed)} filtered out){RESET}\n")
    reason_counts: dict[str, int] = {}
    for item in suppressed:
        r = item["reason"]
        reason_counts[r] = reason_counts.get(r, 0) + 1
    for reason, count in sorted(reason_counts.items(), key=lambda x: -x[1]):
        print(f"  {_c(DIM, f'{count:3d}x')}  {reason}")

    # ── Footer ────────────────────────────────────────────────────────────────
    print(f"\n{'─'*62}")
    print(f"  Markets: {len(markets)}  Headlines: {len(headlines)}  "
          f"Pairs: {len(filtered)}  Errors: {errors}")
    print(f"  Model: {_c(CYAN, cfg.nvidia_model)}")
    print(f"  Elapsed: {elapsed:.1f}s  "
          f"DRY_RUN={_c(GREEN, 'true') if cfg.dry_run else _c(RED, 'FALSE — LIVE')}")
    print(f"{'═'*62}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Polymarket HFT paper sim")
    parser.add_argument("--markets",   type=int,   default=200,   help="Max markets to fetch")
    parser.add_argument("--headlines", type=int,   default=25,    help="Max headlines to pull")
    parser.add_argument("--min-edge",  type=float, default=0.04,  help="Minimum edge threshold")
    parser.add_argument("--bankroll",  type=float, default=1000.0, help="Simulated bankroll $")
    args = parser.parse_args()

    asyncio.run(run_sim(
        market_limit=args.markets,
        headline_limit=args.headlines,
        min_edge=args.min_edge,
        bankroll=args.bankroll,
    ))

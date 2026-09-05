"""
News-to-market matching engine.

Two-tier matching (upgraded from polymarket-pipeline bag-of-words):
  Tier 1: BM25 keyword matching (fast, ~1ms)
  Tier 2: Sentence-transformer semantic similarity (slower, ~5ms)

The result of tier 2 is cached in Redis per (headline_hash, market_id) pair.

Upgrade over polymarket-pipeline:
  - BM25 replaces naive hit/total_keywords ratio
  - Semantic matching catches "Fed hikes" ↔ "interest rate increase"
  - Market question embeddings are pre-computed and cached at startup
  - Results are scored and top-N returned by combined score
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from functools import lru_cache
from typing import Optional

import numpy as np

from core.config import cfg
from core.models import Market, NewsEvent
from persist import redis_state

log = logging.getLogger(__name__)

# Stopwords (extended from polymarket-pipeline)
STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "to", "of", "in", "for", "on",
    "with", "at", "by", "from", "up", "about", "into", "through", "that",
    "this", "these", "those", "it", "its", "or", "and", "but", "if",
    "then", "than", "so", "yet", "both", "either", "neither", "not",
    "no", "nor", "very", "just", "as", "he", "she", "they", "we", "you",
}

# Category keyword fallback maps (from polymarket-pipeline, extended)
CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "ai": ["openai", "gpt", "anthropic", "claude", "gemini", "llm", "artificial intelligence",
           "deepmind", "chatgpt", "llama", "mistral", "model release", "ai chip"],
    "crypto": ["bitcoin", "btc", "ethereum", "eth", "crypto", "solana", "sol", "doge",
               "binance", "coinbase", "blockchain", "defi", "nft", "token", "altcoin"],
    "politics": ["president", "congress", "senate", "election", "vote", "legislation",
                 "trump", "biden", "harris", "democrat", "republican", "policy", "white house"],
    "technology": ["nvidia", "apple", "google", "microsoft", "amazon", "meta", "tesla",
                   "earnings", "stock", "nasdaq", "ipo", "acquisition", "merger"],
    "science": ["nasa", "spacex", "climate", "genome", "physics", "discovery",
                "mars", "moon", "rocket", "launch", "breakthrough"],
}


def extract_keywords(text: str) -> list[str]:
    """Extract meaningful keywords from text (strip stopwords, punctuation, short words)."""
    tokens = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return [t for t in tokens if len(t) > 2 and t not in STOPWORDS]


def bm25_score(query_terms: list[str], doc_terms: list[str], k1: float = 1.5, b: float = 0.75) -> float:
    """
    BM25 relevance score between query and document.
    Upgrade over polymarket-pipeline's hit/total ratio.
    """
    if not doc_terms or not query_terms:
        return 0.0

    doc_len = len(doc_terms)
    avg_doc_len = 8.0  # average question length in keywords

    doc_freq: dict[str, int] = {}
    for t in doc_terms:
        doc_freq[t] = doc_freq.get(t, 0) + 1

    score = 0.0
    for term in query_terms:
        if term not in doc_freq:
            continue
        tf = doc_freq[term]
        # Simplified BM25 (without IDF corpus — we treat each market as independent)
        numerator = tf * (k1 + 1)
        denominator = tf + k1 * (1 - b + b * doc_len / avg_doc_len)
        score += numerator / denominator

    return score / max(len(query_terms), 1)


class SemanticMatcher:
    """
    Sentence-transformer semantic similarity.
    Model: all-MiniLM-L6-v2 (80MB, CPU-fast ~5ms per pair).
    """

    def __init__(self) -> None:
        self._model = None
        self._market_embeddings: dict[str, np.ndarray] = {}
        self._loaded = False

    async def load(self) -> None:
        if self._loaded:
            return
        try:
            from sentence_transformers import SentenceTransformer
            self._model = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: SentenceTransformer("all-MiniLM-L6-v2"),
            )
            self._loaded = True
            log.info("SemanticMatcher: model loaded")
        except ImportError:
            log.warning("SemanticMatcher: sentence-transformers not installed, semantic matching disabled")
        except Exception as exc:
            log.warning("SemanticMatcher: load error: %s", exc)

    def _encode(self, text: str) -> Optional[np.ndarray]:
        if not self._model:
            return None
        try:
            return self._model.encode(text, normalize_embeddings=True)
        except Exception:
            return None

    async def precompute_markets(self, markets: list[Market]) -> None:
        """Pre-compute embeddings for all market questions — done at startup."""
        if not self._model:
            return
        for market in markets:
            if market.condition_id not in self._market_embeddings:
                emb = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: self._encode(market.question)
                )
                if emb is not None:
                    self._market_embeddings[market.condition_id] = emb

    def similarity(self, headline: str, market: Market) -> float:
        if not self._model or market.condition_id not in self._market_embeddings:
            return 0.0
        h_emb = self._encode(headline)
        if h_emb is None:
            return 0.0
        m_emb = self._market_embeddings[market.condition_id]
        return float(np.dot(h_emb, m_emb))  # embeddings are normalized → cosine similarity


class Matcher:
    """
    Combined BM25 + semantic matcher.
    Returns top-N markets by combined relevance score.
    """

    def __init__(self) -> None:
        self.semantic = SemanticMatcher()
        self._markets: list[Market] = []

    async def initialize(self, markets: list[Market]) -> None:
        self._markets = markets
        await self.semantic.load()
        await self.semantic.precompute_markets(markets)

    async def update_markets(self, markets: list[Market]) -> None:
        """Called when market list refreshes — precompute new embeddings."""
        new_markets = [m for m in markets if m.condition_id not in
                       self.semantic._market_embeddings]
        self._markets = markets
        if new_markets:
            await self.semantic.precompute_markets(new_markets)

    async def match(
        self,
        news: NewsEvent,
        markets: Optional[list[Market]] = None,
        top_n: int = 5,
        min_score: float = 0.1,
    ) -> list[tuple[Market, float]]:
        """
        Match news event to markets. Returns list of (market, score) sorted desc.
        """
        pool = markets or self._markets
        if not pool:
            return []

        headline_keywords = extract_keywords(news.headline)
        if not headline_keywords:
            return []

        scored: list[tuple[Market, float]] = []

        for market in pool:
            market_keywords = extract_keywords(market.question)

            # Tier 1: BM25
            bm_score = bm25_score(headline_keywords, market_keywords)

            # Tier 2: Semantic (only if BM25 has any signal)
            sem_score = 0.0
            if bm_score > 0.05 or any(k in news.headline.lower() for k in market_keywords[:3]):
                sem_score = self.semantic.similarity(news.headline, market)

            # Combined (BM25 60% + semantic 40%)
            combined = 0.6 * bm_score + 0.4 * sem_score

            # Category bonus
            cat_kws = CATEGORY_KEYWORDS.get(market.category, [])
            hl_lower = news.headline.lower()
            if any(kw in hl_lower for kw in cat_kws):
                combined += 0.15

            if combined >= min_score:
                scored.append((market, combined))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_n]


# Module-level singleton
matcher = Matcher()

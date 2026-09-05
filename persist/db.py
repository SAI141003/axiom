"""
PostgreSQL persistence layer — all durable state.

Tables:
  markets          — known markets (synced from Gamma API)
  trades           — every submitted order with full audit trail
  outcomes         — resolved market results linked to trades
  signals          — every signal generated (for calibration)
  pipeline_runs    — execution session tracking
  bankroll_log     — bankroll snapshots over time
  performance      — daily performance metrics
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import asyncpg

from core.config import cfg
from core.models import Order, OrderStatus, Signal

log = logging.getLogger(__name__)

_POOL: asyncpg.Pool | None = None


async def connect() -> None:
    global _POOL
    _POOL = await asyncpg.create_pool(
        cfg.database_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
    )
    await _create_tables()
    log.info("PostgreSQL: connected")


async def disconnect() -> None:
    if _POOL:
        await _POOL.close()


@asynccontextmanager
async def conn():
    async with _POOL.acquire() as c:
        yield c


async def _create_tables() -> None:
    async with conn() as c:
        await c.execute("""
            CREATE TABLE IF NOT EXISTS markets (
                condition_id    TEXT PRIMARY KEY,
                question        TEXT NOT NULL,
                category        TEXT,
                yes_price       FLOAT,
                volume          FLOAT,
                active          BOOLEAN DEFAULT TRUE,
                linked_asset    TEXT,
                last_seen       TIMESTAMPTZ DEFAULT NOW(),
                created_at      TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS signals (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                market_id       TEXT NOT NULL,
                market_question TEXT,
                direction       TEXT,
                p_model         FLOAT,
                p_market        FLOAT,
                edge            FLOAT,
                materiality     FLOAT,
                side            TEXT,
                kelly_fraction  FLOAT,
                approved_size   FLOAT,
                consensus_count INT DEFAULT 0,
                news_headline   TEXT,
                news_source     TEXT,
                reasoning       TEXT,
                created_at      TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS trades (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                signal_id       UUID REFERENCES signals(id),
                order_id        TEXT,
                market_id       TEXT NOT NULL,
                market_question TEXT,
                token_id        TEXT,
                side            TEXT,
                size            FLOAT,
                price           FLOAT,
                fill_price      FLOAT,
                filled_size     FLOAT DEFAULT 0,
                status          TEXT,
                p_model         FLOAT,
                edge            FLOAT,
                pnl             FLOAT,
                dry_run         BOOLEAN DEFAULT FALSE,
                error_msg       TEXT,
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                filled_at       TIMESTAMPTZ,
                resolved_at     TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS outcomes (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                trade_id        UUID REFERENCES trades(id),
                market_id       TEXT,
                resolved_yes    BOOLEAN,
                pnl             FLOAT,
                resolved_at     TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS bankroll_log (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                bankroll        FLOAT NOT NULL,
                daily_pnl       FLOAT DEFAULT 0,
                note            TEXT,
                recorded_at     TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS performance (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                date            DATE UNIQUE NOT NULL,
                win_rate        FLOAT,
                sharpe_ratio    FLOAT,
                max_drawdown    FLOAT,
                brier_score     FLOAT,
                total_trades    INT DEFAULT 0,
                total_pnl       FLOAT DEFAULT 0,
                recorded_at     TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id);
            CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
            CREATE INDEX IF NOT EXISTS idx_signals_market ON signals(market_id);
            CREATE INDEX IF NOT EXISTS idx_bankroll_time ON bankroll_log(recorded_at);

            CREATE TABLE IF NOT EXISTS research_papers (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                arxiv_id        TEXT UNIQUE NOT NULL,
                title           TEXT NOT NULL,
                authors         TEXT,
                abstract        TEXT,
                published_at    DATE,
                url             TEXT,
                key_formula     TEXT,
                key_insight     TEXT,
                applicable_signals  TEXT[],
                improvement_score   FLOAT DEFAULT 0,
                concrete_suggestion TEXT,
                ingested_at     TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_research_score ON research_papers(improvement_score DESC);
            CREATE INDEX IF NOT EXISTS idx_research_date  ON research_papers(ingested_at DESC);
        """)


# ── Research Papers ───────────────────────────────────────────────────────────

async def save_research_paper(paper: dict) -> bool:
    """
    Upsert a research paper. Returns True if it was new, False if already known.
    paper dict keys: arxiv_id, title, authors, abstract, published_at, url,
                     key_formula, key_insight, applicable_signals,
                     improvement_score, concrete_suggestion
    """
    async with conn() as c:
        existing = await c.fetchval(
            "SELECT id FROM research_papers WHERE arxiv_id = $1", paper["arxiv_id"]
        )
        if existing:
            return False
        await c.execute("""
            INSERT INTO research_papers
                (arxiv_id, title, authors, abstract, published_at, url,
                 key_formula, key_insight, applicable_signals,
                 improvement_score, concrete_suggestion)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        """,
            paper["arxiv_id"], paper["title"], paper.get("authors", ""),
            paper.get("abstract", ""), paper.get("published_at"),
            paper.get("url", ""), paper.get("key_formula", ""),
            paper.get("key_insight", ""), paper.get("applicable_signals", []),
            float(paper.get("improvement_score", 0)),
            paper.get("concrete_suggestion", ""),
        )
        return True


async def get_top_research_papers(limit: int = 10) -> list[dict]:
    """Return most impactful papers by improvement_score."""
    async with conn() as c:
        rows = await c.fetch("""
            SELECT arxiv_id, title, authors, improvement_score,
                   applicable_signals, key_insight, concrete_suggestion,
                   ingested_at
            FROM research_papers
            ORDER BY improvement_score DESC, ingested_at DESC
            LIMIT $1
        """, limit)
    return [dict(r) for r in rows]


async def get_recent_research_papers(days: int = 30) -> list[dict]:
    """Return papers ingested in the last N days."""
    async with conn() as c:
        rows = await c.fetch("""
            SELECT arxiv_id, title, improvement_score, applicable_signals,
                   key_insight, concrete_suggestion, ingested_at
            FROM research_papers
            WHERE ingested_at >= NOW() - INTERVAL '1 day' * $1
            ORDER BY improvement_score DESC
        """, days)
    return [dict(r) for r in rows]


# ── Bankroll ──────────────────────────────────────────────────────────────────

async def get_current_bankroll() -> float:
    async with conn() as c:
        row = await c.fetchrow(
            "SELECT bankroll FROM bankroll_log ORDER BY recorded_at DESC LIMIT 1"
        )
    return float(row["bankroll"]) if row else cfg.initial_bankroll


async def save_bankroll(amount: float, note: str = "") -> None:
    daily_pnl = amount - await get_current_bankroll()
    async with conn() as c:
        await c.execute(
            "INSERT INTO bankroll_log (bankroll, daily_pnl, note) VALUES ($1, $2, $3)",
            amount, daily_pnl, note,
        )


# ── Signals ───────────────────────────────────────────────────────────────────

async def log_signal(signal: Signal) -> str:
    sid = str(uuid4())
    async with conn() as c:
        await c.execute("""
            INSERT INTO signals
              (id, market_id, market_question, direction, p_model, p_market,
               edge, materiality, side, kelly_fraction, approved_size,
               consensus_count, news_headline, news_source, reasoning)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        """,
            sid,
            signal.market.condition_id,
            signal.market.question,
            signal.direction.value,
            signal.p_model,
            signal.p_market,
            signal.edge,
            signal.materiality,
            signal.side,
            signal.kelly_fraction,
            signal.approved_size,
            signal.consensus_count,
            signal.news.headline if signal.news else None,
            signal.news.source if signal.news else None,
            signal.reasoning,
        )
    return sid


# ── Trades ────────────────────────────────────────────────────────────────────

async def log_trade(order: Order, signal: Signal, dry_run: bool = False) -> str:
    tid = str(uuid4())
    async with conn() as c:
        await c.execute("""
            INSERT INTO trades
              (id, order_id, market_id, market_question, token_id,
               side, size, price, status, p_model, edge, dry_run, error_msg)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        """,
            tid,
            order.order_id,
            order.market_id,
            signal.market.question,
            order.token_id,
            order.side,
            order.size,
            order.price,
            order.status.value,
            signal.p_model,
            signal.edge,
            dry_run,
            order.error_msg,
        )
    return tid


async def update_trade_fill(order_id: str, fill_price: float, filled_size: float) -> None:
    async with conn() as c:
        await c.execute("""
            UPDATE trades
            SET fill_price=$1, filled_size=$2, status='filled', filled_at=NOW()
            WHERE order_id=$3
        """, fill_price, filled_size, order_id)


async def update_trade_status(order_id: str, status: str, error_msg: str = "") -> None:
    async with conn() as c:
        await c.execute(
            "UPDATE trades SET status=$1, error_msg=$2 WHERE order_id=$3",
            status, error_msg, order_id,
        )


async def get_daily_pnl() -> float:
    async with conn() as c:
        row = await c.fetchrow("""
            SELECT COALESCE(SUM(pnl), 0) as total
            FROM trades
            WHERE created_at >= CURRENT_DATE
              AND status IN ('filled', 'dry_run')
        """)
    return float(row["total"]) if row else 0.0


async def get_trade_stats() -> dict:
    async with conn() as c:
        row = await c.fetchrow("""
            SELECT
                COUNT(*) FILTER (WHERE status='filled') AS filled,
                COUNT(*) FILTER (WHERE status='dry_run') AS dry_run,
                COUNT(*) FILTER (WHERE status='rejected_daily_limit') AS rejected,
                COUNT(*) FILTER (WHERE status LIKE 'error%') AS errors,
                COALESCE(SUM(pnl) FILTER (WHERE pnl IS NOT NULL), 0) AS total_pnl
            FROM trades
            WHERE created_at >= CURRENT_DATE
        """)
    return dict(row) if row else {}


# ── Calibration ───────────────────────────────────────────────────────────────

async def get_resolved_signal_outcomes(limit: int = 5_000) -> list[dict]:
    """
    Fetch (p_model, resolved_yes, category) for calibration fitting.
    Only returns rows where the market has resolved (outcome known).
    """
    async with conn() as c:
        rows = await c.fetch("""
            SELECT
                s.p_model                     AS p_model,
                o.resolved_yes::int           AS resolved_yes,
                COALESCE(m.category, 'other') AS category
            FROM signals s
            JOIN trades t  ON t.market_id = s.market_id
                          AND t.signal_id  = s.id::text
            JOIN outcomes o ON o.trade_id = t.id
            LEFT JOIN markets m ON m.condition_id = s.market_id
            WHERE o.resolved_yes IS NOT NULL
              AND s.p_model IS NOT NULL
            ORDER BY s.created_at DESC
            LIMIT $1
        """, limit)
    return [dict(r) for r in rows]


async def get_brier_score(lookback_days: int = 30) -> float:
    """Brier Score from resolved signals. Lower is better (target < 0.25)."""
    async with conn() as c:
        row = await c.fetchrow("""
            SELECT AVG(POWER(s.p_model - CASE WHEN o.resolved_yes THEN 1 ELSE 0 END, 2)) as bs
            FROM signals s
            JOIN trades t ON t.market_id = s.market_id
            JOIN outcomes o ON o.trade_id = t.id
            WHERE o.resolved_at >= NOW() - ($1 * INTERVAL '1 day')
        """, lookback_days)
    return float(row["bs"]) if row and row["bs"] is not None else 0.0


# ── Backtest data feed ────────────────────────────────────────────────────────

async def get_historical_trades(
    start_ts: Optional[float] = None,
    end_ts: Optional[float] = None,
    limit: int = 5_000,
) -> list[dict]:
    """
    Fetch historical trade records for backtest replay.
    Returns a list of dicts with: id, market_id, question, side, size, price,
    p_model, edge, pnl, status, strategy, spread, resolution, ts.
    """
    conditions = ["status IN ('filled', 'dry_run')"]
    params: list = []
    idx = 1

    if start_ts:
        conditions.append(f"created_at >= to_timestamp(${idx})")
        params.append(start_ts)
        idx += 1
    if end_ts:
        conditions.append(f"created_at <= to_timestamp(${idx})")
        params.append(end_ts)
        idx += 1

    params.append(limit)
    where = " AND ".join(conditions)

    async with conn() as c:
        rows = await c.fetch(f"""
            SELECT
                t.id::text        AS id,
                t.market_id       AS market_id,
                t.market_question AS question,
                t.side            AS side,
                t.size            AS size,
                t.price           AS price,
                t.p_model         AS p_model,
                t.edge            AS edge,
                COALESCE(t.pnl, 0) AS pnl,
                t.status          AS status,
                o.resolved_yes    AS resolution,
                EXTRACT(EPOCH FROM t.created_at) AS ts
            FROM trades t
            LEFT JOIN outcomes o ON o.trade_id = t.id
            WHERE {where}
            ORDER BY t.created_at ASC
            LIMIT ${idx}
        """, *params)

    return [dict(r) for r in rows]


# ── Open Orders (startup reconciliation) ─────────────────────────────────────

async def get_open_orders_from_db() -> list[str]:
    async with conn() as c:
        rows = await c.fetch("""
            SELECT order_id FROM trades
            WHERE status IN ('pending', 'submitted', 'partially_filled')
              AND order_id IS NOT NULL
        """)
    return [r["order_id"] for r in rows]

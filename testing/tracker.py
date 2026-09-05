"""
Signal tracker — SQLite-backed log of every crypto binary evaluation.

Records every market priced by crypto_sim.py or ArbitrageScanner:
  - model_prob, market_prob, edge, vol, d2, tau_hours at prediction time
  - outcome (1=YES resolved, 0=NO resolved) filled in later by resolve_outcomes()

Usage:
  from testing.tracker import log_evaluation, resolve_outcomes, print_report
  log_evaluation(market, result)      # called per-priced market in crypto_sim
  resolve_outcomes()                  # call after markets expire to fill outcomes
  print_report()                      # calibration + accuracy metrics

DB: testing/signals.db  (SQLite, no dependencies)
"""
from __future__ import annotations

import json
import math
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "signals.db"

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS evaluations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_ts   REAL NOT NULL,
    market_id   TEXT NOT NULL,
    question    TEXT NOT NULL,
    asset       TEXT NOT NULL,
    direction   TEXT NOT NULL,
    strike      REAL,
    spot        REAL NOT NULL,
    tau_hours   REAL NOT NULL,
    model_prob  REAL NOT NULL,
    market_prob REAL NOT NULL,
    edge        REAL NOT NULL,
    sigma       REAL NOT NULL,
    d2          REAL NOT NULL,
    expiry_ts   REAL NOT NULL,
    signal_fired INTEGER NOT NULL DEFAULT 0,
    outcome     INTEGER,          -- 1=YES resolved, 0=NO resolved, NULL=pending
    resolved_spot REAL,           -- Binance price at expiry
    resolved_ts REAL
);
CREATE INDEX IF NOT EXISTS idx_expiry ON evaluations(expiry_ts, outcome);
CREATE INDEX IF NOT EXISTS idx_ts     ON evaluations(signal_ts);
"""


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def _init_db() -> None:
    with _conn() as c:
        c.executescript(_CREATE_SQL)


_init_db()


# ── Write ─────────────────────────────────────────────────────────────────────

def log_evaluation(market_id: str, question: str, result, signal_fired: bool = False) -> None:
    """
    Log one priced market. `result` is a CryptoBinaryOutput (or compatible dict).
    """
    if result is None:
        return

    # Accept both dataclass/model instances and dicts
    def _get(attr, default=None):
        if isinstance(result, dict):
            return result.get(attr, default)
        return getattr(result, attr, default)

    asset      = _get("asset", "UNK")
    direction  = _get("direction", "above")
    strike     = _get("strike_price")
    spot       = _get("spot_price", 0.0)
    tau_hours  = _get("tau_hours", 0.0)
    model_prob = _get("model_prob", 0.5)
    market_prob= _get("devigged_market_prob", 0.5)
    edge       = _get("edge", 0.0)
    sigma      = _get("realized_vol_ann", 0.0)
    d2         = _get("d2", 0.0)
    expiry_ts  = _get("expiry_ts", time.time() + tau_hours * 3600)

    with _conn() as c:
        c.execute(
            """INSERT INTO evaluations
               (signal_ts, market_id, question, asset, direction, strike, spot,
                tau_hours, model_prob, market_prob, edge, sigma, d2, expiry_ts, signal_fired)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (time.time(), market_id, question[:200], asset, direction,
             strike, spot, tau_hours, model_prob, market_prob, edge,
             sigma, d2, expiry_ts, int(signal_fired)),
        )


# ── Outcome resolution ────────────────────────────────────────────────────────

async def resolve_outcomes(lookback_hours: float = 6.0) -> int:
    """
    Fetch Binance klines and fill in outcome for expired markets.
    Returns count of newly resolved rows.
    """
    import aiohttp

    now = time.time()
    cutoff = now - lookback_hours * 3600

    with _conn() as c:
        rows = c.execute(
            """SELECT id, asset, strike, direction, expiry_ts
               FROM evaluations
               WHERE outcome IS NULL
                 AND expiry_ts < ?
                 AND expiry_ts > ?""",
            (now, cutoff),
        ).fetchall()

    if not rows:
        return 0

    from signals.crypto_binary_signal import ASSET_SYMBOL

    resolved = 0
    async with aiohttp.ClientSession() as session:
        for row in rows:
            symbol = ASSET_SYMBOL.get(row["asset"].upper())
            if not symbol:
                continue
            try:
                # Fetch the 1-min kline that contains the expiry timestamp
                expiry_ms = int(row["expiry_ts"] * 1000)
                url = "https://api.binance.com/api/v3/klines"
                async with session.get(
                    url,
                    params={"symbol": symbol, "interval": "1m",
                            "startTime": expiry_ms - 60_000,
                            "endTime":   expiry_ms + 60_000,
                            "limit": 3},
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as r:
                    data = await r.json()
                if not data:
                    continue

                # Use close price of the candle that spans expiry_ts
                close_px = float(data[0][4])
                strike = row["strike"]
                if strike is None:
                    continue

                if row["direction"] == "above":
                    outcome = 1 if close_px > strike else 0
                else:
                    outcome = 1 if close_px < strike else 0

                with _conn() as c:
                    c.execute(
                        "UPDATE evaluations SET outcome=?, resolved_spot=?, resolved_ts=? WHERE id=?",
                        (outcome, close_px, time.time(), row["id"]),
                    )
                resolved += 1
            except Exception:
                continue

    return resolved


# ── Reporting ─────────────────────────────────────────────────────────────────

def print_report(min_resolved: int = 5) -> None:
    """Print calibration + accuracy report to stdout."""

    with _conn() as c:
        total = c.execute("SELECT COUNT(*) FROM evaluations").fetchone()[0]
        resolved = c.execute(
            "SELECT COUNT(*) FROM evaluations WHERE outcome IS NOT NULL"
        ).fetchone()[0]
        pending = total - resolved

        rows = c.execute(
            """SELECT model_prob, market_prob, edge, sigma, d2,
                      tau_hours, signal_fired, outcome, direction, asset
               FROM evaluations WHERE outcome IS NOT NULL"""
        ).fetchall()

    print("\n" + "═" * 60)
    print("  MODEL EFFICIENCY REPORT")
    print(f"  Total evaluated : {total:,}")
    print(f"  Resolved        : {resolved:,}  |  Pending: {pending:,}")
    print("═" * 60)

    if resolved < min_resolved:
        print(f"  Need {min_resolved}+ resolved markets to compute metrics (have {resolved})")
        print("═" * 60)
        return

    # ── Calibration (Brier score) ─────────────────────────────────────────────
    brier = sum((r["model_prob"] - r["outcome"]) ** 2 for r in rows) / len(rows)
    brier_mkt = sum((r["market_prob"] - r["outcome"]) ** 2 for r in rows) / len(rows)

    # ── Direction accuracy ────────────────────────────────────────────────────
    # "Model is right" = outcome matches direction (model_prob > 0.5 → expect YES)
    correct   = sum(1 for r in rows if (r["model_prob"] > 0.5) == (r["outcome"] == 1))
    accuracy  = correct / len(rows)

    # ── Signal accuracy (when edge > threshold, are we right more often?) ────
    signals   = [r for r in rows if r["signal_fired"]]
    sig_acc   = (
        sum(1 for r in signals if (r["model_prob"] > 0.5) == (r["outcome"] == 1))
        / len(signals) if signals else None
    )

    # ── Mean edge realized ────────────────────────────────────────────────────
    mean_edge = sum(r["edge"] for r in rows) / len(rows)

    # ── Paper P&L ─────────────────────────────────────────────────────────────
    # YES bet: invest $size at price pm.  Win: +size*(1-pm)/pm  Lose: -size
    # NO  bet: invest $size at price 1-pm. Win: +size*pm/(1-pm) Lose: -size
    # Kelly:  YES → edge/(1-pm)   NO → |edge|/pm   (fraction of bankroll to risk)
    total_pnl   = 0.0
    total_expo  = 0.0
    total_roi   = 0.0
    bankroll    = 1000.0
    n_trades    = 0
    for r in rows:
        pm = r["market_prob"]
        e  = r["edge"]
        if abs(e) < 0.01:
            continue
        bet_yes = r["model_prob"] > 0.5

        # Kelly fraction uses the correct denominator for each side
        if bet_yes:
            kelly = min(0.35, e / max(0.01, 1 - pm) * 0.25 * 0.5)
        else:
            kelly = min(0.35, abs(e) / max(0.01, pm) * 0.25 * 0.5)

        size = round(min(bankroll * kelly, 25.0), 2)
        if size < 0.50:
            continue

        side_wins = (bet_yes and r["outcome"] == 1) or (not bet_yes and r["outcome"] == 0)

        if bet_yes:
            pnl = size * (1 - pm) / pm if side_wins else -size
        else:
            pnl = size * pm / (1 - pm) if side_wins else -size

        total_pnl  += pnl
        total_expo += size
        total_roi  += pnl / size
        n_trades   += 1

    # ── Calibration by decile ────────────────────────────────────────────────
    buckets: dict[int, list] = {}
    for r in rows:
        b = min(9, int(r["model_prob"] * 10))
        buckets.setdefault(b, []).append(r["outcome"])

    print(f"\n  Brier score  — model : {brier:.4f}  (lower=better, 0=perfect)")
    print(f"  Brier score  — market: {brier_mkt:.4f}  (our edge over market)")
    print(f"  Direction accuracy   : {accuracy:.1%}  ({correct}/{len(rows)})")
    if sig_acc is not None:
        print(f"  Signal accuracy      : {sig_acc:.1%}  ({len(signals)} trades fired)")
    avg_roi = total_roi / n_trades if n_trades else 0
    print(f"  Mean |edge|          : {mean_edge:+.4f}")
    print(f"  Paper P&L            : ${total_pnl:+.2f}  (ROI={avg_roi:+.1%} avg/trade  exposure=${total_expo:.0f})")

    print(f"\n  Calibration by probability bucket:")
    print(f"  {'Bucket':>8}  {'Predicted':>10}  {'Actual':>8}  {'N':>5}  {'Error':>8}")
    for b in sorted(buckets):
        outcomes = buckets[b]
        predicted = (b + 0.5) / 10.0
        actual    = sum(outcomes) / len(outcomes)
        err       = predicted - actual
        print(f"  {b*10:>3}-{b*10+10:<3}%  {predicted:>10.1%}  {actual:>8.1%}  "
              f"{len(outcomes):>5}  {err:>+8.3f}")

    print("═" * 60 + "\n")


def get_raw_rows(limit: int = 200) -> list[dict]:
    """Return most recent rows as dicts for programmatic use."""
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM evaluations ORDER BY signal_ts DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]

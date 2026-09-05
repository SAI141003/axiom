"""
Polymarket HFT — Top-Level Orchestrator

Startup sequence:
  1. Connect Redis + PostgreSQL
  2. Initialize risk engine (loads bankroll from PostgreSQL)
  3. Start kill switch monitor (independent of all other components)
  4. Start all 4 swarm workers (ingestion, signal, execution, risk)
  5. Start support services (order tracker, MiroFish pre-stager, consensus tracker)
  6. Start monitoring (Prometheus metrics, Rich dashboard)
  7. Block until kill switch fires or SIGTERM received

Environment:
  All configuration is loaded from .env via core.config.cfg.
  DRY_RUN=true by default — set DRY_RUN=false to trade live.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from pathlib import Path

# ── Logging setup (before any imports that log at module level) ───────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("main")

# ── Project imports ───────────────────────────────────────────────────────────
from core.config import cfg
from core.events import bus
from persist import redis_state, db
from risk import risk_engine
from risk.kill_switch import KillSwitchMonitor
from workers import IngestionWorker, SignalWorker, ExecutionWorker, RiskWorker, QuantCalibrationWorker, ResearchWorker
from execute.order_tracker import OrderTracker
from execute.market_maker import market_maker
from execute.tick_reactor import tick_reactor
from portfolio.position_guard import position_guard
from workers.paper_worker import paper_worker
from signals.mirofish_client import MiroFishPreStager
from consensus.ai_trader_client import ConsensusTracker
from compound.nightly_review import NightlyReviewWorker
from monitor.metrics import start_metrics_server, update_portfolio_metrics


async def _metrics_loop() -> None:
    """Refresh Prometheus gauges every 30s."""
    while True:
        await asyncio.sleep(30)
        await update_portfolio_metrics()


async def main() -> None:
    log.info("=" * 60)
    log.info("Polymarket HFT starting (dry_run=%s)", cfg.dry_run)
    log.info("=" * 60)

    if cfg.dry_run:
        log.warning("DRY RUN MODE — no real orders will be placed")

    # ── Phase 1: Connect persistence ──────────────────────────────────────────
    log.info("Connecting Redis at %s", cfg.redis_url)
    await redis_state.connect()

    log.info("Connecting PostgreSQL at %s", cfg.database_url[:30] + "...")
    await db.connect()

    # ── Phase 2: Initialize risk engine from PostgreSQL ───────────────────────
    log.info("Initializing risk engine")
    await risk_engine.initialize()

    # ── Phase 3: Connect Redis event bus ─────────────────────────────────────
    await bus.connect()

    # ── Phase 4: Start Prometheus metrics server ──────────────────────────────
    start_metrics_server()

    # ── Phase 5: Build all workers and services ───────────────────────────────
    kill_monitor = KillSwitchMonitor()
    ingestion_worker = IngestionWorker()
    signal_worker = SignalWorker()
    execution_worker = ExecutionWorker()
    risk_worker = RiskWorker()
    order_tracker = OrderTracker()
    mirofish_prestager = MiroFishPreStager()
    consensus_tracker = ConsensusTracker()
    nightly_review       = NightlyReviewWorker()
    quant_calibration    = QuantCalibrationWorker()
    research_worker      = ResearchWorker()

    # ── Phase 6: Launch all tasks concurrently ────────────────────────────────
    log.info("Starting all swarm workers")

    tasks = [
        # Kill switch must be first — it's the emergency exit
        asyncio.create_task(kill_monitor.run(), name="kill_switch"),

        # Core swarm workers
        asyncio.create_task(ingestion_worker.run(), name="ingestion"),
        asyncio.create_task(signal_worker.run(), name="signal"),
        asyncio.create_task(execution_worker.run(), name="execution"),
        asyncio.create_task(risk_worker.run(), name="risk"),

        # Support services
        asyncio.create_task(order_tracker.run(), name="order_tracker"),
        asyncio.create_task(mirofish_prestager.run(), name="mirofish_prestager"),
        asyncio.create_task(consensus_tracker.run(), name="consensus_tracker"),

        # Quant calibration: CVXPY every 30s, Diffrax every 60s, NumPyro every 5min
        asyncio.create_task(quant_calibration.run(), name="quant_calibration"),

        # Compound / AI workers
        asyncio.create_task(nightly_review.run(), name="nightly_review"),
        asyncio.create_task(research_worker.run(), name="research_worker"),
        asyncio.create_task(market_maker.run(), name="market_maker"),

        # Hot-path: sub-10ms velocity trading + position protection
        asyncio.create_task(tick_reactor.run(), name="tick_reactor"),
        asyncio.create_task(position_guard.run(), name="position_guard"),

        # Paper trading: virtual P&L tracking alongside live/dry-run trades
        asyncio.create_task(paper_worker.run(), name="paper_trader"),

        # Metrics refresh loop
        asyncio.create_task(_metrics_loop(), name="metrics"),
    ]

    # Launch dashboard if terminal is interactive
    if sys.stdout.isatty() and not os.getenv("NO_DASHBOARD"):
        from monitor.dashboard import run_dashboard
        shared_stats: dict = {}
        tasks.append(asyncio.create_task(
            run_dashboard(stats_provider=shared_stats),
            name="dashboard",
        ))

    log.info("All workers started. System operational.")
    log.info(
        "Config: max_bet=$%.0f  btc_max_bet=$%.0f  daily_limit=$%.0f  edge_threshold=%.2f",
        cfg.max_bet_usd, cfg.btc_max_bet_usd, cfg.daily_loss_limit_usd, cfg.edge_threshold,
    )
    log.info(
        "Strategies: negrisk=5s  deribit=%ds  smart_money=%ds  market_maker=%s  nightly_review=%s",
        cfg.deribit_scan_interval, cfg.smart_money_scan_interval,
        "ENABLED" if cfg.market_maker_enabled else "disabled",
        "ENABLED" if cfg.nightly_review_enabled else "disabled",
    )
    log.info(
        "PaperTrader: virtual_bankroll=$%.0f  report_interval=%.0fs",
        cfg.initial_bankroll, cfg.paper_report_interval_s,
    )
    log.info(
        "HotPath: tick_reactor=%s (threshold=%.4f/s)  position_guard=%s (adverse=%.4f/s)",
        "ENABLED" if cfg.tick_reactor_enabled else "disabled",
        cfg.tick_reactor_velocity_threshold,
        "ENABLED" if cfg.position_guard_enabled else "disabled",
        cfg.position_guard_adverse_velocity,
    )

    try:
        # Wait for kill switch signal (blocks indefinitely in normal operation).
        # If Redis disconnects temporarily, wait_for_kill() may raise — retry the
        # subscription loop rather than crashing the whole process.
        while True:
            try:
                await bus.wait_for_kill()
                log.critical("Kill signal received — initiating shutdown")
                break
            except asyncio.CancelledError:
                raise  # let CancelledError propagate to outer except
            except Exception as exc:
                log.warning("main: wait_for_kill error (%s) — will retry in 5s", exc)
                await asyncio.sleep(5)
                # Re-connect bus if it dropped
                try:
                    await bus.connect()
                except Exception:
                    pass
    except asyncio.CancelledError:
        log.info("Cancelled — shutting down")
    finally:
        await _shutdown(tasks)


async def _shutdown(tasks: list[asyncio.Task]) -> None:
    log.info("Shutting down all workers")

    for task in tasks:
        if not task.done():
            task.cancel()

    # Wait up to 10s for graceful shutdown
    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=10.0,
        )
    except asyncio.TimeoutError:
        log.warning("Shutdown timed out — forcing exit")

    # Disconnect persistence
    try:
        await redis_state.disconnect()
        await db.disconnect()
        await bus.disconnect()
    except Exception as exc:
        log.debug("Disconnect error: %s", exc)

    log.info("Shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Interrupted by user")
    except Exception as exc:
        log.critical("Fatal error: %s", exc, exc_info=True)
        sys.exit(1)

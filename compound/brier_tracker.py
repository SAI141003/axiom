"""
Compound Layer — Brier Score Tracker & Kronos Fine-Tuning Trigger

Responsibilities:
  - Compute rolling Brier score from resolved trades
  - Track per-source calibration (Haiku only vs Kronos-enhanced vs MiroFish-enhanced)
  - Trigger Kronos fine-tuning job when calibration degrades
  - Nightly summary log

Brier score: BS = (1/n) * sum((p_model - outcome)^2)
Target: BS < 0.25 (random = 0.25 for 50/50 markets)
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from persist.db import get_brier_score

log = logging.getLogger(__name__)

_BRIER_WARN_THRESHOLD = 0.25
_BRIER_CRITICAL_THRESHOLD = 0.30
_FINE_TUNE_TRIGGER_THRESHOLD = 0.28
_NIGHTLY_INTERVAL_S = 3600  # check every hour, full report at midnight


@dataclass
class CalibrationSnapshot:
    n_resolved: int = 0
    brier_score: float = 0.0
    win_rate: float = 0.0
    avg_edge: float = 0.0
    by_source: dict = field(default_factory=dict)
    ts: float = field(default_factory=time.time)


class BrierTracker:
    def __init__(self) -> None:
        self._running = False
        self._last_snapshot: Optional[CalibrationSnapshot] = None
        self._fine_tune_triggered_at: float = 0.0
        self._stats = {
            "checks_run": 0,
            "warnings_issued": 0,
            "fine_tune_triggers": 0,
        }

    async def run(self) -> None:
        self._running = True
        log.info("BrierTracker: starting")

        await asyncio.gather(
            self._hourly_check_loop(),
        )

    async def _hourly_check_loop(self) -> None:
        while self._running:
            await asyncio.sleep(_NIGHTLY_INTERVAL_S)
            try:
                await self._compute_and_report()
                self._stats["checks_run"] += 1
            except Exception as exc:
                log.debug("BrierTracker: check error: %s", exc)

    async def _compute_and_report(self) -> None:
        # Refit calibration model before computing Brier score
        from compound.calibration import calibrator
        await calibrator.update_from_db()

        brier = await get_brier_score(lookback_days=7)

        if brier is None:
            log.debug("BrierTracker: no resolved trades in past 7 days")
            return

        snapshot = CalibrationSnapshot(
            brier_score=round(brier, 4),
            ts=time.time(),
        )
        self._last_snapshot = snapshot

        if brier >= _BRIER_CRITICAL_THRESHOLD:
            log.error(
                "BrierTracker: CRITICAL calibration degradation BS=%.4f (threshold=%.2f)",
                brier, _BRIER_CRITICAL_THRESHOLD,
            )
            self._stats["warnings_issued"] += 1
        elif brier >= _BRIER_WARN_THRESHOLD:
            log.warning(
                "BrierTracker: calibration warning BS=%.4f (target<%.2f)",
                brier, _BRIER_WARN_THRESHOLD,
            )
            self._stats["warnings_issued"] += 1
        else:
            log.info("BrierTracker: calibration healthy BS=%.4f", brier)

        # Trigger Kronos fine-tuning if calibration degrades and enough time has passed
        if brier >= _FINE_TUNE_TRIGGER_THRESHOLD:
            await self._maybe_trigger_fine_tuning(brier)

    async def _maybe_trigger_fine_tuning(self, brier: float) -> None:
        # Rate limit: don't trigger more than once per 24h
        if time.time() - self._fine_tune_triggered_at < 86400:
            return

        self._fine_tune_triggered_at = time.time()
        self._stats["fine_tune_triggers"] += 1

        log.warning(
            "BrierTracker: triggering Kronos fine-tune (BS=%.4f >= %.2f)",
            brier, _FINE_TUNE_TRIGGER_THRESHOLD,
        )
        # Spawn fine-tuning as background task (non-blocking)
        asyncio.create_task(self._run_fine_tuning_job())

    async def _run_fine_tuning_job(self) -> None:
        """
        Trigger Kronos incremental fine-tuning on recent trade history.
        This is a best-effort background job — failures are logged, not raised.
        """
        try:
            from signals.kronos_signal import fine_tune_on_outcomes
            await fine_tune_on_outcomes(lookback_days=30)
            log.info("BrierTracker: Kronos fine-tune job completed")
        except ImportError:
            log.debug("BrierTracker: Kronos fine-tuning not available (fine_tune_on_outcomes not implemented)")
        except Exception as exc:
            log.warning("BrierTracker: fine-tune job failed: %s", exc)

    def get_snapshot(self) -> Optional[CalibrationSnapshot]:
        return self._last_snapshot

    def get_stats(self) -> dict:
        return {
            **self._stats,
            "last_brier": self._last_snapshot.brier_score if self._last_snapshot else None,
        }

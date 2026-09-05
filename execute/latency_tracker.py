"""
End-to-End Latency Tracker — Phase 6

Measures per-stage pipeline latency:
  WS_RECEIVE   — time from OS socket recv() to message parsed
  PROCESSING   — orderbook delta applied + OBI computed
  SIGNAL       — ensemble signal built (LLM + Heston + Kelly)
  RISK         — risk engine approval
  EXECUTION    — order submitted to CLOB (includes network RTT)
  ACK          — exchange acknowledgment received

All stages store a rolling deque of N=1000 samples.
p50/p95/p99 percentiles are available at any time.

Usage:
  from execute.latency_tracker import tracker, Stage
  tracker.record(Stage.EXECUTION, elapsed_ms)
  report = tracker.report()
"""
from __future__ import annotations

import time
from collections import deque
from enum import Enum
from typing import Optional


_WINDOW = 1_000   # rolling sample count per stage


class Stage(str, Enum):
    WS_RECEIVE   = "ws_receive"
    PROCESSING   = "processing"
    SIGNAL       = "signal"
    RISK         = "risk"
    EXECUTION    = "execution"
    ACK          = "ack"
    E2E          = "e2e"          # total pipeline: WS_RECEIVE → ACK


class LatencyTracker:
    """Thread-safe (asyncio-compatible) rolling latency histogram."""

    def __init__(self) -> None:
        self._samples: dict[Stage, deque[float]] = {
            stage: deque(maxlen=_WINDOW) for stage in Stage
        }
        self._started_at: dict[str, float] = {}   # request_id → start_ts

    def record(self, stage: Stage, latency_ms: float) -> None:
        self._samples[stage].append(latency_ms)

    def start(self, request_id: str) -> None:
        """Mark the start of a pipeline execution for E2E tracking."""
        self._started_at[request_id] = time.perf_counter() * 1000

    def finish(self, request_id: str) -> Optional[float]:
        """
        Mark the end of a pipeline execution.
        Returns the E2E latency in ms if the request_id was started, else None.
        """
        start = self._started_at.pop(request_id, None)
        if start is None:
            return None
        elapsed = time.perf_counter() * 1000 - start
        self.record(Stage.E2E, elapsed)
        # Evict stale in-flight entries (leaks if requests never finish)
        if len(self._started_at) > 500:
            oldest = sorted(self._started_at.items(), key=lambda x: x[1])
            for rid, _ in oldest[250:]:
                del self._started_at[rid]
        return elapsed

    def percentile(self, stage: Stage, pct: float) -> float:
        """
        Return the p-th percentile of recorded samples for a stage.
        Returns 0.0 if no samples recorded.
        """
        buf = self._samples[stage]
        if not buf:
            return 0.0
        sorted_buf = sorted(buf)
        idx = int(pct / 100.0 * (len(sorted_buf) - 1))
        return sorted_buf[idx]

    def p50(self, stage: Stage) -> float:
        return self.percentile(stage, 50)

    def p95(self, stage: Stage) -> float:
        return self.percentile(stage, 95)

    def p99(self, stage: Stage) -> float:
        return self.percentile(stage, 99)

    def count(self, stage: Stage) -> int:
        return len(self._samples[stage])

    def report(self) -> dict:
        """Return a full latency report for all stages."""
        out: dict = {}
        for stage in Stage:
            buf = self._samples[stage]
            if not buf:
                continue
            out[stage.value] = {
                "n":   len(buf),
                "p50": round(self.p50(stage), 2),
                "p95": round(self.p95(stage), 2),
                "p99": round(self.p99(stage), 2),
                "max": round(max(buf), 2),
            }
        return out

    def summary_line(self) -> str:
        """One-line summary for log output."""
        parts = []
        for stage in (Stage.WS_RECEIVE, Stage.SIGNAL, Stage.EXECUTION, Stage.E2E):
            if self._samples[stage]:
                parts.append(f"{stage.value}=p99:{self.p99(stage):.1f}ms")
        return " | ".join(parts) if parts else "no samples"


# Module-level singleton
tracker = LatencyTracker()

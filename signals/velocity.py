"""Price velocity tracker — pure in-process, zero I/O.

Tracks per-market price ticks and computes first + second derivatives.
Used by TickReactor for sub-10ms momentum decisions.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Optional
import time

_WINDOW_S = 10.0   # default velocity window
_BUF_SIZE  = 50    # ticks stored per market


@dataclass
class VelocitySnapshot:
    velocity: float   # price change per second (positive = rising)
    accel: float      # velocity change per second (second derivative)
    span_s: float     # actual time window covered by ticks used


_BUFS: dict[str, deque] = {}   # market_id → deque[(monotonic_ts, price)]


def push_tick(market_id: str, price: float) -> None:
    """Record a new price tick. Call on every MARKET_UPDATE event."""
    if market_id not in _BUFS:
        _BUFS[market_id] = deque(maxlen=_BUF_SIZE)
    _BUFS[market_id].append((time.monotonic(), price))


def get_velocity(market_id: str, window_s: float = _WINDOW_S) -> Optional[VelocitySnapshot]:
    """
    Compute price velocity and acceleration over the last `window_s` seconds.
    Returns None when fewer than 3 ticks are available.
    """
    buf = _BUFS.get(market_id)
    if not buf or len(buf) < 3:
        return None
    now = time.monotonic()
    ticks = [(ts, p) for ts, p in buf if now - ts <= window_s]
    if len(ticks) < 3:
        return None
    t0, p0 = ticks[0]
    t1, p1 = ticks[-1]
    span = t1 - t0
    if span < 0.1:
        return None
    velocity = (p1 - p0) / span
    mid = len(ticks) // 2
    tm, pm = ticks[mid]
    v1 = (pm - p0) / max(0.01, tm - t0)
    v2 = (p1 - pm) / max(0.01, t1 - tm)
    accel = (v2 - v1) / max(0.01, span)
    return VelocitySnapshot(velocity=velocity, accel=accel, span_s=span)

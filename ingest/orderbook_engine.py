"""
L2 Orderbook Engine — Phase 4

Full in-memory bid/ask price-level book with:
  - Sequence number validation (drops out-of-order deltas)
  - OBI = (BidVol − AskVol) / (BidVol + AskVol) at configurable depth
  - Weighted mid-price (resists quote stuffing at one level)
  - Kyle lambda (price impact via OLS on rolling 60-tick window)
  - Per-market singletons via get_l2_book()

Why a local book instead of relying on Redis Orderbook snapshots:
  Redis round-trip ≈ 0.5–1ms per lookup. On a fast-moving crypto market,
  the hot path needs OBI, spread, and best-bid/ask in microseconds.
  This engine lives in process memory — zero I/O after initialization.
"""
from __future__ import annotations

import math
import time
from collections import deque
from typing import Optional


_MAX_DEPTH   = 20     # max levels stored per side
_OBI_DEPTH   = 5      # default levels for OBI calculation
_KYLE_WINDOW = 60     # rolling ticks for Kyle lambda regression
_STALE_AGE_S = 2.0    # book older than 2s is flagged stale


class L2Book:
    """
    In-process L2 book for a single market (both YES and NO tokens map here).

    Bids are stored descending (highest price first).
    Asks are stored ascending (lowest price first).
    """

    __slots__ = (
        "market_id",
        "_bids",      # {price: size}
        "_asks",      # {price: size}
        "_seq",       # last applied sequence number (−1 = unset)
        "_snapshot_ts",
        "_update_ts",
        "_snapshot_confirmed",
        "_momentum",
        "_prev_mid",
        "_kyle_buf",  # deque[(signed_flow, mid_change)] for Kyle lambda
    )

    def __init__(self, market_id: str, initial_price: float = 0.5) -> None:
        self.market_id          = market_id
        self._bids: dict[float, float] = {}
        self._asks: dict[float, float] = {}
        self._seq               = -1
        self._snapshot_ts       = 0.0
        self._update_ts         = 0.0
        self._snapshot_confirmed = False
        self._momentum          = 0.0
        self._prev_mid          = initial_price
        self._kyle_buf: deque[tuple[float, float]] = deque(maxlen=_KYLE_WINDOW)

        # Seed with a synthetic spread so OBI is never nan before first snapshot
        spread = 0.02
        self._bids[round(initial_price - spread / 2, 4)] = 100.0
        self._asks[round(initial_price + spread / 2, 4)] = 100.0

    # ── Snapshot / Delta ──────────────────────────────────────────────────────

    def apply_snapshot(
        self,
        bids: list[dict],
        asks: list[dict],
        seq: Optional[int] = None,
    ) -> None:
        """Full book replace. Always accepted (snapshots reset sequence.)"""
        self._bids = {}
        self._asks = {}

        for b in bids[:_MAX_DEPTH]:
            try:
                p, s = float(b["price"]), float(b["size"])
                if s > 0:
                    self._bids[round(p, 4)] = s
            except (KeyError, ValueError):
                continue

        for a in asks[:_MAX_DEPTH]:
            try:
                p, s = float(a["price"]), float(a["size"])
                if s > 0:
                    self._asks[round(p, 4)] = s
            except (KeyError, ValueError):
                continue

        if seq is not None:
            self._seq = seq
        self._snapshot_ts       = time.time()
        self._update_ts         = self._snapshot_ts
        self._snapshot_confirmed = True
        self._prev_mid          = self.mid_price

    def apply_delta(
        self,
        side: str,
        price: float,
        size: float,
        seq: Optional[int] = None,
    ) -> bool:
        """
        Apply a single level update. Returns False and drops the event if:
          - Book has no snapshot yet
          - Sequence number is out of order (when seq is provided)
        size == 0 removes the level.
        """
        if not self._snapshot_confirmed:
            return False

        if seq is not None and seq <= self._seq:
            return False

        price = round(price, 4)
        if side in ("sell", "ask", "NO", "no"):
            if size <= 0:
                self._asks.pop(price, None)
            else:
                self._asks[price] = size
                # Evict worst levels beyond MAX_DEPTH
                if len(self._asks) > _MAX_DEPTH:
                    worst = sorted(self._asks.keys(), reverse=True)
                    for p in worst[_MAX_DEPTH:]:
                        del self._asks[p]
        else:  # buy / bid / YES
            if size <= 0:
                self._bids.pop(price, None)
            else:
                self._bids[price] = size
                if len(self._bids) > _MAX_DEPTH:
                    worst = sorted(self._bids.keys())
                    for p in worst[_MAX_DEPTH:]:
                        del self._bids[p]

        if seq is not None:
            self._seq = seq

        new_mid = self.mid_price
        elapsed = time.time() - self._update_ts
        if elapsed > 0 and self._prev_mid > 0:
            self._momentum = (new_mid - self._prev_mid) / elapsed
            # Record for Kyle lambda
            signed_flow = float(size) * (1 if side in ("buy", "bid", "YES", "yes") else -1)
            mid_change  = new_mid - self._prev_mid
            if abs(signed_flow) > 0:
                self._kyle_buf.append((signed_flow, mid_change))
        self._prev_mid  = new_mid
        self._update_ts = time.time()
        return True

    def apply_price_change(self, price: float, side: str = "ask") -> None:
        """
        Handle a Polymarket price_change event that contains only the new
        best price (no size). Updates the top-of-book level in place.
        """
        if not self._snapshot_confirmed:
            return

        price = round(price, 4)
        if side in ("sell", "ask"):
            if self._asks:
                old_best = min(self._asks)
                if old_best != price:
                    sz = self._asks.pop(old_best, 100.0)
                    self._asks[price] = sz
            else:
                self._asks[price] = 100.0
        else:
            if self._bids:
                old_best = max(self._bids)
                if old_best != price:
                    sz = self._bids.pop(old_best, 100.0)
                    self._bids[price] = sz
            else:
                self._bids[price] = 100.0

        self._update_ts = time.time()

    # ── Computed properties ───────────────────────────────────────────────────

    @property
    def best_bid(self) -> float:
        return max(self._bids) if self._bids else 0.0

    @property
    def best_ask(self) -> float:
        return min(self._asks) if self._asks else 1.0

    @property
    def mid_price(self) -> float:
        bb, ba = self.best_bid, self.best_ask
        if bb == 0.0 or ba == 1.0:
            return (bb + ba) / 2
        return (bb + ba) / 2

    @property
    def spread(self) -> float:
        return max(0.0, self.best_ask - self.best_bid)

    @property
    def is_crossed(self) -> bool:
        """
        True when best_bid >= best_ask — book is corrupted.
        Causes: WS reconnect race, out-of-order deltas, data feed error.
        Callers must check this before trusting OBI or weighted_mid.
        """
        bb, ba = self.best_bid, self.best_ask
        return bb > 0.0 and ba < 1.0 and bb >= ba

    @property
    def momentum(self) -> float:
        return self._momentum

    @property
    def price_age_ms(self) -> float:
        """Milliseconds since the last price event was applied to this book."""
        return (time.time() - self._update_ts) * 1000.0

    def is_stale(self, max_age_s: float = _STALE_AGE_S) -> bool:
        return (time.time() - self._update_ts) > max_age_s

    # ── Microstructure metrics ────────────────────────────────────────────────

    def obi(self, depth: int = _OBI_DEPTH) -> float:
        """
        Orderbook Imbalance at top-depth levels.
        OBI = (BidVol − AskVol) / (BidVol + AskVol)
        Range: [−1, +1]. Positive → buy pressure.
        Returns 0.0 (neutral / no signal) when book is crossed — do not trade.
        """
        if self.is_crossed:
            return 0.0
        top_bids = sorted(self._bids.items(), reverse=True)[:depth]
        top_asks = sorted(self._asks.items())[:depth]

        bid_vol = sum(s for _, s in top_bids)
        ask_vol = sum(s for _, s in top_asks)
        total   = bid_vol + ask_vol
        if total <= 0:
            return 0.0
        return (bid_vol - ask_vol) / total

    def weighted_mid(self) -> float:
        """
        Weighted mid-price using top-of-book volumes:
          wm = (bid_price × ask_size + ask_price × bid_size) / (ask_size + bid_size)
        Moves toward the side with more liquidity (size), resisting quote stuffing.
        Returns arithmetic mid when book is crossed (safe fallback, not tradeable).
        """
        if self.is_crossed:
            return (self.best_bid + self.best_ask) / 2
        bb, ba = self.best_bid, self.best_ask
        bs = self._bids.get(round(bb, 4), 1.0)
        as_ = self._asks.get(round(ba, 4), 1.0)
        total = bs + as_
        if total <= 0:
            return (bb + ba) / 2
        return (bb * as_ + ba * bs) / total

    def depth_volume(self, side: str, depth: int = _OBI_DEPTH) -> float:
        """Total size at top-depth levels on the given side."""
        if side in ("bid", "buy", "YES"):
            levels = sorted(self._bids.items(), reverse=True)[:depth]
        else:
            levels = sorted(self._asks.items())[:depth]
        return sum(s for _, s in levels)

    def kyle_lambda(self) -> float:
        """
        Price impact coefficient (Kyle λ):
          ΔP = λ × signed_order_flow + ε
        Estimated by OLS on rolling _KYLE_WINDOW ticks.
        Returns 0.0 if insufficient data.
        """
        if len(self._kyle_buf) < 10:
            return 0.0

        flows  = [x[0] for x in self._kyle_buf]
        deltas = [x[1] for x in self._kyle_buf]

        n   = len(flows)
        sx  = sum(flows)
        sy  = sum(deltas)
        sxx = sum(f * f for f in flows)
        sxy = sum(f * d for f, d in zip(flows, deltas))

        denom = n * sxx - sx * sx
        if abs(denom) < 1e-12:
            return 0.0
        return (n * sxy - sx * sy) / denom


# ── Per-market singleton registry ─────────────────────────────────────────────

_L2_BOOKS: dict[str, L2Book] = {}


def get_l2_book(market_id: str, initial_price: float = 0.5) -> L2Book:
    """Return (or create) the per-market L2 book."""
    if market_id not in _L2_BOOKS:
        _L2_BOOKS[market_id] = L2Book(market_id, initial_price)
    return _L2_BOOKS[market_id]


def all_books() -> dict[str, L2Book]:
    return _L2_BOOKS

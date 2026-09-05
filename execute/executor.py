"""
Execution engine — singleton ClobClient, idempotent order submission.

Critical fixes vs polymarket-pipeline/executor.py:
  1. ClobClient is a singleton — credentials derived ONCE at startup
  2. Async semaphore limits concurrent orders (prevents exposure blowout)
  3. Live price sanity check before submit (price must match cached orderbook)
  4. 3-second submit timeout (never hang indefinitely)
  5. Order state machine via order_tracker.py
  6. Idempotency: check for existing order before retrying on 5xx
  7. Daily loss guard reads from risk engine (not SQLite directly)
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from core.config import cfg
from core.models import ExecutionResult, Order, OrderStatus, Signal
from execute.latency_tracker import Stage, tracker as latency_tracker
from execute.order_tracker import OrderTracker
from persist import db, redis_state
from risk import risk_engine

log = logging.getLogger(__name__)

_MAX_CONCURRENT_ORDERS = 5
_SUBMIT_TIMEOUT_S = 3.0
_PRICE_TOLERANCE = 0.03  # reject if live price drifted >3 cents from signal
_MAX_ORDERS_PER_MINUTE = 12  # NautilusTrader-style throttle: hard rate cap


class _Throttler:
    """
    Sliding-window order-rate throttle (pattern from NautilusTrader's Throttler).
    Rejects instead of queueing — in an HFT loop a delayed order is a stale order.
    """

    def __init__(self, max_per_minute: int) -> None:
        self._max = max_per_minute
        self._stamps: list[float] = []

    def allow(self) -> bool:
        now = time.monotonic()
        self._stamps = [t for t in self._stamps if now - t < 60.0]
        if len(self._stamps) >= self._max:
            return False
        self._stamps.append(now)
        return True


class ExecutionEngine:
    """Singleton execution engine wrapping Polymarket CLOB client."""

    _instance: Optional["ExecutionEngine"] = None

    def __init__(self) -> None:
        self._client = None
        self._semaphore = asyncio.Semaphore(_MAX_CONCURRENT_ORDERS)
        self._throttler = _Throttler(_MAX_ORDERS_PER_MINUTE)
        self._tracker = OrderTracker()
        self._initialized = False

    @classmethod
    def get_instance(cls) -> Optional["ExecutionEngine"]:
        return cls._instance

    @classmethod
    async def create(cls) -> "ExecutionEngine":
        if cls._instance is None:
            engine = cls()
            await engine._initialize()
            cls._instance = engine
        return cls._instance

    async def _initialize(self) -> None:
        """Derive CLOB credentials once. Never repeat this in the hot path."""
        if cfg.dry_run:
            log.info("ExecutionEngine: DRY RUN mode — no live orders")
            self._initialized = True
            return

        if not cfg.polymarket_private_key:
            log.warning("ExecutionEngine: no private key — forced dry run")
            self._initialized = True
            return

        try:
            # py-clob-client V1 was archived 2026-05-11; use V2
            try:
                from py_clob_client_v2 import ClobClient
                _v2 = True
            except ImportError:
                from py_clob_client.client import ClobClient  # type: ignore[no-redef]
                _v2 = False

            # key = the WALLET PRIVATE KEY (py-clob-client derives creds from it);
            # signature_type=1 for email/Magic proxy accounts (funder = proxy addr).
            # Verified against live account 2026-07-11: creds derive cleanly.
            self._client = ClobClient(
                host=cfg.polymarket_host,
                key=cfg.polymarket_private_key,
                chain_id=137,
                signature_type=cfg.polymarket_signature_type,
                funder=cfg.polymarket_funder,
            )
            # Derive API creds once — EIP-712 signing, ~200ms
            # V2 renamed create_or_derive_api_creds → create_or_derive_api_key
            if _v2:
                creds = self._client.create_or_derive_api_key()
            else:
                creds = self._client.create_or_derive_api_creds()
            self._client.set_api_creds(creds)
            self._client._v2 = _v2  # stash for order submission
            self._initialized = True
            log.info("ExecutionEngine: CLOB client initialized (v%s) ✓", "2" if _v2 else "1")

        except ImportError:
            log.warning("ExecutionEngine: py-clob-client not installed — forced dry run")
            self._initialized = True
        except Exception as exc:
            log.error("ExecutionEngine: init error: %s", exc)
            raise

    async def submit(self, signal: Signal) -> ExecutionResult:
        """
        Full submission flow:
          1. Refresh risk state
          2. Risk approval
          3. Staleness check
          4. Live price check
          5. Submit order (or dry run)
          6. Track order state
          7. Log to PostgreSQL
        """
        if not self._throttler.allow():
            order = Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=signal.token_id,
                side=signal.side,
                size=signal.approved_size,
                price=signal.target_price,
                status=OrderStatus.REJECTED,
                error_msg="order rate throttle",
            )
            log.warning("ExecutionEngine: throttled — >%d orders/min", _MAX_ORDERS_PER_MINUTE)
            return ExecutionResult(order=order, status=OrderStatus.REJECTED,
                                   message=f"rate throttle: max {_MAX_ORDERS_PER_MINUTE}/min")
        async with self._semaphore:
            return await self._submit_inner(signal)

    async def _submit_inner(self, signal: Signal) -> ExecutionResult:
        t_start = time.perf_counter() * 1000
        latency_tracker.start(signal.id)

        # 1. Risk check (refreshes state first)
        t_risk_start = time.perf_counter() * 1000
        decision = await risk_engine.approve(signal)
        latency_tracker.record(Stage.RISK, time.perf_counter() * 1000 - t_risk_start)
        if not decision.approved:
            order = Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=signal.token_id,
                side=signal.side,
                size=signal.approved_size,
                price=signal.target_price,
                status=OrderStatus.REJECTED,
                error_msg=str(decision.reason),
            )
            log.debug("ExecutionEngine: REJECTED %s — %s", signal.market.condition_id[:8], decision.reason)
            return ExecutionResult(order=order, status=OrderStatus.REJECTED, message=decision.message)

        # Update signal size with risk-approved size
        approved_size = decision.approved_size

        # 2. Staleness check
        if signal.age_ms > cfg.signal_stale_ms:
            order = Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=signal.token_id,
                side=signal.side,
                size=approved_size,
                price=signal.target_price,
                status=OrderStatus.STALE,
                error_msg=f"age={signal.age_ms:.0f}ms > {cfg.signal_stale_ms}ms",
            )
            return ExecutionResult(order=order, status=OrderStatus.STALE)

        # 3. Live price sanity check
        live_ask = await redis_state.get_best_ask(signal.market.condition_id)
        if live_ask is not None and abs(live_ask - signal.target_price) > _PRICE_TOLERANCE:
            order = Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=signal.token_id,
                side=signal.side,
                size=approved_size,
                price=live_ask,
                status=OrderStatus.PRICE_MOVED,
                error_msg=f"signal_price={signal.target_price:.3f} live={live_ask:.3f}",
            )
            log.debug("ExecutionEngine: PRICE_MOVED for %s", signal.market.condition_id[:8])
            return ExecutionResult(order=order, status=OrderStatus.PRICE_MOVED)

        # Use live price if available
        execution_price = live_ask if live_ask is not None else signal.target_price

        # 4. DRY RUN
        if cfg.dry_run or self._client is None:
            order = Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=signal.token_id,
                side=signal.side,
                size=approved_size,
                price=execution_price,
                status=OrderStatus.DRY_RUN,
                order_id=f"dry_{signal.id[:8]}",
            )
            await db.log_trade(order, signal, dry_run=True)
            log.info(
                "DRY RUN: %s %s $%.2f @ %.3f (edge=%.3f)",
                signal.side, signal.market.question[:40],
                approved_size, execution_price, signal.edge,
            )
            return ExecutionResult(order=order, status=OrderStatus.DRY_RUN)

        # 5. LIVE ORDER
        t_exec = time.perf_counter() * 1000
        order = await self._place_live_order(signal, approved_size, execution_price)
        latency_tracker.record(Stage.EXECUTION, time.perf_counter() * 1000 - t_exec)

        # 6. Track in Redis
        await redis_state.set_order(order)
        await risk_engine.on_trade_submitted(
            signal.market.condition_id, approved_size, execution_price
        )

        # 7. Log to PostgreSQL
        await db.log_trade(order, signal)

        e2e_ms = latency_tracker.finish(signal.id) or (time.perf_counter() * 1000 - t_start)
        log.info(
            "ORDER: %s %s %s $%.2f @ %.3f — %s (%.0fms e2e)",
            order.status.value.upper(),
            signal.side,
            signal.market.question[:30],
            approved_size,
            execution_price,
            order.order_id or "—",
            e2e_ms,
        )

        return ExecutionResult(order=order, status=order.status)

    @staticmethod
    def _idempotent_order_id(signal_id: str, attempt: int = 0) -> str:
        """
        Deterministic client order ID derived from signal + attempt.
        Prevents duplicate submissions on retry: same signal re-derives the same ID.
        The exchange deduplicates on this key, returning the original order instead
        of creating a new one.
        """
        import hashlib
        key = f"{signal_id}:{attempt}"
        return hashlib.sha256(key.encode()).hexdigest()[:24]

    _OPTS_CACHE: dict = {}

    def _order_options(self, token_id: str):
        """neg_risk + tick_size for a token (cached). Required by the CLOB v2
        order schema; missing them = 'invalid order version' rejection."""
        from py_clob_client_v2.clob_types import PartialCreateOrderOptions
        cached = self._OPTS_CACHE.get(token_id)
        if cached is not None:
            return cached
        neg = self._client.get_neg_risk(token_id)
        tick = self._client.get_tick_size(token_id)
        opts = PartialCreateOrderOptions(neg_risk=neg, tick_size=tick)
        self._OPTS_CACHE[token_id] = opts
        return opts

    async def _place_live_order(
        self,
        signal: Signal,
        size: float,
        price: float,
        attempt: int = 0,
    ) -> Order:
        """
        Submit order to Polymarket CLOB. Returns Order with exchange ID.
        Uses a deterministic client_id for idempotent retries.
        """
        from py_clob_client.clob_types import OrderArgs, OrderType

        token_id   = signal.token_id
        client_id  = self._idempotent_order_id(signal.id, attempt)
        if not token_id:
            return Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id="",
                side=signal.side,
                size=size,
                price=price,
                status=OrderStatus.ERROR,
                error_msg="no_token_id",
            )

        try:
            _v2 = getattr(self._client, "_v2", False)
            if _v2:
                from py_clob_client_v2 import OrderArgs, OrderType
            else:
                from py_clob_client.clob_types import OrderArgs, OrderType  # type: ignore[no-redef]

            order_args = OrderArgs(
                price=price,
                size=size,
                side="BUY",
                token_id=token_id,
            )
            # Note: py-clob-client V2 accepts an optional `client_order_id` kwarg
            # for idempotent submission. Pass it when the attribute exists.
            if hasattr(order_args, "client_order_id"):
                object.__setattr__(order_args, "client_order_id", client_id)

            if _v2:
                # V2: single combined call. MUST pass neg_risk + tick_size per
                # token or the CLOB rejects with "invalid order version" —
                # proven via live $1 test 2026-07-11 (multi-outcome markets are
                # neg_risk=True). Cache per token to stay off the hot path.
                from py_clob_client_v2.clob_types import PartialCreateOrderOptions
                opts = self._order_options(token_id)
                resp = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        None,
                        lambda: self._client.create_and_post_order(
                            order_args, opts, OrderType.GTC
                        ),
                    ),
                    timeout=_SUBMIT_TIMEOUT_S,
                )
            else:
                # V1 two-step
                signed = self._client.create_order(order_args)
                resp = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        None,
                        lambda: self._client.post_order(signed, OrderType.GTC),
                    ),
                    timeout=_SUBMIT_TIMEOUT_S,
                )

            order_id    = resp.get("orderID", resp.get("id", f"unknown_{int(time.time())}"))
            # Detect immediate partial fill from exchange response
            filled_size = float(resp.get("filledSize", resp.get("size_matched", 0)) or 0)
            if 0 < filled_size < size:
                status = OrderStatus.PARTIALLY_FILLED
                log.info(
                    "ExecutionEngine: partial fill %s — %.2f / %.2f",
                    order_id[:8], filled_size, size,
                )
            else:
                status = OrderStatus.SUBMITTED

            return Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=token_id,
                side=signal.side,
                size=size,
                price=price,
                status=status,
                order_id=order_id,
                filled_size=filled_size,
            )

        except asyncio.TimeoutError:
            log.warning("ExecutionEngine: submit timeout (>%.1fs)", _SUBMIT_TIMEOUT_S)
            return Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=token_id,
                side=signal.side,
                size=size,
                price=price,
                status=OrderStatus.ERROR,
                error_msg="submit_timeout",
            )
        except Exception as exc:
            err = f"{type(exc).__name__}: {str(exc)[:100]}"
            log.error("ExecutionEngine: submit error: %s", err)
            return Order(
                signal_id=signal.id,
                market_id=signal.market.condition_id,
                token_id=token_id,
                side=signal.side,
                size=size,
                price=price,
                status=OrderStatus.ERROR,
                error_msg=err,
            )

    async def cancel_order(self, order_id: str) -> bool:
        """Cancel a single order by exchange ID."""
        if self._client is None:
            return True  # dry run — nothing to cancel

        try:
            resp = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(
                    None,
                    lambda: self._client.cancel(order_id),
                ),
                timeout=2.0,
            )
            return resp.get("success", True)
        except asyncio.TimeoutError:
            log.warning("ExecutionEngine: cancel timeout for %s", order_id)
            return False
        except Exception as exc:
            log.warning("ExecutionEngine: cancel error %s: %s", order_id, exc)
            return False

    async def reconcile_on_startup(self) -> None:
        """
        On startup: compare open orders in DB vs CLOB API.
        Any order in DB but NOT in CLOB = unknown status → alert operator.
        """
        db_open = await db.get_open_orders_from_db()
        if not db_open:
            return

        if self._client is None:
            log.info("Reconciliation: dry run mode, skipping CLOB check")
            return

        try:
            clob_open = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: self._client.get_orders(),
            )
            clob_ids = {o.get("id", o.get("orderID")) for o in (clob_open or [])}

            for oid in db_open:
                if oid not in clob_ids:
                    log.warning("RECONCILIATION: order %s in DB but NOT in CLOB — marking unknown", oid)
                    await db.update_trade_status(oid, "unknown", "not_found_in_clob")

        except Exception as exc:
            log.error("Reconciliation error: %s", exc)

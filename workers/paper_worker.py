"""
PAPER WORKER — Live virtual paper trading.

Mirrors every signal that the live system would act on, opens virtual
positions, tracks P&L tick-by-tick, and closes on exits.

Works in BOTH dry_run=true (pure virtual) and dry_run=false (parallel
shadow to live trading) — gives you a like-for-like performance record.

Virtual lifecycle:
  ENTRY  : SIGNAL_FAST / SIGNAL_CONSENSUS → open virtual position
  UPDATE : MARKET_UPDATE → update unrealized P&L on all open positions
  EXIT   : ORDER_CANCELLED (velocity guard / signal flip) → close at current price
           Price near resolution (>0.95 or <0.05) → auto-close
           Position age > 24h → stale cleanup

Deduplication: same market + side cannot stack within _DEDUP_WINDOW_S.
Signal flip:   new signal for same market on opposite side → close + re-open.

Redis keys (separate from live trading — never pollutes real risk checks):
  paper:stats       → JSON aggregate performance snapshot (TTL 24h)
  paper:pos:{mid}   → JSON individual open position (TTL 24h per update)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass, field, asdict
from typing import Optional

from core.config import cfg
from core.events import Channel, bus
from core.models import Signal
from persist import redis_state

log = logging.getLogger(__name__)

_DEDUP_WINDOW_S     = 60.0    # don't stack same market+side within 60s
_RESOLUTION_YES     = 0.96    # close YES position — market resolving YES
_RESOLUTION_NO      = 0.04    # close YES position — market resolving NO
_MAX_POSITION_AGE_S = 86_400  # 24h stale cleanup
_MAX_CLOSED_HISTORY = 500     # in-memory ring buffer of closed trades


# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class VirtualPosition:
    market_id:     str
    question:      str
    side:          str
    size:          float
    entry_price:   float
    current_price: float
    unrealized_pnl: float = 0.0
    entry_ts:      float  = field(default_factory=time.time)
    signal_id:     str    = ""
    edge:          float  = 0.0
    source:        str    = ""   # tick_reactor | signal_worker | arb | ...


@dataclass
class ClosedTrade:
    market_id:   str
    question:    str
    side:        str
    size:        float
    entry_price: float
    exit_price:  float
    pnl:         float
    pnl_pct:     float   # return on capital
    duration_s:  float
    edge:        float
    source:      str
    exit_reason: str
    closed_ts:   float = field(default_factory=time.time)


# ── Worker ────────────────────────────────────────────────────────────────────

class PaperWorker:
    """
    Live paper trading worker. Starts as an independent asyncio task.
    Never touches real positions, bankroll, or risk state.
    """

    def __init__(self) -> None:
        self._running          = False
        self._positions: dict[str, VirtualPosition] = {}
        self._closed:    list[ClosedTrade]           = []
        self._dedup:     dict[str, float]            = {}   # market+side → last_ts
        self._bankroll         = cfg.initial_bankroll
        self._peak_bankroll    = cfg.initial_bankroll
        self._total_realized   = 0.0
        self._wins             = 0
        self._losses           = 0
        self._total_entered    = 0

    # ── Startup ───────────────────────────────────────────────────────────────

    async def run(self) -> None:
        self._running = True
        log.info(
            "PaperWorker: starting  virtual_bankroll=$%.0f  mode=%s",
            self._bankroll,
            "DRY_RUN (no live orders)" if cfg.dry_run else "SHADOW (alongside live trades)",
        )
        await self._restore_state()

        q_fast      = bus.subscribe_local(Channel.SIGNAL_FAST)
        q_consensus = bus.subscribe_local(Channel.SIGNAL_CONSENSUS)
        q_update    = bus.subscribe_local(Channel.MARKET_UPDATE)
        q_cancel    = bus.subscribe_local(Channel.ORDER_CANCELLED)

        await asyncio.gather(
            self._signal_loop(q_fast,      "fast"),
            self._signal_loop(q_consensus, "consensus"),
            self._update_loop(q_update),
            self._cancel_loop(q_cancel),
            self._maintenance_loop(),
            self._report_loop(),
            self._heartbeat_loop(),
        )

    # ── Entry ─────────────────────────────────────────────────────────────────

    async def _signal_loop(self, q: asyncio.Queue, channel: str) -> None:
        while self._running:
            try:
                raw = await asyncio.wait_for(q.get(), timeout=5.0)
                signal = Signal.model_validate(raw)
                await self._enter(signal)
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("PaperWorker: signal parse error: %s", exc)

    async def _enter(self, signal: Signal) -> None:
        mid  = signal.market.condition_id
        side = signal.side

        # Close existing opposite-side position first (signal flip)
        existing = self._positions.get(mid)
        if existing and existing.side != side:
            await self._close(mid, signal.target_price, "signal_flip")

        # Deduplication: don't stack same market+side within window
        dedup_key = f"{mid}:{side}"
        if time.time() - self._dedup.get(dedup_key, 0.0) < _DEDUP_WINDOW_S:
            return
        if mid in self._positions:
            return

        size = max(1.0, signal.approved_size)
        pos = VirtualPosition(
            market_id    = mid,
            question     = signal.market.question,
            side         = side,
            size         = size,
            entry_price  = signal.target_price,
            current_price= signal.target_price,
            signal_id    = signal.id,
            edge         = signal.edge,
            source       = _source_tag(signal.reasoning),
        )
        self._positions[mid] = pos
        self._dedup[dedup_key] = time.time()
        self._total_entered += 1
        await self._persist_position(mid, pos)
        log.info(
            "PaperWorker ENTER  %s %s $%.2f @ %.3f  edge=%.3f  [%s]",
            side, mid[:8], size, signal.target_price, signal.edge, pos.source,
        )

    # ── Price update → unrealized P&L ────────────────────────────────────────

    async def _update_loop(self, q: asyncio.Queue) -> None:
        while self._running:
            try:
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                mid   = event.get("market_id", "")
                price = event.get("yes_price")
                if mid and price is not None:
                    await self._tick(mid, float(price))
            except asyncio.TimeoutError:
                pass
            except Exception:
                pass

    async def _tick(self, mid: str, price: float) -> None:
        pos = self._positions.get(mid)
        if pos is None:
            return
        pos.current_price  = price
        pos.unrealized_pnl = _pnl(pos, price)

        # Auto-close when market price signals near-resolution
        if pos.side == "YES":
            if price >= _RESOLUTION_YES:
                await self._close(mid, price, "resolved_yes")
            elif price <= _RESOLUTION_NO:
                await self._close(mid, price, "resolved_no")
        else:  # NO position: exits when YES hits extreme
            if price <= _RESOLUTION_NO:
                await self._close(mid, price, "resolved_yes")
            elif price >= _RESOLUTION_YES:
                await self._close(mid, price, "resolved_no")

    # ── Cancel → close virtual position ──────────────────────────────────────

    async def _cancel_loop(self, q: asyncio.Queue) -> None:
        while self._running:
            try:
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                mid   = event.get("market_id", "")
                if mid and mid in self._positions:
                    price  = self._positions[mid].current_price
                    reason = event.get("reason", "cancelled")
                    await self._close(mid, price, reason)
            except asyncio.TimeoutError:
                pass
            except Exception:
                pass

    # ── Core close ────────────────────────────────────────────────────────────

    async def _close(self, mid: str, exit_price: float, reason: str) -> None:
        pos = self._positions.pop(mid, None)
        if pos is None:
            return
        await self._delete_position(mid)

        pnl          = _pnl(pos, exit_price)
        entry_cost   = pos.size * pos.entry_price
        pnl_pct      = pnl / entry_cost if entry_cost > 0 else 0.0
        dur          = time.time() - pos.entry_ts

        trade = ClosedTrade(
            market_id   = pos.market_id,
            question    = pos.question,
            side        = pos.side,
            size        = pos.size,
            entry_price = pos.entry_price,
            exit_price  = exit_price,
            pnl         = pnl,
            pnl_pct     = pnl_pct,
            duration_s  = dur,
            edge        = pos.edge,
            source      = pos.source,
            exit_reason = reason,
        )
        self._closed.append(trade)
        if len(self._closed) > _MAX_CLOSED_HISTORY:
            self._closed.pop(0)

        self._total_realized += pnl
        self._bankroll       += pnl
        self._peak_bankroll   = max(self._peak_bankroll, self._bankroll)

        if pnl >= 0:
            self._wins   += 1
        else:
            self._losses += 1

        log.info(
            "PaperWorker EXIT   %s %s @ %.3f  pnl=$%+.2f (%+.1f%%)  dur=%.0fs  [%s]",
            pos.side, mid[:8], exit_price, pnl, pnl_pct * 100, dur, reason,
        )
        await self._persist_stats()

    # ── Maintenance: close stale positions ────────────────────────────────────

    async def _maintenance_loop(self) -> None:
        while self._running:
            await asyncio.sleep(300)
            now   = time.time()
            stale = [
                mid for mid, pos in self._positions.items()
                if now - pos.entry_ts > _MAX_POSITION_AGE_S
            ]
            for mid in stale:
                await self._close(mid, self._positions[mid].current_price, "stale_24h")

    # ── Periodic performance report ───────────────────────────────────────────

    async def _report_loop(self) -> None:
        await asyncio.sleep(90)   # first report after 90s (let system warm up)
        while self._running:
            self._print_report()
            await asyncio.sleep(cfg.paper_report_interval_s)

    def _print_report(self) -> None:
        n        = self._wins + self._losses
        win_rate = self._wins / n if n else 0.0
        pct_chg  = (self._bankroll - cfg.initial_bankroll) / cfg.initial_bankroll * 100
        drawdown = (
            (self._peak_bankroll - self._bankroll) / self._peak_bankroll * 100
            if self._peak_bankroll > 0 else 0.0
        )
        sharpe       = _sharpe(self._closed)
        open_unreal  = sum(p.unrealized_pnl for p in self._positions.values())

        sep = "━" * 60
        lines = [
            sep,
            "  PAPER TRADING — LIVE PERFORMANCE REPORT",
            sep,
            f"  Virtual Bankroll : ${self._bankroll:>10,.2f}   ({pct_chg:+.1f}% vs start)",
            f"  Open Positions   : {len(self._positions):>3}   unrealized ${open_unreal:+.2f}",
            f"  Closed Trades    : {n:>3}   wins {self._wins}  /  losses {self._losses}   ({win_rate:.1%} win rate)",
            f"  Realized P&L     : ${self._total_realized:>+10,.2f}",
            f"  Sharpe (annlzd)  : {sharpe:>6.2f}   Max Drawdown: {drawdown:.1f}%",
        ]

        # Signal source P&L breakdown
        by_src: dict[str, dict] = {}
        for t in self._closed:
            d = by_src.setdefault(t.source, {"n": 0, "pnl": 0.0, "wins": 0})
            d["n"]   += 1
            d["pnl"] += t.pnl
            if t.pnl >= 0:
                d["wins"] += 1
        if by_src:
            lines.append(f"  {'─'*56}")
            lines.append("  Signal Source Breakdown:")
            for src, d in sorted(by_src.items(), key=lambda x: -x[1]["pnl"]):
                wr = d["wins"] / d["n"] if d["n"] else 0.0
                lines.append(
                    f"    {src:<22s}  {d['n']:3d} trades  "
                    f"${d['pnl']:+8.2f}  ({wr:.0%} win)"
                )

        # Last 5 closed trades
        if self._closed:
            lines.append(f"  {'─'*56}")
            lines.append("  Recent Exits:")
            for t in self._closed[-5:]:
                dur_str = f"{t.duration_s/60:.0f}m" if t.duration_s < 3600 else f"{t.duration_s/3600:.1f}h"
                sign = "✓" if t.pnl >= 0 else "✗"
                lines.append(
                    f"    {sign} {t.side} {t.question[:34]:<34}  "
                    f"${t.pnl:+.2f}  {dur_str}  [{t.exit_reason[:20]}]"
                )

        # Open positions snapshot
        if self._positions:
            lines.append(f"  {'─'*56}")
            lines.append("  Open Positions:")
            for pos in list(self._positions.values())[:8]:
                age_m = (time.time() - pos.entry_ts) / 60
                lines.append(
                    f"    {pos.side} {pos.question[:34]:<34}  "
                    f"${pos.unrealized_pnl:+.2f}  ({age_m:.0f}m)  [{pos.source}]"
                )

        lines.append(sep)
        log.info("\n%s", "\n".join(lines))

    # ── Redis persistence (non-critical — failures are silent) ────────────────

    async def _persist_stats(self) -> None:
        try:
            n = self._wins + self._losses
            payload = json.dumps({
                "virtual_bankroll":    round(self._bankroll, 2),
                "total_realized_pnl":  round(self._total_realized, 2),
                "open_positions":      len(self._positions),
                "total_entered":       self._total_entered,
                "wins":                self._wins,
                "losses":              self._losses,
                "win_rate":            round(self._wins / n, 3) if n else 0.0,
                "sharpe":              round(_sharpe(self._closed), 2),
                "max_drawdown_pct":    round(
                    (self._peak_bankroll - self._bankroll) / max(1, self._peak_bankroll) * 100, 2
                ),
            })
            await redis_state.cache_set("paper:stats", payload, ttl=86_400)
        except Exception:
            pass

    async def _persist_position(self, mid: str, pos: VirtualPosition) -> None:
        try:
            await redis_state.cache_set(
                f"paper:pos:{mid}", json.dumps(asdict(pos)), ttl=86_400
            )
        except Exception:
            pass

    async def _delete_position(self, mid: str) -> None:
        try:
            from persist.redis_state import _REDIS
            if _REDIS:
                await _REDIS.delete(f"paper:pos:{mid}")
        except Exception:
            pass

    async def _restore_state(self) -> None:
        """Restore stats from Redis on restart (best-effort)."""
        try:
            raw = await redis_state.cache_get("paper:stats")
            if raw:
                saved = json.loads(raw)
                self._bankroll       = float(saved.get("virtual_bankroll",   cfg.initial_bankroll))
                self._peak_bankroll  = max(self._peak_bankroll, self._bankroll)
                self._total_realized = float(saved.get("total_realized_pnl", 0.0))
                self._total_entered  = int(saved.get("total_entered",         0))
                self._wins           = int(saved.get("wins",                  0))
                self._losses         = int(saved.get("losses",                0))
                log.info(
                    "PaperWorker: restored — bankroll=$%.2f  trades=%d  pnl=$%+.2f",
                    self._bankroll, self._total_entered, self._total_realized,
                )
        except Exception:
            pass

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await redis_state.set_worker_heartbeat("paper")
            await asyncio.sleep(10)

    def get_summary(self) -> dict:
        n = self._wins + self._losses
        return {
            "virtual_bankroll":   round(self._bankroll, 2),
            "open_positions":     len(self._positions),
            "total_entered":      self._total_entered,
            "wins":               self._wins,
            "losses":             self._losses,
            "win_rate":           round(self._wins / n, 3) if n else 0.0,
            "total_realized_pnl": round(self._total_realized, 2),
            "sharpe":             round(_sharpe(self._closed), 2),
            "max_drawdown_pct":   round(
                (self._peak_bankroll - self._bankroll) / max(1, self._peak_bankroll) * 100, 2
            ),
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _pnl(pos: VirtualPosition, exit_price: float) -> float:
    """Compute realized/unrealized P&L in dollars."""
    if pos.side == "YES":
        return pos.size * (exit_price - pos.entry_price)
    return pos.size * (pos.entry_price - exit_price)


def _sharpe(closed: list[ClosedTrade], min_trades: int = 5) -> float:
    """Annualized Sharpe from per-trade percentage returns."""
    if len(closed) < min_trades:
        return 0.0
    returns = [t.pnl_pct for t in closed]
    mean_r  = sum(returns) / len(returns)
    var_r   = sum((r - mean_r) ** 2 for r in returns) / len(returns)
    std_r   = math.sqrt(var_r) if var_r > 1e-12 else 1e-9
    return mean_r / std_r * math.sqrt(252)


def _source_tag(reasoning: str) -> str:
    """Extract a short source label from signal reasoning."""
    r = reasoning.lower()
    if "tick_reactor"    in r: return "tick_reactor"
    if "oracle_lag"      in r: return "oracle_lag"
    if "crypto_binary"   in r: return "crypto_binary"
    if "negrisk"         in r: return "arb/negrisk"
    if "longshot"        in r: return "longshot_no"
    if "mean_rev"        in r: return "mean_reversion"
    if "uma"             in r: return "uma_dispute"
    if "deribit"         in r: return "deribit_iv"
    if "smart_money"     in r: return "smart_money"
    if r.startswith("arb["): return "arb/" + r[4:r.index("]")] if "]" in r else "arb"
    return "signal_worker"


# Singleton
paper_worker = PaperWorker()

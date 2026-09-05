"""
Monitor — Bloomberg-style Rich terminal dashboard.

Live updates every 2s showing:
  - Bankroll & daily P&L
  - Open positions table
  - Recent signals & orders
  - Worker health (heartbeats)
  - Brier score & calibration
  - API cost tracker
  - Kill switch status
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

try:
    from rich.console import Console
    from rich.layout import Layout
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
    from rich import box
    _RICH_AVAILABLE = True
except ImportError:
    _RICH_AVAILABLE = False

from core.config import cfg
from execute.latency_tracker import Stage, tracker as _latency_tracker
from persist import redis_state

log = logging.getLogger(__name__)

_REFRESH_S = 2.0
_console = Console() if _RICH_AVAILABLE else None


def _make_header(bankroll: float, daily_pnl: float, kill_active: bool) -> Panel:
    pnl_color = "green" if daily_pnl >= 0 else "red"
    kill_text = " [bold red]⛔ KILL SWITCH ACTIVE[/]" if kill_active else ""
    content = (
        f"[bold cyan]Polymarket HFT[/]  "
        f"Bankroll: [bold white]${bankroll:,.2f}[/]  "
        f"Daily P&L: [{pnl_color}]{'+' if daily_pnl >= 0 else ''}${daily_pnl:,.2f}[/]"
        f"{kill_text}"
    )
    return Panel(content, style="bright_blue", padding=(0, 1))


def _make_positions_table(positions: list[dict]) -> Table:
    table = Table(
        title="Open Positions",
        box=box.SIMPLE_HEAVY,
        show_header=True,
        header_style="bold magenta",
    )
    table.add_column("Market", width=40)
    table.add_column("Side", width=6)
    table.add_column("Size", justify="right", width=8)
    table.add_column("Avg", justify="right", width=7)
    table.add_column("Current", justify="right", width=8)
    table.add_column("Unrealized P&L", justify="right", width=15)

    for pos in positions:
        pnl = pos.get("unrealized_pnl", 0)
        pnl_str = f"[green]+${pnl:.2f}[/]" if pnl >= 0 else f"[red]-${abs(pnl):.2f}[/]"
        table.add_row(
            pos["market"][:40],
            pos["side"],
            f"${pos['size']:.2f}",
            f"{pos['avg_price']:.3f}",
            f"{pos['current_price']:.3f}",
            pnl_str,
        )

    if not positions:
        table.add_row("[dim]No open positions[/]", "", "", "", "", "")

    return table


def _make_workers_table(heartbeats: dict[str, float]) -> Table:
    table = Table(
        title="Worker Health",
        box=box.SIMPLE,
        header_style="bold cyan",
    )
    table.add_column("Worker", width=15)
    table.add_column("Status", width=10)
    table.add_column("Last Heartbeat", width=20)

    workers = [
        "ingestion", "signal", "execution", "risk",
        "market_maker", "tick_reactor", "position_guard", "paper_trader",
        "quant_calibration", "research_worker",
    ]
    now = time.time()

    for worker in workers:
        last_ts = heartbeats.get(worker, 0)
        age_s = now - last_ts if last_ts > 0 else 9999

        if age_s < 30:
            status = "[green]ALIVE[/]"
        elif age_s < 60:
            status = "[yellow]STALE[/]"
        else:
            status = "[red]DEAD[/]"

        last_str = f"{age_s:.0f}s ago" if last_ts > 0 else "never"
        table.add_row(worker.capitalize(), status, last_str)

    return table


def _make_stats_panel(stats: dict) -> Panel:
    lat   = _latency_tracker.report()
    e2e   = lat.get(Stage.E2E.value, {})
    exec_ = lat.get(Stage.EXECUTION.value, {})
    sig   = lat.get(Stage.SIGNAL.value, {})

    lat_str = (
        f"  Latency p99 — sig:[cyan]{sig.get('p99', 0):.0f}ms[/]  "
        f"exec:[yellow]{exec_.get('p99', 0):.0f}ms[/]  "
        f"e2e:[magenta]{e2e.get('p99', 0):.0f}ms[/]"
        if e2e else ""
    )

    lines = [
        f"Signals: [cyan]{stats.get('signals_generated', 0)}[/]   "
        f"Orders: [green]{stats.get('orders_submitted', 0)}[/]   "
        f"Rejected: [red]{stats.get('orders_rejected', 0)}[/]   "
        f"Deduped: [yellow]{stats.get('orders_deduped', 0)}[/]",
        f"API Cost: [magenta]${stats.get('api_cost_usd', 0):.3f}[/]   "
        f"API Calls: [magenta]{stats.get('api_calls', 0)}[/]   "
        f"Brier 7d: [cyan]{stats.get('brier_score', 'n/a')}[/]"
        + lat_str,
    ]
    return Panel("\n".join(lines), title="Statistics", style="dim")


async def _gather_dashboard_data() -> dict:
    """Collect all state for one dashboard refresh."""
    try:
        bankroll = await redis_state.get_bankroll() or 0.0
        daily_loss = await redis_state.get_daily_loss() or 0.0
        kill_active = await redis_state.is_kill_switch_active()

        positions_raw = await redis_state.get_all_positions()
        positions = [
            {
                "market": getattr(p, "market_question", p.market_id)[:40],
                "side": getattr(p, "side", "?"),
                "size": getattr(p, "size", 0),
                "avg_price": getattr(p, "avg_price", 0),
                "current_price": getattr(p, "current_price", 0),
                "unrealized_pnl": getattr(p, "unrealized_pnl", 0),
            }
            for p in positions_raw
        ]

        heartbeats = await redis_state.get_worker_health()

        return {
            "bankroll": bankroll,
            "daily_pnl": -daily_loss,
            "kill_active": kill_active,
            "positions": positions,
            "heartbeats": heartbeats,
        }
    except Exception as exc:
        log.debug("dashboard data gather error: %s", exc)
        return {
            "bankroll": 0.0,
            "daily_pnl": 0.0,
            "kill_active": False,
            "positions": [],
            "heartbeats": {},
        }


async def run_dashboard(stats_provider: Optional[dict] = None) -> None:
    """
    Run the live dashboard. Blocks until killed.

    stats_provider: optional shared dict updated by workers with live stats.
    """
    if not _RICH_AVAILABLE:
        log.warning("rich not installed — dashboard disabled")
        return

    stats = stats_provider or {}

    def _build_layout(data: dict) -> Layout:
        layout = Layout()
        layout.split_column(
            Layout(name="header", size=3),
            Layout(name="body"),
            Layout(name="footer", size=5),
        )
        layout["body"].split_row(
            Layout(name="positions"),
            Layout(name="workers"),
        )

        layout["header"].update(_make_header(
            data["bankroll"], data["daily_pnl"], data["kill_active"]
        ))
        layout["positions"].update(_make_positions_table(data["positions"]))
        layout["workers"].update(_make_workers_table(data["heartbeats"]))
        layout["footer"].update(_make_stats_panel(stats))

        return layout

    with Live(console=_console, refresh_per_second=1, screen=True) as live:
        while True:
            data = await _gather_dashboard_data()
            live.update(_build_layout(data))
            await asyncio.sleep(_REFRESH_S)

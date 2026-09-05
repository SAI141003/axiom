"""
Macro Event Calendar — Event Volatility Premium

Computes the next major macro event (FOMC, CPI, NFP, OPEX) and returns a vol
multiplier to apply to options pricing within the event risk window.

No external API required. Dates are:
  - FOMC:  hardcoded from the Fed's published 2025-2026 schedule
  - CPI:   second Wednesday of each month (8:30 ET = 13:30 UTC)
  - NFP:   first Friday of each month (8:30 ET = 13:30 UTC)
  - OPEX:  third Friday of each month (SPX options expiry, 14:30 UTC)

Inspired by Fincept Terminal's MacroCalendarService + FRED integration.
"""
from __future__ import annotations

import calendar
import logging
from datetime import date, datetime, time, timedelta, timezone

log = logging.getLogger(__name__)

# FOMC meeting dates — statement released at 14:00 ET (18:00 UTC) on day 2
_FOMC_DATES: list[date] = [
    # 2025 remaining
    date(2025, 9, 17), date(2025, 10, 29), date(2025, 12, 10),
    # 2026
    date(2026, 1, 28), date(2026, 3, 18), date(2026, 5, 6),
    date(2026, 6, 17), date(2026, 7, 29), date(2026, 9, 16),
    date(2026, 10, 28), date(2026, 12, 9),
]
_FOMC_RELEASE_UTC_HOUR = 18   # 2pm ET

# Vol premium schedule: (hours_before_event, hours_after_event, multiplier)
_WINDOWS: list[tuple[float, float, float]] = [
    (6.0,  1.0, 1.50),   # inside 6h before → 1h after: strong premium
    (24.0, 4.0, 1.20),   # 1 day out: moderate
    (48.0, 6.0, 1.08),   # 2 days out: small
]


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """Return the nth occurrence (1-indexed) of weekday (0=Mon) in year/month."""
    d = date(year, month, 1)
    delta = (weekday - d.weekday()) % 7
    return d + timedelta(days=delta) + timedelta(weeks=n - 1)


def _next_occurrence(ref: date, weekday: int, nth: int) -> date:
    """Find next date after ref that is the nth weekday of its month."""
    for offset in range(3):
        month = ref.month + offset
        year = ref.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        candidate = _nth_weekday(year, month, weekday, nth)
        if candidate > ref:
            return candidate
    return ref + timedelta(days=90)


def _event_multiplier(hours_to_event: float) -> float:
    for h_before, h_after, mult in _WINDOWS:
        if -h_after <= hours_to_event <= h_before:
            return mult
    return 1.0


def get_event_vol_context() -> tuple[float, str, float]:
    """
    Returns (vol_multiplier, event_name, hours_to_event).

    hours_to_event < 0 means the event already passed (still in post-event window).
    vol_multiplier == 1.0 when no event is imminent.
    """
    now   = datetime.now(timezone.utc)
    today = now.date()

    events: list[tuple[str, datetime]] = []

    for d in _FOMC_DATES:
        dt = datetime.combine(d, time(hour=_FOMC_RELEASE_UTC_HOUR), tzinfo=timezone.utc)
        events.append(("FOMC", dt))

    cpi_date = _next_occurrence(today, calendar.WEDNESDAY, 2)
    events.append(("CPI", datetime.combine(cpi_date, time(13, 30), tzinfo=timezone.utc)))

    nfp_date = _next_occurrence(today, calendar.FRIDAY, 1)
    events.append(("NFP", datetime.combine(nfp_date, time(13, 30), tzinfo=timezone.utc)))

    opex_date = _next_occurrence(today, calendar.FRIDAY, 3)
    events.append(("OPEX", datetime.combine(opex_date, time(14, 30), tzinfo=timezone.utc)))

    # Nearest event by absolute time distance
    nearest_name, nearest_dt = min(events, key=lambda e: abs((e[1] - now).total_seconds()))
    hours_to_event = (nearest_dt - now).total_seconds() / 3600.0
    multiplier = _event_multiplier(hours_to_event)

    if multiplier > 1.0:
        log.debug(
            "MacroCalendar: %s in %.1fh → vol_multiplier=%.2f",
            nearest_name, hours_to_event, multiplier,
        )

    return multiplier, nearest_name, hours_to_event

# Polymarket HFT — Bug Fix Report

Session date: 2026-07-07  
Python runtime: 3.14 (`.venv/lib/python3.14/`)

All bugs were found by systematic code review across the full codebase. None required live trading to surface. The fixes below are ordered by severity.

---

## Bug 1 — Kill switch fires on profitable days (CRITICAL)

**File:** `workers/risk_worker.py`

**Symptom:** Kill switch triggers when daily P&L is strongly positive (e.g. +$150). Bot shuts down in the middle of a winning day.

**Root cause:** `get_daily_loss()` returns net P&L — positive means profit, negative means loss. The comparison `daily_loss >= cfg.daily_loss_limit_usd` (with a positive limit like $50) fires whenever profit exceeds $50, which is almost every good day.

**Fix:**
```python
# Before (fires on profitable days):
if daily_loss >= cfg.daily_loss_limit_usd:

# After (correctly fires only on actual losses):
net_loss = max(0.0, -daily_loss) if daily_loss is not None else 0.0
if net_loss >= cfg.daily_loss_limit_usd:
    await self._trigger_kill_switch(
        reason=RiskRejectReason.DAILY_LOSS,
        details=f"net_loss=${net_loss:.2f} >= limit=${cfg.daily_loss_limit_usd:.2f}",
    )
```

**Note:** `risk_engine.py:119` already had `max(0.0, -_daily_loss)` — the fix mirrors that existing correct pattern.

---

## Bug 2 — MiroFish cache crashes on Redis disconnect (HIGH)

**File:** `signals/mirofish_client.py`

**Symptom:** Any transient Redis disconnect causes `RuntimeError` inside the MiroFish signal pipeline, killing the entire signal for that market.

**Root cause:** `_get_cached_report()` and `_cache_report()` called `redis_state._r()` directly — a private method that raises `RuntimeError: Redis not connected` on disconnect rather than returning None.

**Fix:** Replaced `_r()` direct access with the public `cache_get` / `cache_set` helpers, which catch connection errors silently and return None/False respectively. Cache misses on disconnect become a no-op (MiroFish just re-runs the simulation) rather than a crash.

---

## Bug 3 — `asyncio.get_event_loop()` deprecated in Python 3.14 (HIGH, 13 call sites)

**Symptom:** In Python 3.14, `asyncio.get_event_loop()` called from within a running event loop emits a `DeprecationWarning` and in future Python versions will raise `RuntimeError`. Affects all `run_in_executor()` calls that offload CPU-bound work to threads.

**Files fixed and call-site counts:**

| File | Occurrences fixed |
|---|---|
| `execute/executor.py` | 4 |
| `risk/kill_switch.py` | 1 |
| `workers/quant_calibration_worker.py` | 1 |
| `match/matcher.py` | 2 |
| `signals/diffrax_calibrator.py` | 4 |
| `signals/timesfm_signal.py` | 2 |
| `signals/kronos_signal.py` | 4 |
| `signals/bayesian_vol_posterior.py` | 2 |

**Fix (uniform across all sites):**
```python
# Before:
result = await asyncio.get_event_loop().run_in_executor(None, _fn)

# After:
result = await asyncio.get_running_loop().run_in_executor(None, _fn)
```

`get_running_loop()` is the correct API when called from within a coroutine — it returns the already-running loop and raises `RuntimeError` immediately if called outside one (which is the right failure mode, not a silent deprecation).

---

## Bug 4 — Dead code double-computes returns in quant calibration (MEDIUM)

**File:** `workers/quant_calibration_worker.py`

**Symptom:** No crash, but wasted CPU. Arithmetic returns computed, stored to a variable, then immediately overwritten by the correct log returns. Any downstream use of the variable name would silently use the wrong return type.

**Fix:** Removed the dead arithmetic-returns computation. Single correct variable `log_rets` assigned from log returns. Code is now unambiguous.

---

## Bug 5 — Main process crashes on transient Redis disconnect (MEDIUM)

**File:** `main.py`

**Symptom:** A brief Redis blip during `bus.wait_for_kill()` raises an exception that propagates all the way up `main()`, invoking `_shutdown()` and cancelling all 15 worker tasks — equivalent to a manual kill switch activation, but without any order cancellation.

**Root cause:** `await bus.wait_for_kill()` was unguarded. Any exception from the Redis pub/sub subscription escaped directly to the `except asyncio.CancelledError` handler.

**Fix:** Wrapped in an inner retry loop:
```python
while True:
    try:
        await bus.wait_for_kill()
        log.critical("Kill signal received — initiating shutdown")
        break
    except asyncio.CancelledError:
        raise  # let SIGTERM/SIGINT propagate normally
    except Exception as exc:
        log.warning("main: wait_for_kill error (%s) — will retry in 5s", exc)
        await asyncio.sleep(5)
        try:
            await bus.connect()
        except Exception:
            pass
```

`CancelledError` still propagates (intentional shutdown). Everything else retries after 5s with a reconnect attempt.

---

## Verification

After all fixes, a full project-wide grep confirms zero remaining `get_event_loop` calls in source files:

```
grep -rn "get_event_loop" /Users/saiyaganti/polymarket-hft/ --include="*.py" | grep -v ".venv/"
# (no output)
```

---

## Safety invariants — confirmed not violated

- `POLYMARKET_PRIVATE_KEY` is never hardcoded — env only. Confirmed.
- `DRY_RUN=true` is the default in `core/config.py`. Confirmed.
- `MAX_BET_USD=25` hard cap enforced in `risk/risk_engine.py`. Confirmed.
- Kill switch remains independently testable (STOP file, SIGTERM, Redis channel). Confirmed.
- Bankroll loaded from PostgreSQL on startup via `risk_engine.initialize()`. Confirmed.

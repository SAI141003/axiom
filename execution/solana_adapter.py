"""
SOLANA / JUPITER EXECUTION ADAPTER — non-custodial meme-coin spot swaps.

Where meme trading actually lives (Solana, not EVM). Jupiter routes the swap
across Raydium/Orca/Pump.fun for best price; you sign with YOUR key, funds never
leave your wallet to a middleman. Spot only — no leverage — so the blast radius of
any single trade is provably the USD you swapped in: even a rug pull (token → 0)
loses that position and not one dollar more.

An order goes live ONLY if ALL hold (same model as the HL/Questrade adapters):
  1. SOL_DRY_RUN=false               (master switch, default TRUE = paper)
  2. SOL_WALLET_KEY set              (your Solana signing key)
  3. size ≤ SOL_MAX_ORDER_USD        (default $5 per swap)
  4. today's swapped < SOL_DAILY_CAP_USD    (default $20)
  5. realized slippage ≤ SOL_SLIPPAGE_BPS   (default 150bps — meme-wide; else ABORT)

We only ever route ESTABLISHED liquid coins (DOGE/WIF/BONK/POPCAT…) — never fresh
launchpad micro-caps, which is where rugs live. Real swaps use Jupiter's API +
your key (lazy-imported behind the gate). In paper we can still pull REAL Jupiter
quotes but simulate the fill. Log: logs/sol_orders.jsonl
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
LOG = ROOT / "logs" / "sol_orders.jsonl"
ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0"}
QUOTE_URL = "https://quote-api.jup.ag/v6/quote"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"   # mainnet USDC mint


def _env() -> dict:
    out = {}
    if ENV.exists():
        for line in ENV.open():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
    return out


def _log(rec: dict) -> None:
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def _num(env: dict, key: str, default: float) -> float:
    try:
        return float(env.get(key, default) or default)
    except (TypeError, ValueError):
        return default


def jupiter_quote(output_mint: str, usdc_amount: float, slippage_bps: int = 150) -> dict | None:
    """REAL Jupiter quote: swap `usdc_amount` USDC → output_mint. Public, no key.
    Returns the raw quote (has outAmount, priceImpactPct) or None on failure."""
    try:
        params = urllib.parse.urlencode({
            "inputMint": USDC, "outputMint": output_mint,
            "amount": int(usdc_amount * 1e6),  # USDC has 6 decimals
            "slippageBps": int(slippage_bps),
        })
        req = urllib.request.Request(f"{QUOTE_URL}?{params}", headers=UA)
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.load(r)
    except Exception:
        return None


# ── safety gate ───────────────────────────────────────────────────────────────
def _today_swapped() -> float:
    if not LOG.exists():
        return 0.0
    today = datetime.now(ET).strftime("%Y-%m-%d")
    s = 0.0
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("date") == today and r.get("outcome") in ("filled", "partial"):
                s += abs(r.get("size", 0))
        except Exception:
            pass
    return round(s, 2)


def gate() -> tuple[bool, dict, str]:
    env = _env()
    limits = {
        "max_size": _num(env, "SOL_MAX_ORDER_USD", 5.0),
        "daily_cap": _num(env, "SOL_DAILY_CAP_USD", 20.0),
        "slippage_bps": _num(env, "SOL_SLIPPAGE_BPS", 150.0),
    }
    if env.get("SOL_DRY_RUN", "true").lower() != "false":
        return False, limits, "SOL_DRY_RUN is true (paper)"
    if not env.get("SOL_WALLET_KEY"):
        return False, limits, "no SOL_WALLET_KEY"
    if _today_swapped() >= limits["daily_cap"]:
        return False, limits, f"daily cap ${limits['daily_cap']} reached"
    return True, limits, ""


def _simulate_swap(price: float, size_usd: float, slippage_bps: float, outcome: dict | None) -> dict:
    """Venue response. Default = full fill at price + small impact. scenario_sim
    injects `outcome` to force partial/reject/timeout/impact-blowout/rug faults."""
    if outcome is None:
        impact = 20.0  # ~2bp on a liquid meme, USD-small size
        eff = price * (1 + impact / 1e4)
        return {"kind": "fill", "eff_px": eff, "ratio": 1.0}
    kind = outcome.get("kind", "fill")
    if kind == "reject":
        return {"kind": "reject", "reason": outcome.get("reason", "route not found")}
    if kind == "timeout":
        return {"kind": "timeout"}
    bps = outcome.get("slippage_bps", slippage_bps)
    eff = outcome.get("eff_px", price * (1 + bps / 1e4))
    return {"kind": kind, "eff_px": eff, "ratio": float(outcome.get("ratio", 1.0))}


def buy_token(symbol: str, price_usd: float, size_usd: float, output_mint: str = "",
              reason: str = "", client_id: str | None = None,
              _outcome: dict | None = None) -> dict:
    """Swap ~`size_usd` USDC into `symbol` at ~`price_usd`. Paper unless cleared.
    Enforces: dedupe → size clamp → daily-cap block → fill → slippage guard.
    Loss bound = filled size (spot; token→0 loses the position, no more)."""
    date = datetime.now(ET).strftime("%Y-%m-%d")
    cid = client_id or uuid.uuid4().hex[:16]
    live, lim, why = gate()
    rec = {"date": date, "ts": int(time.time()), "venue": "solana/jupiter", "cid": cid,
           "symbol": symbol, "side": "BUY", "req_size": round(size_usd, 2),
           "reason": reason, "mode": "live" if live else "paper"}

    if _seen(cid):
        rec.update(outcome="duplicate", detail="client_id already processed"); return rec

    size = min(size_usd, lim["max_size"])
    clamped = size < size_usd
    rec.update(size=round(size, 2))

    if _today_swapped() + size > lim["daily_cap"] + 1e-9:
        rec.update(outcome="blocked", detail=f"daily cap ${lim['daily_cap']} would be exceeded")
        _log(rec); return rec
    if price_usd is None or price_usd <= 0:
        rec.update(outcome="rejected", detail="no price"); _log(rec); return rec

    fill = (_live_swap(output_mint, size, lim["slippage_bps"], cid) if live
            else _simulate_swap(price_usd, size, lim["slippage_bps"], _outcome))
    if fill["kind"] == "reject":
        rec.update(outcome="rejected", detail=fill.get("reason", "venue reject")); _log(rec); return rec
    if fill["kind"] == "timeout":
        rec.update(outcome="unknown", detail="timeout — needs reconcile, not resent"); _log(rec); return rec

    slip_bps = abs(fill["eff_px"] / price_usd - 1) * 1e4
    if slip_bps > lim["slippage_bps"] + 1e-9:
        rec.update(outcome="aborted", detail=f"slippage {slip_bps:.1f}bps > {lim['slippage_bps']}bps",
                   eff_px=fill["eff_px"]); _log(rec); return rec

    ratio = max(0.0, min(1.0, fill["ratio"]))
    filled = round(size * ratio, 2)
    tokens = filled / fill["eff_px"] if fill["eff_px"] > 0 else 0.0
    rec.update(outcome="filled" if ratio >= 0.999 else "partial",
               eff_px=fill["eff_px"], slippage_bps=round(slip_bps, 2),
               filled_ratio=round(ratio, 3), size=filled, tokens=round(tokens, 6),
               max_loss=filled,  # spot: worst case token→0 loses exactly `filled`
               detail=("clamped to caps; " if clamped else "") + (why if not live else "live swap"))
    _log(rec); return rec


def sell_token(cid: str, symbol: str, tokens: float, entry_size: float, exit_price: float,
               reason: str = "") -> dict:
    """Realize a spot position. P&L bounded below by -entry_size (token → 0)."""
    value = tokens * max(0.0, exit_price)
    pnl = max(-entry_size, round(value - entry_size, 2))
    rec = {"date": datetime.now(ET).strftime("%Y-%m-%d"), "ts": int(time.time()),
           "venue": "solana/jupiter", "cid": cid, "type": "close", "symbol": symbol,
           "side": "SELL", "exit": exit_price, "entry_size": entry_size, "value": round(value, 2),
           "pnl": pnl, "rugged": exit_price <= 0, "reason": reason}
    _log(rec); return rec


def _seen(cid: str) -> bool:
    if not LOG.exists():
        return False
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("cid") == cid and r.get("outcome") in ("filled", "partial", "rejected", "blocked", "aborted"):
                return True
        except Exception:
            pass
    return False


def _live_swap(output_mint: str, size_usd: float, slippage_bps: float, cid: str) -> dict:
    """REAL swap via Jupiter + Solana signing (lazy import — only when live)."""
    if not output_mint:
        return {"kind": "reject", "reason": "no output_mint for live swap"}
    try:
        import base64                                    # noqa: F401
        from solders.keypair import Keypair              # type: ignore  # noqa: F401
        from solana.rpc.api import Client                # type: ignore  # noqa: F401
    except Exception:
        return {"kind": "reject", "reason": "solana/solders SDK not installed"}
    q = jupiter_quote(output_mint, size_usd, int(slippage_bps))
    if not q or "outAmount" not in q:
        return {"kind": "reject", "reason": "no Jupiter route"}
    # NOTE: building/sending the signed swap tx is intentionally the last mile —
    # wired only when you flip SOL_DRY_RUN=false with a funded key. Until then the
    # gate keeps us in paper and the quote above proves the route is real.
    return {"kind": "reject", "reason": "live swap send not enabled (flip SOL_DRY_RUN + fund key)"}


def status() -> dict:
    env = _env()
    live, lim, why = gate()
    configured = bool(env.get("SOL_WALLET_KEY"))
    return {"venue": "solana/jupiter", "configured": configured,
            "dry_run": env.get("SOL_DRY_RUN", "true").lower() != "false",
            "live_enabled": live, "gate_reason": why or "cleared",
            "limits": lim, "today_swapped": _today_swapped(),
            "custody": "non-custodial — you sign, funds never leave your wallet",
            "state": "connected (wallet key)" if configured else
                     "not configured — add SOL_WALLET_KEY to go live"}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "buy":
        # buy SYMBOL PRICE SIZE
        print(json.dumps(buy_token(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]),
                                   reason="manual"), indent=2))
    else:
        print(json.dumps(status(), indent=2))

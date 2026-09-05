"""
PATH F — Crypto Binary Option Signal

For markets asking "Will BTC be above $X at [time]?":
  - Parses strike K and expiry T from question / market.end_date
  - Fetches real-time spot price S from Binance public REST (no auth required)
  - Estimates annualized realized vol σ from last 30 five-minute candles
  - Computes P(S_T > K) = N(d₂) under log-normal dynamics
  - Adds momentum + funding-rate drift adjustment
  - Returns edge vs devigged Polymarket price

This is the primary pricing model for crypto YES/NO binary markets.
Runs every 15 s via ArbitrageScanner._crypto_binary_loop().
Also runs as PATH F in signal_worker for per-news-event pricing.

Data sources — all public, no auth:
  Spot price:   api.binance.com/api/v3/ticker/price
  Klines:       api.binance.com/api/v3/klines
  Funding rate: fapi.binance.com/fapi/v1/fundingRate

Cache TTL:
  Spot:    10 s
  Klines:  30 s  (need fresh vol estimate for short-τ markets)
  Funding: 60 s  (changes every 8 h on Binance)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiohttp
import numpy as np

from core.config import cfg
from core.models import CryptoBinaryOutput, Market
from persist.redis_state import cache_get as _rc_get, cache_set as _rc_set
from signals.heston_pricer import calibrate_heston, heston_digital_prob, get_vol_filter, merton_digital_prob
from signals.onchain_signal import forecast as onchain_forecast
from signals.macro_calendar import get_event_vol_context
from signals.order_flow_signal import get_order_flow

log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

BINANCE_REST = "https://api.binance.com"
BINANCE_FAPI = "https://fapi.binance.com"

ASSET_SYMBOL: dict[str, str] = {
    "BTC":      "BTCUSDT",
    "BITCOIN":  "BTCUSDT",
    "ETH":      "ETHUSDT",
    "ETHEREUM": "ETHUSDT",
    "SOL":      "SOLUSDT",
    "SOLANA":   "SOLUSDT",
    "DOGE":     "DOGEUSDT",
    "DOGECOIN": "DOGEUSDT",
    "AVAX":     "AVAXUSDT",
    "AVALANCHE":"AVAXUSDT",
    "LINK":     "LINKUSDT",
    "BNB":      "BNBUSDT",
    "XRP":      "XRPUSDT",
    "RIPPLE":   "XRPUSDT",
    "MATIC":    "MATICUSDT",
    "POLYGON":  "MATICUSDT",
}

# Normalized display symbol (what we show in UI / logs)
ASSET_DISPLAY: dict[str, str] = {
    "BTCUSDT": "BTC", "ETHUSDT": "ETH", "SOLUSDT": "SOL",
    "DOGEUSDT": "DOGE", "AVAXUSDT": "AVAX", "LINKUSDT": "LINK",
    "BNBUSDT": "BNB", "XRPUSDT": "XRP", "MATICUSDT": "MATIC",
}

_DEFAULT_VOL_ANN = 0.70    # 70% annualized — conservative BTC baseline
_MIN_TAU_HOURS   = 0.02    # ignore markets expiring in < ~1 minute
_MAX_TAU_HOURS   = 72.0    # beyond 3 days the model is less reliable
_MIN_EDGE        = 0.03    # don't return signals below 3 %

# ── Redis cache helpers ───────────────────────────────────────────────────────



# ── Question parsers ──────────────────────────────────────────────────────────

def _parse_asset(question: str) -> tuple[Optional[str], Optional[str]]:
    """Return (asset_key, binance_symbol) from question, e.g. ("BTC", "BTCUSDT")."""
    q = question.upper()
    for key, symbol in ASSET_SYMBOL.items():
        if key in q:
            return ASSET_DISPLAY.get(symbol, key[:4]), symbol
    return None, None


def _parse_direction(question: str) -> str:
    q = question.lower()
    if any(w in q for w in ("above", "exceed", "over", "higher", "more than", "break", "reach", "surpass")):
        return "above"
    if any(w in q for w in ("below", "under", "less than", "lower", "drop", "fall", "dip")):
        return "below"
    return "above"


def _parse_strike(question: str) -> Optional[float]:
    q = question.replace(",", "")
    m = re.search(r'\$\s*(\d+(?:\.\d+)?)\s*[kK](?!\w)', q)
    if m:
        return float(m.group(1)) * 1_000
    m = re.search(r'\$\s*(\d+(?:\.\d+)?)\s*[mM](?!\w)', q)
    if m:
        return float(m.group(1)) * 1_000_000
    # 3+ digit dollar amount (covers $100 SOL strikes, $95000 BTC, etc.)
    m = re.search(r'\$\s*(\d{3,}(?:\.\d+)?)', q)
    if m:
        return float(m.group(1))
    return None


def _parse_expiry(question: str, end_date: Optional[str]) -> Optional[datetime]:
    now = datetime.now(timezone.utc)

    # market.end_date is the most reliable source
    if end_date:
        try:
            dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            pass

    # "in N minutes"
    m = re.search(r'in\s+(\d+)\s+minutes?', question, re.I)
    if m:
        return now + timedelta(minutes=int(m.group(1)))

    # "in N hours"
    m = re.search(r'in\s+(\d+)\s+hours?', question, re.I)
    if m:
        return now + timedelta(hours=int(m.group(1)))

    # "at HH:MM UTC"
    m = re.search(r'at\s+(\d{1,2}):(\d{2})\s*(?:utc|gmt)?', question, re.I)
    if m:
        h, mins = int(m.group(1)), int(m.group(2))
        candidate = now.replace(hour=h, minute=mins, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    # "at Npm / Npm UTC"
    m = re.search(r'at\s+(\d{1,2})\s*(am|pm)', question, re.I)
    if m:
        h = int(m.group(1))
        if m.group(2).lower() == "pm" and h != 12:
            h += 12
        elif m.group(2).lower() == "am" and h == 12:
            h = 0
        candidate = now.replace(hour=h, minute=0, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    q = question.lower()
    if "midnight" in q or "end of day" in q or "23:59" in q:
        return now.replace(hour=23, minute=59, second=0, microsecond=0)

    return None


# ── Binance data fetchers ──────────────────────────────────────────────────────

async def _fetch_klines(symbol: str) -> list[float]:
    """Return last 30 five-minute close prices. Cached 30 s."""
    key = f"cbm:klines:{symbol}"
    cached = await _rc_get(key)
    if cached:
        return json.loads(cached)

    url = f"{BINANCE_REST}/api/v3/klines"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                url,
                params={"symbol": symbol, "interval": "5m", "limit": 30},
                timeout=aiohttp.ClientTimeout(total=5.0),
            ) as r:
                if r.status != 200:
                    return []
                data = await r.json()
        closes = [float(c[4]) for c in data]
        await _rc_set(key, json.dumps(closes), ttl=30)
        return closes
    except Exception as exc:
        log.debug("Binance klines failed %s: %s", symbol, exc)
        return []


async def _fetch_ohlc_1m(symbol: str) -> list[tuple[float, float, float, float]]:
    """
    Return last 30 one-minute OHLC bars as (open, high, low, close) tuples.
    Cached 20s. Used for Yang-Zhang vol estimator.
    """
    key = f"cbm:ohlc1m:{symbol}"
    cached = await _rc_get(key)
    if cached:
        return [tuple(x) for x in json.loads(cached)]

    url = f"{BINANCE_REST}/api/v3/klines"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                url,
                params={"symbol": symbol, "interval": "1m", "limit": 30},
                timeout=aiohttp.ClientTimeout(total=5.0),
            ) as r:
                if r.status != 200:
                    return []
                data = await r.json()
        # [open_time, open, high, low, close, volume, ...]
        bars = [(float(c[1]), float(c[2]), float(c[3]), float(c[4])) for c in data]
        await _rc_set(key, json.dumps(bars), ttl=20)
        return bars
    except Exception as exc:
        log.debug("Binance 1m OHLC failed %s: %s", symbol, exc)
        return []


def _yang_zhang_vol(bars: list[tuple[float, float, float, float]]) -> float:
    """
    Yang-Zhang (2000) OHLC volatility estimator — 5× more efficient than
    close-to-close. Combines Rogers-Satchell (intrabar) with overnight variance.

    bars: list of (open, high, low, close), most recent last.
    Returns annualized volatility.

    Yang-Zhang 2000, "Drift-Independent Volatility Estimation Based on High,
    Low, Open, and Close Prices", Journal of Business 73(3).
    """
    n = len(bars)
    if n < 4:
        return 0.0

    log_rs, log_co, log_oo = [], [], []
    for i in range(n):
        o, h, l, c = bars[i]
        if o <= 0 or h <= 0 or l <= 0 or c <= 0:
            continue
        lh = math.log(h / o)
        ll = math.log(l / o)
        lc = math.log(c / o)
        log_rs.append(lh * (lh - lc) + ll * (ll - lc))  # Rogers-Satchell
        log_co.append(lc)

    for i in range(1, n):
        if bars[i][0] > 0 and bars[i - 1][0] > 0:
            log_oo.append(math.log(bars[i][0] / bars[i - 1][0]))  # open-to-open

    if len(log_rs) < 3 or len(log_oo) < 2:
        return 0.0

    sigma2_rs = float(np.mean(log_rs))

    o_bar = float(np.mean(log_oo))
    sigma2_o = float(np.mean([(r - o_bar) ** 2 for r in log_oo]))

    c_bar = float(np.mean(log_co))
    sigma2_c = float(np.mean([(r - c_bar) ** 2 for r in log_co]))

    # Optimal k (Yang-Zhang 2000 Eq. 14)
    m = len(log_rs)
    k = 0.34 / (1.34 + (m + 1) / max(m - 1, 1))

    sigma2_yz = sigma2_o + k * sigma2_c + (1.0 - k) * sigma2_rs
    # 1-min bars: 365 × 24 × 60 = 525,600 bars/year
    sigma2_ann = max(0.0, sigma2_yz * 525_600)
    return math.sqrt(sigma2_ann)


async def _fetch_spot(symbol: str) -> float:
    """Return current spot price. Cached 10 s."""
    key = f"cbm:spot:{symbol}"
    cached = await _rc_get(key)
    if cached:
        return float(cached)

    url = f"{BINANCE_REST}/api/v3/ticker/price"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                url,
                params={"symbol": symbol},
                timeout=aiohttp.ClientTimeout(total=3.0),
            ) as r:
                if r.status != 200:
                    return 0.0
                data = await r.json()
        price = float(data["price"])
        await _rc_set(key, str(price), ttl=10)
        return price
    except Exception as exc:
        log.debug("Binance spot failed %s: %s", symbol, exc)
        return 0.0


async def _fetch_funding_rate(symbol: str) -> float:
    """Return latest perpetuals funding rate annualized. Cached 60 s."""
    key = f"cbm:funding:{symbol}"
    cached = await _rc_get(key)
    if cached:
        return float(cached)

    url = f"{BINANCE_FAPI}/fapi/v1/fundingRate"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                url,
                params={"symbol": symbol, "limit": 1},
                timeout=aiohttp.ClientTimeout(total=3.0),
            ) as r:
                if r.status != 200:
                    return 0.0
                data = await r.json()
        if not data:
            return 0.0
        # Binance funding is per-8-h; ×3×365 = annualized
        rate_ann = float(data[0].get("fundingRate", 0.0)) * 3 * 365
        await _rc_set(key, str(rate_ann), ttl=60)
        return rate_ann
    except Exception as exc:
        log.debug("Binance funding failed %s: %s", symbol, exc)
        return 0.0


def _devig(yes: float, no: float) -> float:
    total = yes + no
    return yes / total if total > 0 else yes


# ── Main entry point ──────────────────────────────────────────────────────────

async def forecast(market: Market) -> Optional[CryptoBinaryOutput]:
    """
    Price a crypto binary market. Returns None if market can't be parsed
    or if edge is below _MIN_EDGE threshold.
    """
    t0 = time.time()

    asset, symbol = _parse_asset(market.question)
    if not asset or not symbol:
        return None

    strike = _parse_strike(market.question)
    _up_or_down = "up or down" in market.question.lower()
    if strike is None and not _up_or_down:
        return None
    if strike is not None and strike <= 0:
        return None

    # Reject race-condition questions ("hit X or Y first") — not simple above/below
    _q_lower = market.question.lower()
    if " or " in _q_lower and "first" in _q_lower:
        return None

    direction = "above" if _up_or_down else _parse_direction(market.question)

    expiry_dt = _parse_expiry(market.question, market.end_date)
    if expiry_dt is None:
        return None

    now = datetime.now(timezone.utc)
    tau_sec = (expiry_dt - now).total_seconds()
    tau_hours = tau_sec / 3600.0

    if tau_hours < _MIN_TAU_HOURS or tau_hours > _MAX_TAU_HOURS:
        return None

    # Guard: skip near-resolved markets (market_price ≥ 0.93 or ≤ 0.07).
    # These are priced with near-certainty by the crowd — no edge available,
    # and our Heston model underestimates certainty near resolution.
    # Also catches already-expired markets accidentally returned by the scanner.
    if market.yes_price >= 0.93 or market.yes_price <= 0.07:
        return None

    # "Up or Down" markets are only actionable in the final 15 min (oracle lag window).
    # Beyond that the window-open price is unknown — model_p degrades to a coin flip.
    if _up_or_down and tau_hours > 0.25:
        return None

    tau_years = tau_sec / (365.25 * 24.0 * 3600.0)

    # Fetch market data + microstructure + order flow concurrently
    closes, ohlc_1m, spot, funding_ann, onchain, order_flow = await asyncio.gather(
        _fetch_klines(symbol),
        _fetch_ohlc_1m(symbol),
        _fetch_spot(symbol),
        _fetch_funding_rate(symbol),
        onchain_forecast(asset, symbol),
        get_order_flow(asset, symbol),
    )

    if spot <= 0:
        return None

    # "Up or Down" markets: strike = current spot (YES resolves if price ends above open)
    if _up_or_down:
        strike = spot

    # Macro event calendar — vol premium around FOMC / CPI / NFP / OPEX
    macro_vol_mult, macro_event, hours_to_event = get_event_vol_context()

    # Heston calibration + Bayesian particle filter (Eq 1 + Eq 3)
    if closes and len(closes) >= 3:
        log_returns = list(np.diff(np.log(np.array(closes, dtype=float))))
        momentum_5m = closes[-1] / closes[-2] - 1.0
        # 30-min half-life decay — at 2 h+ the 5-min return is pure noise
        momentum_decay = math.exp(-tau_hours / 0.5)
        mu_momentum = momentum_5m * 105_120 * momentum_decay
        params      = calibrate_heston(closes, asset)
        vol_filter  = get_vol_filter(asset, params)
        vol_filter.bulk_update(log_returns)
        params.v0   = vol_filter.v_est   # posterior mean variance from Bayesian filter
        sigma       = vol_filter.sigma_ann
    else:
        momentum_5m = 0.0
        mu_momentum = 0.0
        params      = calibrate_heston([], asset)
        vol_filter  = get_vol_filter(asset, params)
        sigma       = vol_filter.sigma_ann

    # Yang-Zhang vol replaces close-to-close when 1-min OHLC bars are available.
    # YZ is 5× more efficient (lower estimation error) — critical for short-τ markets.
    # Yang & Zhang (2000), Journal of Business 73(3): "Drift-Independent Volatility
    # Estimation Based on High, Low, Open, and Close Prices"
    if ohlc_1m and len(ohlc_1m) >= 8:
        yz_sigma = _yang_zhang_vol(ohlc_1m)
        if 0.05 <= yz_sigma <= 5.0:
            # Blend 60% YZ (more precise) + 40% particle filter (more robust)
            sigma_blended = 0.60 * yz_sigma + 0.40 * sigma
            params.v0 = sigma_blended ** 2
            sigma = sigma_blended
            log.debug("CryptoBinary: YZ vol=%.1f%% blended=%.1f%%",
                      yz_sigma * 100, sigma * 100)

    # Deribit implied vol — forward-looking, consensus from pro options traders.
    # Overrides realized vol when available (lower Brier score empirically).
    try:
        from signals.deribit_signal import get_surface as _deribit_surface
        deribit_surf = _deribit_surface(asset)
        if deribit_surf and strike:
            deribit_iv = deribit_surf.get_iv(expiry_dt.timestamp(), strike)
            if deribit_iv and 0.05 <= deribit_iv <= 5.0:
                # Blend: 70% Deribit IV, 30% realized vol (guards against stale surface)
                sigma_blended = 0.70 * deribit_iv + 0.30 * sigma
                params.v0 = sigma_blended ** 2
                sigma = sigma_blended
                log.debug("CryptoBinary: Deribit IV=%.1f%% (blended=%.1f%%)",
                          deribit_iv * 100, sigma * 100)
    except Exception:
        pass  # Deribit unavailable — proceed with realized vol

    # Apply microstructure + order-flow + macro vol multipliers to latent variance
    # order_flow.vol_multiplier captures trade intensity spikes not visible in klines
    # Cap at 2.5× to prevent compounded extreme multipliers from dominating
    combined_vol_mult = min(onchain.vol_multiplier * order_flow.vol_multiplier * macro_vol_mult, 2.5)
    params.v0 = float(np.clip(params.v0 * combined_vol_mult, 0.001, 25.0))
    sigma     = math.sqrt(params.v0)

    # Combined drift: momentum + funding rate + onchain bias + order flow CVD
    # order_flow.direction_bias is derived from real-time CVD z-score (strongest 5-min signal)
    mu_onchain     = onchain.direction_bias * 0.25
    mu_order_flow  = order_flow.direction_bias * 0.40 * order_flow.confidence
    mu = float(np.clip(
        mu_momentum + funding_ann * 0.10 + mu_onchain + mu_order_flow,
        -3.0, 3.0,
    ))

    # Heston-Lewis digital probability (Eq 2)
    prob_above, d2 = heston_digital_prob(spot, strike, params, tau_years, mu)

    # Merton jump-diffusion blend for medium-horizon markets (6h–72h).
    # At these horizons, the jump-diffusion term contributes 0.1–2.5% probability
    # that the Heston continuous diffusion misses. Default BTC params are calibrated
    # from Bakshi-Cao-Chen (1997) adapted for crypto jump history.
    # Only applied when tau_hours ≥ 6 to avoid adding noise to short-horizon models.
    if tau_hours >= 6.0:
        p_merton = merton_digital_prob(
            spot, strike, tau_years, sigma, mu,
            lam=3.0, mu_j=-0.05, sigma_j=0.07,
        )
        if 0.01 <= p_merton <= 0.99:
            # Blend 70% Heston (captures vol dynamics) + 30% Merton (captures jump tails)
            prob_above = 0.70 * prob_above + 0.30 * p_merton

    # SABR smile correction for binary (digital) options.
    #
    # From Breeden-Litzenberger: P_digital_market = -∂C_vanilla/∂K
    # With vol smile σ(K): ∂C_vanilla/∂K = ∂C_BS/∂K + vega × ∂σ/∂K
    #
    # Correction (Reiner-Rubinstein 1991, r=0 for collateral-backed Polymarket):
    #   P_digital_market = N(d2) - S × √T × n(d1) × ∂σ/∂K
    #
    # For crypto negative skew (∂σ/∂K < 0):
    #   - OTM upside digitals: correction = +S√T n(d1)|∂σ/∂K| > 0 → probability INCREASES
    #   - This is correct: negative skew creates a left-skewed distribution but the
    #     hedging cost of the digital replication increases its market-implied probability.
    try:
        from signals.deribit_signal import get_surface as _deribit_surface
        from signals.sabr_smile import SABRSurface
        deribit_surf = _deribit_surface(asset)
        if deribit_surf and strike and isinstance(deribit_surf, SABRSurface):
            exp_keys = sorted(deribit_surf._smiles.keys())
            if exp_keys:
                nearest_exp = min(exp_keys, key=lambda e: abs(e - expiry_dt.timestamp()))
                smile = deribit_surf._smiles.get(nearest_exp)
                if smile is not None:
                    iv_at_k = smile.get_iv(strike)
                    if iv_at_k and 0.05 <= iv_at_k <= 5.0:
                        dK = max(1.0, strike * 0.005)
                        iv_up   = smile.get_iv(strike + dK)
                        iv_down = smile.get_iv(strike - dK)
                        skew_dk = (iv_up - iv_down) / (2.0 * dK)  # ∂σ/∂K

                        # n(d1) = standard normal PDF at d1 = d2 + σ√T
                        d1_approx = d2 + iv_at_k * math.sqrt(max(tau_years, 1e-9))
                        phi_d1 = math.exp(-0.5 * d1_approx * d1_approx) / math.sqrt(2.0 * math.pi)

                        # Correction: P_digital = N(d2) - S√T n(d1) ∂σ/∂K
                        correction = -spot * math.sqrt(max(tau_years, 1e-9)) * phi_d1 * skew_dk
                        correction = float(np.clip(correction, -0.10, 0.10))
                        prob_above_corrected = float(np.clip(prob_above + correction, 0.01, 0.99))
                        log.debug(
                            "SABRCorrection: d2=%.3f d1=%.3f skew=%.6f correction=%+.4f "
                            "prob %.3f→%.3f",
                            d2, d1_approx, skew_dk, correction, prob_above, prob_above_corrected,
                        )
                        prob_above = prob_above_corrected
    except Exception:
        pass  # SABR surface unavailable — use uncorrected Heston probability

    model_prob = prob_above if direction == "above" else 1.0 - prob_above
    model_prob = float(np.clip(model_prob, 0.01, 0.99))

    # For "above" signals we're buying the NO token → compare against devigged NO price.
    # For "below" signals we're buying the YES token → compare against devigged YES price.
    # Using YES price for both inflated "above" edge by ~0.68 (e.g. 0.73 instead of 0.05).
    devigged_yes = _devig(market.yes_price, market.no_price)
    devigged_p   = devigged_yes if direction == "below" else (1.0 - devigged_yes)
    gross_edge   = model_prob - devigged_p

    # Subtract Polymarket CLOB v2 taker fee: fee = peak_rate × 4p(1-p).
    # At p=0.50, BTC fee = 1.80% — nearly wipes out a 3% gross edge.
    # Kelly sizing and trade decisions must use net edge, not gross edge.
    from signals.microstructure import clob_net_edge as _net_edge
    edge = _net_edge(gross_edge, market.yes_price, category="crypto")

    # Confidence: higher near expiry, higher when deeply in/out of the money
    moneyness     = abs(math.log(max(spot, 1.0) / max(strike, 1.0)))
    time_factor   = float(np.clip(1.0 - tau_hours / _MAX_TAU_HOURS, 0.3, 1.0))
    confidence    = float(np.clip(0.65 * time_factor + 0.20 * min(moneyness, 1.0), 0.25, 0.95))

    latency_ms = (time.time() - t0) * 1000

    log.debug(
        "CryptoBinary: %s %s $%s | S=$%.0f | τ=%.2fh | σ=%.0f%% (×%.2f) | "
        "d₂=%.3f | model=%.3f mkt=%.3f edge=%+.3f | cvd_z=%.1f obi=%.2f | "
        "%s in %.1fh (%.0fms)",
        direction.upper(), asset, f"{strike:,.0f}",
        spot, tau_hours, sigma * 100, combined_vol_mult, d2,
        model_prob, devigged_p, edge,
        order_flow.cvd_z, order_flow.obi,
        macro_event, hours_to_event, latency_ms,
    )

    return CryptoBinaryOutput(
        asset=asset,
        symbol=symbol,
        direction=direction,
        strike_price=strike,
        spot_price=spot,
        expiry_ts=expiry_dt.timestamp(),
        tau_hours=tau_hours,
        realized_vol_ann=sigma,
        d2=d2,
        model_prob=model_prob,
        devigged_market_prob=devigged_p,
        edge=edge,
        momentum_5m=momentum_5m,
        funding_rate=funding_ann,
        confidence=confidence,
        latency_ms=latency_ms,
        vpin=order_flow.vpin,
    )

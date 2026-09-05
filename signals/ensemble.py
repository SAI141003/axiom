"""
Signal ensemble — combines Gemma 4, Kronos, MiroFish, and TimesFM outputs
into a single final Signal with calibrated p_model, edge, and direction.

Weighting scheme:
  Gemma only:               100%
  Gemma + Kronos agree:     Gemma 55%, Kronos 40%, +5% agreement bonus
  Gemma + Kronos disagree:  Gemma 65%, Kronos 35% (disagreement dampens)
  + MiroFish (if available): shifts combined estimate 20% toward MiroFish
  + TimesFM (if available):  shifts combined estimate 15% toward TimesFM

Edge calculation:
  side = "YES" if direction is BULLISH, else "NO"
  edge = p_model - p_market (for chosen side)
  Only valid when edge > cfg.edge_threshold

Position sizing (Robust Kelly — Eq 4):
  f* = edge / (1 − p_market)   (binary Kelly)
  f̂  = f* / (1 + λ · Var(f*))  (shrinks when signal estimates disagree)
  Var(f*) = Var(p_model) / (1 − p_market)²,  estimated from cross-signal spread
  λ = cfg.kelly_lambda (default 1.5)
  hard cap: min(size, cfg.max_bet_usd)
"""
from __future__ import annotations

import logging
import time
from typing import Optional

from core.config import cfg
from core.models import (
    ClassifierOutput, CryptoBinaryOutput, KronosOutput, Market, MarkovOutput,
    MarkovState, NewsEvent, Signal, SignalDirection, SportsOutput, TimesFMOutput,
)
from signals.heston_pricer import robust_kelly, estimate_var_p_model
from signals.market_regime import detect_regime, get_smoother, Regime
from signals.mirofish_client import MiroFishReport

log = logging.getLogger(__name__)



def _implied_probability_from_classification(
    classification: ClassifierOutput,
    market: Market,
) -> tuple[float, str]:
    """
    Convert classification direction + materiality to probability estimate.

    Returns (p_model, side).
    """
    mat = classification.materiality
    current_prob = market.yes_price

    if classification.direction == SignalDirection.BULLISH:
        # News pushes probability toward 1.0
        # At materiality=1.0: p_model = 1.0
        # At materiality=0.6: moderate push
        shift = mat * (1.0 - current_prob) * 0.8
        p_model = min(0.95, current_prob + shift)
        side = "YES"
    elif classification.direction == SignalDirection.BEARISH:
        # News pushes probability toward 0.0
        shift = mat * current_prob * 0.8
        p_model = max(0.05, current_prob - shift)
        side = "NO"
    else:
        return current_prob, "YES"

    return p_model, side


def _combine_with_kronos(
    haiku_p: float,
    haiku_direction: SignalDirection,
    kronos: KronosOutput,
) -> tuple[float, float]:
    """
    Combine Haiku probability estimate with Kronos forecast.
    Returns (combined_p, confidence_weight).
    """
    kronos_p = kronos.threshold_probability
    agreement = haiku_direction == kronos.direction

    if agreement:
        # Weighted: Haiku 55%, Kronos 40%, +5% convergence bonus
        combined = 0.55 * haiku_p + 0.40 * kronos_p
        # Convergence bonus: pull slightly toward the agreed direction
        if haiku_direction == SignalDirection.BULLISH:
            combined = min(0.95, combined + 0.05)
        else:
            combined = max(0.05, combined - 0.05)
        weight = 0.95
    else:
        # Disagreement: Haiku more trusted (news-aware), Kronos less
        combined = 0.65 * haiku_p + 0.35 * kronos_p
        weight = 0.75  # lower confidence on disagreement

    return combined, weight


def _incorporate_mirofish(
    combined_p: float,
    mirofish: MiroFishReport,
) -> float:
    """Blend MiroFish probability (20% weight) into the combined estimate."""
    return 0.80 * combined_p + 0.20 * mirofish.p_estimate


def _incorporate_timesfm(
    combined_p: float,
    timesfm: TimesFMOutput,
) -> float:
    """Blend TimesFM threshold probability (15% weight) into the combined estimate."""
    return 0.85 * combined_p + 0.15 * timesfm.threshold_probability


def _devig(yes_price: float, no_price: float) -> float:
    """Remove market-maker vig. Returns true probability for YES side."""
    total = yes_price + no_price
    if total <= 0:
        return yes_price
    return yes_price / total


def _incorporate_sports(
    combined_p: float,
    sports: SportsOutput,
) -> float:
    """Blend sports statistical model probability (15% weight) into the combined estimate."""
    return 0.85 * combined_p + 0.15 * sports.model_prob_a


def _incorporate_markov(
    combined_p: float,
    markov: MarkovOutput,
    side: str,
    direction: SignalDirection,
) -> float:
    """
    Blend Markov persistence into combined_p.

    If Markov state aligns with trade direction (UP→YES, DOWN→NO):
      pull combined_p toward 0.90 weighted by (persistence − 0.5) × 0.4
    If Markov state conflicts:
      pull combined_p toward 0.50 (uncertainty) by persistence × 0.25
    """
    state_aligns = (
        (markov.current_state == MarkovState.UP   and side == "YES") or
        (markov.current_state == MarkovState.DOWN  and side == "NO")
    )
    p = markov.persistence
    if state_aligns:
        weight = (p - 0.5) * 0.4  # max +0.20 at persistence=1.0
        return min(0.95, combined_p + weight * (0.90 - combined_p))
    else:
        return 0.75 * combined_p + 0.25 * 0.5  # fade toward 50/50


def _multi_factor_score(
    edge: float,
    markov: "MarkovOutput | None",
    vpin: float,
    regime_confidence: float,
    regime_aligns: bool,
) -> float:
    """
    Multi-Factor Strategy score in [0, 1].

    Factors (from images):
      Momentum  (30%): Markov persistence × direction alignment
      Value     (30%): edge relative to max expected edge
      Volatility(20%): inverse VPIN (low VPIN = safe entry)
      Trend     (20%): regime confidence × direction alignment

    Returns a multiplier applied to Kelly size.
    A score of 1.0 = full size; 0.5 = half size; < 0.3 = suppress.
    """
    # Factor 1: Momentum — Markov persistence aligned with direction
    if markov is not None:
        state_aligns = (
            (markov.current_state == MarkovState.UP   and edge > 0) or
            (markov.current_state == MarkovState.DOWN  and edge < 0)
        )
        momentum = markov.persistence if state_aligns else (1.0 - markov.persistence)
    else:
        momentum = 0.5  # no Markov data — neutral

    # Factor 2: Value — normalize edge to [0,1] range (edge 0.10 = max)
    value = min(1.0, abs(edge) / 0.10)

    # Factor 3: Volatility — inverse VPIN (0.0 VPIN = 1.0 score, 1.0 VPIN = 0.0 score)
    volatility = max(0.0, 1.0 - vpin)

    # Factor 4: Trend — Hurst regime confidence × direction alignment
    trend = regime_confidence if regime_aligns else (1.0 - regime_confidence * 0.5)

    score = (
        0.30 * momentum  +
        0.30 * value     +
        0.20 * volatility +
        0.20 * trend
    )
    return round(max(0.0, min(1.0, score)), 4)


def _incorporate_crypto_binary(
    combined_p: float,
    cb: CryptoBinaryOutput,
) -> float:
    """
    Blend crypto binary option model probability.
    Weight scales with confidence: 35 – 50%.
    At high confidence the binary option model IS the correct pricing model
    and should dominate the LLM/news-based estimate.
    """
    weight = float(min(0.50, cb.confidence * 0.55))
    return (1.0 - weight) * combined_p + weight * cb.model_prob


def build_signal(
    market: Market,
    news: Optional[NewsEvent],
    classification: ClassifierOutput,
    bankroll: float,
    kronos: Optional[KronosOutput] = None,
    mirofish: Optional[MiroFishReport] = None,
    timesfm: Optional[TimesFMOutput] = None,
    sports: Optional[SportsOutput] = None,
    crypto_binary: Optional[CryptoBinaryOutput] = None,
    markov: Optional[MarkovOutput] = None,
    consensus_count: int = 0,
    order_flow_vpin: float = 0.0,
) -> Optional[Signal]:
    """
    Build a final Signal from all available inputs.
    Returns None if no actionable edge found.
    """
    # Step 0: Logit-space price smoothing — use smoothed price, not raw tick
    smoother = get_smoother(market.condition_id, market.yes_price)
    smoother.update(market.yes_price)
    smoothed_yes = smoother.smoothed_prob
    # Shallow copy with smoothed price so downstream steps use denoised price
    market = market.model_copy(update={"yes_price": smoothed_yes, "no_price": 1.0 - smoothed_yes})

    # Step 1: Base probability from Claude Haiku
    if classification.direction == SignalDirection.NEUTRAL:
        return None

    if classification.materiality < cfg.materiality_threshold:
        return None

    haiku_p, side = _implied_probability_from_classification(classification, market)
    direction = classification.direction

    # Adverse selection guard: don't buy YES above 0.85 or NO below 0.15
    if side == "YES" and market.yes_price > 0.85:
        return None
    if side == "NO" and market.yes_price < 0.15:
        return None

    # Step 2: Combine with Kronos if available and asset-linked
    combined_p = haiku_p
    if kronos is not None:
        combined_p, _ = _combine_with_kronos(haiku_p, direction, kronos)

    # Step 3: Incorporate MiroFish if available
    if mirofish is not None:
        combined_p = _incorporate_mirofish(combined_p, mirofish)
        combined_p = max(0.05, min(0.95, combined_p))

    # Step 4: Incorporate TimesFM if available
    if timesfm is not None:
        combined_p = _incorporate_timesfm(combined_p, timesfm)
        combined_p = max(0.05, min(0.95, combined_p))

    # Step 5: Incorporate Sports signal if available (only for sports-category markets)
    if sports is not None and sports.confidence >= cfg.sports_min_confidence:
        combined_p = _incorporate_sports(combined_p, sports)
        combined_p = max(0.05, min(0.95, combined_p))

    # Step 5b: Incorporate Crypto Binary option signal (crypto markets only)
    # High-confidence binary option model overrides LLM-based estimate significantly
    if crypto_binary is not None:
        combined_p = _incorporate_crypto_binary(combined_p, crypto_binary)
        combined_p = max(0.05, min(0.95, combined_p))

    # Step 5c_pre: Markov State Transition (BTC priority path — PATH G)
    # Aligns combined_p with the observed 5-min trend persistence.
    # For non-BTC markets markov is None — no effect.
    if markov is not None:
        # Hard gate: if persistence < threshold and state conflicts, suppress entirely
        state_aligns = (
            (markov.current_state == MarkovState.UP   and side == "YES") or
            (markov.current_state == MarkovState.DOWN  and side == "NO")
        )
        if not state_aligns and markov.persistence >= cfg.markov_min_persistence:
            # Strong opposing Markov state — skip this signal
            log.debug(
                "Markov gate: state=%s conflicts with side=%s persist=%.3f",
                markov.current_state.value, side, markov.persistence,
            )
            return None
        combined_p = _incorporate_markov(combined_p, markov, side, direction)
        combined_p = max(0.05, min(0.95, combined_p))

    # Step 5c: Regime-based confidence adjustment (Hurst exponent)
    # Requires price history; skip if unavailable (first run).
    # TRENDING + matching direction → slight boost (momentum confirmation)
    # MEAN_REVERTING + price far from 0.5 → fade extreme, reduce confidence
    # Note: detect_regime is CPU-only, <1ms on 64 prices, safe in async context.
    if hasattr(market, "_price_history") and len(market._price_history) >= 16:  # type: ignore[union-attr]
        regime_out = detect_regime(market._price_history)  # type: ignore[union-attr]
        if regime_out.regime == Regime.TRENDING and regime_out.confidence > 0.4:
            if (direction == SignalDirection.BULLISH and regime_out.trend_direction > 0) or \
               (direction == SignalDirection.BEARISH and regime_out.trend_direction < 0):
                combined_p = min(0.95, combined_p * 1.05)   # 5% boost on trend confirmation
        elif regime_out.regime == Regime.MEAN_REVERTING and regime_out.confidence > 0.4:
            # Mean-reverting: pull combined_p toward 0.5 (fade extreme predictions)
            combined_p = 0.85 * combined_p + 0.15 * 0.5

    # Step 6a: Isotonic calibration — correct systematic over/underconfidence.
    # Only active once BrierTracker has fitted a model (≥30 resolved trades).
    # Calibrator maps raw p_model → historically-accurate probability.
    try:
        from compound.calibration import calibrator
        combined_p = calibrator.calibrate(combined_p, category=market.category)
    except Exception:
        pass  # calibrator not yet fitted — use raw estimate

    # Step 6b: Domain+horizon calibration correction (arXiv:2602.19520)
    # Corrects for systematic crowd bias: politics underconfident at long horizons,
    # weather overconfident within 48h, sports underconfident beyond 1 month.
    if cfg.calibration_enabled:
        try:
            from signals.calibration import calibrated_prob
            tau_h = 999.0
            if market.end_date:
                from datetime import datetime, timezone
                end_dt = datetime.fromisoformat(market.end_date.replace("Z", "+00:00"))
                tau_h = max(0.0, (end_dt - datetime.now(timezone.utc)).total_seconds() / 3600)
            combined_p = calibrated_prob(combined_p, market.category or "", tau_h)
            combined_p = max(0.05, min(0.95, combined_p))
        except Exception:
            pass

    # Step 6: Calculate edge against devigged market probability (removes vig).
    # combined_p is always expressed as the YES probability.
    # When side=="NO" we need to convert to the perspective of our bet:
    #   p_model_for_bet = P(our bet wins) = 1 - combined_p
    # p_market is always expressed as P(chosen side wins), so:
    #   p_market = devig(yes, no)  for YES bet
    #   p_market = devig(no, yes)  for NO  bet
    p_market        = _devig(market.yes_price, market.no_price) if side == "YES" else _devig(market.no_price, market.yes_price)
    p_model_for_bet = combined_p if side == "YES" else 1.0 - combined_p
    gross_edge      = p_model_for_bet - p_market

    # Subtract Polymarket CLOB v2 taker fee: fee = peak_rate × 4p(1−p).
    # Without this, Kelly overbets by 50%+ near p=0.50 on crypto markets.
    try:
        from signals.microstructure import clob_net_edge as _net_edge
        edge = _net_edge(gross_edge, market.yes_price, market.category or "other")
    except Exception:
        edge = gross_edge

    if edge < cfg.edge_threshold:
        return None

    # Step 7: Robust Kelly position sizing (Eq 4 — shrinks when signal estimates disagree)
    # Convert all p_estimates to the same "P(bet wins)" frame
    p_estimates = [haiku_p if side == "YES" else 1.0 - haiku_p]
    if kronos is not None:
        kp = kronos.threshold_probability
        p_estimates.append(kp if side == "YES" else 1.0 - kp)
    if mirofish is not None:
        mp = mirofish.p_estimate
        p_estimates.append(mp if side == "YES" else 1.0 - mp)
    if timesfm is not None:
        tp = timesfm.threshold_probability
        p_estimates.append(tp if side == "YES" else 1.0 - tp)
    if sports is not None:
        sp = sports.model_prob_a
        p_estimates.append(sp if side == "YES" else 1.0 - sp)
    if crypto_binary is not None:
        cb_p = crypto_binary.model_prob  # N(d₂) = P(price > strike) = P(YES wins)
        p_estimates.append(cb_p if side == "YES" else 1.0 - cb_p)

    var_p = estimate_var_p_model(p_estimates)
    size, kelly_fraction = robust_kelly(p_model_for_bet, p_market, bankroll, var_p)

    # BTC priority: higher max_bet when Markov confirms and market is BTC
    effective_max_bet = cfg.max_bet_usd
    if markov is not None and markov.signal_confirmed and market.category == "crypto":
        effective_max_bet = cfg.btc_max_bet_usd

    # Multi-Factor score: Momentum × Value × Volatility × Trend
    # Compute regime info for trend factor
    _regime_confidence = 0.5
    _regime_aligns = True
    if hasattr(market, "_price_history") and len(market._price_history) >= 16:  # type: ignore[union-attr]
        try:
            _ro = detect_regime(market._price_history)  # type: ignore[union-attr]
            _regime_confidence = _ro.confidence
            _regime_aligns = (
                (direction == SignalDirection.BULLISH and _ro.trend_direction > 0) or
                (direction == SignalDirection.BEARISH and _ro.trend_direction < 0)
            )
        except Exception:
            pass
    # Use real VPIN from order flow when available (supplied by signal_worker for crypto)
    _vpin = float(order_flow_vpin) if order_flow_vpin > 0.0 else 0.0
    mf_score = _multi_factor_score(edge, markov, _vpin, _regime_confidence, _regime_aligns)
    # Apply multi-factor multiplier (floor at 0.30 to avoid over-suppression)
    size = size * max(0.30, mf_score)

    # Consensus bonus: 3+ agreeing signals → allow slightly larger size
    if consensus_count >= 3:
        size = min(size * (1.0 + cfg.kelly_consensus_bonus), effective_max_bet)
    else:
        size = min(size, effective_max_bet)
    # Kronos disagreement penalty — cross-model conflict adds unmodelled risk
    if kronos is not None and kronos.direction != classification.direction:
        size *= 0.8

    if size < 1.0:
        return None

    reasoning_parts = [
        f"Gemma4: {classification.direction.value} (mat={classification.materiality:.2f})",
        f"edge={edge:.3f}",
        f"smoothed_p={smoothed_yes:.3f}",
        f"mf_score={mf_score:.3f}",
    ]
    if markov:
        reasoning_parts.append(
            f"Markov({markov.asset}): state={markov.current_state.value} "
            f"persist={markov.persistence:.3f} windows={markov.n_windows}"
        )
    if kronos:
        reasoning_parts.append(
            f"Kronos: {kronos.direction.value} ({kronos.asset} {kronos.predicted_price:.0f})"
        )
    if mirofish:
        reasoning_parts.append(f"MiroFish: p={mirofish.p_estimate:.2f}")
    if timesfm:
        reasoning_parts.append(
            f"TimesFM: {timesfm.direction.value} p={timesfm.threshold_probability:.2f} "
            f"[{timesfm.p10:.0f}-{timesfm.p90:.0f}]"
        )
    if sports:
        reasoning_parts.append(
            f"Sports({sports.sport}): {sports.model_used} p={sports.model_prob_a:.2f} "
            f"edge={sports.edge:+.3f} conf={sports.confidence:.2f}"
        )
    if crypto_binary:
        reasoning_parts.append(
            f"BinaryOpt({crypto_binary.asset} {crypto_binary.direction} "
            f"${crypto_binary.strike_price:,.0f}): S=${crypto_binary.spot_price:,.0f} "
            f"σ={crypto_binary.realized_vol_ann*100:.0f}% τ={crypto_binary.tau_hours:.1f}h "
            f"d₂={crypto_binary.d2:.2f} p={crypto_binary.model_prob:.3f}"
        )
    if consensus_count > 0:
        reasoning_parts.append(f"consensus={consensus_count}")

    return Signal(
        market=market,
        news=news,
        direction=direction,
        p_model=p_model_for_bet,   # P(our bet wins), same frame as p_market
        p_market=p_market,
        edge=edge,
        materiality=classification.materiality,
        approved_size=size,
        kelly_fraction=kelly_fraction,
        side=side,
        reasoning=" | ".join(reasoning_parts),
        classification=classification,
        kronos=kronos,
        consensus_count=consensus_count,
    )

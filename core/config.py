"""Central configuration — all settings loaded from environment variables."""
from __future__ import annotations

import os
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # NVIDIA NIM (primary LLM — Gemma 4 via NVIDIA's OpenAI-compatible endpoint)
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_model: str = "google/gemma-4-31b-it"

    # Anthropic (kept as fallback if nvidia_api_key is not set)
    anthropic_api_key: str = ""

    # Polymarket CLOB
    polymarket_host: str = "https://clob.polymarket.com"
    polymarket_api_key: str = ""
    polymarket_api_secret: str = ""
    polymarket_api_passphrase: str = ""
    polymarket_private_key: str = ""
    polymarket_funder: str = ""
    polymarket_signature_type: int = 1  # 0=EOA/MetaMask, 1=email/Magic proxy, 2=browser-wallet proxy
    polymarket_ws_host: str = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
    polymarket_gamma_api: str = "https://gamma-api.polymarket.com"

    # News
    twitter_bearer_token: str = ""
    telegram_bot_token: str = ""
    newsapi_key: str = ""
    worldmonitor_api_url: str = ""  # optional: WorldMonitor relay URL for direct API polling

    # AI-Trader
    ai_trader_api_key: str = ""
    ai_trader_base_url: str = "https://api.ai4trade.ai"

    # MiroFish — uses NVIDIA NIM by default (same key, OpenAI-compatible)
    mirofish_base_url: str = "http://localhost:5001"
    mirofish_llm_api_key: str = ""   # defaults to nvidia_api_key at runtime
    mirofish_llm_base_url: str = "https://integrate.api.nvidia.com/v1"
    mirofish_llm_model: str = "google/gemma-4-31b-it"
    zep_api_key: str = ""

    # Kronos
    hf_token: str = ""   # HuggingFace token — exported to env for weight downloads
    kronos_model: str = "NeoQuasar/Kronos-base"   # 102M (largest OPEN model) — was mini (4.1M)
    kronos_device: str = "cpu"

    # Infrastructure
    redis_url: str = "redis://localhost:6379/0"
    database_url: str = "postgresql://trading:trading@localhost:5432/polymarket_hft"

    # Trading
    dry_run: bool = True
    max_bet_usd: float = 25.0
    daily_loss_limit_usd: float = 150.0
    initial_bankroll: float = 1000.0
    edge_threshold: float = 0.04
    materiality_threshold: float = 0.6
    max_volume_usd: float = 500_000.0
    min_volume_usd: float = 1_000.0
    max_concurrent_positions: int = 15
    max_drawdown_pct: float = 0.08
    max_single_market_pct: float = 0.05
    signal_stale_ms: int = 5_000
    kelly_base: float = 0.25
    kelly_consensus_bonus: float = 0.10
    kelly_max: float = 0.35
    kelly_lambda: float = 1.5        # Eq 4 risk-aversion: shrinks size when estimates disagree
    cvar_breach_pct: float = 0.12    # CVaR check: halt if worst-5% mean loss > 12% of bankroll

    # Microstructure gates (Phase 3)
    # Per-category latency decay λ (edge half-life = ln2/λ seconds):
    #   crypto:    λ=0.35  → half-life ≈ 2s  (price moves in seconds)
    #   sports:    λ=0.05  → half-life ≈ 14s (in-game; pre-game even slower)
    #   politics:  λ=0.003 → half-life ≈ 4min (fundamental, not tick-driven)
    #   other:     λ=0.15  → half-life ≈ 4.6s (default, conservative)
    latency_decay_lambda: float = 0.15           # fallback default
    latency_decay_lambda_crypto: float = 0.35
    latency_decay_lambda_sports: float = 0.05
    latency_decay_lambda_politics: float = 0.003
    latency_decay_lambda_ai: float = 0.02        # AI/tech news: slower than crypto
    latency_decay_lambda_science: float = 0.005  # science/climate: very slow
    obi_gate_threshold: float = 0.10     # |OBI| minimum to apply gate (below = inconclusive)
    obi_depth: int = 5                   # number of orderbook levels for OBI calculation
    vpin_adverse_threshold: float = 0.70 # VPIN above this → adverse selection risk, skip
    ev_fee_rate: float = 0.01            # taker fee used in EV filter

    # Models — classification uses NVIDIA NIM (Gemma 4) when nvidia_api_key is set,
    # falls back to Anthropic Haiku otherwise
    classification_model: str = "google/gemma-4-31b-it"
    scoring_model: str = "google/gemma-4-31b-it"

    # Observability
    prometheus_port: int = 9090
    log_level: str = "INFO"

    # Feature flags
    use_kronos: bool = True
    use_mirofish: bool = True
    use_timesfm: bool = True
    use_ai_trader_consensus: bool = True
    use_sports: bool = True
    use_markov: bool = True          # Markov State Transition (BTC priority path)
    nightly_review_enabled: bool = True  # Self-learning nightly loop

    # BTC priority trading
    btc_max_bet_usd: float = 50.0    # BTC gets 2× the normal max_bet_usd
    btc_min_persistence: float = 0.87 # Only trade BTC when Markov persistence ≥ 0.87

    # Markov State Transition (PATH G — BTC 5-min)
    markov_min_persistence: float = 0.87   # enter only when P(state→state) ≥ 0.87
    markov_lookback_n: int = 300            # price tick buffer size (≈25 hours at 5-min ticks)
    markov_min_history: int = 50            # min ticks before computing matrix
    markov_window_s: int = 300              # 5-minute bucket size

    # Nightly self-learning review
    nightly_review_hour: int = 2    # 2am local time
    nightly_review_lookback_days: int = 7
    nightly_review_min_trades: int = 20    # skip if fewer resolved trades

    # Monte Carlo simulation
    monte_carlo_n_sims: int = 10_000
    monte_carlo_ruin_threshold: float = 0.20   # ruin if bankroll < 20% of start

    # Market tracking
    tracked_categories: list[str] = ["ai", "crypto", "politics", "science", "technology", "sports"]
    news_lookback_hours: int = 6
    market_refresh_interval_s: int = 300
    ws_markets_per_connection: int = 20

    # NegRisk Dutch Book Scanner (Strategy 2 from research — $29M/year opportunity)
    negrisk_scan_interval: float = 5.0       # scan every 5s (avg window = 2.7s)
    negrisk_min_edge: float = 0.02           # 2% minimum edge after fees
    negrisk_min_liquidity: float = 2_000.0   # USD per side minimum

    # Polymarket CLOB v2 fee curve (April 2026): fee = peak_rate × 4p(1-p)
    # Fee-free categories: geopolitical, world events
    clob_fee_peak_crypto: float  = 0.018   # 1.80% peak at p=0.50
    clob_fee_peak_sports: float  = 0.018
    clob_fee_peak_politics: float = 0.010  # 1.00% peak
    clob_fee_peak_finance: float  = 0.010
    clob_fee_peak_other: float    = 0.010
    clob_maker_rebate_share: float = 0.50  # 50% of taker fees redistributed to makers

    # Deribit IV surface → Polymarket comparison (Strategy 4 — episodic 5-15% edge)
    deribit_ws_url: str = "wss://www.deribit.com/ws/api/v2"
    deribit_scan_interval: float = 30.0
    deribit_min_edge: float = 0.03          # 3% after fees to trigger
    use_deribit: bool = True

    # Smart Money Detection (73% accuracy on depth spikes)
    smart_money_scan_interval: float = 5.0
    smart_money_signal_threshold: float = 65.0   # 0-100 score; ≥65 = actionable
    smart_money_baseline_periods: int = 12        # rolling baseline window
    smart_money_depth_z_threshold: float = 5.0    # z-score to trigger alert

    # Market Maker (Avellaneda-Stoikov adapted for binary markets)
    market_maker_enabled: bool = False      # off by default; enable when ready
    mm_gamma: float = 0.20                  # risk aversion (inventory penalty)
    mm_sigma_b: float = 0.05               # short-horizon belief vol estimate
    mm_k: float = 1.50                     # order arrival rate parameter
    mm_min_spread: float = 0.015           # minimum quoted spread (1.5 cents)
    mm_max_inventory: float = 500.0        # max net YES position in USD
    mm_min_rebate_lifetime_s: float = 3.5  # orders must live ≥3.5s for rebate

    # Calibration correction (arXiv:2602.19520 — domain+horizon slopes)
    calibration_enabled: bool = True
    calibration_min_edge: float = 0.03          # minimum calibration gap to act on

    # Longshot NO bias scanner (jbecker.dev / Stanford — 64pp EV gap at extremes)
    longshot_yes_max: float = 0.20              # only scan YES prices below this
    longshot_min_edge: float = 0.015            # min net edge after fees
    longshot_min_tau_hours: float = 24.0        # skip markets resolving in <24h
    longshot_scan_interval: float = 10.0

    # Oracle lag arbitrage — Chainlink 5/15-min crypto markets
    oracle_lag_window_s: float = 45.0           # enter when secs_remaining ≤ 45
    oracle_lag_execution_cutoff_s: float = 10.0 # never enter with <10s left
    oracle_lag_min_move: float = 0.0025         # 0.25% spot move to trigger
    oracle_lag_min_edge: float = 0.04
    oracle_lag_scan_interval: float = 2.0       # scan every 2s (end-of-window precision)

    # UMA dispute front-running (89.6% accuracy post-filing)
    uma_dispute_scan_interval: float = 15.0
    uma_min_confidence: float = 0.70            # min Claude confidence to trade

    # Mean-reversion on price overreaction (18-33% CAR documented)
    mr_lookback_n: int = 20                     # rolling window in observations
    mr_z_threshold: float = 1.8                 # Z-score below mean to trigger
    mr_min_vol: float = 0.008                   # min std dev (skip flat markets)
    mr_min_edge: float = 0.02                   # min expected recovery
    mr_scan_interval: float = 30.0

    # Wash trading filter (Columbia SSRN — 25% of Polymarket volume is wash)
    wash_vol_oi_threshold: float = 8.0          # vol/OI ratio above this = suspicious
    wash_max_score: float = 55.0                # score ≥ this → flag as wash

    # Quant calibration workers (QuantCalibrationWorker)
    use_cvxpy: bool = True                   # CVXPY portfolio optimization every 30s
    use_diffrax: bool = True                 # JAX/Diffrax Heston calibration every 60s
    use_numpyro: bool = True                 # NumPyro SVI Bayesian vol posterior every 5min
    use_sabr: bool = True                    # SABR smile calibration with Deribit surface
    cvxpy_solve_interval_s: float = 30.0     # portfolio optimization refresh interval
    diffrax_recal_interval_s: float = 60.0   # Heston gradient calibration interval
    numpyro_recal_interval_s: float = 300.0  # SVI posterior update (2088ms/50 steps → bg only)

    # Paper trading performance reporting
    paper_report_interval_s: float = 60.0   # print live P&L report every 60s

    # Tick Reactor — sub-10ms hot-path (velocity-based instant trading)
    tick_reactor_enabled: bool = True
    tick_reactor_velocity_threshold: float = 0.003   # 0.3%/s → 3% per 10s = fast-moving market
    tick_reactor_forecast_horizon_s: float = 3.0     # seconds of price move to forecast
    tick_reactor_min_edge: float = 0.04              # minimum raw edge before gate check
    tick_reactor_kelly_scale: float = 0.40           # 40% of normal Kelly (no LLM confirmation)

    # Position Guard — adverse velocity exit
    position_guard_enabled: bool = True
    position_guard_adverse_velocity: float = 0.004   # 0.4%/s → exit on crash (1 tick above reactor threshold)
    position_guard_min_age_s: float = 30.0           # minimum position age before guard can trigger

    # Sports signal (PATH E) — all public, no auth required
    club_elo_api: str = "http://api.clubelo.com"
    sackmann_atp_base: str = "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master"
    sackmann_wta_base: str = "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master"
    sports_cache_ttl_s: int = 86_400            # 24 h Redis cache for fetched stats
    sports_timeout_s: float = 8.0               # per-fetch HTTP timeout
    sports_min_confidence: float = 0.45         # discard sports signals below this confidence
    sports_ensemble_weight: float = 0.15        # fraction blended into combined_p

    # ignore env vars this model doesn't declare (e.g. BOT_*_ENABLED, which
    # bot_switch.py reads directly) — otherwise pydantic forbids them and any
    # daemon that loads config crashes on startup.
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8",
                    "extra": "ignore"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


# Module-level singleton
cfg = get_settings()

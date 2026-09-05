"""Shared Pydantic models used across all layers."""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, computed_field


# ── Enums ─────────────────────────────────────────────────────────────────────

class OrderStatus(str, Enum):
    PENDING = "pending"
    SUBMITTED = "submitted"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"
    ERROR = "error"
    STALE = "stale"
    PRICE_MOVED = "price_moved"
    DRY_RUN = "dry_run"


class SignalDirection(str, Enum):
    BULLISH = "bullish"
    BEARISH = "bearish"
    NEUTRAL = "neutral"


class RiskRejectReason(str, Enum):
    EDGE_TOO_SMALL = "edge_too_small"
    DAILY_LOSS_LIMIT = "daily_loss_limit"
    MAX_DRAWDOWN = "max_drawdown"
    MARKET_CONCENTRATION = "market_concentration"
    MAX_CONCURRENT = "max_concurrent"
    STALE_SIGNAL = "stale_signal"
    KILL_SWITCH = "kill_switch"
    VaR_BREACH = "var_breach"


# ── Market ────────────────────────────────────────────────────────────────────

class Market(BaseModel):
    condition_id: str
    question: str
    category: str = "other"
    yes_price: float = 0.5
    no_price: float = 0.5
    volume: float = 0.0
    end_date: Optional[str] = None
    active: bool = True
    tokens: list[dict] = Field(default_factory=list)
    linked_asset: Optional[str] = None  # e.g. "BTC", "ETH" for Kronos

    @computed_field
    @property
    def implied_probability(self) -> float:
        return self.yes_price

    @computed_field
    @property
    def spread(self) -> float:
        return self.yes_price - self.no_price


# ── News ──────────────────────────────────────────────────────────────────────

class NewsEvent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    headline: str
    source: str
    published_at: float = Field(default_factory=time.time)
    received_at: float = Field(default_factory=time.time)
    url: str = ""
    content: str = ""

    @computed_field
    @property
    def latency_ms(self) -> float:
        return (self.received_at - self.published_at) * 1000

    @computed_field
    @property
    def age_ms(self) -> float:
        return (time.time() - self.received_at) * 1000


# ── Classification ────────────────────────────────────────────────────────────

class ClassifierOutput(BaseModel):
    direction: SignalDirection
    materiality: float = Field(ge=0.0, le=1.0)
    reasoning: str
    latency_ms: float = 0.0
    model_used: str = ""


# ── TimesFM Forecast ──────────────────────────────────────────────────────────

class TimesFMOutput(BaseModel):
    asset: str
    current_price: float
    predicted_price: float               # median (p50) of quantile distribution
    forecast_horizon_steps: int          # number of steps ahead
    threshold_probability: float = Field(ge=0.0, le=1.0)  # P(price > threshold)
    direction: "SignalDirection"
    confidence: float = Field(ge=0.0, le=1.0)  # width of quantile band (inverted)
    p10: float = 0.0                     # 10th percentile price forecast
    p90: float = 0.0                     # 90th percentile price forecast
    latency_ms: float = 0.0


# ── Crypto Binary Option Forecast ────────────────────────────────────────────

class CryptoBinaryOutput(BaseModel):
    asset: str                                            # "BTC", "ETH"
    symbol: str                                           # "BTCUSDT"
    direction: str                                        # "above" | "below"
    strike_price: float                                   # parsed $K from question
    spot_price: float                                     # real-time Binance price
    expiry_ts: float                                      # Unix timestamp of market expiry
    tau_hours: float                                      # hours to expiry
    realized_vol_ann: float                               # annualized σ (e.g. 0.68 = 68%)
    d2: float                                             # Black-Scholes d₂ value
    model_prob: float = Field(ge=0.0, le=1.0)             # N(d₂) — P(YES resolves)
    devigged_market_prob: float = Field(ge=0.0, le=1.0)   # Polymarket devigged price
    edge: float                                           # model_prob − devigged_market_prob
    momentum_5m: float = 0.0                              # last 5-min return
    funding_rate: float = 0.0                             # Binance perp funding (annualized)
    confidence: float = Field(ge=0.0, le=1.0)
    latency_ms: float = 0.0
    vpin: float = 0.0                                     # VPIN toxicity [0,1]; >0.70 = adverse selection


# ── Sports Forecast ───────────────────────────────────────────────────────────

class SportsOutput(BaseModel):
    sport: str                                          # "soccer"|"tennis"|"ufc"|"cricket"|"basketball"|"unknown"
    team_a: str                                         # first entity extracted from question
    team_b: str = ""                                    # second entity (empty for tournament questions)
    model_prob_a: float = Field(ge=0.0, le=1.0)         # P(team_a wins / outcome A) from statistical model
    devigged_market_prob: float = Field(ge=0.0, le=1.0) # Polymarket price with vig removed
    edge: float                                         # model_prob_a − devigged_market_prob
    model_used: str = ""                                # "dixon_coles_elo"|"surface_elo"|"ufc_stats"|"elo_fallback"
    confidence: float = Field(ge=0.0, le=1.0)          # reliability estimate (data freshness + sample size)
    data_freshness_h: float = 0.0                       # hours since underlying stats were last updated
    home_team: str = ""                                 # home team if known (affects Dixon-Coles lambda)
    tournament: str = ""                                # tournament name if detected in question
    latency_ms: float = 0.0


# ── Markov State Transition ───────────────────────────────────────────────────

class MarkovState(str, Enum):
    UP   = "up"
    DOWN = "down"


class MarkovOutput(BaseModel):
    asset: str
    current_state: MarkovState
    persistence: float = Field(ge=0.0, le=1.0)   # P(state → state)
    transition_matrix: dict                        # {"up": {"up": p, "down": 1-p}, ...}
    n_windows: int
    signal_confirmed: bool                         # persistence >= cfg.markov_min_persistence
    latency_ms: float = 0.0


# ── Kronos Forecast ───────────────────────────────────────────────────────────

class KronosOutput(BaseModel):
    asset: str
    current_price: float
    predicted_price: float
    forecast_horizon_minutes: int
    confidence: float = Field(ge=0.0, le=1.0)
    direction: SignalDirection
    threshold_probability: float = Field(ge=0.0, le=1.0)
    latency_ms: float = 0.0
    # ensemble stats from N stochastic runs (the model's REAL uncertainty —
    # the old single-run confidence was always 0.95-1.0 and meant nothing)
    agreement: Optional[float] = None      # fraction of runs agreeing on direction
    pred_vol_bp: Optional[float] = None    # cross-run dispersion of the forecast


# ── Signal ────────────────────────────────────────────────────────────────────

class Signal(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    market: Market
    news: Optional[NewsEvent] = None
    direction: SignalDirection
    p_model: float = Field(ge=0.0, le=1.0)
    p_market: float = Field(ge=0.0, le=1.0)
    edge: float
    materiality: float = 0.0
    approved_size: float = 0.0
    kelly_fraction: float = 0.0
    side: str = "YES"
    reasoning: str = ""
    classification: Optional[ClassifierOutput] = None
    kronos: Optional[KronosOutput] = None
    consensus_count: int = 0
    created_at_ms: float = Field(default_factory=lambda: time.time() * 1000)

    @computed_field
    @property
    def age_ms(self) -> float:
        return time.time() * 1000 - self.created_at_ms

    @computed_field
    @property
    def target_price(self) -> float:
        return self.market.yes_price if self.side == "YES" else self.market.no_price

    @computed_field
    @property
    def token_id(self) -> str:
        for t in self.market.tokens:
            outcome = t.get("outcome", "").upper()
            if outcome == self.side:
                return t.get("token_id", "")
        return ""


# ── Order ─────────────────────────────────────────────────────────────────────

class Order(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    signal_id: str
    market_id: str
    token_id: str
    side: str
    size: float
    price: float
    status: OrderStatus = OrderStatus.PENDING
    order_id: Optional[str] = None  # exchange-assigned ID
    fill_price: Optional[float] = None
    filled_size: float = 0.0
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    filled_at: Optional[datetime] = None
    error_msg: str = ""


# ── Execution Result ──────────────────────────────────────────────────────────

class ExecutionResult(BaseModel):
    order: Order
    status: OrderStatus
    message: str = ""


# ── Risk Decision ─────────────────────────────────────────────────────────────

class RiskDecision(BaseModel):
    approved: bool
    reason: Optional[RiskRejectReason] = None
    approved_size: float = 0.0
    kelly_fraction: float = 0.0
    message: str = ""


# ── Position ──────────────────────────────────────────────────────────────────

class Position(BaseModel):
    market_id: str
    market_question: str
    token_id: str
    side: str
    size: float
    avg_price: float
    current_price: float
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0
    opened_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    signal_id: str = ""

    @computed_field
    @property
    def unrealized_pnl_computed(self) -> float:
        return self.size * (self.current_price - self.avg_price)


# ── Orderbook Snapshot ────────────────────────────────────────────────────────

class OrderbookLevel(BaseModel):
    price: float
    size: float


class Orderbook(BaseModel):
    market_id: str
    token_id: str
    bids: list[OrderbookLevel] = Field(default_factory=list)
    asks: list[OrderbookLevel] = Field(default_factory=list)
    last_update: float = Field(default_factory=time.time)
    snapshot_confirmed: bool = False

    @computed_field
    @property
    def best_bid(self) -> float:
        return self.bids[0].price if self.bids else 0.0

    @computed_field
    @property
    def best_ask(self) -> float:
        return self.asks[0].price if self.asks else 1.0

    @computed_field
    @property
    def mid_price(self) -> float:
        return (self.best_bid + self.best_ask) / 2

    @computed_field
    @property
    def spread(self) -> float:
        return self.best_ask - self.best_bid

    @computed_field
    @property
    def is_stale(self) -> bool:
        return (time.time() - self.last_update) > 2.0

    @computed_field
    @property
    def age_ms(self) -> float:
        return (time.time() - self.last_update) * 1000


# ── System Health ─────────────────────────────────────────────────────────────

class WorkerHealth(BaseModel):
    name: str
    status: str = "unknown"
    last_heartbeat: float = Field(default_factory=time.time)
    events_processed: int = 0
    errors: int = 0

    @computed_field
    @property
    def is_healthy(self) -> bool:
        return (time.time() - self.last_heartbeat) < 30.0

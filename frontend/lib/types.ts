export interface Market {
  condition_id: string;
  question: string;
  category: "ai" | "crypto" | "politics" | "science" | "technology" | "sports" | "other";
  yes_price: number;
  no_price: number;
  volume: number;
  active: boolean;
  linked_asset?: string;
  change_24h?: number;
  end_date?: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
}

export interface OrderBook {
  market_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  mid_price: number;
  spread: number;
  timestamp: number;
}

export interface PricePoint {
  ts: number;
  yes_price: number;
  no_price: number;
  volume?: number;
}

export interface Signal {
  id: string;
  market_id: string;
  market_question: string;
  side: "YES" | "NO";
  edge: number;
  p_model: number;
  p_market: number;
  approved_size: number;
  kelly_fraction: number;
  consensus_count: number;
  source: "fast" | "consensus";
  ts: number;
}

export interface Position {
  market_id: string;
  market_question: string;
  token_id: string;
  side: "YES" | "NO";
  size: number;
  avg_price: number;
  current_price: number;
  unrealized_pnl: number;
  opened_at: number;
}

export type OrderStatus = "PENDING" | "SUBMITTED" | "FILLED" | "REJECTED" | "CANCELLED" | "DRY_RUN" | "STALE" | "ERROR";

export interface Order {
  order_id: string;
  market_id: string;
  market_question: string;
  side: "YES" | "NO";
  size: number;
  price: number;
  status: OrderStatus;
  fill_price?: number;
  filled_size?: number;
  source?: string;
  ts: number;
}

export interface RiskState {
  bankroll: number;
  peak_bankroll: number;
  daily_loss: number;
  daily_loss_limit: number;
  drawdown_pct: number;
  max_drawdown_pct: number;
  open_positions: number;
  total_exposure: number;
  kill_switch_active: boolean;
}

export interface WorkerHealth {
  ingestion: number;
  signal: number;
  execution: number;
  risk: number;
}

export interface LogEntry {
  id: string;
  level: "INFO" | "WARNING" | "ERROR" | "CRITICAL" | "DEBUG";
  message: string;
  ts: number;
}

export interface SystemStats {
  ws_connected: boolean;
  ws_latency_ms: number;
  api_cost_usd: number;
  api_calls: number;
  signals_generated: number;
  orders_submitted: number;
  orders_dry_run: number;
  orders_rejected: number;
  brier_score?: number;
  uptime_s: number;
}

export interface ArbOpportunity {
  id: string;
  strategy: "threshold_cascade" | "complement" | "resolution_proximity" | "crypto_binary" | "kalshi_cross";
  market_a_id: string;
  market_a_question: string;
  market_a_side: "YES" | "NO";
  market_a_price: number;      // devigged market prob for crypto_binary
  market_b_id: string;
  market_b_question: string;
  market_b_side: "YES" | "NO";
  market_b_price: number;
  edge: number;
  confidence: number;
  reason: string;
  action: string;
  ts: number;
  // Binary option fields — populated for crypto_binary strategy
  spot_price?: number;
  strike_price?: number;
  tau_hours?: number;
  realized_vol?: number;
  model_prob?: number;
}

export type WSMessageType =
  | "market_update"
  | "markets_snapshot"
  | "orderbook_update"
  | "price_history"
  | "signal"
  | "order_submitted"
  | "order_filled"
  | "order_cancelled"
  | "position_update"
  | "positions_update"
  | "risk_update"
  | "heartbeat"
  | "stats_update"
  | "log"
  | "kill_switch"
  | "subscribed"
  | "arb_opportunity"
  | "pong";

export interface WSMessage {
  type: WSMessageType;
  [key: string]: unknown;
}

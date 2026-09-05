import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  Market, OrderBook, PricePoint, Signal, Position, Order,
  RiskState, WorkerHealth, LogEntry, SystemStats, ArbOpportunity,
} from "./types";

// No hardcoded markets — populated at runtime from Gamma API.

function generateMockHistory(basePrice: number, n = 60): PricePoint[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const t = now - (n - i) * 60_000;
    const noise = (Math.random() - 0.5) * 0.04;
    const trend = Math.sin(i / 10) * 0.02;
    const price = Math.max(0.02, Math.min(0.98, basePrice + noise + trend));
    return { ts: t, yes_price: price, no_price: 1 - price, volume: Math.random() * 50000 + 5000 };
  });
}

function generateMockOrderBook(midPrice: number): OrderBook {
  const spread = 0.02 + Math.random() * 0.01;
  const asks: OrderBook["bids"] = Array.from({ length: 8 }, (_, i) => ({
    price: midPrice + (i + 1) * 0.005 + spread / 2,
    size: Math.random() * 5000 + 500,
    total: 0,
  })).sort((a, b) => a.price - b.price);
  const bids: OrderBook["bids"] = Array.from({ length: 8 }, (_, i) => ({
    price: midPrice - (i + 1) * 0.005 - spread / 2,
    size: Math.random() * 5000 + 500,
    total: 0,
  })).sort((a, b) => b.price - a.price);

  let askTotal = 0;
  asks.forEach(a => { askTotal += a.size; a.total = askTotal; });
  let bidTotal = 0;
  bids.forEach(b => { bidTotal += b.size; b.total = bidTotal; });

  return { market_id: "mock", bids, asks, mid_price: midPrice, spread, timestamp: Date.now() };
}

interface TradingStore {
  // Market state
  markets: Market[];
  selectedMarket: Market | null;
  watchlist: Set<string>;

  // Order book & chart
  orderbook: OrderBook | null;
  priceHistory: PricePoint[];

  // Activity feeds
  signals: Signal[];
  orders: Order[];
  positions: Position[];

  // Risk
  risk: RiskState;

  // Arbitrage
  arbOpportunities: ArbOpportunity[];

  // System
  workerHealth: WorkerHealth;
  logs: LogEntry[];
  stats: SystemStats;

  // Actions
  setMarkets: (markets: Market[]) => void;
  updateMarket: (update: Partial<Market> & { condition_id: string }) => void;
  selectMarket: (market: Market) => void;
  toggleWatchlist: (id: string) => void;
  setOrderBook: (ob: OrderBook) => void;
  appendPricePoint: (pt: PricePoint) => void;
  setPriceHistory: (history: PricePoint[]) => void;
  addSignal: (signal: Signal) => void;
  addOrder: (order: Order) => void;
  updateOrder: (orderId: string, update: Partial<Order>) => void;
  setPositions: (positions: Position[]) => void;
  updatePosition: (marketId: string, update: Partial<Position>) => void;
  addArbOpportunity: (opp: ArbOpportunity) => void;
  setRisk: (risk: Partial<RiskState>) => void;
  setWorkerHealth: (health: Partial<WorkerHealth>) => void;
  addLog: (log: Omit<LogEntry, "id">) => void;
  setStats: (stats: Partial<SystemStats>) => void;
  activateKillSwitch: () => void;
  deactivateKillSwitch: () => void;
}

export const useTradingStore = create<TradingStore>()(
  subscribeWithSelector((set, get) => ({
    markets: [],
    selectedMarket: null,
    watchlist: new Set<string>(),

    orderbook: null,
    priceHistory: [],

    signals:  [],
    orders:   [],
    positions:[],

    arbOpportunities: [],

    risk: {
      bankroll: 1000.0,
      peak_bankroll: 1000.0,
      daily_loss: 0,
      daily_loss_limit: 150.0,
      drawdown_pct: 0,
      max_drawdown_pct: 0.08,
      open_positions: 0,
      total_exposure: 0,
      kill_switch_active: false,
    },

    workerHealth: { ingestion: 0, signal: 0, execution: 0, risk: 0 },

    logs: [],

    stats: {
      ws_connected: false,
      ws_latency_ms: 0,
      api_cost_usd: 0,
      api_calls: 0,
      signals_generated: 0,
      orders_submitted: 0,
      orders_dry_run: 0,
      orders_rejected: 0,
      brier_score: undefined,
      uptime_s: 0,
    },

    // ── Actions ───────────────────────────────────────────────────────────────

    setMarkets: (markets) => set({ markets }),

    updateMarket: (update) => set((state) => ({
      markets: state.markets.map((m) =>
        m.condition_id === update.condition_id ? { ...m, ...update } : m
      ),
      selectedMarket:
        state.selectedMarket?.condition_id === update.condition_id
          ? { ...state.selectedMarket, ...update }
          : state.selectedMarket,
    })),

    selectMarket: (market) => set((state) => ({
      selectedMarket: market,
      orderbook: state.orderbook ?? generateMockOrderBook(market.yes_price),
      priceHistory: state.priceHistory.length ? state.priceHistory : generateMockHistory(market.yes_price),
    })),

    toggleWatchlist: (id) => set((state) => {
      const wl = new Set(state.watchlist);
      wl.has(id) ? wl.delete(id) : wl.add(id);
      return { watchlist: wl };
    }),

    setOrderBook: (ob) => set({ orderbook: ob }),

    appendPricePoint: (pt) => set((state) => ({
      priceHistory: [...state.priceHistory.slice(-299), pt],
    })),

    setPriceHistory: (priceHistory) => set({ priceHistory }),

    addSignal: (signal) => set((state) => ({
      signals: [signal, ...state.signals].slice(0, 50),
    })),

    addOrder: (order) => set((state) => ({
      orders: [order, ...state.orders].slice(0, 100),
    })),

    updateOrder: (orderId, update) => set((state) => ({
      orders: state.orders.map((o) => o.order_id === orderId ? { ...o, ...update } : o),
    })),

    setPositions: (positions) => set({ positions }),

    addArbOpportunity: (opp) => set((state) => ({
      arbOpportunities: [opp, ...state.arbOpportunities.filter(o => o.id !== opp.id)].slice(0, 50),
    })),

    updatePosition: (marketId, update) => set((state) => ({
      positions: state.positions.map((p) =>
        p.market_id === marketId ? { ...p, ...update } : p
      ),
    })),

    setRisk: (risk) => set((state) => ({ risk: { ...state.risk, ...risk } })),

    setWorkerHealth: (health) => set((state) => ({
      workerHealth: { ...state.workerHealth, ...health },
    })),

    addLog: (log) => set((state) => ({
      logs: [{ ...log, id: `log-${Date.now()}-${Math.random()}` }, ...state.logs].slice(0, 200),
    })),

    setStats: (stats) => set((state) => ({ stats: { ...state.stats, ...stats } })),

    // F8 now drives the REAL bot kill switch (Redis system:kill) via /api/kill;
    // local state updates optimistically, backend confirms via WS system.kill.
    activateKillSwitch: () => {
      set((state) => ({ risk: { ...state.risk, kill_switch_active: true } }));
      fetch("/api/kill", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: true, reason: "terminal F8" }),
      }).catch(() => {});
    },

    deactivateKillSwitch: () => {
      set((state) => ({ risk: { ...state.risk, kill_switch_active: false } }));
      fetch("/api/kill", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      }).catch(() => {});
    },
  }))
);

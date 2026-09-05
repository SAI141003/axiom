/**
 * Simulates live market data when the WebSocket backend is not reachable.
 * Called by Dashboard after a 1-second grace period if WS stays offline.
 * Keeps all store state live: prices, signals, orders, positions, risk, workers.
 */
import { useTradingStore } from "./store";
import type { ArbOpportunity, Order } from "./types";

const TICK_MS   = 1_400;
const SIGNAL_MS = 7_000;
const WORKER_MS = 4_000;
const STATS_MS  = 2_000;
const RISK_MS   = 8_000;
const ARB_MS    = 18_000;

// Live spot prices — seeded from Binance on startup, then drifted by mock ticks
export const LIVE_SPOT: Record<string, number> = { BTC: 95_400, ETH: 3_280, SOL: 168 };
const MOCK_SIGMA: Record<string, number> = { BTC: 0.68, ETH: 0.82, SOL: 1.10 };

/** Call once after fetchBinancePrices() resolves to ground the mock in real spot prices. */
export function seedSpotPrices(prices: Record<string, number>): void {
  Object.assign(LIVE_SPOT, prices);
}
// Simulated N(d2) — good enough for mock UI
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
function binaryCallProb(S: number, K: number, sigma: number, tauHours: number): number {
  const tau = tauHours / 8760;
  if (tau <= 0 || sigma <= 0) return S > K ? 0.9 : 0.1;
  const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * tau) / (sigma * Math.sqrt(tau));
  return Math.max(0.02, Math.min(0.98, normCdf(d2)));
}

const LOG_POOL = [
  "SignalWorker: new signal edge=+{E}% for {M}",
  "IngestionWorker: orderbook depth updated — spread {S}¢",
  "SignalWorker: Gemma4 classify in {L}ms",
  "RiskWorker: VaR check passed — exposure {X}%",
  "ExecutionWorker: DRY_RUN order skipped — kill switch",
  "TimesFM: forecast p50={P} threshold_prob={T}",
  "BrierTracker: rolling BS=0.{B} (healthy)",
  "IngestionWorker: {N} markets active, 3 WS conns",
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(lo: number, hi: number) { return lo + Math.random() * (hi - lo); }
function fmt2(n: number) { return n.toFixed(2); }

const handles: ReturnType<typeof setInterval>[] = [];

export function startMockFeed(): void {
  const store = () => useTradingStore.getState();

  // ── Price ticks ────────────────────────────────────────────────────────────
  handles.push(setInterval(() => {
    const { markets, updateMarket, appendPricePoint, selectedMarket, setOrderBook } = store();

    markets.forEach(m => {
      const chg = (Math.random() - 0.5) * 0.014;
      const yes = Math.max(0.04, Math.min(0.96, m.yes_price + chg));
      updateMarket({ condition_id: m.condition_id, yes_price: yes, no_price: 1 - yes, change_24h: (m.change_24h ?? 0) + (Math.random() - 0.5) * 0.002 });
    });

    if (selectedMarket) {
      const yes = Math.max(0.04, Math.min(0.96, selectedMarket.yes_price + (Math.random() - 0.5) * 0.008));
      appendPricePoint({ ts: Date.now(), yes_price: yes, no_price: 1 - yes, volume: rand(2_000, 25_000) });

      // Refresh order book around new mid price
      const spread = 0.018 + Math.random() * 0.01;
      const bids = Array.from({ length: 8 }, (_, i) => {
        const price = yes - (i + 1) * 0.005 - spread / 2;
        return { price: Math.max(0.01, price), size: rand(400, 6000), total: 0 };
      }).sort((a, b) => b.price - a.price);
      const asks = Array.from({ length: 8 }, (_, i) => {
        const price = yes + (i + 1) * 0.005 + spread / 2;
        return { price: Math.min(0.99, price), size: rand(400, 6000), total: 0 };
      }).sort((a, b) => a.price - b.price);
      let bt = 0, at = 0;
      bids.forEach(b => { bt += b.size; b.total = bt; });
      asks.forEach(a => { at += a.size; a.total = at; });
      setOrderBook({ market_id: selectedMarket.condition_id, bids, asks, mid_price: yes, spread, timestamp: Date.now() });
    }
  }, TICK_MS));

  // ── Signal + order generation ──────────────────────────────────────────────
  handles.push(setInterval(() => {
    const { markets, addSignal, addOrder, addLog, setStats, stats } = store();
    const market = pick(markets);
    const isYes  = Math.random() > 0.4;
    const side   = isYes ? "YES" as const : "NO" as const;
    const p_market = isYes ? market.yes_price : market.no_price;
    const edge   = rand(0.04, 0.12);
    const p_model = Math.max(0.05, Math.min(0.95, p_market + edge * (isYes ? 1 : -1)));
    const size   = rand(8, 24);

    const sig = {
      id: `s-${Date.now()}`,
      market_id: market.condition_id,
      market_question: market.question,
      side,
      edge,
      p_model,
      p_market,
      approved_size: size,
      kelly_fraction: rand(0.18, 0.32),
      consensus_count: Math.floor(rand(0, 5)),
      source: Math.random() > 0.5 ? "consensus" as const : "fast" as const,
      ts: Date.now(),
    };
    addSignal(sig);

    const isDryRun = useTradingStore.getState().risk.kill_switch_active || Math.random() > 0.6;
    const order: Order = {
      order_id: `o-${Date.now()}`,
      market_id: market.condition_id,
      market_question: market.question.slice(0, 35),
      side,
      size,
      price: p_market,
      status: isDryRun ? "DRY_RUN" : "FILLED",
      fill_price: isDryRun ? undefined : p_market + (Math.random() - 0.5) * 0.003,
      filled_size: isDryRun ? undefined : size,
      source: sig.source,
      ts: Date.now(),
    };
    addOrder(order);

    setStats({ signals_generated: stats.signals_generated + 1, orders_dry_run: isDryRun ? stats.orders_dry_run + 1 : stats.orders_dry_run, orders_submitted: isDryRun ? stats.orders_submitted : stats.orders_submitted + 1, api_cost_usd: stats.api_cost_usd + rand(0.002, 0.006) });

    const msg = pick(LOG_POOL)
      .replace("{E}", (edge * 100).toFixed(1))
      .replace("{M}", market.question.slice(0, 24))
      .replace("{S}", fmt2(rand(1, 4)))
      .replace("{L}", String(Math.floor(rand(80, 340))))
      .replace("{X}", fmt2(rand(3, 18)))
      .replace("{P}", fmt2(rand(0.45, 0.72)))
      .replace("{T}", fmt2(rand(0.52, 0.88)))
      .replace("{B}", String(Math.floor(rand(18, 26))))
      .replace("{N}", String(Math.floor(rand(6, 12))));
    addLog({ level: Math.random() > 0.85 ? "WARNING" : "INFO", message: msg, ts: Date.now() });
  }, SIGNAL_MS));

  // ── Worker heartbeats ─────────────────────────────────────────────────────
  handles.push(setInterval(() => {
    store().setWorkerHealth({
      ingestion: Date.now() - rand(500, 3000),
      signal:    Date.now() - rand(200, 2000),
      execution: Date.now() - rand(100, 1500),
      risk:      Date.now() - rand(400, 3500),
    });
  }, WORKER_MS));

  // ── Uptime + API cost ticks ───────────────────────────────────────────────
  handles.push(setInterval(() => {
    const { stats, setStats } = store();
    setStats({ uptime_s: stats.uptime_s + 2, api_calls: stats.api_calls + Math.floor(rand(1, 4)) });
  }, STATS_MS));

  // ── Risk drift ────────────────────────────────────────────────────────────
  handles.push(setInterval(() => {
    const { risk, setRisk } = store();
    if (risk.kill_switch_active) return;
    const pnlDelta = (Math.random() - 0.45) * 0.8;
    const bankroll = Math.max(800, risk.bankroll + pnlDelta);
    const daily    = Math.max(0, risk.daily_loss + (pnlDelta < 0 ? -pnlDelta : 0));
    setRisk({ bankroll, daily_loss: daily, drawdown_pct: Math.max(0, (risk.peak_bankroll - bankroll) / risk.peak_bankroll), total_exposure: rand(10, 45) });
  }, RISK_MS));

  // ── Crypto binary option opportunities (primary strategy, 12s cadence) ─────
  handles.push(setInterval(() => {
    const { addArbOpportunity, addLog } = store();
    const ASSETS = ["BTC", "ETH", "SOL"] as const;
    const asset  = pick(ASSETS as unknown as typeof ASSETS[number][]);

    // Drift the live spot a little each tick
    LIVE_SPOT[asset] *= (1 + (Math.random() - 0.5) * 0.003);
    const spot   = LIVE_SPOT[asset];
    const sigma  = MOCK_SIGMA[asset] * (0.9 + Math.random() * 0.2);

    // Pick a nearby strike
    const strikePct  = 1 + (Math.random() - 0.5) * 0.04;  // ±2% from spot
    const strike     = Math.round(spot * strikePct / (asset === "BTC" ? 1000 : 10)) * (asset === "BTC" ? 1000 : 10);
    const tauHours   = rand(0.08, 6.0);    // 5 min to 6 hours
    const direction  = Math.random() > 0.5 ? "above" : "below";

    const modelP  = direction === "above"
      ? binaryCallProb(spot, strike, sigma, tauHours)
      : 1 - binaryCallProb(spot, strike, sigma, tauHours);
    // Simulate Polymarket lagging model by 3-12%
    const lag     = (Math.random() - 0.3) * 0.14;
    const mktP    = Math.max(0.03, Math.min(0.97, modelP - lag));
    const edge    = modelP - mktP;

    if (Math.abs(edge) < 0.03) return;   // skip tiny edges

    const side    = edge > 0 ? "YES" as const : "NO" as const;
    const strikeFmt = strike >= 1000 ? `$${(strike/1000).toFixed(0)}K` : `$${strike}`;
    const spotFmt   = spot >= 1000   ? `$${(spot/1000).toFixed(2)}K`   : `$${spot.toFixed(2)}`;
    const opp: ArbOpportunity = {
      id:                `cb-${asset}-${Date.now()}`,
      strategy:          "crypto_binary",
      market_a_id:       `mock-${asset.toLowerCase()}-${Math.floor(strike)}`,
      market_a_question: `Will ${asset} be ${direction} ${strikeFmt} in ${tauHours < 1 ? `${Math.round(tauHours*60)}m` : `${tauHours.toFixed(1)}h`}?`,
      market_a_side:     side,
      market_a_price:    +mktP.toFixed(3),
      market_b_id:       "",
      market_b_question: "",
      market_b_side:     "YES",
      market_b_price:    0,
      edge:              +Math.abs(edge).toFixed(4),
      confidence:        +Math.min(0.95, 0.55 + Math.abs(Math.log(spot / strike)) * 0.8 + (1 - tauHours / 72) * 0.3).toFixed(3),
      reason:            `${asset} SPOT ${spotFmt}  STRIKE ${strikeFmt} | τ=${tauHours < 1 ? `${(tauHours*60).toFixed(0)}m` : `${tauHours.toFixed(1)}h`}  σ=${(sigma*100).toFixed(0)}%  d₂=${((Math.log(spot/strike))/(sigma*Math.sqrt(tauHours/8760))).toFixed(2)}`,
      action:            `BUY ${side} @ ${mktP.toFixed(3)}  (model: ${modelP.toFixed(3)}  edge: ${edge > 0 ? "+" : ""}${(edge*100).toFixed(1)}¢)`,
      ts:                Date.now(),
      spot_price:        +spot.toFixed(2),
      strike_price:      strike,
      tau_hours:         +tauHours.toFixed(3),
      realized_vol:      +sigma.toFixed(3),
      model_prob:        +modelP.toFixed(3),
    };
    addArbOpportunity(opp);
    addLog({
      level:   "INFO",
      message: `BOPT: ${asset} ${direction.toUpperCase()} ${strikeFmt} | model=${(modelP*100).toFixed(1)}% mkt=${(mktP*100).toFixed(1)}% edge=${edge>0?"+":""}${(edge*100).toFixed(1)}¢`,
      ts:      Date.now(),
    });
  }, 12_000));

  // ── Structural arbitrage opportunities (cascade / complement / resolution) ─
  handles.push(setInterval(() => {
    const { markets, addArbOpportunity, addLog } = store();
    if (markets.length < 2) return;

    const strategies: ArbOpportunity["strategy"][] = [
      "threshold_cascade",
      "complement",
      "resolution_proximity",
    ];
    const strategy = pick(strategies);

    const mA = pick(markets);
    const mB = pick(markets.filter(m => m.condition_id !== mA.condition_id));

    let opp: ArbOpportunity;
    const edge = rand(0.02, 0.11);
    const conf = rand(0.55, 0.92);
    const id   = `mock-arb-${Date.now()}`;

    if (strategy === "complement") {
      // Simulate a market where YES + NO < 0.96 due to price drift
      const syntheticYes = mA.yes_price - rand(0.02, 0.06);
      const syntheticNo  = mA.no_price  - rand(0.02, 0.06);
      opp = {
        id,
        strategy,
        market_a_id:       mA.condition_id,
        market_a_question: mA.question,
        market_a_side:     "YES",
        market_a_price:    +syntheticYes.toFixed(3),
        market_b_id:       mA.condition_id,
        market_b_question: mA.question,
        market_b_side:     "NO",
        market_b_price:    +syntheticNo.toFixed(3),
        edge:              +edge.toFixed(4),
        confidence:        +conf.toFixed(3),
        reason:            `YES(${syntheticYes.toFixed(3)}) + NO(${syntheticNo.toFixed(3)}) = ${(syntheticYes + syntheticNo).toFixed(3)} < 1`,
        action:            `BUY YES @ ${syntheticYes.toFixed(3)}  +  BUY NO @ ${syntheticNo.toFixed(3)}`,
        ts:                Date.now(),
      };
    } else if (strategy === "threshold_cascade") {
      const asset = mA.linked_asset ?? mB.linked_asset ?? "BTC";
      const tLow  = Math.floor(rand(60, 90)) * 1000;
      const tHigh = tLow + Math.floor(rand(10, 30)) * 1000;
      const pLow  = mA.yes_price - rand(0.03, 0.08);
      const pHigh = mA.yes_price;
      opp = {
        id,
        strategy,
        market_a_id:       mA.condition_id,
        market_a_question: `Will ${asset} exceed $${tLow/1000}K?`,
        market_a_side:     "YES",
        market_a_price:    +pLow.toFixed(3),
        market_b_id:       mB.condition_id,
        market_b_question: `Will ${asset} exceed $${tHigh/1000}K?`,
        market_b_side:     "YES",
        market_b_price:    +pHigh.toFixed(3),
        edge:              +edge.toFixed(4),
        confidence:        +conf.toFixed(3),
        reason:            `${asset}: $${tLow/1000}K @ ${pLow.toFixed(3)} < $${tHigh/1000}K @ ${pHigh.toFixed(3)} — logical violation`,
        action:            `BUY ${asset}>${tLow/1000}K YES @ ${pLow.toFixed(3)}  (should be ≥ ${pHigh.toFixed(3)})`,
        ts:                Date.now(),
      };
    } else {
      const hoursLeft = rand(2, 42);
      const highYes   = rand(0.78, 0.94);
      opp = {
        id,
        strategy,
        market_a_id:       mA.condition_id,
        market_a_question: mA.question,
        market_a_side:     "YES",
        market_a_price:    +highYes.toFixed(3),
        market_b_id:       "",
        market_b_question: "",
        market_b_side:     "YES",
        market_b_price:    0,
        edge:              +edge.toFixed(4),
        confidence:        +(highYes * 0.88).toFixed(3),
        reason:            `YES=${highYes.toFixed(3)}  resolves in ${hoursLeft.toFixed(1)}h — time premium available`,
        action:            `BUY YES @ ${highYes.toFixed(3)}  (closes in ${hoursLeft.toFixed(1)}h)`,
        ts:                Date.now(),
      };
    }

    addArbOpportunity(opp);
    addLog({
      level:   "INFO",
      message: `ARB: ${strategy} edge=+${(edge * 100).toFixed(1)}¢ — ${opp.action.slice(0, 55)}`,
      ts:      Date.now(),
    });
  }, ARB_MS));
}

export function stopMockFeed(): void {
  handles.forEach(clearInterval);
  handles.length = 0;
}

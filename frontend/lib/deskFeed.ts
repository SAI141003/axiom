/**
 * The desk feed — real paper books into the terminal store. Replaces the old
 * simulation entirely: positions, orders and signals are the weather bot's
 * Polymarket trades and the crypto tape; the book and chart are the CLOB; risk
 * is the fleet's actual balances; worker dots are the launchd services.
 */
import { useTradingStore } from "./store";
import type { Order, Position, Signal } from "./types";

const timers: ReturnType<typeof setInterval>[] = [];
let lastToken: string | null = null;
let unsub: (() => void) | null = null;

const j = (u: string) => fetch(u, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

async function book() {
  const s = useTradingStore.getState();
  const token = s.selectedMarket?.token_id;
  if (!token) return;
  const d = await j(`/api/markets/book?token=${token}`);
  if (!d || useTradingStore.getState().selectedMarket?.token_id !== token) return;
  if (d.book) s.setOrderBook({ market_id: s.selectedMarket!.condition_id, ...d.book });
  if (d.history?.length) s.setPriceHistory(d.history);
  if (lastToken !== token) { lastToken = token; s.addLog({ level: "INFO", message: `CLOB: book ${d.book ? `${d.book.bids.length}×${d.book.asks.length} levels` : "empty"} · ${d.history?.length ?? 0} history points`, ts: Date.now() }); }
}

async function weather() {
  const d = await j("/api/weather-trades");
  if (!d) return;
  const s = useTradingStore.getState();
  const trades: any[] = d.trades ?? [];
  const positions: Position[] = trades.filter((t) => t.status === "open").map((t) => ({
    market_id: t.slug, market_question: t.q, token_id: t.tid, side: t.side,
    size: +(t.stake / t.entry).toFixed(2), avg_price: t.entry, current_price: t.entry,
    unrealized_pnl: 0, opened_at: t.ts * 1000,
  }));
  s.setPositions(positions);
  const seen = new Set(s.orders.map((o) => o.order_id));
  for (const t of trades.slice().reverse()) {
    if (seen.has(t.tid)) continue;
    const o: Order = { order_id: t.tid, market_id: t.slug, market_question: t.q, side: t.side, size: +(t.stake / t.entry).toFixed(2), price: t.entry,
      status: "DRY_RUN", fill_price: t.entry, filled_size: +(t.stake / t.entry).toFixed(2), source: "weather", ts: t.ts * 1000 };
    s.addOrder(o);
    const sig: Signal = { id: `w-${t.tid}`, market_id: t.slug, market_question: t.q, side: t.side, edge: t.edge, p_model: t.model, p_market: t.market,
      approved_size: t.stake, kelly_fraction: t.stake / 100, consensus_count: 1, source: "consensus", ts: t.ts * 1000 };
    s.addSignal(sig);
  }
  const st = d.stats ?? {};
  s.setStats({ signals_generated: st.placed ?? 0, orders_dry_run: st.placed ?? 0, orders_submitted: 0, orders_rejected: 0 });
}

async function tape() {
  const d = await j("/api/tape");
  const s = useTradingStore.getState();
  for (const f of d?.frames ?? []) {
    const id = `t-${f.sym}-${f.ts}`;
    if (s.signals.some((x) => x.id === id) || f.decision === "hold") continue;
    s.addSignal({ id, market_id: f.sym, market_question: `${f.sym} tape · ${f.decision} · CVD ${f.cvd_ratio > 0 ? "+" : ""}${(f.cvd_ratio * 100).toFixed(0)}%`, side: f.bias >= 0 ? "YES" : "NO",
      edge: f.bias, p_model: 0.5 + f.bias / 2, p_market: 0.5, approved_size: 0, kelly_fraction: 0, consensus_count: f.big_trades, source: "fast", ts: f.ts * 1000 });
  }
}

async function risk() {
  const [f, a, sc] = await Promise.all([j("/api/fleet"), j("/api/agents"), j("/api/scenario")]);
  const s = useTradingStore.getState();
  if (f?.totals) {
    const todayLoss = (f.accounts ?? []).reduce((x: number, acc: any) => x + Math.min(0, acc.today?.pnl ?? 0), 0);
    const open = s.positions;
    s.setRisk({ bankroll: f.totals.account, peak_bankroll: Math.max(f.totals.start, f.totals.account), daily_loss: -todayLoss,
      drawdown_pct: Math.max(0, (f.totals.start - f.totals.account) / f.totals.start), open_positions: open.length,
      total_exposure: +open.reduce((x, p) => x + p.size * p.avg_price, 0).toFixed(2) });
  }
  if (a?.services?.list) {
    const up = (names: string[]) => (a.services.list.some((x: any) => names.includes(x.name) && x.state === "running") ? Date.now() : 0);
    s.setWorkerHealth({ ingestion: up(["crypto", "data.openbb", "newsdesk.poll"]), signal: up(["weather", "oraclelag", "vwap"]), execution: up(["bot", "botos", "flowbot"]), risk: up(["autotuner", "montecarlo", "forwardsnapshot"]) });
  }
  if (sc?.brier != null) s.setStats({ brier_score: sc.brier });
}

export function startDeskFeed(): void {
  stopDeskFeed();
  const s = useTradingStore.getState();
  s.addLog({ level: "INFO", message: "Desk feed: paper books, CLOB book, crypto tape, fleet risk — all real, nothing simulated", ts: Date.now() });
  book(); weather(); tape(); risk();
  timers.push(setInterval(book, 10_000), setInterval(weather, 30_000), setInterval(tape, 15_000), setInterval(risk, 60_000));
  unsub = useTradingStore.subscribe((st) => st.selectedMarket?.token_id, () => { book(); });
}

export function stopDeskFeed(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0; unsub?.(); unsub = null; lastToken = null;
}

"use client";

/**
 * Multi-asset 5-minute Up/Down auto-trader.
 *
 * LIVE DATA:
 *   - Spot prices: Binance public REST (no key) polled every 4s
 *   - Market prices: Polymarket Gamma via /api/crypto/window every 10s
 *   - Resolution: Binance 5m kline open vs close for the exact window
 *     (Polymarket resolves via Chainlink BTC/USD — Binance tracks it within
 *      ~1bp; this is a paper-trading approximation, not a live order engine)
 *
 * STRATEGY (Markov/momentum blend, mirrors backend signals/markov_signal.py):
 *   - EMA(60s) vs EMA(180s) momentum sign
 *   - last-3-window persistence (same-direction streak)
 *   - enter in the first 90s of each window when signal and market agree
 *     (only take the trade when our side costs < 0.62 — no chasing)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import TopNav from "@/components/TopNav";
import EngineBanner from "@/components/EngineBanner";
import { getToggle } from "@/lib/toggles";

// tradable defaults from the 2-day LIVE dry run (2,277 real trades,
// dryrun/analyze.py 2026-07-09): ETH +$21 (50.6% WR), BTC -$12 (50.5%),
// XRP -$99 (49.4%), SOL -$523 (46.0% — momentum ANTI-predicts on SOL, 46.7%
// agreement) → SOL and XRP off by default; supersedes the earlier
// point-in-time backtest that had ETH off.
const ASSETS = [
  { id: "btc", symbol: "BTCUSDT", label: "BTC", color: "#f7931a", tradeDefault: true },
  { id: "eth", symbol: "ETHUSDT", label: "ETH", color: "#8a92b2", tradeDefault: true },
  { id: "sol", symbol: "SOLUSDT", label: "SOL", color: "#9945ff", tradeDefault: false },
  { id: "xrp", symbol: "XRPUSDT", label: "XRP", color: "#22d3ee", tradeDefault: false },
] as const;

const STAKE_USD    = 10;    // paper stake per trade
const MAX_SIDE_PX  = 0.62;  // never pay more than 62¢ for a side
const ENTRY_WINDOW = 90;    // only enter in the first 90s of a 5-min window

interface WindowInfo {
  slug: string; title: string;
  windowStart: number; windowEnd: number;
  upPrice: number; downPrice: number;
  volume: number; active: boolean;
}

interface AssetState {
  spot: number;
  emaFast: number;   // ~60s
  emaSlow: number;   // ~180s
  window: WindowInfo | null;
  lastSignal: string;
  lastTradedWindow: number;
  recentDirs: number[];   // +1/-1 for last closed 5m windows
}

interface Trade {
  id: string; asset: string; windowStart: number; windowEnd: number;
  side: "UP" | "DOWN"; entryPrice: number; stake: number; signal: string;
  spotAtEntry: number; windowOpen?: number; windowClose?: number;
  status: "open" | "won" | "lost" | "void"; pnl?: number; ts: number;
}

interface LearnedCfg { enabled: boolean; threshold: number; sign: number }

export default function CryptoAutoTrader() {
  const [auto, setAuto] = useState(() => getToggle("crypto.autoTrade"));
  const [enabled, setEnabled] = useState<Record<string, boolean>>(
    () => Object.fromEntries(ASSETS.map((a) => [a.id, a.tradeDefault])),
  );
  const [learned, setLearned] = useState<Record<string, LearnedCfg>>({});
  const [states, setStates] = useState<Record<string, AssetState>>({});
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState({ resolved: 0, wins: 0, winRate: 0, totalPnl: 0, open: 0 });
  const [log, setLog] = useState<string[]>([]);
  const [clock, setClock] = useState(0);

  const statesRef = useRef(states);
  statesRef.current = states;
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const tradesRef = useRef(trades);
  tradesRef.current = trades;

  const addLog = useCallback((msg: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} ${msg}`, ...l].slice(0, 40));
  }, []);

  // ── Load persisted trades ────────────────────────────────────────────────
  const refreshTrades = useCallback(async () => {
    try {
      const res = await fetch("/api/crypto/trades");
      if (res.ok) {
        const data = await res.json();
        setTrades(data.trades ?? []);
        setStats(data.stats ?? stats);
      }
    } catch {}
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshTrades();
    const id = setInterval(refreshTrades, 5000);   // stream live daemon trades
    return () => clearInterval(id);
  }, [refreshTrades]);

  // Self-learner params (nightly refit from real outcomes) — sets asset
  // enable/threshold/momentum-sign; manual toggles still override enable.
  const learnedRef = useRef(learned);
  learnedRef.current = learned;
  useEffect(() => {
    fetch("/api/learned").then((r) => (r.ok ? r.json() : null)).then((d) => {
      const p = d?.crypto?.params;
      if (!p) return;
      setLearned(p);
      setEnabled(Object.fromEntries(ASSETS.map((a) => [a.id, p[a.id]?.enabled ?? a.tradeDefault])));
    }).catch(() => {});
  }, []);

  // ── Spot price loop (Binance REST, 4s) ───────────────────────────────────
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const symbols = JSON.stringify(ASSETS.map((a) => a.symbol));
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(symbols)}`);
        if (!res.ok) return;
        const rows: { symbol: string; price: string }[] = await res.json();
        if (stop) return;
        setStates((prev) => {
          const next = { ...prev };
          for (const a of ASSETS) {
            const row = rows.find((r) => r.symbol === a.symbol);
            if (!row) continue;
            const px = parseFloat(row.price);
            const cur = next[a.id] ?? {
              spot: px, emaFast: px, emaSlow: px, window: null,
              lastSignal: "warming up", lastTradedWindow: 0, recentDirs: [],
            };
            // EMA alphas for 4s cadence: fast ≈ 60s, slow ≈ 180s
            next[a.id] = {
              ...cur,
              spot: px,
              emaFast: cur.emaFast + (2 / (15 + 1)) * (px - cur.emaFast),
              emaSlow: cur.emaSlow + (2 / (45 + 1)) * (px - cur.emaSlow),
            };
          }
          return next;
        });
      } catch {}
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // ── Polymarket window loop (10s) ─────────────────────────────────────────
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      for (const a of ASSETS) {
        try {
          const res = await fetch(`/api/crypto/window?asset=${a.id}`);
          if (!res.ok || stop) continue;
          const data = await res.json();
          setStates((prev) => ({
            ...prev,
            [a.id]: { ...(prev[a.id] ?? {} as AssetState), window: data.current },
          }));
        } catch {}
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // ── Auto-trade + resolution loop (5s) ────────────────────────────────────
  useEffect(() => {
    const id = setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      setClock(now);
      const windowStart = Math.floor(now / 300) * 300;
      const secsIn = now - windowStart;

      for (const a of ASSETS) {
        const st = statesRef.current[a.id];
        if (!st || !st.spot) continue;

        // ── 1. ENTRY ──
        if (
          autoRef.current &&
          enabledRef.current[a.id] &&
          secsIn <= ENTRY_WINDOW &&
          st.lastTradedWindow !== windowStart &&
          st.window && st.window.windowStart === windowStart && st.window.active
        ) {
          const momentum = (st.emaFast - st.emaSlow) / st.emaSlow;
          const persistence = st.recentDirs.length >= 2
            ? st.recentDirs.slice(-3).reduce((s, d) => s + d, 0) / Math.min(3, st.recentDirs.length)
            : 0;
          // blended score: momentum dominates, persistence confirms
          const score = Math.sign(momentum) * Math.min(1, Math.abs(momentum) * 8000) * 0.7 + persistence * 0.3;

          // self-learner config: sign −1 = FADE the signal (e.g. SOL mean-reverts)
          const cfg = learnedRef.current[a.id] ?? { threshold: 0.25, sign: 1, enabled: true };
          const eff = cfg.sign * score;
          let side: "UP" | "DOWN" | null = null;
          if (eff > cfg.threshold) side = "UP";
          else if (eff < -cfg.threshold) side = "DOWN";

          if (side) {
            const price = side === "UP" ? st.window.upPrice : st.window.downPrice;
            if (price > 0.01 && price < MAX_SIDE_PX) {
              const signal = `mom=${(momentum * 10000).toFixed(1)}bp persist=${persistence.toFixed(2)} score=${score.toFixed(2)}`;
              setStates((prev) => ({
                ...prev,
                [a.id]: { ...prev[a.id], lastTradedWindow: windowStart, lastSignal: `${side} @ ${(price * 100).toFixed(1)}¢ · ${signal}` },
              }));
              // display-only live signal — the daemon is the single source of
              // truth for paper trades; the page no longer writes its own layer.
              addLog(`◦ ${a.label} ${side} signal @ ${(price * 100).toFixed(1)}¢ (${signal})`);
            } else {
              setStates((prev) => ({
                ...prev,
                [a.id]: { ...prev[a.id], lastTradedWindow: windowStart, lastSignal: `skip — ${side} costs ${(price * 100).toFixed(1)}¢ > ${MAX_SIDE_PX * 100}¢ cap` },
              }));
            }
          } else if (secsIn > ENTRY_WINDOW - 10) {
            setStates((prev) => ({
              ...prev,
              [a.id]: { ...prev[a.id], lastTradedWindow: windowStart, lastSignal: `no edge (score=${score.toFixed(2)}) — window skipped` },
            }));
          }
        }

        // Resolution is owned by the daemon; the page reads results via polling.
      }
    }, 5000);
    return () => clearInterval(id);
  }, [addLog, refreshTrades]);

  // ── Equity curve from resolved trades ─────────────────────────────────────
  const equity = (() => {
    let cum = 0;
    return trades
      .filter((t) => t.status === "won" || t.status === "lost")
      .map((t) => { cum += t.pnl ?? 0; return { ts: t.windowEnd, pnl: parseFloat(cum.toFixed(2)) }; });
  })();

  const secsLeft = 300 - (clock % 300);

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <EngineBanner engine="oracle-lag (gated)" />
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em] glow-cyan">◎ CRYPTO 5-MIN AUTO-TRADER</h1>
            <p className="text-xs mt-1" style={{ color: "var(--hud-muted)" }}>
              Live Binance spot + live Polymarket Up/Down markets · paper-trades ${STAKE_USD}/window automatically
              · window closes in <span className="glow-amber">{Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")}</span>
            </p>
          </div>
          <button
            onClick={() => setAuto((v) => !v)}
            className={`hud-chip transition-all ${auto ? "hud-nav-active" : ""}`}
            style={{ color: auto ? undefined : "var(--hud-muted)", cursor: "pointer", height: 34 }}
          >
            {auto ? "⚡ AUTO-TRADING ON" : "⏸ AUTO-TRADING PAUSED"}
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {[
            { label: "TOTAL P&L", value: `${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`, color: stats.totalPnl >= 0 ? "var(--hud-green)" : "var(--hud-red)" },
            { label: "RESOLVED", value: String(stats.resolved), color: "var(--hud-violet)" },
            { label: "OPEN", value: String(stats.open), color: "var(--hud-cyan)" },
            { label: "WIN RATE", value: `${(stats.winRate * 100).toFixed(1)}%`, color: stats.winRate >= 0.5 ? "var(--hud-green)" : "var(--hud-amber)" },
            { label: "STAKE / TRADE", value: `$${STAKE_USD}`, color: "var(--hud-muted)" },
          ].map((c) => (
            <div key={c.label} className="hud-panel hud-panel-static px-4 py-3">
              <div className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>{c.label}</div>
              <div className="text-xl font-bold tabular-nums mt-1" style={{ color: c.color }}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* Asset panels */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {ASSETS.map((a) => {
            const st = states[a.id];
            const mom = st ? ((st.emaFast - st.emaSlow) / st.emaSlow) * 10000 : 0;
            return (
              <div key={a.id} className="hud-panel hud-panel-static p-4"
                   style={{ opacity: enabled[a.id] ? 1 : 0.55 }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="flex items-center gap-2">
                    <span className="font-bold tracking-widest" style={{ color: a.color }}>{a.label}/USDT</span>
                    <button
                      onClick={() => setEnabled((e) => ({ ...e, [a.id]: !e[a.id] }))}
                      className="text-[9px] px-1.5 py-0.5 tracking-widest cursor-pointer"
                      title={a.tradeDefault ? "validated profitable on 983 real windows" : "backtest: 46.6% WR, net loser — off by default"}
                      style={{
                        border: `1px solid ${enabled[a.id] ? "rgba(52,211,153,0.5)" : "var(--hud-border)"}`,
                        color: enabled[a.id] ? "var(--hud-green)" : "var(--hud-muted)",
                        background: "transparent",
                      }}>
                      {enabled[a.id] ? "TRADING" : "OFF"}
                    </button>
                    {learned[a.id] && (
                      <span className="text-[9px]" style={{ color: "var(--hud-violet)" }}
                            title="nightly self-learner config (stability-tested on real outcomes)">
                        🧠 {learned[a.id].sign === -1 ? "FADE" : "FOLLOW"} @{learned[a.id].threshold}
                      </span>
                    )}
                  </span>
                  <span className="text-lg font-bold tabular-nums">
                    {st?.spot ? `$${st.spot.toLocaleString("en-US", { maximumFractionDigits: st.spot > 100 ? 0 : 4 })}` : "…"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs tabular-nums mb-2">
                  <span style={{ color: "var(--hud-muted)" }}>
                    momentum <span style={{ color: mom >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>{mom >= 0 ? "+" : ""}{mom.toFixed(1)}bp</span>
                  </span>
                  {st?.window && (
                    <span>
                      <span style={{ color: "var(--hud-green)" }}>UP {(st.window.upPrice * 100).toFixed(1)}¢</span>
                      {" / "}
                      <span style={{ color: "var(--hud-red)" }}>DOWN {(st.window.downPrice * 100).toFixed(1)}¢</span>
                    </span>
                  )}
                </div>
                <div className="text-[10px] truncate" style={{ color: "var(--hud-muted)" }}>
                  {st?.window?.title ?? "loading market…"}
                </div>
                <div className="text-[10px] mt-1 truncate" style={{ color: "var(--hud-cyan)" }}>
                  {st?.lastSignal ?? "—"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Equity curve + activity log */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <div className="hud-panel hud-panel-static p-4">
            <div className="text-xs tracking-widest mb-2 glow-green">EQUITY CURVE (PAPER)</div>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={equity}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2a45" />
                <XAxis dataKey="ts" tickFormatter={(v) => new Date(v * 1000).toLocaleTimeString().slice(0, 5)}
                       tick={{ fill: "#7c8cae", fontSize: 9 }} />
                <YAxis tick={{ fill: "#7c8cae", fontSize: 9 }} />
                <Tooltip contentStyle={{ background: "#0c1222", border: "1px solid #1c2a45", fontSize: 11 }}
                         labelFormatter={(v) => new Date((v as number) * 1000).toLocaleString()} />
                <ReferenceLine y={0} stroke="#7c8cae" strokeDasharray="4 2" />
                <Area type="monotone" dataKey="pnl" stroke="#34d399" fill="#34d39922" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="hud-panel hud-panel-static p-4 overflow-hidden">
            <div className="text-xs tracking-widest mb-2 glow-cyan">ACTIVITY LOG</div>
            <div className="flex flex-col gap-1 overflow-y-auto text-[11px]" style={{ maxHeight: 180 }}>
              {log.length === 0 && <span style={{ color: "var(--hud-muted)" }}>Waiting for first window entry… trades fire in the first {ENTRY_WINDOW}s of each 5-min window when momentum ≥ threshold.</span>}
              {log.map((l, i) => <div key={i} style={{ color: "var(--hud-text)" }}>{l}</div>)}
            </div>
          </div>
        </div>

        {/* Trades table */}
        <div className="hud-panel hud-panel-static overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ background: "rgba(12,18,34,0.9)", color: "var(--hud-muted)" }}>
                <th className="text-left px-3 py-2">TIME</th>
                <th className="text-left px-3 py-2">ASSET</th>
                <th className="text-left px-3 py-2">SIDE</th>
                <th className="text-right px-3 py-2">ENTRY</th>
                <th className="text-right px-3 py-2">OPEN→CLOSE</th>
                <th className="text-left px-3 py-2">STATUS</th>
                <th className="text-right px-3 py-2">P&L</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {[...trades].reverse().slice(0, 25).map((t) => (
                <tr key={t.id} className="hud-row">
                  <td className="px-3 py-1.5" style={{ color: "var(--hud-muted)" }}>
                    {new Date(t.windowStart * 1000).toLocaleTimeString()}
                  </td>
                  <td className="px-3 py-1.5 font-bold uppercase">{t.asset}</td>
                  <td className="px-3 py-1.5 font-bold" style={{ color: t.side === "UP" ? "var(--hud-green)" : "var(--hud-red)" }}>{t.side}</td>
                  <td className="text-right px-3 py-1.5">{(t.entryPrice * 100).toFixed(1)}¢</td>
                  <td className="text-right px-3 py-1.5" style={{ color: "var(--hud-muted)" }}>
                    {t.windowOpen ? `${t.windowOpen.toFixed(t.windowOpen > 100 ? 0 : 4)} → ${t.windowClose?.toFixed(t.windowClose! > 100 ? 0 : 4)}` : "…"}
                  </td>
                  <td className="px-3 py-1.5">
                    {t.status === "open" && <span className="glow-cyan">OPEN</span>}
                    {t.status === "won"  && <span className="glow-green">WON</span>}
                    {t.status === "lost" && <span className="glow-red">LOST</span>}
                  </td>
                  <td className="text-right px-3 py-1.5 font-bold"
                      style={{ color: (t.pnl ?? 0) >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                    {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))}
              {trades.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8" style={{ color: "var(--hud-muted)" }}>
                  No trades yet — the engine enters automatically when a 5-min window opens with momentum.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[10px] mt-4 pb-8" style={{ color: "var(--hud-muted)" }}>
          Paper trading with live data. Resolution uses Binance 5m klines as a proxy for Chainlink
          (Polymarket&apos;s official source) — boundary ties can differ. Real order placement stays in the
          Python backend behind DRY_RUN + kill switch.
        </p>
      </main>
    </div>
  );
}

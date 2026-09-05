"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { initWebSocket, destroyWebSocket } from "@/lib/websocket";
import { startMockFeed, stopMockFeed, seedSpotPrices } from "@/lib/mockFeed";
import { fetchGammaMarkets, fetchBinancePrices } from "@/lib/liveData";
import MarketList from "./MarketList";
import OrderBook from "./OrderBook";
import ChartPanel from "./ChartPanel";
import PositionsPanel from "./PositionsPanel";
import OrdersPanel from "./OrdersPanel";
import RiskPanel from "./RiskPanel";
import SignalFeed from "./SignalFeed";
import QuickOrderPanel from "./QuickOrderPanel";
import ArbitragePanel from "./ArbitragePanel";
import MiroFishDashboard from "./MiroFishDashboard";
import { useTradingStore } from "@/lib/store";
import clsx from "clsx";

// ── View tabs ─────────────────────────────────────────────────────────────────

type View = "markets" | "signals" | "risk" | "pnl" | "analytics" | "arb" | "mirofish";

const VIEWS: { id: View; key: string; label: string }[] = [
  { id: "markets",   key: "1", label: "MKTS"  },
  { id: "signals",   key: "2", label: "SIGS"  },
  { id: "risk",      key: "3", label: "RISK"  },
  { id: "pnl",       key: "4", label: "P&L"   },
  { id: "analytics", key: "5", label: "ANLYT" },
  { id: "arb",       key: "6", label: "ARB"   },
  { id: "mirofish",  key: "7", label: "MFISH" },
];

// F-key bar definitions
const FN_KEYS = [
  { key: "F1",  label: "HELP",   id: "help"      },
  { key: "F2",  label: "ORDERS", id: "orders"    },
  { key: "F3",  label: "SIGS",   id: "signals"   },
  { key: "F4",  label: "RISK",   id: "risk"      },
  { key: "F5",  label: "P&L",    id: "pnl"       },
  { key: "F6",  label: "MKTS",   id: "markets"   },
  { key: "F7",  label: "ANLYT",  id: "analytics" },
  { key: "F8",  label: "KILL",   id: "kill"      },
  { key: "F9",  label: "ARB",    id: "arb"       },
  { key: "F10", label: "SIM",    id: "sim"       },
];

// ── Main ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const killActive           = useTradingStore((s) => s.risk.kill_switch_active);
  const activateKillSwitch   = useTradingStore((s) => s.activateKillSwitch);
  const deactivateKillSwitch = useTradingStore((s) => s.deactivateKillSwitch);
  const wsConnected       = useTradingStore((s) => s.stats.ws_connected);

  const [activeView,    setActiveView   ] = useState<View>("markets");
  const [simRunning,    setSimRunning   ] = useState(false);
  const [helpOpen,      setHelpOpen     ] = useState(false);
  const [killConfirm,   setKillConfirm  ] = useState(false);
  const [loadingMarkets,setLoadingMarkets] = useState(true);

  const simStarted  = useRef(false);
  const killTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Startup: fetch live Gamma markets + Binance prices, then try WS ─────────
  useEffect(() => {
    const store = useTradingStore.getState();

    // 1. Fetch live data immediately (parallel)
    Promise.all([
      fetchGammaMarkets(50),
      fetchBinancePrices(),
    ]).then(([markets, prices]) => {
      // Seed live spot prices into mockFeed so crypto binary opps are realistic
      if (Object.keys(prices).length > 0) {
        seedSpotPrices(prices);
      }

      if (markets.length > 0) {
        store.setMarkets(markets);
        store.selectMarket(markets[0]);
        store.addLog({
          level: "INFO",
          message: `Gamma API: ${markets.length} live markets loaded`,
          ts: Date.now(),
        });
      } else {
        store.addLog({
          level: "WARNING",
          message: "Gamma API: no markets returned — check network",
          ts: Date.now(),
        });
      }

      const btc = prices.BTC;
      if (btc) {
        store.addLog({
          level: "INFO",
          message: `Binance: BTC $${btc.toLocaleString(undefined, { maximumFractionDigits: 0 })} ETH $${(prices.ETH ?? 0).toLocaleString()} SOL $${(prices.SOL ?? 0).toFixed(2)}`,
          ts: Date.now(),
        });
      }
    }).catch(() => {
      store.addLog({ level: "WARNING", message: "Live data fetch failed — check network", ts: Date.now() });
    }).finally(() => {
      setLoadingMarkets(false);
    });

    // 2. Try backend WS
    initWebSocket();

    // NO silent mock fallback — the terminal shows real data or an OFFLINE
    // state. Simulation only ever starts via the explicit F10 toggle, and is
    // clearly labelled. (A silent fake feed is worse than an honest gap.)
    const timer = setTimeout(() => {
      if (!useTradingStore.getState().stats.ws_connected) {
        useTradingStore.getState().addLog({
          level: "WARNING",
          message: "Backend WS offline (ws://localhost:8765) — live bot telemetry unavailable. Press F10 for an explicitly-labelled sim feed.",
          ts: Date.now(),
        });
      }
    }, 1500);

    return () => {
      clearTimeout(timer);
      destroyWebSocket();
      stopMockFeed();
    };
  }, []);

  // Keyboard: 1-6 switch views, ESC closes overlays
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = parseInt(e.key) - 1;
      if (idx >= 0 && idx < VIEWS.length) setActiveView(VIEWS[idx].id);
      if (e.key === "Escape") { setHelpOpen(false); setKillConfirm(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleFnKey = useCallback((id: string) => {
    switch (id) {
      case "help":      setHelpOpen(v => !v); break;
      case "orders":    setActiveView("pnl"); break;
      case "signals":   setActiveView("signals"); break;
      case "risk":      setActiveView("risk"); break;
      case "pnl":       setActiveView("pnl"); break;
      case "markets":   setActiveView("markets"); break;
      case "analytics": setActiveView("analytics"); break;
      case "arb":       setActiveView("arb"); break;
      case "mirofish":  setActiveView("mirofish"); break;
      case "kill":
        if (killActive) {
          // Toggle OFF: second press on active kill switch deactivates
          deactivateKillSwitch();
          useTradingStore.getState().addLog({ level: "WARNING", message: "Kill switch DEACTIVATED — trading resumed", ts: Date.now() });
          break;
        }
        if (!killConfirm) {
          setKillConfirm(true);
          if (killTimeout.current) clearTimeout(killTimeout.current);
          killTimeout.current = setTimeout(() => setKillConfirm(false), 5000);
        } else {
          activateKillSwitch();
          setKillConfirm(false);
          if (killTimeout.current) clearTimeout(killTimeout.current);
          useTradingStore.getState().addLog({ level: "ERROR", message: "Kill switch ACTIVATED — all orders halted", ts: Date.now() });
        }
        break;
      case "sim":
        if (simRunning) { stopMockFeed(); setSimRunning(false); }
        else            { startMockFeed(); setSimRunning(true); }
        break;
    }
  }, [killActive, killConfirm, activateKillSwitch, simRunning]);

  if (loadingMarkets) {
    return (
      <div className="flex flex-col h-screen w-screen bg-bb-bg items-center justify-center gap-4">
        <div className="animate-pulse-dot" style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--bb-amber)" }} />
        <span className="num" style={{ color: "var(--bb-amber)", fontSize: 12, letterSpacing: "0.18em" }}>LOADING LIVE MARKETS…</span>
        <span className="text-bb-muted" style={{ fontSize: 9 }}>Fetching from Polymarket Gamma API</span>
      </div>
    );
  }

  return (
    <div className={clsx(
      "flex flex-col h-screen w-screen bg-bb-bg overflow-hidden",
      killActive && "kill-border",
    )}>
      <BreadcrumbBar activeView={activeView} onViewChange={setActiveView} />
      <SecurityBar killActive={killActive} />

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* LEFT — market watchlist, always visible */}
        <div className="flex flex-col border-r border-bb-border flex-shrink-0" style={{ width: "19%", minWidth: 200 }}>
          <MarketList />
        </div>

        {/* CENTER + RIGHT — view-dependent */}
        {activeView === "risk"      && <RiskView />}
        {activeView === "signals"   && <SignalsView />}
        {activeView === "pnl"       && <PnLView />}
        {activeView === "analytics" && <AnalyticsView wsConnected={wsConnected} simRunning={simRunning} />}
        {activeView === "arb"       && <ArbView />}
        {activeView === "mirofish"  && <MiroFishView />}
        {activeView === "markets"   && <MainView />}
      </div>

      <FunctionKeyBar
        activeView={activeView}
        killActive={killActive}
        killConfirm={killConfirm}
        simRunning={simRunning}
        wsConnected={wsConnected}
        onFnKey={handleFnKey}
      />

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

// ── Views ─────────────────────────────────────────────────────────────────────

function MainView() {
  return (
    <>
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <div className="flex flex-col border-b border-bb-border" style={{ height: "57%" }}>
          <ChartPanel />
        </div>
        <div className="flex flex-1 overflow-hidden min-h-0">
          <div className="flex-1 border-r border-bb-border overflow-hidden"><OrderBook /></div>
          <div style={{ width: "36%" }} className="overflow-hidden"><SignalFeed /></div>
        </div>
      </div>
      <div className="flex flex-col overflow-hidden border-l border-bb-border flex-shrink-0" style={{ width: "28%", minWidth: 260 }}>
        <div style={{ height: "30%" }} className="border-b border-bb-border"><RiskPanel /></div>
        <div style={{ height: "22%" }} className="border-b border-bb-border"><QuickOrderPanel /></div>
        <div style={{ height: "24%" }} className="border-b border-bb-border"><PositionsPanel /></div>
        <div className="flex-1 overflow-hidden"><OrdersPanel /></div>
      </div>
    </>
  );
}

function RiskView() {
  return (
    <>
      <div className="flex-1 border-r border-bb-border overflow-hidden">
        <ChartPanel />
      </div>
      <div className="flex flex-col border-l border-bb-border overflow-hidden flex-shrink-0" style={{ width: "38%", minWidth: 300 }}>
        <div style={{ height: "55%" }} className="border-b border-bb-border"><RiskPanel /></div>
        <div className="flex-1 overflow-hidden"><OrdersPanel /></div>
      </div>
    </>
  );
}

function SignalsView() {
  return (
    <>
      <div className="flex-1 border-r border-bb-border overflow-hidden">
        <ChartPanel />
      </div>
      <div className="flex flex-col overflow-hidden flex-shrink-0" style={{ width: "40%", minWidth: 320 }}>
        <div style={{ height: "60%" }} className="border-b border-bb-border"><SignalFeed /></div>
        <div className="flex-1 overflow-hidden"><PositionsPanel /></div>
      </div>
    </>
  );
}

function PnLView() {
  const { positions, orders, risk } = useTradingStore((s) => ({
    positions: s.positions,
    orders:    s.orders,
    risk:      s.risk,
  }));

  const totalUnrealized = positions.reduce((s, p) => s + p.unrealized_pnl, 0);
  const filled          = orders.filter(o => o.status === "FILLED");
  const realized        = filled.reduce((s, o) =>
    s + ((o.fill_price ?? o.price) - o.price) * o.size * (o.side === "YES" ? 1 : -1), 0);

  return (
    <>
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <div className="border-b border-bb-border flex-shrink-0" style={{ height: "22%" }}>
          <div className="panel-header">P&L SUMMARY</div>
          <div className="grid grid-cols-4 gap-0" style={{ height: "calc(100% - 24px)" }}>
            {([
              ["BANKROLL",   `$${risk.bankroll.toFixed(2)}`,                          risk.bankroll >= risk.peak_bankroll * 0.95 ? "bb-green" : "bb-red"],
              ["DAILY LOSS", `$${risk.daily_loss.toFixed(2)}`,                        risk.daily_loss > 100 ? "bb-red" : "bb-green"],
              ["UNREALIZED", `${totalUnrealized >= 0 ? "+" : ""}$${totalUnrealized.toFixed(2)}`, totalUnrealized >= 0 ? "bb-green" : "bb-red"],
              ["REALIZED",   `${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}`,    realized >= 0 ? "bb-green" : "bb-red"],
            ] as [string, string, string][]).map(([l, v, c]) => (
              <div key={l} className="border-r border-bb-border flex flex-col justify-center items-center">
                <span className="bb-label">{l}</span>
                <span className={`num font-bold text-lg text-${c}`}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-hidden"><OrdersPanel /></div>
      </div>
      <div className="border-l border-bb-border overflow-hidden flex-shrink-0" style={{ width: "30%", minWidth: 260 }}>
        <PositionsPanel />
      </div>
    </>
  );
}

function AnalyticsView({ wsConnected, simRunning }: { wsConnected: boolean; simRunning: boolean }) {
  const { stats, logs } = useTradingStore((s) => ({ stats: s.stats, logs: s.logs }));

  const LOG_COLORS: Record<string, string> = {
    DEBUG:    "text-bb-muted",
    INFO:     "text-bb-dim",
    WARNING:  "text-neon-yellow",
    ERROR:    "text-bb-red",
    CRITICAL: "text-bb-red font-bold",
  };
  const LOG_PFX: Record<string, string> = {
    DEBUG: "DBG", INFO: "INF", WARNING: "WRN", ERROR: "ERR", CRITICAL: "CRT",
  };

  return (
    <>
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        {/* Stats grid */}
        <div className="border-b border-bb-border flex-shrink-0" style={{ height: "22%" }}>
          <div className="panel-header">SYSTEM ANALYTICS</div>
          <div className="grid grid-cols-4 gap-px bg-bb-border" style={{ height: "calc(100% - 24px)" }}>
            {([
              ["SIGNALS",  String(stats.signals_generated),   "bb-cyan" ],
              ["ORDERS",   String(stats.orders_submitted),     "bb-green"],
              ["DRY RUN",  String(stats.orders_dry_run),       "bb-amber"],
              ["REJECTED", String(stats.orders_rejected),      "bb-red"  ],
              ["API COST", `$${stats.api_cost_usd.toFixed(2)}`, "bb-cyan"],
              ["API CALLS",String(stats.api_calls),            "bb-dim"  ],
              ["BRIER 7D", stats.brier_score ? stats.brier_score.toFixed(3) : "n/a",
                           stats.brier_score && stats.brier_score < 0.25 ? "bb-green" : "bb-yellow"],
              ["UPTIME",   formatUptime(stats.uptime_s),       "bb-dim"  ],
            ] as [string, string, string][]).map(([l, v, c]) => (
              <div key={l} className="bg-bb-surface flex flex-col justify-center items-center gap-1">
                <span className="bb-label text-bb-amber">{l}</span>
                <span className={`num font-bold text-sm text-${c}`}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* System log */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="panel-header">
            <span>SYSTEM LOG</span>
            <div className="flex items-center gap-3">
              <span className={clsx("text-2xs", wsConnected ? "text-bb-green" : "text-bb-red")}>
                {wsConnected ? "● WS LIVE" : "● WS OFFLINE"}
              </span>
              <span className={clsx("text-2xs", simRunning ? "text-bb-amber" : "text-bb-muted")}>
                {simRunning ? "● SIM ON" : "○ SIM OFF"}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto font-mono">
            {logs.slice(0, 60).map((log) => (
              <div key={log.id} className={clsx(
                "flex items-start gap-2 px-2 py-0.5 border-b border-bb-border/40 text-2xs",
                LOG_COLORS[log.level],
              )}>
                <span className="text-bb-muted num flex-shrink-0">
                  {new Date(log.ts).toLocaleTimeString("en-US", { hour12: false })}
                </span>
                <span className="text-bb-amber flex-shrink-0 w-8">[{LOG_PFX[log.level]}]</span>
                <span className="flex-1">{log.message}</span>
              </div>
            ))}
            {logs.length === 0 && (
              <div className="text-bb-muted text-2xs p-4 text-center">No log entries</div>
            )}
          </div>
        </div>
      </div>

      <div className="border-l border-bb-border overflow-hidden flex-shrink-0" style={{ width: "38%", minWidth: 280 }}>
        <ChartPanel />
      </div>
    </>
  );
}

function ArbView() {
  return (
    <>
      <div className="flex-1 overflow-hidden border-r border-bb-border">
        <ArbitragePanel />
      </div>
      <div className="flex flex-col overflow-hidden flex-shrink-0 border-l border-bb-border" style={{ width: "30%", minWidth: 260 }}>
        <div style={{ height: "48%" }} className="border-b border-bb-border"><RiskPanel /></div>
        <div className="flex-1 overflow-hidden"><SignalFeed /></div>
      </div>
    </>
  );
}

function MiroFishView() {
  return (
    <div className="flex-1 overflow-auto">
      <MiroFishDashboard />
    </div>
  );
}

// ── Breadcrumb bar ────────────────────────────────────────────────────────────

function BreadcrumbBar({ activeView, onViewChange }: { activeView: View; onViewChange: (v: View) => void }) {
  const [clock, setClock] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(0, 19).replace("T", " "));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center justify-between flex-shrink-0 border-b border-bb-border"
         style={{ height: 24, background: "#050505" }}>
      <div className="flex items-center h-full">
        {/* Brand badge — links back to AXIOM home */}
        <Link href="/" title="Back to AXIOM home"
              className="flex items-center h-full px-4 border-r border-bb-border flex-shrink-0 hover:opacity-80 transition-opacity"
              style={{ background: "var(--bb-amber)" }}>
          <span style={{ color: "#0b0d12", fontWeight: 800, fontSize: 11, letterSpacing: "0.18em" }}>◂ POLY-HFT</span>
        </Link>
        {/* Nav tabs */}
        <div className="flex items-center h-full">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => onViewChange(v.id)}
              className={clsx(
                "h-full px-3 num transition-colors border-r border-bb-border/50",
                activeView === v.id
                  ? "text-bb-yellow bg-bb-hover"
                  : "text-bb-muted hover:text-bb-dim hover:bg-bb-hover",
              )}
              style={{ fontSize: 10, letterSpacing: "0.06em" }}
            >
              <span style={{ color: "var(--bb-amber)", fontSize: 9 }}>{v.key})</span>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {/* UTC clock */}
      <div className="flex items-center gap-3 px-4 h-full border-l border-bb-border flex-shrink-0">
        <span style={{ color: "var(--bb-dim)", fontSize: 9, letterSpacing: "0.1em" }}>UTC</span>
        <span className="num" style={{ color: "var(--bb-yellow)", fontSize: 10 }}>
          {clock ?? "——:——:——"}
        </span>
      </div>
    </div>
  );
}

// ── Security / info header ────────────────────────────────────────────────────

function SecurityBar({ killActive }: { killActive: boolean }) {
  const { stats, risk, market } = useTradingStore((s) => ({
    stats:  s.stats,
    risk:   s.risk,
    market: s.selectedMarket,
  }));

  return (
    <div className="flex items-center flex-shrink-0 border-b border-bb-border overflow-hidden"
         style={{ height: 32, background: "#080808", padding: "0 10px" }}>
      {/* Security identifier */}
      <div className="flex items-center gap-2 border-r border-bb-border/50 flex-shrink-0"
           style={{ height: "100%", paddingRight: 12, marginRight: 0 }}>
        <span className="num truncate" style={{ color: "var(--bb-yellow)", fontWeight: 700, fontSize: 11, maxWidth: 280 }}>
          {market ? market.question.slice(0, 42) : "NO MARKET SELECTED"}
        </span>
        {market?.linked_asset && (
          <span style={{ color: "var(--bb-amber)", fontSize: 9 }}>[{market.linked_asset}]</span>
        )}
        <span style={{ color: "var(--bb-muted)", fontSize: 9 }}>YN COND</span>
      </div>

      {/* Live field:value pairs */}
      <div className="flex items-center flex-1 overflow-hidden" style={{ height: "100%" }}>
        <BBField label="YES"      value={market ? `${(market.yes_price * 100).toFixed(2)}¢` : "—"} color="green" />
        <BBField label="NO"       value={market ? `${(market.no_price  * 100).toFixed(2)}¢` : "—"} color="red"   />
        <BBField label="VOL"      value={market ? `$${(market.volume / 1000).toFixed(0)}K`   : "—"}               />
        <BBField label="BANKROLL" value={`$${risk.bankroll.toFixed(2)}`}
                 color={risk.bankroll >= risk.peak_bankroll * 0.92 ? "green" : "red"} />
        <BBField label="D-P&L"    value={`${risk.daily_loss > 0 ? "-" : "+"}$${Math.abs(risk.daily_loss).toFixed(2)}`}
                 color={risk.daily_loss > 0 ? "red" : "green"} />
        <BBField label="BRIER-7D" value={stats.brier_score ? stats.brier_score.toFixed(3) : "n/a"}
                 color={!stats.brier_score || stats.brier_score < 0.25 ? "green" : "red"} />
        <BBField label="SIGNALS"  value={String(stats.signals_generated)} color="cyan"  />
        <BBField label="COST"     value={`$${stats.api_cost_usd.toFixed(2)}`}            color="amber" />
        <BBField label="MODE"     value={stats.orders_dry_run > 0 ? "DRY" : "LIVE"}
                 color={stats.orders_dry_run > 0 ? "amber" : "green"} />
      </div>

      {killActive && (
        <div className="flex items-center flex-shrink-0 pl-3 border-l border-bb-border/50">
          <span className="animate-blink text-bb-red font-bold" style={{ fontSize: 10, letterSpacing: "0.1em" }}>
            ⛔ KILL ACTIVE
          </span>
        </div>
      )}
    </div>
  );
}

const VALUE_COLORS: Record<string, string> = {
  green:  "var(--bb-green)",
  red:    "var(--bb-red)",
  cyan:   "var(--bb-cyan)",
  amber:  "var(--bb-amber)",
  yellow: "var(--bb-yellow)",
};

function BBField({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0 border-r border-bb-border/40"
         style={{ padding: "0 10px", height: "100%" }}>
      <span style={{ color: "var(--bb-amber)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {label}
      </span>
      <span className="num" style={{
        color: color ? (VALUE_COLORS[color] ?? color) : "var(--bb-white)",
        fontSize: 11,
        fontWeight: 600,
      }}>
        {value}
      </span>
    </div>
  );
}

// ── F-key bar ─────────────────────────────────────────────────────────────────

function FunctionKeyBar({ activeView, killActive, killConfirm, simRunning, wsConnected, onFnKey }: {
  activeView:  View;
  killActive:  boolean;
  killConfirm: boolean;
  simRunning:  boolean;
  wsConnected: boolean;
  onFnKey:     (id: string) => void;
}) {
  const { stats, workerHealth } = useTradingStore((s) => ({
    stats:        s.stats,
    workerHealth: s.workerHealth,
  }));

  const VIEW_TO_FN: Record<View, string> = {
    markets:   "markets",
    signals:   "signals",
    risk:      "risk",
    pnl:       "pnl",
    analytics: "analytics",
    arb:       "arb",
    mirofish:  "mirofish",
  };

  return (
    <div className="bb-fnbar">
      {FN_KEYS.map(({ key, label, id }) => {
        const isKill   = id === "kill";
        const isSim    = id === "sim";
        const isActive = VIEW_TO_FN[activeView] === id || (isKill && killConfirm) || (isSim && simRunning);

        return (
          <button key={key} className="bb-fn" onClick={() => onFnKey(id)}>
            <span className="bb-fn-key" style={
              isKill && (killActive || killConfirm)
                ? { background: killActive ? "var(--bb-red)" : "var(--bb-yellow)", color: "#0b0d12" }
                : {}
            }>
              {key}
            </span>
            <span className="bb-fn-label" style={
              isActive
                ? { color: "var(--bb-yellow)" }
                : isKill && killActive
                ? { color: "var(--bb-red)" }
                : {}
            }>
              {isKill && killActive ? "RESUME" : isKill && killConfirm ? "CONFIRM?" : isSim && simRunning ? "SIM ON" : label}
            </span>
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* Worker health dots */}
      <div className="flex items-center gap-2 px-2 border-l border-bb-border" style={{ height: "100%" }}>
        {(["ingestion", "signal", "execution", "risk"] as const).map((w) => {
          const age = (Date.now() - ((workerHealth as unknown as Record<string, number>)[w] ?? 0)) / 1000;
          const col = age < 30 ? "var(--bb-green)" : age < 60 ? "var(--bb-yellow)" : "var(--bb-red)";
          return (
            <div key={w} className="flex flex-col items-center" style={{ gap: 1 }}>
              <div className="animate-pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: col }} />
              <span style={{ color: col, fontSize: 7 }}>{w.slice(0, 3).toUpperCase()}</span>
            </div>
          );
        })}
      </div>

      {/* WS / SIM status */}
      <div className="flex items-center gap-4 px-3 border-l border-bb-border" style={{ height: "100%" }}>
        <div className="flex items-center gap-1.5">
          <div className={wsConnected ? "animate-pulse-dot" : "animate-blink"}
               style={{ width: 5, height: 5, borderRadius: "50%", background: wsConnected ? "var(--bb-green)" : "var(--bb-red)" }} />
          <span style={{ color: wsConnected ? "var(--bb-green)" : "var(--bb-red)", fontSize: 9 }}>
            {wsConnected ? `WS ${stats.ws_latency_ms}ms` : "WS OFFLINE"}
          </span>
        </div>
        {simRunning && (
          <span style={{ color: "var(--bb-amber)", fontSize: 9, letterSpacing: "0.08em" }}>● SIM</span>
        )}
      </div>

      {/* Kill / uptime / mode */}
      <div className="flex items-center gap-4 px-3 border-l border-bb-border" style={{ height: "100%" }}>
        <span
          className={killActive ? "animate-blink" : ""}
          style={{ color: killActive ? "var(--bb-red)" : "var(--bb-muted)", fontSize: 9, letterSpacing: "0.08em" }}
        >
          {killActive ? "⛔ KILLED" : "KILL OFF"}
        </span>
        <span className="num" style={{ color: "var(--bb-muted)", fontSize: 9 }}>
          {formatUptime(stats.uptime_s)}
        </span>
        <span style={{
          color: stats.orders_dry_run > 0 ? "var(--bb-amber)" : "var(--bb-green)",
          fontSize: 9,
          fontWeight: 700,
        }}>
          {stats.orders_dry_run > 0 ? "DRY" : "LIVE"}
        </span>
      </div>
    </div>
  );
}

// ── Help overlay ──────────────────────────────────────────────────────────────

const HELP_ENTRIES: [string, string][] = [
  ["1",   "Markets view — orderbook + chart + positions"],
  ["2",   "Signals view — signal feed + chart"],
  ["3",   "Risk view — risk dashboard + orders"],
  ["4",   "P&L view — bankroll summary + orders + positions"],
  ["5",   "Analytics view — system stats + full log"],
  ["6",   "Arbitrage view — cross-market opportunity scanner"],
  ["ESC", "Close overlay / cancel kill confirm"],
  ["F1",  "Toggle this help overlay"],
  ["F2",  "Jump to Orders (P&L view)"],
  ["F3",  "Jump to Signals view"],
  ["F4",  "Jump to Risk view"],
  ["F5",  "Jump to P&L view"],
  ["F6",  "Jump to Markets view"],
  ["F7",  "Jump to Analytics view"],
  ["F8",  "Kill switch — press twice within 5 s to confirm"],
  ["F9",  "Jump to Arbitrage scanner"],
  ["F10", "Toggle mock data simulation on/off"],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
         style={{ background: "rgba(0,0,0,0.85)" }}
         onClick={onClose}>
      <div className="border border-bb-amber bg-bb-surface"
           style={{ minWidth: 460 }}
           onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span>KEYBOARD SHORTCUTS — POLY-HFT TERMINAL</span>
          <button onClick={onClose} className="text-bb-dim hover:text-bb-white text-xs">ESC</button>
        </div>
        <div className="p-3">
          {HELP_ENTRIES.map(([k, v]) => (
            <div key={k} className="flex items-start gap-4 py-1 border-b border-bb-border/40 text-xs">
              <span className="num font-bold text-bb-amber flex-shrink-0" style={{ minWidth: 36 }}>{k}</span>
              <span className="text-bb-dim">{v}</span>
            </div>
          ))}
          <p className="text-bb-muted mt-3 text-2xs">Press ESC or click outside to close.</p>
        </div>
      </div>
    </div>
  );
}

// ── Util ──────────────────────────────────────────────────────────────────────

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m}m`;
}

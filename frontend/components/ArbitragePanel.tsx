"use client";

import { useTradingStore } from "@/lib/store";
import type { ArbOpportunity } from "@/lib/types";
import clsx from "clsx";

// ── Color helpers ─────────────────────────────────────────────────────────────

function edgeColor(edge: number): string {
  if (edge >= 0.08) return "var(--bb-green)";
  if (edge >= 0.04) return "var(--bb-yellow)";
  return "var(--bb-amber)";
}

function probColor(model: number, market: number): string {
  const gap = model - market;
  if (gap > 0.06)  return "var(--bb-green)";
  if (gap > 0.02)  return "var(--bb-yellow)";
  if (gap < -0.06) return "var(--bb-red)";
  return "var(--bb-amber)";
}

// ── Crypto Binary Row ─────────────────────────────────────────────────────────
// Full binary option display: asset, strike, spot, moneyness bar, σ, τ, model vs mkt, edge

function CryptoBinaryRow({ opp }: { opp: ArbOpportunity }) {
  const spot   = opp.spot_price   ?? 0;
  const strike = opp.strike_price ?? 0;
  const sigma  = opp.realized_vol ?? 0;
  const tau    = opp.tau_hours    ?? 0;
  const modelP = opp.model_prob   ?? opp.confidence;
  const mktP   = opp.market_a_price;
  const ec     = edgeColor(opp.edge);
  const pc     = probColor(modelP, mktP);

  // Moneyness: how far spot is from strike as % of strike
  const moneyness  = strike > 0 ? ((spot - strike) / strike) * 100 : 0;
  const isAbove    = opp.market_a_side === "YES";

  // Parse asset from question heuristic or reason
  const assetMatch = opp.reason.match(/^([A-Z]+)\s/);
  const asset      = assetMatch ? assetMatch[1] : "CRYPTO";

  // Moneyness bar: 50% = at the money, sides = ITM/OTM
  const barPct = Math.min(100, Math.max(0, 50 + moneyness * 5));

  return (
    <div
      className="border-b border-bb-border/40 hover:bg-bb-hover transition-colors cursor-default"
      style={{ padding: "6px 8px" }}
    >
      {/* ── Row 1: Header ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-0" style={{ fontSize: 10 }}>
        {/* Strategy badge */}
        <span
          className="flex-shrink-0 num font-bold"
          style={{ color: "var(--bb-cyan)", width: 62, fontSize: 9, letterSpacing: "0.06em" }}
        >
          BOPT
        </span>
        {/* Asset + direction */}
        <span className="font-bold flex-shrink-0" style={{ color: "var(--bb-yellow)", fontSize: 11, minWidth: 64 }}>
          {asset} {isAbove ? "▲ ABOVE" : "▼ BELOW"}
        </span>
        {/* Strike */}
        <span className="flex-shrink-0 num" style={{ color: "var(--bb-dim)", fontSize: 10, minWidth: 80 }}>
          K&nbsp;${strike >= 1000 ? `${(strike/1000).toFixed(0)}K` : strike.toFixed(0)}
        </span>
        <div style={{ flex: 1 }} />
        {/* Edge */}
        <span className="num font-bold flex-shrink-0" style={{ color: ec, minWidth: 48, textAlign: "right", fontSize: 12 }}>
          {opp.edge >= 0 ? "+" : ""}{(opp.edge * 100).toFixed(1)}¢
        </span>
        {/* Confidence */}
        <span className="num flex-shrink-0 text-bb-dim" style={{ minWidth: 38, textAlign: "right", fontSize: 9 }}>
          {(opp.confidence * 100).toFixed(0)}%
        </span>
      </div>

      {/* ── Row 2: Option details ───────────────────────────────────────── */}
      <div className="flex items-center gap-3 num" style={{ paddingLeft: 62, marginTop: 3, fontSize: 9 }}>
        {/* Spot vs strike */}
        <span style={{ color: spot >= strike ? "var(--bb-green)" : "var(--bb-red)" }}>
          SPOT ${spot >= 1000 ? `${(spot/1000).toFixed(2)}K` : spot.toFixed(2)}
        </span>
        <span className="text-bb-muted">|</span>
        {/* Vol */}
        <span style={{ color: "var(--bb-cyan)" }}>
          σ {(sigma * 100).toFixed(0)}%
        </span>
        <span className="text-bb-muted">|</span>
        {/* Time to expiry */}
        <span style={{ color: tau < 0.5 ? "var(--bb-yellow)" : "var(--bb-dim)" }}>
          τ {tau < 1 ? `${(tau * 60).toFixed(0)}m` : `${tau.toFixed(1)}h`}
        </span>
        <span className="text-bb-muted">|</span>
        {/* Model vs Market probability */}
        <span style={{ color: pc }}>
          MODEL {(modelP * 100).toFixed(1)}%
        </span>
        <span style={{ color: "var(--bb-dim)" }}>
          MKT {(mktP * 100).toFixed(1)}%
        </span>
      </div>

      {/* ── Row 3: Moneyness bar ────────────────────────────────────────── */}
      <div style={{ paddingLeft: 62, marginTop: 4 }}>
        <div
          className="relative"
          style={{ height: 4, background: "var(--bb-border)", borderRadius: 2, overflow: "hidden" }}
        >
          {/* Center line (at the money) */}
          <div
            className="absolute"
            style={{ left: "50%", top: 0, width: 1, height: "100%", background: "var(--bb-muted)", opacity: 0.5 }}
          />
          {/* Spot indicator */}
          <div
            className="absolute"
            style={{
              left: `${barPct}%`,
              top: 0,
              width: 3,
              height: "100%",
              background: spot >= strike ? "var(--bb-green)" : "var(--bb-red)",
              borderRadius: 1,
              transform: "translateX(-50%)",
            }}
          />
          {/* Fill from center to spot */}
          <div
            style={{
              position: "absolute",
              left: `${Math.min(50, barPct)}%`,
              width: `${Math.abs(barPct - 50)}%`,
              height: "100%",
              background: spot >= strike ? "rgba(0,255,128,0.2)" : "rgba(255,80,80,0.2)",
            }}
          />
        </div>
        <div className="flex justify-between num" style={{ fontSize: 7, marginTop: 1, color: "var(--bb-muted)" }}>
          <span>OTM</span>
          <span>ATM</span>
          <span>ITM</span>
        </div>
      </div>

      {/* ── Row 4: Action ───────────────────────────────────────────────── */}
      <div style={{ paddingLeft: 62, color: "var(--bb-amber)", fontSize: 9, marginTop: 2 }}>
        ▶ {opp.action}
      </div>
    </div>
  );
}

// ── Standard Arb Row ─────────────────────────────────────────────────────────

const STRATEGY_LABEL: Record<string, string> = {
  threshold_cascade:    "CASCADE",
  complement:           "COMPLEM",
  resolution_proximity: "RESOLTN",
  crypto_binary:        "BOPT",
};

const STRATEGY_COLOR: Record<string, string> = {
  threshold_cascade:    "var(--bb-cyan)",
  complement:           "#CC44CC",
  resolution_proximity: "var(--bb-green)",
  crypto_binary:        "var(--bb-cyan)",
};

function ArbRow({ opp }: { opp: ArbOpportunity }) {
  if (opp.strategy === "crypto_binary") return <CryptoBinaryRow opp={opp} />;

  const col    = STRATEGY_COLOR[opp.strategy] ?? "var(--bb-dim)";
  const ec     = edgeColor(opp.edge);
  const hasLegB = opp.strategy !== "resolution_proximity";

  return (
    <div className="border-b border-bb-border/40 hover:bg-bb-hover transition-colors cursor-default" style={{ padding: "5px 8px" }}>
      <div className="flex items-center gap-0" style={{ fontSize: 10 }}>
        <span className="flex-shrink-0 num font-bold" style={{ color: col, width: 62, fontSize: 9, letterSpacing: "0.06em" }}>
          {STRATEGY_LABEL[opp.strategy] ?? opp.strategy.slice(0, 7).toUpperCase()}
        </span>
        <span className="flex-1 truncate text-bb-white" title={opp.market_a_question}>
          {opp.market_a_question.slice(0, 42)}
        </span>
        {hasLegB && <span className="text-bb-dim flex-shrink-0 px-2" style={{ fontSize: 9 }}>↔</span>}
        {hasLegB && opp.market_b_question && (
          <span className="flex-1 truncate text-bb-dim" title={opp.market_b_question}>
            {opp.market_b_question.slice(0, 38)}
          </span>
        )}
        <span className="num font-bold flex-shrink-0 text-right" style={{ color: ec, minWidth: 44, fontSize: 11 }}>
          +{(opp.edge * 100).toFixed(1)}¢
        </span>
        <span className="num flex-shrink-0 text-right text-bb-dim" style={{ minWidth: 36, fontSize: 9 }}>
          {(opp.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div style={{ paddingLeft: 62, color: "var(--bb-amber)", fontSize: 9, marginTop: 2 }}>
        ▶ {opp.action}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function ArbitragePanel() {
  const opps = useTradingStore((s) => s.arbOpportunities);

  const binaryOpps   = opps.filter(o => o.strategy === "crypto_binary");
  const cascade      = opps.filter(o => o.strategy === "threshold_cascade");
  const complement   = opps.filter(o => o.strategy === "complement");
  const resolution   = opps.filter(o => o.strategy === "resolution_proximity");

  // Sort: crypto binary first (primary strategy), then rest by edge desc
  const sorted = [
    ...binaryOpps.sort((a, b) => b.edge - a.edge),
    ...[...cascade, ...complement, ...resolution].sort((a, b) => b.edge - a.edge),
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "var(--bb-panel)" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="panel-header">
        <span>ARBITRAGE SCANNER</span>
        <div className="flex items-center gap-3">
          <span style={{ color: binaryOpps.length > 0 ? "var(--bb-cyan)"   : "var(--bb-muted)", fontSize: 9 }}>
            BOPT {binaryOpps.length}
          </span>
          <span style={{ color: cascade.length    > 0 ? "var(--bb-cyan)"   : "var(--bb-muted)", fontSize: 9 }}>
            CASCADE {cascade.length}
          </span>
          <span style={{ color: complement.length > 0 ? "#CC44CC"          : "var(--bb-muted)", fontSize: 9 }}>
            COMPLEM {complement.length}
          </span>
          <span style={{ color: resolution.length > 0 ? "var(--bb-green)"  : "var(--bb-muted)", fontSize: 9 }}>
            RESOLTN {resolution.length}
          </span>
        </div>
      </div>

      {/* ── Column header ──────────────────────────────────────────────────── */}
      <div
        className="flex items-center flex-shrink-0 border-b border-bb-border"
        style={{ background: "#0a0a0a", padding: "2px 8px", fontSize: 9 }}
      >
        <span className="bb-label" style={{ width: 62 }}>TYPE</span>
        <span className="bb-label flex-1">MARKET / INSTRUMENT</span>
        <span className="bb-label" style={{ minWidth: 48, textAlign: "right" }}>EDGE</span>
        <span className="bb-label" style={{ minWidth: 38, textAlign: "right" }}>CONF</span>
      </div>

      {/* ── Rows ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div
              className="animate-pulse-dot"
              style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--bb-cyan)" }}
            />
            <span className="text-bb-dim" style={{ fontSize: 10, letterSpacing: "0.12em" }}>
              SCANNING MARKETS…
            </span>
            <span className="text-bb-muted" style={{ fontSize: 9 }}>
              Binary option model running every 15s · Structural scan every 60s
            </span>
          </div>
        ) : (
          sorted.map(opp => <ArbRow key={opp.id} opp={opp} />)
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-4 flex-shrink-0 border-t border-bb-border px-2"
        style={{ height: 20, background: "#0a0a0a", fontSize: 9 }}
      >
        <span className="text-bb-dim">BINARY OPTION · CASCADE · COMPLEMENT · RESOLUTION</span>
        <div style={{ flex: 1 }} />
        <span className="text-bb-muted">BOPT: 15s</span>
        <span className="text-bb-muted">STRUCT: 60s</span>
      </div>
    </div>
  );
}

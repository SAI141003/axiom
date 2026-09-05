"use client";

import { useState } from "react";
import Link from "next/link";
import TopNav from "@/components/TopNav";

export const AI_FEATURES = [
  { id: "stock-analyst", href: "/ai/stock-analyst", icon: "◆", title: "AI STOCK ANALYST",
    desc: "Live price, vol, VaR, SMA + news → bull/bear thesis, target range, conviction score.",
    placeholder: "NVDA", inputLabel: "Ticker", accent: "var(--hud-cyan)", glow: "glow-cyan" },
  { id: "market-intel", href: "/ai/market-intel", icon: "◉", title: "AI MARKET INTELLIGENCE",
    desc: "Watchlist headlines scanned — flags only what materially changes your thesis.",
    placeholder: "NVDA, TSLA, BTC-USD", inputLabel: "Watchlist (comma-separated)", accent: "var(--hud-violet)", glow: "glow-violet" },
  { id: "macro", href: "/ai/macro", icon: "◈", title: "AI MACRO ANALYST",
    desc: "Live SPX, NDX, 10Y, DXY, gold, oil, BTC, VIX → tight morning brief for your book.",
    placeholder: "long US tech + crypto, small gold hedge", inputLabel: "Your portfolio (free text)", accent: "var(--hud-amber)", glow: "glow-amber" },
  { id: "risk-engine", href: "/ai/risk-engine", icon: "▣", title: "AI RISK ENGINE",
    desc: "Portfolio VaR/CVaR from 1y of live returns + stress tests + cheapest hedges.",
    placeholder: "NVDA 40\nMSFT 30\nBTC-USD 30", inputLabel: "Positions (TICKER WEIGHT per line)", accent: "var(--hud-red)", glow: "glow-red", multiline: true },
  { id: "alpha-hunter", href: "/ai/alpha-hunter", icon: "▲", title: "AI ALPHA HUNTER",
    desc: "30-name universe scanned live for vol-normalized anomalies — top 10 ranked by edge.",
    placeholder: "", inputLabel: "", accent: "var(--hud-green)", glow: "glow-green", noInput: true },
] as const;

export type AiFeatureId = (typeof AI_FEATURES)[number]["id"];

export default function AiTool({ featureId }: { featureId: AiFeatureId }) {
  const feature = AI_FEATURES.find((f) => f.id === featureId)!;
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  const run = async () => {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feature: feature.id, input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        {/* Feature switcher */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {AI_FEATURES.map((f) => (
            <Link key={f.id} href={f.href}
                  className={`hud-chip transition-all ${f.id === feature.id ? "hud-nav-active" : ""}`}
                  style={{ color: f.id === feature.id ? undefined : "var(--hud-muted)" }}>
              {f.icon} {f.title.replace("AI ", "")}
            </Link>
          ))}
        </div>

        <h1 className={`text-xl font-bold tracking-[0.2em] ${feature.glow}`}>
          {feature.icon} {feature.title}
        </h1>
        <p className="text-xs mt-1 mb-6" style={{ color: "var(--hud-muted)" }}>{feature.desc}</p>

        {/* Input */}
        <div className="hud-panel hud-panel-static p-4 mb-6">
          {!("noInput" in feature && feature.noInput) && (
            <>
              <label className="text-[10px] tracking-widest block mb-2" style={{ color: "var(--hud-muted)" }}>
                {feature.inputLabel}
              </label>
              {"multiline" in feature && feature.multiline ? (
                <textarea
                  value={input} onChange={(e) => setInput(e.target.value)}
                  placeholder={feature.placeholder} rows={4}
                  className="w-full px-3 py-2 text-xs outline-none mb-3"
                  style={{ background: "rgba(6,9,19,0.8)", border: "1px solid var(--hud-border)", color: "var(--hud-text)" }}
                />
              ) : (
                <input
                  value={input} onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !running && run()}
                  placeholder={feature.placeholder}
                  className="w-full px-3 py-2 text-xs outline-none mb-3"
                  style={{ background: "rgba(6,9,19,0.8)", border: "1px solid var(--hud-border)", color: "var(--hud-text)" }}
                />
              )}
            </>
          )}
          <button onClick={run} disabled={running}
                  className="hud-chip hud-nav-active"
                  style={{ cursor: running ? "wait" : "pointer", height: 34, opacity: running ? 0.6 : 1 }}>
            {running ? "⟳ FETCHING LIVE DATA + RUNNING CLAUDE…" : "▶ RUN ANALYSIS"}
          </button>
        </div>

        {error && (
          <div className="hud-panel hud-panel-static p-4 mb-6 text-xs" style={{ color: "var(--hud-red)" }}>
            ⚠ {error}
          </div>
        )}

        {result && (
          <>
            {/* Live data echo */}
            {(result.live || result.snapshot || result.scan || result.portfolio) && (
              <div className="hud-panel hud-panel-static p-4 mb-4 overflow-x-auto">
                <div className="text-[10px] tracking-widest mb-2 glow-cyan">LIVE DATA USED</div>
                <pre className="text-[10px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--hud-muted)" }}>
                  {JSON.stringify(result.live ?? result.snapshot ?? result.scan ?? result.portfolio, null, 2)}
                </pre>
              </div>
            )}
            {/* Bull/Bear debate (TradingAgents-style, stock analyst only) */}
            {result.debate && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="hud-panel hud-panel-static p-4">
                  <div className="text-[10px] tracking-widest mb-2 glow-green">🐂 BULL RESEARCHER</div>
                  <div className="text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--hud-text)" }}>
                    {result.debate.bull}
                  </div>
                </div>
                <div className="hud-panel hud-panel-static p-4">
                  <div className="text-[10px] tracking-widest mb-2 glow-red">🐻 BEAR RESEARCHER</div>
                  <div className="text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--hud-text)" }}>
                    {result.debate.bear}
                  </div>
                </div>
              </div>
            )}
            {/* Final analysis / fund manager verdict */}
            <div className="hud-panel hud-panel-static p-5">
              <div className={`text-[10px] tracking-widest mb-3 ${feature.glow}`}>
                {result.debate ? "⚖ FUND MANAGER VERDICT" : "CLAUDE ANALYSIS"}
              </div>
              <div className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: "var(--hud-text)" }}>
                {result.analysis}
              </div>
            </div>
          </>
        )}

        <p className="text-[10px] mt-6 pb-8" style={{ color: "var(--hud-muted)" }}>
          Live data: Yahoo Finance · Model: Claude Haiku 4.5 · Educational only, not financial advice.
        </p>
      </main>
    </div>
  );
}

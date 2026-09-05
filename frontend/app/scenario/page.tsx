"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import TopNav from "@/components/TopNav";

/**
 * COMPANY SCENARIO — quantum-inspired forecasting on REAL market data.
 * Superposition (20k Monte-Carlo futures) → interference (live evidence amplifies
 * the aligned branch) → measurement (calibrated P(up) + bull/base/bear tree).
 * Every forecast is Brier-scored against reality. Nothing mocked.
 */

const EXAMPLES = ["NVDA", "TSLA", "AAPL", "AMD", "MSFT", "GOOGL"];
function pct(v: number) { return `${(v * 100).toFixed(0)}%`; }

export default function ScenarioPage() {
  const [sym, setSym] = useState("");
  const [hz, setHz] = useState(21);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState("");
  const [track, setTrack] = useState<any>(null);

  useEffect(() => {
    fetch("/api/scenario").then((x) => x.json()).then(setTrack).catch(() => {});
  }, [r]);

  const ask = async (ticker: string) => {
    const s = ticker.trim().toUpperCase();
    if (!s || busy) return;
    setBusy(true); setErr(""); setR(null);
    try {
      const res = await fetch("/api/scenario", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: s, horizon: hz }),
      });
      const d = await res.json();
      if (d.error) setErr(d.error); else setR(d);
    } catch { setErr("scenario engine unreachable"); }
    setBusy(false);
  };

  const [exec, setExec] = useState<any>(null);
  const executeSignal = async (inst: string) => {
    if (!r) return;
    setExec({ pending: true });
    try {
      const res = await fetch("/api/broker/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: r.symbol, direction: r.verdict,
          conviction: Math.abs(r.p_up - 0.5) * 2, instrument: inst }),
      });
      setExec(await res.json());
    } catch { setExec({ status: "error", detail: "unreachable" }); }
  };

  const up = r && r.verdict === "UP";
  const vColor = r ? (up ? "var(--hud-green)" : "#f87171") : "";

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">◇ COMPANY SCENARIO</h1>
          <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
            superposition of 20,000 real-vol futures → interference of live evidence → measured verdict · Brier-scored
          </p>
        </motion.div>

        <TrackBadge track={track} />
        <BrokerStatus />

        <form onSubmit={(e) => { e.preventDefault(); ask(sym); }} className="flex gap-2 mb-3">
          <input value={sym} onChange={(e) => setSym(e.target.value)}
                 placeholder="ticker — NVDA, TSLA, AAPL …"
                 className="flex-1 px-4 py-3 text-sm rounded border bg-transparent uppercase"
                 style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }} />
          <select value={hz} onChange={(e) => setHz(Number(e.target.value))}
                  className="px-3 py-3 text-xs rounded border bg-transparent"
                  style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }}>
            <option value={5}>1 week</option>
            <option value={21}>1 month</option>
            <option value={63}>1 quarter</option>
          </select>
          <button type="submit" disabled={busy}
                  className="px-6 py-3 text-sm rounded border font-bold"
                  style={{ borderColor: "var(--hud-accent)", color: busy ? "var(--hud-muted)" : "var(--hud-accent)" }}>
            {busy ? "SIMULATING…" : "FORECAST"}
          </button>
        </form>
        <div className="flex gap-2 flex-wrap mb-8">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => { setSym(ex); ask(ex); }}
                    className="text-[10px] px-2 py-1 rounded border hover:opacity-80"
                    style={{ borderColor: "var(--hud-border)", color: "var(--hud-muted)" }}>{ex}</button>
          ))}
        </div>

        {busy && (
          <div className="text-center py-14 text-sm animate-pulse" style={{ color: "var(--hud-muted)" }}>
            collapsing 20,000 futures into one forecast…
          </div>
        )}
        {err && <div className="text-center py-8 text-sm" style={{ color: "#f87171" }}>⚠ {err}</div>}

        {r && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
            {/* verdict */}
            <div className="hud-panel hud-panel-static p-6 text-center">
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
                {r.symbol} · ${r.price} · {r.horizon_days}-DAY HORIZON · vol {r.realized_vol_annual}%/yr
              </div>
              <div className="text-5xl font-bold tracking-widest" style={{ color: vColor }}>{r.verdict}</div>
              <div className="text-2xl font-bold tabular-nums mt-2" style={{ color: "var(--hud-text)" }}>{pct(r.p_up)}</div>
              <div className="text-[11px] mt-1" style={{ color: "var(--hud-muted)" }}>{r.conviction} · P(up)</div>
              <div className="mt-3 h-2 rounded mx-auto" style={{ maxWidth: 420, background: "#1c2130" }}>
                <div className="h-full rounded" style={{ width: pct(r.p_up), background: vColor }} />
              </div>
              {/* route this forecast to the Canada-legal broker (paper unless activated) */}
              <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
                <button onClick={() => executeSignal("equity")}
                        className="text-[10px] px-3 py-1.5 rounded border hover:opacity-80 font-bold"
                        style={{ borderColor: "var(--hud-accent)", color: "var(--hud-accent)" }}>
                  ▸ TRADE STOCK (Questrade)
                </button>
                <button onClick={() => executeSignal("option")}
                        className="text-[10px] px-3 py-1.5 rounded border hover:opacity-80 font-bold"
                        style={{ borderColor: "var(--hud-border)", color: "var(--hud-muted)" }}>
                  ▸ TRADE OPTION
                </button>
              </div>
              {exec && (
                <div className="text-[10px] mt-2" style={{ color: exec.status === "filled" ? "var(--hud-green)" : exec.status === "error" ? "#f87171" : "var(--hud-muted)" }}>
                  {exec.pending ? "routing to broker…"
                    : `${(exec.status ?? "").toUpperCase()} — ${exec.detail ?? ""}${exec.instrument === "option" && exec.strike ? ` (${exec.right} ${exec.strike} exp ${exec.expiry})` : ""}`}
                </div>
              )}
            </div>

            {/* scenario tree */}
            <div className="hud-panel hud-panel-static p-4">
              <div className="text-[10px] tracking-widest mb-3" style={{ color: "var(--hud-muted)" }}>
                SCENARIO TREE — {r.n_paths.toLocaleString()} REAL-VOL FUTURES
              </div>
              {(["bull", "base", "bear"] as const).map((k) => {
                const s = r.scenarios[k];
                const col = k === "bull" ? "var(--hud-green)" : k === "bear" ? "#f87171" : "var(--hud-muted)";
                return (
                  <div key={k} className="flex items-center gap-3 py-1.5">
                    <span className="text-[11px] w-12 uppercase font-bold" style={{ color: col }}>{k}</span>
                    <span className="text-sm tabular-nums w-20" style={{ color: "var(--hud-text)" }}>${s.target}</span>
                    <span className="text-[11px] tabular-nums w-14" style={{ color: col }}>{s.pct >= 0 ? "+" : ""}{s.pct}%</span>
                    <div className="flex-1 h-3 rounded" style={{ background: "#1c2130" }}>
                      <div className="h-full rounded" style={{ width: pct(s.prob), background: col, opacity: 0.75 }} />
                    </div>
                    <span className="text-[10px] tabular-nums w-10 text-right" style={{ color: "var(--hud-muted)" }}>{pct(s.prob)}</span>
                  </div>
                );
              })}
            </div>

            {/* interference */}
            <div className="hud-panel hud-panel-static p-4">
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>
                INTERFERENCE — live evidence · raw MC {pct(r.mc_p_up_raw)} → measured {pct(r.p_up)}
              </div>
              {r.interference.map((i: any, k: number) => (
                <div key={k} className="text-[12px] py-1 flex items-center gap-2">
                  <span style={{ color: i.p >= 0.5 ? "var(--hud-green)" : "#f87171" }}>▸ {i.factor} {pct(i.p)}</span>
                  <span style={{ color: "var(--hud-muted)" }}>— {i.note}</span>
                </div>
              ))}
            </div>

            <div className="text-[10px] text-center pb-8" style={{ color: "var(--hud-muted)" }}>{r.honesty}</div>
          </motion.div>
        )}
      </main>
    </div>
  );
}

function TrackBadge({ track }: { track: any }) {
  if (!track) return null;
  const scored = track.resolved > 0;
  return (
    <div className="hud-panel hud-panel-static px-4 py-2 mb-4 flex items-center justify-between flex-wrap gap-3">
      <div>
        <div className="text-[10px] tracking-widest font-bold" style={{ color: "var(--hud-cyan)" }}>
          ⊙ TRACKED ACCURACY — SCORED vs REALITY
        </div>
        <div className="text-[8px]" style={{ color: "var(--hud-muted)" }}>
          {scored ? "Brier < 0.25 = skill beyond a coin flip" : "forecasts resolve at their horizon — record builds automatically"}
        </div>
      </div>
      {scored ? (
        <div className="flex gap-5 tabular-nums text-right">
          <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>ACCURACY</div>
            <div className="text-lg font-bold" style={{ color: "var(--hud-green)" }}>{pct(track.accuracy)}</div></div>
          <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>BRIER</div>
            <div className="text-lg font-bold" style={{ color: track.brier < 0.25 ? "var(--hud-green)" : "var(--hud-amber)" }}>{track.brier}</div></div>
          <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>SCORED</div>
            <div className="text-lg font-bold" style={{ color: "var(--hud-text)" }}>{track.resolved}</div></div>
        </div>
      ) : (
        <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>{track.pending ?? 0} forecasts pending resolution</div>
      )}
    </div>
  );
}

// ── Canada-legal execution adapter (Questrade) — status + activation path ─────
function BrokerStatus() {
  const [b, setB] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/broker/status").then((r) => r.json()).then(setB).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!b) return null;
  const connected = b.state === "connected";
  const paper = b.dry_run !== false;
  const dot = connected ? "var(--hud-green)" : b.configured ? "var(--hud-amber)" : "var(--hud-muted)";
  return (
    <div className="hud-panel hud-panel-static px-4 py-3 mb-4 font-mono">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, display: "inline-block" }} />
          <span className="text-[11px] tracking-widest font-bold" style={{ color: "var(--hud-text)" }}>
            LIVE EXECUTION — QUESTRADE (CANADA-LEGAL)
          </span>
          <span className="text-[9px] px-2 py-0.5 rounded" style={{
            color: paper ? "var(--hud-amber)" : "var(--hud-green)",
            background: paper ? "rgba(217,164,65,0.12)" : "rgba(52,211,153,0.12)" }}>
            {paper ? "PAPER" : "LIVE"}
          </span>
        </div>
        <div className="text-[10px] tabular-nums" style={{ color: "var(--hud-muted)" }}>
          ${b.max_order_usd}/order · ${b.daily_cap_usd}/day cap · spent today ${b.today_spend}
          {b.cash_cad != null && ` · cash CA$${b.cash_cad}`}
        </div>
      </div>
      <div className="text-[10px] mt-1" style={{ color: "var(--hud-muted)" }}>
        {connected
          ? `Connected · ${b.accounts} account(s) — the scenario/options signals can place real equity orders here.`
          : b.configured
            ? `Token present but ${b.state}.`
            : "Not live yet — add your Questrade API refresh token (QUESTRADE_REFRESH_TOKEN) + flip BROKER_DRY_RUN=false to activate. Same brain, a venue that serves Vancouver."}
      </div>
    </div>
  );
}

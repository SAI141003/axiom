"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

interface Cfg { stakeUsd: number; dailyCapUsd: number; dailyProfitTarget: number; stopLossUsd: number }
interface LiveToday { sent: number; spend: number; filled: number; rejected: number; blocked: number }

export default function LiveAccountPage() {
  const [balance, setBalance] = useState<number | null>(null);
  const [maxed, setMaxed] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [today, setToday] = useState<LiveToday | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [updated, setUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await fetch("/api/live/balance");
      if (!res.ok) return;
      const d = await res.json();
      setBalance(d.balance); setMaxed(d.allowancesMaxed);
      setDryRun(d.dryRun); setToday(d.liveToday); setCfg(d.config);
      setErr(d.err || ""); setUpdated(new Date());
    } finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);   // balance is a real CLOB call — 60s is plenty
    return () => clearInterval(id);
  }, []);

  const save = async () => {
    setMsg("");
    const body: Record<string, number> = {};
    const map: Record<string, string> = {
      LIVE_MICRO_USD: "stake", LIVE_DAILY_CAP_USD: "cap",
      LIVE_DAILY_PROFIT_TARGET: "target", LIVE_STOP_LOSS_USD: "stop",
    };
    for (const [envKey, k] of Object.entries(map)) {
      if (edit[k] !== undefined && edit[k] !== "") body[envKey] = parseFloat(edit[k]);
    }
    const res = await fetch("/api/live/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    setMsg(res.ok ? `✓ saved — ${d.note}` : `⚠ ${d.error}`);
    setEdit({});
    load();
  };

  const Knob = ({ label, k, current, unit, hint }: {
    label: string; k: string; current: number; unit: string; hint: string;
  }) => (
    <div className="hud-panel hud-panel-static p-4">
      <div className="text-[10px] tracking-[0.16em] mb-1" style={{ color: "var(--hud-muted)" }}>{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-xl font-bold tabular-nums" style={{ color: "var(--hud-text)" }}>
          {unit}{current}
        </span>
        <input
          value={edit[k] ?? ""}
          onChange={(e) => setEdit((s) => ({ ...s, [k]: e.target.value }))}
          placeholder="new…"
          className="w-20 px-2 py-1 text-xs outline-none tabular-nums ml-auto"
          style={{ background: "rgba(11,13,18,0.7)", border: "1px solid var(--hud-border)",
                   color: "var(--hud-text)", borderRadius: 8 }}
        />
      </div>
      <div className="text-[9px] mt-1.5 leading-relaxed" style={{ color: "var(--hud-muted)" }}>{hint}</div>
    </div>
  );

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-4xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.2em]">LIVE ACCOUNT</h1>
        <p className="text-xs mt-1 mb-6" style={{ color: "var(--hud-muted)" }}>
          Real Polymarket balance from the CLOB collateral view · trade sizing, stop-loss and the
          daily profit target that auto-halts the bot. {updated && `Updated ${updated.toLocaleTimeString()}.`}
        </p>

        {/* Balance + mode */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="hud-panel hud-panel-static px-4 py-3">
            <div className="text-[9px] tracking-[0.16em]" style={{ color: "var(--hud-muted)" }}>LIVE BALANCE (CLOB)</div>
            <div className="text-2xl font-bold tabular-nums mt-0.5" style={{ color: "var(--hud-green)" }}>
              {loading ? "…" : balance != null ? `$${balance.toFixed(2)}` : "—"}
            </div>
            <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>
              {maxed ? "allowances maxed ✓" : balance != null ? "check allowances" : err.slice(0, 40)}
            </div>
          </div>
          <div className="hud-panel hud-panel-static px-4 py-3">
            <div className="text-[9px] tracking-[0.16em]" style={{ color: "var(--hud-muted)" }}>TRADING MODE</div>
            <div className="text-lg font-bold mt-0.5" style={{ color: dryRun ? "var(--hud-amber)" : "var(--hud-red)" }}>
              {dryRun ? "DRY-RUN" : "⚡ LIVE"}
            </div>
            <LiveToggle dryRun={dryRun} onChange={(v) => setDryRun(v)} />
          </div>
          <div className="hud-panel hud-panel-static px-4 py-3">
            <div className="text-[9px] tracking-[0.16em]" style={{ color: "var(--hud-muted)" }}>LIVE SPEND TODAY</div>
            <div className="text-2xl font-bold tabular-nums mt-0.5" style={{ color: "var(--hud-accent)" }}>
              ${today?.spend?.toFixed(2) ?? "0.00"}
            </div>
            <div className="text-[9px]" style={{ color: "var(--hud-muted)" }}>
              of ${cfg?.dailyCapUsd ?? 10} daily cap
            </div>
          </div>
          <div className="hud-panel hud-panel-static px-4 py-3">
            <div className="text-[9px] tracking-[0.16em]" style={{ color: "var(--hud-muted)" }}>ORDERS TODAY</div>
            <div className="text-lg font-bold tabular-nums mt-0.5">
              <span style={{ color: "var(--hud-green)" }}>{today?.filled ?? 0} filled</span>
              <span style={{ color: "var(--hud-muted)" }}> · {today?.rejected ?? 0} rej · {today?.blocked ?? 0} blk</span>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="text-[10px] tracking-[0.18em] mb-2" style={{ color: "var(--hud-accent)" }}>
          RISK CONTROLS — applied on the very next trade decision
        </div>
        {cfg && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <Knob label="STAKE PER TRADE" k="stake" current={cfg.stakeUsd} unit="$"
                  hint="Each live order's size. Hard code ceiling $5 regardless of this setting." />
            <Knob label="DAILY SPEND CAP" k="cap" current={cfg.dailyCapUsd} unit="$"
                  hint="Total live spend allowed per day across all strategies." />
            <Knob label="DAILY PROFIT TARGET (AUTO-STOP)" k="target" current={cfg.dailyProfitTarget} unit="$"
                  hint="When the day's realized P&L reaches +this, the bot STOPS trading for the day — overtrading protection. 0 = off." />
            <Knob label="DAILY STOP LOSS (AUTO-STOP)" k="stop" current={cfg.stopLossUsd} unit="$"
                  hint="When the day's realized P&L reaches −this, the bot halts for the day. 0 = off." />
          </div>
        )}
        <button onClick={save} className="hud-chip hud-nav-active" style={{ height: 36, cursor: "pointer" }}>
          💾 SAVE RISK CONTROLS
        </button>
        {msg && <div className="text-[11px] mt-2" style={{ color: msg.startsWith("✓") ? "var(--hud-green)" : "var(--hud-red)" }}>{msg}</div>}

        <p className="text-[10px] mt-6 pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          How the auto-stop works: at the first trade decision each day the bot snapshots your CLOB
          balance; every later decision compares the live balance against it. Hit the profit target →
          done for the day (locking wins beats giving them back). Hit the stop loss → halted.
          Every blocked attempt is logged with its reason in logs/live_orders.jsonl.
          The GO-LIVE toggle flips DRY_RUN and releases the kill switch — but Polymarket geoblocks
          Canada, so orders will still be refused (403) from a Canadian connection.
        </p>
      </main>
    </div>
  );
}

// ── GO-LIVE toggle: typed confirmation to turn ON, one click to turn OFF ──────
function LiveToggle({ dryRun, onChange }: { dryRun: boolean; onChange: (v: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [txt, setTxt] = useState("");
  const [msg, setMsg] = useState("");

  const flip = async (enable: boolean, confirm?: string) => {
    setMsg("");
    const res = await fetch("/api/live/golive", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enable, confirm }),
    });
    const d = await res.json();
    if (d.error) { setMsg(d.error); return; }
    onChange(d.dryRun); setConfirming(false); setTxt("");
    setMsg(d.warning ? `⚠ ${d.warning}` : "✓ " + d.state);
  };

  if (!dryRun) {
    return (
      <div className="mt-1">
        <button onClick={() => flip(false)}
                className="text-[10px] px-2 py-1 rounded border font-bold hover:opacity-80"
                style={{ borderColor: "var(--hud-amber)", color: "var(--hud-amber)" }}>
          ■ STOP — back to paper
        </button>
        {msg && <div className="text-[8px] mt-1" style={{ color: "var(--hud-muted)" }}>{msg}</div>}
      </div>
    );
  }
  return (
    <div className="mt-1">
      {!confirming ? (
        <button onClick={() => setConfirming(true)}
                className="text-[10px] px-2 py-1 rounded border font-bold hover:opacity-80"
                style={{ borderColor: "var(--hud-red)", color: "var(--hud-red)" }}>
          ⚡ GO LIVE (Polymarket)
        </button>
      ) : (
        <div className="flex flex-col gap-1">
          <input value={txt} onChange={(e) => setTxt(e.target.value)} placeholder='type "GO LIVE"'
                 className="text-[10px] px-2 py-1 rounded border bg-transparent"
                 style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }} />
          <div className="flex gap-1">
            <button onClick={() => flip(true, txt)} disabled={txt !== "GO LIVE"}
                    className="text-[10px] px-2 py-1 rounded border font-bold"
                    style={{ borderColor: txt === "GO LIVE" ? "var(--hud-red)" : "var(--hud-border)",
                             color: txt === "GO LIVE" ? "var(--hud-red)" : "var(--hud-muted)" }}>
              confirm
            </button>
            <button onClick={() => { setConfirming(false); setTxt(""); }}
                    className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: "var(--hud-border)", color: "var(--hud-muted)" }}>
              cancel
            </button>
          </div>
        </div>
      )}
      {msg && <div className="text-[8px] mt-1" style={{ color: msg.startsWith("⚠") ? "var(--hud-amber)" : "var(--hud-muted)" }}>{msg}</div>}
    </div>
  );
}

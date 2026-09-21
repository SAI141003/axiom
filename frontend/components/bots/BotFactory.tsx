"use client";

import { useEffect, useState } from "react";
import { Plus, Sparkles, Power, Trash2, RefreshCw } from "lucide-react";
import { Card, usd } from "@/components/charts";

const EVALUATORS = ["momentum", "ma_cross", "mean_reversion", "rsi", "bollinger", "obv", "mfi", "volume_profile"];
const DEFAULT = { name: "", universe: "ETH/USD", timeframe: "1d", stake: 20, max_pos: 2, enter: 0.15, exit: 0.05, weights: { momentum: 1.0, rsi: 0.5 } as Record<string, number>, note: "" };

// The Bot OS. Describe a bot in words and AXIOM writes the spec, or set the
// dials yourself. Either way it is a JSON file the runner picks up within the
// hour, trades on paper from $100, and shows here with its own book.
export default function BotFactory() {
  const [bots, setBots] = useState<any[]>([]);
  const [form, setForm] = useState({ ...DEFAULT });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [desc, setDesc] = useState("");

  const load = () => fetch("/api/botos").then((r) => r.json()).then((d) => setBots(d.bots ?? [])).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);

  const create = async () => {
    setBusy(true); setMsg(null);
    const spec = { ...form, universe: form.universe.split(/[,\s]+/).filter(Boolean), weights: Object.fromEntries(Object.entries(form.weights).filter(([, v]) => v > 0)) };
    const r = await fetch("/api/botos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    const d = await r.json();
    setMsg(d.ok ? { ok: true, text: `${d.spec.name} is live — first cycle within the hour.` } : { ok: false, text: d.error ?? "could not create" });
    if (d.ok) { setForm({ ...DEFAULT }); load(); }
    setBusy(false);
  };
  const toggle = async (id: string, enabled: boolean) => { await fetch("/api/botos", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, enabled }) }); load(); };
  const remove = async (id: string, name: string) => { if (!confirm(`Retire ${name}? Its log is kept.`)) return; await fetch(`/api/botos?id=${id}`, { method: "DELETE" }); load(); };
  const describe = () => { if (!desc.trim()) return; window.dispatchEvent(new CustomEvent("axiom:jarvis-ask", { detail: `Create a bot: ${desc.trim()}. Use the create_bot tool, then tell me its id and what it will trade.` })); setDesc(""); };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid lg:grid-cols-[1fr_1.2fr] gap-4">
        <Card title="DESCRIBE A BOT" sub="say what you want; AXIOM writes the spec and starts it on paper">
          <form onSubmit={(e) => { e.preventDefault(); describe(); }} className="flex flex-col gap-2">
            <label htmlFor="bot-desc" className="sr-only">Describe the bot</label>
            <textarea id="bot-desc" value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} placeholder="e.g. a daily SOL and ETH bot that buys momentum with RSI confirmation, $15 a position, two positions max"
                      className="hud-input prose-sans w-full resize-none py-3" />
            <button type="submit" disabled={!desc.trim()} className="hud-btn hud-btn-accent self-start" style={{ minHeight: 40 }}><Sparkles size={13} aria-hidden /> Ask AXIOM to build it</button>
          </form>
        </Card>

        <Card title="OR SET THE DIALS" sub="every bot is the evaluator blend on real candles, $100 paper, no keys">
          <form onSubmit={(e) => { e.preventDefault(); create(); }} className="grid grid-cols-2 gap-3 prose-sans text-[12px]">
            <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="hud-input w-full" style={{ minHeight: 40 }} placeholder="ETH momentum" /></Field>
            <Field label="Symbols (BASE/QUOTE)"><input value={form.universe} onChange={(e) => setForm({ ...form, universe: e.target.value })} required className="hud-input w-full font-mono" style={{ minHeight: 40 }} placeholder="ETH/USD, SOL/USD" /></Field>
            <Field label="Timeframe">
              <select value={form.timeframe} onChange={(e) => setForm({ ...form, timeframe: e.target.value })} className="hud-input w-full" style={{ minHeight: 40 }}>
                <option value="1d">1d — where the edge is</option><option value="4h">4h — research bet</option><option value="1h">1h — research bet</option>
              </select>
            </Field>
            <Field label="Stake × max positions">
              <div className="flex gap-2">
                <input type="number" min={5} max={50} value={form.stake} onChange={(e) => setForm({ ...form, stake: Number(e.target.value) })} className="hud-input w-full font-mono" style={{ minHeight: 40 }} aria-label="stake" />
                <input type="number" min={1} max={5} value={form.max_pos} onChange={(e) => setForm({ ...form, max_pos: Number(e.target.value) })} className="hud-input w-full font-mono" style={{ minHeight: 40 }} aria-label="max positions" />
              </div>
            </Field>
            <div className="col-span-2">
              <div className="text-[9px] tracking-widest font-mono mb-2" style={{ color: "var(--hud-muted)" }}>EVALUATOR WEIGHTS</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
                {EVALUATORS.map((k) => (
                  <label key={k} className="flex flex-col gap-1 text-[11px]" style={{ color: "var(--hud-text)" }}>
                    <span className="flex justify-between font-mono"><span>{k}</span><span style={{ color: "var(--hud-accent)" }}>{(form.weights[k] ?? 0).toFixed(1)}</span></span>
                    <input type="range" min={0} max={1.5} step={0.1} value={form.weights[k] ?? 0} onChange={(e) => setForm({ ...form, weights: { ...form.weights, [k]: Number(e.target.value) } })} aria-label={`${k} weight`} />
                  </label>
                ))}
              </div>
            </div>
            <Field label="Enter / exit threshold">
              <div className="flex gap-2">
                <input type="number" step={0.01} min={0.05} max={0.5} value={form.enter} onChange={(e) => setForm({ ...form, enter: Number(e.target.value) })} className="hud-input w-full font-mono" style={{ minHeight: 40 }} aria-label="enter threshold" />
                <input type="number" step={0.01} min={0} max={0.49} value={form.exit} onChange={(e) => setForm({ ...form, exit: Number(e.target.value) })} className="hud-input w-full font-mono" style={{ minHeight: 40 }} aria-label="exit threshold" />
              </div>
            </Field>
            <Field label="Note"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="hud-input w-full" style={{ minHeight: 40 }} placeholder="why this bot exists" /></Field>
            <div className="col-span-2 flex items-center gap-3">
              <button type="submit" disabled={busy || !form.name.trim()} className="hud-btn hud-btn-accent" style={{ minHeight: 40 }}><Plus size={13} aria-hidden /> Create bot</button>
              {msg && <span role="status" className="text-[12px]" style={{ color: msg.ok ? "var(--hud-green)" : "var(--hud-red)" }}>{msg.text}</span>}
            </div>
          </form>
        </Card>
      </div>

      <Card title="YOUR BOTS" sub={`${bots.length} spec bot${bots.length === 1 ? "" : "s"} · each on its own $100 paper book · runner cycles hourly`}>
        {bots.length === 0 && <div className="text-[12px] py-6 text-center prose-sans" style={{ color: "var(--hud-muted)" }}>none yet — describe one above, or ask AXIOM anywhere: “create a bot that…”</div>}
        <div className="flex flex-col gap-2">
          {bots.map((b) => {
            const k = b.book;
            return (
              <div key={b.id} className="hud-panel hud-panel-static p-3 flex flex-wrap items-center gap-3 min-w-0">
                <span className="hud-led" style={{ background: b.enabled ? "var(--hud-green)" : "var(--hud-muted)", color: b.enabled ? "var(--hud-green)" : "var(--hud-muted)" }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[13px]" style={{ color: "var(--hud-text)" }}>{b.name}</span>
                    <span className="hud-chip">{b.timeframe}</span>
                    <span className="text-[10px] font-mono truncate" style={{ color: "var(--hud-muted)" }}>{b.universe.join(" · ")} · ${b.stake} × {b.max_pos}</span>
                  </div>
                  <div className="text-[10px] font-mono truncate mt-0.5" style={{ color: "var(--hud-muted)" }}>
                    {Object.entries(b.weights).map(([e, w]) => `${e} ${w}`).join(" · ")} · enter {b.enter} / exit {b.exit}{b.note ? ` — ${b.note}` : ""}
                  </div>
                </div>
                {k && (
                  <div className="flex gap-4 tabular-nums text-right font-mono">
                    <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>BOOK</div><div className="text-[15px] font-bold" style={{ color: k.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>{usd(k.account)}</div></div>
                    <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>P&L</div><div className="text-[15px] font-bold" style={{ color: k.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>{k.pnl >= 0 ? "+" : ""}{usd(k.pnl)}</div></div>
                    <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>OPEN</div><div className="text-[15px] font-bold" style={{ color: "var(--hud-text)" }}>{k.open?.length ?? 0}</div></div>
                    <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>TRADES</div><div className="text-[15px] font-bold" style={{ color: "var(--hud-text)" }}>{k.trades}{k.win_rate != null ? ` · ${(k.win_rate * 100).toFixed(0)}%` : ""}</div></div>
                  </div>
                )}
                <div className="flex gap-1">
                  <button onClick={() => toggle(b.id, !b.enabled)} className="hud-icon-btn" aria-label={b.enabled ? "pause bot" : "resume bot"} title={b.enabled ? "pause" : "resume"} style={{ color: b.enabled ? "var(--hud-green)" : undefined }}><Power size={15} /></button>
                  <button onClick={() => remove(b.id, b.name)} className="hud-icon-btn" aria-label="retire bot" title="retire (log kept)"><Trash2 size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
        <button onClick={load} className="hud-btn mt-3"><RefreshCw size={12} aria-hidden /> Refresh</button>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[9px] tracking-widest font-mono" style={{ color: "var(--hud-muted)" }}>{label.toUpperCase()}</span>{children}</label>;
}

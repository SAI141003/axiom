"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

// Every AI the desk runs on, measured: model, job, latency, state. The desk
// should never have to guess which brain is answering or why it is slow.
const TONE: Record<string, string> = { ok: "var(--hud-green)", slow: "var(--hud-amber)", limited: "var(--hud-amber)", empty: "var(--hud-amber)", down: "var(--hud-red)", "no key": "var(--hud-muted)" };

export default function AiHealth({ compact = false }: { compact?: boolean }) {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => { setBusy(true); fetch(`/api/ai/health${refresh ? "?refresh=1" : ""}`).then((r) => r.json()).then(setD).catch(() => {}).finally(() => setBusy(false)); };
  useEffect(() => { load(); const t = setInterval(() => load(), 10 * 60_000); return () => clearInterval(t); }, []);
  const models: any[] = d?.models ?? [], services: any[] = d?.services ?? [];
  const lanes: any[] = (d?.usage?.lanes ?? []).filter((l: any) => l.day > 0 || l.skip).sort((a: any, b: any) => b.day - a.day);
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const shown = compact ? models.filter((m) => m.status !== "no key").slice(0, 6) : models;
  const svc = compact ? services.slice(0, 3) : services;
  return (
    <section className={`hud-panel hud-panel-static min-w-0 overflow-hidden ${compact ? "p-3" : "p-4"}`} aria-label="AI health">
      <div className="flex items-center mb-2 gap-2">
        <h2 className="text-[9px] tracking-[0.25em] font-bold font-mono m-0 whitespace-nowrap" style={{ color: "var(--hud-accent)" }}>AI HEALTH</h2>
        {d?.summary && <span className="text-[9px] font-mono truncate" style={{ color: "var(--hud-muted)" }}>{d.summary.ok}/{d.summary.keyed} models answering{d.summary.fastest ? ` · fastest ${d.summary.fastest}` : ""}</span>}
        <span className="flex-1" />
        <button onClick={() => load(true)} className="hud-icon-btn" aria-label="re-measure" title="re-measure every model (spends a little quota)" disabled={busy} style={{ width: 26, height: 26 }}><RefreshCw size={12} className={busy ? "hud-spin" : ""} /></button>
      </div>
      {!d && <p className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>measuring every model…</p>}
      {shown.map((m, i) => (
        <div key={i} className="flex items-center gap-2 py-[3px] text-[10.5px] font-mono min-w-0" style={{ borderBottom: "1px solid var(--hud-border)" }}>
          <span className="hud-led shrink-0" style={{ background: TONE[m.status], color: TONE[m.status] }} aria-hidden />
          <span className="truncate" style={{ color: "var(--hud-text)" }} title={`${m.job} — ${m.provider} ${m.model}`}>{compact ? m.model.split("/").pop() : m.job}</span>
          {!compact && <span className="truncate hidden lg:inline" style={{ color: "var(--hud-muted)" }}>{m.provider} · {m.model}</span>}
          <span className="flex-1" />
          <span className="shrink-0" style={{ color: TONE[m.status] }}>{m.status}{m.ms != null && m.status !== "no key" ? ` ${m.ms >= 1000 ? (m.ms / 1000).toFixed(1) + "s" : m.ms + "ms"}` : ""}</span>
        </div>
      ))}
      {(compact ? lanes.slice(0, 3) : lanes).map((l, i) => (
        <div key={`u${i}`} className="flex items-center gap-2 py-[3px] text-[10.5px] font-mono min-w-0" style={{ borderBottom: "1px solid var(--hud-border)" }} title={`${l.provider} ${l.model}: ${l.day} tokens in 24h${l.limits.day ? ` of ${l.limits.day}/day` : ""}${l.estimated ? ` (${l.estimated} estimated)` : ""}${l.skip ? ` — skipped: ${l.skip}` : ""}`}>
          <span className="hud-led shrink-0" style={{ background: l.skip ? "var(--hud-amber)" : "var(--hud-accent)", color: l.skip ? "var(--hud-amber)" : "var(--hud-accent)" }} aria-hidden />
          <span className="truncate" style={{ color: "var(--hud-text)" }}>{l.model.split("/").pop()} <span style={{ color: "var(--hud-muted)" }}>· {l.provider}</span></span>
          <span className="flex-1" />
          <span className="shrink-0" style={{ color: l.skip ? "var(--hud-amber)" : "var(--hud-muted)" }}>{k(l.day)} tok{l.dayPct != null ? ` · ${Math.round(l.dayPct * 100)}%` : ""}{l.skip ? ` · ${l.skip}` : ""}</span>
        </div>
      ))}
      {svc.map((s, i) => (
        <div key={`s${i}`} className="flex items-center gap-2 py-[3px] text-[10.5px] font-mono min-w-0" style={{ borderBottom: "1px solid var(--hud-border)" }}>
          <span className="hud-led shrink-0" style={{ background: s.ok ? "var(--hud-green)" : "var(--hud-red)", color: s.ok ? "var(--hud-green)" : "var(--hud-red)" }} aria-hidden />
          <span className="truncate" style={{ color: "var(--hud-text)" }}>{s.label}</span>
          <span className="flex-1" />
          <span className="truncate max-w-[55%] text-right" style={{ color: "var(--hud-muted)" }} title={s.note}>{s.note}</span>
        </div>
      ))}
    </section>
  );
}

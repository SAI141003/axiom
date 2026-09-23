"use client";
/**
 * What the loop last worked out, under the brain on the home page.
 *
 * Deliberately not the trade tape. Individual fills belong on /terminal and
 * /journal; the home page answers "is it thinking, and what has it worked
 * out", which is a different question — so this reads /api/learned, the
 * parameters the reflection loop changed and when, not /api/brain's events.
 */
import { useEffect, useState } from "react";

type Agent = { id: string; label: string; alive: boolean };
type Learned = Record<string, { params?: any; evidence?: any; learned_at?: number }>;

const AGO = (s: number) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

/** One short sentence for what a strategy last worked out. */
function conclusion(name: string, v: { params?: any; evidence?: any }): string {
  const p = v.params ?? {}, e = v.evidence ?? {};
  if (name === "weather") {
    const off = (p.disabled_cities ?? []).length;
    return `weather · edge floor ${p.min_flag_edge ?? "—"}${off ? `, ${off} ${off === 1 ? "city" : "cities"} switched off` : ""}`;
  }
  if (name === "crypto") {
    const on = Object.entries(p as Record<string, any>).filter(([, c]) => c?.enabled).map(([k]) => k.toUpperCase());
    return `crypto · trading ${on.length ? `${on.join(", ")} of ${Object.keys(p).length}` : "nothing"}`;
  }
  if (name === "premarket") {
    return `pre-market · ${p.target_mult ?? "—"}R target, ${p.stop_mult ?? "—"}R stop${e.n ? ` over ${e.n} trades` : ""}`;
  }
  return `${name} · ${Object.keys(p).length} parameters tuned`;
}

export default function BrainNote() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [learned, setLearned] = useState<Learned>({});
  const [i, setI] = useState(0);

  useEffect(() => {
    let live = true;
    const pull = async () => {
      const [b, l] = await Promise.all([
        fetch("/api/brain", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        fetch("/api/learned", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      ]);
      if (!live) return;
      if (b?.agents) setAgents(b.agents);
      if (l && typeof l === "object") setLearned(l);
    };
    pull();
    const t = setInterval(pull, 20_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const notes = Object.entries(learned).map(([k, v]) => ({ k, text: conclusion(k, v), at: v?.learned_at ?? 0 }));

  useEffect(() => {
    if (notes.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % notes.length), 6000);
    return () => clearInterval(t);
  }, [notes.length]);

  const shown = notes[i % Math.max(1, notes.length)];
  const alive = agents.filter((a) => a.alive).length;

  return (
    <div className="text-center" style={{ maxWidth: 440, margin: "0 auto" }}>
      <div className="text-[9px] font-mono tracking-[0.22em]" style={{ color: "var(--hud-muted)" }}>
        {alive}/{agents.length || "—"} AGENTS LIVE · WHAT IT HAS WORKED OUT
      </div>
      {shown && (
        <div key={shown.k} className="prose-sans text-[11px] leading-snug mt-0.5 hud-fade-in" style={{ color: "var(--hud-text)" }}>
          {shown.text}
          {shown.at > 0 && <span style={{ color: "var(--hud-muted)" }}> · {AGO(Date.now() / 1000 - shown.at)} ago</span>}
        </div>
      )}
    </div>
  );
}

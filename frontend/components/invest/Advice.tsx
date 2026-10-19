"use client";

import { useEffect, useState } from "react";
import { Bell, ExternalLink } from "lucide-react";
import { when } from "./SipPlanner";

// YOUR CALLS — what the advisor says to buy or sell, when, and why. Refreshed
// every minute from /api/advice (the advisor itself runs every 15 minutes).
const COLOR: Record<string, string> = { "SIP BUY": "var(--hud-green)", "NEXT SIP": "var(--hud-accent)", SELL: "var(--hud-red)", PAUSE: "var(--hud-amber)", RESUME: "var(--hud-green)", DIP: "var(--hud-amber)" };

export default function Advice() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/advice", { cache: "no-store" }).then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  if (!d) return null;
  const calls = d.calls ?? [];
  return (
    <section className="hud-panel hud-panel-static p-4 mb-6" aria-label="Your calls" style={{ borderColor: calls.some((c: any) => !c.silent) ? "var(--hud-green)" : undefined }}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
        <h2 className="text-[11px] tracking-[0.25em] font-bold m-0 flex items-center gap-2" style={{ color: "var(--hud-accent)" }}><Bell size={13} aria-hidden /> YOUR CALLS · WHAT TO DO, WHEN, WHY</h2>
        <span className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>
          {d.generated ? `advisor checked ${new Date(d.generated).toLocaleTimeString()} · runs every 15 min, day and night` : "advisor has not run yet"}
        </span>
      </div>
      {!d.profiles?.length && (
        <p className="prose-sans text-[12px] m-0" style={{ color: "var(--hud-muted)" }}>
          No plan saved yet. Open the SIP planner, build a plan, and press <b>Save as my plan</b> — the advisor then tells you every buy, and any sell, with the reason, here and on your phone.
        </p>
      )}
      {calls.map((c: any) => (
        <div key={c.id} className="py-2" style={{ borderTop: "1px solid var(--hud-border)" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ color: COLOR[c.kind] ?? "var(--hud-text)", border: "1px solid currentColor" }}>{c.kind}</span>
            <span className="text-[10px]" style={{ color: "var(--hud-muted)" }}>{c.market === "ca" ? "🇨🇦" : "🇺🇸"}</span>
            <b className="text-[13px] prose-sans">{c.title}</b>
          </div>
          <p className="prose-sans text-[12px] my-1">{c.why}</p>
          {c.detail?.length > 0 && <div className="text-[11px] tabular-nums" style={{ color: "var(--hud-muted)" }}>{c.detail.join(" · ")}</div>}
          <div className="text-[10px] mt-0.5" style={{ color: "var(--hud-muted)" }}>when: {when(c.when)}</div>
        </div>
      ))}
      {d.news?.length > 0 && (
        <details className="mt-2">
          <summary className="text-[10px] cursor-pointer" style={{ color: "var(--hud-accent)" }}>{d.news.length} fresh headlines on your holdings</summary>
          {d.news.map((n: any) => (
            <a key={n.link} href={n.link} target="_blank" rel="noreferrer" className="flex gap-2 text-[11px] py-0.5 hover:underline prose-sans">
              <span className="shrink-0 text-[10px] font-bold w-12">{n.about}</span><span className="truncate">{n.title}</span><ExternalLink size={10} className="shrink-0 mt-0.5" aria-hidden />
            </a>
          ))}
        </details>
      )}
    </section>
  );
}

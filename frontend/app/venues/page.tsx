"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";

type Venue = {
  name: string; cat: string; tier: number; canada: string; custody: string;
  api: string; kyc: string; security: string; best_for: string; reaches: string;
  note: string; src: string; src_label: string;
};

const CA = {
  yes: { label: "REACHABLE (BC)", color: "var(--hud-green)" },
  "ontario-blocked": { label: "OK outside Ontario", color: "var(--hud-amber)" },
  check: { label: "VERIFY", color: "var(--hud-amber)" },
  geoblocked: { label: "IP-GEOBLOCKED", color: "#f87171" },
  no: { label: "NOT IN CANADA", color: "#f87171" },
} as const;

export default function VenuesPage() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    fetch("/api/venues").then((r) => r.json()).then(setD).catch(() => {});
  }, []);
  const venues: Venue[] = d?.venues ?? [];
  const featured = venues.find((v) => v.name.startsWith("MetaMask"));
  const rest = venues.filter((v) => !v.name.startsWith("MetaMask"));

  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-5xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.25em] glow-cyan text-center">⚡ TRADING VENUES</h1>
        <p className="text-[11px] mt-1 mb-4 text-center" style={{ color: "var(--hud-muted)" }}>
          every platform a bot can trade on · can we reach it from Vancouver (BC)? · is the custody model safe for automation? · researched {d?.as_of ?? ""}, cited
        </p>

        {/* Breaking: MetaMask Agent Wallet */}
        {featured && (
          <div className="hud-panel hud-panel-static p-4 mb-5" style={{ borderColor: "rgba(124,154,255,0.55)" }}>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-[9px] font-bold px-2 py-0.5 rounded" style={{ color: "#0a0e17", background: "var(--hud-cyan)" }}>NEW · AUG 6 2026</span>
              <span className="text-[15px] font-bold" style={{ color: "var(--hud-text)" }}>{featured.name}</span>
              <span className="text-[10px] font-bold" style={{ color: CA[featured.canada as keyof typeof CA]?.color }}>{CA[featured.canada as keyof typeof CA]?.label}</span>
            </div>
            <div className="text-[11px] leading-relaxed mb-2" style={{ color: "var(--hud-text)" }}>{featured.note}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-[10px]" style={{ color: "var(--hud-muted)" }}>
              <div><b style={{ color: "var(--hud-cyan)" }}>connect:</b> {featured.api}</div>
              <div><b style={{ color: "var(--hud-cyan)" }}>reaches:</b> {featured.reaches}</div>
              <div><b style={{ color: "var(--hud-cyan)" }}>custody:</b> {featured.custody}</div>
              <div><b style={{ color: "var(--hud-cyan)" }}>guardrails:</b> {featured.security}</div>
            </div>
            <a href={featured.src} target="_blank" rel="noreferrer" className="text-[9px] mt-2 inline-block" style={{ color: "var(--hud-cyan)" }}>📄 {featured.src_label}</a>
          </div>
        )}

        {/* Full catalog table */}
        <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-muted)" }}>THE FULL MAP — {venues.length} venues</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr style={{ color: "var(--hud-muted)" }} className="text-left tracking-widest">
                <th className="py-2 pr-3">VENUE</th>
                <th className="py-2 pr-3">TYPE</th>
                <th className="py-2 pr-3">FROM CANADA</th>
                <th className="py-2 pr-3">CUSTODY</th>
                <th className="py-2 pr-3">API</th>
                <th className="py-2 pr-3">BEST FOR</th>
                <th className="py-2">SRC</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((v, i) => {
                const ca = CA[v.canada as keyof typeof CA];
                return (
                  <tr key={i} className="align-top" style={{ borderTop: "1px solid var(--hud-border)" }}>
                    <td className="py-2 pr-3 font-bold" style={{ color: "var(--hud-text)" }}>{v.name}</td>
                    <td className="py-2 pr-3" style={{ color: "var(--hud-muted)" }}>{v.cat}</td>
                    <td className="py-2 pr-3 font-bold whitespace-nowrap" style={{ color: ca?.color }}>{ca?.label}</td>
                    <td className="py-2 pr-3" style={{ color: "var(--hud-muted)" }}>{v.custody}</td>
                    <td className="py-2 pr-3" style={{ color: "var(--hud-muted)" }}>{v.api}</td>
                    <td className="py-2 pr-3" style={{ color: "var(--hud-muted)" }}>{v.best_for}</td>
                    <td className="py-2 whitespace-nowrap"><a href={v.src} target="_blank" rel="noreferrer" style={{ color: "var(--hud-cyan)" }}>📄</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Verdict */}
        {d?.verdict && (
          <div className="hud-panel hud-panel-static p-4 mt-5 text-[11px] leading-relaxed" style={{ color: "var(--hud-text)", borderColor: "rgba(52,211,153,0.4)" }}>
            <div className="text-[10px] tracking-widest mb-1 font-bold" style={{ color: "var(--hud-green)" }}>THE HONEST READ</div>
            {d.verdict}
          </div>
        )}

        <div className="text-[10px] mt-4 pb-8 leading-relaxed" style={{ color: "var(--hud-muted)" }}>
          Custody legend — <b>Non-custodial</b>: the bot signs with your own key, funds stay on-chain (safest for automation when the trade-key can&apos;t withdraw).
          <b> Custodial</b>: a regulated exchange holds your funds; use scoped, no-withdraw API keys. Everything here is a map — the discipline holds:
          paper-first, then a dry-run-gated adapter (like the Questrade one), before a single real cent.
        </div>
      </main>
    </div>
  );
}

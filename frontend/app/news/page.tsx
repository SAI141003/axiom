"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import TopNav from "@/components/TopNav";
import EngineBanner from "@/components/EngineBanner";

interface Affected { sym: string; relation: string; direction: string; price: number; chgPct: number }
interface Card {
  uuid: string; sym: string; title: string; publisher: string; link: string; published: number;
  quote: { price: number; chgPct: number } | null;
  eventType: string; direction: string; magnitude: number; horizon: string; volEffect: string;
  stockPlay: string | null; optionsPlay: string | null; affected: Affected[];
}

const EVENT_COLORS: Record<string, string> = {
  earnings: "#a78bfa", guidance: "#a78bfa", mna: "#34d399", regulatory: "#f87171",
  product: "#22d3ee", analyst: "#94a3b8", macro: "#fbbf24", litigation: "#f87171",
  supply_chain: "#22d3ee", other: "#556",
};

const dirColor = (d: string) => d === "bull" ? "var(--hud-green)" : d === "bear" ? "#f87171" : "var(--hud-amber)";

export default function NewsDeskPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [llmActive, setLlmActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = async (symbols?: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/newsdesk${symbols ? `?symbols=${symbols}` : ""}`);
      const d = await res.json();
      setCards(d.cards ?? []);
      setLlmActive(d.llmActive);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 5 * 60_000);   // stays current all session
    return () => clearInterval(t);
  }, []);

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <h1 className="text-xl font-bold tracking-[0.2em] glow-cyan">◈ QUANT NEWS DESK</h1>
          <p className="text-xs mt-1 mb-4" style={{ color: "var(--hud-muted)" }}>
            Live headlines → event type → affected chain → expected move &amp; vol → the play.
            Every ticker below is validated against a live quote. Refreshes every 5 min.
          </p>
          <EngineBanner engine="news-lag (niche)" />
        </motion.div>

        <form className="flex gap-2 mb-5" onSubmit={(e) => { e.preventDefault(); load(q || undefined); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="watchlist: NVDA,TSLA,AAPL … (blank = default)"
                 className="flex-1 px-3 py-2 text-xs rounded border bg-transparent"
                 style={{ borderColor: "var(--hud-border)", color: "var(--hud-text)" }} />
          <button type="submit" className="px-4 py-2 text-xs rounded border font-bold"
                  style={{ borderColor: "var(--hud-accent)", color: "var(--hud-accent)" }}>
            SCAN
          </button>
        </form>

        {!llmActive && !loading && cards.length > 0 && (
          <div className="rounded border px-4 py-2 mb-4 text-xs"
               style={{ borderColor: "#7c2d12", background: "#7c2d1222", color: "#fdba74" }}>
            ⚠ LLM classification unavailable — showing raw headlines only (no plays). Check LLM keys in /settings.
          </div>
        )}

        {loading ? (
          <div className="text-center py-20 text-sm" style={{ color: "var(--hud-muted)" }}>
            Scanning live news across the watchlist…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {cards.map((c, i) => (
              <motion.div key={c.uuid}
                          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: Math.min(i * 0.04, 0.5) }}
                          className="hud-panel hud-panel-static p-4"
                          style={c.magnitude >= 4 ? { borderColor: "rgba(167,139,250,0.5)" } : undefined}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap text-[10px] mb-1">
                      <span className="px-1.5 py-0.5 rounded font-bold"
                            style={{ background: `${EVENT_COLORS[c.eventType] ?? "#556"}22`, color: EVENT_COLORS[c.eventType] ?? "#556" }}>
                        {c.eventType.toUpperCase()}
                      </span>
                      <span className="font-bold" style={{ color: dirColor(c.direction) }}>
                        {c.direction.toUpperCase()}
                      </span>
                      <span style={{ color: "var(--hud-muted)" }}>
                        mag {"●".repeat(c.magnitude)}{"○".repeat(5 - c.magnitude)} · {c.horizon} · vol: {c.volEffect}
                      </span>
                      <span style={{ color: "var(--hud-muted)" }}>
                        {c.publisher} · {new Date(c.published).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <a href={c.link} target="_blank" rel="noreferrer"
                       className="text-xs hover:underline" style={{ color: "var(--hud-text)" }}>
                      {c.title}
                    </a>
                    {(c.stockPlay || c.optionsPlay) && (
                      <div className="mt-2 text-[11px] flex flex-col gap-0.5">
                        {c.stockPlay && <div><span className="font-bold" style={{ color: "var(--hud-cyan)" }}>STOCK</span> <span style={{ color: "var(--hud-text)" }}>{c.stockPlay}</span></div>}
                        {c.optionsPlay && <div><span className="font-bold" style={{ color: "var(--hud-violet)" }}>OPTIONS</span> <span style={{ color: "var(--hud-text)" }}>{c.optionsPlay}</span></div>}
                      </div>
                    )}
                    {c.affected.length > 0 && (
                      <div className="mt-2 flex gap-2 flex-wrap">
                        {c.affected.map((a) => (
                          <Link key={a.sym} href={`/stocks?symbol=${a.sym}`}
                                className="text-[10px] px-2 py-1 rounded border tabular-nums hover:opacity-80"
                                style={{ borderColor: "var(--hud-border)", color: dirColor(a.direction) }}>
                            {a.sym} ${a.price?.toFixed(2)} ({a.chgPct >= 0 ? "+" : ""}{a.chgPct}%) · {a.relation}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right tabular-nums">
                    <div className="text-xs font-bold" style={{ color: "var(--hud-accent)" }}>{c.sym}</div>
                    {c.quote && (
                      <>
                        <div className="text-sm font-bold" style={{ color: "var(--hud-text)" }}>${c.quote.price.toFixed(2)}</div>
                        <div className="text-[11px] font-bold" style={{ color: c.quote.chgPct >= 0 ? "var(--hud-green)" : "#f87171" }}>
                          {c.quote.chgPct >= 0 ? "+" : ""}{c.quote.chgPct}%
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
            {cards.length === 0 && (
              <div className="text-center py-16 text-sm" style={{ color: "var(--hud-muted)" }}>
                No headlines in the last 48h for this watchlist.
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

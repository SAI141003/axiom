"use client";

import { useEffect, useState } from "react";
import TopNav from "@/components/TopNav";
import { getToggle } from "@/lib/toggles";

interface Quote {
  symbol: string;
  price: number | null;
  previousClose?: number | null;
  fiftyTwoWeekHigh?: number | null;
}

// July 2026 AI Stock Playbook — catalyst trades (2-4 month horizon)
const CATALYST_TRADES = [
  {
    symbol: "TTWO", name: "Take-Two Interactive", rank: 1,
    rating: "Strong Buy · 29 analysts", target: 285,
    thesis: "GTA 6 locked for Nov 19, 2026. Accumulate through the marketing cycle, trim into launch week. Don't hold through the launch.",
    risk: "Delay whisper = −10-15% instantly. Do NOT buy EA as alternative (pinned to M&A price).",
  },
  {
    symbol: "NVDA", name: "NVIDIA", rank: 2,
    rating: "Strong Buy · 58 analysts", target: 302,
    thesis: "Near its 200-day ($191) — every prior touch has been bought. Short float near zero, options call-tilted. Earnings late August.",
    risk: "Decisive close below $191 = thesis broken. Add dip, don't chase strength.",
  },
  {
    symbol: "MU", name: "Micron", rank: 3,
    rating: "Strong Buy · 42 analysts", target: 1550,
    thesis: "HBM supercycle. Up ~9x, pulled back 22% while analysts keep raising targets. Fiscal Q4 earnings late September. HALF-SIZE only.",
    risk: "Memory is brutally cyclical. Highest-risk, highest-upside name on the list.",
  },
  {
    symbol: "GOOGL", name: "Alphabet", rank: 4,
    rating: "Strong Buy · 53 analysts", target: 433,
    thesis: "Down 13% from high. Q2 earnings late July. Role: ballast — lowest volatility of the five.",
    risk: "AI chatbots threaten search share. Antitrust overhang.",
  },
  {
    symbol: "GEV", name: "GE Vernova", rank: 5,
    rating: "Buy · 34 analysts", target: 1235,
    thesis: "Clean uptrend, above rising 50-day. Q2 earnings ~Jul 22. AI-electricity bottleneck — power demand is secular.",
    risk: "Expensive and crowded. Exit signal = close below 50-day.",
  },
];

// 5-year compounders (2026-2031)
const COMPOUNDERS = [
  { symbol: "MSFT",  nickname: "The Fortress",         bear: 316, base: 575,  bull: 970,  cagr: "8.0%",  pGain: "71%" },
  { symbol: "GOOGL", nickname: "The Cash Machine",     bear: 285, base: 542,  bull: 977,  cagr: "8.8%",  pGain: "65%" },
  { symbol: "NVDA",  nickname: "The Growth Engine",    bear: 63,  base: 480,  bull: 1840, cagr: "14.2%", pGain: "61%" },
  { symbol: "TSM",   nickname: "The Chokepoint",       bear: 219, base: 610,  bull: 1290, cagr: "7.2%",  pGain: "74%" },
  { symbol: "LLY",   nickname: "The Defensive Grower", bear: 660, base: 2040, bull: 4200, cagr: "11.0%", pGain: "79%" },
];

const SIX_RULES = [
  { n: 1, title: "Sizing", body: "5 stocks at ~8% each (MU at 4%). Tactical ETFs at 5%. Keep 15-20% cash for Aug-Sep volatility." },
  { n: 2, title: "Catalyst run-up", body: "Buy ahead of the event, add on confirmation, sell INTO the event — not after it." },
  { n: 3, title: "Buy-the-dip filter", body: "Only in names where consensus target is far above price AND price holds its 200-day." },
  { n: 4, title: "Momentum filter", body: "Trend is the thesis. Close below 50-day IS the sell signal. No averaging down." },
  { n: 5, title: "Avoid", body: "Stocks above consensus after huge runs. Broken parabolas still falling (silver, BTC)." },
  { n: 6, title: "Write the exit first", body: "Every position gets a stop and a target on paper before you buy. Non-negotiable." },
];

// ── Supply-chain "chain reaction" map — when a leader moves, its chain follows ──
const CHAINS: { name: string; desc: string; tiers: { label: string; symbols: string[] }[] }[] = [
  {
    name: "AI COMPUTE CHAIN",
    desc: "The silicon path: accelerators → foundry → fab equipment → HBM memory → chip test — every layer earns from the same GPU order book",
    tiers: [
      { label: "ACCELERATORS", symbols: ["NVDA", "AMD", "AVGO", "MRVL"] },
      { label: "FOUNDRY",      symbols: ["TSM", "GFS"] },
      { label: "FAB EQUIPMENT", symbols: ["ASML", "AMAT", "LRCX", "KLAC"] },
      { label: "MEMORY (HBM/NAND)", symbols: ["MU", "SNDK"] },
      { label: "CHIP TEST",    symbols: ["TER"] },
    ],
  },
  {
    name: "DATA CENTER CHAIN",
    desc: "Where every AI dollar lands: hard disks & storage → servers → optics/networking → cooling & power gear → power plants → the buildings themselves → builders → cloud buyers",
    tiers: [
      { label: "HARD DISKS / STORAGE", symbols: ["WDC", "STX", "NTAP"] },
      { label: "SERVERS",     symbols: ["SMCI", "DELL", "HPE"] },
      { label: "OPTICS / NETWORK", symbols: ["ANET", "COHR", "LITE", "APH", "CSCO"] },
      { label: "COOLING / POWER GEAR", symbols: ["VRT", "ETN", "MOD"] },
      { label: "POWER PLANTS", symbols: ["VST", "CEG", "GEV", "NRG"] },
      { label: "DC REITS",    symbols: ["EQIX", "DLR"] },
      { label: "BUILDERS",    symbols: ["PWR", "EME"] },
      { label: "CLOUD BUYERS", symbols: ["MSFT", "GOOGL", "AMZN", "META", "ORCL", "CRWV"] },
    ],
  },
  {
    name: "APPLE CHAIN",
    desc: "iPhone cycle: Apple → its silicon and RF suppliers",
    tiers: [
      { label: "LEADER",    symbols: ["AAPL"] },
      { label: "SILICON",   symbols: ["TSM", "QCOM"] },
      { label: "RF/CHIPS",  symbols: ["AVGO", "SWKS"] },
    ],
  },
  {
    name: "AUTOMAKER CHAIN",
    desc: "The car food chain: automakers → EV/ICE platforms → battery & lithium → power/auto semiconductors → parts & interiors → dealers/finance",
    tiers: [
      { label: "AUTOMAKERS",   symbols: ["TSLA", "GM", "F", "RIVN", "LCID", "TM", "STLA"] },
      { label: "BATTERY/LITHIUM", symbols: ["ALB", "LAC", "QS"] },
      { label: "AUTO SEMIS",   symbols: ["ON", "NXPI", "STM", "MBLY", "INDI"] },
      { label: "PARTS",        symbols: ["APTV", "BWA", "MGA", "LEA"] },
      { label: "DEALERS/FIN",  symbols: ["KMX", "AN", "ALLY"] },
    ],
  },
  {
    name: "FINTECH CHAIN",
    desc: "Digital finance: neobanks & platforms → card networks → processors → BNPL → the infrastructure they run on",
    tiers: [
      { label: "NEOBANKS/PLATFORMS", symbols: ["SOFI", "COIN", "HOOD", "AFRM"] },
      { label: "CARD NETWORKS", symbols: ["V", "MA", "AXP"] },
      { label: "PROCESSORS",   symbols: ["PYPL", "FIS", "FISV", "GPN"] },
      { label: "INFRA",        symbols: ["NU", "MELI"] },
    ],
  },
];

const CHAIN_SYMBOLS = Array.from(new Set(CHAINS.flatMap((c) => c.tiers.flatMap((t) => t.symbols))));

function chgPct(q?: Quote): number | null {
  if (!q?.price || !q.previousClose) return null;
  return ((q.price - q.previousClose) / q.previousClose) * 100;
}

function DeepChain() {
  const [sym, setSym] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");

  const research = async (s: string) => {
    const t = s.trim().toUpperCase();
    if (!t) return;
    setLoading(true); setErr(""); setData(null);
    try {
      const res = await fetch(`/api/deepchain?symbol=${encodeURIComponent(t)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "failed");
      setData(d);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setLoading(false); }
  };

  const Chip = ({ x }: { x: any }) => (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 mr-1 mb-1 text-[10px]"
          style={{ borderRadius: 99,
                   border: `1px solid ${x.verified ? "rgba(62,207,142,0.4)" : "var(--hud-border)"}`,
                   background: x.verified ? "rgba(62,207,142,0.08)" : "transparent",
                   color: x.verified ? "var(--hud-green)" : "var(--hud-muted)" }}
          title={x.note || ""}>
      {x.name}{x.verified ? ` ${x.ticker} $${x.price}${x.chg != null ? ` ${x.chg >= 0 ? "+" : ""}${x.chg}%` : ""}` : x.ticker ? ` ${x.ticker}·priv` : " ·private"}
    </span>
  );

  return (
    <div className="mb-10">
      <h2 className="text-sm font-bold tracking-widest mb-1" style={{ color: "var(--hud-accent)" }}>
        🔎 SEARCH ANY STOCK — DEEP RESEARCH
      </h2>
      <p className="text-[10px] mb-3" style={{ color: "var(--hud-muted)" }}>
        Type any symbol — even a penny stock. AI maps its parts → named manufacturers (incl. small caps),
        customers, contracts and history; every ticker is then validated against a live quote.
        <span style={{ color: "var(--hud-green)" }}> Green = verified live</span>; grey = private/unverified.
      </p>
      <div className="flex gap-2 mb-4">
        <input value={sym} onChange={(e) => setSym(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && research(sym)}
               placeholder="e.g. WDC, VRT, SMCI, or any ticker…"
               className="px-3 py-2 text-xs outline-none flex-1 max-w-xs"
               style={{ background: "rgba(11,13,18,0.7)", border: "1px solid var(--hud-border)",
                        color: "var(--hud-text)", borderRadius: 8 }} />
        <button onClick={() => research(sym)} disabled={loading}
                className="hud-chip hud-nav-active" style={{ height: 34, cursor: "pointer" }}>
          {loading ? "⟳ RESEARCHING…" : "▶ MAP CHAIN"}
        </button>
      </div>

      {err && <div className="hud-panel hud-panel-static p-3 text-xs" style={{ color: "var(--hud-red)" }}>⚠ {err}</div>}

      {data && (
        <div className="hud-panel hud-panel-static p-4">
          <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
            <span className="font-bold text-[14px]">{data.profile.name} <span style={{ color: "var(--hud-muted)" }}>{data.symbol}</span></span>
            <span className="text-[10px]" style={{ color: "var(--hud-muted)" }}>
              {data.profile.industry} · {data.validation.verified}/{data.validation.named} suppliers verified live
            </span>
          </div>
          <p className="text-[11px] mb-4" style={{ color: "var(--hud-text)" }}>{data.overview}</p>

          {/* connected companies — every verified ticker, live price + today's move */}
          {data.connected?.length > 0 && (
            <>
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-accent)" }}>
                CONNECTED COMPANIES · LIVE ({data.connected.length})
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4">
                {data.connected.map((c: any) => (
                  <div key={c.ticker} className="px-2.5 py-1.5 text-center flex-shrink-0"
                       title={c.name + (c.related ? " · Yahoo-related" : " · from chain research")}
                       style={{ background: "rgba(11,13,18,0.7)", borderRadius: 8,
                                border: `1px solid ${c.chg == null ? "var(--hud-border)" : c.chg >= 0 ? "rgba(62,207,142,0.35)" : "rgba(244,113,116,0.35)"}` }}>
                    <div className="text-[10px] font-bold">{c.ticker}{c.related ? " ↔" : ""}</div>
                    <div className="text-[10px] tabular-nums">${c.price}</div>
                    <div className="text-[10px] tabular-nums font-bold"
                         style={{ color: c.chg == null ? "var(--hud-muted)" : c.chg >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                      {c.chg == null ? "—" : `${c.chg >= 0 ? "+" : ""}${c.chg}%`}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* recent news — the injections moving this name */}
          {data.headlines?.length > 0 && (
            <>
              <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-accent)" }}>
                RECENT NEWS
              </div>
              <div className="flex flex-col gap-1 mb-4">
                {data.headlines.slice(0, 6).map((h: any, i: number) => (
                  <a key={i} href={h.link || "#"} target="_blank" rel="noreferrer"
                     className="text-[11px] hover:underline flex items-baseline gap-2"
                     style={{ color: "var(--hud-text)" }}>
                    <span className="flex-1">{typeof h === "string" ? h : h.title}</span>
                    {h.publisher && (
                      <span className="text-[9px] flex-shrink-0" style={{ color: "var(--hud-muted)" }}>
                        {h.publisher}{h.ts ? ` · ${new Date(h.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}` : ""}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            </>
          )}

          <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-accent)" }}>PARTS → MANUFACTURERS</div>
          {data.parts?.map((p: any, i: number) => (
            <div key={i} className="mb-2.5">
              <div className="text-[11px] font-bold mb-1">{p.component}</div>
              <div>{(p.suppliers ?? []).map((su: any, j: number) => <Chip key={j} x={su} />)}</div>
            </div>
          ))}

          {data.customers?.length > 0 && (
            <>
              <div className="text-[10px] tracking-widest mt-3 mb-2" style={{ color: "var(--hud-accent)" }}>CUSTOMERS</div>
              <div>{data.customers.map((c: any, i: number) => <Chip key={i} x={c} />)}</div>
            </>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            {data.contracts?.length > 0 && (
              <div>
                <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-accent)" }}>CONTRACTS / DESIGN WINS</div>
                {data.contracts.map((c: any, i: number) => (
                  <div key={i} className="text-[11px] mb-1" style={{ color: "var(--hud-muted)" }}>
                    <b style={{ color: "var(--hud-text)" }}>{c.party}</b> · {c.desc} <span>({c.year})</span>
                  </div>
                ))}
              </div>
            )}
            {data.history?.length > 0 && (
              <div>
                <div className="text-[10px] tracking-widest mb-2" style={{ color: "var(--hud-accent)" }}>COMPANY HISTORY</div>
                {data.history.map((h: any, i: number) => (
                  <div key={i} className="text-[11px] mb-1" style={{ color: "var(--hud-muted)" }}>
                    <b style={{ color: "var(--hud-text)" }}>{h.year}</b> · {h.event}
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.risks?.length > 0 && (
            <div className="mt-3 text-[10px]" style={{ color: "var(--hud-amber)" }}>
              ⚠ {data.risks.join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChainSection({ quotes }: { quotes: Record<string, Quote> }) {
  return (
    <div className="mb-10">
      <h2 className="text-sm font-bold tracking-widest mb-1" style={{ color: "var(--hud-accent)" }}>
        CHAIN REACTION · SUPPLY-CHAIN LIVE MAP
      </h2>
      <p className="text-[10px] mb-3" style={{ color: "var(--hud-muted)" }}>
        When a leader moves, its suppliers follow — CONFIRMED means the chain is moving with its leader
        today (trend has breadth); DIVERGING means the move is isolated (weaker signal).
      </p>
      <div className="flex flex-col gap-4">
        {CHAINS.map((chain) => {
          const leadCh = chain.tiers[0].symbols
            .map((s) => chgPct(quotes[s])).filter((v): v is number => v != null);
          const restCh = chain.tiers.slice(1).flatMap((t) => t.symbols)
            .map((s) => chgPct(quotes[s])).filter((v): v is number => v != null);
          const leadAvg = leadCh.length ? leadCh.reduce((a, b) => a + b, 0) / leadCh.length : 0;
          const restAvg = restCh.length ? restCh.reduce((a, b) => a + b, 0) / restCh.length : 0;
          const confirmed = Math.sign(leadAvg) === Math.sign(restAvg) && Math.abs(restAvg) > 0.15;
          return (
            <div key={chain.name} className="hud-panel hud-panel-static p-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                <span className="font-bold text-[13px]">{chain.name}</span>
                <span className="flex items-center gap-3 text-[11px] tabular-nums">
                  <span>leader <b style={{ color: leadAvg >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                    {leadAvg >= 0 ? "+" : ""}{leadAvg.toFixed(2)}%</b></span>
                  <span>chain <b style={{ color: restAvg >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
                    {restAvg >= 0 ? "+" : ""}{restAvg.toFixed(2)}%</b></span>
                  <span className="px-2 py-0.5 text-[9px] font-bold tracking-widest"
                        style={{ borderRadius: 99,
                                 border: `1px solid ${confirmed ? "rgba(62,207,142,0.5)" : "rgba(226,177,88,0.5)"}`,
                                 color: confirmed ? "var(--hud-green)" : "var(--hud-amber)" }}>
                    {confirmed ? "⛓ CONFIRMED" : "⚠ DIVERGING"}
                  </span>
                </span>
              </div>
              <p className="text-[10px] mb-3" style={{ color: "var(--hud-muted)" }}>{chain.desc}</p>
              <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
                {chain.tiers.map((tier, ti) => (
                  <div key={tier.label} className="flex items-center gap-1.5 flex-shrink-0">
                    {ti > 0 && <span style={{ color: "var(--hud-muted)" }} className="text-sm">→</span>}
                    <div className="flex flex-col gap-1">
                      <div className="text-[8px] tracking-[0.14em] text-center" style={{ color: "var(--hud-muted)" }}>
                        {tier.label}
                      </div>
                      <div className="flex gap-1">
                        {tier.symbols.map((sym) => {
                          const ch = chgPct(quotes[sym]);
                          const col = ch == null ? "var(--hud-muted)" : ch >= 0 ? "var(--hud-green)" : "var(--hud-red)";
                          return (
                            <div key={sym} className="px-2 py-1.5 text-center"
                                 style={{ background: "rgba(11,13,18,0.7)", borderRadius: 8,
                                          border: `1px solid ${ch == null ? "var(--hud-border)" : ch >= 0 ? "rgba(62,207,142,0.35)" : "rgba(244,113,116,0.35)"}` }}>
                              <div className="text-[10px] font-bold">{sym}</div>
                              <div className="text-[10px] tabular-nums font-bold" style={{ color: col }}>
                                {ch == null ? "—" : `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function StocksPage() {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const symbols = Array.from(new Set([
      ...CATALYST_TRADES.map((t) => t.symbol),
      ...COMPOUNDERS.map((c) => c.symbol),
      ...CHAIN_SYMBOLS,
    ])).join(",");

    const tick = () =>
      fetch(`/api/quotes?symbols=${symbols}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: { symbol: string; price: number | null; prevClose: number | null }[]) => {
          setQuotes((prev) => {
            const map: Record<string, Quote> = { ...prev };
            rows.forEach((q) => {
              if (q.price) map[q.symbol] = { symbol: q.symbol, price: q.price, previousClose: q.prevClose };
            });
            return map;
          });
        })
        .finally(() => setLoading(false));

    tick();                                  // initial load
    const id = setInterval(() => { if (getToggle("stocks.liveTicks")) tick(); }, 15_000);
    return () => clearInterval(id);
  }, []);

  const fmtChange = (q?: Quote) => {
    if (!q?.price || !q.previousClose) return null;
    const pct = ((q.price - q.previousClose) / q.previousClose) * 100;
    return (
      <span style={{ color: pct >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>
        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
      </span>
    );
  };

  return (
    <div className="hud-bg">
      <TopNav />
      <main className="max-w-6xl mx-auto p-6 font-mono">
        <h1 className="text-xl font-bold tracking-[0.2em] glow-amber">▲ AI STOCK PLAYBOOK</h1>
        <p className="text-xs mt-1 mb-6" style={{ color: "var(--hud-muted)" }}>
          July 2026 · 5 catalyst trades (2-4 mo) + 5 long-term compounders · live quotes via Yahoo Finance
          · educational only, not financial advice
        </p>

        <DeepChain />

        <ChainSection quotes={quotes} />

        {/* ── Catalyst trades ── */}
        <h2 className="text-sm font-bold tracking-widest mb-3" style={{ color: "var(--hud-amber)" }}>
          TOP 5 CATALYST TRADES
        </h2>
        <div className="flex flex-col gap-3 mb-10">
          {CATALYST_TRADES.map((t) => {
            const q = quotes[t.symbol];
            const upside = q?.price ? ((t.target / q.price - 1) * 100).toFixed(0) : null;
            return (
              <div key={t.symbol} className="hud-panel hud-panel-static p-4 grid grid-cols-1 md:grid-cols-[140px_1fr_1fr] gap-4">
                <div>
                  <div className="text-[10px]" style={{ color: "var(--hud-amber)" }}>#{t.rank}</div>
                  <div className="text-lg font-bold">{t.symbol}</div>
                  <div className="text-xl font-bold tabular-nums mt-1" style={{ color: "var(--hud-text)" }}>
                    {loading ? "…" : q?.price ? `$${q.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—"}
                  </div>
                  <div className="text-xs mt-0.5">{fmtChange(q)}</div>
                  <div className="text-[10px] mt-2" style={{ color: "var(--hud-muted)" }}>
                    Target ${t.target.toLocaleString()}
                    {upside && <span style={{ color: "var(--hud-green)" }}> (+{upside}%)</span>}
                  </div>
                </div>
                <div className="text-xs leading-relaxed">
                  <div className="text-[10px] tracking-widest mb-1" style={{ color: "var(--hud-green)" }}>{t.rating}</div>
                  <p style={{ color: "var(--hud-text)" }}>{t.thesis}</p>
                </div>
                <div className="text-xs leading-relaxed">
                  <div className="text-[10px] tracking-widest mb-1" style={{ color: "var(--hud-red)" }}>⚠ RISK</div>
                  <p style={{ color: "var(--hud-red)" }}>{t.risk}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Compounders ── */}
        <h2 className="text-sm font-bold tracking-widest mb-3" style={{ color: "var(--hud-accent)" }}>
          5-YEAR COMPOUNDERS (2026-2031) · DCF + CAPM + MONTE CARLO
        </h2>
        <div className="hud-panel hud-panel-static overflow-hidden mb-10">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "var(--hud-panel)", color: "var(--hud-muted)" }}>
                <th className="text-left px-4 py-3 font-medium">Ticker</th>
                <th className="text-right px-4 py-3 font-medium">Live Price</th>
                <th className="text-right px-4 py-3 font-medium">Bear &apos;31</th>
                <th className="text-right px-4 py-3 font-medium">Base &apos;31</th>
                <th className="text-right px-4 py-3 font-medium">Bull &apos;31</th>
                <th className="text-right px-4 py-3 font-medium">CAGR/yr</th>
                <th className="text-right px-4 py-3 font-medium">P(gain)</th>
              </tr>
            </thead>
            <tbody>
              {COMPOUNDERS.map((c) => {
                const q = quotes[c.symbol];
                return (
                  <tr key={c.symbol} className="hud-row tabular-nums">
                    <td className="px-4 py-3">
                      <span className="font-bold">{c.symbol}</span>
                      <span className="ml-2 text-[10px]" style={{ color: "var(--hud-muted)" }}>{c.nickname}</span>
                    </td>
                    <td className="text-right px-4 py-3 font-bold">
                      {loading ? "…" : q?.price ? `$${q.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—"}
                      <span className="ml-2 text-[10px]">{fmtChange(q)}</span>
                    </td>
                    <td className="text-right px-4 py-3" style={{ color: "var(--hud-red)" }}>${c.bear}</td>
                    <td className="text-right px-4 py-3" style={{ color: "var(--hud-text)" }}>${c.base.toLocaleString()}</td>
                    <td className="text-right px-4 py-3" style={{ color: "var(--hud-green)" }}>${c.bull.toLocaleString()}</td>
                    <td className="text-right px-4 py-3" style={{ color: "var(--hud-accent)" }}>{c.cagr}</td>
                    <td className="text-right px-4 py-3" style={{ color: "var(--hud-accent)" }}>{c.pGain}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Six rules ── */}
        <h2 className="text-sm font-bold tracking-widest mb-3" style={{ color: "var(--hud-green)" }}>
          THE SIX RULES THAT ACTUALLY MULTIPLY MONEY
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          {SIX_RULES.map((r) => (
            <div key={r.n} className="hud-panel hud-panel-static p-4">
              <div className="text-xs font-bold mb-1">
                <span style={{ color: "var(--hud-amber)" }}>{r.n}.</span> {r.title}
              </div>
              <p className="text-[11px] leading-relaxed" style={{ color: "var(--hud-muted)" }}>{r.body}</p>
            </div>
          ))}
        </div>

        <p className="text-[10px] pb-8" style={{ color: "var(--hud-muted)" }}>
          Playbook data from July 2, 2026 snapshots. Targets are analyst consensus + Monte Carlo blends.
          Educational and entertainment only — not financial advice.
        </p>
      </main>
    </div>
  );
}

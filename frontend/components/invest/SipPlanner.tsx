"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Kpi, DonutChart, Lines, CompareBars, PALETTE } from "@/components/charts";
import { ExternalLink, Newspaper } from "lucide-react";

// The monthly-SIP planner, shared by /invest and the SIP button on /stocks:
// amount, years, risk and goal in; a diversified plan out (ETF core, one proven
// leader per sector, gold and silver), back-tested on real prices, projected
// over 2,000 paths, with an exact buy calendar and a live watch on every holding.

export type Market = "us" | "ca";
const RISKS = [
  { id: "conservative", label: "Conservative", sub: "40% stocks" },
  { id: "balanced", label: "Balanced", sub: "60% stocks" },
  { id: "growth", label: "Growth", sub: "80% stocks" },
  { id: "aggressive", label: "Aggressive", sub: "100% stocks" },
] as const;

export const pc = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
export const money = (v: number | null | undefined, cur = "USD") =>
  v == null ? "—" : `${cur === "CAD" ? "C$" : "$"}${Math.round(v).toLocaleString()}`;
export const big = (v: number | null) => (v == null ? "—" : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : `$${(v / 1e9).toFixed(1)}B`);
export const tone = (v: number | null | undefined) => (v == null ? "var(--hud-muted)" : v >= 0 ? "var(--hud-green)" : "var(--hud-red)");
export const when = (ms: number) => {
  const et = new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const ist = new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  return `${et} ET · ${ist} IST`;
};
const ago = (ms: number | null) => { if (!ms) return ""; const h = (Date.now() - ms) / 3600_000; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };

export function Spark({ data, w = 90, h = 24 }: { data: number[]; w?: number; h?: number }) {
  if (!data?.length) return null;
  const lo = Math.min(...data), hi = Math.max(...data), up = data[data.length - 1] >= data[0];
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - lo) / (hi - lo || 1)) * h}`).join(" ");
  return <svg width={w} height={h} aria-hidden><polyline points={pts} fill="none" stroke={up ? "var(--hud-green)" : "var(--hud-red)"} strokeWidth={1.3} /></svg>;
}


export default function SipPlanner({ market, uni }: { market: Market; uni?: any }) {
  const [form, setForm] = useState({ monthly: "500", years: "15", risk: "growth", goal: "" });
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [style, setStyle] = useState<"diversified" | "simple" | "diy">("diversified");
  const [watch, setWatch] = useState<any[] | null>(null);
  useEffect(() => { setPlan(null); setWatch(null); }, [market]);

  const run = useCallback(async () => {
    setBusy(true); setErr(""); setWatch(null);
    try {
      const r = await fetch("/api/invest/plan", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ market, monthly: Number(form.monthly), years: Number(form.years), risk: form.risk, goal: Number(form.goal) || undefined }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "plan failed");
      setPlan(d);
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  }, [market, form]);

  // every holding of the chosen mix: live chart, the tested rule, exact times, news
  useEffect(() => {
    if (!plan) return;
    const syms: string[] = plan.buy[style].map((o: any) => o.symbol);
    const top = (uni?.etfs ?? []).filter((e: any) => syms.includes(e.symbol)).flatMap((e: any) => e.holdings.slice(0, 2).map((h: any) => h.symbol)).filter(Boolean);
    const holdings = Array.from(new Set(top.length ? top : market === "us" ? ["NVDA", "AAPL", "MSFT"] : ["RY.TO", "SHOP.TO", "NVDA"]));
    setWatch(null);
    // the watch endpoint takes 8 symbols a call; larger mixes are split
    const chunks: string[][] = []; for (let i = 0; i < syms.length; i += 8) chunks.push(syms.slice(i, i + 8));
    Promise.all(chunks.map((c) => fetch(`/api/invest/watch?symbols=${c.join(",")}&holdings=${holdings.slice(0, 3).join(",")}`).then((r) => r.json()).then((d) => d.rows ?? []).catch(() => [])))
      .then((rows) => setWatch(rows.flat()));
  }, [plan, uni, market, style]);

  const cur = market === "ca" ? "CAD" : "USD";
  return (
    <>
      <section className="hud-panel hud-panel-static p-4 mb-4" aria-label="Monthly SIP planner">
        <h2 className="text-[11px] tracking-[0.25em] font-bold m-0 mb-3" style={{ color: "var(--hud-accent)" }}>YOUR MONTHLY SIP · {market === "us" ? "🇺🇸 US MARKET (USD)" : "🇨🇦 CANADIAN MARKET (CAD)"}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
          <label className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>MONTHLY AMOUNT ({cur})
            <input type="number" min={1} value={form.monthly} onChange={(e) => setForm({ ...form, monthly: e.target.value })} className="hud-input mt-1 w-full text-base" aria-label="Monthly amount" />
          </label>
          <label className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>FOR HOW MANY YEARS
            <input type="number" min={1} max={40} value={form.years} onChange={(e) => setForm({ ...form, years: e.target.value })} className="hud-input mt-1 w-full text-base" aria-label="Years" />
          </label>
          <label className="text-[10px] tracking-widest" style={{ color: "var(--hud-muted)" }}>GOAL ({cur}, OPTIONAL)
            <input type="number" min={0} value={form.goal} placeholder="e.g. 200000" onChange={(e) => setForm({ ...form, goal: e.target.value })} className="hud-input mt-1 w-full text-base" aria-label="Goal amount" />
          </label>
          <button onClick={run} disabled={busy} className="hud-btn hud-btn-accent" style={{ minHeight: 40 }}>{busy ? "Scanning 20 years of data…" : "Build my plan"}</button>
        </div>
        <div className="flex gap-2 flex-wrap mt-3" role="radiogroup" aria-label="Risk">
          {RISKS.map((r) => (
            <button key={r.id} role="radio" aria-checked={form.risk === r.id} onClick={() => setForm({ ...form, risk: r.id })}
                    className={`hud-chip ${form.risk === r.id ? "hud-nav-active" : ""}`} style={{ cursor: "pointer", color: form.risk === r.id ? undefined : "var(--hud-muted)" }}>
              {r.label} <span className="opacity-70">· {r.sub}</span>
            </button>
          ))}
        </div>
        {err && <p className="text-xs mt-2" style={{ color: "var(--hud-red)" }}>{err}</p>}
      </section>
      {plan && <SaveBar plan={plan} style={style} />}
      {plan && <Plan plan={plan} style={style} setStyle={setStyle} cur={cur} />}
      {plan && <Watch rows={watch} />}
    </>
  );
}

function SaveBar({ plan, style }: any) {
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const save = async () => {
    setState("saving");
    const r = await fetch("/api/advice/profile", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...plan.input, style }) }).catch(() => null);
    setState(r?.ok ? "saved" : "error");
  };
  return (
    <div className="hud-panel hud-panel-static p-3 mb-3 flex items-center gap-3 flex-wrap" style={{ borderColor: "var(--hud-accent)" }}>
      <button onClick={save} disabled={state === "saving"} className="hud-btn hud-btn-accent" style={{ minHeight: 34 }}>
        {state === "saved" ? "✓ Saved — the advisor is on it" : state === "saving" ? "Saving…" : "Save as my plan"}
      </button>
      <span className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>
        {state === "error" ? "Could not save — is the desk running?" : "The advisor then tells you every monthly buy (the day before and at the time), any sell, and the news on your holdings — on the Stocks page and on your phone (ntfy). One saved plan per market."}
      </span>
    </div>
  );
}

function Plan({ plan, style, setStyle, cur }: any) {
  const orders = plan.buy[style];
  const a = plan.analysis[style === "diversified" ? "diversified" : "core"];
  const b = a.backtest, f = a.forecast;
  const other = plan.analysis[style === "diversified" ? "core" : "diversified"].backtest;
  const total = orders.reduce((s: number, o: any) => s + o.amount, 0);
  return (
    <section className="mb-4" aria-label="Your plan">
      {plan.riskNote && <div className="hud-panel hud-panel-static p-3 mb-3 prose-sans text-xs" style={{ borderColor: "var(--hud-amber)", color: "var(--hud-amber)" }}>{plan.riskNote}</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <Kpi label="YOU WILL PUT IN" value={money(f.invested, cur)} sub={`${money(plan.input.monthly, cur)} × ${plan.input.years * 12} months`} />
        <Kpi label="LIKELY VALUE (MEDIAN)" value={money(f.p50, cur)} tone="good" sub={`${money(f.p50Today, cur)} in today's money`} />
        <Kpi label="BAD CASE / GOOD CASE" value={`${money(f.p10, cur)} – ${money(f.p90, cur)}`} sub="1 in 10 below / 1 in 10 above" />
        <Kpi label={f.chanceGoal != null ? "CHANCE OF YOUR GOAL" : "CHANCE OF A GAIN"} value={pc(f.chanceGoal ?? f.chanceAboveInvested, 0)}
             tone={(f.chanceGoal ?? f.chanceAboveInvested) >= 0.5 ? "good" : "bad"} sub={f.chanceGoal != null ? `reach ${money(plan.input.goal, cur)}` : "end above what you put in"} />
      </div>

      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <Card title={`WHAT TO BUY EVERY MONTH · ${Math.round(plan.equity * 100)}% STOCKS / ${Math.round((1 - plan.equity) * 100)}% BONDS`}
              sub="Buy on the first trading day of each month, 30 minutes after the open. Same day, same amount — no timing.">
          <div className="flex gap-2 mb-2" role="tablist">
            {([["diversified", "DIVERSIFIED (ETFs + stocks + metals)"], ["simple", "ONE FUND (simplest)"], ["diy", "ETF BLOCKS (lowest fee)"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={style === k} onClick={() => setStyle(k)} className={`hud-chip ${style === k ? "hud-nav-active" : ""}`}
                      style={{ cursor: "pointer", color: style === k ? undefined : "var(--hud-muted)" }}>{l}</button>
            ))}
          </div>
          {orders.map((o: any, i: number) => (
            <div key={o.symbol} className="flex items-center gap-3 py-2 text-[12px]" style={{ borderTop: "1px solid var(--hud-border)" }}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden />
              <div className="min-w-0 flex-1"><div className="font-bold">BUY {o.symbol.replace(".TO", "")} <span className="font-normal" style={{ color: "var(--hud-muted)" }}>· {pc(o.weight, o.weight < 0.1 ? 1 : 0)} · {o.kind === "stock" ? "stock" : o.kind === "metal" ? "metal" : o.kind === "bond" ? "bonds" : "ETF"}</span></div>
                <div className="prose-sans text-[10px] truncate" style={{ color: "var(--hud-muted)" }}>{o.role}</div></div>
              <div className="text-right shrink-0"><div className="font-bold">{money(o.amount, cur)}/mo</div>
                <div className="text-[10px]" style={{ color: "var(--hud-muted)" }}>{o.price ? `@ ${o.price.toFixed(2)} ≈ ${o.fractional.toFixed(2)} sh` : ""}{o.shares === 0 ? " · needs fractional shares" : ""}</div></div>
            </div>
          ))}
          <div className="text-[10px] pt-2" style={{ color: "var(--hud-muted)", borderTop: "1px solid var(--hud-border)" }}>
            Total {money(total, cur)}/month. {style === "simple" ? "One fund holds the whole mix and rebalances itself." : "Rebalance once a year: if any holding is 5+ points off its share, sell the excess and buy the short one."}
            {style === "diversified" && orders.some((o: any) => o.kind === "stock" && o.amount < 25) && " Stock amounts are small: use a broker with fractional shares (Wealthsimple, Questrade, Schwab, Fidelity, IBKR), or buy the stock slice every 3 months instead."}
          </div>
        </Card>
        <Card title="THE MIX" sub={style === "diversified" ? "by type — every sector is covered through the ETFs, the leaders add a direct stake in each" : undefined}>
          <DonutChart data={style === "diversified"
            ? (["etf", "stock", "bond", "metal"] as const).map((k) => ({ name: { etf: "Broad ETFs", stock: "Sector leaders", bond: "Bonds", metal: "Gold + silver" }[k], value: Math.round(orders.filter((o: any) => o.kind === k).reduce((s2: number, o: any) => s2 + o.weight, 0) * 1000) / 10 }))
            : orders.map((o: any) => ({ name: o.symbol.replace(".TO", ""), value: Math.round(o.weight * 1000) / 10 }))} valueLabel={(v) => `${v}%`} height={230} />
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <Card title={`IF YOU HAD STARTED IN ${b.from} · REAL PRICES`} sub={`${money(b.invested, cur)} in → ${money(b.value, cur)} today · ${pc(b.annual)} a year · deepest fall ${pc(b.worstDrop, 0)}`}>
          <Lines data={b.curve.filter((_: any, i: number) => i % 2 === 0)} keys={["value", "invested"]} format={(v) => money(v, cur)} height={220} />
          {b.rolling && <p className="prose-sans text-[11px] mt-2 mb-0" style={{ color: "var(--hud-muted)" }}>
            Started in any of {b.rolling.count} different months, a {Math.round(b.rolling.horizonMonths / 12)}-year run ended at <b style={{ color: "var(--hud-red)" }}>{b.rolling.worst.multiple.toFixed(2)}×</b> your money at worst ({b.rolling.worst.start}),
            {" "}<b>{b.rolling.median.multiple.toFixed(2)}×</b> typically and <b style={{ color: "var(--hud-green)" }}>{b.rolling.best.multiple.toFixed(2)}×</b> at best ({b.rolling.best.start}).
            {b.rolling.lossShare > 0 ? ` ${pc(b.rolling.lossShare, 0)} of start dates ended below the money put in.` : " None ended below the money put in."}</p>}
        </Card>
        <Card title={`THE NEXT ${plan.input.years} YEARS · 2,000 SIMULATED PATHS`} sub={`Assumes ${pc(f.assumed.portfolio)} a year (stocks ${pc(f.assumed.stocks)}, bonds ${pc(f.assumed.bonds)}) — slower than the last decade on purpose. At the last decade's pace the median would be ${money(f.histPace, cur)}.`}>
          <Lines data={f.fan.map((r: any) => ({ year: `yr ${r.year}`, "good case": r.p90, likely: r.p50, "bad case": r.p10, "put in": r.invested }))}
                 keys={["good case", "likely", "bad case", "put in"]} xKey="year" format={(v) => money(v, cur)} height={220} />
        </Card>
      </div>

      <Card title="YOUR NEXT 12 BUYS · EXACT DAY AND TIME" className="mb-3"
            sub={`First trading day of each month (weekends and ${plan.input.market === "ca" ? "TSX" : "NYSE"} holidays skipped), 10:00 AM New York — 30 minutes after the open. Value = the plan's simulated range right after that buy.`}>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead><tr style={{ color: "var(--hud-muted)" }}>
              {["#", "BUY ON", "WHAT", "TOTAL PUT IN", "LIKELY VALUE", "RANGE (1 IN 10)"].map((h) => <th key={h} className="text-left px-2 py-1.5 font-normal tracking-widest text-[9px]">{h}</th>)}
            </tr></thead>
            <tbody>
              {a.calendar.map((c: any) => (
                <tr key={c.n} style={{ borderTop: "1px solid var(--hud-border)" }}>
                  <td className="px-2 py-1.5" style={{ color: "var(--hud-muted)" }}>{c.n}</td>
                  <td className="px-2 py-1.5 font-bold whitespace-nowrap">{when(c.at)}</td>
                  <td className="px-2 py-1.5 prose-sans">{orders.length > 4 ? `${orders.length} buys, ${money(orders.reduce((s2: number, o: any) => s2 + o.amount, 0), cur)} — the list above` : orders.map((o: any) => `${money(o.amount, cur)} ${o.symbol.replace(".TO", "")}`).join(" + ")}</td>
                  <td className="px-2 py-1.5">{money(c.invested, cur)}</td>
                  <td className="px-2 py-1.5" style={{ color: tone(c.likely - c.invested) }}>{money(c.likely, cur)}</td>
                  <td className="px-2 py-1.5" style={{ color: "var(--hud-muted)" }}>{money(c.low, cur)} – {money(c.high, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {style === "diversified" && plan.leaders?.length > 0 && (
        <Card title="SECTOR LEADERS · HOW EACH STOCK WAS CHOSEN" className="mb-3"
              sub="One per sector: 10+ years of data, a 10-year return above cash and a positive last 3 years, worst fall above −70%, then the best return per unit of risk (Sharpe) among the sector's leaders.">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] tabular-nums">
              <thead><tr style={{ color: "var(--hud-muted)" }}>{["SECTOR", "STOCK", "10-YR /YR", "3-YR /YR", "SWINGS", "WORST FALL", "SHARPE", "CHOSEN OVER"].map((h) => <th key={h} className="text-left px-2 py-1.5 font-normal tracking-widest text-[9px]">{h}</th>)}</tr></thead>
              <tbody>{plan.leaders.map((l: any) => (
                <tr key={l.symbol} style={{ borderTop: "1px solid var(--hud-border)" }}>
                  <td className="px-2 py-1.5 prose-sans">{l.sector}</td>
                  <td className="px-2 py-1.5"><b>{l.symbol.replace(".TO", "")}</b> <span className="prose-sans" style={{ color: "var(--hud-muted)" }}>{l.name.slice(0, 28)}</span></td>
                  <td className="px-2 py-1.5" style={{ color: tone(l.r10) }}>{pc(l.r10)}</td>
                  <td className="px-2 py-1.5" style={{ color: tone(l.r3) }}>{pc(l.r3)}</td>
                  <td className="px-2 py-1.5">{pc(l.vol, 0)}</td>
                  <td className="px-2 py-1.5" style={{ color: "var(--hud-red)" }}>{pc(l.maxDD, 0)}</td>
                  <td className="px-2 py-1.5">{l.sharpe.toFixed(2)}</td>
                  <td className="px-2 py-1.5 prose-sans" style={{ color: "var(--hud-muted)" }}>{[...l.beat.map((x: string) => x.replace(".TO", "")), ...l.rejected.map((r: any) => `${r.symbol.replace(".TO", "")} ✗ ${r.why}`)].join(" · ") || "—"}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Card>
      )}
      <Card title="DID ADDING STOCKS AND METALS HELP?" className="mb-3">
        <p className="prose-sans text-[12px] m-0">
          {style === "diversified" ? "This diversified plan" : "This ETF-only plan"}: <b>{pc(b.annual)}/yr</b>, deepest fall <b>{pc(b.worstDrop, 0)}</b> ({b.from} → {b.to}).
          {" "}{style === "diversified" ? "The ETF core alone" : "The diversified version"}: <b>{pc(other.annual)}/yr</b>, deepest fall <b>{pc(other.worstDrop, 0)}</b> ({other.from} → {other.to}).
          {" "}Different start dates make these not perfectly comparable; the simulated range above is the fairer view of the future.
        </p>
      </Card>

      <Card title="HOW THIS PLAN WAS WORKED OUT" className="mb-3">
        <ol className="prose-sans text-[12px] leading-relaxed m-0 pl-5">{plan.chain.map((c: string, i: number) => <li key={i}>{c}</li>)}</ol>
      </Card>
    </section>
  );
}

function Watch({ rows }: { rows: any[] | null }) {
  const COLOR: Record<string, string> = { BUY: "var(--hud-green)", "BUY ON DIP": "var(--hud-amber)", HOLD: "var(--hud-accent)", SELL: "var(--hud-red)" };
  return (
    <section className="hud-panel hud-panel-static p-4 mb-4" aria-label="Watch: your funds">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
        <h2 className="text-[11px] tracking-[0.25em] font-bold m-0" style={{ color: "var(--hud-accent)" }}>WATCH · YOUR FUNDS, LIVE</h2>
        <span className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>buy/sell = the 10-month trend rule, kept only where this fund's own history says it paid</span>
      </div>
      {!rows && <p className="text-[11px]" style={{ color: "var(--hud-muted)" }}>Reading live charts and news…</p>}
      {rows?.map((r) => r.error ? null : (
        <div key={r.symbol} className="py-3" style={{ borderTop: "1px solid var(--hud-border)" }}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-bold text-sm">{r.symbol.replace(".TO", "")}</span>
            <span className="tabular-nums">{r.price?.toFixed(2)} {r.currency}</span>
            <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ color: COLOR[r.action], border: "1px solid currentColor" }}>{r.action}</span>
            <Spark data={r.chart.spark} w={120} h={26} />
            <span className="text-[10px]" style={{ color: "var(--hud-muted)" }}>RSI {r.chart.rsi?.toFixed(0)} · {pc(r.chart.fromHigh)} from 1-yr high · as of {when(r.asOf)}</span>
          </div>
          <p className="prose-sans text-[12px] my-1">{r.why}</p>
          {(r.action === "SELL" || r.action === "BUY ON DIP") && (
            <p className="prose-sans text-[11px] my-1" style={{ color: "var(--hud-muted)" }}>
              Your SIP keeps buying {r.symbol.replace(".TO", "")} on schedule either way — this signal is for extra money you choose to time{r.action === "BUY ON DIP" && r.buyLimit ? `; a limit order near ${r.buyLimit.toFixed(2)}` : ""}.
            </p>
          )}
          <div className="grid md:grid-cols-3 gap-2 text-[11px]">
            <div><span style={{ color: "var(--hud-muted)" }}>Next SIP buy: </span><b>{when(r.times.nextSip)}</b></div>
            <div><span style={{ color: "var(--hud-muted)" }}>Rule re-checked at the close: </span><b>{when(r.times.nextCheck)}</b></div>
            <div><span style={{ color: "var(--hud-muted)" }}>Act on a change: </span><b>{when(r.times.actOn)}</b></div>
          </div>
          <div className="text-[10px] mt-1" style={{ color: "var(--hud-muted)" }}>
            Rule on {r.rule.years.toFixed(0)} yrs of this fund: {pc(r.rule.ruleCagr)}/yr, worst fall {pc(r.rule.ruleMaxDD, 0)} · just holding: {pc(r.rule.holdCagr)}/yr, worst {pc(r.rule.holdMaxDD, 0)} ·
            {r.rule.timingWorks ? " timing has paid here" : " timing has NOT paid here — hold"}{r.rule.lastFlip ? ` · last signal ${r.rule.lastFlip.to === "in" ? "buy" : "sell"} ${r.rule.lastFlip.at}` : ""}
          </div>
          {r.news?.length > 0 && (
            <details className="mt-1">
              <summary className="text-[10px] cursor-pointer flex items-center gap-1" style={{ color: "var(--hud-accent)" }}><Newspaper size={11} aria-hidden /> {r.news.length} news items on {r.symbol.replace(".TO", "")} and what it holds</summary>
              {r.news.map((n: any) => (
                <a key={n.link} href={n.link} target="_blank" rel="noreferrer" className="flex gap-2 text-[11px] py-0.5 hover:underline prose-sans">
                  <span className="shrink-0 w-14 text-[10px]" style={{ color: "var(--hud-muted)" }}>{ago(n.at)}</span>
                  <span className="shrink-0 text-[10px] font-bold w-12">{n.about.replace(".TO", "")}</span>
                  <span className="truncate">{n.title}</span><ExternalLink size={10} className="shrink-0 mt-0.5" aria-hidden />
                </a>
              ))}
            </details>
          )}
        </div>
      ))}
    </section>
  );
}

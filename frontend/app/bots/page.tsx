"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import PageHeader from "@/components/PageHeader";
import { Bot, CloudSun } from "lucide-react";
import { Card, Kpi, DonutChart, CompareBars, Lines, Tabs, usd } from "@/components/charts";
import CcxtBotPanel from "@/components/bots/CcxtBotPanel";
import FlowBotPanel from "@/components/bots/FlowBotPanel";
import GammaPulsePanel from "@/components/bots/GammaPulsePanel";
import StocksBotPanel from "@/components/bots/StocksBotPanel";
import MemeBotPanel from "@/components/bots/MemeBotPanel";
import WeatherBotPanel from "@/components/bots/WeatherBotPanel";
import BotFactory from "@/components/bots/BotFactory";

const TABS = [
  { id: "fleet", label: "FLEET" },
  { id: "create", label: "+ CREATE A BOT" },
  { id: "strategy", label: "STRATEGY" },
  { id: "flow", label: "FLOW" },
  { id: "gamma", label: "GAMMA" },
  { id: "stocks", label: "STOCKS" },
  { id: "meme", label: "MEME" },
  { id: "weather", label: "WEATHER" },
];

export default function BotsPage() {
  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <Suspense fallback={null}><Bots /></Suspense>
    </div>
  );
}

function Bots() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "fleet";
  const setTab = (id: string) => router.replace(id === "fleet" ? "/bots" : `/bots?tab=${id}`, { scroll: false });
  return (
    <main className="max-w-6xl mx-auto p-6 font-mono">
      <PageHeader icon={Bot} title="BOT FLEET">every paper account on one screen · $100 each · forward-tested in the open · no real money</PageHeader>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "fleet" && <Fleet />}
      {tab === "create" && <BotFactory />}
      {tab === "strategy" && <CcxtBotPanel />}
      {tab === "flow" && <FlowBotPanel />}
      {tab === "gamma" && <GammaPulsePanel />}
      {tab === "stocks" && <StocksBotPanel />}
      {tab === "meme" && <MemeBotPanel />}
      {tab === "weather" && <WeatherBotPanel />}
    </main>
  );
}

function Fleet() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const load = () => fetch("/api/fleet").then((r) => r.json()).then(setD).catch(() => {});
    load(); const t = setInterval(load, 30_000); return () => clearInterval(t);
  }, []);
  const accounts: any[] = d?.accounts ?? [];
  const t = d?.totals;

  const capital = accounts.map((a) => ({ name: a.name, value: Math.max(0, a.account ?? 0) }));
  const pnlBars = accounts.map((a) => ({ name: a.name, pnl: a.pnl ?? 0 }));
  const winBars = accounts.map((a) => ({ name: a.name, win: (a.winRate ?? 0) * 100, trades: a.trades ?? 0 }));
  const equity: any[] = d?.equity ?? [];
  const goat = (d?.probes ?? []).find((p: any) => p.name === "weather (late-day)");
  const keys = accounts.map((a) => a.name).filter((k) => equity.some((row) => row[k] != null));

  return (
    <div className="flex flex-col gap-4">
      {goat && (
        <div className="hud-glass rounded-2xl p-4 flex flex-wrap items-center gap-4" role="status">
          <span className="hud-page-icon" style={{ width: 40, height: 40, color: "var(--hud-gold)", background: "var(--hud-gold-soft)", boxShadow: "inset 0 0 0 1px rgba(245,185,66,0.3), 0 0 30px -8px rgba(245,185,66,0.5)" }} aria-hidden><CloudSun size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] tracking-[0.22em] font-bold font-mono" style={{ color: "var(--hud-gold)" }}>THE MONEY GOAT — WEATHER</div>
            <div className="prose-sans text-[12px]" style={{ color: "var(--hud-muted)" }}>station observations vs market buckets · trades only after hour 14 of the day · the one proven edge on the desk</div>
          </div>
          <div className="flex gap-5 tabular-nums font-mono text-right">
            <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>PROFIT</div><div className="text-2xl font-bold" style={{ color: "var(--hud-gold)", textShadow: "0 0 24px var(--hud-gold-soft)" }}>+{usd(goat.pnl)}</div></div>
            <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>WIN RATE</div><div className="text-2xl font-bold" style={{ color: "var(--hud-text)" }}>{(goat.winRate * 100).toFixed(0)}%</div></div>
            <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>TRADES</div><div className="text-2xl font-bold" style={{ color: "var(--hud-text)" }}>{goat.trades}</div></div>
            <div><div className="text-[8px] tracking-widest" style={{ color: "var(--hud-muted)" }}>TODAY</div><div className="text-2xl font-bold" style={{ color: (goat.today?.pnl ?? 0) >= 0 ? "var(--hud-green)" : "var(--hud-red)" }}>{goat.today ? `${goat.today.pnl >= 0 ? "+" : ""}${usd(goat.today.pnl)}` : "—"}</div></div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="FLEET BALANCE" value={t ? usd(t.account) : "—"} tone={t && t.pnl >= 0 ? "good" : "bad"} sub={t ? `started at $${t.start}` : ""} />
        <Kpi label="FLEET P&L" value={t ? `${t.pnl >= 0 ? "+" : ""}${usd(t.pnl)}` : "—"} tone={t && t.pnl >= 0 ? "good" : "bad"} sub={t ? `${t.trades} trades` : ""} />
        <Kpi label="ACCOUNTS" value={String(accounts.length)} sub="$100 paper each" />
        <Kpi label="FORWARD TEST" value={d ? `${d.daysTracked} days` : "—"} sub="continuous · daily snapshot" />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Card title="CAPITAL BY ACCOUNT" sub="current balance share of the fleet">
          <DonutChart data={capital} valueLabel={usd} />
        </Card>
        <Card title="P&L COMPARISON" sub="realised, since each account's first trade">
          <CompareBars data={pnlBars} keys={[{ key: "pnl", label: "P&L" }]} format={usd} signed />
        </Card>
        <Card title="WIN RATE" sub="% of resolved trades that closed positive">
          <CompareBars data={winBars} keys={[{ key: "win", label: "win %" }]} format={(v) => `${v.toFixed(0)}%`} />
        </Card>
      </div>

      <Card title="EQUITY — EVERY ACCOUNT" sub="one point per snapshotted day · dashed line is the $100 start">
        <Lines data={equity} keys={keys} format={usd} refY={100} height={300} />
      </Card>

      <Card title="ACCOUNTS" sub="click a tab above for open positions and recent closes">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead><tr className="text-[9px] tracking-widest" style={{ color: "var(--hud-muted)" }}>
              <th className="text-left py-1">BOT</th><th className="text-right">BALANCE</th><th className="text-right">P&L</th>
              <th className="text-right">TRADES</th><th className="text-right">WIN</th><th className="text-right">TODAY</th><th className="text-left pl-4">CONFIG</th>
            </tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.key} className="hud-row">
                  <td className="py-1.5 font-bold whitespace-nowrap" style={{ color: "var(--hud-text)" }}>{a.name}</td>
                  <td className="text-right" style={{ color: a.account >= 100 ? "#34d399" : a.account > 0 ? "var(--hud-text)" : "#f87171" }}>{usd(a.account)}</td>
                  <td className="text-right font-bold" style={{ color: a.pnl >= 0 ? "#34d399" : "#f87171" }}>{a.pnl >= 0 ? "+" : ""}{usd(a.pnl)}</td>
                  <td className="text-right">{a.trades}</td>
                  <td className="text-right">{a.winRate != null ? `${(a.winRate * 100).toFixed(0)}%` : "—"}</td>
                  <td className="text-right" style={{ color: (a.today?.pnl ?? 0) >= 0 ? "#34d399" : "#f87171" }}>{a.today ? `${a.today.pnl >= 0 ? "+" : ""}${usd(a.today.pnl)}` : "—"}</td>
                  <td className="pl-4 max-w-[26rem] truncate" style={{ color: "var(--hud-muted)" }} title={a.config}>{a.config}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {d?.probes?.length > 0 && (
        <Card title="RESEARCH BOOKS" sub="engines scored on their own terms, not on a $100 book — weather is the one that earns">
          <div className="grid md:grid-cols-2 gap-2 text-[11px]">
            {d.probes.map((p: any) => (
              <div key={p.key} className="flex justify-between gap-3 px-3 py-1.5 rounded min-w-0" style={{ background: "rgba(255,255,255,0.02)" }}>
                <span className="truncate font-bold" style={{ color: "var(--hud-text)" }}>{p.name}</span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--hud-muted)" }}>{p.trades} trades · win {p.winRate != null ? `${(p.winRate * 100).toFixed(0)}%` : "—"} · <b style={{ color: p.pnl >= 0 ? "#34d399" : "#f87171" }}>{p.pnl >= 0 ? "+" : ""}{usd(p.pnl ?? 0)}</b></span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

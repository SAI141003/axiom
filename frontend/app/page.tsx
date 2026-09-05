import Link from "next/link";
import TopNav from "@/components/TopNav";

export const metadata = { title: "AXIOM — quant research & paper-trading desk" };

const STATS = [
  { k: "PAPER BOTS", v: "6", sub: "forward-tested, $100 each" },
  { k: "SAFETY ASSERTIONS", v: "10,500", sub: "0 failures" },
  { k: "EXCHANGE REACH", v: "100+", sub: "via CCXT, non-custodial" },
  { k: "MODE", v: "DRY-RUN", sub: "no live orders" },
];

const MODULES: {
  href: string; title: string; desc: string; tag: string; live?: boolean;
}[] = [
  {
    href: "/backtest-lab",
    title: "Backtest Lab",
    desc: "OctoBot-grade engine — real OHLCV, fees + slippage, no look-ahead, walk-forward folds. Where a strategy earns the right to trade.",
    tag: "RESEARCH", live: true,
  },
  {
    href: "/proving-ground",
    title: "Proving Ground",
    desc: "Every execution adapter run through every fault — fills, rejects, slippage, liquidations, rug-pulls. 10,500 assertions, zero failures.",
    tag: "SAFETY", live: true,
  },
  {
    href: "/flow-bot",
    title: "Flow Bot",
    desc: "Reads the live tape the pros read — Cumulative Delta, Big Trades, DOM imbalance. Intraday order flow, forward-tested.",
    tag: "ORDER FLOW", live: true,
  },
  {
    href: "/ccxt-bot",
    title: "Strategy Bot",
    desc: "The evaluator blend on daily BTC/ETH/SOL via CCXT — a downside-protector, only trading where the backtest proved edge.",
    tag: "AUTO-TRADING", live: true,
  },
  {
    href: "/gamma-pulse",
    title: "Gamma Pulse",
    desc: "Dealer gamma regime for stocks & options — above zero-gamma dampens, below amplifies. The 'Deep Gamma' the desks watch.",
    tag: "DEALER FLOW", live: true,
  },
  {
    href: "/venues",
    title: "Trading Venues",
    desc: "Every platform a bot can reach from here, custody model and Canada-legality mapped — MetaMask Agent Wallet, Hyperliquid, Kraken, Jupiter.",
    tag: "CONNECTIVITY",
  },
  {
    href: "/intel",
    title: "Intelligence Desk",
    desc: "Every opportunity from every strategy in one live feed, AI risk review every 10 minutes, and a journal the desk learns from.",
    tag: "AI · LEARNS", live: true,
  },
  {
    href: "/brain",
    title: "The Brain",
    desc: "The reflection loop — perceive resolved trades, attribute wins and losses to segments, write lessons, arm or disarm strategies.",
    tag: "SELF-TUNING", live: true,
  },
  {
    href: "/crypto",
    title: "Crypto Auto-Bot",
    desc: "Auto paper-trades Polymarket's 5-minute Up/Down markets from live CLOB prices — self-learned per-asset config.",
    tag: "AUTO-TRADING", live: true,
  },
  {
    href: "/weather",
    title: "Weather Edge",
    desc: "Station-grade METAR observations + 82-member forecast ensembles vs live market buckets. The proven edge.",
    tag: "SCANNER", live: true,
  },
  {
    href: "/options",
    title: "Options Desk",
    desc: "Live chains, realized-vs-implied vol, call/put recommendation with Kelly sizing — pennies included.",
    tag: "ANALYSIS",
  },
  {
    href: "/terminal",
    title: "Terminal",
    desc: "The full Bloomberg-style desk: order book, charts, live signal feed, kill switch.",
    tag: "PRO",
  },
];

export default function Home() {
  return (
    <div className="hud-bg min-h-screen">
      <TopNav />
      <main className="max-w-6xl mx-auto px-6 py-16 font-mono">

        {/* Hero */}
        <header className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <span className="hud-led" style={{ background: "var(--hud-green)", color: "var(--hud-green)" }} />
            <span className="text-[10px] tracking-[0.25em]" style={{ color: "var(--hud-muted)" }}>
              LIVE · FORWARD-TESTING · PAPER
            </span>
          </div>
          <h1 className="hud-gradient-text text-5xl sm:text-6xl font-extrabold tracking-[0.14em] leading-none">
            AXIOM
          </h1>
          <p className="text-[14px] mt-5 max-w-2xl leading-relaxed" style={{ color: "var(--hud-muted)" }}>
            A quant research and paper-trading desk. Real market data, a walk-forward backtester,
            a scenario-proven safety floor, and a stable of bots under continuous forward-test —
            each one keeping an honest scorecard it can&apos;t fudge.
          </p>
        </header>

        {/* Stats strip */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-12">
          {STATS.map((s) => (
            <div key={s.k} className="hud-panel hud-panel-static px-4 py-3">
              <div className="text-[9px] tracking-[0.18em]" style={{ color: "var(--hud-muted)" }}>{s.k}</div>
              <div className="text-2xl font-bold mt-1 tabular-nums hud-gradient-text">{s.v}</div>
              <div className="text-[9px] mt-0.5" style={{ color: "var(--hud-muted)" }}>{s.sub}</div>
            </div>
          ))}
        </section>

        {/* Modules */}
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-[11px] tracking-[0.22em] font-bold" style={{ color: "var(--hud-text)" }}>THE DESK</h2>
          <div className="flex-1 h-px" style={{ background: "var(--hud-border)" }} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {MODULES.map((m, i) => (
            <Link
              key={m.href}
              href={m.href}
              className="hud-panel p-5 block group"
              style={{ animationDelay: `${i * 35}ms` }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-[9px] tracking-[0.18em]" style={{ color: "var(--hud-accent)" }}>
                  {m.tag}
                </span>
                {m.live && (
                  <span className="flex items-center gap-1.5 text-[9px]" style={{ color: "var(--hud-green)" }}>
                    <span className="hud-led" style={{ background: "var(--hud-green)", color: "var(--hud-green)", width: 5, height: 5 }} />
                    TESTING
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="text-[15px] font-bold" style={{ color: "var(--hud-text)" }}>{m.title}</div>
                <span className="text-[13px] opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200"
                      style={{ color: "var(--hud-accent)" }} aria-hidden>→</span>
              </div>
              <p className="text-[11px] leading-relaxed" style={{ color: "var(--hud-muted)" }}>
                {m.desc}
              </p>
            </Link>
          ))}
        </div>

        {/* Safety line */}
        <p className="mt-12 text-[10px] leading-relaxed max-w-3xl" style={{ color: "var(--hud-muted)" }}>
          <span style={{ color: "var(--hud-amber)" }}>Dry-run by default</span> — no live orders. Per-order and daily
          caps, a trade-only key model that can&apos;t withdraw, and an independent kill switch. Educational only, not financial advice.
        </p>
      </main>
    </div>
  );
}

import { NextResponse } from "next/server";
import { askLLM as askClaude } from "@/lib/llm";

/**
 * AI Desk — 5 working tools. Each fetches LIVE market data server-side,
 * then asks Claude to analyze it. No demo data.
 *
 * Features: stock-analyst | market-intel | macro | risk-engine | alpha-hunter
 */

const YF = "https://query1.finance.yahoo.com";
const UA = { "User-Agent": "Mozilla/5.0" };

async function yfChart(symbol: string, range = "6mo", interval = "1d") {
  const res = await fetch(
    `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
    { headers: UA, next: { revalidate: 300 } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const r = data.chart?.result?.[0];
  if (!r) return null;
  const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  return {
    symbol,
    price: r.meta?.regularMarketPrice ?? null,
    previousClose: r.meta?.chartPreviousClose ?? null,
    high52: r.meta?.fiftyTwoWeekHigh ?? null,
    low52: r.meta?.fiftyTwoWeekLow ?? null,
    closes: closes.filter((c): c is number => c != null),
  };
}

async function yfNews(query: string, count = 8) {
  try {
    const res = await fetch(
      `${YF}/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${count}&quotesCount=0`,
      { headers: UA, next: { revalidate: 300 } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.news ?? []).map((n: any) => ({
      title: n.title,
      publisher: n.publisher,
      published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

function stats(closes: number[]) {
  if (closes.length < 20) return null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * Math.sqrt(252);
  const sorted = [...rets].sort((a, b) => a - b);
  const var95 = sorted[Math.floor(rets.length * 0.05)];
  const cvar95 = sorted.slice(0, Math.max(1, Math.floor(rets.length * 0.05))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(rets.length * 0.05));
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
  const sma200 = closes.reduce((a, b) => a + b, 0) / closes.length;
  const ret1m = closes.length > 21 ? closes[closes.length - 1] / closes[closes.length - 22] - 1 : 0;
  const ret3m = closes.length > 63 ? closes[closes.length - 1] / closes[closes.length - 64] - 1 : 0;
  return {
    annVol: +(vol * 100).toFixed(1),
    dailyVaR95: +(var95 * 100).toFixed(2),
    dailyCVaR95: +(cvar95 * 100).toFixed(2),
    sma50: +sma50.toFixed(2),
    sma200: +sma200.toFixed(2),
    ret1m: +(ret1m * 100).toFixed(1),
    ret3m: +(ret3m * 100).toFixed(1),
  };
}

const ALPHA_UNIVERSE = [
  "NVDA","AMD","AVGO","MU","TSM","SMCI","ARM","MRVL","INTC","QCOM",
  "MSFT","GOOGL","META","AMZN","AAPL","TSLA","NFLX","CRM","ORCL","PLTR",
  "GEV","VST","CEG","LLY","NVO","UNH","JPM","GS","COIN","HOOD",
];

export async function POST(request: Request) {
  let body: { feature?: string; input?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const feature = body.feature ?? "";
  const input = (body.input ?? "").trim();

  try {
    // ── 1. STOCK ANALYST — TradingAgents-style bull/bear debate ──────────
    // (Tauric Research architecture: opposing researchers argue in parallel,
    //  a Fund Manager synthesises the verdict with a conviction score.)
    if (feature === "stock-analyst") {
      const sym = (input || "NVDA").toUpperCase().slice(0, 8);
      const [chart, news] = await Promise.all([yfChart(sym, "1y"), yfNews(sym, 6)]);
      if (!chart?.price) return NextResponse.json({ error: `no data for ${sym}` }, { status: 404 });
      const s = stats(chart.closes);
      const dossier = `LIVE DATA for ${sym}:
Price: $${chart.price} | prev close $${chart.previousClose} | 52wk ${chart.low52}-${chart.high52}
1y stats: ${JSON.stringify(s)}
Recent headlines: ${JSON.stringify(news)}`;

      // Single-roundtrip debate: bull researcher, bear researcher, fund manager
      // verdict — all roles in one structured response (NIM rate-limits
      // concurrent calls, so one call beats three).
      const raw = await askClaude(
        "You are running a TradingAgents-style desk debate. Play three roles in order and label each section EXACTLY with these markers: ===BULL===, ===BEAR===, ===VERDICT===.",
        `${dossier}

===BULL===
Strongest possible bull case from the live data. Numeric, specific, max 120 words.
===BEAR===
Strongest possible bear case from the live data. Numeric, specific, max 120 words.
===VERDICT===
As Fund Manager: (1) which thesis wins and the deciding factor, (2) action — BUY / ACCUMULATE / HOLD / TRIM / AVOID with entry zone, (3) stop level and 3-month target range, (4) conviction score /10 with one-line justification.`,
        1200,
      );

      const bullCase = raw.match(/===BULL===\s*([\s\S]*?)(?====BEAR===)/)?.[1]?.trim() ?? "";
      const bearCase = raw.match(/===BEAR===\s*([\s\S]*?)(?====VERDICT===)/)?.[1]?.trim() ?? "";
      const verdict  = raw.match(/===VERDICT===\s*([\s\S]*)/)?.[1]?.trim() ?? raw;

      return NextResponse.json({
        feature, symbol: sym,
        live: { price: chart.price, ...s },
        debate: bullCase && bearCase ? { bull: bullCase, bear: bearCase } : undefined,
        analysis: verdict,
      });
    }

    // ── 2. MARKET INTEL ──────────────────────────────────────────────────
    if (feature === "market-intel") {
      const syms = (input || "NVDA,TSLA,BTC-USD").split(",").map((s) => s.trim().toUpperCase()).slice(0, 5);
      const newsArr = await Promise.all(syms.map((s) => yfNews(s, 5)));
      const quotes = await Promise.all(syms.map((s) => yfChart(s, "5d")));
      const analysis = await askClaude(
        "You are a 24/7 market intelligence analyst. Only flag things that materially change a thesis. Cite the headline you base each point on.",
        `Watchlist: ${syms.join(", ")}
Live quotes: ${JSON.stringify(quotes.map((q) => q && { symbol: q.symbol, price: q.price, prevClose: q.previousClose }))}
Headlines per ticker: ${JSON.stringify(Object.fromEntries(syms.map((s, i) => [s, newsArr[i]])))}

For each ticker: MATERIAL or NO CHANGE. If material, explain in 2 lines what changed and the trade implication. End with the single most important item across the whole watchlist.`,
      );
      return NextResponse.json({ feature, symbols: syms, analysis });
    }

    // ── 3. MACRO ANALYST ─────────────────────────────────────────────────
    if (feature === "macro") {
      const macroSyms = ["^GSPC", "^IXIC", "^TNX", "DX-Y.NYB", "GC=F", "CL=F", "BTC-USD", "^VIX"];
      const quotes = await Promise.all(macroSyms.map((s) => yfChart(s, "5d")));
      const snapshot = quotes.map((q) => q && {
        symbol: q.symbol, price: q.price,
        chg: q.previousClose ? +(((q.price! - q.previousClose) / q.previousClose) * 100).toFixed(2) : null,
      });
      const analysis = await askClaude(
        "You are a macro strategist writing a tight morning brief. Numbers first, narrative second.",
        `Live macro snapshot (price, % vs prev close): ${JSON.stringify(snapshot)}
User portfolio context: ${input || "long US tech + crypto"}

Write the morning macro brief: (1) what moved overnight and why it matters, (2) rates/dollar read, (3) commodities + crypto read, (4) what it means for the stated portfolio, (5) one thing to watch today. Markdown, under 300 words.`,
      );
      return NextResponse.json({ feature, snapshot, analysis });
    }

    // ── 4. RISK ENGINE ───────────────────────────────────────────────────
    if (feature === "risk-engine") {
      const lines = (input || "NVDA 40\nMSFT 30\nBTC-USD 30").split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
      const parsed = lines.map((l) => {
        const [sym, w] = l.split(/[\s:]+/);
        return { sym: sym.toUpperCase(), weight: parseFloat(w) || 0 };
      }).filter((p) => p.sym && p.weight > 0).slice(0, 8);
      if (parsed.length === 0) return NextResponse.json({ error: "format: TICKER WEIGHT per line" }, { status: 400 });

      const charts = await Promise.all(parsed.map((p) => yfChart(p.sym, "1y")));
      const perAsset = parsed.map((p, i) => ({
        ...p,
        price: charts[i]?.price ?? null,
        stats: charts[i] ? stats(charts[i]!.closes) : null,
      }));
      // portfolio-level daily VaR (correlation≈simple weighted, conservative no-diversification bound too)
      const wsum = parsed.reduce((a, p) => a + p.weight, 0);
      const portVaR = perAsset.reduce((a, p) => a + (p.stats?.dailyVaR95 ?? 0) * (p.weight / wsum), 0);
      const portCVaR = perAsset.reduce((a, p) => a + (p.stats?.dailyCVaR95 ?? 0) * (p.weight / wsum), 0);

      const analysis = await askClaude(
        "You are a portfolio risk manager. Concrete numbers, concrete hedges with instruments and rough costs.",
        `Portfolio (weights %): ${JSON.stringify(perAsset)}
Weighted daily VaR95 ≈ ${portVaR.toFixed(2)}% · weighted daily CVaR95 ≈ ${portCVaR.toFixed(2)}% (correlation-naive).

Give: (1) risk read — concentration, correlated factor exposure, (2) stress estimates for a 2008-style, 2020-COVID-style and rate-shock scenario (% drawdown each), (3) the cheapest realistic hedge for each scenario (instrument + sizing), (4) one rebalancing suggestion. Markdown.`,
      );
      return NextResponse.json({ feature, portfolio: perAsset, portVaR: +portVaR.toFixed(2), portCVaR: +portCVaR.toFixed(2), analysis });
    }

    // ── 5. ALPHA HUNTER ──────────────────────────────────────────────────
    if (feature === "alpha-hunter") {
      const charts = await Promise.all(ALPHA_UNIVERSE.map((s) => yfChart(s, "3mo")));
      const scored = charts
        .filter((c): c is NonNullable<typeof c> => !!c?.price && c.closes.length > 30)
        .map((c) => {
          const s = stats(c.closes)!;
          const distHigh = c.high52 ? (c.price! / c.high52 - 1) * 100 : 0;
          // anomaly score: strong 1m move vs its own vol + distance from high
          const anomaly = Math.abs(s.ret1m) / Math.max(5, s.annVol / Math.sqrt(12));
          return { symbol: c.symbol, price: c.price, ret1m: s.ret1m, ret3m: s.ret3m, annVol: s.annVol, distFromHigh: +distHigh.toFixed(1), anomaly: +anomaly.toFixed(2) };
        })
        .sort((a, b) => b.anomaly - a.anomaly)
        .slice(0, 10);

      const analysis = await askClaude(
        "You are an alpha-hunting quant. Rank by edge, not by hype. Flag crowding.",
        `Nightly anomaly scan of a 30-name liquid universe — top 10 by |1-month return| normalized by own volatility (live data):
${JSON.stringify(scored)}

For the top 5: why is the move interesting, is it likely to continue or mean-revert (with reasoning), and what's the specific trade with a stop. Then name the 2 most crowded names to avoid. Markdown.`,
      );
      return NextResponse.json({ feature, scan: scored, analysis });
    }

    return NextResponse.json({ error: "unknown feature" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}

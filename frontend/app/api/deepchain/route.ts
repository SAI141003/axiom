import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { askLLM } from "@/lib/llm";

/**
 * Deep Chain Research — quant-grade supply-chain intelligence for ANY ticker.
 *
 * Pipeline (anti-hallucination by construction):
 *   1. LIVE GROUNDING: company profile + fresh headlines from Yahoo (real)
 *   2. LLM RESEARCH: parts → named manufacturers (incl. small caps), customers,
 *      known contracts, company history — strict JSON
 *   3. REALITY VALIDATION: every ticker the LLM names is checked against live
 *      quotes. Verified names render with real prices; the rest are labeled
 *      private/unverified. No claim ships without a reality co-sign.
 *   4. 24h file cache (.data/chains/) — ?refresh=1 to force.
 */

const UA = { "User-Agent": "Mozilla/5.0" };
const CACHE_DIR = path.join(process.cwd(), "..", ".data", "chains");
const CACHE_TTL_MS = 24 * 3600 * 1000;

let _auth: { cookie: string; crumb: string; ts: number } | null = null;
async function yahooAuth() {
  if (_auth && Date.now() - _auth.ts < 20 * 60_000) return _auth;
  const r1 = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.includes("{")) throw new Error("crumb failed");
  _auth = { cookie, crumb, ts: Date.now() };
  return _auth;
}

async function resolveSymbol(query: string): Promise<string | null> {
  // exact-ticker fast path (1-5 chars, no spaces) is tried directly by the
  // caller; this resolves company NAMES (or fuzzy input) to a real ticker.
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`,
      { headers: UA, next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const quotes = (await res.json()).quotes ?? [];
    // prefer a US equity/ETF with a clean ticker
    const pick = quotes.find((q: any) =>
      q.symbol && /^[A-Z]{1,5}$/.test(q.symbol) &&
      (q.quoteType === "EQUITY" || q.quoteType === "ETF"));
    return pick?.symbol ?? quotes[0]?.symbol ?? null;
  } catch { return null; }
}

async function profile(sym: string) {
  const { cookie, crumb } = await yahooAuth();
  const res = await fetch(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=assetProfile,price&crumb=${encodeURIComponent(crumb)}`,
    { headers: { ...UA, cookie }, cache: "no-store" },
  );
  if (!res.ok) return null;
  const r = (await res.json()).quoteSummary?.result?.[0];
  if (!r) return null;
  return {
    name: r.price?.longName ?? sym,
    sector: r.assetProfile?.sector ?? "",
    industry: r.assetProfile?.industry ?? "",
    summary: (r.assetProfile?.longBusinessSummary ?? "").slice(0, 900),
    marketCap: r.price?.marketCap?.raw ?? null,
    price: r.price?.regularMarketPrice?.raw ?? null,
  };
}

async function news(sym: string) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${sym}&newsCount=10&quotesCount=0`,
      { headers: UA, next: { revalidate: 600 } });
    if (!res.ok) return [];
    return ((await res.json()).news ?? []).map((n: any) => ({
      title: n.title, publisher: n.publisher, link: n.link,
      ts: n.providerPublishTime ?? null,
    })).slice(0, 10);
  } catch { return []; }
}

async function relatedSymbols(sym: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${sym}`,
      { headers: UA, next: { revalidate: 3600 } });
    if (!res.ok) return [];
    return ((await res.json()).finance?.result?.[0]?.recommendedSymbols ?? [])
      .map((r: any) => r.symbol).slice(0, 8);
  } catch { return []; }
}

interface LiveQ { price: number; chg: number | null; name?: string }
async function validateTickers(tickers: string[]): Promise<Record<string, LiveQ>> {
  if (!tickers.length) return {};
  try {
    const { cookie, crumb } = await yahooAuth();
    const res = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.slice(0, 64).join(",")}&crumb=${encodeURIComponent(crumb)}`,
      { headers: { ...UA, cookie }, cache: "no-store" },
    );
    if (!res.ok) return {};
    const out: Record<string, LiveQ> = {};
    for (const q of (await res.json()).quoteResponse?.result ?? []) {
      if (q.regularMarketPrice != null) out[q.symbol] = {
        price: q.regularMarketPrice,
        chg: q.regularMarketPreviousClose
          ? +(((q.regularMarketPrice - q.regularMarketPreviousClose) / q.regularMarketPreviousClose) * 100).toFixed(2)
          : null,
        name: q.shortName,
      };
    }
    return out;
  } catch { return {}; }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sym = (searchParams.get("symbol") ?? "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 8);
  const refresh = searchParams.get("refresh") === "1";
  if (!sym) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  // cache
  await fs.mkdir(CACHE_DIR, { recursive: true });
  let cacheFile = path.join(CACHE_DIR, `${sym}.json`);
  if (!refresh) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf-8"));
      if (Date.now() - cached.generated < CACHE_TTL_MS) return NextResponse.json(cached);
    } catch {}
  }

  let resolved = sym;
  let prof = await profile(resolved);
  if (!prof) {
    // not a valid ticker — treat the input as a company NAME and resolve it
    const guess = await resolveSymbol(searchParams.get("symbol") ?? sym);
    if (guess && guess !== sym) {
      resolved = guess;
      prof = await profile(resolved);
    }
  }
  if (!prof) return NextResponse.json({
    error: `couldn't find a stock for "${sym}" — try the ticker symbol (e.g. F for Ford, PLTR for Palantir)`,
  }, { status: 404 });
  const [headlines, related] = await Promise.all([news(resolved), relatedSymbols(resolved)]);

  const raw = await askLLM(
    "You are a supply-chain intelligence analyst at a quant fund. Precision over completeness: " +
    "name only relationships you are confident are real; if a supplier is private or uncertain, say so in the note. " +
    "Include SMALL-CAP and lesser-known suppliers where real. Respond with STRICT JSON only, no markdown fences.",
    `Company: ${prof.name} (${resolved}) — ${prof.sector} / ${prof.industry}
Business: ${prof.summary}
Recent headlines: ${JSON.stringify(headlines)}

Produce this exact JSON shape:
{
 "overview": "2-sentence what they make and where they sit in the chain",
 "parts": [
   {"component": "part/subsystem name",
    "suppliers": [{"name":"Company", "ticker":"TICK or null if private", "note":"what exactly they supply"}]}
 ],
 "customers": [{"name":"Company", "ticker":"TICK or null", "note":"what they buy"}],
 "contracts": [{"party":"Company", "desc":"known contract/design win/partnership", "year":"YYYY or 'ongoing'"}],
 "history": [{"year":"YYYY", "event":"milestone: acquisitions, fabs, product launches"}],
 "risks": ["concentration/geopolitical/technology risks"]
}
Cover EVERY major component tier (for hardware: silicon, memory, storage, power, cooling, assembly, materials). 4-8 parts, 3-6 history events, 2-5 contracts.`,
    2000,
  );

  let data: any;
  try {
    data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  } catch {
    return NextResponse.json({ error: "research parse failed — retry" }, { status: 502 });
  }

  // ── REALITY VALIDATION: every named ticker must have a live quote ──────────
  const named = new Set<string>();
  for (const p of data.parts ?? []) for (const su of p.suppliers ?? [])
    if (su.ticker) named.add(String(su.ticker).toUpperCase());
  for (const c of data.customers ?? []) if (c.ticker) named.add(String(c.ticker).toUpperCase());
  for (const r of related) named.add(r.toUpperCase());
  const live = await validateTickers(Array.from(named));

  const stamp = (x: any) => {
    const t = x.ticker ? String(x.ticker).toUpperCase() : null;
    const q = t ? live[t] : undefined;
    return { ...x, ticker: t, verified: !!q, price: q?.price ?? null, chg: q?.chg ?? null };
  };
  for (const p of data.parts ?? []) p.suppliers = (p.suppliers ?? []).map(stamp);
  data.customers = (data.customers ?? []).map(stamp);

  // connected companies: everything verified (suppliers+customers+Yahoo-related)
  const connected = Array.from(named)
    .filter((t) => live[t])
    .map((t) => ({ ticker: t, name: live[t].name ?? t, price: live[t].price,
                   chg: live[t].chg, related: related.includes(t) }))
    .sort((a, b) => Math.abs(b.chg ?? 0) - Math.abs(a.chg ?? 0));

  const payload = {
    symbol: resolved, profile: prof, headlines, connected,
    ...data,
    validation: {
      named: named.size,
      verified: Object.keys(live).length,
      note: "verified = ticker returns a live quote right now; others are private or unverified",
    },
    generated: Date.now(),
  };
  await fs.writeFile(cacheFile, JSON.stringify(payload));
  return NextResponse.json(payload);
}

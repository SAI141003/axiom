import { promises as fs } from "fs";
import path from "path";

// INVEST — long-term ETF data for the US and Canadian markets, from Yahoo.
// Everything shown is computed from real monthly prices (dividends included,
// via adjusted close) and the funds' own profiles: expense ratio, assets,
// yield, top holdings, sector weights. Cached 6h per market in .data/.

export type Market = "us" | "ca";

export type Etf = {
  symbol: string; name: string; family: string | null; category: string | null; currency: string;
  price: number; aum: number | null; expense: number | null; yield: number | null;
  stock: number | null; bond: number | null;
  r1: number | null; r3: number | null; r5: number | null; r10: number | null;   // annualised, dividends in
  vol: number | null; maxDD: number | null; sharpe: number | null; corr: number | null;
  months: number; holdings: { symbol: string | null; name: string; weight: number }[];
  sectors: { name: string; weight: number }[];
  spark: number[];                 // last 10y of month-end prices, normalised to 1
  twin: string | null;             // another ETF here that tracks the same thing (corr ≥ 0.995)
};

// Candidates per market; the 20 largest by assets are shown.
const CANDIDATES: Record<Market, string[]> = {
  us: ["VOO", "IVV", "SPY", "VTI", "QQQ", "VUG", "VEA", "IEFA", "VTV", "BND", "AGG", "IWF", "IJH", "VIG",
       "VXUS", "IEMG", "VGT", "SCHD", "IWM", "GLD", "VWO", "VYM", "BNDX", "XLK", "RSP", "VO", "VB", "IAU", "TLT", "SCHX"],
  ca: ["XIU.TO", "XIC.TO", "VFV.TO", "ZSP.TO", "XEQT.TO", "VEQT.TO", "XGRO.TO", "VGRO.TO", "XBAL.TO", "VBAL.TO",
       "ZAG.TO", "XBB.TO", "VCN.TO", "ZCN.TO", "XUU.TO", "VUN.TO", "XEF.TO", "XEC.TO", "ZEB.TO", "HXT.TO",
       "XAW.TO", "VIU.TO", "ZQQ.TO", "ZDV.TO", "XSP.TO", "HXQ.TO", "XUS.TO", "QQC.TO", "ZEA.TO", "XQQ.TO"],
};
export const BENCH: Record<Market, string> = { us: "SPY", ca: "XIC.TO" };
const RF = 0.04;   // cash yield for Sharpe

const UA = { "User-Agent": "Mozilla/5.0" };
let crumbCache: { crumb: string; cookie: string; at: number } | null = null;
async function crumb() {
  if (crumbCache && Date.now() - crumbCache.at < 3600_000) return crumbCache;
  const r = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" }).catch(() => null);
  const cookie = (r?.headers.get("set-cookie") ?? "").split(";")[0];
  const c = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, cookie } }).then((x) => x.text()).catch(() => "");
  crumbCache = { crumb: c, cookie, at: Date.now() };
  return crumbCache;
}

export async function monthly(symbol: string, range = "10y"): Promise<{ t: number[]; px: number[]; meta: any } | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1mo&events=div`, { headers: UA, cache: "no-store" });
    const res = (await r.json())?.chart?.result?.[0];
    const adj: (number | null)[] = res?.indicators?.adjclose?.[0]?.adjclose ?? res?.indicators?.quote?.[0]?.close ?? [];
    const t: number[] = []; const px: number[] = [];
    (res?.timestamp ?? []).forEach((ts: number, i: number) => { const v = adj[i]; if (v != null && isFinite(v)) { t.push(ts); px.push(v); } });
    // Yahoo's last monthly bar is the current price; earlier bars are month-starts
    return px.length > 12 ? { t, px, meta: res.meta } : null;
  } catch { return null; }
}

async function profile(symbol: string) {
  try {
    const { crumb: c, cookie } = await crumb();
    const r = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=fundProfile,topHoldings,summaryDetail,price&crumb=${encodeURIComponent(c)}`,
      { headers: { ...UA, cookie }, cache: "no-store" });
    return (await r.json())?.quoteSummary?.result?.[0] ?? null;
  } catch { return null; }
}

const rets = (px: number[]) => px.slice(1).map((v, i) => v / px[i] - 1);
const cagr = (px: number[], months: number) => px.length > months ? Math.pow(px[px.length - 1] / px[px.length - 1 - months], 12 / months) - 1 : null;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function corrOf(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length); if (n < 24) return null;
  const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sx * sy);
}
function maxDrawdown(px: number[]) { let peak = px[0], dd = 0; for (const v of px) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); } return dd; }
const raw = (x: any): number | null => (x && typeof x.raw === "number" ? x.raw : null);

const CACHE = (m: Market) => path.join(process.cwd(), "..", ".data", `invest_universe_${m}.json`);

export async function universe(market: Market, fresh = false): Promise<{ market: Market; generated: number; etfs: Etf[] }> {
  if (!fresh) {
    try { const c = JSON.parse(await fs.readFile(CACHE(market), "utf-8")); if (Date.now() - c.generated < 6 * 3600_000) return c; } catch {}
  }
  const list = CANDIDATES[market];
  const [series, profs] = await Promise.all([Promise.all(list.map((s) => monthly(s))), Promise.all(list.map((s) => profile(s)))]);
  const bench = series[list.indexOf(BENCH[market])];
  const benchR = bench ? rets(bench.px) : [];
  const rows: Etf[] = [];
  list.forEach((sym, i) => {
    const s = series[i], p = profs[i];
    if (!s) return;
    const r = rets(s.px), fp = p?.fundProfile, th = p?.topHoldings, sd = p?.summaryDetail;
    const vol = r.length > 12 ? std(r) * Math.sqrt(12) : null;
    const r5 = cagr(s.px, 60) ?? cagr(s.px, s.px.length - 1);
    rows.push({
      symbol: sym, name: p?.price?.longName ?? s.meta?.longName ?? sym, family: fp?.family ?? null, category: fp?.categoryName ?? null,
      currency: s.meta?.currency ?? (market === "ca" ? "CAD" : "USD"), price: s.meta?.regularMarketPrice ?? s.px[s.px.length - 1],
      aum: raw(sd?.totalAssets), expense: raw(fp?.feesExpensesInvestment?.annualReportExpenseRatio), yield: raw(sd?.yield),
      stock: raw(th?.stockPosition), bond: raw(th?.bondPosition),
      r1: cagr(s.px, 12), r3: cagr(s.px, 36), r5: cagr(s.px, 60), r10: cagr(s.px, 119),
      vol, maxDD: maxDrawdown(s.px), sharpe: vol && r5 != null ? (r5 - RF) / vol : null,
      corr: corrOf(r, benchR), months: s.px.length,
      holdings: (th?.holdings ?? []).slice(0, 5).map((h: any) => ({ symbol: h.symbol ?? null, name: h.holdingName, weight: raw(h.holdingPercent) ?? 0 })),
      sectors: (th?.sectorWeightings ?? []).map((x: any) => { const k = Object.keys(x)[0]; return { name: k.replace(/_/g, " "), weight: raw(x[k]) ?? 0 }; })
        .filter((x: any) => x.weight > 0).sort((a: any, b: any) => b.weight - a.weight).slice(0, 4),
      spark: s.px.map((v) => v / s.px[0]), twin: null,
    });
  });
  // top 20 by assets; ETFs without a reported size go last
  rows.sort((a, b) => (b.aum ?? -1) - (a.aum ?? -1));
  const top = rows.slice(0, 20);
  // twins: funds that move together almost exactly track the same index
  const rmap = new Map(top.map((e) => [e.symbol, rets(series[list.indexOf(e.symbol)]!.px)]));
  for (const e of top) {
    let best: string | null = null, bc = 0.995;
    for (const o of top) { if (o.symbol === e.symbol) continue; const c = corrOf(rmap.get(e.symbol)!, rmap.get(o.symbol)!); if (c != null && c >= bc) { bc = c; best = o.symbol; } }
    e.twin = best;
  }
  const out = { market, generated: Date.now(), etfs: top };
  try { await fs.writeFile(CACHE(market), JSON.stringify(out)); } catch {}
  return out;
}

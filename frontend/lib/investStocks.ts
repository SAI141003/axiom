import { monthly, type Market } from "./invest";
import { swr } from "./swr";

// SECTOR LEADERS — one proven stock per sector for the SIP's stock slice.
// Candidates are the large leaders of each of the 11 GICS sectors. A stock
// qualifies only with 10+ years of history, a 10-year return above cash (4%), a worst
// fall no deeper than -70%, and a positive last 3 years; the qualifier with the
// best 10-year Sharpe (return per unit of risk) is picked for its sector.
// Past leaders are not promised future leaders, which is why the plan keeps
// stocks a minority slice beside broad ETFs that hold every company anyway.

export const SECTORS = ["Technology", "Communication", "Consumer discretionary", "Consumer staples", "Health care",
  "Financials", "Industrials", "Energy", "Utilities", "Real estate", "Materials"] as const;

const CANDIDATES: Record<Market, Record<string, string[]>> = {
  us: {
    "Technology": ["MSFT", "AAPL", "NVDA"], "Communication": ["GOOGL", "META", "NFLX"],
    "Consumer discretionary": ["AMZN", "HD", "MCD"], "Consumer staples": ["COST", "PG", "KO"],
    "Health care": ["LLY", "UNH", "JNJ"], "Financials": ["JPM", "V", "BRK-B"],
    "Industrials": ["CAT", "GE", "UNP"], "Energy": ["XOM", "CVX"], "Utilities": ["NEE", "DUK"],
    "Real estate": ["PLD", "AMT"], "Materials": ["LIN", "SHW"],
  },
  ca: {
    "Technology": ["CSU.TO", "SHOP.TO", "OTEX.TO"], "Communication": ["RCI-B.TO", "T.TO", "BCE.TO"],
    "Consumer discretionary": ["DOL.TO", "CTC-A.TO"], "Consumer staples": ["ATD.TO", "L.TO", "MRU.TO"],
    "Financials": ["RY.TO", "TD.TO", "BN.TO"], "Industrials": ["CNR.TO", "CP.TO", "WCN.TO"],
    "Energy": ["CNQ.TO", "ENB.TO", "SU.TO"], "Utilities": ["FTS.TO", "H.TO", "EMA.TO"],
    "Real estate": ["CAR-UN.TO", "REI-UN.TO"], "Materials": ["AEM.TO", "NTR.TO", "FNV.TO"],
    // Canada has no large listed health-care leader; the ETF core covers the sector
  },
};

export type Leader = {
  sector: string; symbol: string; name: string; price: number; r10: number; r3: number; vol: number; maxDD: number;
  sharpe: number; months: number; beat: string[];       // candidates it was chosen over
  rejected: { symbol: string; why: string }[];
};

const RF = 0.04;
const cagr = (px: number[], n: number) => Math.pow(px[px.length - 1] / px[px.length - 1 - n], 12 / n) - 1;
function stats(px: number[]) {
  const r = px.slice(1).map((v, i) => v / px[i] - 1), m = r.reduce((s, x) => s + x, 0) / r.length;
  const vol = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(12);
  let peak = px[0], dd = 0; for (const v of px) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  const r10 = cagr(px, Math.min(120, px.length - 1)), r3 = cagr(px, 36);
  return { r10, r3, vol, maxDD: dd, sharpe: (r10 - RF) / vol };
}

export function leaders(market: Market): Promise<Leader[]> {
  return swr(`leaders:${market}`, 12 * 3600_000, async () => {
    const out: Leader[] = [];
    await Promise.all(Object.entries(CANDIDATES[market]).map(async ([sector, syms]) => {
      const rows = (await Promise.all(syms.map(async (s) => ({ s, d: await monthly(s, "20y") })))).map(({ s, d }) => {
        if (!d || d.px.length < 121) return { s, why: "under 10 years of history" };
        const st = stats(d.px);
        if (st.r10 <= RF) return { s, why: `earned ${(st.r10 * 100).toFixed(1)}%/yr over 10 years — no better than cash` };
        if (st.maxDD < -0.7) return { s, why: `fell ${(st.maxDD * 100).toFixed(0)}% at worst` };
        if (st.r3 <= 0) return { s, why: `down over the last 3 years (${(st.r3 * 100).toFixed(1)}%/yr)` };
        return { s, st, name: d.meta?.longName ?? s, price: d.meta?.regularMarketPrice ?? d.px[d.px.length - 1], months: d.px.length };
      });
      const ok = rows.filter((r: any) => r.st).sort((a: any, b: any) => b.st.sharpe - a.st.sharpe) as any[];
      if (!ok.length) return;
      const w = ok[0];
      out.push({ sector, symbol: w.s, name: w.name, price: w.price, months: w.months, ...w.st,
        beat: ok.slice(1).map((r) => r.s), rejected: rows.filter((r: any) => r.why).map((r: any) => ({ symbol: r.s, why: r.why })) });
    }));
    return out.sort((a, b) => SECTORS.indexOf(a.sector as any) - SECTORS.indexOf(b.sector as any));
  });
}

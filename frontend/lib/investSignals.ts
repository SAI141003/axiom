import { monthly } from "./invest";

// WATCH — when to buy and when to sell, from the live chart and a tested rule.
//
// The rule is the 10-month moving average (Faber, "A Quantitative Approach to
// Tactical Asset Allocation", 2007): hold while the month-end close is above
// its 10-month average, step aside when it closes below. It is checked once a
// month at the close, so a single bad week does not trigger it. Each fund's
// own 20-year history is replayed with it, and the page shows whether the rule
// actually helped that fund — it mostly trims crashes, it rarely adds return.
//
// Daily chart readings (50/200-day averages, RSI, distance from the high) set
// the price to buy at for extra cash. A monthly SIP is not timed: it buys on
// the first trading day of every month, whatever the chart says.

const UA = { "User-Agent": "Mozilla/5.0" };
const ET = "America/New_York";

async function daily(symbol: string) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1d`, { headers: UA, cache: "no-store" });
    const res = (await r.json())?.chart?.result?.[0];
    const c: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? [];
    const t: number[] = []; const px: number[] = [];
    (res?.timestamp ?? []).forEach((ts: number, i: number) => { const v = c[i]; if (v != null) { t.push(ts); px.push(v); } });
    return { t, px, meta: res?.meta };
  } catch { return null; }
}

async function news(symbol: string, n = 6) {
  try {
    const x = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`, { headers: UA, cache: "no-store" }).then((r) => r.text());
    const dec = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
    return Array.from(x.matchAll(/<item>([\s\S]*?)<\/item>/g)).slice(0, n).map((m) => ({
      title: dec(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""),
      link: dec(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? ""),
      at: Date.parse(m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "") || null,
      about: symbol,
    })).filter((i) => i.title);
  } catch { return []; }
}

const sma = (a: number[], n: number) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);
function rsi(a: number[], n = 14) {
  if (a.length <= n) return null;
  let g = 0, l = 0;
  for (let i = a.length - n; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const cagr = (v0: number, v1: number, months: number) => Math.pow(v1 / v0, 12 / months) - 1;
function maxDD(curve: number[]) { let p = curve[0], d = 0; for (const v of curve) { p = Math.max(p, v); d = Math.min(d, v / p - 1); } return d; }

// last weekday of a month, 4:00 PM New York, as epoch ms
function monthEndClose(year: number, month0: number): number {
  const d = new Date(Date.UTC(year, month0 + 1, 0, 12));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return nyTime(d.toISOString().slice(0, 10), 16, 0);
}
function nextWeekday(ms: number) { const d = new Date(ms + 86400_000); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function firstWeekday(year: number, month0: number) { const d = new Date(Date.UTC(year, month0, 1, 12)); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function nyTime(date: string, h: number, m: number): number {   // a New York wall-clock time → epoch ms
  const guess = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const asNy = Date.parse(new Date(guess).toLocaleString("sv-SE", { timeZone: ET }).replace(" ", "T") + "Z");
  return guess - (asNy - guess);
}

export async function watch(symbol: string, holdings: string[] = []) {
  const [d, m, own, ...hn] = await Promise.all([daily(symbol), monthly(symbol, "20y"), news(symbol, 6), ...holdings.slice(0, 3).map((h) => news(h, 3))]);
  if (!d || d.px.length < 60 || !m) return { symbol, error: "no price data" };
  const price = d.meta?.regularMarketPrice ?? d.px[d.px.length - 1];
  const asOf = (d.meta?.regularMarketTime ?? d.t[d.t.length - 1]) * 1000;
  const s50 = sma(d.px, 50), s200 = sma(d.px, 200), r = rsi(d.px);
  const yr = d.px.slice(-252), hi = Math.max(...yr), lo = Math.min(...yr);

  // ── the 10-month rule on this fund's own history ──
  // each monthly bar closes at that month's last close; the final bar is the
  // month still in progress, so the rule reads only the finished ones
  const mc = m.px.slice(0, -1);
  const mt = m.t.slice(0, -1);
  let inMkt = true, eqRule = 1, eqHold = 1, lastFlip: { at: string; to: "in" | "out" } | null = null, trades = 0;
  const ruleCurve = [1], holdCurve = [1];
  for (let i = 10; i < mc.length; i++) {
    const ret = mc[i] / mc[i - 1] - 1;
    eqHold *= 1 + ret; if (inMkt) eqRule *= 1 + ret; else eqRule *= 1 + 0.03 / 12;   // cash earns ~3%
    ruleCurve.push(eqRule); holdCurve.push(eqHold);
    const avg = mc.slice(i - 9, i + 1).reduce((s, x) => s + x, 0) / 10;
    const want = mc[i] >= avg;
    if (want !== inMkt) { inMkt = want; trades++; lastFlip = { at: new Date(mt[i] * 1000).toISOString().slice(0, 7), to: want ? "in" : "out" }; }
  }
  const years = (mc.length - 10) / 12;
  const tenAvg = mc.slice(-10).reduce((s, x) => s + x, 0) / 10;
  const ruleSaysIn = mc[mc.length - 1] >= tenAvg;

  // ── exact times ──
  const now = new Date();
  const nyNow = new Date(now.toLocaleString("en-US", { timeZone: ET }));
  let check = monthEndClose(nyNow.getFullYear(), nyNow.getMonth());
  if (check < now.getTime()) check = monthEndClose(nyNow.getFullYear(), nyNow.getMonth() + 1);
  const actDay = nextWeekday(check);
  const act = nyTime(actDay, 10, 0);                       // 30 minutes after the open: spreads have settled
  const nm = nyNow.getDate() <= 3 && nyNow.getHours() < 10 ? nyNow.getMonth() : nyNow.getMonth() + 1;
  const sipDay = firstWeekday(nyNow.getFullYear() + (nm > 11 ? 1 : 0), nm % 12);
  const sip = nyTime(sipDay, 10, 0);

  // ── the call ──
  const ruleCagr = cagr(1, eqRule, years * 12), holdCagr = cagr(1, eqHold, years * 12);
  // the rule only earns a SELL where this fund's own history says it paid
  const timingWorks = ruleCagr >= holdCagr - 0.005;
  let action: "BUY" | "BUY ON DIP" | "HOLD" | "SELL";
  let why: string;
  if (!ruleSaysIn && timingWorks) {
    action = "SELL";
    why = `Month-end close ${mc[mc.length - 1].toFixed(2)} is below its 10-month average ${tenAvg.toFixed(2)}, and on this fund's ${years.toFixed(0)}-year history that exit paid (${(ruleCagr * 100).toFixed(1)}%/yr vs ${(holdCagr * 100).toFixed(1)}% holding). Sell at the next session; buy back after a month-end close above the average.`;
  } else if (!ruleSaysIn) {
    action = "HOLD";
    why = `Below its 10-month average, but selling on that signal cost ${((holdCagr - ruleCagr) * 100).toFixed(1)}%/yr on this fund's history — hold, and keep the SIP going.`;
  } else if (r != null && r > 70) {
    action = "BUY ON DIP";
    why = `Trend is up but RSI ${r.toFixed(0)} is stretched. Extra cash: wait for a pull-back toward the 50-day average (${s50?.toFixed(2)}).`;
  } else if (s200 != null && price < s200) {
    action = "HOLD";
    why = `Monthly trend still up but the price is under its 200-day average (${s200.toFixed(2)}) — hold, add only through the SIP until it recovers.`;
  } else {
    action = "BUY";
    why = `Above its 10-month and 200-day averages, RSI ${r?.toFixed(0) ?? "—"} — trend intact.`;
  }
  const buyLimit = action === "BUY ON DIP" && s50 ? s50 : price;

  const items = [...own, ...hn.flat()].filter((x, i, a) => a.findIndex((y) => y.title === x.title) === i)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 10);

  return {
    symbol, price, currency: d.meta?.currency, asOf,
    chart: { s50, s200, rsi: r, high52: hi, low52: lo, fromHigh: price / hi - 1,
             spark: d.px.slice(-252).filter((_, i) => i % 3 === 0) },
    rule: { in: ruleSaysIn, tenMonthAvg: tenAvg, lastFlip, trades, years,
            ruleCagr, holdCagr, timingWorks,
            ruleMaxDD: maxDD(ruleCurve), holdMaxDD: maxDD(holdCurve) },
    action, why, buyLimit,
    times: { nextCheck: check, actOn: act, nextSip: sip },
    news: items,
  };
}

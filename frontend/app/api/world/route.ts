import { NextResponse } from "next/server";
import CATALOG from "./catalog.json";

export const dynamic = "force-dynamic";

// The World Wire: World Monitor's complete open feed catalog (koala73/
// worldmonitor, AGPL-3.0) -- 574 feeds across 48 categories, every one of
// them. Categories are read on demand and cached, so opening "markets" costs
// 14 fetches, not 574; "all" merges whatever is cached plus the market core.
type Feed = { cat: string; name: string; url: string };
const FEEDS = CATALOG as Feed[];
const LABEL: Record<string, string> = { markets: "Markets", finance: "Finance", crypto: "Crypto", commodities: "Commodities", energy: "Energy", bonds: "Bonds", forex: "Forex", derivatives: "Derivatives", centralbanks: "Central banks", economic: "Economic", institutional: "Institutional", fintech: "Fintech", ipo: "IPOs", unicorns: "Unicorns", startups: "Startups", funding: "Funding", vcblogs: "VC blogs", layoffs: "Layoffs", ai: "AI", tech: "Tech", cloud: "Cloud", hardware: "Hardware", security: "Security", dev: "Dev", github: "GitHub", producthunt: "Product Hunt", crisis: "Crisis", politics: "Politics", policy: "Policy", us: "United States", gov: "Government", thinktanks: "Think tanks", analysis: "Analysis", middleeast: "Middle East", gccNews: "Gulf", europe: "Europe", asia: "Asia", latam: "Latin America", africa: "Africa", accelerators: "Accelerators", regionalStartups: "Regional startups", outages: "Outages", nature: "Nature", science: "Science", podcasts: "Podcasts", positive: "Good news", inspiring: "Inspiring", community: "Community" };
const CORE = ["markets", "finance", "crypto", "commodities", "energy", "bonds", "forex", "centralbanks", "economic", "crisis", "politics"];
const ORDER = Object.keys(LABEL);

const cache = new Map<string, { at: number; items: any[] }>();
const TTL = 5 * 60_000;
const dec = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "").trim();

async function readFeed(f: Feed) {
  try {
    const r = await fetch(f.url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "Mozilla/5.0 (AXIOM world wire)" }, cache: "no-store" });
    const xml = await r.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/g)].slice(0, 10).map((m) => {
      const e = m[1] ?? m[2] ?? "";
      const g = (t: string) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)) || [])[1] ?? "";
      const link = g("link") || (e.match(/<link[^>]+href="([^"]+)"/) || [])[1] || "";
      const when = Date.parse(g("pubDate") || g("published") || g("updated") || "") || 0;
      return { title: dec(g("title")).slice(0, 180), link: link.trim(), when, source: f.name, cat: f.cat };
    }).filter((x) => x.title);
  } catch { return []; }
}

async function category(cat: string) {
  const c = cache.get(cat);
  if (c && Date.now() - c.at < TTL) return c.items;
  const feeds = FEEDS.filter((f) => f.cat === cat);
  // bounded concurrency so a 90-feed region does not open 90 sockets at once
  const items: any[] = [];
  for (let i = 0; i < feeds.length; i += 12) items.push(...(await Promise.all(feeds.slice(i, i + 12).map(readFeed))).flat());
  const seen = new Set<string>();
  const out = items.filter((x) => { const k = x.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.when - a.when);
  cache.set(cat, { at: Date.now(), items: out });
  return out;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const want = url.searchParams.get("cat");
  const counts = Object.fromEntries(ORDER.map((c) => [c, FEEDS.filter((f) => f.cat === c).length]).filter(([, n]) => (n as number) > 0));
  if (want && want !== "all" && counts[want]) {
    const items = await category(want);
    return NextResponse.json({ generated: Date.now(), cat: want, label: LABEL[want], feeds: counts[want], items: items.slice(0, 80), catalog: counts, labels: LABEL, total_feeds: FEEDS.length });
  }
  // "all": the market core, read fresh, merged, freshest first
  const core = (await Promise.all(CORE.map(category))).flat().sort((a, b) => b.when - a.when);
  const categories = CORE.filter((c) => counts[c]).map((c) => ({ id: c, label: LABEL[c], items: (cache.get(c)?.items ?? []).slice(0, 12) }));
  return NextResponse.json({ generated: Date.now(), cat: "all", feeds: CORE.reduce((s, c) => s + (counts[c] ?? 0), 0), items: core.slice(0, 120), categories, catalog: counts, labels: LABEL, total_feeds: FEEDS.length });
}

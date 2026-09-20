import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// The World Wire: a curated slice of World Monitor's open feed catalog
// (koala73/worldmonitor, AGPL-3.0 — 748 feeds across 15 categories). We take
// 76 of them across the categories that move markets, read them directly,
// and group the freshest items. Attribution on /about.
const FEEDS: { cat: string; name: string; url: string }[] = [
  { cat: "markets", name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { cat: "markets", name: "MarketWatch", url: "https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "markets", name: "Yahoo Finance", url: "https://finance.yahoo.com/rss/topstories" },
  { cat: "markets", name: "Seeking Alpha", url: "https://seekingalpha.com/market_currents.xml" },
  { cat: "markets", name: "Reuters Markets", url: "https://news.google.com/rss/search?q=site:reuters.com+markets+stocks+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "markets", name: "Bloomberg Markets", url: "https://news.google.com/rss/search?q=site:bloomberg.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "finance", name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { cat: "finance", name: "MarketWatch", url: "https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "finance", name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { cat: "finance", name: "Financial Times", url: "https://www.ft.com/rss/home" },
  { cat: "finance", name: "Reuters Business", url: "https://news.google.com/rss/search?q=site:reuters.com+business+markets&hl=en-US&gl=US&ceid=US:en" },
  { cat: "finance", name: "Fox Business", url: "https://moxie.foxbusiness.com/google-publisher/latest.xml" },
  { cat: "crypto", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { cat: "crypto", name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { cat: "crypto", name: "The Block", url: "https://news.google.com/rss/search?q=site:theblock.co+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "crypto", name: "Crypto News", url: "https://news.google.com/rss/search?q=(bitcoin+OR+ethereum+OR+crypto+OR+\"digital+assets\")+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "crypto", name: "DeFi News", url: "https://news.google.com/rss/search?q=(DeFi+OR+\"decentralized+finance\"+OR+DEX+OR+\"yield+farming\")+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "crypto", name: "Decrypt", url: "https://decrypt.co/feed" },
  { cat: "commodities", name: "Oil & Gas", url: "https://news.google.com/rss/search?q=(oil+price+OR+OPEC+OR+\"natural+gas\"+OR+\"crude+oil\"+OR+WTI+OR+Brent)+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "commodities", name: "Gold & Metals", url: "https://news.google.com/rss/search?q=(gold+price+OR+silver+price+OR+copper+OR+platinum+OR+\"precious+metals\")+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "commodities", name: "Agriculture", url: "https://news.google.com/rss/search?q=(wheat+OR+corn+OR+soybeans+OR+coffee+OR+sugar)+price+OR+commodity+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "commodities", name: "Commodity Trading", url: "https://news.google.com/rss/search?q=(\"commodity+trading\"+OR+\"futures+market\"+OR+CME+OR+NYMEX+OR+COMEX)+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "energy", name: "Oil & Gas", url: "https://news.google.com/rss/search?q=(oil+price+OR+OPEC+OR+\"natural+gas\"+OR+pipeline+OR+LNG)+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "energy", name: "Nuclear Energy", url: "https://news.google.com/rss/search?q=(\"nuclear+energy\"+OR+\"nuclear+power\"+OR+uranium+OR+IAEA)+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "energy", name: "Reuters Energy", url: "https://news.google.com/rss/search?q=site:reuters.com+(oil+OR+gas+OR+energy+OR+OPEC)+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "energy", name: "Mining & Resources", url: "https://news.google.com/rss/search?q=(lithium+OR+\"rare+earth\"+OR+cobalt+OR+mining)+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "crisis", name: "CrisisWatch", url: "https://www.crisisgroup.org/rss" },
  { cat: "crisis", name: "IAEA", url: "https://www.iaea.org/feeds/topnews" },
  { cat: "crisis", name: "WHO", url: "https://www.who.int/rss-feeds/news-english.xml" },
  { cat: "crisis", name: "UNHCR", url: "https://news.google.com/rss/search?q=site:unhcr.org+OR+UNHCR+refugees+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "politics", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { cat: "politics", name: "Guardian World", url: "https://www.theguardian.com/world/rss" },
  { cat: "politics", name: "AP News", url: "https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en" },
  { cat: "politics", name: "Reuters World", url: "https://news.google.com/rss/search?q=site:reuters.com+world&hl=en-US&gl=US&ceid=US:en" },
  { cat: "politics", name: "CNN World", url: "https://news.google.com/rss/search?q=site:cnn.com+world+news+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "politics", name: "Trump - Truth Social", url: "https://trumpstruth.org/feed" },
  { cat: "middleeast", name: "BBC Middle East", url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
  { cat: "middleeast", name: "Guardian ME", url: "https://www.theguardian.com/world/middleeast/rss" },
  { cat: "middleeast", name: "BBC Persian", url: "https://feeds.bbci.co.uk/persian/rss.xml" },
  { cat: "middleeast", name: "Iran International", url: "https://news.google.com/rss/search?q=site:iranintl.com+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "middleeast", name: "Fars News", url: "https://news.google.com/rss/search?q=site:farsnews.ir+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "middleeast", name: "IRNA", url: "https://en.irna.ir/rss" },
  { cat: "europe", name: "Telegraph", url: "https://www.telegraph.co.uk/rss.xml" },
  { cat: "europe", name: "Interfax EN", url: "https://news.google.com/rss/search?q=site%3Ainterfax.com%20when%3A7d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "europe", name: "El Pa\u00eds", url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada" },
  { cat: "europe", name: "El Mundo", url: "https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml" },
  { cat: "europe", name: "BBC Mundo", url: "https://www.bbc.com/mundo/index.xml" },
  { cat: "europe", name: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2/" },
  { cat: "asia", name: "Asia News", url: "https://news.google.com/rss/search?q=(China+OR+Japan+OR+Korea+OR+India+OR+ASEAN)+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "asia", name: "BBC Asia", url: "https://feeds.bbci.co.uk/news/world/asia/rss.xml" },
  { cat: "asia", name: "The Diplomat", url: "https://thediplomat.com/feed/" },
  { cat: "asia", name: "Reuters Asia", url: "https://news.google.com/rss/search?q=site:reuters.com+(China+OR+Japan+OR+Taiwan+OR+Korea)+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "asia", name: "Reuters India", url: "https://news.google.com/rss/search?q=site:reuters.com+India+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "asia", name: "Xinhua", url: "https://news.google.com/rss/search?q=site:xinhuanet.com+OR+Xinhua+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "ai", name: "AI News", url: "https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+\"large+language+model\"+OR+ChatGPT)+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "ai", name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { cat: "ai", name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { cat: "ai", name: "MIT Tech Review", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { cat: "ai", name: "ArXiv AI", url: "https://export.arxiv.org/rss/cs.AI" },
  { cat: "tech", name: "Hacker News", url: "https://hnrss.org/frontpage" },
  { cat: "tech", name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
  { cat: "tech", name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { cat: "tech", name: "MIT Tech Review", url: "https://www.technologyreview.com/feed/" },
  { cat: "tech", name: "Wired", url: "https://www.wired.com/feed/rss" },
  { cat: "gov", name: "White House", url: "https://www.whitehouse.gov/briefings-statements/feed/" },
  { cat: "gov", name: "White House Actions", url: "https://www.whitehouse.gov/presidential-actions/feed/" },
  { cat: "gov", name: "State Dept", url: "https://news.google.com/rss/search?q=site:state.gov+OR+\"State+Department\"&hl=en-US&gl=US&ceid=US:en" },
  { cat: "gov", name: "Pentagon", url: "https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945" },
  { cat: "gov", name: "Treasury", url: "https://news.google.com/rss/search?q=site:treasury.gov+OR+\"Treasury+Department\"&hl=en-US&gl=US&ceid=US:en" },
  { cat: "gov", name: "DOJ", url: "https://news.google.com/rss/search?q=site:justice.gov+OR+\"Justice+Department\"+DOJ&hl=en-US&gl=US&ceid=US:en" },
  { cat: "thinktanks", name: "Foreign Policy", url: "https://foreignpolicy.com/feed/" },
  { cat: "thinktanks", name: "Foreign Affairs", url: "https://www.foreignaffairs.com/rss.xml" },
  { cat: "thinktanks", name: "CSIS", url: "https://news.google.com/rss/search?q=site:csis.org+when:7d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "thinktanks", name: "RAND", url: "https://www.rand.org/pubs/articles.xml" },
  { cat: "thinktanks", name: "Brookings", url: "https://news.google.com/rss/search?q=site:brookings.edu+when:7d&hl=en-US&gl=US&ceid=US:en" },
  { cat: "thinktanks", name: "Carnegie", url: "https://news.google.com/rss/search?q=site:carnegieendowment.org+when:7d&hl=en-US&gl=US&ceid=US:en" },
];

const CATS: Record<string, string> = { markets: "Markets", finance: "Finance", crypto: "Crypto", commodities: "Commodities", energy: "Energy", crisis: "Crisis", politics: "Politics", middleeast: "Middle East", europe: "Europe", asia: "Asia", ai: "AI", tech: "Tech", gov: "Government", thinktanks: "Think tanks" };

let cache: { at: number; payload: any } | null = null;
const dec = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "").trim();

async function readFeed(f: { cat: string; name: string; url: string }) {
  try {
    const r = await fetch(f.url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "Mozilla/5.0 (AXIOM world wire)" }, cache: "no-store" });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/g)].slice(0, 8).map((m) => {
      const e = m[1] ?? m[2] ?? "";
      const g = (t: string) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)) || [])[1] ?? "";
      const link = g("link") || (e.match(/<link[^>]+href="([^"]+)"/) || [])[1] || "";
      const when = Date.parse(g("pubDate") || g("published") || g("updated") || "") || 0;
      return { title: dec(g("title")).slice(0, 180), link: link.trim(), when, source: f.name, cat: f.cat };
    }).filter((x) => x.title);
    return items;
  } catch { return []; }
}

export async function GET() {
  if (cache && Date.now() - cache.at < 4 * 60_000) return NextResponse.json(cache.payload);
  const all = (await Promise.all(FEEDS.map(readFeed))).flat();
  const seen = new Set<string>();
  const items = all.filter((x) => { const k = x.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.when - a.when);
  const byCat: Record<string, any[]> = {};
  for (const it of items) (byCat[it.cat] ??= []).push(it);
  const payload = { generated: Date.now(), feeds: FEEDS.length, items: items.length, categories: Object.keys(CATS).filter((c) => byCat[c]?.length).map((c) => ({ id: c, label: CATS[c], items: byCat[c].slice(0, 12) })) };
  cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}

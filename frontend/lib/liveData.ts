/**
 * Live data fetchers — called from the browser.
 *
 * fetchGammaMarkets()  → real Polymarket markets via /api/markets proxy
 * fetchBinancePrices() → real-time spot prices from Binance public REST (CORS-safe)
 */
import type { Market } from "./types";

// ── Category / asset detection (mirrors backend ingest/market_watcher.py) ────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  ai:         ["openai", "gpt", "anthropic", "claude", "gemini", "llm", "ai model", "deepseek"],
  crypto:     ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto", "doge", "dogecoin", "xrp", "ripple", "avax", "chainlink", "matic"],
  politics:   ["president", "election", "congress", "senate", "trump", "biden", "harris", "republican", "democrat", "policy", "vote"],
  science:    ["nasa", "spacex", "climate", "genome", "physics", "fusion", "cern"],
  technology: ["nvidia", "apple", "google", "microsoft", "stock", "nasdaq", "ipo", "meta", "amazon"],
  sports:     ["soccer", "football", "fifa", "premier league", "nba", "basketball", "tennis", "wimbledon", "ufc", "mma", "cricket", "champions league", "world cup", "super bowl", "nfl"],
};

const LINKED_ASSETS: [string, string][] = [
  ["bitcoin", "BTC"], ["btc", "BTC"],
  ["ethereum", "ETH"], ["eth", "ETH"],
  ["solana", "SOL"], ["sol", "SOL"],
  ["dogecoin", "DOGE"], ["doge", "DOGE"],
  ["nvidia", "NVDA"], ["nvda", "NVDA"],
  ["avax", "AVAX"], ["avalanche", "AVAX"],
];

function inferCategory(question: string, tags: unknown[]): string {
  const q   = question.toLowerCase();
  const tag = tags.map(t => String(t).toLowerCase()).join(" ");
  const src = `${q} ${tag}`;

  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => src.includes(kw))) return cat;
  }
  return "other";
}

function detectLinkedAsset(question: string): string | null {
  const q = question.toLowerCase();
  for (const [kw, asset] of LINKED_ASSETS) {
    if (q.includes(kw)) return asset;
  }
  return null;
}

// ── Gamma API parser ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGammaItem(item: any): Market | null {
  try {
    const conditionId: string = item.conditionId ?? item.condition_id ?? "";
    if (!conditionId) return null;

    const question: string  = item.question ?? "";
    const active: boolean   = item.active    ?? true;
    const volume: number    = parseFloat(item.volume ?? "0") || 0;

    // outcomePrices is a JSON-encoded string: '["0.647","0.353"]'
    let yesPrice = 0.5;
    let noPrice  = 0.5;
    try {
      const prices: string[] = typeof item.outcomePrices === "string"
        ? JSON.parse(item.outcomePrices)
        : (item.outcomePrices ?? []);
      if (prices.length >= 2) {
        yesPrice = parseFloat(prices[0]);
        noPrice  = parseFloat(prices[1]);
      }
    } catch { /* keep 0.5 */ }

    const tags    = Array.isArray(item.tags) ? item.tags : [];
    const endDate = item.endDate ?? item.end_date_iso ?? null;

    return {
      condition_id:  conditionId,
      question,
      category:      inferCategory(question, tags) as Market["category"],
      yes_price:     yesPrice,
      no_price:      noPrice,
      volume,
      active,
      end_date:      endDate ?? undefined,
      linked_asset:  detectLinkedAsset(question) ?? undefined,
      change_24h:    0,
    };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchGammaMarkets(limit = 50): Promise<Market[]> {
  try {
    const res = await fetch(`/api/markets?limit=${limit}`, { cache: "no-store" });
    if (!res.ok) return [];
    const data: unknown[] = await res.json();
    if (!Array.isArray(data)) return [];

    const markets = data
      .map(parseGammaItem)
      .filter((m): m is Market => m !== null && m.volume > 1_000);

    return markets;
  } catch (err) {
    console.warn("[liveData] fetchGammaMarkets failed:", err);
    return [];
  }
}

const BINANCE_SYMBOLS = [
  ["BTCUSDT",  "BTC"],
  ["ETHUSDT",  "ETH"],
  ["SOLUSDT",  "SOL"],
  ["DOGEUSDT", "DOGE"],
  ["AVAXUSDT", "AVAX"],
  ["XRPUSDT",  "XRP"],
] as const;

export async function fetchBinancePrices(): Promise<Record<string, number>> {
  const results = await Promise.allSettled(
    BINANCE_SYMBOLS.map(([sym]) =>
      fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`, {
        cache: "no-store",
      }).then(r => r.json()),
    ),
  );

  const prices: Record<string, number> = {};
  results.forEach((r, i) => {
    const [, key] = BINANCE_SYMBOLS[i];
    if (r.status === "fulfilled" && r.value?.price) {
      prices[key] = parseFloat(r.value.price);
    }
  });
  return prices;
}

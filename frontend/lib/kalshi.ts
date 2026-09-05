import crypto from "crypto";

/**
 * Shared Kalshi fetch — RSA-PSS signed when KALSHI_API_KEY_ID +
 * KALSHI_PRIVATE_KEY_B64 are set (paste in /settings). Unauthenticated
 * requests get listings but NO bid/ask.
 */
const HOSTS = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://trading-api.kalshi.com/trade-api/v2",
];

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_price: number | null;   // mid, dollars — display only
  yes_ask: number | null;     // executable: cost to BUY YES, dollars
  no_ask: number | null;      // executable: cost to BUY NO (= 1 − yes_bid)
  volume: number;
  close_time: string | null;
  category: string;
}

function authHeaders(method: string, path: string): Record<string, string> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  const pemB64 = process.env.KALSHI_PRIVATE_KEY_B64;
  if (!keyId || !pemB64) return {};
  try {
    const pem = Buffer.from(pemB64, "base64").toString("utf-8");
    const ts = String(Date.now());
    const sig = crypto.sign("sha256", Buffer.from(ts + method + path), {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString("base64");
    return {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": sig,
    };
  } catch {
    return {};
  }
}

export async function fetchKalshiMarkets(limit = 200): Promise<{ quotesAvailable: boolean; markets: KalshiMarket[] }> {
  for (const host of HOSTS) {
    try {
      const path = "/trade-api/v2/events";
      const auth = authHeaders("GET", path);
      const res = await fetch(
        `${host}/events?limit=${limit}&status=open&with_nested_markets=true`,
        {
          headers: { Accept: "application/json", ...auth },
          ...(Object.keys(auth).length ? { cache: "no-store" as const } : { next: { revalidate: 60 } }),
        },
      );
      if (!res.ok) continue;
      const data = await res.json();

      const markets: KalshiMarket[] = (data.events ?? []).flatMap((ev: any) =>
        (ev.markets ?? []).map((m: any) => ({
          ticker: m.ticker,
          title: (ev.markets ?? []).length > 1 && m.yes_sub_title
            ? `${ev.title} — ${m.yes_sub_title}`
            : ev.title ?? m.ticker,
          yes_price: m.yes_bid != null && m.yes_ask != null
            ? ((m.yes_bid + m.yes_ask) / 2) / 100
            : null,
          yes_ask: m.yes_ask != null ? m.yes_ask / 100 : null,
          no_ask: m.yes_bid != null ? (100 - m.yes_bid) / 100 : null,
          volume: m.volume ?? 0,
          close_time: m.close_time ?? null,
          category: ev.category ?? "",
        })),
      );

      const quotesAvailable = markets.some((m) => m.yes_ask != null);
      return { quotesAvailable, markets };
    } catch {
      // try next host
    }
  }
  return { quotesAvailable: false, markets: [] };
}

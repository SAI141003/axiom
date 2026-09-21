// One tiny cache for the Eye's proxies: every layer is live, but upstreams are
// public and rate-limited, so each is fetched at most once per window and
// the age is reported with the data. Never a fallback fixture: an upstream
// that fails returns its error and the last good copy, clearly aged.
const store = new Map<string, { at: number; data: any }>();
export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<{ data: T | null; age: number; error?: string }> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { data: hit.data, age: Date.now() - hit.at };
  try { const data = await fetcher(); store.set(key, { at: Date.now(), data }); return { data, age: 0 }; }
  catch (e: any) { return { data: hit?.data ?? null, age: hit ? Date.now() - hit.at : -1, error: String(e?.message ?? e).slice(0, 120) }; }
}
export const UA = { "User-Agent": "AXIOM desk (github.com/SAI141003/axiom)" };

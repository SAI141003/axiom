// Stale-while-revalidate for API routes: answer from memory at once, refresh
// in the background when the copy is older than `ttlMs`. Only the very first
// request after a restart waits for `fn`, and concurrent callers share that
// one call. A failed refresh keeps the last good answer.
type Entry = { at: number; val: unknown; inflight?: Promise<unknown> };
const store = new Map<string, Entry>();

export async function swr<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const e = store.get(key);
  if (e && "val" in e && e.at > 0) {
    if (Date.now() - e.at > ttlMs && !e.inflight) refresh(key, fn);
    return e.val as T;
  }
  if (e?.inflight) return e.inflight as Promise<T>;
  return refresh(key, fn);
}

function refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = store.get(key);
  const p = fn()
    .then((val) => { store.set(key, { at: Date.now(), val }); return val; })
    .catch((err) => { const cur = store.get(key); if (cur) cur.inflight = undefined; if (prev && prev.at > 0) return prev.val as T; throw err; });
  store.set(key, { at: prev?.at ?? 0, val: prev?.val, inflight: p });
  return p;
}

// Serve a route through swr. `?refresh=1` bypasses the cache; 5xx answers are
// never cached (the last good one is served instead).
export async function cachedRoute(req: Request, key: string, ttlMs: number, compute: (req: Request) => Promise<Response>): Promise<Response> {
  const u = new URL(req.url);
  if (u.searchParams.get("refresh") === "1") return compute(req);
  try {
    const r = await swr(`${key}${u.search}`, ttlMs, async () => {
      const res = await compute(req);
      if (res.status >= 500) throw new Error(`${key} ${res.status}`);
      return { status: res.status, body: await res.json() };
    });
    return Response.json(r.body, { status: r.status });
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 502 });
  }
}

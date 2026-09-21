// The dashboard's half of the token ledger shared with jarvis/usage.mjs: same
// file, same line shapes, same 80% rule. Read that file's header for the why.
import { promises as fs } from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "..", ".data", "ai_usage.jsonl");
const SOFT = 0.8;
const KNOWN: Record<string, { day?: number; minute?: number }> = {
  "groq:openai/gpt-oss-120b": { day: 200_000, minute: 8_000 },
  "groq:openai/gpt-oss-20b": { day: 200_000, minute: 8_000 },
  "groq:qwen/qwen3.8-27b": { day: 500_000, minute: 6_000 },
  "groq:groq/compound-mini": { day: 200_000, minute: 70_000 },
};

export async function record(provider: string, model: string, usage: any, status = "ok", est = 0) {
  const line = { ts: Date.now(), p: provider, m: model, in: usage?.prompt_tokens ?? Math.round(est * 0.85), out: usage?.completion_tokens ?? Math.round(est * 0.15), est: !usage, st: status };
  try { await fs.mkdir(path.dirname(FILE), { recursive: true }); await fs.appendFile(FILE, JSON.stringify(line) + "\n"); } catch {}
}

export function parseLimit(text: string) {
  const s = String(text ?? "");
  const window = /per day|TPD|RPD/i.test(s) ? "day" : /per minute|TPM|RPM|per second/i.test(s) ? "minute" : "unknown";
  const limit = Number((s.match(/Limit\s+(\d+)/i) ?? [])[1] ?? 0), used = Number((s.match(/Used\s+(\d+)/i) ?? [])[1] ?? 0);
  const m = s.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  const secs = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : window === "day" ? 3600 : 60;
  return { window, limit, used, until: Date.now() + Math.max(5, secs) * 1000 };
}

export async function recordLimit(provider: string, model: string, body: string) {
  const l = parseLimit(body);
  try { await fs.mkdir(path.dirname(FILE), { recursive: true }); await fs.appendFile(FILE, JSON.stringify({ ts: Date.now(), type: "limit", p: provider, m: model, ...l }) + "\n"); } catch {}
  return l;
}

export type Lane = { provider: string; model: string; day: number; minute: number; calls: number; estimated: number; limits: { day?: number; minute?: number }; cooldownUntil: number; lastLimit: any; dayPct: number | null; minutePct: number | null; skip: string | null };

export async function ledger(): Promise<{ generated: number; lanes: Lane[]; soft: number }> {
  let lines: any[] = [];
  try { lines = (await fs.readFile(FILE, "utf-8")).split("\n").filter(Boolean).slice(-20_000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const now = Date.now(), dayStart = now - 24 * 3600_000, minStart = now - 60_000;
  const lanes: Record<string, Lane> = {};
  const lane = (p: string, m: string) => (lanes[`${p}:${m}`] ??= { provider: p, model: m, day: 0, minute: 0, calls: 0, estimated: 0, limits: { ...(KNOWN[`${p}:${m}`] ?? {}) }, cooldownUntil: 0, lastLimit: null, dayPct: null, minutePct: null, skip: null });
  for (const r of lines) {
    if (r.ts < dayStart) continue;
    const L = lane(r.p, r.m);
    if (r.type === "limit") { if (r.limit) (L.limits as any)[r.window === "unknown" ? "minute" : r.window] = r.limit; if (r.until > now) L.cooldownUntil = Math.max(L.cooldownUntil, r.until); L.lastLimit = { window: r.window, used: r.used, limit: r.limit, at: r.ts }; continue; }
    const tok = (r.in ?? 0) + (r.out ?? 0); L.day += tok; L.calls++; if (r.est) L.estimated += tok; if (r.ts >= minStart) L.minute += tok;
  }
  for (const L of Object.values(lanes)) {
    L.dayPct = L.limits.day ? L.day / L.limits.day : null; L.minutePct = L.limits.minute ? L.minute / L.limits.minute : null;
    L.skip = L.cooldownUntil > now ? "cooldown" : L.dayPct != null && L.dayPct >= SOFT ? "day budget" : L.minutePct != null && L.minutePct >= 1 ? "minute budget" : null;
  }
  return { generated: now, lanes: Object.values(lanes), soft: SOFT };
}

export async function avoid(): Promise<Set<string>> {
  const { lanes } = await ledger();
  return new Set(lanes.filter((l) => l.skip).map((l) => `${l.provider}:${l.model}`));
}

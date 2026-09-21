/**
 * Token ledger + resource reallocation for every AI lane the desk uses.
 *
 * Every completion appends one line to .data/ai_usage.jsonl (provider, model,
 * prompt/completion tokens — real usage when the API reports it, chars/4
 * otherwise). Every 429 appends a "limit" line with what the provider said:
 * the window (minute/day), the limit, the used count, and when it resets.
 *
 * From those lines the desk knows, per model, how much of each budget is gone
 * and reallocates BEFORE the lane dies: a model past 80% of a learned daily
 * limit (or inside a cooldown) is skipped, so the turn goes to the next lane
 * instead of failing through 429s first. The dashboard reads the same file.
 */
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, ".data", "ai_usage.jsonl");
const SOFT = 0.8;   // reallocate at 80% of a known budget

// Published free-tier budgets, used until a 429 teaches us the real ones.
const KNOWN = {
  "groq:openai/gpt-oss-120b": { day: 200_000, minute: 8_000 },
  "groq:openai/gpt-oss-20b":  { day: 200_000, minute: 8_000 },
  "groq:qwen/qwen3.8-27b":    { day: 500_000, minute: 6_000 },
  "groq:groq/compound-mini":  { day: 200_000, minute: 70_000 },
};

export async function record(provider, model, usage, status = "ok", est = 0) {
  const line = { ts: Date.now(), p: provider, m: model, in: usage?.prompt_tokens ?? Math.round(est * 0.85), out: usage?.completion_tokens ?? Math.round(est * 0.15), est: !usage, st: status };
  try { await mkdir(dirname(FILE), { recursive: true }); await appendFile(FILE, JSON.stringify(line) + "\n"); } catch {}
}

// Parse a Groq/OpenAI-style 429 body: "... on tokens per day (TPD): Limit 200000, Used 199196, Requested 2200. Please try again in 1h2m3.4s."
export function parseLimit(text) {
  const s = String(text ?? "");
  const window = /per day|TPD|RPD/i.test(s) ? "day" : /per minute|TPM|RPM|per second/i.test(s) ? "minute" : "unknown";
  const limit = Number((s.match(/Limit\s+(\d+)/i) ?? [])[1] ?? 0), used = Number((s.match(/Used\s+(\d+)/i) ?? [])[1] ?? 0);
  const m = s.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  const secs = m ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : (window === "day" ? 3600 : 60);
  return { window, limit, used, until: Date.now() + Math.max(5, secs) * 1000 };
}

export async function recordLimit(provider, model, body) {
  const l = parseLimit(body);
  try { await mkdir(dirname(FILE), { recursive: true }); await appendFile(FILE, JSON.stringify({ ts: Date.now(), type: "limit", p: provider, m: model, ...l }) + "\n"); } catch {}
  return l;
}

// Today's picture per lane: tokens used, learned limits, cooldowns, and whether the lane should be skipped.
export async function ledger() {
  let lines = [];
  try { lines = (await readFile(FILE, "utf-8")).split("\n").filter(Boolean).slice(-20_000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const now = Date.now(), dayStart = now - 24 * 3600_000, minStart = now - 60_000;
  const lanes = {};
  const lane = (p, m) => (lanes[`${p}:${m}`] ??= { provider: p, model: m, day: 0, minute: 0, calls: 0, estimated: 0, limits: { ...(KNOWN[`${p}:${m}`] ?? {}) }, cooldownUntil: 0, lastLimit: null });
  for (const r of lines) {
    if (r.ts < dayStart) continue;
    const L = lane(r.p, r.m);
    if (r.type === "limit") { if (r.limit) L.limits[r.window === "unknown" ? "minute" : r.window] = r.limit; if (r.until > now) L.cooldownUntil = Math.max(L.cooldownUntil, r.until); L.lastLimit = { window: r.window, used: r.used, limit: r.limit, at: r.ts }; continue; }
    const tok = (r.in ?? 0) + (r.out ?? 0); L.day += tok; L.calls++; if (r.est) L.estimated += tok; if (r.ts >= minStart) L.minute += tok;
  }
  for (const L of Object.values(lanes)) {
    const dayPct = L.limits.day ? L.day / L.limits.day : null, minPct = L.limits.minute ? L.minute / L.limits.minute : null;
    L.dayPct = dayPct; L.minutePct = minPct;
    L.skip = L.cooldownUntil > now ? "cooldown" : dayPct != null && dayPct >= SOFT ? "day budget" : minPct != null && minPct >= 1 ? "minute budget" : null;
  }
  return { generated: now, lanes: Object.values(lanes), soft: SOFT };
}

// The lanes a caller should avoid right now: Set of "provider:model".
export async function avoid() {
  const { lanes } = await ledger();
  return new Set(lanes.filter((l) => l.skip).map((l) => `${l.provider}:${l.model}`));
}

// ── Power allocation ────────────────────────────────────────────────────────
// "Reallocate all power to research" is a real instruction here: the focus
// decides which lane each consumer takes first, so the fast free budget (Groq)
// is reserved for whatever Sai cares about right now and everything else
// moves to NIM. Stored in .data/ai_power.json; balanced when unset.
const POWER = join(ROOT, ".data", "ai_power.json");
export const FOCI = ["balanced", "axiom", "research", "dashboard", "swarm"];
export async function focus() {
  try { const j = JSON.parse(await readFile(POWER, "utf-8")); return FOCI.includes(j.focus) ? j : { focus: "balanced" }; } catch { return { focus: "balanced" }; }
}
export async function setFocus(f, why = "") {
  const { writeFile } = await import("node:fs/promises");
  const j = { focus: FOCI.includes(f) ? f : "balanced", why, set_at: Date.now() };
  await mkdir(dirname(POWER), { recursive: true }); await writeFile(POWER, JSON.stringify(j, null, 2));
  const means = { balanced: "every consumer takes its default lane order",
    axiom: "AXIOM (voice, tools) takes the fast Groq lane first; the dashboard's LLM features move to NIM. Bots keep trading as before",
    research: "AXIOM's long unattended work (night study, deep reads) goes to NIM's big context first; the dashboard keeps the fast Groq lane. Bots keep trading as before",
    dashboard: "the screens (news cards, live summary, council) take the fast Groq lane first; AXIOM moves to NIM. Bots keep trading as before",
    swarm: "NIM is kept clear for the 72 MiroFish personas; AXIOM and the dashboard use Groq. Bots keep trading as before" };
  return { ...j, means: means[j.focus], note: "This reallocates AI lanes only. It does not start or stop any bot — say 'stop trading X' for that." };
}
// Order lanes for a consumer ("bridge" or "dashboard") under the current focus.
export function orderLanes(consumer, lanes, f) {
  const first = (name) => [...lanes].sort((a, b) => (a.name === name ? -1 : b.name === name ? 1 : 0));
  if (f === "axiom") return consumer === "bridge" ? first("groq") : first("nvidia");
  if (f === "research") return consumer === "bridge" ? first("nvidia") : first("groq");
  if (f === "dashboard") return consumer === "bridge" ? first("nvidia") : first("groq");
  if (f === "swarm") return consumer === "bridge" ? first("groq") : first("groq");   // NIM stays clear for the 72 personas
  return lanes;
}

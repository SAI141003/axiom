import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import net from "net";
import { ledger } from "@/lib/aiUsage";

export const dynamic = "force-dynamic";

// The health of every AI the desk uses, measured, not assumed: one tiny real
// request per model with its latency and status, plus the voice engine, the
// swarm and the bridge. Cached ten minutes because every probe spends quota;
// ?refresh=1 re-measures.
type Probe = { job: string; provider: string; model: string; status: "ok" | "slow" | "limited" | "down" | "no key" | "empty"; ms: number | null; note?: string };
let cache: { at: number; payload: any } | null = null;
const ROOT = path.join(process.cwd(), "..");

async function readEnv(): Promise<Record<string, string>> {
  // the Python side (.env) and the dashboard (.env.local) can hold different keys
  const out: Record<string, string> = {};
  for (const f of [path.join(ROOT, ".env"), path.join(process.cwd(), ".env.local")]) {
    try { for (const l of (await fs.readFile(f, "utf-8")).split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/); if (m && m[2]) out[m[1]] = out[m[1]] ?? m[2].replace(/^["']|["']$/g, ""); } } catch {}
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v) as [string, string][]) };
}

async function chat(base: string, key: string, model: string, extra: Record<string, any> = {}): Promise<Omit<Probe, "job" | "provider" | "model">> {
  const t = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 24, messages: [{ role: "user", content: "Reply with the single word: ready" }], ...extra }),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - t;
    if (r.status === 429) return { status: "limited", ms, note: "rate/quota limit" };
    if (r.status === 402) return { status: "down", ms, note: "payment required" };
    if (r.status === 404 || r.status === 410) return { status: "down", ms, note: `model gone (${r.status})` };
    if (!r.ok) return { status: "down", ms, note: `HTTP ${r.status}` };
    const d = await r.json();
    const text = String(d.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) return { status: "empty", ms, note: "answered with no text" };
    return { status: ms > 15_000 ? "slow" : "ok", ms };
  } catch (e: any) { return { status: "down", ms: Date.now() - t, note: e?.name === "TimeoutError" ? "timeout 45s" : String(e?.message ?? e).slice(0, 80) }; }
}

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  if (!force && cache && Date.now() - cache.at < 10 * 60_000) return NextResponse.json({ ...cache.payload, usage: await ledger() });
  const env = await readEnv();
  const G = "https://api.groq.com/openai/v1", N = env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1", C = "https://api.cerebras.ai/v1";
  const oss = { reasoning_effort: "low", reasoning_format: "hidden" };
  const jobs: { job: string; provider: string; model: string; run: () => Promise<any> }[] = [
    { job: "AXIOM brain · first", provider: "Groq", model: env.GROQ_MODEL || "openai/gpt-oss-120b", run: () => env.GROQ_API_KEY ? chat(G, env.GROQ_API_KEY, env.GROQ_MODEL || "openai/gpt-oss-120b", oss) : nokey() },
    { job: "AXIOM brain · rotation", provider: "Groq", model: "qwen/qwen3.8-27b", run: () => env.GROQ_API_KEY ? chat(G, env.GROQ_API_KEY, "qwen/qwen3.8-27b") : nokey() },
    { job: "AXIOM brain · rotation", provider: "Groq", model: "openai/gpt-oss-20b", run: () => env.GROQ_API_KEY ? chat(G, env.GROQ_API_KEY, "openai/gpt-oss-20b", oss) : nokey() },
    { job: "Dashboard LLM · fallback", provider: "Cerebras", model: env.CEREBRAS_MODEL || "gpt-oss-120b", run: () => env.CEREBRAS_API_KEY ? chat(C, env.CEREBRAS_API_KEY, env.CEREBRAS_MODEL || "gpt-oss-120b") : nokey() },
    { job: "AXIOM brain · NIM (dedicated key)", provider: "NVIDIA NIM", model: env.NVIDIA_MODEL_JARVIS || "nvidia/nemotron-3-super-120b-a12b", run: () => (env.NVIDIA_API_KEY_JARVIS || env.NVIDIA_API_KEY) ? chat(N, env.NVIDIA_API_KEY_JARVIS || env.NVIDIA_API_KEY, env.NVIDIA_MODEL_JARVIS || "nvidia/nemotron-3-super-120b-a12b") : nokey() },
    { job: "AXIOM second opinion", provider: "NVIDIA NIM", model: env.NVIDIA_MODEL_JARVIS_DEEP || "nvidia/nemotron-3-ultra-550b-a55b", run: () => (env.NVIDIA_API_KEY_JARVIS || env.NVIDIA_API_KEY) ? chat(N, env.NVIDIA_API_KEY_JARVIS || env.NVIDIA_API_KEY, env.NVIDIA_MODEL_JARVIS_DEEP || "nvidia/nemotron-3-ultra-550b-a55b") : nokey() },
    { job: "Dashboard LLM · NIM", provider: "NVIDIA NIM", model: env.NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b", run: () => env.NVIDIA_API_KEY ? chat(N, env.NVIDIA_API_KEY, env.NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b") : nokey() },
    { job: "MiroFish swarm micro-agents", provider: "NVIDIA NIM", model: env.MIROFISH_MICRO_MODEL || "openai/gpt-oss-20b", run: () => env.NVIDIA_API_KEY ? chat(N, env.NVIDIA_API_KEY, env.MIROFISH_MICRO_MODEL || "openai/gpt-oss-20b", { reasoning_effort: "low" }) : nokey() },
    { job: "News classifier (Python, background — slow is fine)", provider: "NVIDIA NIM", model: "google/gemma-4-31b-it", run: () => env.NVIDIA_API_KEY ? chat(N, env.NVIDIA_API_KEY, "google/gemma-4-31b-it") : nokey() },
    { job: "GPT-6 Astra (optional)", provider: "OpenAI", model: env.OPENAI_MODEL || "gpt-6-astra", run: () => env.OPENAI_API_KEY ? chat("https://api.openai.com/v1", env.OPENAI_API_KEY, env.OPENAI_MODEL || "gpt-6-astra") : nokey() },
  ];
  const models: Probe[] = await Promise.all(jobs.map(async (j) => ({ job: j.job, provider: j.provider, model: j.model, ...(await j.run()) })));

  // the non-LLM parts of the mind
  const base = new URL(request.url).origin;
  const timed = async (label: string, f: () => Promise<any>) => { const t = Date.now(); try { const r = await f(); return { label, ok: !!r, ms: Date.now() - t, ...r }; } catch (e: any) { return { label, ok: false, ms: Date.now() - t, note: String(e?.message ?? e).slice(0, 80) }; } };
  const services = await Promise.all([
    timed("Voice · edge-tts en-GB Ryan", async () => { const r = await fetch(`${base}/api/jarvis/tts`, { cache: "no-store" }); const d = await r.json(); return { ok: d.ok, note: d.engine }; }),
    timed("Bridge · ws://127.0.0.1:8788", () => new Promise((res) => { const s = net.connect(8788, "127.0.0.1"); s.setTimeout(2000); s.on("connect", () => { s.destroy(); res({ ok: true, note: "listening" }); }); s.on("error", () => res({ ok: false, note: "not running — cd jarvis && npm start" })); s.on("timeout", () => { s.destroy(); res({ ok: false, note: "timeout" }); }); })),
    timed("MiroFish swarm · :5001", async () => { const r = await fetch(`${base}/api/mirofish`, { cache: "no-store" }); const d = await r.json(); return { ok: !!d.online, note: d.online ? `${d.population} personas on ${d.micro_model}` : "offline" }; }),
    timed("Jev shadow judge · TypeSafe (typed, ~100 ms)", async () => { const r = await fetch(`${base}/api/jev`, { cache: "no-store" }); const d = await r.json(); return { ok: !!d.configured, note: d.configured ? `${d.scored ?? 0} scored · Brier ${d.brier ?? "—"} vs base ${d.brier_base_rate ?? "—"}` : "no key — TYPESAFE_AI_API_KEY ($0.042/M in, no free tier)" }; }),
    timed("Night study · 04:10", async () => { const dir = path.join(ROOT, "jarvis", "notes"); const fs_ = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md")).sort(); const last = fs_[fs_.length - 1]; if (!last) return { ok: false, note: "no notes yet" }; const age = (Date.now() - (await fs.stat(path.join(dir, last))).mtimeMs) / 3_600_000; return { ok: age < 36, note: `${last.slice(0, 10)} · ${last.slice(11, 60).replace(/-/g, " ")}` }; }),
    timed("Weekly freshness · Sun 04:40", async () => { const l = await fs.readFile(path.join(ROOT, "logs", "jarvis_freshness.log"), "utf-8").catch(() => ""); const last = l.trim().split("\n").slice(-1)[0] ?? ""; return { ok: !/timed out|error|limit|not reachable/i.test(last), note: last.slice(0, 90) || "never ran" }; }),
  ]);

  const ok = models.filter((m) => m.status === "ok").length, keyed = models.filter((m) => m.status !== "no key").length;
  const fastest = models.filter((m) => m.status === "ok").sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9))[0];
  const usage = await ledger();
  const payload = { generated: Date.now(), models, services, usage, summary: { ok, keyed, fastest: fastest ? `${fastest.model} ${fastest.ms}ms` : null, brainReady: models.some((m) => /AXIOM brain/.test(m.job) && m.status === "ok") } };
  cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
const nokey = async () => ({ status: "no key" as const, ms: null });

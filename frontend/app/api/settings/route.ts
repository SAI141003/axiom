import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

/**
 * Local single-user settings — manage API keys from the UI instead of chat.
 *
 * - Frontend keys → frontend/.env.local AND live process.env (no restart needed)
 * - Backend keys (Polymarket live account etc.) → ../.env (bot restart required
 *   — use /api/settings/restart)
 * - GET never returns full values: only set/unset + last 4 chars.
 * - DRY_RUN is intentionally NOT editable here: flipping to live trading stays
 *   a manual .env edit by design (see CLAUDE.md safety rules).
 */

const FRONTEND_ENV = path.join(process.cwd(), ".env.local");
const BACKEND_ENV = path.join(process.cwd(), "..", ".env");

const KEYS: { name: string; scope: "frontend" | "backend"; label: string; group: string }[] = [
  { name: "GROQ_API_KEY",      scope: "frontend", label: "Groq (fast LLM — console.groq.com)",      group: "AI PROVIDERS" },
  { name: "CEREBRAS_API_KEY",  scope: "frontend", label: "Cerebras (cloud.cerebras.ai)",            group: "AI PROVIDERS" },
  { name: "ANTHROPIC_API_KEY", scope: "frontend", label: "Anthropic Claude",                        group: "AI PROVIDERS" },
  { name: "NVIDIA_API_KEY",    scope: "frontend", label: "NVIDIA NIM",                              group: "AI PROVIDERS" },
  { name: "POLYMARKET_PRIVATE_KEY",    scope: "backend", label: "Wallet private key (signs orders)", group: "POLYMARKET LIVE ACCOUNT" },
  { name: "POLYMARKET_API_KEY",        scope: "backend", label: "CLOB API key",                      group: "POLYMARKET LIVE ACCOUNT" },
  { name: "POLYMARKET_API_SECRET",     scope: "backend", label: "CLOB API secret",                   group: "POLYMARKET LIVE ACCOUNT" },
  { name: "POLYMARKET_API_PASSPHRASE", scope: "backend", label: "CLOB API passphrase",               group: "POLYMARKET LIVE ACCOUNT" },
  { name: "POLYMARKET_FUNDER",         scope: "backend", label: "Funder address (USDC wallet)",      group: "POLYMARKET LIVE ACCOUNT" },
  { name: "KALSHI_API_KEY_ID",       scope: "frontend", label: "Kalshi API key ID (kalshi.com → settings → API)", group: "OTHER VENUES" },
  { name: "KALSHI_PRIVATE_KEY_B64",  scope: "frontend", label: "Kalshi RSA private key, base64-encoded PEM (`base64 -i key.pem`)", group: "OTHER VENUES" },
  { name: "HF_TOKEN",                  scope: "backend", label: "HuggingFace token (Kronos downloads)", group: "OTHER" },
];

async function readEnv(file: string): Promise<{ vals: Record<string, string>; disabled: Set<string> }> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const vals: Record<string, string> = {};
    const disabled = new Set<string>();
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) vals[m[1]] = m[2];
      const d = line.match(/^#DISABLED:([A-Z0-9_]+)=(.*)$/);
      if (d) { vals[d[1]] = d[2]; disabled.add(d[1]); }
    }
    return { vals, disabled };
  } catch {
    return { vals: {}, disabled: new Set() };
  }
}

async function toggleEnvKey(file: string, name: string, disable: boolean): Promise<void> {
  let raw = "";
  try { raw = await fs.readFile(file, "utf-8"); } catch {}
  if (disable) {
    raw = raw.replace(new RegExp(`^${name}=`, "m"), `#DISABLED:${name}=`);
  } else {
    raw = raw.replace(new RegExp(`^#DISABLED:${name}=`, "m"), `${name}=`);
  }
  await fs.writeFile(file, raw);
}

async function writeEnvKey(file: string, name: string, value: string): Promise<void> {
  let raw = "";
  try { raw = await fs.readFile(file, "utf-8"); } catch {}
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  raw = re.test(raw)
    ? raw.replace(re, line)
    : raw + (raw.endsWith("\n") || raw === "" ? "" : "\n") + line + "\n";
  await fs.writeFile(file, raw);
}

export async function GET() {
  const [fe, be] = await Promise.all([readEnv(FRONTEND_ENV), readEnv(BACKEND_ENV)]);
  const rows = KEYS.map((k) => {
    const env = k.scope === "frontend" ? fe : be;
    const v = env.vals[k.name] ?? "";
    return {
      ...k,
      set: v.length > 0,
      disabled: env.disabled.has(k.name),
      hint: v.length > 4 ? `…${v.slice(-4)}` : v.length > 0 ? "set" : "",
    };
  });
  return NextResponse.json({ keys: rows, dryRun: (be.vals.DRY_RUN ?? "true").toLowerCase() !== "false" });
}

export async function POST(request: Request) {
  let body: { name?: string; value?: string; action?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const def = KEYS.find((k) => k.name === body.name);
  if (!def) return NextResponse.json({ error: "unknown key" }, { status: 400 });

  // enable/disable without losing the stored value
  if (body.action === "disable" || body.action === "enable") {
    const file = def.scope === "frontend" ? FRONTEND_ENV : BACKEND_ENV;
    await toggleEnvKey(file, def.name, body.action === "disable");
    if (def.scope === "frontend") {
      if (body.action === "disable") delete process.env[def.name];
      else {
        const { vals } = await readEnv(file);
        if (vals[def.name]) process.env[def.name] = vals[def.name];
      }
    }
    return NextResponse.json({ ok: true, note: body.action === "disable"
      ? "Key disabled (value kept — re-enable anytime)."
      : def.scope === "frontend" ? "Re-enabled — active immediately." : "Re-enabled — restart bot to apply." });
  }
  const value = (body.value ?? "").trim();
  if (/[\n\r]/.test(value)) return NextResponse.json({ error: "invalid value" }, { status: 400 });

  const file = def.scope === "frontend" ? FRONTEND_ENV : BACKEND_ENV;
  await writeEnvKey(file, def.name, value);
  if (def.scope === "frontend") {
    // live-update the running server — LLM chain reads process.env per request
    process.env[def.name] = value;
  }
  return NextResponse.json({
    ok: true,
    note: def.scope === "frontend"
      ? "Active immediately."
      : "Saved to backend .env — restart the bot for it to take effect.",
  });
}

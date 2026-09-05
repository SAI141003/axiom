import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { askLLM } from "../../../lib/llm";

const execFileP = promisify(execFile);
const ROOT = path.join(process.cwd(), "..");

/**
 * LEDGER — the Valuation Reviewer (Anthropic-finance "Valuation Reviewer"
 * template). Pulls fundamentals from the FMP connector and gives a DCF +
 * multiples + quality verdict. Requires FMP_API_KEY; without it, says so
 * plainly rather than guessing.
 */

async function fundamentals(sym: string): Promise<any | null> {
  try {
    const { stdout } = await execFileP(
      path.join(ROOT, ".venv", "bin", "python"),
      [path.join(ROOT, "signals", "fmp_connector.py"), sym],
      { cwd: ROOT, timeout: 25_000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

function parseJSON(s: string): any {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function GET(request: Request) {
  const sym = (new URL(request.url).searchParams.get("symbol") ?? "").toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) return NextResponse.json({ error: "valid symbol required" }, { status: 400 });

  const f = await fundamentals(sym);
  if (!f || f.available === false) {
    return NextResponse.json({
      symbol: sym, available: false,
      reason: f?.reason ?? "FMP connector unavailable — add FMP_API_KEY (free at financialmodelingprep.com) to .env",
    });
  }

  const raw = await askLLM(
    `You are Ledger, the Valuation Reviewer. Weigh DCF, multiples, quality and leverage. Be decisive; name the key risk. No buy/sell instructions — analysis only.`,
    `${sym} fundamentals:\n` +
    `sector ${f.sector}; price $${f.price}; DCF fair value $${f.dcf_fair_value} (${f.dcf_upside != null ? (f.dcf_upside * 100).toFixed(0) + "% " + f.dcf_verdict : "n/a"}); ` +
    `P/E ${f.pe_ttm}; net margin ${f.net_margin}; ROE ${f.roe}; debt/equity ${f.debt_to_equity}; beta ${f.beta}.\n` +
    `Reply ONLY as JSON: {"verdict":"UNDERVALUED"|"FAIR"|"OVERVALUED","thesis":"one sentence","key_risk":"one sentence"}`,
    280).catch(() => "");
  const v = parseJSON(raw) ?? {};

  return NextResponse.json({
    symbol: sym, available: true, fundamentals: f,
    verdict: String(v.verdict ?? "FAIR").toUpperCase(),
    thesis: String(v.thesis ?? "—").slice(0, 220),
    keyRisk: String(v.key_risk ?? "—").slice(0, 220),
    generated: Date.now(),
  });
}

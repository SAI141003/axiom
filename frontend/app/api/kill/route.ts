import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const run = promisify(exec);

/**
 * REAL kill switch — sets/clears the same Redis key the bot's risk engine
 * checks on every order (`system:kill`), and publishes system.kill so all
 * workers react immediately. The terminal's F8 now controls the actual bot.
 */
export async function GET() {
  try {
    const { stdout } = await run(`redis-cli get system:kill`);
    const reason = stdout.trim();
    return NextResponse.json({ active: reason.length > 0, reason: reason || null });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { active?: boolean; reason?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const reason = (body.reason ?? "terminal F8").replace(/[^\w .:-]/g, "").slice(0, 80);
  try {
    if (body.active) {
      await run(`redis-cli set system:kill "${reason}"`);
      await run(`redis-cli publish system.kill "${reason}"`);
    } else {
      await run(`redis-cli del system:kill`);
    }
    return NextResponse.json({ ok: true, active: !!body.active });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

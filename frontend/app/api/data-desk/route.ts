import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// Data Desk — the OpenBB snapshot (equities, crypto, UST curve, CPI, news).
export async function GET() {
  try {
    const raw = await fs.readFile(path.join(ROOT, ".data", "openbb_snapshot.json"), "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ equities: [], crypto: [], treasury: null, cpi_yoy: null, news: [] });
  }
}

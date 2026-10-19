import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// The advisor's latest calls (scripts/advisor.py writes them every 15 minutes).
export async function GET() {
  try {
    return NextResponse.json(JSON.parse(await fs.readFile(path.join(process.cwd(), "..", ".data", "advice.json"), "utf-8")));
  } catch {
    return NextResponse.json({ generated: null, profiles: [], calls: [], news: [] });
  }
}

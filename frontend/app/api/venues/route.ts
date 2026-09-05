import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// Venue catalog — researched, cited map of every platform a bot can trade on,
// and whether it's reachable from Canada (BC). Static reference data, not prices.
export async function GET() {
  try {
    const raw = await fs.readFile(path.join(ROOT, ".data", "venues.json"), "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ venues: [], verdict: "", as_of: "" });
  }
}

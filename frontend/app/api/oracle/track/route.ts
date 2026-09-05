import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// The Oracle's OWN tracked accuracy — the differentiator. Reads the scorecards
// written by signals/oracle_resolver.py and signals/earnings_resolver.py, which
// grade every logged forecast against reality (Brier score) each night.
const ROOT = path.join(process.cwd(), "..");

async function readJson(rel: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf-8"));
  } catch {
    return null;
  }
}

export async function GET() {
  const [oracle, earnings, log] = await Promise.all([
    readJson(".data/oracle_scorecard.json"),
    readJson(".data/earnings_scorecard.json"),
    fs.readFile(path.join(ROOT, "logs", "oracle_predictions.jsonl"), "utf-8").catch(() => ""),
  ]);
  const pending = log.split("\n").filter((l) => l.trim() && !JSON.parse(l).resolved).length;
  return NextResponse.json({ oracle, earnings, pending });
}

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
export async function GET() {
  try {
    const d = JSON.parse(await fs.readFile(path.join(process.cwd(), "..", ".data", "model_benchmark.json"), "utf-8"));
    return NextResponse.json(d);
  } catch {
    return NextResponse.json({ rows: [], summary: "benchmark not yet computed" });
  }
}

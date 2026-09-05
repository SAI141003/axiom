import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
export async function GET() {
  try {
    return NextResponse.json(JSON.parse(await fs.readFile(
      path.join(process.cwd(), "..", ".data", "vol_model_benchmark.json"), "utf-8")));
  } catch { return NextResponse.json({ ranking: [] }); }
}

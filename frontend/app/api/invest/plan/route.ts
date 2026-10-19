import { NextResponse } from "next/server";
import { buildPlan, type Risk, type Style } from "@/lib/investPlan";

export const dynamic = "force-dynamic";

const RISKS: Risk[] = ["conservative", "balanced", "growth", "aggressive"];

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const monthly = Number(b.monthly), years = Number(b.years);
  if (!(monthly > 0) || !(years > 0)) return NextResponse.json({ error: "monthly amount and years must be positive" }, { status: 400 });
  try {
    return NextResponse.json(await buildPlan({
      market: b.market === "ca" ? "ca" : "us", monthly, years,
      risk: RISKS.includes(b.risk) ? b.risk : "growth", style: (["simple", "diy"].includes(b.style) ? b.style : "diversified") as Style,
      goal: Number(b.goal) > 0 ? Number(b.goal) : undefined,
    }));
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 502 });
  }
}

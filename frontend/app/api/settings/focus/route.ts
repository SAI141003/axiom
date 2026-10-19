import { NextResponse } from "next/server";
import { focusState, setFocus, NON_STOCK, STOCK } from "@/lib/focus";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...(await focusState()), stopped: NON_STOCK, kept: STOCK });
}

export async function POST(req: Request) {
  const { stocks } = await req.json().catch(() => ({}));
  if (typeof stocks !== "boolean") return NextResponse.json({ error: "body: { stocks: true | false }" }, { status: 400 });
  return NextResponse.json(await setFocus(stocks));
}

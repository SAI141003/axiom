import { NextResponse } from "next/server";

// Proxy to the live MiroFish swarm backend (signals/mirofish_server.py on
// :5001). POST a market question → runs the 12-persona swarm → returns the
// influence-weighted P(YES), disagreement, confidence, and each persona's vote.
const BASE = "http://localhost:5001";

export async function POST(request: Request) {
  let body: { question?: string; price?: number; volume?: number };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const q = (body.question ?? "").trim();
  if (!q) return NextResponse.json({ error: "question required" }, { status: 400 });

  const seed = `Prediction Market Research Request

Question: ${q}
${body.price != null ? `Current YES Price: ${body.price} (implied ${Math.round(body.price * 100)}%)` : ""}
${body.volume != null ? `Market Volume: $${body.volume.toLocaleString()}` : ""}`;

  try {
    const sub = await fetch(`${BASE}/api/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed, goal: `Estimate P(YES) that this resolves YES: ${q}` }),
    });
    if (!sub.ok) return NextResponse.json({ error: "swarm backend offline (start com.polymarket.mirofish)" }, { status: 503 });
    const { simulation_id } = await sub.json();

    // poll up to ~55s
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await fetch(`${BASE}/api/status/${simulation_id}`).then((r) => r.json()).catch(() => ({}));
      if (st.status === "completed") {
        const rep = await fetch(`${BASE}/api/report/${simulation_id}`).then((r) => r.json());
        return NextResponse.json(rep);
      }
      if (st.status === "failed") return NextResponse.json({ error: "swarm failed" }, { status: 502 });
    }
    return NextResponse.json({ error: "swarm timed out" }, { status: 504 });
  } catch {
    return NextResponse.json({ error: "swarm backend unreachable" }, { status: 503 });
  }
}

export async function GET() {
  try {
    const h = await fetch(`${BASE}/`, { cache: "no-store" }).then((r) => r.json());
    return NextResponse.json({ online: true, ...h });
  } catch {
    return NextResponse.json({ online: false });
  }
}

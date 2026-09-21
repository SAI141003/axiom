import TopNav from "@/components/TopNav";
import HudHome from "@/components/home/HudHome";

export const metadata = { title: "AXIOM — quant research & paper-trading desk" };


export default function Home() {
  return (
    <div className="hud-bg min-h-screen relative">
      <div className="hud-ambient" aria-hidden />
      <TopNav />
      <main className="relative max-w-[1500px] mx-auto px-6 py-6 font-mono">
        <header className="mb-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <h1 className="hud-gradient-text text-3xl font-extrabold tracking-[0.18em] leading-none">AXIOM</h1>
            <span className="flex items-center gap-2 text-[10px] tracking-[0.25em]" style={{ color: "var(--hud-muted)" }}>
              <span className="hud-led" style={{ background: "var(--hud-green)", color: "var(--hud-green)" }} />SYSTEM ONLINE · FORWARD-TESTING · PAPER
            </span>
          </div>
          <p className="prose-sans text-[12px] max-w-[64ch]" style={{ color: "var(--hud-muted)" }}>A proof-gated quant desk with a mind — real data, walk-forward backtests, a proven safety floor, a stable of bots, and AXIOM listening on every page.</p>
        </header>
        <HudHome />
        <p className="prose-sans mt-8 text-[11px] leading-relaxed max-w-[70ch]" style={{ color: "var(--hud-muted)" }}>
          <span style={{ color: "var(--hud-amber)" }}>Dry-run by default</span> — no live orders. Per-order and daily caps, a trade-only key model that can&apos;t withdraw, and an independent kill switch. Educational only, not financial advice.
        </p>
      </main>
    </div>
  );
}

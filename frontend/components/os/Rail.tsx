"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Brain, ChevronsLeft, ChevronsRight } from "lucide-react";
import { GROUPS, pageFor } from "@/components/nav/pages";

// The OS rail: AXIOM at the head, every screen as an icon, the desk's vitals
// at the foot. Fixed on the left of every page; expands on hover or pin.
export default function Rail() {
  const pathname = usePathname();
  const current = pageFor(pathname);
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [v, setV] = useState<any>(null);
  const [jstate, setJstate] = useState<string>("idle");
  const open = pinned || hover;

  useEffect(() => { try { setPinned(localStorage.getItem("axiom.rail") === "open"); } catch {} }, []);
  useEffect(() => {
    const load = async () => {
      try {
        const [f, a] = await Promise.all([fetch("/api/fleet").then((r) => r.json()), fetch("/api/agents").then((r) => r.json())]);
        const goat = (f.probes ?? []).find((p: any) => p.name === "weather (late-day)");
        setV({ pnl: f.totals?.pnl, goat: goat?.pnl, running: a.running, total: a.total, down: a.down });
      } catch {}
    };
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);
  useEffect(() => { const h = (e: Event) => setJstate((e as CustomEvent).detail); window.addEventListener("axiom:jarvis-state", h); return () => window.removeEventListener("axiom:jarvis-state", h); }, []);

  const tone = jstate === "listening" ? "var(--hud-green)" : jstate === "thinking" ? "var(--hud-amber)" : jstate === "speaking" ? "var(--hud-accent-2)" : "var(--hud-accent)";

  return (
    <aside aria-label="Desk rail" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
           className="hud-rail hidden md:flex flex-col" data-open={open || undefined}>
      <Link href="/mind" className="hud-rail-head" aria-label="AXIOM" title="AXIOM — the mind">
        <span className="hud-rail-orb" style={{ ["--tone" as any]: tone }}><Brain size={18} strokeWidth={1.7} /></span>
        <span className="hud-rail-label"><b>AXIOM</b><small>the mind · {jstate}</small></span>
      </Link>
      <nav className="flex-1 overflow-y-auto py-1" style={{ scrollbarWidth: "none" }}>
        {GROUPS.map((g) => (
          <div key={g.label} className="hud-rail-group">
            <div className="hud-rail-groupname">{g.label}</div>
            {g.pages.filter((p) => p.href !== "/mind").map((p) => {
              const Icon = p.icon; const active = p.href === current?.href;
              return (
                <Link key={p.href} href={p.href} prefetch={false} aria-current={active ? "page" : undefined} className="hud-rail-item" data-active={active || undefined} title={open ? undefined : `${p.label} — ${p.hint}`}>
                  <Icon size={17} strokeWidth={1.7} aria-hidden />
                  <span className="hud-rail-label"><b>{p.label}</b><small>{p.hint}</small></span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="hud-rail-foot">
        <Vital label="Fleet" value={v?.pnl != null ? `${v.pnl >= 0 ? "+" : "−"}$${Math.abs(v.pnl).toFixed(0)}` : "—"} tone={v?.pnl >= 0 ? "var(--hud-green)" : "var(--hud-red)"} open={open} />
        <Vital label="Goat" value={v?.goat != null ? `${v.goat >= 0 ? "+" : "−"}$${Math.abs(v.goat).toFixed(0)}` : "—"} tone="var(--hud-gold)" open={open} />
        <Vital label="Agents" value={v ? `${v.running}/${v.total}` : "—"} tone={v?.down ? "var(--hud-red)" : "var(--hud-green)"} open={open} />
        <button onClick={() => { const n = !pinned; setPinned(n); try { localStorage.setItem("axiom.rail", n ? "open" : "closed"); } catch {} }} className="hud-rail-item mt-1" aria-pressed={pinned} aria-label={pinned ? "collapse rail" : "pin rail open"}>
          {pinned ? <ChevronsLeft size={16} aria-hidden /> : <ChevronsRight size={16} aria-hidden />}
          <span className="hud-rail-label"><b>{pinned ? "Collapse" : "Pin open"}</b></span>
        </button>
      </div>
    </aside>
  );
}

function Vital({ label, value, tone, open }: { label: string; value: string; tone: string; open: boolean }) {
  return (
    <div className="hud-rail-vital" title={`${label}: ${value}`}>
      <span className="font-mono text-[10px] font-bold" style={{ color: tone }}>{open ? value : value.slice(0, 5)}</span>
      <span className="hud-rail-label"><small>{label}</small></span>
    </div>
  );
}

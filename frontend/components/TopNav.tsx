"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Command, Sparkles } from "lucide-react";
import { GROUPS, pageFor } from "./nav/pages";
import Rail from "./os/Rail";

// Four groups, each a menu. The bar never overflows: at any width it is the
// wordmark, four labels, the palette shortcut and the mode chip. The current
// page is always visible in its group's label, so you never lose your place.
export default function TopNav() {
  const pathname = usePathname();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const bar = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const current = pageFor(pathname);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setOpenGroup(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenGroup(null); };
    const close = () => setOpenGroup(null);
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    window.addEventListener("axiom:palette-open", close); window.addEventListener("axiom:jarvis-open", close);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); window.removeEventListener("axiom:palette-open", close); window.removeEventListener("axiom:jarvis-open", close); };
  }, []);
  useEffect(() => { setOpenGroup(null); }, [pathname]);
  // God's Eye's sensor mode (CRT / NVG / FLIR / noir) is a desk-wide setting
  useEffect(() => { try { const s = localStorage.getItem("axiom.sensor"); if (s && s !== "normal") document.documentElement.dataset.sensor = s; else delete document.documentElement.dataset.sensor; } catch {} }, [pathname]);

  return (
    <>
    <Rail />
    <nav ref={bar} aria-label="Primary" className="sticky top-0 z-50 hud-glass-bar flex items-center gap-2 px-4 h-14">
      <Link href="/" className="flex items-center gap-2 mr-2 shrink-0 rounded-md focus-visible:ring-2" style={{ ["--tw-ring-color" as any]: "var(--hud-accent)" }} aria-label="AXIOM home">
        <svg viewBox="0 0 64 64" className="w-[22px] h-[22px]" aria-hidden="true">
          <defs><linearGradient id="axnav" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="var(--hud-accent-2)" /><stop offset="45%" stopColor="var(--hud-accent)" /><stop offset="100%" stopColor="var(--hud-accent-deep)" /></linearGradient></defs>
          <path d="M14 49 L32 15 L50 49" fill="none" stroke="url(#axnav)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M18 39 H46" stroke="url(#axnav)" strokeWidth="5" strokeLinecap="round" />
        </svg>
        <span className="hud-gradient-text text-[14px] font-extrabold tracking-[0.22em] font-mono">AXIOM</span>
      </Link>

      {/* breadcrumb on md+ (the rail holds the menus); the menus themselves below md */}
      <div className="hidden md:flex items-center gap-2 min-w-0 text-[11px] font-mono" style={{ color: "var(--hud-muted)" }}>
        {current && <><span className="tracking-[0.14em] uppercase">{GROUPS.find((g) => g.pages.some((p) => p.href === current.href))?.label}</span><span>·</span><span className="prose-sans text-[12px] font-medium" style={{ color: "var(--hud-text)" }}>{current.label}</span><span className="prose-sans text-[11px] truncate hidden lg:inline">— {current.hint}</span></>}
      </div>
      <div className="flex md:hidden items-center gap-1 min-w-0">
        {GROUPS.map((g) => {
          const here = g.pages.some((p) => p.href === current?.href);
          const open = openGroup === g.label;
          return (
            <div key={g.label} className="relative">
              <button onClick={() => setOpenGroup(open ? null : g.label)} aria-haspopup="menu" aria-expanded={open}
                      className="hud-navbtn" data-active={here || undefined}>
                <span className="font-mono text-[11px] tracking-[0.14em] uppercase">{g.label}</span>
                {here && current && <span className="hidden sm:inline text-[11px] prose-sans font-medium" style={{ color: "var(--hud-text)" }}>· {current.label}</span>}
                <ChevronDown size={12} aria-hidden style={{ transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none" }} />
              </button>
              <AnimatePresence>
                {open && (
                  <motion.ul role="menu" initial={reduced ? false : { opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
                             transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                             className="hud-glass absolute left-0 top-[calc(100%+8px)] min-w-[280px] rounded-xl p-1.5 z-50">
                    {g.pages.map((p) => {
                      const Icon = p.icon; const active = p.href === current?.href;
                      return (
                        <li key={p.href} role="none">
                          <Link href={p.href} role="menuitem" aria-current={active ? "page" : undefined}
                                className="flex items-center gap-3 px-3 min-h-[44px] rounded-lg transition-colors"
                                style={{ background: active ? "var(--hud-accent-soft)" : "transparent", color: active ? "var(--hud-accent)" : "var(--hud-text)" }}
                                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                            <Icon size={16} aria-hidden style={{ color: active ? "var(--hud-accent)" : "var(--hud-muted)" }} />
                            <span className="text-[13px] font-medium prose-sans">{p.label}</span>
                            <span className="text-[11px] prose-sans truncate" style={{ color: "var(--hud-muted)" }}>{p.hint}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <div className="flex-1" />

      <button onClick={() => window.dispatchEvent(new Event("axiom:palette-open"))} className="hud-navbtn hidden md:flex" aria-label="open command palette">
        <Command size={13} aria-hidden /><span className="font-mono text-[11px]">K</span>
        <span className="prose-sans text-[11px]" style={{ color: "var(--hud-muted)" }}>jump or ask</span>
      </button>
      {pathname !== "/mind" && (
        <button onClick={() => window.dispatchEvent(new Event("axiom:jarvis-open"))} className="hud-navbtn" aria-label="open AXIOM">
          <Sparkles size={13} aria-hidden style={{ color: "var(--hud-accent)" }} /><span className="font-mono text-[11px] tracking-widest">AXIOM</span>
        </button>
      )}
      <span className="hud-chip ml-1" style={{ color: "var(--hud-amber)" }}>Dry-run</span>
    </nav>
    </>
  );
}

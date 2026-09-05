"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const LINKS = [
  { href: "/",          label: "Home" },
  { href: "/brain",     label: "Brain" },
  { href: "/workforce", label: "Workforce" },
  { href: "/council",   label: "Council" },
  { href: "/live-account", label: "Account" },
  { href: "/intel",     label: "Intel" },
  { href: "/journal",   label: "Journal" },
  { href: "/news",      label: "News" },
  { href: "/crypto",    label: "Auto-Bot" },
  { href: "/weather",   label: "Weather" },
  { href: "/weather-bot", label: "Bot 2" },
  { href: "/premarket", label: "Pre-Market" },
  { href: "/options",   label: "Options" },
  { href: "/live",      label: "Markets" },
  { href: "/arbitrage", label: "Arb" },
  { href: "/ai",        label: "AI Desk" },
  { href: "/scenario",  label: "Scenario" },
  { href: "/benchmark", label: "Benchmark" },
  { href: "/venues",    label: "Venues" },
  { href: "/proving-ground", label: "Proving Ground" },
  { href: "/backtest-lab", label: "Backtest Lab" },
  { href: "/data-desk", label: "Data Desk" },
  { href: "/ccxt-bot",  label: "Strategy Bot" },
  { href: "/flow-bot",  label: "Flow Bot" },
  { href: "/gamma-pulse", label: "Gamma" },
  { href: "/stocks-bot", label: "Stocks Bot" },
  { href: "/meme-bot",  label: "Meme Bot" },
  { href: "/stocks",    label: "Stocks" },
  { href: "/mirofish",  label: "MiroFish" },
  { href: "/terminal",  label: "Terminal" },
  { href: "/settings",  label: "Keys" },
];

export default function TopNav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-50 flex items-center gap-4 px-5 h-14 border-b backdrop-blur-xl"
         style={{
           background: "linear-gradient(180deg, rgba(13,16,23,0.92), rgba(10,12,17,0.82))",
           borderColor: "var(--hud-border)",
           boxShadow: "0 1px 0 rgba(255,255,255,0.03), 0 8px 24px -16px rgba(0,0,0,0.8)",
         }}>
      {/* Wordmark */}
      <Link href="/" className="flex items-center gap-2 flex-shrink-0 group" aria-label="AXIOM home">
        <svg viewBox="0 0 64 64" className="w-[22px] h-[22px] flex-shrink-0" aria-hidden="true">
          <defs>
            <linearGradient id="axnav" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--hud-accent-2)" />
              <stop offset="45%" stopColor="var(--hud-accent)" />
              <stop offset="100%" stopColor="var(--hud-accent-deep)" />
            </linearGradient>
          </defs>
          <path d="M14 49 L32 15 L50 49" fill="none" stroke="url(#axnav)" strokeWidth="7"
                strokeLinecap="round" strokeLinejoin="round" />
          <path d="M18 39 H46" stroke="url(#axnav)" strokeWidth="5" strokeLinecap="round" />
        </svg>
        <span className="hud-gradient-text text-[14px] font-extrabold tracking-[0.22em]">
          AXIOM
        </span>
      </Link>

      {/* Nav */}
      <div className="flex items-center gap-0.5 overflow-x-auto flex-1 min-w-0"
           style={{ scrollbarWidth: "none" }}>
        {LINKS.map((l) => {
          const active = pathname === l.href || (l.href === "/ai" && pathname.startsWith("/ai"));
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "relative px-3 py-1.5 rounded-md text-[11px] font-medium tracking-wide whitespace-nowrap flex-shrink-0",
                "transition-all duration-200 hover:text-[color:var(--hud-text)]",
              )}
              style={{
                color: active ? "var(--hud-accent)" : "var(--hud-muted)",
                background: active ? "var(--hud-accent-soft)" : "transparent",
                boxShadow: active ? "inset 0 0 0 1px rgba(124,154,255,0.28)" : "none",
              }}
            >
              {l.label}
              {active && (
                <span className="absolute left-1/2 -translate-x-1/2 -bottom-[7px] h-[2px] w-5 rounded-full"
                      style={{ background: "var(--hud-accent)", boxShadow: "0 0 8px var(--hud-glow)" }} />
              )}
            </Link>
          );
        })}
      </div>

      {/* Status */}
      <div className="hidden md:flex items-center gap-2 flex-shrink-0 text-[10px] tracking-widest"
           style={{ color: "var(--hud-muted)" }}>
        <span className="hud-led" style={{ background: "var(--hud-green)", color: "var(--hud-green)", width: 6, height: 6 }} />
        LIVE
        <span className="hud-chip ml-1" style={{ color: "var(--hud-amber)" }}>DRY-RUN</span>
      </div>
    </nav>
  );
}

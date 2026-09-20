import type { LucideIcon } from "lucide-react";
import {
  Home, Sparkles, Terminal, Brain, Users, Briefcase, Bot, Zap, CloudSun, Sun, LineChart, TrendingUp, Layers, Globe, Activity,
  FlaskConical, Cpu, Eye, Radio, Newspaper, BookOpen, Wallet, ShieldCheck, KeyRound, Network,
} from "lucide-react";

export type Page = { href: string; label: string; hint: string; icon: LucideIcon; keywords?: string };
export type Group = { label: string; pages: Page[] };

// The desk, in reading order: what is running → where it trades → where it
// is tested → what it can reach. This one list feeds the nav bar, the command
// palette and the home page cards.
export const GROUPS: Group[] = [
  { label: "Desk", pages: [
    { href: "/",          label: "Home",      hint: "the desk at a glance",                    icon: Home },
    { href: "/jarvis",    label: "Jarvis",    hint: "the desk's voice — ask anything",         icon: Sparkles, keywords: "assistant voice ai brief" },
    { href: "/terminal",  label: "Terminal",  hint: "order book, signal feed, kill switch",    icon: Terminal, keywords: "bloomberg kill switch" },
    { href: "/brain",     label: "Brain",     hint: "the reflection loop and daily scoreboard", icon: Brain, keywords: "lessons thompson allocation" },
    { href: "/council",   label: "Council",   hint: "eight role agents debate and rule",       icon: Users, keywords: "agents debate risk manager" },
    { href: "/workforce", label: "Workforce", hint: "the agent roster",                        icon: Briefcase },
    { href: "/connectome", label: "Connectome", hint: "the desk's nervous system, read from the code, lit by today's activity", icon: Network, keywords: "wiring graph brain map modules" },
  ]},
  { label: "Trade", pages: [
    { href: "/bots",      label: "Bots",      hint: "every paper account on one screen",       icon: Bot, keywords: "fleet flow meme gamma stocks weather strategy" },
    { href: "/crypto",    label: "Auto-Bot",  hint: "5-minute crypto engine",                  icon: Zap, keywords: "btc 5m" },
    { href: "/weather",   label: "Weather",   hint: "station observations vs market buckets",  icon: CloudSun, keywords: "metar ensemble temperature" },
    { href: "/premarket", label: "Pre-Market", hint: "first-20-minute stock picks",            icon: Sun },
    { href: "/options",   label: "Options",   hint: "chains, vol, Kelly-sized recommendations", icon: LineChart, keywords: "calls puts gamma" },
    { href: "/stocks",    label: "Stocks",    hint: "sizing and factor view",                   icon: TrendingUp },
    { href: "/arbitrage", label: "Arb",       hint: "neg-risk and cross-venue arbitrage",       icon: Layers, keywords: "kalshi negrisk" },
    { href: "/live",      label: "Markets",   hint: "live market list",                        icon: Globe },
    { href: "/tape",      label: "Tape",      hint: "the flow bot replayed frame by frame",     icon: Activity, keywords: "replay order flow cvd" },
  ]},
  { label: "Research", pages: [
    { href: "/lab",       label: "Lab",       hint: "backtests, proving ground, scenarios, benchmarks, data", icon: FlaskConical, keywords: "backtest scenario proving benchmark data desk" },
    { href: "/ai",        label: "AI Desk",   hint: "stock analyst, market intel, risk engine, macro, alpha hunter", icon: Cpu },
    { href: "/oracle",    label: "Oracle",    hint: "the oracle-lag probe, Brier-scored",       icon: Eye },
    { href: "/intel",     label: "Intel",     hint: "news read by the classifier",             icon: Radio, keywords: "sentiment materiality" },
    { href: "/news",      label: "News",      hint: "live wall, live summary, the world wire",  icon: Newspaper, keywords: "tv video headlines wire" },
    { href: "/world",     label: "World",     hint: "World Monitor, whole: the live map, chokepoints, cables, exchanges, missions", icon: Globe, keywords: "map monitor geopolitics situation room" },
    { href: "/journal",   label: "Journal",   hint: "every trade, every lesson",               icon: BookOpen },
  ]},
  { label: "Account", pages: [
    { href: "/live-account", label: "Account", hint: "balance, caps, the go-live gate",        icon: Wallet, keywords: "live balance caps" },
    { href: "/venues",    label: "Venues",    hint: "where a bot can trade from here",         icon: ShieldCheck, keywords: "hyperliquid kraken polymarket jupiter" },
    { href: "/settings",  label: "Keys",      hint: "API keys and bot switches",               icon: KeyRound, keywords: "settings env" },
    { href: "/about",     label: "About",     hint: "every source, paper, repo and feed — where it is used and what came of it", icon: BookOpen, keywords: "sources papers credits research about" },
  ]},
];

export const PAGES: Page[] = GROUPS.flatMap((g) => g.pages);
export const pageFor = (pathname: string) => PAGES.find((p) => p.href === pathname) ?? PAGES.find((p) => p.href !== "/" && pathname.startsWith(p.href));

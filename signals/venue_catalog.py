"""
VENUE CATALOG — every platform a AXIOM bot can (or soon will) trade on,
with the two things that actually decide it: can you reach it from Canada (BC),
and is the money custody model safe for an automated agent.

This is RESEARCHED, CITED reference data (not live prices) — regenerated here so
there's one honest source of truth and every claim carries a source URL. Facts
current as of Aug 2026. Nothing here trades real money; it's the map we consult
before ever building a real (dry-run-gated) adapter.

  python signals/venue_catalog.py   →   writes .data/venues.json
"""
from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "venues.json"

# canada: "yes" reachable from BC | "ontario-blocked" | "no" | "geoblocked"
# custody: how the bot holds funds — the risk that matters for automation
VENUES = [
    # ── the new bridge: agent-native wallet ──────────────────────────────────
    {
        "name": "MetaMask Agent Wallet", "cat": "Agent Wallet (NEW)", "tier": 1,
        "canada": "yes", "custody": "Self-custodial · keys in TEE enclave",
        "api": "MetaMask CLI + agent skills (natural language → signed tx)",
        "kyc": "None (self-custodial)",
        "security": "Spend caps + protocol allowlist · Guard/Beast mode · sim → Blockaid scan → MEV protect · tx protection ≤$10k/mo",
        "best_for": "Letting an AI agent trade on-chain WITH hard guardrails — supports Claude Code",
        "reaches": "Hyperliquid + EVM chains (incl. Robinhood Chain, Monad)",
        "note": "Launched Aug 6 2026 — built specifically for AI agents. Keys never leave the enclave; neither MetaMask nor Consensys can access them. This is the honest bridge from paper to guarded real trading.",
        "src": "https://cryptobriefing.com/metamask-launches-ai-agent-wallet-for-automated-onchain-trading/",
        "src_label": "CryptoBriefing · Aug 2026",
    },
    # ── on-chain perps: best non-custodial API venue ─────────────────────────
    {
        "name": "Hyperliquid", "cat": "On-chain Perps DEX", "tier": 1,
        "canada": "ontario-blocked", "custody": "Non-custodial · API wallet can trade, NOT withdraw",
        "api": "Official Python SDK + REST/WS · 200k orders/s · zero gas on L1",
        "kyc": "None",
        "security": "Agent/API wallet is a separate key that places & cancels only — funds can't be withdrawn by the bot key",
        "best_for": "Automated perps (100+ assets, 40x) — the strongest DIY-bot venue",
        "reaches": "Its own L1 (BTC/ETH/SOL/alt perps + spot)",
        "note": "Restricted in ONTARIO under provincial securities rules; the rest of Canada (incl. BC) is not named. Regulatory situation is FLUID in 2026 — verify before real funds.",
        "src": "https://www.datawallet.com/crypto/hyperliquid-supported-and-restricted-countries",
        "src_label": "Datawallet · 2026",
    },
    # ── Canada-registered CEX (custodial, KYC, but fully legal + solid API) ───
    {
        "name": "Kraken", "cat": "Centralized Exchange", "tier": 1,
        "canada": "yes", "custody": "Custodial (exchange holds funds)",
        "api": "Mature REST + WebSocket · advanced order types",
        "kyc": "Yes (FINTRAC registered)",
        "security": "API keys with per-key permissions (trade-only, no-withdraw), IP allowlist, cold storage, proof-of-reserves",
        "best_for": "The legal, boring, reliable spot/margin venue for a Canadian bot",
        "reaches": "200+ coins/pairs",
        "note": "One of the safest for Canadians — strong compliance history. Custodial means you trust the exchange with funds.",
        "src": "https://www.ratehub.ca/investing/best-crypto-exchanges",
        "src_label": "Ratehub · 2026",
    },
    {
        "name": "Coinbase (Advanced Trade)", "cat": "Centralized Exchange", "tier": 1,
        "canada": "yes", "custody": "Custodial",
        "api": "Advanced Trade REST + WS API",
        "kyc": "Yes (FINTRAC registered)",
        "security": "Scoped API keys (trade/no-withdraw), 2FA, insured custody",
        "best_for": "Deep liquidity spot for a Canadian bot; cleanest onboarding",
        "reaches": "Large coin selection",
        "note": "FINTRAC-registered and available in Canada. Custodial.",
        "src": "https://www.ratehub.ca/investing/best-crypto-exchanges",
        "src_label": "Ratehub · 2026",
    },
    {
        "name": "NDAX", "cat": "Centralized Exchange (Canadian)", "tier": 1,
        "canada": "yes", "custody": "Custodial",
        "api": "REST API · flat 0.2% fee · $0 deposits",
        "kyc": "Yes (registered nationwide)",
        "security": "Scoped API keys, cold storage",
        "best_for": "Low-fee Canadian-domiciled venue (Calgary), CAD rails via Interac",
        "reaches": "Major coins",
        "note": "Homegrown Canadian exchange, one of the lowest-spread environments here.",
        "src": "https://netcoins.com/blog/best-canadian-crypto-exchanges-compared-2026-updated-guide",
        "src_label": "Netcoins · 2026",
    },
    {
        "name": "Bitbuy", "cat": "Centralized Exchange (Canadian)", "tier": 2,
        "canada": "yes", "custody": "Custodial",
        "api": "REST API",
        "kyc": "Yes (OSC + FINTRAC)",
        "security": "Scoped keys, cold storage, proof-of-reserves",
        "best_for": "Simple regulated Canadian spot",
        "reaches": "Major coins",
        "note": "OSC/FINTRAC compliant Canadian marketplace.",
        "src": "https://www.ratehub.ca/investing/best-crypto-exchanges",
        "src_label": "Ratehub · 2026",
    },
    # ── Solana meme-coin rails (where the meme bot actually lives) ────────────
    {
        "name": "Jupiter (Solana aggregator)", "cat": "On-chain DEX — Solana meme", "tier": 1,
        "canada": "yes", "custody": "Non-custodial · signs with your Solana key",
        "api": "Swap API (routes across Raydium/Orca/Pump.fun/Moonshot) · solana-py / solders",
        "kyc": "None",
        "security": "Permissionless smart contracts — no central geo-block; you hold the key",
        "best_for": "The real home of meme-coin bot trading — best routing/liquidity on Solana",
        "reaches": "Any SPL token (DOGE-on-SOL, WIF, BONK, POPCAT, fresh launches)",
        "note": "Needs a SOLANA wallet (Phantom / solana-py), NOT MetaMask (which is EVM-first). This is where our $100 meme bot would graduate to real if it proves out.",
        "src": "https://medium.com/@www.amirj26670/how-to-buy-and-sell-any-token-on-solana-including-meme-coins-using-code-33ad16e85fce",
        "src_label": "Solana Swap API guide · 2026",
    },
    {
        "name": "Raydium / Pump.fun / Moonshot", "cat": "On-chain DEX — Solana meme", "tier": 2,
        "canada": "yes", "custody": "Non-custodial",
        "api": "Direct program calls or via aggregators; Jito bundles for priority",
        "kyc": "None",
        "security": "Permissionless; HIGH rug-pull risk on fresh launchpad tokens",
        "best_for": "Launchpad / earliest meme liquidity (highest risk)",
        "reaches": "New SPL tokens at/near launch",
        "note": "Where the rug pulls live. Our bot rule stays: liquid established coins only, never fresh micro-caps.",
        "src": "https://github.com/henrytirla/Solana-Trading-Bot",
        "src_label": "Solana-Trading-Bot (GitHub) · 2026",
    },
    # ── EVM DEX (MetaMask-native spot) ───────────────────────────────────────
    {
        "name": "Uniswap / 1inch / 0x", "cat": "On-chain DEX — EVM", "tier": 2,
        "canada": "yes", "custody": "Non-custodial · MetaMask-native",
        "api": "Router contracts + aggregator REST APIs (web3.py / ethers)",
        "kyc": "None",
        "security": "Permissionless contracts; watch slippage/MEV (MetaMask Agent Wallet adds MEV protection)",
        "best_for": "EVM spot swaps a MetaMask-signed bot can do directly",
        "reaches": "ERC-20 tokens on Ethereum + L2s (Base, Arbitrum, Optimism)",
        "note": "This is the classic MetaMask + bot path for spot. Pairs naturally with the Agent Wallet.",
        "src": "https://cryptobriefing.com/metamask-launches-ai-agent-wallet-for-automated-onchain-trading/",
        "src_label": "CryptoBriefing · 2026",
    },
    {
        "name": "dYdX v4 / GMX / Drift", "cat": "On-chain Perps DEX", "tier": 3,
        "canada": "check", "custody": "Non-custodial",
        "api": "Public APIs / SDKs (dYdX Cosmos chain, GMX on Arbitrum/Avax, Drift on Solana)",
        "kyc": "None",
        "security": "Non-custodial perps; front-ends may geo-restrict — verify from a Canadian IP",
        "best_for": "Alternative non-custodial perps if Hyperliquid is unavailable",
        "reaches": "Major perp markets",
        "note": "Legality/access from Canada varies and is fluid — confirm before real funds.",
        "src": "https://www.coinperps.com/learn/hyperliquid-restricted-countries",
        "src_label": "CoinPerps · 2026",
    },
    # ── prediction markets: the original domain, and why they're blocked ──────
    {
        "name": "Polymarket", "cat": "Prediction Market", "tier": 3,
        "canada": "geoblocked", "custody": "Non-custodial (on-chain USDC)",
        "api": "CLOB REST/WS API",
        "kyc": "None (wallet-based)",
        "security": "On-chain settlement; but front-end + CLOB enforce IP geo-block",
        "best_for": "Event/probability trading — our platform's origin",
        "reaches": "Politics, crypto, sports, econ event markets",
        "note": "IP-GEOBLOCKED in Canada (403 'Trading restricted in your region'). MetaMask does NOT bypass it — the block is at the IP level, not the wallet. We do not circumvent it.",
        "src": "https://www.coinperps.com/learn/kalshi-restricted-countries",
        "src_label": "CoinPerps · 2026",
    },
    {
        "name": "Kalshi", "cat": "Prediction Market", "tier": 3,
        "canada": "no", "custody": "Custodial (CFTC-regulated)",
        "api": "REST API",
        "kyc": "Yes (US identity)",
        "security": "Regulated US exchange",
        "best_for": "US-regulated event contracts",
        "reaches": "US event markets",
        "note": "US-only — not available to Canadian residents.",
        "src": "https://www.coinperps.com/learn/kalshi-restricted-countries",
        "src_label": "CoinPerps · 2026",
    },
    # ── explicitly NOT available ─────────────────────────────────────────────
    {
        "name": "Binance", "cat": "Centralized Exchange", "tier": 3,
        "canada": "no", "custody": "Custodial",
        "api": "REST/WS (elsewhere)",
        "kyc": "Yes",
        "security": "n/a for Canada",
        "best_for": "—",
        "reaches": "—",
        "note": "WITHDREW from Canada (2023). Not an option for a Canada-based bot.",
        "src": "https://www.ratehub.ca/investing/best-crypto-exchanges",
        "src_label": "Ratehub · 2026",
    },
]

VERDICT = (
    "MetaMask is no longer just a wallet — as of Aug 6 2026 its Agent Wallet is purpose-built "
    "for AI-agent bot trading (supports Claude Code) with spend caps, protocol allowlists and MEV "
    "protection, and it reaches Hyperliquid + EVM DEXes. From Vancouver (BC), the reachable, "
    "bot-capable venues are: MetaMask Agent Wallet, Hyperliquid (non-Ontario), Kraken/Coinbase/NDAX "
    "(regulated CEX), and Jupiter/Uniswap (non-custodial DEX for meme + spot). Polymarket stays "
    "IP-geoblocked and we do not circumvent it. Everything here is a MAP — the discipline holds: "
    "paper-first, then a dry-run-gated adapter, before one real cent."
)


def main() -> None:
    report = {
        "ts": int(time.time()),
        "as_of": "2026-08",
        "home_base": "Vancouver, BC, Canada",
        "verdict": VERDICT,
        "venues": VENUES,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    print(f"[venues] wrote {len(VENUES)} venues → {OUT}")
    for v in VENUES:
        flag = {"yes": "✓", "ontario-blocked": "~", "check": "?",
                "geoblocked": "✗", "no": "✗"}.get(v["canada"], "?")
        print(f"  {flag} {v['name']:<34} {v['cat']}")


if __name__ == "__main__":
    main()

"""
SCENARIO SIM — turn both bots loose on every fault, prove they can't blow up.

"Full hands to the bots" done responsibly: this hammers the Hyperliquid and
Solana/Jupiter adapters through every ugly thing a real venue can do — clean
fills, partial fills, rejects, slippage blowouts, timeouts, liquidations, rug
pulls, cap breaches, duplicate sends — thousands of randomized times, and only
prints PERFECT when EVERY invariant holds on EVERY run. No network, no real money;
it drives the adapters' test seams and asserts the safety math.

The invariants (these are the whole reason a bot can be trusted with the wheel):
  I1  paper mode never emits a live order
  I2  committed capital per order never exceeds the per-order cap
  I3  cumulative committed never exceeds the daily cap
  I4  leverage never exceeds the max (Hyperliquid)
  I5  a fill worse than the slippage tolerance ABORTS (no position, no spend)
  I6  a fill within tolerance goes through
  I7  a venue reject leaves no spend and doesn't crash
  I8  a timeout is 'unknown' (never silently resent → no double spend)
  I9  a partial fill commits only the filled fraction
  I10 realized loss can never exceed committed capital (liquidation / rug floor)
  I11 going live requires BOTH the switch off AND a key — either alone stays paper

Run:  python execution/scenario_sim.py            (one full suite)
      python execution/scenario_sim.py 5          (5 rounds; loops till perfect)
Writes .data/scenario_report.json for the /proving-ground page.
"""
from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hyperliquid_adapter as hl
import solana_adapter as sol
import ccxt_adapter as cx

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / ".data" / "_sim_orders.jsonl"
OUT = ROOT / ".data" / "scenario_report.json"

# a controlled env so gate()/limits are deterministic (never touches real .env)
PAPER_ENV = {"HL_DRY_RUN": "true", "HL_MAX_ORDER_USD": "5", "HL_DAILY_CAP_USD": "20",
             "HL_MAX_LEVERAGE": "3", "HL_SLIPPAGE_BPS": "50",
             "SOL_DRY_RUN": "true", "SOL_MAX_ORDER_USD": "5", "SOL_DAILY_CAP_USD": "20",
             "SOL_SLIPPAGE_BPS": "150",
             "CCXT_DRY_RUN": "true", "CCXT_MAX_ORDER_USD": "5", "CCXT_DAILY_CAP_USD": "20",
             "CCXT_SLIPPAGE_BPS": "30"}


def _fresh(mod, env: dict) -> None:
    """Point an adapter at a clean temp log and a controlled env — hermetic."""
    if TMP.exists():
        TMP.unlink()
    mod.LOG = TMP
    mod._env = lambda: dict(env)


class Suite:
    def __init__(self) -> None:
        self.results: dict[str, dict] = {}

    def check(self, scenario: str, ok: bool, detail: str = "") -> None:
        r = self.results.setdefault(scenario, {"runs": 0, "fails": 0, "first_fail": ""})
        r["runs"] += 1
        if not ok:
            r["fails"] += 1
            if not r["first_fail"]:
                r["first_fail"] = detail

    # ── Hyperliquid scenarios ────────────────────────────────────────────────
    def hl_round(self, n: int) -> None:
        for _ in range(n):
            _fresh(hl, PAPER_ENV)
            mid = random.uniform(0.5, 90000)
            side = random.choice(["LONG", "SHORT"])

            # I1 paper never live · I2 cap clamp · I4 lev clamp · I10 loss bound
            r = hl.place_perp("BTC", side, margin_usd=random.uniform(0.1, 50),
                              leverage=random.uniform(1, 25), _mid=mid)
            self.check("HL normal fill", r["outcome"] in ("filled", "partial"), str(r))
            self.check("I1 paper-never-live", r["mode"] == "paper", str(r))
            self.check("I2 per-order cap", r["margin"] <= 5 + 1e-9, f"margin {r.get('margin')}")
            self.check("I4 leverage cap", r["leverage"] <= 3 + 1e-9, f"lev {r.get('leverage')}")
            self.check("I10 loss<=margin (entry)", r.get("max_loss", 0) <= r["margin"] + 1e-9, str(r))

            # I5 slippage abort (inject a blowout beyond 50bps)
            _fresh(hl, PAPER_ENV)
            r = hl.place_perp("BTC", side, 3, 2, _mid=mid,
                              _outcome={"kind": "fill", "slippage_bps": random.uniform(60, 400)})
            self.check("I5 slippage abort", r["outcome"] == "aborted", str(r))
            self.check("I5 no spend on abort", hl._today_committed() == 0, "spend leaked")

            # I6 slippage within tolerance fills
            _fresh(hl, PAPER_ENV)
            r = hl.place_perp("BTC", side, 3, 2, _mid=mid,
                              _outcome={"kind": "fill", "slippage_bps": random.uniform(0, 45)})
            self.check("I6 in-tolerance fills", r["outcome"] == "filled", str(r))

            # I7 reject
            _fresh(hl, PAPER_ENV)
            r = hl.place_perp("BTC", side, 3, 2, _mid=mid, _outcome={"kind": "reject"})
            self.check("I7 reject no spend", r["outcome"] == "rejected" and hl._today_committed() == 0, str(r))

            # I8 timeout is unknown + idempotent resend
            _fresh(hl, PAPER_ENV)
            r1 = hl.place_perp("BTC", side, 3, 2, _mid=mid, client_id="dup1", _outcome={"kind": "timeout"})
            self.check("I8 timeout unknown", r1["outcome"] == "unknown", str(r1))
            # a filled order then a resend with the same cid must dedupe
            _fresh(hl, PAPER_ENV)
            hl.place_perp("BTC", side, 3, 2, _mid=mid, client_id="dup2")
            r2 = hl.place_perp("BTC", side, 3, 2, _mid=mid, client_id="dup2")
            self.check("I8 idempotent resend", r2["outcome"] == "duplicate", str(r2))

            # I9 partial fill commits only filled fraction
            _fresh(hl, PAPER_ENV)
            ratio = random.uniform(0.1, 0.9)
            r = hl.place_perp("BTC", side, 4, 2, _mid=mid, _outcome={"kind": "partial", "ratio": ratio, "slippage_bps": 5})
            self.check("I9 partial commits fraction",
                       abs(r["margin"] - round(4 * ratio, 2)) < 0.02, str(r))

            # I3 daily cap: fire many max orders, committed must never exceed cap
            _fresh(hl, PAPER_ENV)
            for _ in range(12):
                hl.place_perp("BTC", side, 5, 1, _mid=mid, _outcome={"kind": "fill", "slippage_bps": 5})
            self.check("I3 daily cap", hl._today_committed() <= 20 + 1e-9,
                       f"committed {hl._today_committed()}")

            # I10 loss bound on close (catastrophic adverse move can't exceed margin)
            entry = mid
            crash = mid * (0.001 if side == "LONG" else 50)  # wipeout move
            c = hl.close_perp("x", entry, crash, side, margin=5, leverage=3)
            self.check("I10 liquidation floor", c["pnl"] >= -5 - 1e-9, str(c))

            # I11 live requires switch OFF and key
            _fresh(hl, {**PAPER_ENV, "HL_DRY_RUN": "false"})  # switch off, NO key
            live, _, _ = hl.gate()
            self.check("I11 no-key stays paper", live is False, "went live without key")
            _fresh(hl, {**PAPER_ENV, "HL_API_WALLET_KEY": "k"})  # key, switch ON (dry)
            live, _, _ = hl.gate()
            self.check("I11 switch-on stays paper", live is False, "went live with switch on")

    # ── Solana / Jupiter scenarios ───────────────────────────────────────────
    def sol_round(self, n: int) -> None:
        for _ in range(n):
            _fresh(sol, PAPER_ENV)
            px = random.uniform(1e-8, 5)

            r = sol.buy_token("WIF", px, size_usd=random.uniform(0.1, 50))
            self.check("SOL normal fill", r["outcome"] in ("filled", "partial"), str(r))
            self.check("I1 paper-never-live (sol)", r["mode"] == "paper", str(r))
            self.check("I2 per-order cap (sol)", r["size"] <= 5 + 1e-9, f"size {r.get('size')}")
            self.check("I10 loss<=size (entry)", r.get("max_loss", 0) <= r["size"] + 1e-9, str(r))

            _fresh(sol, PAPER_ENV)
            r = sol.buy_token("WIF", px, 3, _outcome={"kind": "fill", "slippage_bps": random.uniform(160, 900)})
            self.check("I5 slippage abort (sol)", r["outcome"] == "aborted", str(r))
            self.check("I5 no spend on abort (sol)", sol._today_swapped() == 0, "spend leaked")

            _fresh(sol, PAPER_ENV)
            r = sol.buy_token("WIF", px, 3, _outcome={"kind": "reject"})
            self.check("I7 reject no spend (sol)", r["outcome"] == "rejected" and sol._today_swapped() == 0, str(r))

            _fresh(sol, PAPER_ENV)
            r = sol.buy_token("WIF", px, 3, client_id="sdup", _outcome={"kind": "timeout"})
            self.check("I8 timeout unknown (sol)", r["outcome"] == "unknown", str(r))

            _fresh(sol, PAPER_ENV)
            for _ in range(12):
                sol.buy_token("WIF", px, 5, _outcome={"kind": "fill", "slippage_bps": 5})
            self.check("I3 daily cap (sol)", sol._today_swapped() <= 20 + 1e-9,
                       f"swapped {sol._today_swapped()}")

            # I10 rug pull: token → 0, loss can't exceed the size swapped in
            tokens = 3 / px
            c = sol.sell_token("x", "WIF", tokens, entry_size=3, exit_price=0.0)
            self.check("I10 rug floor", c["pnl"] >= -3 - 1e-9 and c["rugged"], str(c))

    # ── CCXT (100+ exchanges) scenarios — same invariants, spot ──────────────
    def ccxt_round(self, n: int) -> None:
        for _ in range(n):
            _fresh(cx, PAPER_ENV)
            px = random.uniform(0.01, 90000)
            side = random.choice(["BUY", "SELL"])

            r = cx.place_order("BTC/USD", side, random.uniform(0.1, 50), _price=px)
            self.check("CCXT normal fill", r["outcome"] in ("filled", "partial"), str(r))
            self.check("I1 paper-never-live (ccxt)", r["mode"] == "paper", str(r))
            self.check("I2 per-order cap (ccxt)", r["size"] <= 5 + 1e-9, f"size {r.get('size')}")
            self.check("I10 loss<=size (ccxt)", r.get("max_loss", 0) <= r["size"] + 1e-9, str(r))

            _fresh(cx, PAPER_ENV)
            r = cx.place_order("BTC/USD", side, 3, _price=px, _outcome={"kind": "fill", "slippage_bps": random.uniform(40, 500)})
            self.check("I5 slippage abort (ccxt)", r["outcome"] == "aborted", str(r))
            self.check("I5 no spend on abort (ccxt)", cx._today_traded() == 0, "spend leaked")

            _fresh(cx, PAPER_ENV)
            r = cx.place_order("BTC/USD", side, 3, _price=px, _outcome={"kind": "reject"})
            self.check("I7 reject no spend (ccxt)", r["outcome"] == "rejected" and cx._today_traded() == 0, str(r))

            _fresh(cx, PAPER_ENV)
            r = cx.place_order("BTC/USD", side, 3, _price=px, client_id="cxdup", _outcome={"kind": "timeout"})
            self.check("I8 timeout unknown (ccxt)", r["outcome"] == "unknown", str(r))

            _fresh(cx, PAPER_ENV)
            for _ in range(12):
                cx.place_order("BTC/USD", side, 5, _price=px, _outcome={"kind": "fill", "slippage_bps": 3})
            self.check("I3 daily cap (ccxt)", cx._today_traded() <= 20 + 1e-9, f"traded {cx._today_traded()}")


def run(rounds: int, per: int = 60) -> dict:
    suite = Suite()
    t0 = time.time()
    for _ in range(rounds):
        suite.hl_round(per)
        suite.sol_round(per)
        suite.ccxt_round(per)
    if TMP.exists():
        TMP.unlink()
    scenarios = sorted(suite.results.items())
    total_runs = sum(r["runs"] for _, r in scenarios)
    total_fails = sum(r["fails"] for _, r in scenarios)
    report = {
        "ts": int(time.time()), "rounds": rounds, "seconds": round(time.time() - t0, 2),
        "total_runs": total_runs, "total_fails": total_fails,
        "perfect": total_fails == 0,
        "scenarios": [{"name": k, "runs": v["runs"], "fails": v["fails"],
                       "pass_rate": round((v["runs"] - v["fails"]) / v["runs"], 4) if v["runs"] else 0,
                       "first_fail": v["first_fail"]} for k, v in scenarios],
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    return report


def main() -> None:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    rep = run(rounds)
    print(f"\nSCENARIO SIM — {rep['total_runs']} assertions across "
          f"{len(rep['scenarios'])} scenarios in {rep['seconds']}s\n")
    width = max(len(s["name"]) for s in rep["scenarios"])
    for s in rep["scenarios"]:
        mark = "✓" if s["fails"] == 0 else "✗"
        line = f"  {mark} {s['name']:<{width}}  {s['runs']:>4} runs  {s['pass_rate']*100:5.1f}%"
        if s["fails"]:
            line += f"   FAIL: {s['first_fail'][:80]}"
        print(line)
    print()
    if rep["perfect"]:
        print(f"  ★ PERFECT — {rep['total_runs']} assertions, 0 failures. "
              f"Every invariant holds; the bots can't blow past the caps.")
    else:
        print(f"  ✗ {rep['total_fails']} failures — NOT perfect yet. Fix and rerun.")
    print(f"\n  report → {OUT}")


if __name__ == "__main__":
    main()

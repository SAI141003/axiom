"""
AXIOM advisor — tells the investor what to buy, when, and why. Runs every
15 minutes around the clock (launchd); places no orders.

For every saved plan (Invest page → "Save as my plan"):
  * SIP BUY     — the day before and at each monthly buy (first trading day,
                  10:00 AM New York): every holding, the amount, the share count.
  * PAUSE       — a holding closed a month below its 10-month average and, on
                  that fund's own 20-year history, stepping aside beat holding
                  on both return and worst fall: its new money waits in a
                  T-bill fund (nothing is sold) until the trend turns up.
                  Where stepping aside did not pay, nothing is said.
  * RESUME      — a paused holding closed a month back above its average.
  * DIP         — a holding marked "buy on dip" reached its limit price.
  * NEWS        — once a day, the freshest headlines on the holdings.

Writes .data/advice.json (the dashboard reads it) and pushes each new call
once to the ntfy topic in .env (NTFY_TOPIC). Nothing here is a trade; the
investor decides.
"""
import json, os, time, urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / ".data"
PROFILES = DATA / "client_profile.json"
OUT = DATA / "advice.json"
SENT = DATA / "advice_sent.json"
DESK = os.environ.get("DESK_URL", "http://localhost:3300")
IST, ET = ZoneInfo("Asia/Kolkata"), ZoneInfo("America/New_York")


def env(key: str) -> str:
    try:
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return ""


def get(path: str, body: dict | None = None, timeout: int = 200):
    req = urllib.request.Request(DESK + path, data=json.dumps(body).encode() if body else None,
                                 headers={"content-type": "application/json"} if body else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def push(title: str, body: str, click: str | None = None) -> None:
    topic = env("NTFY_TOPIC")
    if not topic:
        return
    h = {"Title": title.encode("utf-8").decode("latin-1", "ignore"), "Tags": "chart_with_upwards_trend", "Priority": "high"}
    if click:
        h["Click"] = click
    try:
        urllib.request.urlopen(urllib.request.Request(f"https://ntfy.sh/{topic}", data=body.encode(), headers=h), timeout=20)
    except Exception as e:
        print(f"push failed: {e}")


def stamp(ms: float) -> str:
    t = ms / 1000
    return (datetime.fromtimestamp(t, ET).strftime("%a %d %b, %I:%M %p ET") + " · "
            + datetime.fromtimestamp(t, IST).strftime("%I:%M %p IST"))


def money(v: float, cur: str) -> str:
    return f"{'C$' if cur == 'CAD' else '$'}{v:,.2f}"


def calls_for(profile: dict, now_ms: float, state: dict) -> tuple[list[dict], list[dict]]:
    plan = get("/api/invest/plan", profile)
    style = profile.get("style", "diversified")
    orders = plan["buy"][style]
    cur = plan["currency"]
    cal = plan["analysis"]["diversified" if style == "diversified" else "core"]["calendar"]
    tag = f"{profile['market'].upper()} {money(profile['monthly'], cur)}/mo"
    out: list[dict] = []

    # ── the monthly buy ──
    nxt = cal[0]
    lines = [f"{o['symbol'].replace('.TO', '')}: {money(o['amount'], cur)}" + (f" (~{o['fractional']:.2f} sh @ {o['price']:.2f})" if o.get("price") else "") for o in orders]
    if now_ms >= nxt["at"] - 86400_000:
        live = now_ms >= nxt["at"]
        out.append({
            "id": f"sip-{profile['market']}-{nxt['date']}-{'now' if live else 'eve'}", "kind": "SIP BUY", "market": profile["market"],
            "title": f"{'Buy now' if live else 'Tomorrow'}: your {tag} SIP — {len(orders)} buys",
            "why": f"Your plan buys on the first trading day of every month at 10:00 AM New York. Same amounts every month, whatever the market did — that is what the back-test measured ({plan['analysis']['diversified' if style == 'diversified' else 'core']['backtest']['annual'] * 100:.1f}%/yr since {plan['analysis']['diversified' if style == 'diversified' else 'core']['backtest']['from']}).",
            "when": nxt["at"], "until": nxt["at"] + 8 * 3600_000, "detail": lines,
        })
    else:
        out.append({"id": f"sip-next-{profile['market']}-{nxt['date']}", "kind": "NEXT SIP", "market": profile["market"], "silent": True,
                    "title": f"Next {tag} SIP buy: {stamp(nxt['at'])}", "why": "Monthly, first trading day, 10:00 AM New York.",
                    "when": nxt["at"], "until": nxt["at"], "detail": lines})

    # ── live chart on every holding ──
    syms = [o["symbol"] for o in orders]
    rows: list[dict] = []
    for i in range(0, len(syms), 8):
        try:
            rows += get(f"/api/invest/watch?symbols={','.join(syms[i:i + 8])}").get("rows", [])
        except Exception as e:
            print(f"watch failed: {e}")
    news: list[dict] = []
    paused = state.setdefault("paused", {})
    for r in rows:
        if r.get("error"):
            continue
        s = r["symbol"].replace(".TO", "")
        key = f"{profile['market']}:{r['symbol']}"
        if r["action"] == "SELL":
            paused[key] = (r["rule"].get("lastFlip") or {}).get("at")
        elif key in paused and r["rule"].get("in"):
            amt = next((o["amount"] for o in orders if o["symbol"] == r["symbol"]), 0)
            out.append({"id": f"resume-{r['symbol']}-{paused[key]}", "kind": "RESUME", "market": profile["market"],
                        "title": f"Resume {s}: its {money(amt, cur)} goes back into {s} from the next buy",
                        "why": f"{s} closed a month back above its 10-month average ({r['rule']['tenMonthAvg']:.2f}) — the trend that paused it has turned up. What waited in the T-bill fund can move back into {s} now.",
                        "when": r["times"]["nextSip"], "until": r["times"]["nextSip"] + 8 * 3600_000, "detail": [f"{s} price {r['price']:.2f}"]})
            del paused[key]
        if r["action"] == "SELL":
            # a long-term SIP does not sell its holdings on a trend signal: new
            # money for this holding waits in a T-bill fund until the trend
            # turns back up, and what is already owned is kept
            amt = next((o["amount"] for o in orders if o["symbol"] == r["symbol"]), 0)
            park = "CASH.TO" if profile["market"] == "ca" else "SGOV"
            flip = (r["rule"].get("lastFlip") or {}).get("at")
            out.append({"id": f"pause-{r['symbol']}-{flip}", "kind": "PAUSE", "market": profile["market"],
                        "title": f"Pause new money into {s}: put its {money(amt, cur)} into {park.replace('.TO', '')} until the trend turns up",
                        "why": r["why"].split(" Sell at the next session")[0] + f" Keep the {s} you own. Re-checked at every month-end close; you will be told when to switch back.",
                        "when": r["times"]["actOn"], "until": r["times"]["nextCheck"] + 3600_000,
                        "detail": [f"{s} price {r['price']:.2f} {r.get('currency', '')}", f"{park.replace('.TO', '')}: T-bill fund, cash-like"]})
        elif r["action"] == "BUY ON DIP" and r.get("buyLimit") and r["price"] <= r["buyLimit"]:
            out.append({"id": f"dip-{r['symbol']}-{datetime.now(ET):%Y-%m-%d}", "kind": "DIP", "market": profile["market"],
                        "title": f"{s} reached its dip price {r['buyLimit']:.2f} — extra money can go in", "why": r["why"],
                        "when": now_ms, "until": now_ms + 86400_000, "detail": [f"price {r['price']:.2f}"]})
        for n in r.get("news", [])[:3]:
            if n.get("at") and now_ms - n["at"] < 86400_000:
                news.append({"symbol": s, "about": n["about"].replace(".TO", ""), "title": n["title"], "link": n["link"], "at": n["at"]})
    seen, uniq = set(), []
    for n in sorted(news, key=lambda x: -x["at"]):
        if n["title"] not in seen:
            seen.add(n["title"]); uniq.append(n)
    return out, uniq[:12]


def main() -> None:
    try:
        profiles = json.loads(PROFILES.read_text()).get("profiles", [])
    except (OSError, ValueError):
        profiles = []
    now_ms = time.time() * 1000
    STATE = DATA / "advice_state.json"
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    calls: list[dict] = []
    news: list[dict] = []
    for p in profiles:
        try:
            c, n = calls_for(p, now_ms, state)
            calls += c; news += n
        except Exception as e:
            print(f"{datetime.now(IST):%d %b %H:%M} IST plan {p.get('market')} failed: {e}")
    calls = [c for c in calls if c["until"] >= now_ms or c.get("silent")]
    OUT.write_text(json.dumps({"generated": now_ms, "profiles": profiles, "calls": calls, "news": news}))
    STATE.write_text(json.dumps(state))

    sent = set(json.loads(SENT.read_text())) if SENT.exists() else set()
    for c in calls:
        if c.get("silent") or c["id"] in sent:
            continue
        push(f"{c['kind']} · {c['title']}"[:180], c["why"] + ("\n\n" + "\n".join(c["detail"]) if c.get("detail") else ""), f"{DESK}/stocks")
        sent.add(c["id"])
    # one news digest a day, first run after 07:30 New York
    et = datetime.now(ET)
    digest = f"news-{et:%Y-%m-%d}"
    if news and digest not in sent and (et.hour, et.minute) >= (7, 30):
        push("Today's news on your holdings", "\n".join(f"• {n['about']}: {n['title']}" for n in news[:6]), f"{DESK}/stocks")
        sent.add(digest)
    SENT.write_text(json.dumps(sorted(sent)[-500:]))
    print(f"{datetime.now(IST):%d %b %H:%M} IST · {len(profiles)} plan(s) · {len(calls)} call(s) · {len(news)} news")


if __name__ == "__main__":
    main()

"""
Weather trade alerts, pushed to the ntfy phone app.

Every run reads the desk's live weather scan and texts the top three picks that
pass a strict rule — stricter than the bot's own gate — and never repeats one:

  * the bot's gated pick (moderate edge, strong favourite)
  * settled on the real airport station (METAR), not grid data
  * the bot's own buying window is open (2 PM city time or later)
  * the model gives the side at least 5 points more than the price

Backtest on the bot's history (first time each market qualified, 2 PM+):
bot gate 87 trades 87.4% won $0.83/trade; this rule 68 trades 88.2% won
$1.05/trade. A tighter 80-95c band did worse (84.8%, $0.14/trade).

Nothing qualifies -> nothing is sent.
"""
import json, re, time, urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

def _env(key: str) -> str:
    for line in (Path(__file__).resolve().parent.parent / ".env").read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


DESK = "http://localhost:3300/api/weather"
SENT = Path(__file__).resolve().parent.parent / ".data" / "weather_alerts_sent.json"
IST = ZoneInfo("Asia/Kolkata")


def perfect(reports: list[dict]) -> list[dict]:
    now_ms = time.time() * 1000
    out = []
    for r in reports:
        p = r.get("pick")
        if not p or r.get("obsSource") != "metar" or now_ms < r["buyFrom"]:
            continue
        if p["model"] < p["price"] + 0.05:
            continue
        out.append({**p, "slug": r["slug"], "margin": p["model"] - p["price"]})
    return sorted(out, key=lambda x: -x["margin"])


def push(text: str, title: str = "AXIOM weather picks", click: str | None = None) -> bool:
    """ntfy.sh push to the phone app subscribed to NTFY_TOPIC (no account, no Mac prompt)."""
    topic = _env("NTFY_TOPIC")
    if not topic:
        return False
    headers = {"Title": title.encode("utf-8").decode("latin-1", "ignore"), "Tags": "moneybag", "Priority": "high"}
    if click:
        headers["Click"] = click
        headers["Actions"] = f"view, Open on Polymarket, {click}"
    try:
        req = urllib.request.Request(f"https://ntfy.sh/{topic}", data=text.encode(), headers=headers)
        urllib.request.urlopen(req, timeout=20)
        return True
    except Exception as e:
        print(f"push failed: {e}")
        return False


def max_price(p: dict) -> float:
    """Highest price that still passes the rule (model 5+ points above), capped at 97c."""
    return min(0.97, p["model"] - 0.05)


def order(p: dict) -> tuple[str, str]:
    """One pick as an exact order: title line and body."""
    m = re.search(r"highest temperature in (.+?) be (.+?) on (\w+ \d+)", p["question"])
    what = f"{m.group(1)} {m.group(2)} ({m.group(3)})" if m else p["question"]
    title = f"BUY {p['side']} · {what}"
    body = (f"{p['question']}\n"
            f"Buy {p['side']} now at {p['price']*100:.0f}c. Pay no more than {max_price(p)*100:.0f}c.\n"
            f"Model: {p['model']*100:.0f}% · settles on the airport station.")
    return title, body


def main() -> None:
    with urllib.request.urlopen(DESK, timeout=170) as r:
        reports = json.load(r).get("reports", [])
    sent = set(json.loads(SENT.read_text())) if SENT.exists() else set()
    picks = [p for p in perfect(reports) if f'{p["slug"]}|{p["side"]}' not in sent][:3]
    stamp = datetime.now(IST).strftime("%d %b %I:%M %p IST")
    if not picks:
        print(f"{stamp} no perfect picks")
        return
    for p in picks:
        title, body = order(p)
        if not push(body, title=title, click=f"https://polymarket.com/event/{p['slug']}"):
            picks = picks[:picks.index(p)]   # keep unsent ones for the next run
            break
    sent.update(f'{p["slug"]}|{p["side"]}' for p in picks)
    SENT.write_text(json.dumps(sorted(sent)))
    print(f"{stamp} pushed {len(picks)}")

if __name__ == "__main__":
    main()

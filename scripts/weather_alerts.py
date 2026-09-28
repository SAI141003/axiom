"""
Weather trade alerts by text message.

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
import json, subprocess, time, urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

TO = "+17783195274"
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


def send(text: str) -> bool:
    # iMessage first; SMS relays through the paired iPhone ("Text Message Forwarding")
    for service in ("iMessage", "SMS"):
        script = f'''tell application "Messages"
  set s to 1st account whose service type = {service}
  send {json.dumps(text)} to participant {json.dumps(TO)} of s
end tell'''
        try:
            subprocess.run(["osascript", "-e", script], check=True, timeout=30, capture_output=True)
            return True
        except Exception as e:
            print(f"send via {service} failed: {getattr(e, 'stderr', b'') or e}")
    return False


def main() -> None:
    with urllib.request.urlopen(DESK, timeout=170) as r:
        reports = json.load(r).get("reports", [])
    sent = set(json.loads(SENT.read_text())) if SENT.exists() else set()
    picks = [p for p in perfect(reports) if f'{p["slug"]}|{p["side"]}' not in sent][:3]
    stamp = datetime.now(IST).strftime("%d %b %I:%M %p IST")
    if not picks:
        print(f"{stamp} no perfect picks")
        return
    lines = [f"AXIOM weather · {stamp}"]
    for i, p in enumerate(picks, 1):
        lines.append(f"{i}. BUY {p['side']} @ {p['price']*100:.0f}c (model {p['model']*100:.0f}%)\n{p['question']}\npolymarket.com/event/{p['slug']}")
    lines.append("Paper-tested, not advice.")
    if send("\n\n".join(lines)):
        sent.update(f'{p["slug"]}|{p["side"]}' for p in picks)
        SENT.write_text(json.dumps(sorted(sent)))
        print(f"{stamp} sent {len(picks)}")


if __name__ == "__main__":
    main()

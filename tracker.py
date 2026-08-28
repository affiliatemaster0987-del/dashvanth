"""
Call tracker + accuracy store (SQLite).

Two rules this file exists to enforce:
  1. Calls that never reached entry are stored, but excluded from every
     accuracy number. Win rate is computed over triggered calls only.
  2. Maximum favourable excursion is recorded on every call, so a trade that
     ran to 24.5 and reversed is not filed away as a plain stop-loss.
"""
import json
import threading
from datetime import datetime, date, timedelta

import config
import db

_lock = db.lock()
IST = timedelta(hours=5, minutes=30)


def now_ist() -> datetime:
    """Render runs in UTC. Every stamp the trader reads must be IST."""
    return datetime.utcnow() + IST


def today_ist():
    return now_ist().date()

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL,
    trade_date    TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    underlying    TEXT,
    side          TEXT NOT NULL,
    tier          TEXT,
    score         INTEGER,
    window_key    TEXT,
    jackpot       INTEGER DEFAULT 0,
    news_based    INTEGER DEFAULT 0,
    entry         REAL, sl REAL, t1 REAL, t2 REAL, t3 REAL,
    ltp           REAL,
    max_seen      REAL,
    min_seen      REAL,
    status        TEXT DEFAULT 'WAITING',
    triggered     INTEGER DEFAULT 0,
    t1_at TEXT, t2_at TEXT, t3_at TEXT, closed_at TEXT,
    result        TEXT,
    pnl_pct       REAL,
    why           TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_date ON calls(trade_date);
"""

# Columns added after v1 shipped. Applied with ALTER TABLE so an existing
# terminal.db keeps its history instead of being wiped.
MIGRATIONS = [
    ("detected_at", "TEXT"), ("confirmed_at", "TEXT"),
    ("released_at", "TEXT"), ("entry_at", "TEXT"),
    ("zone_low", "REAL"), ("zone_high", "REAL"),
    ("confidence", "TEXT"), ("spot_entry", "REAL"),
]


def _conn():
    return db.connect()


def init():
    with _lock, _conn() as c:
        c.executescript(SCHEMA)
        have = c.columns("calls")
        for col, coltype in MIGRATIONS:
            if col not in have:
                c.execute(f"ALTER TABLE calls ADD COLUMN {col} {coltype}")


def create_call(d: dict) -> int:
    now = now_ist().isoformat(timespec="seconds")
    clock = now_ist().strftime("%H:%M")
    with _lock, _conn() as c:
        return c.insert(
            """INSERT INTO calls (created_at, trade_date, symbol, underlying, side,
               tier, score, window_key, jackpot, news_based, entry, sl, t1, t2, t3,
               ltp, max_seen, min_seen, why, detected_at, confirmed_at, released_at,
               zone_low, zone_high, confidence, spot_entry)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (now, today_ist().isoformat(), d["symbol"], d.get("underlying"), d["side"],
             d.get("tier"), d.get("score"), d.get("window_key"),
             int(d.get("jackpot", 0)), int(d.get("news_based", 0)),
             d["entry"], d["sl"], d["t1"], d["t2"], d["t3"],
             d["entry"], d["entry"], d["entry"], d.get("why", ""),
             d.get("detected_at"), d.get("confirmed_at"), d.get("released_at") or clock,
             d.get("zone_low"), d.get("zone_high"), d.get("confidence"),
             d.get("spot_entry")))


def open_calls() -> list:
    with _lock, _conn() as c:
        return c.execute(
            "SELECT * FROM calls WHERE status NOT IN ('SL HIT','EXITED','EXPIRED') "
            "ORDER BY id DESC").fetchall()


def today_calls() -> list:
    with _lock, _conn() as c:
        return c.execute(
            "SELECT * FROM calls WHERE trade_date = ? ORDER BY id DESC",
            (today_ist().isoformat(),)).fetchall()


def update_tick(call_id: int, ltp: float) -> dict:
    """
    Advance one call's state machine on a new price.
    Returns the updated row plus a `transition` key when the status changed.
    """
    now = now_ist().strftime("%H:%M")
    with _lock, _conn() as c:
        r = c.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
        if not r:
            return {}
        if r["status"] in ("SL HIT", "EXITED", "EXPIRED"):
            return r

        max_seen = max(r["max_seen"] or ltp, ltp)
        min_seen = min(r["min_seen"] or ltp, ltp)
        status, result = r["status"], r["result"]
        t1_at, t2_at, t3_at = r["t1_at"], r["t2_at"], r["t3_at"]
        closed_at = r["closed_at"]
        triggered = r["triggered"]
        entry_at = r["entry_at"]

        if status == "WAITING" and ltp >= r["entry"]:
            status, triggered = "RUNNING", 1
            entry_at = r["entry_at"] or now

        if triggered:
            if ltp <= r["sl"]:
                status = "SL HIT"
                closed_at = now
                # a stop after T2 is still a T2 result, not a loss
                result = "T2 + TRAIL" if t2_at else "T1 + TRAIL" if t1_at else "SL"
            else:
                # record any new target reached, but never walk the status
                # backwards - a call that ran to T2 and eased off is still
                # a T2 call sitting in trail, not a fresh T1.
                if ltp >= r["t3"]:
                    t3_at = t3_at or now
                elif ltp >= r["t2"]:
                    t2_at = t2_at or now
                elif ltp >= r["t1"]:
                    t1_at = t1_at or now
                result = "T3" if t3_at else "T2" if t2_at else "T1" if t1_at else result
                reached = "T3 HIT" if t3_at else "T2 HIT" if t2_at else "T1 HIT" if t1_at else "RUNNING"
                rank = {"RUNNING": 0, "T1 HIT": 1, "T2 HIT": 2, "T3 HIT": 3}
                status = reached if rank[reached] >= rank.get(status, 0) else status

        # best move since entry - the number that survives a reversal
        pnl = round((max_seen - r["entry"]) / r["entry"] * 100, 2) if r["entry"] else 0
        live = round((ltp - r["entry"]) / r["entry"] * 100, 2) if r["entry"] else 0
        c.execute(
            """UPDATE calls SET ltp=?, max_seen=?, min_seen=?, status=?, triggered=?,
               t1_at=?, t2_at=?, t3_at=?, closed_at=?, result=?, pnl_pct=?,
               entry_at=? WHERE id=?""",
            (ltp, max_seen, min_seen, status, triggered, t1_at, t2_at, t3_at,
             closed_at, result, pnl, entry_at, call_id),
        )
        out = {**r, "ltp": ltp, "max_seen": max_seen, "min_seen": min_seen,
               "status": status, "triggered": triggered, "result": result,
               "t1_at": t1_at, "t2_at": t2_at, "t3_at": t3_at, "pnl_pct": pnl,
               "live_pct": live, "entry_at": entry_at}
        if status != r["status"]:
            out["transition"] = status
        return out


# ------------------------------------------------------------------ accuracy
def accuracy(last_n: int = 50, where: str = "1=1", params=()) -> dict:
    """Computed over TRIGGERED calls only. Untriggered ones never inflate this."""
    with _lock, _conn() as c:
        rows = c.execute(
            f"SELECT * FROM calls WHERE triggered = 1 AND {where} "
            f"ORDER BY id DESC LIMIT ?", (*params, last_n)).fetchall()
    n = len(rows)
    if n == 0:
        return {"n": 0, "win": 0, "loss": 0, "t1": 0, "t2": 0, "t3": 0, "avg_max": 0}
    t1 = sum(1 for r in rows if r["t1_at"])
    t2 = sum(1 for r in rows if r["t2_at"])
    t3 = sum(1 for r in rows if r["t3_at"])
    win = sum(1 for r in rows if r["result"] and r["result"] != "SL")
    return {
        "n": n, "win": win, "loss": n - win,
        "t1": round(t1 / n * 100), "t2": round(t2 / n * 100), "t3": round(t3 / n * 100),
        "avg_max": round(sum(r["pnl_pct"] or 0 for r in rows) / n, 2),
    }


def jackpot_results() -> dict:
    """
    How the calls the terminal actually raised have worked out - today and
    over the last thirty days. Triggered calls only.
    """
    def bucket(where, params=()):
        with _lock, _conn() as c:
            rows = c.execute(
                f"SELECT * FROM calls WHERE triggered = 1 AND {where}", params).fetchall()
        n = len(rows)
        if not n:
            return {"n": 0, "t1": 0, "t2": 0, "t3": 0, "sl": 0,
                    "t1_pct": 0, "best": None}
        best = max(rows, key=lambda r: r["pnl_pct"] or 0)
        return {
            "n": n,
            "t1": sum(1 for r in rows if r["t1_at"]),
            "t2": sum(1 for r in rows if r["t2_at"]),
            "t3": sum(1 for r in rows if r["t3_at"]),
            "sl": sum(1 for r in rows if r["result"] == "SL"),
            "t1_pct": round(sum(1 for r in rows if r["t1_at"]) / n * 100),
            "best": {"symbol": best["symbol"], "pct": best["pnl_pct"]}
                    if best["pnl_pct"] else None,
        }

    cutoff = (now_ist() - timedelta(days=30)).date().isoformat()
    return {
        "today": bucket("trade_date = ?", (today_ist().isoformat(),)),
        "month": bucket("trade_date >= ?", (cutoff,)),
        "all": bucket("1=1"),
        "raised_today": len(today_calls()),
    }


def expectancy(last_n: int = 50) -> dict:
    """
    Win rate on its own is misleading. A 40% strategy with large winners
    beats a 70% one that gives it all back on the losers, so this reports
    expectancy per trade, profit factor and the worst run-down.
    """
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT * FROM calls WHERE triggered = 1 AND result IS NOT NULL "
            "ORDER BY id DESC LIMIT ?", (last_n,)).fetchall()
    rows = rows[::-1]
    if not rows:
        return {"n": 0, "expectancy": 0, "profit_factor": 0, "avg_win": 0,
                "avg_loss": 0, "win_rate": 0, "max_drawdown": 0}

    results = []
    for r in rows:
        entry = r["entry"] or 0
        if not entry:
            continue
        if r["result"] == "SL":
            results.append(-abs(entry - (r["sl"] or entry)) / entry * 100)
        else:
            hit = r["t3"] if r["t3_at"] else r["t2"] if r["t2_at"] else r["t1"]
            results.append(abs((hit or entry) - entry) / entry * 100)

    wins = [x for x in results if x > 0]
    losses = [-x for x in results if x < 0]
    n = len(results) or 1
    avg_win = sum(wins) / len(wins) if wins else 0
    avg_loss = sum(losses) / len(losses) if losses else 0
    win_rate = len(wins) / n

    equity, peak, dd = 0.0, 0.0, 0.0
    for x in results:
        equity += x
        peak = max(peak, equity)
        dd = min(dd, equity - peak)

    return {
        "n": len(results),
        "win_rate": round(win_rate * 100, 1),
        "avg_win": round(avg_win, 2), "avg_loss": round(avg_loss, 2),
        "expectancy": round(win_rate * avg_win - (1 - win_rate) * avg_loss, 2),
        "profit_factor": round(sum(wins) / sum(losses), 2) if losses else None,
        "max_drawdown": round(dd, 2),
    }


def segments(last_n: int = 50) -> list:
    return [
        {"label": "CE calls",   **accuracy(last_n, "side = ?", ("CE",))},
        {"label": "PE calls",   **accuracy(last_n, "side = ?", ("PE",))},
        {"label": "Jackpot",    **accuracy(last_n, "jackpot = 1")},
        {"label": "News-based", **accuracy(last_n, "news_based = 1")},
        {"label": "9:30-11:30", **accuracy(last_n, "window_key = ?", ("PRIME",))},
        {"label": "1:30-3:15",  **accuracy(last_n, "window_key = ?", ("SECOND",))},
    ]


def untriggered_today() -> int:
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM calls WHERE trade_date = ? AND triggered = 0",
            (today_ist().isoformat(),)).fetchone()
    return (row or {}).get("n", 0)


# ---------------------------------------------------------------- risk state
def risk_state() -> dict:
    """Consecutive stops and day P&L drive the terminal lock."""
    rows = today_calls()
    closed = [r for r in rows if r["status"] in ("SL HIT", "EXITED")]
    streak = 0
    for r in sorted(closed, key=lambda x: x["id"], reverse=True):
        if r["result"] == "SL":
            streak += 1
        else:
            break

    day_pnl = 0.0
    for r in rows:
        if not r["triggered"]:
            continue
        if r["result"] == "SL":
            day_pnl -= abs(r["entry"] - r["sl"]) * 100
        elif r["result"]:
            hit = r["t3"] if r["t3_at"] else r["t2"] if r["t2_at"] else r["t1"] if r["t1_at"] else r["entry"]
            day_pnl += abs(hit - r["entry"]) * 100

    cooldown = False
    if streak >= config.MAX_CONSECUTIVE_SL:
        last_sl = max((r["closed_at"] for r in closed if r["closed_at"]), default=None)
        cooldown = True
        if last_sl:
            try:
                t = datetime.strptime(last_sl, "%H:%M").time()
                mins = now_ist().hour * 60 + now_ist().minute
                cooldown = (mins - (t.hour * 60 + t.minute)) < config.COOLDOWN_MINUTES
            except ValueError:
                cooldown = True

    return {
        "sl_streak": streak,
        "max_sl": config.MAX_CONSECUTIVE_SL,
        "day_pnl": round(day_pnl, 2),
        "loss_limit": config.DAILY_LOSS_LIMIT,
        "cooldown_min": config.COOLDOWN_MINUTES,
        "open_count": len([r for r in rows if r["status"] in ("RUNNING", "T1 HIT", "T2 HIT")]),
        "locked": bool(cooldown) or day_pnl <= -config.DAILY_LOSS_LIMIT,
    }

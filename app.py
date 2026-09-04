"""
KRT / Mannan AI Terminal - FastAPI application.

    uvicorn app:app --host 0.0.0.0 --port $PORT

Routes
    GET  /                  the terminal
    GET  /api/health        Render health check
    GET  /api/snapshot      everything the UI needs, in one call
    GET  /api/chain/{sym}   option chain for one underlying
    GET  /api/calls         open + today's calls
    POST /api/calls         raise a call from the current top setup
    GET  /api/accuracy      last-N accuracy, segment breakdown
"""
import logging
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

# ---------------------------------------------------------------- local
# A missing or broken module here used to abort the import and take the whole
# deploy down, so the only symptom was "Failed" in the Render dashboard with
# the reason buried in a build log. The app now starts either way and serves
# the reason on /, so the screen can say what is wrong instead of nothing.
BOOT_ERROR = None
try:
    import config
    import db
    import engine
    import news as news_mod
    import notify
    import scanner
    import tracker
    from smart_client import client, now_ist
except Exception as _exc:                                  # noqa: BLE001
    import traceback
    BOOT_ERROR = {
        "error": f"{type(_exc).__name__}: {_exc}",
        "trace": traceback.format_exc()[-2000:],
        "hint": ("A module failed to import. The usual cause is a file missing from the repo - "
                 "deleting a .py file and re-uploading it fires a deploy in between, and that "
                 "deploy has nothing to import. Expected at the repo root: config.py, db.py, "
                 "engine.py, news.py, notify.py, scanner.py, tracker.py, smart_client.py, "
                 "accumulation.py, quant.py, app.py."),
    }
    logging.getLogger("app").error("boot import failed: %s", _exc)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

STATE = {"snapshot": None, "updated": None, "error": None, "boot": "starting"}
# When each setup was first noticed, first cleared its mandatory filters, and
# first became call-grade. Real observed times, not invented ones.
LIFECYCLE = {}
scheduler = BackgroundScheduler(timezone="Asia/Kolkata")


def _stamp_lifecycle(ranked):
    """
    Record the first time each setup crossed each threshold today.

    The stages are ordered: a setup cannot be confirmed before it was
    detected. Without this a candidate that cleared its mandatory filters at
    09:17 but only reached score 70 at 09:18 displayed a confirmation time
    EARLIER than its detection time, which reads like a broken clock.
    """
    clock = now_ist().strftime("%H:%M")
    today = now_ist().strftime("%Y-%m-%d")
    for r in ranked:
        key = f"{today}:{r['st']['sym']}:{r['side']}"
        entry = LIFECYCLE.setdefault(key, {})
        qualifies = not r["failed"]

        # detection is the gate: nothing later can be stamped before it
        if "detected" not in entry and (r["score"] >= 70 or qualifies):
            entry["detected"] = clock
        if "detected" in entry:
            if qualifies and "confirmed" not in entry:
                entry["confirmed"] = clock
            if (qualifies and r["score"] >= 82
                    and "confirmed" in entry and "released" not in entry):
                entry["released"] = clock
        r["times"] = dict(entry)


def _build_card(r, snap):
    """The full Call of the Day card: strike choices, zones, plan, breakdown."""
    if not r:
        return None
    st, side, win = r["st"], r["side"], snap["window"]
    rows = client.quote_strikes(client.option_chain(st["sym"], kind=side), st["ltp"])
    choices = engine.option_choices(rows, st["ltp"], side)
    safe = choices["safe"]
    prem = (engine.premium_legs(safe["prem"], safe["delta"], st["ltp"], r["legs"], win)
            if safe else None)
    spot_zone = engine.spot_zone(st["ltp"], st["atr"])

    return {
        "sym": st["sym"], "side": side, "sector": st["sector"],
        "score": r["score"], "tier": engine.classify(r["score"])["tier"],
        "confidence": engine.confidence_label(r["score"]),
        "spot": st["ltp"], "spot_zone": spot_zone,
        "in_zone": engine.in_zone(st["ltp"], spot_zone),
        "vwap": st["vwap"], "atr": st["atr"], "vol_ratio": st["vol_ratio"],
        "legs": r["legs"], "premium_legs": prem,
        "choices": choices,
        "times": r.get("times", {}),
        "checks": r["checks"], "breakdown": engine.score_breakdown(r["checks"]),
        "fake": r["fake"],
        "plan": engine.trade_plan(win, r["legs"]["capped"]),
        "lights": engine.signal_lights(st, side),
        "conf": engine.confirmations(st, side),
        "level_count": r["level_count"],
    }


# --------------------------------------------------------------- background
def refresh_snapshot():
    """Rescan the universe. Runs every minute during market hours."""
    if not client.connected and not client.login():
        STATE["error"] = client.last_error
        return
    try:
        t0 = time.time()
        snap = scanner.full_scan()
        snap["scan_ms"] = int((time.time() - t0) * 1000)
        _stamp_lifecycle(snap["ranked"])
        risk = tracker.risk_state()
        snap["risk"] = risk
        snap["commander"] = engine.build_commander({
            "risk": risk, "win": snap["window"], "bias_label": snap["bias_label"],
            "fear": snap["fear"], "bn_note": snap["bn_note"], "best": snap["best"],
            "stale": snap.get("stale"),
        })
        snap["card"] = _build_card(snap["best"], snap)
        snap["news_bias"] = news_mod.bias_strip(snap["news"])
        STATE["snapshot"] = snap
        STATE["updated"] = now_ist().strftime("%H:%M:%S")
        STATE["error"] = None
        auto_raise(snap)
    except Exception as exc:                           # noqa: BLE001
        log.exception("scan failed")
        STATE["error"] = f"{type(exc).__name__}: {exc}"


def auto_raise(snap):
    """
    A setup that is only displayed is never measured. Until now a call reached
    the tracker only if somebody pressed a button, so Jackpot Results stayed at
    zero all day while the screen showed ENTRY READY.

    Guards, in order: feed live, market open, risk manager clear, decision not
    WAIT, setup clears its filters, and no open call already on that symbol and
    side today.
    """
    if not config.AUTO_RAISE or snap.get("stale"):
        return
    win = snap.get("window") or {}
    if not win.get("tradable"):
        return
    decision = snap.get("decision") or {}
    if decision.get("side") == "WAIT" or not decision.get("has_setup"):
        return
    if tracker.risk_state()["locked"]:
        return

    top = snap.get("best")
    if not top or top["failed"] or top["score"] < config.AUTO_RAISE_SCORE:
        return

    st, side = top["st"], top["side"]
    open_today = {(c.get("underlying"), c.get("side")) for c in tracker.today_calls()}
    if (st["sym"], side) in open_today:
        return                                   # already tracking this one

    if len([c for c in tracker.today_calls()]) >= config.MAX_CALLS_PER_DAY:
        log.info("daily call cap reached")
        return

    try:
        _raise(top, side, snap, source="auto")
        log.info("auto-raised %s %s at %s", st["sym"], side, top["score"])
    except HTTPException as exc:
        log.info("auto-raise skipped: %s", exc.detail)
    except Exception:                            # noqa: BLE001
        log.exception("auto-raise failed")


def refresh_calls():
    """Repriced every 30s so the state machine and excursion tracker advance."""
    if not client.connected:
        return
    for call in tracker.open_calls():
        token = call.get("underlying") and client.token_for(call["underlying"])
        price = None
        if call["symbol"].endswith(("CE", "PE")):
            row = next((r for r in client.instruments
                        if r.get("symbol") == call["symbol"]), None)
            if row:
                price = client.ltp("NFO", row["symbol"], row["token"])
        elif token:
            price = client.ltp("NSE", f"{call['underlying']}-EQ", token)
        if price is None:
            continue
        updated = tracker.update_tick(call["id"], price)
        if updated.get("transition"):
            notify.status_alert(updated, updated["transition"])


def _warmup():
    """
    Broker login, the 98k-row instrument master and the first 33-second scan
    used to run before the server accepted its first request. On a free
    instance that woke from sleep, the page just spun. Now the app serves
    straight away and reports its own warm-up state.
    """
    STATE["boot"] = "logging in"
    client.login()
    STATE["boot"] = "loading instruments"
    client.load_instruments()
    STATE["boot"] = "first scan"
    refresh_snapshot()
    STATE["boot"] = "ready"


def _boot_ok():
    return BOOT_ERROR is None


@asynccontextmanager
async def lifespan(_: FastAPI):
    if BOOT_ERROR:
        # Start anyway. A process that stays up and explains itself is more
        # useful than one that dies and leaves only "Failed" in the dashboard.
        log.error("starting in degraded mode: %s", BOOT_ERROR["error"])
        yield
        return
    tracker.init()
    STATE["boot"] = "starting"
    threading.Thread(target=_warmup, daemon=True).start()
    scheduler.add_job(refresh_snapshot, "interval", seconds=60, id="scan",
                      max_instances=1, coalesce=True)
    scheduler.add_job(refresh_calls, "interval", seconds=30, id="calls",
                      max_instances=1, coalesce=True)
    scheduler.add_job(client.load_instruments, "cron", hour=8, minute=45, id="scrip")
    scheduler.start()
    log.info("terminal ready")
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="KRT AI Terminal", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# ------------------------------------------------------------------- routes
BOOT_HTML = """<!doctype html><html><head><meta charset="utf-8">
<title>KRT AI - startup failed</title>
<style>body{background:#0A0D14;color:#E8EAF0;font-family:ui-monospace,monospace;padding:28px;
line-height:1.7}h1{font-size:17px;color:#FF4D5E;margin:0 0 4px}.b{color:#FFA033;letter-spacing:.26em;
font-size:10px}pre{background:#12161F;border:1px solid #232A38;border-radius:3px;padding:12px;
white-space:pre-wrap;word-break:break-word;font-size:11px;color:#8A93A6}
.h{color:#FFA033;font-size:12px}</style></head><body>
<div class="b">KRT AI</div><h1>The terminal could not start.</h1>
<p class="h">%s</p><pre>%s</pre><pre>%s</pre>
<p style="color:#8A93A6;font-size:11px">No market data is served while this is showing. Fix the
import and redeploy; nothing here is a signal.</p></body></html>"""


@app.get("/")
def index(request: Request):
    if BOOT_ERROR:
        return HTMLResponse(
            BOOT_HTML % (BOOT_ERROR["hint"], BOOT_ERROR["error"], BOOT_ERROR["trace"]),
            status_code=503)
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/health")
def health():
    if BOOT_ERROR:
        return JSONResponse({"ok": False, "boot_error": BOOT_ERROR}, status_code=503)
    return {
        "ok": True,
        "broker": client.connected,
        "broker_error": client.last_error,
        "instruments": len(client.instruments),
        "last_scan": STATE["updated"],
        "scan_error": STATE["error"],
        "telegram": notify.enabled(),
        "boot": STATE.get("boot"),
        "db": db.check(),
        "calls_today": len(tracker.today_calls()),
        "storage_warning": None if db.persistent() else
            "No persistent database configured - call history is lost on every restart",
        "server_time": now_ist().strftime("%Y-%m-%d %H:%M:%S"),
    }


@app.get("/api/snapshot")
def snapshot():
    snap = STATE["snapshot"]
    if not snap:
        return JSONResponse(
            {"ready": False, "boot": STATE.get("boot"),
             "error": STATE["error"] or client.last_error
             or f"warming up: {STATE.get('boot')}"}, status_code=503)

    def slim(r):
        if not r:
            return None
        return {
            "sym": r["st"]["sym"], "side": r["side"], "sector": r["st"]["sector"],
            "ltp": r["st"]["ltp"], "vwap": r["st"]["vwap"], "atr": r["st"]["atr"],
            "vol_ratio": r["st"]["vol_ratio"], "score": r["score"],
            "tier": engine.classify(r["score"])["tier"],
            "level_count": r["level_count"], "checks": r["checks"],
            "failed": r["failed"], "fake": r["fake"], "legs": r["legs"],
            "confidence": engine.confidence_label(r["score"]),
            "lights": r.get("lights", []),
            "conf": r.get("conf", {}),
            "grade": engine.grade(r["score"]),
            "tier_band": engine.tier(r["score"]),
            "stack": r["st"].get("stack"),
            "ema20": r["st"].get("ema20"), "ema50": r["st"].get("ema50"),
            "ema200": r["st"].get("ema200"),
            "times": r.get("times", {}),
            "levels": {k: r["st"][k] for k in
                       ("pdh", "pdl", "pwh", "pwl", "pmh", "pml")},
            "option": r.get("option"),
            "prev_date": r["st"].get("prev_date"),
            "session_date": r["st"].get("session_date"),
            "session_is_today": bool(r["st"].get("session_is_today")),
            "no_today_candle": bool(r["st"].get("no_today_candle")),
            "quoted": bool(r["st"].get("quoted")),
            "price_source": r["st"].get("price_source"),
            "prev_source": r["st"].get("prev_source"),
            "day_open": r["st"].get("day_open"),
            "day_high": r["st"].get("day_high"),
            "day_low": r["st"].get("day_low"),
        }

    return {
        "ready": True,
        "updated": STATE["updated"],
        "window": snap["window"],
        "indices": snap["indices"],
        "sectors": sorted(({"name": k, "chg": v} for k, v in snap["sectors"].items()),
                          key=lambda s: s["chg"], reverse=True),
        "bias_label": snap["bias_label"], "fear": snap["fear"],
        "commander": snap["commander"], "risk": snap["risk"],
        "accumulation": snap.get("accumulation"),
        "golden": snap.get("golden"),
        "breaks": snap.get("breaks"),
        "gamma": snap.get("gamma"),
        "empty_reason": snap.get("empty_reason"),
        "scan_error": STATE["error"],
        "tokens_resolved": snap.get("tokens_resolved"),
        "instruments_ready": snap.get("instruments_ready"),
        "universe_size": snap.get("universe_size"),
        "top_ce": slim(snap["top_ce"]), "top_pe": slim(snap["top_pe"]),
        "jackpot_ce": [slim(r) for r in snap["jackpot_ce"]],
        "jackpot_pe": [slim(r) for r in snap["jackpot_pe"]],
        "focus": [slim(r) for r in snap["focus"]],
        "read": snap.get("read"),
        "decision": snap.get("decision"),
        "top_ce_watch": snap.get("top_ce_watch"),
        "top_pe_watch": snap.get("top_pe_watch"),
        "side_strength": snap.get("side_strength"),
        "sector_best": snap.get("sector_best", []),
        "attribution": snap.get("attribution", {}),
        "next_session": snap.get("next_session"),
        "pressure": snap.get("pressure"),
        "status": snap.get("status"),
        "top_setups": snap.get("top_setups", []),
        "stale": snap.get("stale", False),
        "feed_counts": {"live": snap.get("fresh_count", 0),
                        "old": snap.get("old_count", 0),
                        "nodata": snap.get("nodata_count", 0)},
        "funnel": snap.get("funnel", []),
        "movers": snap.get("movers", {}),
        "breadth_panel": snap.get("breadth_panel", {}),
        "scanners": snap.get("scanners", {}),
        "near_trigger": snap.get("near_trigger", []),
        "tiers": snap.get("tiers", {}),
        "scan_ms": snap.get("scan_ms"),
        "card": snap.get("card"),
        "jackpot_results": tracker.jackpot_results(),
        "index_setups": {
            k: {"idx": v["idx"],
                "CE": {kk: v["CE"][kk] for kk in ("score", "grade", "checks",
                                                  "failed", "qualified", "side")},
                "PE": {kk: v["PE"][kk] for kk in ("score", "grade", "checks",
                                                  "failed", "qualified", "side")}}
            for k, v in snap.get("index_setups", {}).items()
        },
        "index_radar": snap.get("index_radar", []),
        "index_cards": snap.get("index_cards", []),
        "sector_rows": snap.get("sector_rows", []),
        "breadth": snap.get("breadth", 0),
        "ce_box": [slim(r) for r in snap.get("ce_box", [])],
        "pe_box": [slim(r) for r in snap.get("pe_box", [])],
        "breakout_radar": snap.get("breakout_radar", []),
        "surges": snap.get("surges", []),
        "lead_sector": snap.get("lead_sector"),
        "lead_stocks": [slim(r) for r in snap.get("lead_stocks", [])],
        "news": snap["news"],
        "news_bias": snap.get("news_bias"),
        "health": {
            "broker": client.connected,
            "instruments": len(client.instruments) > 0,
            "news": len(snap["news"]) > 0,
            "scan_error": STATE["error"],
        },
        "scanned": snap["scanned"],
    }


@app.get("/api/chain/{sym}")
def chain(sym: str, side: str = "CE"):
    if not client.connected:
        raise HTTPException(503, "broker not connected")
    snap = STATE["snapshot"] or {}
    spot = next((r["st"]["ltp"] for r in (snap.get("focus") or [])
                 if r["st"]["sym"] == sym.upper()), None)
    if spot is None:
        token = client.token_for(sym)
        spot = client.ltp("NSE", f"{sym.upper()}-EQ", token) if token else None
    if spot is None:
        raise HTTPException(404, f"no spot price for {sym}")

    rows = client.quote_strikes(client.option_chain(sym, kind=side), spot)
    picked = engine.pick_strike(rows, spot, side)
    return {"symbol": sym.upper(), "side": side, "spot": spot,
            "rows": picked["rows"], "best": picked["best"]}


@app.get("/api/calls")
def calls():
    today = tracker.today_calls()
    triggered = [c for c in today if c["triggered"]]
    for c in today:
        c["advice"] = engine.entry_advice(
            c.get("entry"), c.get("ltp"), c.get("sl"), c.get("t1"),
            c.get("zone_high"))
        c["badge"] = engine.call_result_badge(c)
        c["timeline"] = [
            {"k": "Raised", "t": (c.get("created_at") or "")[11:16]},
            {"k": "Detected", "t": c.get("detected_at")},
            {"k": "Confirmed", "t": c.get("confirmed_at")},
            {"k": "Entry hit", "t": c.get("entry_at")},
            {"k": "T1 hit", "t": c.get("t1_at")},
            {"k": "T2 hit", "t": c.get("t2_at")},
            {"k": "T3 hit", "t": c.get("t3_at")},
            {"k": "Closed", "t": c.get("closed_at")},
        ]

    triggered_n = len([c for c in today if c["triggered"]])
    return {
        "funnel": [
            {"stage": "raised", "n": len(today)},
            {"stage": "triggered", "n": triggered_n},
            {"stage": "running", "n": len([c for c in today if c["triggered"] and
                c["status"] not in ("SL HIT", "EXITED", "EXPIRED")])},
            {"stage": "completed", "n": len([c for c in today
                if c["status"] in ("SL HIT", "EXITED", "EXPIRED")])},
        ],
        "open": tracker.open_calls(),
        "today": today,
        "running": [c for c in today if c["triggered"] and
                    c["status"] not in ("SL HIT", "EXITED", "EXPIRED")],
        "completed": [c for c in today if c["status"] in ("SL HIT", "EXITED", "EXPIRED")],
        "missed": [c for c in today if not c["triggered"]],
        "net_pct": round(sum(
            (abs((c["t3"] if c["t3_at"] else c["t2"] if c["t2_at"] else c["t1"]) - c["entry"])
             / c["entry"] * 100) if c["result"] and c["result"] != "SL"
            else -abs(c["entry"] - c["sl"]) / c["entry"] * 100
            for c in today if c["triggered"] and c["result"] and c["entry"]), 2),
        "waiting": len([c for c in today if not c["triggered"]]),
        "untriggered": tracker.untriggered_today(),
        "storage_persistent": db.persistent(),
        "summary": {
            "triggered": len(triggered),
            "t1": sum(1 for c in triggered if c["t1_at"]),
            "t2": sum(1 for c in triggered if c["t2_at"]),
            "t3": sum(1 for c in triggered if c["t3_at"]),
            "sl": sum(1 for c in triggered if c["result"] == "SL"),
        },
        "risk": tracker.risk_state(),
    }


def _raise(top, side, snap, source="manual"):
    """Create one tracked call from a scored setup. Shared by button and engine."""
    st, legs = top["st"], top["legs"]
    rows = client.quote_strikes(client.option_chain(st["sym"], kind=side), st["ltp"])
    picked = engine.pick_strike(rows, st["ltp"], side)
    if not picked["best"]:
        raise HTTPException(409, "no strike passes the liquidity test")

    b = picked["best"]
    prem = engine.premium_legs(b["prem"], b["delta"], st["ltp"], legs, snap["window"])
    zone = engine.entry_zone(b["prem"], b.get("spread", 0))
    times = top.get("times", {})
    call_id = tracker.create_call({
        "symbol": b["symbol"], "underlying": st["sym"], "side": side,
        "tier": engine.classify(top["score"])["tier"], "score": top["score"],
        "confidence": engine.confidence_label(top["score"]),
        "window_key": snap["window"]["key"],
        "jackpot": top["level_count"] >= 2,
        "news_based": bool(snap.get("news")),
        "entry": prem["entry"], "sl": prem["sl"],
        "t1": prem["t1"], "t2": prem["t2"], "t3": prem["t3"],
        "zone_low": zone["low"], "zone_high": zone["high"],
        "spot_entry": st["ltp"],
        "detected_at": times.get("detected"),
        "confirmed_at": times.get("confirmed"),
        "released_at": times.get("released"),
        "why": f"{top['level_count']}-level break, {st['vol_ratio']}x volume, "
               f"{st['sector']} aligned",
    })
    notify.call_alert({"id": call_id, "symbol": b["symbol"],
                       "tier": engine.classify(top["score"])["tier"],
                       "score": top["score"], **prem,
                       "why": f"{top['level_count']}-level break"})
    return {"id": call_id, "symbol": b["symbol"], "source": source, **prem}


@app.post("/api/calls")
def raise_call(side: str = "CE"):
    """Manual raise from the button. Same guards as the automatic path."""
    snap = STATE["snapshot"]
    if not snap:
        raise HTTPException(503, "no snapshot yet")
    if tracker.risk_state()["locked"]:
        raise HTTPException(423, "risk manager has locked the terminal")
    top = snap["top_ce"] if side == "CE" else snap["top_pe"]
    if not top:
        raise HTTPException(409, f"no qualifying {side} setup right now")
    return _raise(top, side, snap, source="manual")


@app.get("/api/diagnostics")
def diagnostics():
    """Every subsystem, stated plainly. A silent failure is the worst kind."""
    snap = STATE["snapshot"] or {}
    _dbcheck = db.check()
    last = STATE["updated"]
    age = None
    if last:
        try:
            h, m, sec = (int(x) for x in last.split(":"))
            now = now_ist()
            age = (now.hour * 3600 + now.minute * 60 + now.second) - (h * 3600 + m * 60 + sec)
        except ValueError:
            age = None
    return {
        "subsystems": [
            {"name": "Broker session", "ok": client.connected,
             "detail": client.last_error or "authenticated"},
            {"name": "Instrument master", "ok": len(client.instruments) > 0,
             "detail": f"{len(client.instruments)} contracts"},
            {"name": "Spot feed", "ok": not snap.get("stale", True),
             "detail": "live candles" if not snap.get("stale", True)
                       else "previous session - not live"},
            {"name": "Scanner loop", "ok": age is not None and age < 180,
             "detail": f"last run {age}s ago" if age is not None else "never run"},
            {"name": "News feed", "ok": len(snap.get("news", [])) > 0,
             "detail": f"{len(snap.get('news', []))} headlines"},
            {"name": "Database", "ok": _dbcheck["ok"] and _dbcheck["persistent"],
             "detail": _dbcheck["detail"]},
            {"name": "Warm-up", "ok": STATE.get("boot") == "ready",
             "detail": STATE.get("boot", "unknown")},
            {"name": "IST clock", "ok": True,
             "detail": now_ist().strftime("%H:%M:%S")},
            {"name": "Market session", "ok": (snap.get("window") or {}).get("tradable", False),
             "detail": (snap.get("window") or {}).get("label", "unknown")},
        ],
        "last_run": {
            "scanned": snap.get("scanned", 0),
            "fresh": snap.get("fresh_count", 0),
            "ms": snap.get("scan_ms"),
            "universe": len(config.UNIVERSE),
            "error": STATE["error"],
        },
    }


@app.get("/api/accuracy")
def accuracy(last: int = 50):
    return {
        "overall": tracker.accuracy(last),
        "expectancy": tracker.expectancy(last),
        "segments": tracker.segments(last),
        "untriggered_today": tracker.untriggered_today(),
        "note": ("Every figure is counted from triggered calls in this sample. "
                 "Calls that never filled are excluded from the denominator."),
    }

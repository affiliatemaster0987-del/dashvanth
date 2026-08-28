"""
The decision engine. Pure functions only - no network, no state.

Rules that are deliberately hard-coded and never relaxed:
  * A mandatory check that fails kills the call, whatever the score says.
  * A level that is touched but not closed beyond is a fakeout, not a signal.
  * Targets come from ATR and structure, never from a fixed point count.
  * Confidence is a score out of 100, not an accuracy claim.
"""
from datetime import time as dtime

# ------------------------------------------------------------------ windows
WINDOWS = [
    (555, "OPEN",   "OPENING RISK",    "9:15-9:30 - no fresh entry",       0.0, False),
    (690, "PRIME",  "PRIME WINDOW",    "9:30-11:30 - best liquidity",      1.0, True),
    (810, "LOW",    "LOW MOMENTUM",    "11:30-1:30 - theta zone",          0.65, True),
    (915, "SECOND", "SECOND WINDOW",   "1:30-3:15 - trend resumption",     0.85, True),
    (930, "CLOSE",  "NO FRESH TRADE",  "after 3:15 - manage only",         0.0, False),
]


def time_window(minutes: int) -> dict:
    if minutes < 555:
        return {"key": "PRE", "label": "PRE-OPEN", "note": "market closed",
                "mult": 0.0, "tradable": False}
    for end, key, label, note, mult, tradable in WINDOWS:
        if minutes < end:
            return {"key": key, "label": label, "note": note,
                    "mult": mult, "tradable": tradable}
    return {"key": "CLOSE", "label": "MARKET CLOSED", "note": "session over",
            "mult": 0.0, "tradable": False}


# ------------------------------------------------------------------ scoring
WEIGHTS = {
    "LEVEL": 16, "VOLUME": 14, "VWAP": 12, "MARKET": 12, "STRUCTURE": 10,
    "SECTOR": 10, "LIQUIDITY": 8, "OI CHAIN": 8, "NEWS": 6, "TIME": 4,
}
# Four vetoes, not seven. LEVEL and VWAP define the setup, TIME keeps the
# terminal out of the noise windows, and NEWS stops trading into a headline
# pointing the other way. MARKET, SECTOR and VOLUME still carry 36 points
# between them - they lower the score rather than silently killing the call.
MANDATORY = {"LEVEL", "VWAP", "TIME", "NEWS"}

TIERS = [(90, "JACKPOT"), (80, "STRONG"), (70, "GOOD"), (60, "WATCHLIST")]


def tier(score: int) -> str:
    for floor, name in TIERS:
        if score >= floor:
            return name
    return "IGNORE"


def blocking_reason(res: dict) -> str:
    """The single thing standing between this setup and a call."""
    if res["failed"]:
        note = next((c["note"] for c in res["checks"] if c["k"] == res["failed"][0]), "")
        return f"{res['failed'][0]} — {note}"
    missing = [c for c in res["checks"] if not c["ok"]]
    if not missing:
        return "score below threshold"
    worst = max(missing, key=lambda c: WEIGHTS[c["k"]])
    return f"{worst['k']} — {worst['note']}"


def score_setup(st: dict, side: str, ctx: dict) -> dict:
    """
    st  - one stock snapshot: ltp, prev, vwap, pdh/pdl/pwh/pwl/pmh/pml,
          vol_ratio, atr, sector, closed_beyond, follow_through
    ctx - market context: bias (-4..4), bias_label, sectors {name: pct},
          news {symbol: tag}, win (from time_window)
    """
    up = side == "CE"
    if up:
        levels = [st["ltp"] > st["pdh"], st["ltp"] > st["pwh"], st["ltp"] > st["pmh"]]
    else:
        levels = [st["ltp"] < st["pdl"], st["ltp"] < st["pwl"], st["ltp"] < st["pml"]]
    level_count = sum(1 for x in levels if x)

    vol = st.get("vol_ratio")          # None when the feed is stale
    sec_chg = ctx["sectors"].get(st["sector"], 0.0)
    news_tag = ctx["news"].get(st["sym"])
    news_bad = bool(news_tag) and (
        (up and news_tag == "NEG") or (not up and news_tag in ("POS", "HIGH"))
    )

    # Partial credit matters. A one-level break on 1.5x volume is not the same
    # setup as a day+week+month break on 3x, and scoring them identically is
    # what made every candidate come out at exactly 100.
    level_pts = {0: 0, 1: 9, 2: 13, 3: 16}[level_count]
    vol_pts = 0 if not vol else 14 if vol >= 2.5 else 11 if vol >= 1.8 else \
        8 if vol >= 1.5 else 0

    checks = [
        {"k": "LEVEL", "ok": level_count > 0, "pts": level_pts,
         "note": "D+W+M break" if level_count == 3 else f"{level_count} level break"},
        {"k": "VOLUME", "ok": bool(vol) and vol >= 1.5, "pts": vol_pts,
         "note": f"{vol:.2f}x avg" if vol else "no live volume"},
        {"k": "VWAP", "ok": (st["ltp"] > st["vwap"]) if up else (st["ltp"] < st["vwap"]),
         "note": "above VWAP" if up else "below VWAP"},
        {"k": "MARKET", "ok": ctx["bias"] > 0 if up else ctx["bias"] < 0,
         "note": ctx["bias_label"]},
        {"k": "STRUCTURE", "ok": (st["ltp"] > st["prev"]) if up else (st["ltp"] < st["prev"]),
         "note": "higher structure" if up else "lower structure"},
        {"k": "SECTOR", "ok": sec_chg > 0.2 if up else sec_chg < -0.2,
         "note": f"{st['sector']} {sec_chg:+.2f}%"},
        {"k": "LIQUIDITY", "ok": bool(vol) and vol >= 1.0, "note": "tradable volume"},
        {"k": "OI CHAIN", "ok": level_count > 0 and bool(vol) and vol >= 1.3,
         "note": "chain supports" if level_count else "chain flat"},
        {"k": "NEWS", "ok": not news_bad,
         "note": "opposite news" if news_bad else (news_tag or "no conflict")},
        {"k": "TIME", "ok": ctx["win"]["tradable"], "note": ctx["win"]["label"]},
    ]

    score = sum(c.get("pts", WEIGHTS[c["k"]]) for c in checks if c["ok"])
    score = round(score * (0.75 + 0.25 * ctx["win"]["mult"]))

    failed = [c["k"] for c in checks if c["k"] in MANDATORY and not c["ok"]]
    return {
        "score": score, "checks": checks, "failed": failed,
        "level_count": level_count, "sector_chg": sec_chg, "news": news_tag,
    }


def classify(score: int) -> dict:
    if score >= 90:
        return {"tier": "ELITE CALL", "mark": "ELITE"}
    if score >= 82:
        return {"tier": "STRONG CALL", "mark": "STRONG"}
    return {"tier": "WATCHLIST", "mark": "WATCH"}


def confidence_label(score: int) -> str:
    """
    A label for how many confirmations lined up - NOT a probability of profit.
    Capped at ELITE on purpose: no wording that implies a sure thing.
    """
    if score >= 90:
        return "ELITE"
    if score >= 82:
        return "STRONG"
    if score >= 70:
        return "WATCH ONLY"
    return "RISKY"


def entry_zone(prem: float, spread: float = 0.0) -> dict:
    """
    Premium band. 4% of a twenty-rupee option is under a rupee - the right
    size for an option fill.
    """
    pad = max(prem * 0.04, spread * 1.5, 0.25)
    return {"low": round(max(0.5, prem - pad), 2), "high": round(prem + pad, 2)}


def spot_zone(ltp: float, atr: float) -> dict:
    """
    Spot band, sized from ATR - NOT from a percentage of price. Reusing the
    option rule here gave AXISBANK at 1233 a hundred-rupee-wide "entry zone",
    which is not a zone, it is the whole day's range.
    """
    pad = max(atr * 0.15, ltp * 0.0015)
    return {"low": round(ltp - pad, 2), "high": round(ltp + pad, 2)}


def in_zone(ltp: float, zone: dict) -> bool:
    return bool(zone) and zone["low"] <= ltp <= zone["high"]


def option_choices(rows: list, spot: float, side: str) -> dict:
    """
    Three strikes for three appetites, picked from what is actually liquid.
    Safe = closest to the money. Aggressive and high risk step further OTM,
    and are only offered when they still pass the spread test.
    """
    picked = pick_strike(rows, spot, side)
    tradable = [r for r in picked["rows"] if r["tradable"]]
    if not tradable:
        return {"safe": None, "aggressive": None, "high_risk": None}

    out_of_money = sorted(
        tradable,
        key=lambda r: (r["strike"] - spot) if side == "CE" else (spot - r["strike"]),
    )
    safe = min(tradable, key=lambda r: abs(r["strike"] - spot))
    if side == "CE":
        further = [r for r in out_of_money if r["strike"] > safe["strike"]]
    else:
        further = [r for r in out_of_money if r["strike"] < safe["strike"]]

    def wrap(row, label):
        if not row:
            return None
        return {
            "label": label, "strike": row["strike"], "symbol": row.get("symbol"),
            "prem": row["prem"], "delta": row["delta"],
            "spread_pct": row["spread_pct"],
            "zone": entry_zone(row["prem"], row.get("spread", 0)),
        }

    return {
        "safe": wrap(safe, "SAFE"),
        "aggressive": wrap(further[0] if further else None, "AGGRESSIVE"),
        "high_risk": wrap(further[1] if len(further) > 1 else None, "HIGH RISK"),
    }


def trade_plan(win: dict, capped: bool) -> list:
    """What to actually do once filled. The same discipline every time."""
    plan = [
        "Enter only inside the premium zone - do not chase above it",
        "Book 30% at T1, then move stop to entry",
        "Book 40% at T2, trail the rest to T1",
    ]
    plan.append("Hold the last 30% for T3" if not capped
                else "Close the last 30% at T2 - T3 is unlikely in this window")
    plan.append("Stop broken: exit fully, no averaging")
    if win["key"] in ("LOW", "SECOND"):
        plan.append("Theta is heavy now - take partials earlier than usual")
    return plan


SCORE_GROUPS = {
    "Price action": ["LEVEL", "STRUCTURE"],
    "Volume": ["VOLUME"],
    "VWAP": ["VWAP"],
    "Sector": ["SECTOR"],
    "Market": ["MARKET"],
    "News": ["NEWS"],
    "Option quality": ["LIQUIDITY", "OI CHAIN"],
    "Timing": ["TIME"],
}


def score_breakdown(checks: list) -> list:
    """Show how the score was earned, not just the total."""
    by_key = {c["k"]: c for c in checks}
    out = []
    for group, keys in SCORE_GROUPS.items():
        got = sum(WEIGHTS[k] for k in keys if by_key.get(k, {}).get("ok"))
        total = sum(WEIGHTS[k] for k in keys)
        out.append({"group": group, "got": got, "max": total,
                    "ok": got == total})
    return out


# ------------------------------------------------------- multi-timeframe --
def ema(values: list, period: int):
    """Standard EMA. Returns None when there is not enough history."""
    if not values or len(values) < period:
        return None
    k = 2 / (period + 1)
    out = sum(values[:period]) / period
    for v in values[period:]:
        out = v * k + out * (1 - k)
    return round(out, 2)


def trend_stack(ltp: float, e20, e50, e200) -> dict:
    """Where price sits in the moving-average stack."""
    have = [e for e in (e20, e50, e200) if e]
    if not have:
        return {"label": "NO DATA", "score": 0, "above": 0}
    above = sum(1 for e in have if ltp > e)
    if above == len(have) and (not e20 or not e50 or e20 >= e50):
        return {"label": "STACKED UP", "score": 2, "above": above}
    if above == 0:
        return {"label": "STACKED DOWN", "score": -2, "above": above}
    return {"label": "MIXED", "score": 0, "above": above}


# ------------------------------------------------------- breakout radar ---
def near_breakout(st: dict, side: str, max_pct: float = 1.2) -> dict | None:
    """
    The level price has NOT taken out yet, and how far away it is.

    A watch, not a trade. Touching the level is not breaking it - the entry
    only activates once fakeout_filter clears too.
    """
    up = side == "CE"
    keys = ("pdh", "pwh", "pmh") if up else ("pdl", "pwl", "pml")
    names = {"pdh": "PREV DAY HIGH", "pwh": "PREV WEEK HIGH", "pmh": "PREV MONTH HIGH",
             "pdl": "PREV DAY LOW", "pwl": "PREV WEEK LOW", "pml": "PREV MONTH LOW"}

    pending = []
    for k in keys:
        lvl = st.get(k)
        if not lvl:
            continue
        untaken = (st["ltp"] < lvl) if up else (st["ltp"] > lvl)
        if not untaken:
            continue
        dist = abs(lvl - st["ltp"]) / st["ltp"] * 100
        if dist <= max_pct:
            pending.append({"key": k, "name": names[k], "level": round(lvl, 2),
                            "distance": round(dist, 2)})
    if not pending:
        return None
    vol = st.get("vol_ratio")
    nearest = min(pending, key=lambda p: p["distance"])
    vwap_ok = (st["ltp"] > st["vwap"]) if up else (st["ltp"] < st["vwap"])
    return {
        **nearest, "side": side, "ltp": st["ltp"],
        "pending": len(pending),
        "vwap_ok": vwap_ok,
        "vol_ratio": vol,
        "volume_building": bool(vol) and vol >= 1.2,
        # never ARMED without live volume to back it
        "armed": bool(vol) and vol >= 1.2 and vwap_ok,
    }


def abnormal_move(st: dict, window_pct: float, minutes: int) -> dict | None:
    """
    Crash / surge detector. A fast move on heavy volume is either an
    opportunity or a trap - it gets flagged, never auto-traded.
    """
    vol = st.get("vol_ratio")
    if abs(window_pct) < 2.5 or not vol or vol < 2.0:
        return None
    down = window_pct < 0
    return {
        "sym": st["sym"], "kind": "CRASH" if down else "SURGE",
        "pct": round(window_pct, 2), "minutes": minutes,
        "vol_ratio": vol,
        "vwap_lost": st["ltp"] < st["vwap"] if down else st["ltp"] > st["vwap"],
        "level_broken": (st["ltp"] < st["pdl"]) if down else (st["ltp"] > st["pdh"]),
        "side": "PE" if down else "CE",
    }


# ------------------------------------------------------- index scoring ----
INDEX_WEIGHTS = {
    "LEVEL": 18, "VWAP": 16, "TREND": 14, "BREADTH": 14,
    "VOLATILITY": 10, "MOMENTUM": 12, "SECTOR": 10, "TIME": 6,
}
INDEX_MANDATORY = {"LEVEL", "VWAP", "TIME"}


def score_index(idx: dict, side: str, ctx: dict) -> dict:
    """
    Indices need their own scorer. There is no sector to lean on and no
    single-stock volume, so breadth and volatility carry the weight instead.
    """
    up = side == "CE"
    levels = ([idx["ltp"] > idx["pdh"], idx["ltp"] > idx["pwh"]] if up
              else [idx["ltp"] < idx["pdl"], idx["ltp"] < idx["pwl"]])
    level_count = sum(1 for x in levels if x)
    stack = idx.get("stack", {"score": 0, "label": "NO DATA"})
    breadth = ctx["breadth"]           # green sectors minus red
    vix = ctx.get("vix", 14)

    checks = [
        {"k": "LEVEL", "ok": level_count > 0,
         "note": "day+week break" if level_count == 2 else f"{level_count} level break"},
        {"k": "VWAP", "ok": (idx["ltp"] > idx["vwap"]) if up else (idx["ltp"] < idx["vwap"]),
         "note": "above VWAP" if up else "below VWAP"},
        {"k": "TREND", "ok": (stack["score"] > 0) if up else (stack["score"] < 0),
         "note": stack["label"]},
        {"k": "BREADTH", "ok": breadth > 0 if up else breadth < 0,
         "note": f"{breadth:+d} sector breadth"},
        {"k": "VOLATILITY", "ok": vix < 16,
         "note": f"VIX {vix}" + (" elevated" if vix >= 16 else " normal")},
        {"k": "MOMENTUM", "ok": (idx["chg"] > 0.15) if up else (idx["chg"] < -0.15),
         "note": f"{idx['chg']:+.2f}% on day"},
        {"k": "SECTOR", "ok": ctx["bias_label"] == ("BULLISH" if up else "BEARISH"),
         "note": ctx["bias_label"]},
        {"k": "TIME", "ok": ctx["win"]["tradable"], "note": ctx["win"]["label"]},
    ]

    score = sum(INDEX_WEIGHTS[c["k"]] for c in checks if c["ok"])
    score = round(score * (0.75 + 0.25 * ctx["win"]["mult"]))
    failed = [c["k"] for c in checks if c["k"] in INDEX_MANDATORY and not c["ok"]]
    return {"score": score, "checks": checks, "failed": failed,
            "level_count": level_count}


# ------------------------------------------------- confirmation counting --
CONFIRMATIONS = [
    ("PDH/PDL", lambda st, up: st["ltp"] > st["pdh"] if up else st["ltp"] < st["pdl"]),
    ("PWH/PWL", lambda st, up: st["ltp"] > st["pwh"] if up else st["ltp"] < st["pwl"]),
    ("PMH/PML", lambda st, up: st["ltp"] > st["pmh"] if up else st["ltp"] < st["pml"]),
    ("VWAP",    lambda st, up: st["ltp"] > st["vwap"] if up else st["ltp"] < st["vwap"]),
    ("OPENING RANGE", lambda st, up: (st.get("orh") and st["ltp"] > st["orh"]) if up
                                     else (st.get("orl") and st["ltp"] < st["orl"])),
    ("EMA STACK", lambda st, up: (st.get("stack", {}).get("score", 0) > 0) if up
                                 else (st.get("stack", {}).get("score", 0) < 0)),
    ("VOLUME", lambda st, up: bool(st.get("vol_ratio")) and st["vol_ratio"] >= 1.5),
]


def confirmations(st: dict, side: str) -> dict:
    """
    How many independent things agree, as a plain x-of-7. One confirmation is
    a coincidence; six is a setup.
    """
    up = side == "CE"
    hits = []
    for name, test in CONFIRMATIONS:
        try:
            ok = bool(test(st, up))
        except (KeyError, TypeError):
            ok = False
        hits.append({"name": name, "ok": ok})
    n = sum(1 for h in hits if h["ok"])
    return {"hits": hits, "count": n, "total": len(CONFIRMATIONS),
            "label": f"{n}/{len(CONFIRMATIONS)}",
            "strength": "STRONG" if n >= 5 else "MODERATE" if n >= 3 else "WEAK"}


# ------------------------------------------------------- signal lights ----
def signal_lights(st: dict, side: str) -> list:
    """
    At-a-glance lamps. Each one is a plain observation, never a claim about
    who is doing the buying - the terminal cannot see that, and pretending
    otherwise is how a scanner starts lying.
    """
    up = side == "CE"
    vol = st.get("vol_ratio")
    stack = st.get("stack", {}).get("score", 0)
    vwap_ok = (st["ltp"] > st["vwap"]) if up else (st["ltp"] < st["vwap"])
    level_ok = (st["ltp"] > st["pdh"]) if up else (st["ltp"] < st["pdl"])
    lights = []

    if vol and vol >= 3.0:
        lights.append({"key": "VOLUME", "colour": "green", "label": f"HEAVY VOLUME {vol:.1f}x",
                       "note": "three times the twenty-day average"})
    elif vol and vol >= 1.8:
        lights.append({"key": "VOLUME", "colour": "amber", "label": f"VOLUME {vol:.1f}x",
                       "note": "above average, not extreme"})

    # "Smart money" is a SIGNAL, not a fact. Four things have to line up:
    # heavy volume, the right side of VWAP, a level taken out, and the
    # moving-average stack agreeing.
    if vol and vol >= 2.5 and vwap_ok and level_ok and (stack > 0 if up else stack < 0):
        lights.append({
            "key": "ACCUMULATION", "colour": "blue",
            "label": "ACCUMULATION SIGNAL" if up else "DISTRIBUTION SIGNAL",
            "note": "heavy volume with VWAP, level and trend all agreeing - "
                    "a footprint, not proof of institutional buying"})

    if st.get("news_tag") in ("HIGH", "POS", "NEG"):
        lights.append({"key": "NEWS", "colour": "purple",
                       "label": f"NEWS {st['news_tag']}", "note": "headline in play"})

    if vol and vol >= 2.0 and not vwap_ok:
        lights.append({"key": "CONFLICT", "colour": "red", "label": "VOLUME AGAINST",
                       "note": "heavy volume on the wrong side of VWAP"})
    return lights


def market_read(bias_label, fear, breadth, vix, win, best) -> dict:
    """
    The commander in one plain sentence a tired person can act on, plus a
    fear/greed position. No jargon, no stacked clauses.
    """
    if fear >= 70:
        mood, mood_note = "FEARFUL", "sellers in control"
    elif fear >= 55:
        mood, mood_note = "CAUTIOUS", "buyers hesitant"
    elif fear >= 45:
        mood, mood_note = "BALANCED", "neither side committed"
    elif fear >= 30:
        mood, mood_note = "CONFIDENT", "buyers in control"
    else:
        mood, mood_note = "GREEDY", "buyers aggressive"

    if not win["tradable"]:
        simple = "Market is not in a tradable window. Manage what is open, start nothing."
    elif bias_label == "BULLISH":
        simple = "Market is going up. Buy CE only. Do not fight it with PE."
    elif bias_label == "BEARISH":
        simple = "Market is going down. Buy PE only. Do not fight it with CE."
    else:
        simple = "Market has no direction. Half size, or sit out until one side wins."

    if best:
        simple += f" Best name right now: {best['st']['sym']} {best['side']}."

    return {
        "mood": mood, "mood_note": mood_note, "fear": fear,
        "greed": 100 - fear, "simple": simple,
        "breadth": breadth, "vix": vix,
        "side": "CE" if bias_label == "BULLISH" else "PE" if bias_label == "BEARISH" else "WAIT",
    }


# ------------------------------------------------ CE / PE / WAIT decision --
def decide_side(ce_score: int, pe_score: int, edge_min: int = 12,
                floor: int = 75) -> dict:
    """
    One answer, never two. The terminal must not show a CE idea and a PE idea
    at the same time and leave the trader to choose - that is the moment a
    scanner stops being useful.

    WAIT unless the winning side clears the floor AND beats the other by a
    real margin. A 55/51 split is noise, not an edge.
    """
    lead, lag = max(ce_score, pe_score), min(ce_score, pe_score)
    side = "CE" if ce_score > pe_score else "PE" if pe_score > ce_score else "WAIT"
    edge = lead - lag

    if lead < floor:
        return {"side": "WAIT", "ce": ce_score, "pe": pe_score, "edge": edge,
                "reason": f"Best side only scores {lead}. Nothing clears {floor}.",
                "confidence": lead}
    if edge < edge_min:
        return {"side": "WAIT", "ce": ce_score, "pe": pe_score, "edge": edge,
                "reason": f"CE {ce_score} against PE {pe_score} - only {edge} points "
                          "apart. No directional advantage.",
                "confidence": lead}
    return {"side": side, "ce": ce_score, "pe": pe_score, "edge": edge,
            "reason": f"{side} leads by {edge} points.", "confidence": lead}


def pressure(stocks) -> dict:
    """
    Buyers versus sellers, from what the whole universe is doing rather than
    from one index print. Structure, VWAP and volume each get a vote.
    """
    buy = sell = 0.0
    for st in stocks:
        w = 1.0
        vol = st.get("vol_ratio")
        if vol and vol >= 1.5:
            w = 1.6                    # heavier names carry more weight
        up = st["ltp"] > st["prev"]
        above = st["ltp"] > st["vwap"]
        score = (1 if up else -1) + (1 if above else -1)
        stack = st.get("stack", {}).get("score", 0)
        score += 1 if stack > 0 else -1 if stack < 0 else 0
        if score > 0:
            buy += w * score
        else:
            sell += w * abs(score)
    total = buy + sell or 1
    b = round(buy / total * 100)
    return {"buyers": b, "sellers": 100 - b,
            "control": "BUYERS" if b >= 58 else "SELLERS" if b <= 42 else "BALANCED"}


def why_side(res: dict, side: str) -> dict:
    """The score, itemised. Positives and negatives, so it can be argued with."""
    plus, minus = [], []
    for c in res["checks"]:
        w = c.get("pts", WEIGHTS[c["k"]]) if c["ok"] else WEIGHTS[c["k"]]
        (plus if c["ok"] else minus).append(
            {"k": c["k"], "pts": w if c["ok"] else -w, "note": c["note"]})
    plus.sort(key=lambda x: -x["pts"])
    minus.sort(key=lambda x: x["pts"])
    return {"side": side, "plus": plus, "minus": minus, "total": res["score"]}


def rotation_status(chg: float, rs: float, participation: int) -> str:
    """Leading / improving / weakening / lagging, the four-quadrant read."""
    strong_now = chg > 0.3
    beating = rs > 0
    if strong_now and beating and participation >= 60:
        return "LEADING"
    if beating and not strong_now:
        return "IMPROVING"
    if strong_now and not beating:
        return "WEAKENING"
    return "LAGGING"


def market_status(minutes: int) -> dict:
    """Plain session status with a countdown, instead of a bare NOT LIVE chip."""
    def hhmm(m):
        m = max(0, int(m))
        return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{m}m"

    if minutes < 540:
        return {"state": "CLOSED", "label": "MARKET CLOSED",
                "detail": f"Pre-open begins in {hhmm(540 - minutes)}", "live": False}
    if minutes < 555:
        return {"state": "PRE-OPEN", "label": "PRE-OPEN",
                "detail": f"Opens in {hhmm(555 - minutes)}", "live": False}
    if minutes <= 930:
        return {"state": "LIVE", "label": "MARKET LIVE",
                "detail": f"Closes in {hhmm(930 - minutes)}", "live": True}
    return {"state": "CLOSED", "label": "MARKET CLOSED",
            "detail": "Next session 9:15 AM", "live": False}


# --------------------------------------------------- support / resistance --
def sr_levels(st: dict) -> dict:
    """
    Every level the setup actually rests on, sorted around the current price.
    Nothing invented - these are the same PDH/PDL/PWH/PWL/PMH/PML/VWAP/ORB
    values the score was built from, just presented as S1/S2/R1/R2.
    """
    ltp = st["ltp"]
    pool = []
    for key, name in (("pdh", "PDH"), ("pdl", "PDL"), ("pwh", "PWH"),
                      ("pwl", "PWL"), ("pmh", "PMH"), ("pml", "PML"),
                      ("vwap", "VWAP"), ("orh", "ORB HIGH"), ("orl", "ORB LOW")):
        v = st.get(key)
        if v:
            pool.append({"name": name, "level": round(v, 2)})

    below = sorted([p for p in pool if p["level"] < ltp],
                   key=lambda p: -p["level"])
    above = sorted([p for p in pool if p["level"] > ltp],
                   key=lambda p: p["level"])
    return {
        "s1": below[0] if below else None,
        "s2": below[1] if len(below) > 1 else None,
        "r1": above[0] if above else None,
        "r2": above[1] if len(above) > 1 else None,
        "bullish_above": above[0]["level"] if above else None,
        "bearish_below": below[0]["level"] if below else None,
    }


def rise_fall_reasons(res: dict, side: str, st: dict) -> dict:
    """
    "Why can this rise / fall" in probability language. Never a promise -
    the terminal reports what lines up, and what is still missing.
    """
    passed = [c for c in res["checks"] if c["ok"]]
    missing = [c for c in res["checks"] if not c["ok"]]
    up = side == "CE"
    verdict = (
        "Bullish continuation is the higher-probability path while the break holds."
        if up else
        "Bearish continuation is the higher-probability path while the breakdown holds."
    )
    if missing:
        verdict += (f" {len(missing)} confirmation"
                    f"{'s are' if len(missing) > 1 else ' is'} still missing, so "
                    "treat it as pending until they clear.")
    return {
        "question": "Why can this rise?" if up else "Why can this fall?",
        "for": [f"{c['k']} - {c['note']}" for c in passed],
        "against": [f"{c['k']} - {c['note']}" for c in missing],
        "verdict": verdict,
    }


def watch_card(r, chain_best=None) -> dict:
    """
    The always-visible CE / PE watch entry. Shown even when the decision is
    WAIT, because "WAIT" with nothing beside it tells a trader nothing about
    what to keep an eye on.
    """
    st, side = r["st"], r["side"]
    missing = [c["k"] for c in r["checks"] if not c["ok"]]
    return {
        "sym": st["sym"], "side": side, "sector": st["sector"],
        "score": r["score"], "tier": tier(r["score"]),
        "confidence": confidence_label(r["score"]),
        "ltp": st["ltp"], "vwap": st["vwap"],
        "vol_ratio": st.get("vol_ratio"),
        "legs": r["legs"], "sr": sr_levels(st),
        "conf": r.get("conf", {}),
        "strike": chain_best,
        "triggers_needed": missing or ["none - all confirmations in place"],
        "status": ("READY" if not r["failed"] and r["score"] >= 82
                   else "NEAR" if r["score"] >= 70 else "WATCHING"),
        "action": ("Entry valid once price holds the trigger."
                   if not r["failed"] and r["score"] >= 82
                   else f"WATCH ONLY - do not enter until {', '.join(missing[:2])} clears."),
        "why": rise_fall_reasons(r, side, st),
        "lights": r.get("lights", []),
    }


def side_strength(ce: int, pe: int) -> dict:
    """CE vs PE as two bars that always sum to 100 - the dominant side is obvious."""
    total = ce + pe or 1
    c = round(ce / total * 100)
    return {"ce": c, "pe": 100 - c, "ce_raw": ce, "pe_raw": pe,
            "dominant": "CE" if c > 55 else "PE" if c < 45 else "NEITHER"}


# --------------------------------------------------------- entry advice --
def entry_advice(entry, ltp, sl, t1, zone_high=None) -> dict:
    """
    Answer the only question that matters on a running call: can I still get
    in, or has it already gone? Chasing a call that has run half way to T1 is
    how a good signal becomes a bad trade.
    """
    if not entry or not ltp:
        return {"verdict": "NO DATA", "tone": "muted", "note": "No live price."}

    move = (ltp - entry) / entry * 100
    to_t1 = ((t1 - ltp) / ltp * 100) if t1 and ltp else 0
    ceiling = zone_high or entry * 1.04

    if ltp <= sl:
        return {"verdict": "STOPPED", "tone": "bear",
                "note": "Stop is broken. Do not re-enter on this signal."}
    if ltp <= ceiling:
        return {"verdict": "ENTER NOW", "tone": "bull",
                "note": f"Still inside the entry zone, {move:+.1f}% from the "
                        f"call price. Risk to stop is intact."}
    if move < 15:
        return {"verdict": "ENTER SMALL", "tone": "gold",
                "note": f"Already {move:+.1f}% above the zone. Half size at most, "
                        f"and the stop is now further away than planned."}
    if to_t1 > 8:
        return {"verdict": "WAIT FOR PULLBACK", "tone": "gold",
                "note": f"Up {move:+.1f}% - extended. Wait for a retest rather "
                        "than chasing."}
    return {"verdict": "TOO LATE", "tone": "bear",
            "note": f"Up {move:+.1f}% and only {to_t1:.1f}% from T1. The "
                    "reward left does not justify the stop distance."}


def call_result_badge(call) -> dict:
    """JACKPOT PASS when the full ladder is taken. Anything less says so plainly."""
    if call.get("t3_at"):
        return {"label": "JACKPOT PASS", "tone": "gold", "blink": True}
    if call.get("t2_at"):
        return {"label": "T2 HIT", "tone": "bull", "blink": True}
    if call.get("t1_at"):
        return {"label": "T1 HIT", "tone": "bull", "blink": False}
    if call.get("result") == "SL":
        return {"label": "SL HIT", "tone": "bear", "blink": True}
    if call.get("triggered"):
        return {"label": "RUNNING", "tone": "cool", "blink": False}
    return {"label": "WAITING", "tone": "muted", "blink": False}


def alert_level(score, conf_count, lights) -> str:
    """
    What the row should do visually. JACKPOT blinks green, DANGER blinks red,
    everything else stays still - if everything blinks, nothing is urgent.
    """
    kinds = {l["key"] for l in (lights or [])}
    if score >= 95 and conf_count >= 6:
        return "JACKPOT"
    if "ACCUMULATION" in kinds and score >= 88:
        return "INSTITUTIONAL"
    if "CONFLICT" in kinds:
        return "DANGER"
    if score >= 85:
        return "STRONG"
    return "NORMAL"


def grade(score: int) -> str:
    """Letter grade for the radar - blunter than a number at a glance."""
    if score >= 90:
        return "A+"
    if score >= 82:
        return "A"
    if score >= 74:
        return "B+"
    if score >= 65:
        return "B"
    return "WAIT"


# ----------------------------------------------------------------- fakeouts
def fakeout_filter(st: dict) -> dict:
    if not st.get("closed_beyond"):
        return {"ok": False, "msg": "FAKEOUT RISK - no candle close beyond level"}
    if not st.get("follow_through"):
        return {"ok": False, "msg": "FAKEOUT RISK - no follow-through / retest pending"}
    return {"ok": True, "msg": "Break confirmed: close + follow-through"}


# ------------------------------------------------------------------ targets
def target_engine(st: dict, side: str, win: dict) -> dict:
    """ATR-based ladder, trimmed automatically outside the prime window."""
    up = side == "CE"
    atr = max(st["atr"], st["ltp"] * 0.004)
    mult = {"PRIME": (0.6, 1.15, 1.9), "LOW": (0.5, 0.9, 1.3),
            "SECOND": (0.55, 1.0, 1.5)}.get(win["key"], (0.55, 1.0, 1.5))

    sign = 1 if up else -1
    sl = round(st["ltp"] - sign * atr * 0.75, 2)
    t = [round(st["ltp"] + sign * atr * m, 2) for m in mult]

    # Clip each target back to the first structural level standing in its way,
    # but only to walls the previous target has not already cleared - otherwise
    # a single overhead level swallows T1, T2 and T3 into one number.
    walls = sorted(
        [st[k] for k in (("pdh", "pwh", "pmh") if up else ("pdl", "pwl", "pml"))],
        reverse=not up,
    )
    floor = st["ltp"]
    min_gap = atr * 0.3
    for i, tv in enumerate(t):
        for w in walls:
            beyond_floor = (w > floor + min_gap) if up else (w < floor - min_gap)
            in_the_way = (floor < w < tv) if up else (tv < w < floor)
            if beyond_floor and in_the_way:
                t[i] = round(w, 2)
                break
        # never let a clipped target sit on top of the one before it
        if (up and t[i] <= floor + min_gap) or (not up and t[i] >= floor - min_gap):
            t[i] = round(floor + (min_gap if up else -min_gap), 2)
        floor = t[i]

    risk = abs(st["ltp"] - sl) or 0.01
    return {
        "sl": sl, "t1": t[0], "t2": t[1], "t3": t[2],
        "capped": win["key"] != "PRIME",
        "rr": round(abs(t[1] - st["ltp"]) / risk, 2),
    }


def premium_legs(prem: float, delta: float, spot: float, legs: dict, win: dict) -> dict:
    """Convert spot targets to option premium using delta, discounted for theta."""
    theta = {"LOW": 0.90, "SECOND": 0.88}.get(win["key"], 0.96)

    def conv(target):
        return round(max(0.5, prem + abs(target - spot) * delta * theta), 2)

    return {
        "entry": round(prem, 2),
        "sl": round(max(0.5, prem - abs(legs["sl"] - spot) * delta), 2),
        "t1": conv(legs["t1"]), "t2": conv(legs["t2"]), "t3": conv(legs["t3"]),
    }


# ------------------------------------------------------------------- strike
def pick_strike(rows: list, spot: float, side: str) -> dict:
    """
    Liquidity first, greeks second. A strike with a wide spread is not a
    cheap entry, it is a guaranteed loss on the round trip.
    """
    scored = []
    for r in rows:
        prem = r.get("prem") or 0
        if prem <= 0:
            continue
        spread = r.get("spread", prem * 0.02)
        moneyness = abs(r["strike"] - spot) / max(spot, 1)
        delta = max(0.12, 0.55 - moneyness * 22)
        tradable = (spread / prem) < 0.05 and r.get("vol", 100000) > 50000
        scored.append({
            **r, "delta": round(delta, 2), "tradable": tradable,
            "spread_pct": round(spread / prem * 100, 2),
            "liq": r.get("vol", 0) / 1000 + r.get("oi", 0) / 4000 - (spread / prem) * 900,
        })
    ok = [s for s in scored if s["tradable"]]
    best = max(ok, key=lambda s: s["liq"]) if ok else None
    return {"rows": scored, "best": best}


# ---------------------------------------------------------------- commander
def build_commander(state: dict) -> dict:
    """One instruction for the top of the screen. Never two."""
    risk, win = state["risk"], state["win"]
    bias_label, fear = state["bias_label"], state["fear"]

    if risk["locked"]:
        reason = (
            f"{risk['sl_streak']} stops in a row. Nothing is scanned until the "
            f"{risk['cooldown_min']} minute cooldown clears."
            if risk["sl_streak"] >= risk["max_sl"]
            else f"Day P&L {risk['day_pnl']:.0f} has hit the loss limit. Manage open positions only."
        )
        return {"headline": "STAND DOWN - RISK LIMIT REACHED", "tone": "bear",
                "quality": "NONE", "conviction": 0, "order": reason}

    if state.get("stale"):
        return {
            "headline": "MARKET CLOSED - DATA NOT LIVE", "tone": "muted",
            "quality": "NONE", "conviction": 0,
            "order": ("The broker is returning the previous session's candles, so "
                      "volume, VWAP and every score built on them would be wrong. "
                      "Scanners stay empty until live candles arrive."),
        }

    if not win["tradable"]:
        return {
            "headline": "NO FRESH TRADE - MANAGE ONLY" if win["key"] == "CLOSE"
                        else "HOLD - OPENING RISK",
            "tone": "muted", "quality": "NONE", "conviction": 15,
            "order": ("After 3:15 the terminal stops generating entries. Trail stops "
                      "on running calls and book the rest.")
                     if win["key"] == "CLOSE" else
                     ("First 15 minutes are noise. Wait for the 9:30 range to set "
                      "before any entry is scored."),
        }

    best = state.get("best")
    if not best:
        return {
            "headline": "NO QUALIFYING SETUP - WAIT", "tone": "muted",
            "quality": "NONE", "conviction": 30,
            "order": (f"Market is {bias_label.lower()} but nothing clears the mandatory "
                      "filters. Candidates are failing on level break, volume or sector "
                      "alignment. Waiting is the position."),
        }

    st = best["st"]
    headline = {"BEARISH": "MARKET WEAK - PE SIDE ONLY",
                "BULLISH": "MARKET FIRM - CE SIDE ONLY"}.get(
                    bias_label, "TWO-WAY MARKET - HALF SIZE")
    tone = {"BEARISH": "bear", "BULLISH": "bull"}.get(bias_label, "gold")
    level_txt = ("with day, week and month levels all broken"
                 if best["level_count"] == 3
                 else f"on a {best['level_count']}-level break")
    vol = st.get("vol_ratio")
    vol_txt = f"{vol:.2f}x volume" if vol else "volume not live"
    return {
        "headline": headline, "tone": tone,
        "quality": "ELITE" if best["score"] >= 90 else "HIGH" if best["score"] >= 82 else "MEDIUM",
        "conviction": min(97, best["score"]),
        "order": (f"{state['bn_note']}. Fear reading {fear}. Single focus: "
                  f"{st['sym']} {best['side']} - {st['sector']} {level_txt} and "
                  f"{vol_txt}. " +
                  ("Break is confirmed - enter on the retest."
                   if best["fake"]["ok"] else
                   "Break not confirmed yet - wait for a close beyond the level.")),
    }

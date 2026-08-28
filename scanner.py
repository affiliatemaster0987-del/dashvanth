"""
Scanner: turns broker candles into the snapshot the engine scores.

Levels (PDH/PDL, PWH/PWL, PMH/PML), VWAP, ATR and the volume ratio are all
derived here so engine.py can stay a pure function of a dict.
"""
import logging
from datetime import datetime, timedelta, date

import config
import engine
import news as news_mod
from smart_client import client, now_ist

log = logging.getLogger("scanner")

_daily_cache = {}
_cache_day = None


def market_open(minutes: int) -> bool:
    return 555 <= minutes <= 930


def candle_state(intra) -> str:
    """
    Three outcomes, not two. An empty response means the fetch FAILED - at
    50 symbols against a 3/sec limit some calls always will - and that is a
    different problem from the broker handing back yesterday's session.
    Conflating them is what flipped the whole terminal to "market closed"
    in the middle of a live session.

    Returns "live" | "old" | "nodata".
    """
    if not intra:
        return "nodata"
    try:
        stamp = str(intra[-1]["t"])[:10]
    except (KeyError, IndexError, TypeError):
        return "nodata"
    return "live" if stamp == now_ist().strftime("%Y-%m-%d") else "old"


# ---------------------------------------------------------------- level math
def _period_levels(daily):
    """Previous day / week / month extremes from daily candles."""
    if len(daily) < 2:
        return None
    prev = daily[-2]
    today = daily[-1]

    def window(days):
        cut = datetime.utcnow() - timedelta(days=days)
        rows = []
        for c in daily[:-1]:
            try:
                ts = datetime.fromisoformat(str(c["t"])[:19])
            except ValueError:
                continue
            if ts >= cut:
                rows.append(c)
        return rows or daily[:-1]

    wk, mo = window(7), window(30)
    return {
        "pdh": prev["h"], "pdl": prev["l"], "prev": prev["c"],
        "pwh": max(c["h"] for c in wk), "pwl": min(c["l"] for c in wk),
        "pmh": max(c["h"] for c in mo), "pml": min(c["l"] for c in mo),
        "today_open": today["o"],
    }


def _atr(daily, period=14):
    if len(daily) < period + 1:
        return 0.0
    trs = []
    for i in range(-period, 0):
        h, l, pc = daily[i]["h"], daily[i]["l"], daily[i - 1]["c"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return round(sum(trs) / len(trs), 2)


def _vwap_and_volume(intra):
    """Session VWAP plus today's cumulative volume from 5-minute candles."""
    pv = vol = 0.0
    for c in intra:
        typical = (c["h"] + c["l"] + c["c"]) / 3
        pv += typical * c["v"]
        vol += c["v"]
    return (round(pv / vol, 2) if vol else None), vol


def _confirmation(intra, level, up):
    """
    Fakeout filter inputs. A level is only 'broken' when a completed candle
    closed beyond it, and only 'confirmed' when a later candle held beyond it.
    """
    if not intra or level is None:
        return False, False
    closed = [c for c in intra[:-1]]
    if not closed:
        return False, False
    beyond = [i for i, c in enumerate(closed) if (c["c"] > level if up else c["c"] < level)]
    if not beyond:
        return False, False
    first = beyond[0]
    after = closed[first + 1:]
    follow = any((c["c"] > level if up else c["c"] < level) for c in after)
    return True, bool(follow)


# ------------------------------------------------------------------ snapshot
def stock_snapshot(sym: str) -> dict | None:
    global _cache_day
    today = date.today()
    if _cache_day != today:
        _daily_cache.clear()
        _cache_day = today

    token = client.token_for(sym)
    if not token:
        return None

    daily = _daily_cache.get(sym) or client.candles(token, "ONE_DAY", days=45)
    if len(daily) < 3:
        return None
    _daily_cache[sym] = daily

    lv = _period_levels(daily)
    if not lv:
        return None

    intra = client.candles(token, "FIVE_MINUTE", days=1)
    vwap, vol_today = _vwap_and_volume(intra)
    ltp = intra[-1]["c"] if intra else daily[-1]["c"]
    if vwap is None:
        vwap = lv["prev"]

    closes = [c["c"] for c in daily]
    e20, e50, e200 = engine.ema(closes, 20), engine.ema(closes, 50), engine.ema(closes, 200)
    stack = engine.trend_stack(ltp, e20, e50, e200)

    # opening range = first three 5-minute candles
    opening = intra[:3]
    orh = max((c["h"] for c in opening), default=None)
    orl = min((c["l"] for c in opening), default=None)

    # move over the last ~15 minutes, for the crash / surge detector
    recent = intra[-3:] if len(intra) >= 4 else []
    win_pct = ((ltp - recent[0]["o"]) / recent[0]["o"] * 100) if recent else 0.0

    avg_vol = sum(c["v"] for c in daily[-21:-1]) / max(len(daily[-21:-1]), 1)
    minutes = now_ist().hour * 60 + now_ist().minute
    cstate = candle_state(intra)
    fresh = cstate == "live"

    # Only project a part-day volume up to a full day once enough of the
    # session has actually elapsed. Before that the projection is noise, and
    # on stale candles it is meaningless - so it is reported as None, and the
    # VOLUME check fails rather than passing on a fabricated number.
    if not fresh or not market_open(minutes):
        vol_ratio = None
    else:
        elapsed = (minutes - 555) / 375
        if elapsed < 0.10:                     # first ~37 minutes
            vol_ratio = round(vol_today / (avg_vol * elapsed), 2) if avg_vol and elapsed > 0.01 else None
            if vol_ratio and vol_ratio > 6:    # cap the early-session blow-up
                vol_ratio = 6.0
        else:
            vol_ratio = round((vol_today / elapsed) / avg_vol, 2) if avg_vol else None

    up_level = max(lv["pdh"], lv["pwh"], lv["pmh"]) if ltp > lv["pdh"] else lv["pdh"]
    dn_level = min(lv["pdl"], lv["pwl"], lv["pml"]) if ltp < lv["pdl"] else lv["pdl"]
    up_close, up_follow = _confirmation(intra, lv["pdh"], True)
    dn_close, dn_follow = _confirmation(intra, lv["pdl"], False)

    return {
        "sym": sym,
        "sector": config.SECTOR_MAP.get(sym, "OTHER"),
        "ltp": round(ltp, 2), "vwap": vwap, "atr": _atr(daily),
        "vol_ratio": vol_ratio,
        **{k: round(v, 2) for k, v in lv.items()},
        "closed_beyond_up": up_close, "follow_up": up_follow,
        "closed_beyond_dn": dn_close, "follow_dn": dn_follow,
        "ema20": e20, "ema50": e50, "ema200": e200, "stack": stack,
        "orh": round(orh, 2) if orh else None,
        "orl": round(orl, 2) if orl else None,
        "window_pct": round(win_pct, 2) if fresh else 0.0,
        "fresh": fresh, "candle_state": cstate,
    }


def _sided(st, side):
    """The engine wants one pair of confirmation flags, matched to the side."""
    up = side == "CE"
    return {**st,
            "closed_beyond": st["closed_beyond_up"] if up else st["closed_beyond_dn"],
            "follow_through": st["follow_up"] if up else st["follow_dn"]}


# -------------------------------------------------------------------- market
def index_snapshot():
    """Indices get the same level treatment as stocks - they are tradable too."""
    out = []
    for idx in config.INDICES:
        exch = idx.get("exchange", "NSE")
        intra = client.candles(idx["token"], "FIVE_MINUTE", days=1, exchange=exch)
        daily = client.candles(idx["token"], "ONE_DAY", days=45, exchange=exch)
        if not intra or len(daily) < 3:
            continue
        vwap, _ = _vwap_and_volume(intra)
        ltp = intra[-1]["c"]
        lv = _period_levels(daily) or {}
        prev = lv.get("prev") or daily[-2]["c"]
        closes = [c["c"] for c in daily]
        e20, e50, e200 = engine.ema(closes, 20), engine.ema(closes, 50), engine.ema(closes, 200)
        recent = intra[-3:] if len(intra) >= 4 else []
        out.append({
            "sym": idx["sym"], "ltp": round(ltp, 2), "prev": round(prev, 2),
            "vwap": vwap or prev,
            "chg": round((ltp - prev) / prev * 100, 2) if prev else 0,
            "dh": max(c["h"] for c in intra), "dl": min(c["l"] for c in intra),
            "pdh": round(lv.get("pdh", 0), 2), "pdl": round(lv.get("pdl", 0), 2),
            "pwh": round(lv.get("pwh", 0), 2), "pwl": round(lv.get("pwl", 0), 2),
            "ema20": e20, "ema50": e50, "ema200": e200,
            "stack": engine.trend_stack(ltp, e20, e50, e200),
            "window_pct": round(((ltp - recent[0]["o"]) / recent[0]["o"] * 100), 2)
                          if recent else 0.0,
            "tradable": idx.get("tradable", True),
        })
    return out


def scan_indices(indices, ctx):
    """CE and PE setup per index, plus the radar ranking across all four."""
    setups, radar = {}, []
    for idx in indices:
        if not idx.get("tradable", True):
            continue
        best = {}
        for side in ("CE", "PE"):
            r = engine.score_index(idx, side, ctx)
            r["side"] = side
            r["grade"] = engine.grade(r["score"])
            r["qualified"] = not r["failed"] and r["score"] >= 82
            best[side] = r
            radar.append({"sym": idx["sym"], "side": side, "score": r["score"],
                          "grade": r["grade"], "qualified": r["qualified"]})
        setups[idx["sym"]] = {"idx": idx, "CE": best["CE"], "PE": best["PE"]}
    radar.sort(key=lambda r: r["score"], reverse=True)
    return setups, radar[:8]


def sector_strength(stocks) -> dict:
    buckets = {}
    for s in stocks:
        chg = (s["ltp"] - s["prev"]) / s["prev"] * 100 if s["prev"] else 0
        buckets.setdefault(s["sector"], []).append(chg)
    return {k: round(sum(v) / len(v), 2) for k, v in buckets.items()}


def sector_commander(stocks, nifty_chg: float) -> list:
    """
    Average change alone hides a sector carried by one name. This adds
    participation (how many members agree), VWAP participation, and relative
    strength against the index.
    """
    buckets = {}
    for s in stocks:
        chg = (s["ltp"] - s["prev"]) / s["prev"] * 100 if s["prev"] else 0
        b = buckets.setdefault(s["sector"], {"chg": [], "above": 0, "vol": [], "n": 0})
        b["chg"].append(chg)
        b["above"] += 1 if s["ltp"] > s["vwap"] else 0
        if s.get("vol_ratio"):          # None whenever the feed is not live
            b["vol"].append(s["vol_ratio"])
        b["n"] += 1

    out = []
    for name, b in buckets.items():
        avg = sum(b["chg"]) / b["n"]
        agree = sum(1 for c in b["chg"] if (c > 0) == (avg > 0))
        participation = round(agree / b["n"] * 100)
        vwap_part = round(b["above"] / b["n"] * 100)
        rs = round(avg - nifty_chg, 2)
        strong = avg > 0
        # a move only counts as VERY STRONG when the members actually agree
        if abs(avg) >= 1.5 and participation >= 70:
            label = "VERY STRONG" if strong else "VERY WEAK"
        elif abs(avg) >= 0.5 and participation >= 60:
            label = "STRONG" if strong else "WEAK"
        else:
            label = "MIXED"
        out.append({
            "rotation": engine.rotation_status(avg, rs, participation),
            "name": name, "chg": round(avg, 2), "participation": participation,
            "vwap_participation": vwap_part, "rs": rs, "label": label,
            "members": b["n"],
            "avg_vol": round(sum(b["vol"]) / len(b["vol"]), 2) if b["vol"] else None,
        })
    out.sort(key=lambda s: s["chg"], reverse=True)
    return out


def market_bias(indices, sectors) -> tuple:
    def get(name):
        return next((i for i in indices if i["sym"] == name), None)

    nifty, bn, vix = get("NIFTY"), get("BANKNIFTY"), get("INDIA VIX")
    bias = 0
    if nifty:
        bias += 1 if nifty["ltp"] > nifty["vwap"] else -1
    if bn:
        bias += 1 if bn["ltp"] > bn["vwap"] else -1
    green = sum(1 for v in sectors.values() if v > 0)
    bias += 1 if green > len(sectors) / 2 else -1
    if vix:
        bias += -1 if vix["ltp"] > 14 else 1

    label = "BULLISH" if bias >= 2 else "BEARISH" if bias <= -2 else "SIDEWAYS"
    vix_v = vix["ltp"] if vix else 13
    fear = max(8, min(96, round(50 - bias * 11 + (vix_v - 13) * 9)))
    bn_note = ("BANKNIFTY holding above VWAP" if bn and bn["ltp"] > bn["vwap"]
               else "BANKNIFTY below VWAP" if bn else "BANKNIFTY data unavailable")
    return bias, label, fear, bn_note


# ----------------------------------------------------------------- full scan
def movers(stocks) -> dict:
    """
    Moneycontrol-style movers, built from data already in the scan.
    Only categories the broker feed can actually support are included -
    delivery and OI buckets need a separate feed and are left out rather
    than filled with a guess.
    """
    def chg(s):
        return round((s["ltp"] - s["prev"]) / s["prev"] * 100, 2) if s["prev"] else 0.0

    rows = [{
        "sym": s["sym"], "sector": s["sector"], "ltp": s["ltp"],
        "chg": chg(s), "vol_ratio": s.get("vol_ratio"),
        "above_vwap": s["ltp"] > s["vwap"],
        "value": s["ltp"] * (s.get("vol_ratio") or 0),
        "stack": s.get("stack", {}).get("label"),
    } for s in stocks]

    with_vol = [r for r in rows if r["vol_ratio"]]
    return {
        "gainers": sorted(rows, key=lambda r: r["chg"], reverse=True)[:8],
        "losers": sorted(rows, key=lambda r: r["chg"])[:8],
        "volume_shockers": sorted(with_vol, key=lambda r: r["vol_ratio"], reverse=True)[:8],
        "price_shockers": sorted(rows, key=lambda r: abs(r["chg"]), reverse=True)[:8],
        "active_by_value": sorted(with_vol, key=lambda r: r["value"], reverse=True)[:8],
        "above_vwap": sorted([r for r in rows if r["above_vwap"]],
                             key=lambda r: r["chg"], reverse=True)[:8],
        "below_vwap": sorted([r for r in rows if not r["above_vwap"]],
                             key=lambda r: r["chg"])[:8],
    }


def breadth_panel(stocks, sector_rows) -> dict:
    """Advances, declines, and how much of the universe is actually holding up."""
    adv = dec = unch = 0
    above_vwap = above_ema = 0
    for s in stocks:
        c = (s["ltp"] - s["prev"]) / s["prev"] * 100 if s["prev"] else 0
        if c > 0.1:
            adv += 1
        elif c < -0.1:
            dec += 1
        else:
            unch += 1
        if s["ltp"] > s["vwap"]:
            above_vwap += 1
        if s.get("ema20") and s["ltp"] > s["ema20"]:
            above_ema += 1
    n = max(len(stocks), 1)
    strong = [r["name"] for r in sector_rows if r["chg"] > 0.4][:3]
    weak = [r["name"] for r in sector_rows if r["chg"] < -0.4][-3:]
    return {
        "universe": len(stocks), "advances": adv, "declines": dec, "unchanged": unch,
        "above_vwap_pct": round(above_vwap / n * 100),
        "above_ema_pct": round(above_ema / n * 100),
        "strong_sectors": strong, "weak_sectors": weak,
        "ratio": round(adv / dec, 2) if dec else None,
    }


def pressure_attribution(stocks, sector_rows) -> dict:
    """Which sectors the buying and the selling is actually coming from."""
    buying, selling = [], []
    for r in sector_rows:
        members = [s for s in stocks if s["sector"] == r["name"]]
        if not members:
            continue
        above = sum(1 for s in members if s["ltp"] > s["vwap"])
        if r["chg"] > 0.2 and above >= len(members) / 2:
            buying.append(r["name"])
        elif r["chg"] < -0.2 and above < len(members) / 2:
            selling.append(r["name"])
    return {"buying_from": buying[:4], "selling_from": selling[:4]}


def sector_best(ranked, sector_rows) -> list:
    """Every sector, plus the single best-scoring name inside it."""
    out = []
    for r in sector_rows:
        side = "CE" if r["chg"] > 0 else "PE"
        cands = [x for x in ranked
                 if x["st"]["sector"] == r["name"] and x["side"] == side]
        best = max(cands, key=lambda x: x["score"]) if cands else None
        out.append({
            **r, "preferred_side": side,
            "best_stock": best["st"]["sym"] if best else None,
            "best_score": best["score"] if best else None,
            "best_ltp": best["st"]["ltp"] if best else None,
            "best_legs": best["legs"] if best else None,
        })
    return out


def next_session(ranked, sector_rows, indices) -> dict:
    """
    After 3:15 the screen should stop saying WAIT and start preparing for
    tomorrow: what is coiled near a level, which sectors led, where the
    index levels sit.
    """
    near_up, near_dn = [], []
    for r in ranked:
        nb = engine.near_breakout(r["st"], r["side"], max_pct=2.0)
        if not nb:
            continue
        item = {"sym": r["st"]["sym"], "side": r["side"], "score": r["score"],
                "level": nb["level"], "name": nb["name"],
                "distance": nb["distance"], "sector": r["st"]["sector"]}
        (near_up if r["side"] == "CE" else near_dn).append(item)
    near_up.sort(key=lambda x: x["distance"])
    near_dn.sort(key=lambda x: x["distance"])

    ce = sorted([r for r in ranked if r["side"] == "CE"],
                key=lambda r: r["score"], reverse=True)[:3]
    pe = sorted([r for r in ranked if r["side"] == "PE"],
                key=lambda r: r["score"], reverse=True)[:3]

    def slim(r):
        return {"sym": r["st"]["sym"], "sector": r["st"]["sector"],
                "score": r["score"], "ltp": r["st"]["ltp"],
                "sr": engine.sr_levels(r["st"])}

    return {
        "tomorrow_ce": [slim(r) for r in ce],
        "tomorrow_pe": [slim(r) for r in pe],
        "near_breakouts": near_up[:5], "near_breakdowns": near_dn[:5],
        "strongest": sector_rows[0]["name"] if sector_rows else None,
        "weakest": sector_rows[-1]["name"] if sector_rows else None,
        "index_levels": [{"sym": i["sym"], "ltp": i["ltp"], "pdh": i.get("pdh"),
                          "pdl": i.get("pdl"), "vwap": i["vwap"]} for i in indices],
    }


def attach_strikes(items, key_sym="sym", key_side="side"):
    """
    Give every row a concrete option to buy, with a live premium and the
    time it was quoted. Strikes come from the in-memory instrument master
    (free) and all the premiums are fetched in ONE batched call, so a whole
    scanner page costs a single request.
    """
    if not items:
        return items
    picks, rows = {}, []
    for it in items:
        sym, side = it.get(key_sym), it.get(key_side)
        spot = it.get("ltp")
        if not sym or not side or not spot:
            continue
        try:
            best = client.nearest_strike(sym, spot, kind=side)
        except Exception:                                  # noqa: BLE001
            best = None
        if best:
            picks[id(it)] = best
            rows.append(best)

    prem_map = client.batch_premiums(rows)
    stamp = now_ist().strftime("%H:%M:%S")
    for it in items:
        best = picks.get(id(it))
        if not best:
            it["option"] = None
            continue
        q = prem_map.get(str(best["token"])) or {}
        prem = q.get("prem")
        it["option"] = {
            "strike": best["strike"], "symbol": best["symbol"],
            "expiry": best["expiry"], "lotsize": best.get("lotsize"),
            "prem": prem, "oi": q.get("oi"), "vol": q.get("vol"),
            "spread": q.get("spread"),
            "zone": engine.entry_zone(prem, q.get("spread") or 0) if prem else None,
            "quoted_at": stamp if prem else None,
            "liquid": bool(prem and q.get("spread") is not None
                           and q["spread"] / prem < 0.05),
        }
    return items


def index_option_cards(setups, ctx):
    """
    A tradable option card per index, with the strike, live premium, OI and
    a PCR read from the same batch of quotes. Nothing here is invented: if
    the chain does not quote, the card says so.
    """
    cards = []
    for sym, v in setups.items():
        idx = v["idx"]
        meta = next((i for i in config.INDICES if i["sym"] == sym), {})
        name, exch = meta.get("opt"), meta.get("opt_exch", "NFO")
        if not name:
            continue

        ce, pe = v["CE"], v["PE"]
        lead = ce if ce["score"] >= pe["score"] else pe
        side = lead["side"]

        # quote a band of strikes once - it gives the recommended contract
        # AND enough OI on both sides to compute a PCR
        try:
            ce_chain = client.option_chain(name, kind="CE", exch=exch)
            pe_chain = client.option_chain(name, kind="PE", exch=exch)
        except Exception:                                  # noqa: BLE001
            ce_chain = pe_chain = []
        if not ce_chain or not pe_chain:
            cards.append({"sym": sym, "idx": idx, "side": side, "score": lead["score"],
                          "grade": lead["grade"], "qualified": lead["qualified"],
                          "checks": lead["checks"], "option": None, "pcr": None,
                          "note": "No option chain available for this index."})
            continue

        near = sorted(ce_chain, key=lambda c: abs(c["strike"] - idx["ltp"]))[:5]
        nearp = sorted(pe_chain, key=lambda c: abs(c["strike"] - idx["ltp"]))[:5]
        rows = [{**r, "exch": exch} for r in near + nearp]
        quotes = client.batch_premiums(rows)

        ce_oi = sum((quotes.get(str(r["token"])) or {}).get("oi", 0) for r in near)
        pe_oi = sum((quotes.get(str(r["token"])) or {}).get("oi", 0) for r in nearp)
        pcr = round(pe_oi / ce_oi, 2) if ce_oi else None

        pick = min(near if side == "CE" else nearp,
                   key=lambda c: abs(c["strike"] - idx["ltp"]))
        q = quotes.get(str(pick["token"])) or {}
        prem = q.get("prem")
        legs = engine.target_engine(
            {**idx, "atr": abs(idx["ltp"] - idx.get("pdl", idx["ltp"])) or idx["ltp"] * 0.004,
             "pdh": idx.get("pdh", idx["ltp"]), "pdl": idx.get("pdl", idx["ltp"]),
             "pwh": idx.get("pwh", idx["ltp"]), "pwl": idx.get("pwl", idx["ltp"]),
             "pmh": idx.get("pwh", idx["ltp"]), "pml": idx.get("pwl", idx["ltp"])},
            side, ctx["win"])

        cards.append({
            "sym": sym, "idx": idx, "side": side, "score": lead["score"],
            "grade": lead["grade"], "qualified": lead["qualified"],
            "checks": lead["checks"], "legs": legs,
            "alert": engine.alert_level(lead["score"],
                                        sum(1 for c in lead["checks"] if c["ok"]), []),
            "pcr": pcr, "ce_oi": ce_oi, "pe_oi": pe_oi,
            "pcr_read": (None if pcr is None else
                         "PUT WRITING - supports CE" if pcr > 1.2 else
                         "CALL WRITING - supports PE" if pcr < 0.8 else
                         "BALANCED - no option-chain edge"),
            "option": {
                "strike": pick["strike"], "symbol": pick["symbol"],
                "expiry": pick["expiry"], "prem": prem,
                "oi": q.get("oi"), "vol": q.get("vol"), "spread": q.get("spread"),
                "zone": engine.entry_zone(prem, q.get("spread") or 0) if prem else None,
                "quoted_at": now_ist().strftime("%H:%M:%S") if prem else None,
                "liquid": bool(prem and q.get("spread") is not None
                               and q["spread"] / prem < 0.05),
            } if prem else None,
        })
    cards.sort(key=lambda c: c["score"], reverse=True)
    return cards


def full_scan() -> dict:
    minutes = now_ist().hour * 60 + now_ist().minute
    win = engine.time_window(minutes)

    stocks = [s for s in (stock_snapshot(sym) for sym in config.UNIVERSE) if s]
    # Stale means the broker gave us an OLD session. Symbols that simply
    # failed to fetch are a fetch problem, counted and reported separately -
    # they must never make a live session look closed.
    fresh_n = sum(1 for s in stocks if s.get("candle_state") == "live")
    old_n = sum(1 for s in stocks if s.get("candle_state") == "old")
    nodata_n = sum(1 for s in stocks if s.get("candle_state") == "nodata")
    with_data = fresh_n + old_n
    stale = with_data > 0 and fresh_n < with_data / 2
    indices = index_snapshot()
    sectors = sector_strength(stocks)
    bias, label, fear, bn_note = market_bias(indices, sectors)
    nifty_chg = next((i["chg"] for i in indices if i["sym"] == "NIFTY"), 0.0)
    vix = next((i["ltp"] for i in indices if i["sym"] == "INDIA VIX"), 14)
    sector_rows = sector_commander(stocks, nifty_chg)
    breadth = sum(1 for s in sector_rows if s["chg"] > 0) - \
              sum(1 for s in sector_rows if s["chg"] < 0)

    headlines = news_mod.fetch(config.UNIVERSE)
    news_tags = news_mod.by_symbol(headlines)

    ctx = {"bias": bias, "bias_label": label, "sectors": sectors,
           "news": news_tags, "win": win, "breadth": breadth, "vix": vix}

    index_setups, index_radar = scan_indices(indices, ctx)

    ranked = []
    for st in stocks:
        for side in ("CE", "PE"):
            sided = _sided(st, side)
            res = engine.score_setup(sided, side, ctx)
            sided["news_tag"] = news_tags.get(st["sym"])
            ranked.append({
                "st": sided, "side": side, "fake": engine.fakeout_filter(sided),
                "legs": engine.target_engine(sided, side, win),
                "lights": engine.signal_lights(sided, side),
                "conf": engine.confirmations(sided, side), **res,
            })
    ranked.sort(key=lambda r: r["score"], reverse=True)

    # ---- call engine funnel: where every candidate actually died ----
    stage_names = ["LEVEL", "VWAP", "TIME", "NEWS", "VOLUME", "MARKET", "SECTOR"]
    funnel = [{"stage": "scanned", "n": len(ranked)}]
    survivors = ranked
    for stage in stage_names:
        survivors = [r for r in survivors
                     if next((c["ok"] for c in r["checks"] if c["k"] == stage), True)]
        funnel.append({"stage": stage, "n": len(survivors)})
    funnel.append({"stage": "score >= 82",
                   "n": len([r for r in ranked if not r["failed"] and r["score"] >= 82])})

    qualified = [r for r in ranked if not r["failed"] and r["score"] >= 82]

    # ---- near trigger: the best setups and the ONE thing blocking each ----
    near = []
    for r in ranked[:40]:
        if r in qualified:
            continue
        st = r["st"]
        nb = engine.near_breakout(st, r["side"])
        near.append({
            "sym": st["sym"], "side": r["side"], "sector": st["sector"],
            "score": r["score"], "tier": engine.tier(r["score"]),
            "blocking": engine.blocking_reason(r),
            "distance": nb["distance"] if nb else None,
            "level": nb["level"] if nb else None,
            "level_name": nb["name"] if nb else None,
            "ltp": st["ltp"],
        })
    near.sort(key=lambda n: n["score"], reverse=True)
    top_ce = next((r for r in qualified if r["side"] == "CE"), None)
    top_pe = next((r for r in qualified if r["side"] == "PE"), None)

    def jackpot(side):
        return [r for r in ranked
                if r["side"] == side and r["level_count"] > 0
                and (r["st"].get("vol_ratio") or 0) >= 1.5][:6]

    # One answer for the whole screen: CE, PE or WAIT - never both sides at once.
    best_ce_score = max((r["score"] for r in ranked if r["side"] == "CE"), default=0)
    best_pe_score = max((r["score"] for r in ranked if r["side"] == "PE"), default=0)
    decision = engine.decide_side(best_ce_score, best_pe_score)
    if decision["side"] == "WAIT":
        best = None
    else:
        best = next((r for r in ranked if r["side"] == decision["side"]
                     and not r["failed"] and r["score"] >= 82), None)
    decision["has_setup"] = best is not None
    decision["strength"] = engine.side_strength(best_ce_score, best_pe_score)

    # Always surface the strongest CE and the strongest PE, even on WAIT.
    def _watch(side):
        cands = [r for r in ranked if r["side"] == side]
        return engine.watch_card(max(cands, key=lambda r: r["score"])) if cands else None

    top_ce_watch, top_pe_watch = _watch("CE"), _watch("PE")
    # Naming the sector is not enough - say which stock inside it.
    lead_row = (sector_rows[0] if decision["side"] == "CE" and sector_rows
                else sector_rows[-1] if sector_rows else None)
    decision["best_sector"] = lead_row["name"] if lead_row else None
    if lead_row:
        side_for_sector = "CE" if lead_row["chg"] > 0 else "PE"
        pool = [r for r in ranked if r["st"]["sector"] == lead_row["name"]
                and r["side"] == side_for_sector]
        pick = max(pool, key=lambda r: r["score"]) if pool else None
        decision["sector_pick"] = {
            "sector": lead_row["name"], "sym": pick["st"]["sym"], "side": pick["side"],
            "score": pick["score"], "ltp": pick["st"]["ltp"], "legs": pick["legs"],
            "rotation": lead_row.get("rotation"),
        } if pick else None
    if best:
        decision["why"] = engine.why_side(best, best["side"])

    # top three, whatever side, with their live status
    top_setups = [{
        "sym": r["st"]["sym"], "side": r["side"], "score": r["score"],
        "tier": engine.tier(r["score"]),
        "status": ("ENTRY READY" if not r["failed"] and r["score"] >= 82
                   else "NEAR ENTRY" if r["score"] >= 70 else "WATCHING"),
        "blocking": engine.blocking_reason(r) if r["failed"] else None,
        "ltp": r["st"]["ltp"], "legs": r["legs"], "lights": r.get("lights", []),
    } for r in ranked[:3]]

    # master CE / PE boxes - top five each, ranked, no forcing
    # Always show the top ten per side, tier-labelled. A blank screen tells
    # the trader nothing about whether the engine is even running.
    ce_box = [r for r in ranked if r["side"] == "CE"][:10]
    pe_box = [r for r in ranked if r["side"] == "PE"][:10]

    # levels price has NOT taken out yet, closest first
    radar = []
    for st in stocks:
        for side in ("CE", "PE"):
            nb = engine.near_breakout(_sided(st, side), side)
            if nb:
                nb["sym"] = st["sym"]
                nb["sector"] = st["sector"]
                nb["vol_ratio"] = st["vol_ratio"]
                radar.append(nb)
    radar.sort(key=lambda n: (not n["armed"], n["distance"]))

    # fast abnormal moves - flagged, never auto-traded
    surges = [a for a in (engine.abnormal_move(st, st.get("window_pct", 0), 15)
                          for st in stocks) if a]

    # categorised scanners with an x-of-7 confirmation count each
    def bucket(side, test):
        out = []
        for st in stocks:
            sided = _sided(st, side)
            if not test(sided, side == "CE"):
                continue
            conf = engine.confirmations(sided, side)
            out.append({"sym": st["sym"], "sector": st["sector"], "ltp": st["ltp"],
                        "side": side, "vol_ratio": st.get("vol_ratio"),
                        "conf": conf["label"], "count": conf["count"],
                        "strength": conf["strength"],
                        "hits": [h["name"] for h in conf["hits"] if h["ok"]]})
        return sorted(out, key=lambda r: r["count"], reverse=True)[:8]

    scanners = {
        "breakout": bucket("CE", lambda st, up: st["ltp"] > st["pdh"]),
        "breakdown": bucket("PE", lambda st, up: st["ltp"] < st["pdl"]),
        "vwap_up": bucket("CE", lambda st, up: st["ltp"] > st["vwap"]),
        "vwap_down": bucket("PE", lambda st, up: st["ltp"] < st["vwap"]),
        "orb_up": bucket("CE", lambda st, up: st.get("orh") and st["ltp"] > st["orh"]),
        "orb_down": bucket("PE", lambda st, up: st.get("orl") and st["ltp"] < st["orl"]),
    }

    if stale:
        # An empty scanner is honest. A scanner full of yesterday's numbers
        # dressed up as live signals is not.
        radar, surges, ce_box, pe_box, top_setups = [], [], [], [], []
        scanners = {k: [] for k in scanners}
        top_ce = top_pe = best = None
        decision = {"side": "WAIT", "ce": 0, "pe": 0, "edge": 0, "has_setup": False,
                    "reason": "Feed is not live. Nothing is scored until real "
                              "candles arrive.", "confidence": 0,
                    "strength": engine.side_strength(0, 0)}
        top_ce_watch = top_pe_watch = None

    # strongest sector, then its best names
    lead = sector_rows[0]["name"] if sector_rows else None
    lead_stocks = sorted(
        [r for r in ranked if r["st"]["sector"] == lead and r["side"] == "CE"],
        key=lambda r: r["score"], reverse=True)[:4] if lead else []

    # a buyable contract on every row the trader might act from
    for bucket in scanners.values():
        attach_strikes(bucket)
    attach_strikes(top_setups)
    mv = movers(stocks)
    for name in ("gainers", "losers", "volume_shockers", "price_shockers",
                 "active_by_value"):
        for r in mv.get(name, []):
            # a gainer is not automatically a CE - the side follows VWAP and
            # structure, not the day's percentage
            r["side"] = "CE" if r["above_vwap"] and r["chg"] > 0 else "PE"
        attach_strikes(mv.get(name, []))

    for w in (top_ce_watch, top_pe_watch):
        if w:
            attach_strikes([w])
            w["alert"] = engine.alert_level(
                w["score"], (w.get("conf") or {}).get("count", 0), w.get("lights"))
    for r in scanners.values():
        for row in r:
            row["alert"] = engine.alert_level(
                row.get("count", 0) * 14, row.get("count", 0), [])

    return {
        "read": engine.market_read(label, fear, breadth, vix, win, best),
        "top_ce_watch": top_ce_watch, "top_pe_watch": top_pe_watch,
        "side_strength": engine.side_strength(best_ce_score, best_pe_score),
        "sector_best": sector_best(ranked, sector_rows),
        "attribution": pressure_attribution(stocks, sector_rows),
        "next_session": (next_session(ranked, sector_rows, indices)
                         if not win["tradable"] and minutes > 915 else None),
        "decision": decision, "pressure": engine.pressure(stocks),
        "status": engine.market_status(minutes),
        "top_setups": top_setups,
        "stale": stale, "fresh_count": fresh_n,
        "old_count": old_n, "nodata_count": nodata_n,
        "funnel": funnel, "near_trigger": near[:10],
        "movers": mv, "breadth_panel": breadth_panel(stocks, sector_rows),
        "scanners": scanners,
        "tiers": {t: len([r for r in ranked if engine.tier(r["score"]) == t])
                  for t in ("JACKPOT", "STRONG", "GOOD", "WATCHLIST", "IGNORE")},
        "index_setups": index_setups, "index_radar": index_radar,
        "index_cards": index_option_cards(index_setups, ctx),
        "sector_rows": sector_rows, "breadth": breadth,
        "ce_box": ce_box, "pe_box": pe_box,
        "breakout_radar": radar[:8], "surges": surges,
        "lead_sector": lead, "lead_stocks": lead_stocks,
        "window": win, "indices": indices, "sectors": sectors,
        "bias": bias, "bias_label": label, "fear": fear, "bn_note": bn_note,
        "top_ce": top_ce, "top_pe": top_pe,
        "jackpot_ce": jackpot("CE"), "jackpot_pe": jackpot("PE"),
        "focus": [r for r in ranked if r["score"] >= 70][:5],
        "news": headlines, "best": best, "ranked": ranked,
        "scanned": len(stocks),
    }

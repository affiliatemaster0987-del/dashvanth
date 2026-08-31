"""
KRT Quant Core: regime, multi-timeframe alignment, historical zone memory,
max pain, and the Golden Score that ranks everything.

DESIGN CONSTRAINT
-----------------
The scanner already takes ~17s against a 3-requests/second broker limit, so
nothing here issues a new API call. Every module below is computed from data
the scan has already paid for:

  * daily candles (400 days, cached once per session)  -> regime, zone memory,
    daily trend, EMA50/200
  * today's 5-minute candles                           -> 15m and 60m frames
    by resampling, never by re-fetching
  * the option chain the accumulation radar quoted     -> max pain, PCR

WHAT IS NOT HERE, AND WHY
-------------------------
Order-flow acceleration, volume delta, aggressive buy/sell split, buyer
absorption and stop-hunt detection all need tick data with the aggressor side
attached. Delivery volume and block/bulk deals are not in the broker API at
all. None of them are estimated - they are reported as unavailable so a score
is never inflated by a number nobody measured.
"""
import logging
from collections import defaultdict
from datetime import datetime

log = logging.getLogger("quant")

UNAVAILABLE = {
    "ORDER FLOW": "Volume delta and aggressive buy/sell need tick data with "
                  "the aggressor side. The REST quote cannot separate them.",
    "ABSORPTION": "Buyer/seller absorption and stop hunts need the same tick "
                  "stream. Standing depth is a different, weaker signal.",
    "DELIVERY": "Delivery percentage is not in the broker API.",
    "BLOCK DEALS": "Block and bulk deal feeds are not in the broker API.",
}


# ------------------------------------------------------------ resampling
def _cdate(c):
    try:
        return datetime.fromisoformat(str(c["t"])[:19])
    except (KeyError, TypeError, ValueError):
        return None


def resample(intra, minutes):
    """
    Build a higher timeframe from the 5-minute series already in hand.

    Bucketing by wall clock rather than by count keeps the candles aligned to
    the same boundaries a chart would draw, so a 15m candle here is the same
    15m candle the trader is looking at.
    """
    if not intra or minutes < 5:
        return list(intra or [])
    buckets = defaultdict(list)
    for c in intra:
        d = _cdate(c)
        if d is None:
            continue
        slot = (d.hour * 60 + d.minute) // minutes
        buckets[(d.date(), slot)].append(c)
    out = []
    for key in sorted(buckets):
        grp = buckets[key]
        out.append({
            "t": grp[0]["t"], "o": grp[0]["o"],
            "h": max(x["h"] for x in grp), "l": min(x["l"] for x in grp),
            "c": grp[-1]["c"], "v": sum(x.get("v") or 0 for x in grp),
        })
    return out


def _ema(vals, n):
    if not vals or len(vals) < n:
        return None
    k = 2 / (n + 1)
    e = sum(vals[:n]) / n
    for v in vals[n:]:
        e = v * k + e * (1 - k)
    return round(e, 2)


def _trend_of(candles, fast=9, slow=21):
    """Direction of one timeframe: EMA slope plus where price sits."""
    closes = [c["c"] for c in candles if c.get("c")]
    if len(closes) < slow + 1:
        return {"ok": False, "label": "NO DATA", "bull": None,
                "note": f"needs {slow + 1} candles, has {len(closes)}"}
    ef, es = _ema(closes, fast), _ema(closes, slow)
    if ef is None or es is None:
        return {"ok": False, "label": "NO DATA", "bull": None, "note": "ema unavailable"}
    last = closes[-1]
    bull = ef > es and last > es
    bear = ef < es and last < es
    label = "BULLISH" if bull else "BEARISH" if bear else "MIXED"
    return {"ok": True, "label": label, "bull": True if bull else False if bear else None,
            "ema_fast": ef, "ema_slow": es,
            "note": f"EMA{fast} {ef} vs EMA{slow} {es}"}


def multi_timeframe(intra, daily, side="CE"):
    """
    Agreement across 5m, 15m, 60m and daily.

    Only today's intraday candles exist, so the 60m frame can hold as few as
    six bars early in a session. Frames without enough history report NO DATA
    and are excluded from the percentage rather than counted as agreement.
    """
    frames = {
        "5m": _trend_of(intra or []),
        "15m": _trend_of(resample(intra, 15)),
        "60m": _trend_of(resample(intra, 60)),
        "daily": _trend_of(daily or [], 20, 50),
    }
    want = str(side).upper() == "CE"
    usable = [f for f in frames.values() if f["ok"] and f["bull"] is not None]
    agree = [f for f in usable if f["bull"] is want]
    pct = round(100 * len(agree) / len(usable)) if usable else None
    return {
        "frames": frames, "aligned": len(agree), "measured": len(usable),
        "of": len(frames), "pct": pct,
        "note": (f"{len(agree)} of {len(usable)} readable frames agree with the "
                 f"{side} side" if usable else
                 "no timeframe has enough candles yet"),
    }


# --------------------------------------------------------------- regime
def regime(indices, breadth_pct=None):
    """
    Classify the session before scoring anything in it. A breakout score means
    something different in a trending tape than in a sideways one.
    """
    by = {i.get("sym"): i for i in (indices or [])}
    nifty, vix = by.get("NIFTY"), by.get("INDIA VIX")
    if not nifty:
        return {"label": "UNKNOWN", "note": "no index data", "trend": None,
                "vol": None, "breakout_bias": 1.0}

    v = (vix or {}).get("ltp")
    stack = (nifty.get("stack") or {}).get("label", "")
    chg = nifty.get("chg") or 0
    rng = None
    if nifty.get("dh") and nifty.get("dl") and nifty.get("prev"):
        rng = round((nifty["dh"] - nifty["dl"]) / nifty["prev"] * 100, 2)

    vol_label = ("NO VIX" if v is None else
                 "LOW VOLATILITY" if v < 12 else
                 "HIGH VOLATILITY" if v > 18 else "NORMAL VOLATILITY")

    trending = abs(chg) >= 0.45 and "STACKED" in stack
    if trending and chg > 0:
        label, bias = "TRENDING BULLISH", 1.15
    elif trending and chg < 0:
        label, bias = "TRENDING BEARISH", 1.15
    elif rng is not None and rng < 0.35:
        label, bias = "SIDEWAYS", 0.75
    else:
        label, bias = "MIXED", 0.9

    if v is not None and v > 18:
        bias *= 0.9
    return {
        "label": label, "vol": vol_label, "vix": v, "day_range_pct": rng,
        "trend": chg, "breakout_bias": round(bias, 2),
        "note": (f"{label} · {vol_label}"
                 + (f" · VIX {v}" if v is not None else "")
                 + (f" · day range {rng}%" if rng is not None else "")),
        "why_bias": ("Breakout scores are lifted in a trending tape and cut in "
                     "a sideways one, because the same setup does not carry the "
                     "same odds in both."),
    }


# ------------------------------------------------- historical zone memory
def zone_memory(daily, level, tol_pct=0.4, forward=5):
    """
    How this price zone behaved the last time price was here.

    A "test" is a session whose range touched the band around `level`. The
    reaction is measured over the next `forward` sessions. With 400 days of
    daily candles this typically finds a handful of tests, not dozens - the
    count is always returned so a 2-sample "80%" is never read as a law.
    """
    if not daily or not level:
        return None
    band = level * tol_pct / 100
    lo, hi = level - band, level + band
    tests = []
    for i, c in enumerate(daily[:-forward] if len(daily) > forward else []):
        if c["l"] <= hi and c["h"] >= lo:
            fwd = daily[i + 1: i + 1 + forward]
            if not fwd:
                continue
            base = c["c"]
            up = (max(x["h"] for x in fwd) - base) / base * 100
            dn = (min(x["l"] for x in fwd) - base) / base * 100
            tests.append({"date": str(_cdate(c) and _cdate(c).date()),
                          "up": round(up, 2), "dn": round(dn, 2),
                          "bullish": up > abs(dn)})
    if not tests:
        return {"tests": 0, "note": "price has not traded this zone in the "
                                    "stored history", "level": level}
    bulls = [t for t in tests if t["bullish"]]
    n = len(tests)
    return {
        "level": round(level, 2), "band_pct": tol_pct, "tests": n,
        "bullish": len(bulls), "bearish": n - len(bulls),
        "bull_pct": round(100 * len(bulls) / n),
        "avg_up": round(sum(t["up"] for t in tests) / n, 2),
        "avg_dn": round(sum(t["dn"] for t in tests) / n, 2),
        "best_up": round(max(t["up"] for t in tests), 2),
        "worst_dn": round(min(t["dn"] for t in tests), 2),
        "forward_days": forward,
        "recent": tests[-4:],
        "thin": n < 4,
        "note": (f"{n} test{'s' if n != 1 else ''} in the stored history"
                 + (" - too few to lean on" if n < 4 else "")),
    }


# ------------------------------------------------------------- max pain
def max_pain(ce_rows, pe_rows):
    """
    The strike where the most option value expires worthless. Computed from
    the OI already quoted for the chain, so it costs nothing extra.
    """
    ce = {r["strike"]: (r.get("oi") or 0) for r in (ce_rows or []) if r.get("strike")}
    pe = {r["strike"]: (r.get("oi") or 0) for r in (pe_rows or []) if r.get("strike")}
    strikes = sorted(set(ce) | set(pe))
    if len(strikes) < 3:
        return None
    pains = []
    for s in strikes:
        loss = sum(oi * max(0, s - k) for k, oi in ce.items()) + \
               sum(oi * max(0, k - s) for k, oi in pe.items())
        pains.append((loss, s))
    pains.sort()
    total_ce, total_pe = sum(ce.values()), sum(pe.values())
    return {
        "strike": pains[0][1],
        "pcr": round(total_pe / total_ce, 2) if total_ce else None,
        "ce_oi": total_ce, "pe_oi": total_pe,
        "strikes_used": len(strikes),
        "note": ("Computed only across the strikes this scan quoted, not the "
                 "whole chain, so treat it as a local read."),
    }


# --------------------------------------------------------- golden score
WEIGHTS = {
    "STRUCTURE":    15,
    "VOLUME":       15,
    "INSTITUTIONAL": 15,
    "OPTION CHAIN": 15,
    "HISTORICAL":   10,
    "SECTOR":       10,
    "MULTI TF":     10,
    "MOMENTUM":      5,
    "LIQUIDITY":     5,
}


def golden_score(ctx):
    """
    Fold every module into one ranked score.

    Components that could not be measured are excluded and the total is
    renormalised over what remained, with the coverage returned alongside. A
    94 built from four modules is not the same claim as a 94 built from nine,
    and the difference is never hidden.
    """
    comps, got, possible = [], 0.0, 0.0

    def add(k, ok, detail, pts=None, available=True):
        nonlocal got, possible
        w = WEIGHTS[k]
        if not available:
            comps.append({"k": k, "weight": w, "available": False,
                          "detail": detail, "earned": None})
            return
        earned = (w if ok else 0) if pts is None else pts
        got += earned
        possible += w
        comps.append({"k": k, "weight": w, "available": True, "ok": bool(ok),
                      "earned": round(earned, 1), "detail": detail})

    st = ctx.get("setup") or {}
    checks = {c["k"]: c for c in (st.get("checks") or [])}

    lv = checks.get("LEVEL")
    if lv is None:
        add("STRUCTURE", False, "no level check on this setup", available=False)
    else:
        add("STRUCTURE", lv.get("ok"), lv.get("note", ""),
            WEIGHTS["STRUCTURE"] if lv.get("ok") else 0)

    vr = st.get("vol_ratio")
    if vr is None:
        add("VOLUME", False, "no live volume on this feed", available=False)
    else:
        pts = 15 if vr >= 2.5 else 11 if vr >= 1.8 else 6 if vr >= 1.3 else 0
        add("VOLUME", pts > 0, f"{round(vr, 2)}x average", pts)

    acc = ctx.get("accumulation")
    if not acc or acc.get("score") is None:
        add("INSTITUTIONAL", False,
            "no scored option contract for this underlying", available=False)
    elif acc.get("thin"):
        add("INSTITUTIONAL", False,
            f"accumulation coverage thin ({acc.get('possible')}/100 measurable)", 0)
    else:
        s = acc["score"]
        pts = 15 if s >= 85 else 11 if s >= 75 else 6 if s >= 65 else 0
        add("INSTITUTIONAL", pts > 0, f"accumulation score {s}", pts)

    oc = ctx.get("chain")
    if not oc:
        add("OPTION CHAIN", False, "chain not quoted for this underlying",
            available=False)
    else:
        pcr = oc.get("pcr")
        want_ce = str(ctx.get("side", "CE")).upper() == "CE"
        good = pcr is not None and ((pcr > 1.15) if want_ce else (pcr < 0.85))
        add("OPTION CHAIN", good,
            f"PCR {pcr}" + (f" · max pain {oc.get('strike')}" if oc.get("strike") else ""),
            WEIGHTS["OPTION CHAIN"] if good else 5 if pcr is not None else 0)

    hz = ctx.get("zone")
    if not hz or not hz.get("tests"):
        add("HISTORICAL", False,
            (hz or {}).get("note", "no history for this zone"), available=False)
    elif hz.get("thin"):
        add("HISTORICAL", False,
            f"{hz['tests']} test(s) only - too few to lean on", 3)
    else:
        want_ce = str(ctx.get("side", "CE")).upper() == "CE"
        p = hz["bull_pct"] if want_ce else 100 - hz["bull_pct"]
        pts = 10 if p >= 70 else 6 if p >= 55 else 0
        add("HISTORICAL", pts > 0,
            f"{p}% of {hz['tests']} tests went this way · avg "
            f"{hz['avg_up'] if want_ce else hz['avg_dn']}%", pts)

    sec = checks.get("SECTOR")
    if sec is None:
        add("SECTOR", False, "no sector row", available=False)
    else:
        add("SECTOR", sec.get("ok"), sec.get("note", ""),
            WEIGHTS["SECTOR"] if sec.get("ok") else 0)

    mtf = ctx.get("mtf")
    if not mtf or mtf.get("pct") is None:
        add("MULTI TF", False, "no timeframe had enough candles", available=False)
    else:
        p = mtf["pct"]
        pts = 10 if p >= 75 else 6 if p >= 50 else 0
        add("MULTI TF", pts > 0, mtf["note"], pts)

    reg = ctx.get("regime") or {}
    mom = checks.get("VWAP")
    if mom is None:
        add("MOMENTUM", False, "no VWAP check", available=False)
    else:
        add("MOMENTUM", mom.get("ok"), mom.get("note", ""),
            WEIGHTS["MOMENTUM"] if mom.get("ok") else 0)

    liq = checks.get("LIQUIDITY")
    if liq is None:
        add("LIQUIDITY", False, "no liquidity check", available=False)
    else:
        add("LIQUIDITY", liq.get("ok"), liq.get("note", ""),
            WEIGHTS["LIQUIDITY"] if liq.get("ok") else 0)

    raw = round(100 * got / possible) if possible else None
    bias = reg.get("breakout_bias", 1.0)
    score = None if raw is None else max(0, min(100, round(raw * bias)))

    measured = sum(1 for c in comps if c["available"])
    thin = possible < 55

    if score is None:
        band = "NO DATA"
    elif thin:
        band = "INSUFFICIENT DATA"
    elif score >= 95:
        band = "ULTRA GOLDEN"
    elif score >= 90:
        band = "GOLDEN JACKPOT"
    elif score >= 85:
        band = "GOLDEN SETUP"
    elif score >= 75:
        band = "WATCHLIST"
    else:
        band = "IGNORE"

    why = [f"{c['k']}: {c['detail']}" for c in comps
           if c["available"] and c.get("ok") and c.get("detail")]
    against = [f"{c['k']}: {c['detail']}" for c in comps
               if c["available"] and not c.get("ok") and c.get("detail")]
    missing = [f"{c['k']}: {c['detail']}" for c in comps if not c["available"]]

    return {
        "score": score, "raw": raw, "band": band,
        "regime_bias": bias, "regime": reg.get("label"),
        "measured": measured, "of": len(WEIGHTS), "possible": round(possible),
        "thin": thin,
        "components": comps, "why": why, "against": against, "missing": missing,
        "coverage_note": (
            f"Only {round(possible)} of 100 points were measurable "
            f"({measured} of {len(WEIGHTS)} modules). Held below GOLDEN until "
            f"more of the picture exists." ) if thin else None,
        "unavailable": UNAVAILABLE,
    }

# ------------------------------------------------------- option plan
def option_plan(legs, prem, delta, lotsize=None, spread=None):
    """
    Turn an underlying plan into a PREMIUM plan.

    The scanner's stop and targets are levels on the stock or index. A trader
    holding the option needs them in rupees of premium, and the bridge is
    delta: a one-rupee move in the underlying moves the premium by roughly
    delta rupees.

    This is an approximation and is labelled as one. Delta itself drifts as
    price moves (gamma), and time decay pulls the premium down every hour the
    move does not happen, so the further target is the least reliable number
    here. It is still far better than showing a trader a stock level when the
    position is an option.
    """
    if not legs or not prem or prem <= 0 or not delta:
        return None
    entry = legs.get("entry") or legs.get("ltp")
    if entry is None:
        # the scanner's legs are anchored on the underlying LTP
        entry = legs.get("spot")
    if entry is None:
        return None

    d = abs(float(delta))
    if d < 0.05:
        return {"ok": False,
                "why": f"delta {round(float(delta), 3)} is too small - the premium "
                       f"barely responds to the underlying, so a premium target "
                       f"would be fiction."}

    def prem_at(level):
        if level is None:
            return None
        move = (level - entry) * (1 if float(delta) > 0 else -1)
        return round(max(0.05, prem + d * move), 2)

    sl = prem_at(legs.get("sl"))
    t1, t2, t3 = (prem_at(legs.get("t1")), prem_at(legs.get("t2")),
                  prem_at(legs.get("t3")))

    risk = round(prem - sl, 2) if sl is not None else None
    rr = None
    if risk and risk > 0 and t2 is not None:
        rr = round((t2 - prem) / risk, 2)

    lo = round(prem - (spread or 0) / 2, 2) if spread else round(prem * 0.99, 2)
    hi = round(prem + (spread or 0) / 2, 2) if spread else round(prem * 1.01, 2)

    return {
        "ok": True,
        "entry_low": max(0.05, lo), "entry_high": hi,
        "prem": prem, "sl": sl, "t1": t1, "t2": t2, "t3": t3,
        "risk_per_unit": risk, "rr": rr,
        "lotsize": lotsize,
        "risk_per_lot": round(risk * lotsize, 2) if (risk and lotsize) else None,
        "cost_per_lot": round(prem * lotsize, 2) if lotsize else None,
        "delta": round(float(delta), 3),
        "basis": (f"Premium levels are the underlying plan converted at delta "
                  f"{round(d, 2)}. They are an estimate: delta moves as price "
                  f"moves, and time decay works against you while you wait."),
    }

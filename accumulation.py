"""
KRT Institutional Accumulation Radar.

Nobody can detect an institution entering. What can be measured is whether
OI, volume, depth and price are behaving the way accumulation usually looks,
and how fast that picture is building. This module produces that score.

The honest part matters more than the score. Three of the signals in the
original design cannot be computed from this broker feed at all:

  * CVD / delta volume  - needs trade-by-trade aggressor tagging (tick or
    websocket data). A snapshot quote cannot tell a market buy from a market
    sell, so there is no CVD here and none is invented.
  * Bid-side absorption / ask lifting - needs the same tick stream. The five
    level depth block gives a standing-order imbalance, which is a weaker and
    genuinely different signal, so it is reported under its own name.
  * Futures confirmation - the futures leg is not part of the current scan.

Those components are marked UNAVAILABLE and excluded from the total. The score
is renormalised over what was actually measured, and every card carries the
count, so a 90 built from six signals is never mistaken for a 90 built from ten.
"""
import logging
import math
from collections import deque
from datetime import datetime, timedelta

from smart_client import now_ist

log = logging.getLogger("accumulation")

# Samples arrive once per scan (60s). Twenty of them is a ~20 minute memory,
# which is all the velocity windows below need.
_MAX_SAMPLES = 20
_history: dict[str, deque] = {}
_score_history: dict[str, deque] = {}

# weight, and whether this feed can support it at all
COMPONENTS = {
    "OI_VELOCITY":      (15, "OI Velocity"),
    "VOLUME_BURST":     (15, "Volume Burst"),
    "OI_PRICE":         (10, "OI / Price Structure"),
    "DEPTH_IMBALANCE":  (10, "Depth Imbalance"),
    "PREMIUM_HOLD":     (10, "Premium Holding"),
    "IV_EXPANSION":     (10, "IV Expansion"),
    "UNDERLYING":       (10, "Underlying Trend"),
    "SECTOR":            (5, "Sector Strength"),
    "LIQUIDITY":         (5, "Liquidity / Spread"),
}

# named so the UI can say why, rather than leaving a silent gap
UNAVAILABLE = {
    "CVD": "Needs trade-by-trade aggressor data. A snapshot quote cannot "
           "separate market buys from market sells.",
    "ABSORPTION": "Bid absorption and ask lifting need a tick stream. Standing "
                  "depth is reported separately as Depth Imbalance.",
    "FUTURES": "The futures leg is not part of this scan.",
}


# ------------------------------------------------------ implied volatility
#
# Angel's FULL-mode quote does NOT carry impliedVolatility, so reading it off
# the row leaves IV permanently unavailable and costs the score ten points of
# coverage on every contract. IV is not feed data though - it is the number
# that makes Black-Scholes reproduce the premium being quoted, so it can be
# solved from figures already in hand: premium, spot, strike and time.
def _norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _bs_price(spot, strike, t, vol, kind, r=0.065):
    if min(spot, strike, t, vol) <= 0:
        return None
    d1 = (math.log(spot / strike) + (r + 0.5 * vol * vol) * t) / (vol * math.sqrt(t))
    d2 = d1 - vol * math.sqrt(t)
    if str(kind).upper() == "CE":
        return spot * _norm_cdf(d1) - strike * math.exp(-r * t) * _norm_cdf(d2)
    return strike * math.exp(-r * t) * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def years_to_expiry(expiry):
    """Angel expiries look like 29SEP2026. Floored so IV stays finite."""
    try:
        exp = datetime.strptime(str(expiry), "%d%b%Y").replace(hour=15, minute=30)
    except (TypeError, ValueError):
        return None
    now = now_ist()
    now = now.replace(tzinfo=None) if now.tzinfo else now
    return max((exp - now).total_seconds(), 3600) / (365.0 * 24 * 3600)


def implied_vol(prem, spot, strike, expiry, kind):
    """
    Bisection, not Newton. A few microseconds slower, but it cannot diverge on
    a deep-ITM or near-expiry contract, and a silently wrong IV is worse than
    a slow one. Returns None when the premium carries no time value, because
    IV genuinely does not exist there.
    """
    t = years_to_expiry(expiry)
    if not t or not prem or prem <= 0 or not spot or not strike:
        return None
    up = str(kind).upper() == "CE"
    intrinsic = max(0.0, (spot - strike) if up else (strike - spot))
    if prem <= intrinsic * 1.001:
        return None
    lo, hi = 0.005, 5.0
    for _ in range(60):
        mid = (lo + hi) / 2
        px = _bs_price(spot, strike, t, mid, kind)
        if px is None:
            return None
        if px > prem:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-5:
            break
    v = (lo + hi) / 2
    return round(v * 100, 2) if 0.01 < v < 4.9 else None


def option_delta(spot, strike, expiry, iv_pct, kind, r=0.065):
    t = years_to_expiry(expiry)
    if not t or not iv_pct or not spot or not strike:
        return None
    vol = iv_pct / 100.0
    d1 = (math.log(spot / strike) + (r + 0.5 * vol * vol) * t) / (vol * math.sqrt(t))
    return round(_norm_cdf(d1) if str(kind).upper() == "CE" else _norm_cdf(d1) - 1.0, 3)


def key_for(sym, strike, side):
    return f"{sym}:{strike}:{side}"


def record(key, prem, oi, vol, spread=None, bid_qty=None, ask_qty=None, iv=None):
    """Store one observation. Velocity is meaningless without these."""
    buf = _history.setdefault(key, deque(maxlen=_MAX_SAMPLES))
    buf.append({
        "t": now_ist(), "prem": prem, "oi": oi, "vol": vol,
        "spread": spread, "bid_qty": bid_qty, "ask_qty": ask_qty, "iv": iv,
    })


def _window(buf, minutes):
    """The oldest sample still inside the window, or None."""
    if not buf:
        return None
    cut = now_ist() - timedelta(minutes=minutes)
    older = [s for s in buf if s["t"] <= cut]
    return older[-1] if older else None


def _pct(now, then):
    if not then or then <= 0 or now is None:
        return None
    return round((now - then) / then * 100, 2)


def oi_velocity(key):
    """OI change over 1, 3 and 5 minutes. None until there is history."""
    buf = _history.get(key)
    if not buf or len(buf) < 2:
        return {"m1": None, "m3": None, "m5": None, "samples": len(buf or [])}
    cur = buf[-1]["oi"]
    out = {"samples": len(buf)}
    for label, mins in (("m1", 1), ("m3", 3), ("m5", 5)):
        ref = _window(buf, mins)
        out[label] = _pct(cur, ref["oi"]) if ref else None
    # fall back to the oldest sample we have when the window is not covered yet
    if out["m5"] is None and len(buf) >= 2:
        out["span"] = _pct(cur, buf[0]["oi"])
        out["span_min"] = round((buf[-1]["t"] - buf[0]["t"]).total_seconds() / 60, 1)
    return out


def volume_burst(key):
    """Current volume against the mean of the earlier samples."""
    buf = _history.get(key)
    if not buf or len(buf) < 3:
        return None
    vols = [s["vol"] for s in buf if s["vol"]]
    if len(vols) < 3:
        return None
    cur, earlier = vols[-1], vols[:-1]
    # volume is cumulative for the day, so compare the per-sample increments
    steps = [b - a for a, b in zip(vols, vols[1:]) if b >= a]
    if len(steps) < 2:
        return None
    last, rest = steps[-1], steps[:-1]
    avg = sum(rest) / len(rest) if rest else 0
    if avg <= 0:
        return None
    return round(last / avg, 2)


def oi_price_state(key):
    """The four-way read every options desk starts from."""
    buf = _history.get(key)
    if not buf or len(buf) < 2:
        return None
    ref = _window(buf, 5) or buf[0]
    d_oi = _pct(buf[-1]["oi"], ref["oi"])
    d_p = _pct(buf[-1]["prem"], ref["prem"])
    if d_oi is None or d_p is None:
        return None
    if d_p > 0 and d_oi > 0:
        label, bullish = "LONG BUILDUP", True
    elif d_p > 0 and d_oi < 0:
        label, bullish = "SHORT COVERING", None
    elif d_p < 0 and d_oi > 0:
        label, bullish = "SHORT BUILDUP", False
    else:
        label, bullish = "LONG UNWINDING", False
    return {"label": label, "d_oi": d_oi, "d_prem": d_p, "bullish": bullish}


def depth_imbalance(bid_qty, ask_qty):
    """
    Standing orders only. This is NOT absorption and NOT CVD - it says what is
    resting on the book, not what has been aggressively traded.
    """
    if not bid_qty or not ask_qty or (bid_qty + ask_qty) <= 0:
        return None
    return round(bid_qty / (bid_qty + ask_qty) * 100)


def premium_hold(key):
    """Premium against the mean of the samples taken so far."""
    buf = _history.get(key)
    if not buf or len(buf) < 3:
        return None
    prems = [s["prem"] for s in buf if s["prem"]]
    if len(prems) < 3:
        return None
    mean = sum(prems) / len(prems)
    if mean <= 0:
        return None
    return {"above": prems[-1] >= mean, "mean": round(mean, 2),
            "pct": round((prems[-1] - mean) / mean * 100, 2)}


def iv_expansion(key):
    buf = _history.get(key)
    if not buf:
        return None
    ivs = [s["iv"] for s in buf if s.get("iv")]
    if len(ivs) < 3:
        return None
    ref = sum(ivs[:-1]) / len(ivs[:-1])
    if ref <= 0:
        return None
    return {"now": round(ivs[-1], 2), "change": round((ivs[-1] - ref) / ref * 100, 2)}


def trap_flags(key, vel, burst, state, spread, baseline_spread):
    """
    Volume without OI is the classic false positive: churn, not positioning.
    A widening spread on a rising premium is the other one.
    """
    flags = []
    strongest_oi = next((v for v in (vel.get("m1"), vel.get("m3"),
                                     vel.get("m5"), vel.get("span"))
                         if v is not None), None)
    if burst and burst >= 2 and (strongest_oi is None or strongest_oi <= 0.5):
        flags.append("Volume burst with no OI build — churn, not positioning.")
    if state and state["label"] in ("SHORT BUILDUP", "LONG UNWINDING"):
        flags.append(f"OI/price reads {state['label']} — writers, not buyers.")
    if spread and baseline_spread and baseline_spread > 0 and spread > baseline_spread * 2:
        flags.append("Spread has widened sharply — exit may be expensive.")
    return flags


def score_contract(row, ctx=None):
    """
    Score one contract. `row` needs: sym, strike, side, prem, oi, vol and
    optionally spread, bid_qty, ask_qty, iv.

    Returns the score renormalised over the components that could actually be
    measured, plus the full component list so the card can show its own gaps.
    """
    ctx = ctx or {}
    key = key_for(row["sym"], row["strike"], row["side"])
    record(key, row.get("prem"), row.get("oi"), row.get("vol"),
           row.get("spread"), row.get("bid_qty"), row.get("ask_qty"), row.get("iv"))

    is_ce = str(row.get("side", "CE")).upper() == "CE"
    vel = oi_velocity(key)
    burst = volume_burst(key)
    state = oi_price_state(key)
    imbalance = depth_imbalance(row.get("bid_qty"), row.get("ask_qty"))
    hold = premium_hold(key)
    iv = iv_expansion(key)

    buf = _history.get(key) or []
    spreads = [s["spread"] for s in buf if s.get("spread")]
    baseline_spread = (sum(spreads[:-1]) / len(spreads[:-1])) if len(spreads) > 1 else None

    comps, got, possible = [], 0.0, 0.0

    def add(code, ok, detail, points=None, available=True):
        nonlocal got, possible
        weight, label = COMPONENTS[code]
        if not available:
            comps.append({"code": code, "label": label, "weight": weight,
                          "available": False, "detail": detail, "earned": None})
            return
        earned = weight if points is None and ok else (points or 0)
        got += earned
        possible += weight
        comps.append({"code": code, "label": label, "weight": weight,
                      "available": True, "ok": bool(ok), "earned": round(earned, 1),
                      "detail": detail})

    # ---- OI velocity
    best_vel = next((v for v in (vel.get("m1"), vel.get("m3"), vel.get("m5"),
                                 vel.get("span")) if v is not None), None)
    if best_vel is None:
        add("OI_VELOCITY", False, f"Needs a second sample — have {vel.get('samples', 0)}.",
            available=False)
    else:
        pts = 15 if best_vel >= 10 else 11 if best_vel >= 5 else 6 if best_vel >= 2 else 0
        add("OI_VELOCITY", pts > 0, f"{best_vel:+.2f}% over the window", pts)

    # ---- volume burst
    if burst is None:
        add("VOLUME_BURST", False, "Needs three samples to compare against.",
            available=False)
    else:
        pts = 15 if burst >= 3 else 11 if burst >= 2 else 6 if burst >= 1.5 else 0
        add("VOLUME_BURST", pts > 0, f"{burst}x the recent average", pts)

    # ---- OI / price structure
    if state is None:
        add("OI_PRICE", False, "Needs two samples.", available=False)
    else:
        good = state["bullish"] is True
        add("OI_PRICE", good, f"{state['label']} · OI {state['d_oi']:+.2f}%, "
                              f"premium {state['d_prem']:+.2f}%", 10 if good else 0)

    # ---- depth imbalance (NOT absorption, NOT CVD)
    if imbalance is None:
        add("DEPTH_IMBALANCE", False, "No depth in the quote.", available=False)
    else:
        pts = 10 if imbalance >= 65 else 6 if imbalance >= 55 else 0
        add("DEPTH_IMBALANCE", pts > 0,
            f"{imbalance}% of resting size on the bid", pts)

    # ---- premium holding
    if hold is None:
        add("PREMIUM_HOLD", False, "Needs three samples.", available=False)
    else:
        add("PREMIUM_HOLD", hold["above"],
            f"{hold['pct']:+.2f}% vs its {len(buf)}-sample mean",
            10 if hold["above"] else 0)

    # ---- IV
    if iv is None:
        add("IV_EXPANSION", False,
            "Not enough IV history yet — needs three scored samples.",
            available=False)
    else:
        rising = iv["change"] > 0
        add("IV_EXPANSION", rising, f"IV {iv['now']} ({iv['change']:+.2f}%)",
            10 if rising else 0)

    # ---- underlying
    und = ctx.get("underlying")
    if und is None:
        add("UNDERLYING", False, "No underlying read supplied.", available=False)
    else:
        aligned = bool(und.get("bullish")) == is_ce
        add("UNDERLYING", aligned,
            f"{und.get('label', 'unknown')} — {'agrees' if aligned else 'disagrees'} "
            f"with the {row['side']} side", 10 if aligned else 0)

    # ---- sector
    sec = ctx.get("sector")
    if sec is None:
        add("SECTOR", False, "No sector row for this underlying.", available=False)
    else:
        aligned = (sec.get("chg", 0) > 0) == is_ce
        add("SECTOR", aligned,
            f"{sec.get('name')} {sec.get('chg', 0):+.2f}%", 5 if aligned else 0)

    # ---- liquidity
    spread, prem = row.get("spread"), row.get("prem")
    if spread is None or not prem:
        add("LIQUIDITY", False, "No depth to measure the spread.", available=False)
    else:
        rel = spread / prem * 100
        pts = 5 if rel <= 2 else 3 if rel <= 5 else 0
        add("LIQUIDITY", pts > 0, f"spread {spread} ({rel:.1f}% of premium)", pts)

    score = round(100 * got / possible) if possible else None
    measured = sum(1 for c in comps if c["available"])

    # ---- accumulation speed
    speed = None
    if score is not None:
        sbuf = _score_history.setdefault(key, deque(maxlen=_MAX_SAMPLES))
        sbuf.append({"t": now_ist(), "score": score})
        ref = _window(sbuf, 3)
        if ref:
            delta = score - ref["score"]
            speed = {"delta": delta, "over_min": 3,
                     "label": "RAPID" if delta >= 12 else "BUILDING" if delta >= 5
                              else "FLAT" if delta > -5 else "FADING"}
        trail = [s["score"] for s in sbuf][-5:]
    else:
        trail = []

    traps = trap_flags(key, vel, burst, state, spread, baseline_spread)

    # ---- state machine
    #
    # A score is only as trustworthy as its coverage. Four signals out of nine
    # can read 100 and mean almost nothing - velocity and volume both need
    # several samples before they exist at all, so a freshly seen contract
    # starts out looking perfect. Until enough of the board is measurable the
    # tier is held down and the reason is stated, rather than letting a thin
    # 100 outrank a complete 85.
    MIN_POINTS = 55
    thin = possible < MIN_POINTS

    if score is None:
        stage, tier = "EARLY WATCH", "NO DATA"
    elif thin:
        stage, tier = "EARLY WATCH", "INSUFFICIENT DATA"
    elif traps:
        stage, tier = "EARLY WATCH", "TRAP RISK"
    elif score >= 90:
        stage, tier = "CONFIRMED ENTRY", "INSTITUTION ACTIVE"
    elif score >= 80:
        stage, tier = "BREAKOUT ARMED", "STRONG ACCUMULATION"
    elif score >= 70:
        stage, tier = "SMART MONEY ACTIVE", "BUILDING"
    elif score >= 60:
        stage, tier = "ACCUMULATION BUILDING", "WATCH"
    else:
        stage, tier = "EARLY WATCH", "IGNORE"

    return {
        "sym": row["sym"], "strike": row["strike"], "side": row["side"],
        "symbol": row.get("symbol"), "prem": prem, "oi": row.get("oi"),
        "vol": row.get("vol"), "spread": spread, "iv": row.get("iv"),
        "iv_source": row.get("iv_source"), "delta": row.get("delta"),
        "expiry": row.get("expiry"), "lotsize": row.get("lotsize"),
        "score": score, "measured": measured, "of": len(COMPONENTS),
        "possible": round(possible), "stage": stage, "tier": tier,
        "thin": thin, "min_points": MIN_POINTS,
        "coverage_note": (
            f"Only {round(possible)} of 100 points could be measured "
            f"({measured} of {len(COMPONENTS)} signals). Velocity and volume "
            f"need a few scans of history before they exist, so this contract "
            f"is held at WATCH until the picture fills in."
        ) if thin else None,
        "components": comps, "unavailable": UNAVAILABLE,
        "velocity": vel, "burst": burst, "oi_price": state,
        "imbalance": imbalance, "speed": speed, "trail": trail,
        "traps": traps,
        "samples": len(buf),
    }


def rank_chain(rows, ctx=None):
    """Score a set of strikes and return them ranked, highest first."""
    out = [score_contract(r, ctx) for r in rows if r.get("prem") and r.get("strike")]
    out.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0)))
    return out


def reset():
    """Clear the sampling memory - used when the feed goes stale."""
    _history.clear()
    _score_history.clear()

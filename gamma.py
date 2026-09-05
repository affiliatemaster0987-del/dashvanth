"""
KRT Gamma Move — directional stock-option scanner.

THE ORDER MATTERS
-----------------
High gamma is not a reason to buy anything. Gamma only says the option's delta
will move quickly if the underlying moves; it is silent on whether it will. So
the underlying is judged first and the chain second:

    level break -> volume -> VWAP / trend -> momentum
                -> chain scan -> best strike -> delta + gamma + liquidity
                -> score -> signal -> live tracking

A candidate that fails the underlying test never reaches the chain, however
attractive its greeks look.

WHAT IS MEASURED, AND FROM WHAT
-------------------------------
Levels, VWAP, EMA, volume ratio and momentum come from the scanner's own stock
snapshot. Premium, open interest, option volume and the bid/ask spread come
from the broker quote. Delta and gamma are solved from the premium with
Black-Scholes — the feed carries no greeks, so they are arithmetic on a quoted
price rather than a second source, and a contract with no time value returns
nothing instead of a fabricated number.

WHAT IS ABSENT
--------------
Order flow, aggressor side and tick-level absorption are not available from a
REST quote, so "momentum" here means price and volume behaviour across scans,
not buying pressure. It is labelled that way on screen.
"""
import logging

import accumulation
import quant
from smart_client import client, now_ist

log = logging.getLogger("gamma")

# ---------------------------------------------------------------- storage
# Signal-time state has to survive between scans: the premium when the signal
# fired, the peak since, and whether the move has already failed. Without it
# every scan would re-issue the same call at a new price and the card would
# never be able to say "T1 hit at 10:48".
_live = {}          # (sym, side) -> signal record
_day = None

WEIGHTS = {
    "BREAKOUT":   25,     # quality of the level break / breakdown
    "REL_VOLUME": 20,     # relative volume against the stock's own average
    "VWAP":       15,     # price on the correct side of VWAP
    "MOMENTUM":   10,     # trend / EMA stack agreeing
    "OPT_VOLUME": 10,     # option turnover and open interest
    "GREEKS":     15,     # delta fit and gamma
    "SPREAD":      5,     # bid-ask cost
}
TOTAL = sum(WEIGHTS.values())

STAGES = ["GAMMA WATCH", "GAMMA TRIGGER", "GAMMA ACCELERATION"]


def _reset_if_new_day():
    global _day
    today = now_ist().strftime("%Y-%m-%d")
    if _day != today:
        _live.clear()
        _day = today


# ------------------------------------------------------- underlying gate
BULL_LEVELS = [("pdh", "PREV DAY HIGH"), ("pwh", "PREV WEEK HIGH"),
               ("pmh", "PREV MONTH HIGH"), ("or5h", "FIRST 5-MIN HIGH"),
               ("orh", "FIRST 15-MIN HIGH")]
BEAR_LEVELS = [("pdl", "PREV DAY LOW"), ("pwl", "PREV WEEK LOW"),
               ("pml", "PREV MONTH LOW"), ("or5l", "FIRST 5-MIN LOW"),
               ("orl", "FIRST 15-MIN LOW")]


def rel_volume_band(vr):
    """Relative volume in words, so "strong" always means the same thing."""
    if vr is None:
        return None, "no live volume"
    if vr < 1.0:
        return "WEAK", f"{round(vr, 2)}x — below its own average"
    if vr < 1.5:
        return "NORMAL", f"{round(vr, 2)}x — normal participation"
    if vr < 2.0:
        return "GOOD", f"{round(vr, 2)}x average"
    return "STRONG", f"{round(vr, 2)}x average"


def underlying_case(st, side):
    """
    Does the stock itself justify looking at its chain at all?

    Two things are MANDATORY and a candidate is dropped without them:

      * VWAP on the right side. A call bought while price sits under VWAP is
        fighting the session's own average; the same in reverse for a put.
        This used to be scored rather than required, which let a bearish
        signal through with price above VWAP.
      * The first 5-minute level taken. That is the confirmation the move has
        actually started, as opposed to price merely sitting near a level.

    The 15-minute range and the day / week / month extremes are additive: they
    strengthen a case that already exists, they do not create one.
    """
    ltp, vwap = st.get("ltp"), st.get("vwap")
    if not ltp:
        return None
    up = side == "CE"

    # --- mandatory 1: VWAP must agree with the direction
    if not vwap:
        return None
    vwap_ok = (ltp > vwap) if up else (ltp < vwap)
    if not vwap_ok:
        return None

    # --- mandatory 2: the first 5-minute level must be taken
    k5 = "or5h" if up else "or5l"
    lv5 = st.get(k5)
    if not lv5 or not (ltp > lv5 if up else ltp < lv5):
        return None

    levels = BULL_LEVELS if up else BEAR_LEVELS
    broken, extra = [], []
    for key, label in levels:
        lv = st.get(key)
        if lv and (ltp > lv if up else ltp < lv):
            entry = {"key": key, "name": label, "level": round(lv, 2)}
            broken.append(entry)
            if key not in (k5,):
                extra.append(entry)

    vr = st.get("vol_ratio")
    vol_band, vol_note = rel_volume_band(vr)
    stack = (st.get("stack") or {}).get("label", "")
    trend_ok = ("UP" in stack) if up else ("DOWN" in stack)

    return {
        "broken": broken, "extra": extra, "levels_taken": len(broken),
        "five_min": {"key": k5, "level": round(lv5, 2),
                     "name": "FIRST 5-MIN HIGH" if up else "FIRST 5-MIN LOW"},
        "vol_ratio": vr, "vol_band": vol_band, "vol_note": vol_note,
        "vwap_ok": True, "vwap_side": "above" if up else "below",
        "trend_ok": trend_ok, "stack": stack,
        "ltp": round(ltp, 2), "vwap": round(vwap, 2),
    }


# --------------------------------------------------------- strike choice
def _score_strike(row, spot, side):
    """Rank ATM against one strike either side on what actually matters."""
    prem, oi, vol = row.get("prem"), row.get("oi"), row.get("vol")
    spread, delta = row.get("spread"), row.get("delta")
    if not prem or not delta:
        return None
    # Delta near 0.45-0.60 gives the move without paying for deep intrinsic.
    d = abs(delta)
    delta_fit = 1.0 if 0.42 <= d <= 0.62 else 0.6 if 0.32 <= d <= 0.72 else 0.2
    spread_pct = (spread / prem * 100) if (spread and prem) else None
    liq = 1.0 if (spread_pct is not None and spread_pct <= 1.5) else \
          0.6 if (spread_pct is not None and spread_pct <= 3.0) else 0.2
    turn = (vol / oi) if (oi and vol) else 0
    return {
        "fit": round(delta_fit * 0.5 + liq * 0.3 + min(turn, 1.0) * 0.2, 3),
        "delta_fit": delta_fit, "liq": liq, "turnover": round(turn, 2),
        "spread_pct": round(spread_pct, 2) if spread_pct is not None else None,
    }


def pick_strike(sym, spot, side):
    """
    Compare the money strike with one either side, and take the best.

    The nearest strike is not automatically the right one: it can be the least
    liquid of the three, and a wide spread is paid twice.
    """
    chain = client.option_chain(sym, kind=side)
    if not chain:
        return None, "no chain returned for this underlying"

    near = sorted(chain, key=lambda c: abs(c["strike"] - spot))[:3]
    if not near:
        return None, "no strike near the money"

    quotes = client.quote_full({"NFO": [str(c["token"]) for c in near]})
    cands = []
    for c in near:
        q = quotes.get(str(c["token"])) or {}
        prem = accumulation._num(q.get("ltp")) if hasattr(accumulation, "_num") else None
        if prem is None:
            try:
                prem = float(q.get("ltp") or 0) or None
            except (TypeError, ValueError):
                prem = None
        if not prem:
            continue
        iv = accumulation.implied_vol(prem, spot, c["strike"], c["expiry"], side)
        row = {
            "strike": c["strike"], "symbol": c["symbol"], "expiry": c["expiry"],
            "lotsize": c.get("lotsize"), "token": c["token"], "side": side,
            "prem": prem,
            "oi": int(q.get("opnInterest") or 0),
            "vol": int(q.get("tradeVolume") or 0),
            "spread": client.spread_from_depth(q) if hasattr(client, "spread_from_depth") else None,
            "iv": iv,
            "delta": accumulation.option_delta(spot, c["strike"], c["expiry"], iv, side),
            "gamma": accumulation.option_gamma(spot, c["strike"], c["expiry"], iv),
        }
        fit = _score_strike(row, spot, side)
        if fit:
            row.update(fit)
            cands.append(row)

    if not cands:
        return None, "no strike near the money returned a usable quote"
    cands.sort(key=lambda r: -r["fit"])
    best = cands[0]
    best["compared"] = [{"strike": c["strike"], "prem": c["prem"], "fit": c["fit"],
                         "delta": c["delta"], "spread_pct": c["spread_pct"]} for c in cands]
    return best, None


# ---------------------------------------------------------------- score
def score(case, opt):
    """
    Score the confirmations that actually exist.

    A hard rule sits on top of the arithmetic: a move cannot be called STRONG
    on average volume. Relative volume is the difference between a level being
    taken and a level being taken by someone, so the band caps the grade no
    matter how well everything else reads.
    """
    comps, got, possible = [], 0.0, 0.0

    def add(k, ok, detail, pts=None, available=True):
        nonlocal got, possible
        w = WEIGHTS[k]
        if not available:
            comps.append({"k": k, "weight": w, "available": False, "detail": detail})
            return
        earned = (w if ok else 0) if pts is None else pts
        got += earned
        possible += w
        comps.append({"k": k, "weight": w, "available": True, "ok": bool(ok),
                      "earned": round(earned, 1), "detail": detail})

    # --- breakout quality: the 5-minute level is the entry ticket, the rest add
    n_extra = len(case.get("extra") or [])
    names = ", ".join(b["name"] for b in case["broken"])
    add("BREAKOUT", n_extra >= 1,
        f"{case['levels_taken']} level{'s' if case['levels_taken'] != 1 else ''} taken · {names}",
        25 if n_extra >= 3 else 22 if n_extra == 2 else 19 if n_extra == 1 else 14)

    vr, band = case.get("vol_ratio"), case.get("vol_band")
    if vr is None:
        add("REL_VOLUME", False, "no live volume on this feed", available=False)
    else:
        add("REL_VOLUME", band in ("GOOD", "STRONG"), f"{band} · {case.get('vol_note')}",
            20 if band == "STRONG" else 15 if band == "GOOD" else
            8 if band == "NORMAL" else 0)

    add("VWAP", True, f"{case['vwap_side']} VWAP {case['vwap']}")

    add("MOMENTUM", bool(case.get("trend_ok")),
        case.get("stack") or "no EMA stack",
        10 if case.get("trend_ok") else 4)

    ov, turn = opt.get("vol"), opt.get("turnover") or 0
    if not ov:
        add("OPT_VOLUME", False, "no option volume quoted", available=False)
    else:
        add("OPT_VOLUME", turn >= 0.5, f"{ov:,} traded · {turn}x OI",
            10 if turn >= 0.5 else 6 if turn >= 0.2 else 2)

    d, g = opt.get("delta"), opt.get("gamma")
    if d is None or g is None:
        add("GREEKS", False, "premium carries no time value, so IV and the greeks do not exist",
            available=False)
    else:
        fit = opt.get("delta_fit", 0)
        add("GREEKS", fit >= 1.0, f"delta {d} · gamma {g}",
            15 if fit >= 1.0 else 9 if fit >= 0.6 else 3)

    sp = opt.get("spread_pct")
    if sp is None:
        add("SPREAD", False, "no depth in the quote", available=False)
    else:
        add("SPREAD", sp <= 1.5, f"{sp}% of premium",
            5 if sp <= 1.5 else 3 if sp <= 3 else 0)

    raw = round(100 * got / possible) if possible else None
    thin = possible < 60

    # --- the volume ceiling
    capped_at, cap_note = None, None
    final = raw
    if raw is not None and vr is not None:
        if vr < 1.0:
            capped_at, cap_note = 74, ("Relative volume is under 1.0x — the level was taken on "
                                       "less than the stock's own average trade. Held at WATCH.")
        elif vr < 1.5:
            capped_at, cap_note = 84, ("Relative volume is under 1.5x. A move on ordinary volume "
                                       "is not a STRONG move, whatever the rest of the card says.")
        if capped_at is not None and raw > capped_at:
            final = capped_at

    band_label = ("NO DATA" if final is None else
                  "INSUFFICIENT DATA" if thin else
                  "STRONG GAMMA MOVE" if final >= 85 else
                  "GAMMA TRIGGER" if final >= 75 else
                  "GAMMA WATCH" if final >= 65 else "IGNORE")
    stage = 2 if (final or 0) >= 85 else 1 if (final or 0) >= 75 else 0

    return {
        "score": final, "raw_score": raw, "capped_at": capped_at, "cap_note": cap_note,
        "band": band_label, "stage": stage, "stage_label": STAGES[stage],
        "components": comps, "measured": sum(1 for c in comps if c["available"]),
        "of": len(WEIGHTS), "possible": round(possible), "thin": thin,
        "coverage_note": (f"Only {round(possible)} of 100 points could be measured. Held below "
                          "a trigger until more of the picture exists.") if thin else None,
    }


# ------------------------------------------------------- live tracking
def _track(key, sym, side, res, opt, case, legs):
    """
    Keep the signal price separate from the live price, and never re-time a
    signal that already fired.
    """
    stamp = now_ist().strftime("%H:%M")
    rec = _live.get(key)
    prem = opt["prem"]

    if rec is None:
        if res["stage"] < 1 or res["thin"]:
            return None                     # only a confirmed trigger is logged
        plan = quant.option_plan({**(legs or {}), "entry": case["ltp"]},
                                 prem, opt.get("delta"), opt.get("lotsize"),
                                 opt.get("spread"))
        rec = {
            "sym": sym, "side": side, "at": stamp,
            "signal_prem": prem, "signal_spot": case["ltp"],
            "symbol": opt["symbol"], "strike": opt["strike"], "expiry": opt["expiry"],
            "plan": plan if (plan and plan.get("ok")) else None,
            "plan_why": None if (plan and plan.get("ok")) else (plan or {}).get("why"),
            "peak": prem, "trough": prem,
            "hits": {}, "failed_at": None, "weak_at": None, "history": [],
        }
        _live[key] = rec

    rec["prem"] = prem
    rec["spot"] = case["ltp"]
    rec["peak"] = max(rec["peak"], prem)
    rec["trough"] = min(rec["trough"], prem)
    rec["score"] = res["score"]
    rec["band"] = res["band"]
    rec["stage_label"] = res["stage_label"]
    if not rec["history"] or rec["history"][-1]["p"] != prem:
        rec["history"].append({"t": stamp, "p": prem})
        rec["history"] = rec["history"][-30:]

    p = rec.get("plan")
    if p:
        for k in ("t1", "t2", "t3"):
            if p.get(k) and prem >= p[k] and k not in rec["hits"]:
                rec["hits"][k] = stamp
        if p.get("sl") and prem <= p["sl"] and "sl" not in rec["hits"]:
            rec["hits"]["sl"] = stamp
            rec["failed_at"] = stamp

    # the underlying giving the level back is the move failing, whatever the
    # premium happens to be doing at that instant
    still_broken = bool(case.get("broken"))
    if not still_broken and not rec["failed_at"]:
        rec["failed_at"] = stamp
    elif case.get("vwap_ok") is False and not rec["weak_at"]:
        rec["weak_at"] = stamp

    rec["state"] = ("FAILED" if rec["failed_at"] else
                    "WEAKENING" if rec["weak_at"] else
                    "COMPLETED" if "t3" in rec["hits"] else "ACTIVE")
    rec["pnl_pct"] = round((prem - rec["signal_prem"]) / rec["signal_prem"] * 100, 2) \
        if rec["signal_prem"] else None
    return rec


# ---------------------------------------------------------------- entry
def scan(stocks, win, max_candidates=6):
    """
    Run the full pipeline. Only candidates that clear the underlying gate reach
    the option chain, which keeps the extra broker calls bounded.
    """
    _reset_if_new_day()
    import engine

    cases = []
    for st in stocks or []:
        for side in ("CE", "PE"):
            case = underlying_case(st, side)
            if not case:
                continue
            # a cheap pre-rank so the chain is only scanned for the best few
            rough = (case["levels_taken"] * 2
                     + (2 if case.get("vwap_ok") else 0)
                     + (1 if case.get("trend_ok") else 0)
                     + min((case.get("vol_ratio") or 0), 3))
            cases.append((rough, st, side, case))
    cases.sort(key=lambda x: -x[0])

    signals, skipped = [], []
    for _, st, side, case in cases[:max_candidates]:
        sym = st["sym"]
        try:
            opt, why = pick_strike(sym, case["ltp"], side)
        except Exception as exc:                           # noqa: BLE001
            log.warning("gamma chain %s %s failed: %s", sym, side, exc)
            opt, why = None, str(exc)
        if not opt:
            skipped.append({"sym": sym, "side": side, "why": why})
            continue

        res = score(case, opt)
        legs = None
        try:
            legs = engine.target_engine(st, side, win or {"key": "LOW"})
        except Exception:                                  # noqa: BLE001
            legs = None

        rec = _track((sym, side), sym, side, res, opt, case, legs)
        signals.append({
            "sym": sym, "side": side, "sector": st.get("sector"),
            "spot": case["ltp"], "case": case, "option": opt, **res,
            "live": rec,
        })

    # A signal that stops qualifying does not stop existing. When the stock is
    # still in the scan but no longer clears the gate, the level has been given
    # back - that is the move failing, and it has to be said, not just dropped
    # off the board while the last card sits there looking alive.
    stamp = now_ist().strftime("%H:%M")
    seen = {(s["sym"], s["side"]) for s in signals}
    by_sym = {st["sym"]: st for st in (stocks or []) if st.get("sym")}
    for key, rec in _live.items():
        if key in seen:
            continue
        st = by_sym.get(rec["sym"])
        if st and st.get("ltp"):
            rec["spot"] = round(st["ltp"], 2)
        if not rec.get("failed_at"):
            rec["failed_at"] = stamp
            rec["state"] = "FAILED"
            rec["fail_reason"] = ("The underlying no longer holds the level that produced this "
                                  "signal. The move is over whatever the premium is doing.")

    live_only = [r for r in _live.values() if (r["sym"], r["side"]) not in seen]

    signals.sort(key=lambda s: -(s["score"] or 0))
    qualified = [s for s in signals if (s["score"] or 0) >= 75 and not s["thin"]]

    # --- call of the day: the highest score is a candidate, not a winner
    def day_call_checks(sig):
        opt, live, case = sig.get("option") or {}, sig.get("live"), sig.get("case") or {}
        out = []
        state = (live or {}).get("state")
        out.append({"k": "Signal still active", "ok": state in (None, "ACTIVE"),
                    "note": f"state {state or 'new'}"})
        sp = opt.get("spread_pct")
        out.append({"k": "Spread acceptable", "ok": sp is not None and sp <= 3.0,
                    "note": f"{sp}% of premium" if sp is not None else "spread unknown"})
        turn = opt.get("turnover") or 0
        out.append({"k": "Option liquidity good", "ok": turn >= 0.2 and bool(opt.get("oi")),
                    "note": f"{turn}x OI turnover"})
        # overextended: premium already through the first target
        p = (live or {}).get("plan")
        prem = (live or {}).get("prem", opt.get("prem"))
        ext = bool(p and p.get("t1") and prem and prem >= p["t1"])
        out.append({"k": "Not already extended past T1", "ok": not ext,
                    "note": "premium is past T1" if ext else "still inside the plan"})
        out.append({"k": "Momentum continuing", "ok": bool(case.get("trend_ok")),
                    "note": case.get("stack") or "no EMA stack"})
        return out

    best, best_checks, rejected = None, None, []
    for sig in qualified:
        checks = day_call_checks(sig)
        sig["day_call_checks"] = checks
        if all(c["ok"] for c in checks):
            best, best_checks = sig, checks
            break
        rejected.append({"sym": sig["sym"], "side": sig["side"], "score": sig["score"],
                         "failed": [c["k"] for c in checks if not c["ok"]]})

    return {
        "available": True,
        "signals": signals,
        "qualified": qualified,
        "carried": live_only,
        "best": best,
        "best_checks": best_checks,
        "day_call_rejected": rejected,
        "skipped": skipped,
        "weights": WEIGHTS,
        "note": (None if best else
                 ("NO HIGH-QUALITY GAMMA SETUP. "
                  + ("Signals scored, but none passed the call-of-the-day checks — see below."
                     if qualified else
                     "Nothing cleared a confirmed trigger. A day without a setup is a normal day."))),
        "method": ("Level break, then volume, then VWAP and trend, then momentum — only then is "
                   "the chain scanned. High gamma on its own never produces a signal."),
    }

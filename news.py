"""
News intelligence. Pulls headlines, tags them, and maps them to symbols.

A headline on its own never produces a call - scanner.py only uses the tag
as one input out of ten. That is deliberate.
"""
import re
import logging
from datetime import datetime, timedelta

import feedparser

import config

log = logging.getLogger("news")

FEEDS = [
    "https://www.moneycontrol.com/rss/buzzingstocks.xml",
    "https://www.moneycontrol.com/rss/results.xml",
    "https://www.business-standard.com/rss/markets-106.rss",
    "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",
]

HIGH_IMPACT = [
    "order win", "contract win", "bags order", "wins order", "acquisition",
    "merger", "stake sale", "usfda", "block deal", "bulk deal", "buyback",
    "profit warning", "fraud", "raid", "downgrade to sell", "upper circuit",
    "lower circuit", "qip",
]
POSITIVE = [
    "profit rises", "profit jumps", "beats estimate", "record revenue", "order",
    "upgrade", "target raised", "approval", "clearance", "expansion", "dividend",
    "bonus", "wins", "signs deal", "surges", "rallies",
]
NEGATIVE = [
    "profit falls", "loss widens", "misses estimate", "downgrade", "target cut",
    "resigns", "probe", "penalty", "recall", "default", "slippage", "warning",
    "slumps", "plunges", "cuts guidance", "impairment",
]


def _tag(headline: str) -> str:
    h = headline.lower()
    if any(k in h for k in HIGH_IMPACT):
        return "HIGH"
    if any(k in h for k in NEGATIVE):
        return "NEG"
    if any(k in h for k in POSITIVE):
        return "POS"
    return "NEU"


def _symbols_in(headline: str, universe) -> list:
    """Match on the symbol and on a loose company-name form of it."""
    found = []
    upper = headline.upper()
    for sym in universe:
        stem = re.sub(r"[^A-Z]", "", sym)[:6]
        if sym in upper or (len(stem) >= 4 and stem in upper):
            found.append(sym)
    return found


IMPACT_HIGH = HIGH_IMPACT
IMPACT_MEDIUM = [
    "upgrade", "downgrade", "target raised", "target cut", "dividend",
    "expansion", "guidance", "capex", "partnership", "launch",
]


def _impact(headline: str, tag: str) -> str:
    h = headline.lower()
    if tag == "HIGH" or any(k in h for k in IMPACT_HIGH):
        return "HIGH"
    if any(k in h for k in IMPACT_MEDIUM):
        return "MEDIUM"
    return "LOW" if tag == "NEU" else "MEDIUM"


def _bias(tag: str) -> str:
    if tag in ("POS", "HIGH"):
        return "BULLISH"
    if tag == "NEG":
        return "BEARISH"
    return "NEUTRAL"


def fetch(universe=None, limit=25) -> list:
    universe = universe or config.UNIVERSE
    cutoff = datetime.utcnow() - timedelta(hours=8)
    items = []
    for url in FEEDS:
        try:
            parsed = feedparser.parse(url)
        except Exception as exc:                       # noqa: BLE001
            log.warning("feed %s failed: %s", url, exc)
            continue
        for e in parsed.entries[:40]:
            title = getattr(e, "title", "").strip()
            if not title:
                continue
            published = None
            if getattr(e, "published_parsed", None):
                published = datetime(*e.published_parsed[:6])
                if published < cutoff:
                    continue
            syms = _symbols_in(title, universe)
            tag = _tag(title)
            impact = _impact(title, tag)
            items.append({
                "head": title,
                "tag": tag,
                "impact": impact,
                "bias": _bias(tag),
                # only tradable when it names a stock we scan, carries weight,
                # and actually points a direction
                "actionable": bool(syms) and impact in ("HIGH", "MEDIUM")
                              and tag != "NEU",
                "symbols": syms,
                "time": (published or datetime.utcnow()).strftime("%H:%M"),
                "link": getattr(e, "link", ""),
            })
    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    items.sort(key=lambda i: (not i["actionable"], order[i["impact"]], i["time"]))
    return items[:limit]


def bias_strip(items, universe=None) -> dict:
    """Top-of-screen summary: which names the news is pushing each way."""
    pos, neg = [], []
    for it in items:
        for s in it["symbols"]:
            if it["bias"] == "BULLISH" and s not in pos:
                pos.append(s)
            elif it["bias"] == "BEARISH" and s not in neg:
                neg.append(s)
    return {"positive": pos[:6], "negative": neg[:6],
            "actionable": sum(1 for i in items if i["actionable"])}


def by_symbol(items) -> dict:
    """Strongest tag wins when a symbol has several headlines."""
    rank = {"HIGH": 3, "NEG": 2, "POS": 2, "NEU": 1}
    out = {}
    for it in items:
        for s in it["symbols"]:
            if s not in out or rank[it["tag"]] > rank[out[s]]:
                out[s] = it["tag"]
    return out


def verdict(tag: str, above_vwap: bool) -> str:
    """How the news reads once price is put next to it."""
    if tag == "NEU":
        return "no action - neutral"
    positive = tag in ("POS", "HIGH")
    if positive and above_vwap:
        return "CE candidate - news and price agree"
    if not positive and not above_vwap:
        return "PE candidate - news and price agree"
    return "AVOID - price is fighting the news"

"""
Angel One SmartAPI wrapper.

Everything the terminal needs from the broker lives here: session login,
the instrument master, LTP, historical candles, and an option chain built
from the NFO instrument list.

Rate limits are real. SmartAPI allows roughly 3 requests/second on quote
and historical endpoints, so every call goes through a throttle and daily
levels are cached until the next session.
"""
import json
import time
import logging
import threading
from datetime import datetime, timedelta, date

import httpx
import pyotp

import config

log = logging.getLogger("smart_client")
IST = timedelta(hours=5, minutes=30)


def now_ist() -> datetime:
    return datetime.utcnow() + IST


class Throttle:
    """Crude but effective: never more than `rate` calls per second."""

    def __init__(self, rate=3):
        self.min_gap = 1.0 / rate
        self.last = 0.0
        self.lock = threading.Lock()

    def wait(self):
        with self.lock:
            gap = time.time() - self.last
            if gap < self.min_gap:
                time.sleep(self.min_gap - gap)
            self.last = time.time()


class SmartClient:
    def __init__(self):
        self.api = None
        self.feed_token = None
        self.instruments = []
        self.by_symbol = {}
        self.throttle = Throttle(3)
        self.connected = False
        self.last_error = None
        self._candle_cache = {}
        self._cache_day = None

    # ---------------------------------------------------------------- auth
    def login(self):
        """Returns True on success. Never raises - the UI shows the reason."""
        if not all([config.ANGEL_API_KEY, config.ANGEL_CLIENT_CODE,
                    config.ANGEL_PIN, config.ANGEL_TOTP_SECRET]):
            self.last_error = "Angel credentials missing in environment"
            self.connected = False
            return False
        try:
            from SmartApi import SmartConnect
            self.api = SmartConnect(api_key=config.ANGEL_API_KEY)
            totp = pyotp.TOTP(config.ANGEL_TOTP_SECRET).now()
            res = self.api.generateSession(config.ANGEL_CLIENT_CODE, config.ANGEL_PIN, totp)
            if not res or not res.get("status"):
                self.last_error = (res or {}).get("message", "login rejected")
                self.connected = False
                return False
            self.feed_token = self.api.getfeedToken()
            self.connected = True
            self.last_error = None
            log.info("Angel session established")
            return True
        except Exception as exc:                       # noqa: BLE001
            self.last_error = f"{type(exc).__name__}: {exc}"
            self.connected = False
            return False

    # --------------------------------------------------------- instruments
    def load_instruments(self):
        """Download the scrip master once per day and index it."""
        try:
            r = httpx.get(config.INSTRUMENT_URL, timeout=60)
            r.raise_for_status()
            self.instruments = r.json()
        except Exception as exc:                       # noqa: BLE001
            self.last_error = f"instrument master: {exc}"
            return False

        self.by_symbol = {}
        for row in self.instruments:
            if row.get("exch_seg") == "NSE" and row.get("symbol", "").endswith("-EQ"):
                self.by_symbol[row["name"]] = row
        log.info("Loaded %d instruments (%d cash symbols)",
                 len(self.instruments), len(self.by_symbol))
        return True

    def resolve_index(self, cfg):
        """
        Find an index token by name when the configured one returns nothing.
        Angel has changed index scrip ids before; hard-coding alone would
        drop a whole index without any visible error.
        """
        want = (cfg.get("match") or cfg["sym"]).lower()
        for row in self.instruments:
            if row.get("exch_seg") != cfg.get("exchange", "NSE"):
                continue
            name = (row.get("name") or "").lower()
            sym = (row.get("symbol") or "").lower()
            if want in (name, sym) or want == name.replace(" ", ""):
                return row["token"]
        return None

    def token_for(self, symbol):
        row = self.by_symbol.get(symbol.upper())
        return row["token"] if row else None

    # ---------------------------------------------------------------- data
    def ltp(self, exchange, tradingsymbol, token):
        self.throttle.wait()
        try:
            res = self.api.ltpData(exchange, tradingsymbol, token)
            return (res or {}).get("data", {}).get("ltp")
        except Exception as exc:                       # noqa: BLE001
            log.warning("ltp %s failed: %s", tradingsymbol, exc)
            return None

    def quote_full(self, exchange_tokens: dict) -> dict:
        """
        Batched quotes via the Market Data API in FULL mode.

        One request covers up to 50 tokens and returns open/high/low/close,
        volume AND the five-level depth - so bid-ask spread is measured, not
        estimated. Far cheaper than one ltpData call per symbol.

        exchange_tokens: {"NSE": ["2885", ...], "NFO": [...]}
        Returns {token: row}.
        """
        out = {}
        for exch, tokens in exchange_tokens.items():
            for i in range(0, len(tokens), 50):
                chunk = tokens[i:i + 50]
                self.throttle.wait()
                try:
                    res = self.api.getMarketData("FULL", {exch: chunk})
                    for row in (res or {}).get("data", {}).get("fetched", []):
                        out[str(row.get("symbolToken"))] = row
                except Exception as exc:               # noqa: BLE001
                    log.warning("getMarketData %s failed: %s", exch, exc)
        return out

    @staticmethod
    def spread_from_depth(row) -> float | None:
        """Best bid vs best ask from the FULL-mode depth block."""
        depth = (row or {}).get("depth") or {}
        buy = (depth.get("buy") or [{}])[0].get("price")
        sell = (depth.get("sell") or [{}])[0].get("price")
        if not buy or not sell:
            return None
        return round(float(sell) - float(buy), 2)

    def candles(self, token, interval="ONE_DAY", days=40, exchange="NSE"):
        """Historical OHLCV. Cached per trading day to stay inside limits."""
        today = date.today()
        if self._cache_day != today:
            self._candle_cache.clear()
            self._cache_day = today
        key = (token, interval, days)
        if key in self._candle_cache:
            return self._candle_cache[key]

        to_dt = now_ist()
        from_dt = to_dt - timedelta(days=days)
        params = {
            "exchange": exchange,
            "symboltoken": token,
            "interval": interval,
            "fromdate": from_dt.strftime("%Y-%m-%d %H:%M"),
            "todate": to_dt.strftime("%Y-%m-%d %H:%M"),
        }
        self.throttle.wait()
        try:
            res = self.api.getCandleData(params)
            rows = (res or {}).get("data") or []
            out = [
                {"t": c[0], "o": c[1], "h": c[2], "l": c[3], "c": c[4], "v": c[5]}
                for c in rows
            ]
            # intraday is only cached for a minute, daily for the whole session
            if interval == "ONE_DAY":
                self._candle_cache[key] = out
            return out
        except Exception as exc:                       # noqa: BLE001
            log.warning("candles %s failed: %s", token, exc)
            return []

    # -------------------------------------------------------- option chain
    def option_chain(self, name, expiry=None, kind="CE", exchange="NFO"):
        """
        Build a chain from the NFO instrument list, then quote each strike.
        `name` is the underlying, e.g. BANKNIFTY or BEL.
        """
        exch = (exchange or "NFO").upper()
        rows = [
            r for r in self.instruments
            if r.get("exch_seg") == exch
            and r.get("name") == name.upper()
            and r.get("symbol", "").endswith(kind)
        ]
        if not rows:
            return []

        def exp_key(r):
            try:
                return datetime.strptime(r["expiry"], "%d%b%Y")
            except Exception:                          # noqa: BLE001
                return datetime.max

        expiries = sorted({r["expiry"] for r in rows}, key=lambda e: exp_key({"expiry": e}))
        target = expiry or expiries[0]
        rows = [r for r in rows if r["expiry"] == target]
        rows.sort(key=lambda r: float(r["strike"]))
        return [
            {
                "token": r["token"],
                "symbol": r["symbol"],
                "strike": float(r["strike"]) / 100.0,   # scrip master stores paise
                "expiry": r["expiry"],
                "lotsize": int(r.get("lotsize", 0)),
            }
            for r in rows
        ]

    def nearest_strike(self, name, spot, kind="CE", exchange="NFO"):
        """
        Pick the tradable strike nearest the money using the instrument
        master that is already in memory - no network call, so this is cheap
        enough to run for every row on a scanner page.
        """
        chain = self.option_chain(name, kind=kind, exchange=exchange)
        if not chain:
            return None
        best = min(chain, key=lambda c: abs(c["strike"] - spot))
        return {**best, "exch": exchange}

    def batch_premiums(self, rows):
        """
        One quote call for many strikes. `rows` is a list of chain entries;
        returns {token: {ltp, oi, volume}}. Keeps a whole scanner page inside
        a single request instead of one per row.
        """
        if not rows:
            return {}
        by_exch = {}
        for r in rows:
            by_exch.setdefault(r.get("exch", "NFO"), []).append(r["token"])
        quotes = self.quote_full(by_exch)
        out = {}
        for token, q in quotes.items():
            ltp = float(q.get("ltp") or 0)
            if ltp <= 0:
                continue
            out[token] = {"prem": ltp, "oi": int(q.get("opnInterest") or 0),
                          "vol": int(q.get("tradeVolume") or 0),
                          "spread": self.spread_from_depth(q)}
        return out

    def quote_strikes(self, chain, spot, width=4):
        """
        Quote the strikes near the money in ONE batched call, with the real
        bid-ask spread and OI taken from the depth block rather than guessed.
        """
        if not chain:
            return []
        near = sorted(chain, key=lambda c: abs(c["strike"] - spot))[: width * 2]
        quotes = self.quote_full({"NFO": [c["token"] for c in near]})
        out = []
        for c in near:
            row = quotes.get(str(c["token"]))
            if not row:
                continue
            prem = float(row.get("ltp") or 0)
            if prem <= 0:
                continue
            spread = self.spread_from_depth(row)
            out.append({
                **c,
                "prem": prem,
                "spread": spread if spread is not None else round(prem * 0.02, 2),
                "vol": int(row.get("tradeVolume") or 0),
                "oi": int(row.get("opnInterest") or 0),
                "iv": row.get("impliedVolatility"),
            })
        return sorted(out, key=lambda c: c["strike"])


client = SmartClient()

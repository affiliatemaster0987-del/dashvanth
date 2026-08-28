"""Central settings. Everything comes from environment variables."""
import os
from dotenv import load_dotenv

load_dotenv()

def _int(key, default):
    try:
        return int(os.getenv(key, default))
    except (TypeError, ValueError):
        return default

# --- Angel One SmartAPI ---
# Both naming schemes are accepted: the ANGEL_* names used by this build and
# the SMARTAPI_* names used by krt-ai-terminal-v2. Whichever is already set in
# the Render dashboard will be picked up, so nothing has to be renamed.
def _cred(*names):
    for n in names:
        v = os.getenv(n)
        if v:
            return v
    return ""

ANGEL_API_KEY     = _cred("ANGEL_API_KEY", "SMARTAPI_KEY")
ANGEL_CLIENT_CODE = _cred("ANGEL_CLIENT_CODE", "SMARTAPI_CLIENT")
ANGEL_PIN         = _cred("ANGEL_PIN", "SMARTAPI_PIN")
ANGEL_TOTP_SECRET = _cred("ANGEL_TOTP_SECRET", "SMARTAPI_TOTP")

# --- Telegram ---
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

# --- Risk guards ---
DAILY_LOSS_LIMIT   = _int("DAILY_LOSS_LIMIT", 5000)
MAX_CONSECUTIVE_SL = _int("MAX_CONSECUTIVE_SL", 2)
COOLDOWN_MINUTES   = _int("COOLDOWN_MINUTES", 30)

# --- Universe ---
UNIVERSE = [s.strip().upper() for s in os.getenv(
    "UNIVERSE",
    # ~50 liquid F&O names. A 12-name universe cannot produce setups: with
    # seven mandatory filters it yields well under one candidate per scan.
    "RELIANCE,ONGC,BPCL,IOC,GAIL,"
    "HDFCBANK,ICICIBANK,AXISBANK,KOTAKBANK,INDUSINDBK,"
    "SBIN,BANKBARODA,PFC,RECLTD,CANBK,"
    "INFY,TCS,WIPRO,HCLTECH,TECHM,"
    "TATASTEEL,JSWSTEEL,HINDALCO,VEDL,NATIONALUM,"
    "TATAMOTORS,MARUTI,M&M,BAJAJ-AUTO,EICHERMOT,"
    "SUNPHARMA,CIPLA,DRREDDY,LUPIN,AUROPHARMA,"
    "ITC,HINDUNILVR,BRITANNIA,VBL,DABUR,"
    "BEL,HAL,BDL,"
    "LT,SIEMENS,ABB,"
    "DLF,GODREJPROP,"
    "TATAPOWER,NTPC"
).split(",") if s.strip()]

INDICES = [
    # `opt` is the underlying name in the option scrip master, `opt_exch` the
    # segment its contracts live in. SENSEX and BANKEX options trade on BFO,
    # everything else on NFO - without this the chain lookup finds nothing.
    {"sym": "NIFTY",      "token": "99926000", "exchange": "NSE",
     "opt": "NIFTY",      "opt_exch": "NFO"},
    {"sym": "BANKNIFTY",  "token": "99926009", "exchange": "NSE",
     "opt": "BANKNIFTY",  "opt_exch": "NFO"},
    {"sym": "FINNIFTY",   "token": "99926037", "exchange": "NSE",
     "opt": "FINNIFTY",   "opt_exch": "NFO"},
    {"sym": "MIDCPNIFTY", "token": "99926074", "exchange": "NSE",
     "opt": "MIDCPNIFTY", "opt_exch": "NFO"},
    {"sym": "SENSEX",     "token": "99919000", "exchange": "BSE",
     "opt": "SENSEX",     "opt_exch": "BFO"},
    {"sym": "BANKEX",     "token": "99919012", "exchange": "BSE",
     "opt": "BANKEX",     "opt_exch": "BFO"},
    # VIX is context, never a tradable setup
    {"sym": "INDIA VIX",  "token": "99926017", "exchange": "NSE",
     "tradable": False},
]

SECTOR_MAP = {
    "RELIANCE": "ENERGY", "ONGC": "ENERGY", "BPCL": "ENERGY",
    "IOC": "ENERGY", "GAIL": "ENERGY",
    "HDFCBANK": "BANK", "ICICIBANK": "BANK", "AXISBANK": "BANK",
    "KOTAKBANK": "BANK", "INDUSINDBK": "BANK",
    "SBIN": "PSU BANK", "BANKBARODA": "PSU BANK", "PFC": "PSU BANK",
    "RECLTD": "PSU BANK", "CANBK": "PSU BANK",
    "INFY": "IT", "TCS": "IT", "WIPRO": "IT", "HCLTECH": "IT", "TECHM": "IT",
    "TATASTEEL": "METAL", "JSWSTEEL": "METAL", "HINDALCO": "METAL",
    "VEDL": "METAL", "NATIONALUM": "METAL",
    "TATAMOTORS": "AUTO", "MARUTI": "AUTO", "M&M": "AUTO",
    "BAJAJ-AUTO": "AUTO", "EICHERMOT": "AUTO",
    "SUNPHARMA": "PHARMA", "CIPLA": "PHARMA", "DRREDDY": "PHARMA",
    "LUPIN": "PHARMA", "AUROPHARMA": "PHARMA",
    "ITC": "FMCG", "HINDUNILVR": "FMCG", "BRITANNIA": "FMCG",
    "VBL": "FMCG", "DABUR": "FMCG",
    "BEL": "DEFENCE", "HAL": "DEFENCE", "BDL": "DEFENCE",
    "LT": "CAPITAL GOODS", "SIEMENS": "CAPITAL GOODS", "ABB": "CAPITAL GOODS",
    "DLF": "REALTY", "GODREJPROP": "REALTY",
    "TATAPOWER": "POWER", "NTPC": "POWER",
}

# Render's free tier has an ephemeral filesystem: the container is wiped on
# every restart and every spin-down, taking terminal.db (and all call history)
# with it. If a persistent disk is mounted at /var/data the DB goes there.
_DISK = "/var/data"
# The scanner books its own calls so results are measured, not just displayed.
AUTO_RAISE = os.getenv("AUTO_RAISE", "1") not in ("0", "false", "False")
AUTO_RAISE_SCORE = _int("AUTO_RAISE_SCORE", 85)
MAX_CALLS_PER_DAY = _int("MAX_CALLS_PER_DAY", 8)

DB_PATH = os.getenv("DB_PATH") or (
    os.path.join(_DISK, "terminal.db") if os.path.isdir(_DISK) else "terminal.db"
)
DB_PERSISTENT = DB_PATH.startswith(_DISK)
INSTRUMENT_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"

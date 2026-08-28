"""
Storage layer. Postgres when DATABASE_URL is set, SQLite otherwise.

Render's free web service has an ephemeral filesystem: the container is wiped
on every restart and every spin-down. A SQLite file there cannot hold history,
which is why the terminal kept reporting zero calls. Point DATABASE_URL at a
free Supabase or Render Postgres instance and the history becomes permanent.

The rest of the app writes plain SQL with `?` placeholders and never has to
know which backend is live.
"""
import os
import re
import sqlite3
import threading
import logging

log = logging.getLogger("db")

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))
SQLITE_PATH = os.getenv("DB_PATH") or (
    "/var/data/terminal.db" if os.path.isdir("/var/data") else "terminal.db"
)

_lock = threading.Lock()
_pg = None

LAST_ERROR = None


def _normalise(url: str) -> str:
    """
    Accept every shape of Postgres URL people paste in.

    Supabase hands out a few variants and SQLAlchemy-style prefixes are
    common; psycopg2 only understands `postgresql://`, and it rejects the
    `?pgbouncer=true` parameter that the pooler URL sometimes carries.
    """
    url = url.strip().strip('"').strip("'")
    url = url.replace("postgresql+psycopg2://", "postgresql://", 1)
    url = url.replace("postgres://", "postgresql://", 1)
    for junk in ("?pgbouncer=true", "&pgbouncer=true",
                 "?supa=base-pooler.x", "&supa=base-pooler.x"):
        url = url.replace(junk, "")
    return url


if IS_POSTGRES:
    try:
        import psycopg2
        import psycopg2.extras
        _pg_url = _normalise(DATABASE_URL)
    except ImportError:
        LAST_ERROR = ("psycopg2 is not installed - add psycopg2-binary to "
                      "requirements.txt")
        log.error(LAST_ERROR)
        IS_POSTGRES = False


def backend() -> str:
    return "postgres" if IS_POSTGRES else "sqlite"


def check() -> dict:
    """
    Prove the database is really reachable instead of assuming it. A silent
    fallback to ephemeral SQLite is exactly the failure that loses a day of
    call history without anyone noticing.
    """
    global LAST_ERROR
    try:
        with connect() as c:
            c.execute("SELECT 1")
        LAST_ERROR = None
        return {"ok": True, "backend": backend(), "persistent": persistent(),
                "detail": describe()}
    except Exception as exc:                           # noqa: BLE001
        LAST_ERROR = f"{type(exc).__name__}: {exc}"
        hint = ""
        msg = str(exc).lower()
        if "network is unreachable" in msg or "could not translate" in msg:
            hint = (" - Render cannot reach Supabase's direct connection "
                    "(IPv6 only). Use the Session Pooler URI instead.")
        elif "password authentication" in msg:
            hint = " - wrong password, or special characters need URL-encoding."
        elif "does not exist" in msg:
            hint = " - database name in the URI looks wrong."
        return {"ok": False, "backend": backend(), "persistent": False,
                "detail": LAST_ERROR + hint}


def persistent() -> bool:
    """SQLite only survives a restart when it sits on a mounted disk."""
    return IS_POSTGRES or SQLITE_PATH.startswith("/var/data")


def describe() -> str:
    if IS_POSTGRES:
        return "Postgres - history is permanent"
    if persistent():
        return "SQLite on a mounted disk - history is permanent"
    return "SQLite on ephemeral storage - history is wiped on restart"


# ------------------------------------------------------------------ schema
def _translate(sql: str) -> str:
    """SQLite dialect in, Postgres dialect out."""
    if not IS_POSTGRES:
        return sql
    sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
    sql = sql.replace("AUTOINCREMENT", "")
    # `?` placeholders -> `%s`, leaving any `?` inside quotes alone
    out, in_str, quote = [], False, ""
    for ch in sql:
        if in_str:
            if ch == quote:
                in_str = False
            out.append(ch)
        elif ch in ("'", '"'):
            in_str, quote = True, ch
            out.append(ch)
        elif ch == "?":
            out.append("%s")
        else:
            out.append(ch)
    return "".join(out)


class Cursor:
    """Thin wrapper so callers always get dict-like rows from either backend."""

    def __init__(self, cur):
        self._cur = cur

    def fetchall(self):
        rows = self._cur.fetchall()
        return [dict(r) for r in rows]

    def fetchone(self):
        row = self._cur.fetchone()
        return dict(row) if row else None

    @property
    def lastrowid(self):
        if IS_POSTGRES:
            row = self._cur.fetchone()
            return (dict(row) or {}).get("id") if row else None
        return self._cur.lastrowid


class Conn:
    def __init__(self, raw):
        self.raw = raw

    def execute(self, sql, params=()):
        cur = self.raw.cursor()
        cur.execute(_translate(sql), params)
        return Cursor(cur)

    def insert(self, sql, params=()):
        """INSERT that returns the new id on both backends."""
        if IS_POSTGRES and "returning" not in sql.lower():
            sql = sql.rstrip().rstrip(";") + " RETURNING id"
        return self.execute(sql, params).lastrowid

    def executescript(self, script):
        for stmt in script.split(";"):
            if stmt.strip():
                self.execute(stmt)

    def columns(self, table):
        if IS_POSTGRES:
            rows = self.execute(
                "SELECT column_name AS name FROM information_schema.columns "
                "WHERE table_name = ?", (table,)).fetchall()
        else:
            rows = self.execute(f"PRAGMA table_info({table})").fetchall()
        return {r["name"] for r in rows}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *_):
        if exc_type:
            self.raw.rollback()
        else:
            self.raw.commit()
        if not IS_POSTGRES:
            self.raw.close()
        return False


def connect() -> Conn:
    global _pg
    if IS_POSTGRES:
        if _pg is None or getattr(_pg, "closed", 1):
            _pg = psycopg2.connect(_pg_url, connect_timeout=10,
                                   cursor_factory=psycopg2.extras.RealDictCursor)
            _pg.autocommit = False
        return Conn(_pg)
    raw = sqlite3.connect(SQLITE_PATH, timeout=15)
    raw.row_factory = sqlite3.Row
    return Conn(raw)


def lock():
    return _lock

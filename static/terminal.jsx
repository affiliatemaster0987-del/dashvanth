import React from "react";
import { useState, useEffect, useMemo, useCallback } from "react";
import ReactDOMClient from "react-dom/client";
const ReactDOM = ReactDOMClient;

/* ------------------------------------------------------------------
   A single choke point so a backend dict can never crash the screen.

   engine.py returns dicts where the UI expects a sentence (market_read
   is one; confidence, stack and fake are others). React throws on an
   object child, which unmounts the whole terminal. Rather than trust
   that every one of a few hundred render sites was wrapped by hand,
   every child passes through here on its way into an element.
   ------------------------------------------------------------------ */
const _createElement = React.createElement;
const _isElement = (v) => v !== null && typeof v === "object" &&
  (v.$$typeof !== undefined || typeof v.then === "function");

function _coerceChild(c) {
  if (c === null || c === undefined || typeof c === "boolean") return c;
  if (typeof c === "string" || typeof c === "number") return c;
  if (Array.isArray(c)) return c.map(_coerceChild);
  if (_isElement(c)) return c;
  if (typeof c === "object") {
    try {
      if (typeof window !== "undefined") {
        window.__KRT_COERCED = (window.__KRT_COERCED || 0) + 1;
      }
    } catch (e) { /* counting is best-effort */ }
    return text(c);
  }
  return c;
}

React.createElement = function (type, props) {
  const n = arguments.length;
  if (n <= 2) return _createElement(type, props);
  const args = new Array(n);
  args[0] = type; args[1] = props;
  for (let i = 2; i < n; i++) args[i] = _coerceChild(arguments[i]);
  return _createElement.apply(null, args);
};

/* Build stamp — index.html fetches this file and looks for this exact id,
   so a stale cached bundle can be identified instead of guessed at. */
const KRT_BUILD = "v25-1788405849";
try { window.__KRT_BUILD = KRT_BUILD; } catch (e) { /* */ }

/* ============================================================
   KRT AI OPTION COMMAND CENTER
   Design: krt-ai-terminal (4).jsx — unchanged visual language.
   Data:   every number below comes from /api/snapshot, /api/calls
           or /api/chain. Nothing on this screen is invented.
           Panels the backend cannot support were removed rather
           than filled with placeholder figures.
   ============================================================ */

const C = {
  ink: "#0A0D14",
  panel: "#12161F",
  raised: "#171C27",
  line: "#232A38",
  lineSoft: "#1B2130",
  text: "#E8EAF0",
  dim: "#8A93A6",
  faint: "#4A5468",
  saffron: "#FFA033",
  saffronDeep: "#FF7A1A",
  bull: "#2FD98A",
  bear: "#FF4D5E",
  gold: "#FFC94D",
  silver: "#C3CBDA",
  lite: "#7C879B",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.krt * { box-sizing: border-box; }
.krt {
  font-family: 'Space Grotesk', system-ui, sans-serif;
  background: ${C.ink};
  color: ${C.text};
  min-height: 100%;
  -webkit-font-smoothing: antialiased;
}
.krt .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.krt button { font-family: inherit; cursor: pointer; border: none; background: none; color: inherit; }
.krt button:focus-visible, .krt [tabindex]:focus-visible {
  outline: 2px solid ${C.saffron}; outline-offset: 2px; border-radius: 3px;
}
.krt ::-webkit-scrollbar { width: 8px; height: 8px; }
.krt ::-webkit-scrollbar-track { background: ${C.ink}; }
.krt ::-webkit-scrollbar-thumb { background: ${C.line}; border-radius: 4px; }

@keyframes krt-seam { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
@keyframes krt-live { 0%,100% { opacity: .3; } 50% { opacity: 1; } }
@keyframes krt-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.krt-seam { animation: krt-seam 2.4s ease-in-out infinite; }
.krt-live { animation: krt-live 1.6s ease-in-out infinite; }
.krt-in { animation: krt-in .35s ease-out both; }

@media (prefers-reduced-motion: reduce) {
  .krt *, .krt *::before, .krt *::after { animation: none !important; transition: none !important; }
}

.krt-shell { display: grid; grid-template-columns: 148px 1fr; min-height: 100vh; }
.krt-cols { display: grid; grid-template-columns: 1.35fr 1fr; gap: 12px; }
.krt-cols3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.krt-cols2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.krt-rail { position: sticky; top: 0; height: 100vh; }

@media (max-width: 860px) {
  .krt-shell { grid-template-columns: 1fr; }
  .krt-rail { position: static; height: auto; display: flex; overflow-x: auto; border-right: none !important; border-bottom: 1px solid ${C.line}; }
  .krt-rail-brand { display: none !important; }
  .krt-rail-item { white-space: nowrap; border-left: none !important; border-bottom: 2px solid transparent; }
  .krt-cols, .krt-cols3, .krt-cols2 { grid-template-columns: 1fr; }
}
`;

/* ---------------- formatting ----------------
   A missing field renders as an em dash, never as a zero. */
const DASH = "—";
const has = (v) => v !== null && v !== undefined && v !== "";
const num = (v, d = 2) => (has(v) && isFinite(v)
  ? Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })
  : DASH);
const rupee = (v, d = 2) => (has(v) && isFinite(v) ? `₹${num(v, d)}` : DASH);
const signed = (v, d = 2) => (has(v) && isFinite(v) ? `${v > 0 ? "+" : ""}${num(v, d)}%` : DASH);
const intl = (v) => (has(v) && isFinite(v)
  ? Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 }) : DASH);

/* The backend returns dicts where a sentence is expected (engine.market_read
   is one). React cannot render an object, so every backend value passes
   through here before it is displayed. */
const PREFER = ["simple", "reason", "msg", "note", "label", "text", "name", "head", "why"];
function text(v, fallback = DASH) {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => text(x, "")).filter(Boolean);
    return parts.length ? parts.join(" · ") : fallback;
  }
  if (typeof v === "object") {
    for (const k of PREFER) {
      if (typeof v[k] === "string" && v[k]) return v[k];
    }
    const scalars = Object.entries(v)
      .filter(([, x]) => typeof x === "string" || typeof x === "number")
      .map(([k, x]) => `${k}: ${x}`);
    return scalars.length ? scalars.join(" · ") : fallback;
  }
  return fallback;
}

const fmtClock = (s) => {
  if (!has(s)) return "--:--:--";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
};
function istSeconds() {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  return ist.getHours() * 3600 + ist.getMinutes() * 60 + ist.getSeconds();
}

const STAGES = ["WATCH", "BUILDING", "ARMED", "TRIGGERED", "T1", "T2", "T3"];

/* ============================================================
   DATA LAYER
   ============================================================ */

/* the engine's real weighting — engine.py WEIGHTS */
const WEIGHTS = {
  LEVEL: 16, VOLUME: 14, VWAP: 12, MARKET: 12, STRUCTURE: 10,
  SECTOR: 10, LIQUIDITY: 8, "OI CHAIN": 8, NEWS: 6, TIME: 4,
};
const PRETTY = {
  LEVEL: "Level", VOLUME: "Volume", VWAP: "VWAP", MARKET: "Market",
  STRUCTURE: "Structure", SECTOR: "Sector", LIQUIDITY: "Liquidity",
  "OI CHAIN": "Gamma / OI", NEWS: "News", TIME: "Timing",
};

/* The engine already bands every score (engine.TIERS). Naming them a second
   time here produced "LITE" on a setup the backend called STRONG, so the
   backend's own band is used and only falls back when it is absent. */
const tierFor = (s) => (s >= 90 ? "JACKPOT" : s >= 80 ? "STRONG"
  : s >= 70 ? "GOOD" : s >= 60 ? "WATCHLIST" : "IGNORE");
const tierColor = (t) =>
  t === "JACKPOT" ? C.gold : t === "STRONG" ? C.bull :
  t === "GOOD" ? C.saffron : t === "WATCHLIST" ? C.silver : C.lite;

function stageFor(r) {
  const t = r.times || {};
  if (t.t3_at) return 6;
  if (t.t2_at) return 5;
  if (t.t1_at) return 4;
  if (t.entry_at) return 3;
  if (t.confirmed_at) return 2;
  if (t.detected_at) return 1;
  if ((r.failed || []).length) return 0;
  return (r.score || 0) >= 85 ? 2 : 1;
}

function toSetup(r, i) {
  const legs = r.legs || {};
  const ltp = r.ltp;
  const checks = r.checks || [];
  const lv = r.levels || {};
  const isCE = r.side === "CE";

  const breakdown = {}, breakdownMax = {};
  Object.keys(WEIGHTS).forEach((k) => {
    const c = checks.find((x) => x.k === k);
    breakdown[PRETTY[k]] = c && c.ok ? (has(c.pts) ? c.pts : WEIGHTS[k]) : 0;
    breakdownMax[PRETTY[k]] = WEIGHTS[k];
  });

  const passed = checks.filter((c) => c.ok && c.note).map((c) => text(c.note, "")).filter(Boolean);
  const blocked = checks.filter((c) => !c.ok && c.note).map((c) => text(c.note, "")).filter(Boolean);
  const level = isCE ? lv.pdh : lv.pdl;

  return {
    id: `${text(r.sym, "?")}-${text(r.side, "")}-${i}`,
    sym: text(r.sym, "?"), side: text(r.side, ""), sector: text(r.sector, ""),
    tier: text(r.tier_band, text(r.tier, tierFor(r.score || 0))),
    score: r.score || 0,
    stage: stageFor(r),
    ltp,
    sl: has(legs.sl) ? legs.sl : null,
    tgts: [legs.t1, legs.t2, legs.t3].filter(has),
    rr: legs.rr, capped: legs.capped,
    trigger: has(level) ? `${isCE ? "Above" : "Below"} ${rupee(level)}` : "Level break",
    why: passed, blocked,
    breakdown, breakdownMax,
    levels: lv, vwap: r.vwap, atr: r.atr, volRatio: r.vol_ratio,
    ema20: r.ema20, ema50: r.ema50, ema200: r.ema200,
    stack: r.stack, confidence: text(r.confidence, ""), grade: text(r.grade, ""),
    lights: r.lights || [], conf: r.conf || {},
    fake: r.fake || null, levelCount: r.level_count,
    prevDate: text(r.prev_date, ""), noTodayCandle: !!r.no_today_candle,
    option: r.option || null,
    quoted: !!r.quoted, priceSource: text(r.price_source, ""),
    prevSource: text(r.prev_source, ""),
    dayOpen: r.day_open, dayHigh: r.day_high, dayLow: r.day_low,
  };
}

function useFeed() {
  const [snap, setSnap] = useState(null);
  const [calls, setCalls] = useState(null);
  const [err, setErr] = useState(null);
  const [boot, setBoot] = useState(null);
  const [sec, setSec] = useState(istSeconds());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setSec(istSeconds()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const res = await fetch("/api/snapshot", { cache: "no-store" });
        const body = await res.json();
        if (dead) return;
        if (!res.ok || body.ready === false) {
          setErr(body.error || `snapshot ${res.status}`);
          setBoot(body.boot || null); setSnap(null);
        } else { setSnap(body); setErr(null); setBoot(null); }
      } catch (e) { if (!dead) { setErr(String(e.message || e)); setSnap(null); } }
      try {
        const r2 = await fetch("/api/calls", { cache: "no-store" });
        if (r2.ok && !dead) setCalls(await r2.json());
      } catch { /* journal is optional */ }
    };
    pull();
    const t = setInterval(pull, 15000);
    return () => { dead = true; clearInterval(t); };
  }, [nonce]);

  const setups = useMemo(() => {
    if (!snap) return [];
    const rows = [...(snap.jackpot_ce || []), ...(snap.jackpot_pe || []),
                  ...(snap.ce_box || []), ...(snap.pe_box || [])];
    const seen = new Set();
    return rows.filter((r) => r && r.sym)
      .filter((r) => { const k = r.sym + r.side; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(toSetup)
      .sort((a, b) => b.score - a.score);
  }, [snap]);

  const mood = useMemo(() => {
    if (!snap) return null;
    const p = snap.pressure || {};
    if (has(p.buyers)) { const b = Math.round(p.buyers); return { bull: b, bear: Math.max(1, 100 - b) }; }
    const bp = snap.breadth_panel || {};
    if (has(bp.advances) && has(bp.declines)) return { bull: bp.advances, bear: Math.max(1, bp.declines) };
    return null;
  }, [snap]);

  const indices = useMemo(() => {
    if (!snap || !snap.indices) return [];
    const arr = Array.isArray(snap.indices) ? snap.indices
      : Object.entries(snap.indices).map(([k, v]) => ({ name: k, ...(v || {}) }));
    return arr.map((x) => ({
      name: x.name || x.sym || DASH,
      ltp: x.ltp, chg: x.chg,
      pdh: x.pdh, pdl: x.pdl, vwap: x.vwap,
    }));
  }, [snap]);

  const unquoted = useMemo(() => {
    if (!snap) return 0;
    const rows = [...(snap.ce_box || []), ...(snap.pe_box || [])];
    const named = rows.filter((r) => r && has(r.quoted));
    return named.length ? named.filter((r) => !r.quoted).length : 0;
  }, [snap]);

  const shifted = useMemo(() => {
    if (!snap) return { any: false, date: null, session: null, isToday: true };
    const rows = [...(snap.indices || []), ...(snap.ce_box || []), ...(snap.pe_box || [])];
    const hit = rows.find((r) => r && r.no_today_candle);
    const any_ = rows.find((r) => r && has(r.session_date));
    return {
      any: !!hit,
      date: hit ? text(hit.prev_date, "") : null,
      session: any_ ? text(any_.session_date, "") : null,
      isToday: any_ ? !!any_.session_is_today : true,
    };
  }, [snap]);

  const win = (snap && snap.window) || {};
  /* The backend already says this plainly in two places. Read them rather
     than guessing from the window key — "CLOSE" is not "CLOSED", and that one
     character was enough to label a Saturday as an open session. */
  const status = (snap && snap.status) || {};
  const sessionOpen = has(status.live) ? !!status.live
    : has(win.tradable) ? !!win.tradable
    : String(status.state || "").toUpperCase() === "OPEN";
  const sessionLabel = text(status.label, text(win.label, sessionOpen ? "SESSION OPEN" : "SESSION CLOSED"));
  const stale = !!(snap && snap.stale);
  const source = !snap ? "warming" : stale ? "stale" : "live";
  const sourceLabel = source === "live" ? "LIVE · BROKER FEED"
    : source === "stale" ? "FEED STALE · DO NOT TRADE"
    : boot ? `WARMING UP · ${String(boot).toUpperCase()}` : "NO FEED · BACKEND NOT READY";

  return {
    snap, calls, setups, mood, indices, sec, stale, source, sourceLabel,
    emptyReason: text(snap && snap.empty_reason, ""),
    scanError: text(snap && snap.scan_error, ""),
    shiftedLevels: shifted.any, prevDate: shifted.date,
    sessionShown: shifted.session, sessionIsToday: shifted.isToday,
    unquoted,
    sessionOpen, sessionLabel, sessionDetail: text(status.detail, ""),
    err, boot, live: !!snap,
    reload: () => setNonce((n) => n + 1),
  };
}

/* ---------------- primitives ---------------- */
const Panel = ({ title, right, children, style, pad = 14 }) => (
  <section style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 4, ...style }}>
    {title && (
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "9px 14px", borderBottom: `1px solid ${C.lineSoft}`,
      }}>
        <h2 className="mono" style={{ margin: 0, fontSize: 10.5, letterSpacing: ".16em", color: C.dim, fontWeight: 600 }}>
          {title}
        </h2>
        {right}
      </header>
    )}
    <div style={{ padding: pad }}>{children}</div>
  </section>
);

const Tag = ({ children, color = C.dim, solid = false }) => (
  <span className="mono" style={{
    fontSize: 9.5, letterSpacing: ".1em", fontWeight: 600, padding: "2px 6px", borderRadius: 2,
    color: solid ? C.ink : color,
    background: solid ? color : `${color}1A`,
    border: `1px solid ${solid ? color : color + "44"}`,
  }}>{typeof children === "object" && children !== null && !Array.isArray(children) ? text(children) : children}</span>
);

const Row = ({ label, value, color }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
    <span className="mono" style={{ fontSize: 10.5, color: C.dim, letterSpacing: ".04em" }}>{label}</span>
    <span className="mono" style={{ fontSize: 12.5, color: value === DASH ? C.faint : (color || C.text), fontWeight: 500, textAlign: "right" }}>{text(value)}</span>
  </div>
);

const Meter = ({ v, max = 100, color }) => (
  <div style={{ height: 3, background: C.lineSoft, borderRadius: 2, overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(100, (v / (max || 1)) * 100))}%`, height: "100%", background: color, transition: "width .5s ease" }} />
  </div>
);

const Empty = ({ children }) => (
  <div className="mono" style={{ fontSize: 11, color: C.dim, lineHeight: 1.6, padding: "22px 12px", textAlign: "center" }}>
    {children}
  </div>
);

/* ---------------- signature: mood tug-of-war ---------------- */
function MoodBar({ mood, label, breadth, decision, win, fear, sectors }) {
  if (!mood) {
    return <Empty>The scanner has not returned a pressure reading yet. Nothing is being estimated in its place.</Empty>;
  }
  const total = mood.bull + mood.bear;
  const bullPct = (mood.bull / total) * 100;
  const bp = breadth || {};
  const d = decision || {};

  const chips = [
    ["BREADTH", has(bp.advances) ? `${bp.advances} adv / ${bp.declines} dec` : DASH,
      has(bp.ratio) ? (bp.ratio > 1 ? C.bull : C.bear) : C.dim],
    ["ABOVE VWAP", has(bp.above_vwap_pct) ? `${bp.above_vwap_pct}% of universe` : DASH,
      has(bp.above_vwap_pct) ? (bp.above_vwap_pct >= 55 ? C.bull : bp.above_vwap_pct <= 45 ? C.bear : C.saffron) : C.dim],
    ["ABOVE EMA20", has(bp.above_ema_pct) ? `${bp.above_ema_pct}% of universe` : DASH,
      has(bp.above_ema_pct) ? (bp.above_ema_pct >= 55 ? C.bull : C.bear) : C.dim],
    ["DECISION", d.side || DASH, d.side === "CE" ? C.bull : d.side === "PE" ? C.bear : C.saffron],
    ["WINDOW", win && win.key ? win.key : DASH, win && win.tradable ? C.bull : C.saffron],
    ["LEAD SECTOR", sectors && sectors.length ? sectors[0].name : DASH,
      sectors && sectors.length ? (sectors[0].chg > 0 ? C.bull : C.bear) : C.dim],
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8, gap: 10, flexWrap: "wrap" }}>
        <div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".18em", color: C.dim }}>MARKET MOOD</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-.02em", lineHeight: 1.1, marginTop: 3 }}>
            {text(label)}
          </div>
          {has(fear) && (
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 3 }}>
              Fear index {num(fear, 0)}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 22, color: C.bull, fontWeight: 600 }}>{mood.bull}</div>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".1em" }}>BUY / SELL PRESSURE</div>
          <div className="mono" style={{ fontSize: 22, color: C.bear, fontWeight: 600 }}>{mood.bear}</div>
        </div>
      </div>

      <div style={{ position: "relative", height: 34, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          <div style={{ width: `${bullPct}%`, background: `linear-gradient(90deg, ${C.bull}22, ${C.bull}55)`, transition: "width .6s cubic-bezier(.4,0,.2,1)" }} />
          <div style={{ flex: 1, background: `linear-gradient(90deg, ${C.bear}55, ${C.bear}22)` }} />
        </div>
        <div className="krt-seam" style={{
          position: "absolute", top: -2, bottom: -2, left: `${bullPct}%`, width: 2,
          background: C.saffron, boxShadow: `0 0 12px ${C.saffron}`, transition: "left .6s cubic-bezier(.4,0,.2,1)",
        }} />
        <div className="mono" style={{ position: "absolute", left: 8, top: 10, fontSize: 10, color: C.bull, letterSpacing: ".12em" }}>BUYERS</div>
        <div className="mono" style={{ position: "absolute", right: 8, top: 10, fontSize: 10, color: C.bear, letterSpacing: ".12em" }}>SELLERS</div>
      </div>

      <div className="krt-cols3" style={{ marginTop: 10, gap: 8 }}>
        {chips.map(([k, v, col]) => (
          <div key={k} style={{ background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "7px 9px" }}>
            <div className="mono" style={{ fontSize: 9, color: C.dim, letterSpacing: ".12em" }}>{k}</div>
            <div className="mono" style={{ fontSize: 11.5, color: v === DASH ? C.faint : col, marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- stage rail ---------------- */
function StageRail({ stage }) {
  return (
    <div style={{ display: "flex", gap: 3, marginTop: 10 }}>
      {STAGES.map((s, i) => {
        const done = i <= stage;
        const isNow = i === stage;
        return (
          <div key={s} style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              height: 3, borderRadius: 2,
              background: done ? (isNow ? C.saffron : C.saffron + "77") : C.lineSoft,
              boxShadow: isNow ? `0 0 8px ${C.saffron}88` : "none",
            }} />
            <div className="mono" style={{
              fontSize: 8, marginTop: 4, letterSpacing: ".06em", textAlign: "center",
              color: isNow ? C.saffron : done ? C.dim : "#3D4658",
              overflow: "hidden", textOverflow: "ellipsis",
            }}>{s}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- the contract to actually trade ----------------
   Every board that names a stock should also name the option, its premium,
   and the plan in premium terms. A trader holding a call does not act on a
   stock level, so showing only the underlying was the wrong unit. */
function Stars({ n, of = 5 }) {
  const full = Math.max(0, Math.min(of, Math.round(n)));
  return (
    <span className="mono" style={{ fontSize: 11, color: C.gold, letterSpacing: "1px" }}>
      {"★".repeat(full)}<span style={{ color: C.faint }}>{"★".repeat(of - full)}</span>
    </span>
  );
}

/* score plus liquidity, expressed the way a trader reads confidence */
function confidenceOf(score, opt) {
  let n = !has(score) ? 0 : score >= 90 ? 5 : score >= 80 ? 4 : score >= 70 ? 3 : score >= 60 ? 2 : 1;
  const why = [];
  if (opt && opt.liquid === false) { n = Math.max(1, n - 1); why.push("wide spread"); }
  if (opt && !opt.prem) { n = Math.min(n, 1); why.push("no live premium"); }
  return { stars: n, why };
}

/* ---------------- what to actually do, right now ----------------
   A premium and a target still leave the trader to work out whether this is
   an entry, a chase, or already gone. The engine knows where price sits
   against the zone and the first target, so it should say so. */
function actionFor(opt, score) {
  const p = opt && opt.plan;
  if (!p || !p.ok || !has(opt.prem)) {
    return { label: "NO PLAN", color: C.dim,
             note: "No usable premium plan on this row, so there is nothing to act on." };
  }
  const prem = opt.prem;
  if (opt.liquid === false) {
    return { label: "SKIP · WIDE SPREAD", color: C.bear,
             note: "The spread is wide enough that you pay it twice. Skip unless it tightens." };
  }
  if (has(p.t1) && prem >= p.t1) {
    return { label: "TOO LATE · T1 GONE", color: C.bear,
             note: `Premium is already past T1 (${rupee(p.t1)}). The move you were paid for `
                   + `has happened; entering here buys the risk without the reward.` };
  }
  if (has(p.sl) && prem <= p.sl) {
    return { label: "INVALID · BELOW STOP", color: C.bear,
             note: "Premium is already at or under the stop. This plan is dead, not cheap." };
  }
  if (has(p.entry_low) && has(p.entry_high) && prem >= p.entry_low && prem <= p.entry_high) {
    const strong = (score || 0) >= 80;
    return { label: strong ? "ENTRY ZONE · GOOD ODDS" : "ENTRY ZONE · THIN ODDS",
             color: strong ? C.bull : C.saffron,
             note: strong
               ? "Premium is inside the planned zone and the setup scored well. This is the entry."
               : "Premium is inside the zone, but the setup scored low. Half size at most." };
  }
  if (has(p.entry_high) && prem > p.entry_high) {
    const ext = ((prem - p.entry_high) / p.entry_high) * 100;
    return { label: `EXTENDED +${num(ext, 1)}%`, color: C.saffron,
             note: `Already ${num(ext, 1)}% above the zone. The stop is now further away `
                   + `than planned, so the risk you take is bigger than the plan assumed.` };
  }
  return { label: "WAIT FOR ZONE", color: C.dim,
           note: `Premium is below the zone. Wait for ${rupee(p.entry_low)} rather than guessing a bottom.` };
}

function ActionLine({ opt, score }) {
  const a = actionFor(opt, score);
  return (
    <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 3,
      background: `${a.color}12`, border: `1px solid ${a.color}55` }}>
      <div className="mono" style={{ fontSize: 10.5, color: a.color, letterSpacing: ".1em", fontWeight: 600 }}>
        {a.label}
      </div>
      <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 3, lineHeight: 1.55 }}>
        {a.note}
      </div>
    </div>
  );
}


function OptionPlan({ opt, score, compact }) {
  if (!opt) {
    return (
      <div className="mono" style={{ fontSize: 10, color: C.faint, marginTop: 6, lineHeight: 1.5 }}>
        No option contract quoted for this row — the strike or its premium did not come back.
      </div>
    );
  }
  const p = opt.plan;
  const conf = confidenceOf(score, opt);
  return (
    <div style={{ marginTop: 8, padding: 10, background: C.raised,
      border: `1px solid ${opt.liquid ? C.lineSoft : C.bear + "55"}`, borderRadius: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>
          {text(opt.symbol, `${num(opt.strike, 0)}`)}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Stars n={conf.stars} />
          <span className="mono" style={{ fontSize: 13, color: C.text }}>{rupee(opt.prem)}</span>
        </span>
      </div>

      {opt.legs_source === "derived" && (
        <div className="mono" style={{ fontSize: 9, color: C.saffron, marginTop: 4, lineHeight: 1.5 }}>
          This row had no plan of its own — the stop and targets below are the standard ATR ladder
          built from the stock, not a scored setup.
        </div>
      )}
      <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 4 }}>
        strike {num(opt.strike, 0)} · exp {text(opt.expiry, "")}
        {has(opt.lotsize) ? ` · lot ${intl(opt.lotsize)}` : ""}
        {opt.quoted_at ? ` · quoted ${text(opt.quoted_at)}` : ""}
        {opt.liquid === false ? " · WIDE SPREAD" : ""}
      </div>

      {p && p.ok ? (
        <>
          <div className="mono" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.9 }}>
            <div><span style={{ color: C.dim }}>ENTRY </span>
              <span style={{ color: C.text }}>{rupee(p.entry_low)} – {rupee(p.entry_high)}</span></div>
            <div><span style={{ color: C.dim }}>SL </span>
              <span style={{ color: C.bear }}>{rupee(p.sl)}</span>
              {has(p.risk_per_unit) ? <span style={{ color: C.faint }}> (risk {rupee(p.risk_per_unit)}/unit)</span> : null}</div>
            <div><span style={{ color: C.dim }}>T1 </span><span style={{ color: C.bull }}>{rupee(p.t1)}</span>
              <span style={{ color: C.dim }}>  T2 </span><span style={{ color: C.bull }}>{rupee(p.t2)}</span>
              <span style={{ color: C.dim }}>  T3 </span><span style={{ color: C.bull }}>{rupee(p.t3)}</span></div>
            {has(p.rr) && <div><span style={{ color: C.dim }}>R:R at T2 </span>
              <span style={{ color: C.saffron }}>1 : {num(p.rr, 2)}</span></div>}
            {!compact && has(p.cost_per_lot) && (
              <div><span style={{ color: C.dim }}>ONE LOT </span>
                <span style={{ color: C.text }}>{rupee(p.cost_per_lot, 0)}</span>
                {has(p.risk_per_lot) ? <span style={{ color: C.bear }}> · risk {rupee(p.risk_per_lot, 0)}</span> : null}</div>
            )}
          </div>
          {!compact && (
            <div className="mono" style={{ fontSize: 9, color: C.faint, marginTop: 8, lineHeight: 1.5 }}>
              {text(p.basis)}
            </div>
          )}
        </>
      ) : (
        <div className="mono" style={{ fontSize: 10, color: C.saffron, marginTop: 8, lineHeight: 1.5 }}>
          {text(p && p.why,
            "This row has no stop or targets on the underlying, so there is nothing to convert "
            + "into premium levels. Open it from the CE / PE board, where the setup carries a "
            + "full plan.")}
        </div>
      )}
      {!compact && <ActionLine opt={opt} score={score} />}
      {conf.why.length > 0 && (
        <div className="mono" style={{ fontSize: 9, color: C.bear, marginTop: 6 }}>
          confidence reduced — {conf.why.join(", ")}
        </div>
      )}
    </div>
  );
}


/* ---------------- setup card ---------------- */
function SetupCard({ s, onOpen, active }) {
  return (
    <button
      onClick={() => onOpen(s.id)}
      className="krt-in"
      style={{
        display: "block", width: "100%", textAlign: "left",
        background: active ? C.raised : C.panel,
        borderTop: `1px solid ${active ? C.saffron + "66" : C.line}`,
        borderRight: `1px solid ${active ? C.saffron + "66" : C.line}`,
        borderBottom: `1px solid ${active ? C.saffron + "66" : C.line}`,
        borderLeft: `3px solid ${tierColor(s.tier)}`,
        borderRadius: 4, padding: 12, marginBottom: 8, transition: "border-color .2s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>
            {text(s.sym)} <span style={{ color: s.side === "CE" ? C.bull : C.bear }}>{text(s.side, "")}</span>
          </div>
          <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>
            Trigger · {s.trigger}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <Tag color={tierColor(s.tier)}>{s.tier}</Tag>
          <div className="mono" style={{ fontSize: 19, fontWeight: 600, marginTop: 5, color: s.score >= 90 ? C.gold : C.text }}>
            {Math.round(s.score)}
          </div>
        </div>
      </div>

      <div className="mono" style={{ display: "flex", gap: 14, marginTop: 9, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: C.dim }}>LTP <span style={{ color: C.text }}>{rupee(s.ltp)}</span></span>
        <span style={{ color: C.dim }}>SL <span style={{ color: C.bear }}>{rupee(s.sl)}</span></span>
        <span style={{ color: C.dim }}>Tgt <span style={{ color: C.bull }}>{s.tgts.length ? s.tgts.map((t) => num(t)).join(" / ") : DASH}</span></span>
        <span style={{ color: C.dim }}>Vol <span style={{ color: (s.volRatio || 0) >= 1.5 ? C.bull : C.text }}>{has(s.volRatio) ? `${num(s.volRatio, 1)}×` : DASH}</span></span>
      </div>

      <OptionPlan opt={s.option} score={s.score} compact />
      <StageRail stage={s.stage} />
    </button>
  );
}

/* A setup is only tradable when the whole plan exists. Rule: never present a
   "best setup" built from a strike and a premium alone - without an entry, a
   stop and targets there is nothing to act on, and showing one anyway invites
   the trader to fill the gaps themselves. */
function planComplete(opt) {
  const p = opt && opt.plan;
  return !!(opt && has(opt.prem) && p && p.ok
            && has(p.entry_low) && has(p.entry_high)
            && has(p.sl) && has(p.t1) && has(p.t2) && has(p.t3));
}

function Incomplete({ what, why }) {
  return (
    <div style={{ border: `1px solid ${C.saffron}55`, background: `${C.saffron}0E`,
      borderRadius: 4, padding: 12 }}>
      <div className="mono" style={{ fontSize: 10.5, color: C.saffron, letterSpacing: ".12em" }}>
        DATA INCOMPLETE · NO TRADE
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: C.text, marginTop: 6, lineHeight: 1.6 }}>
        {what} {why}
      </div>
      <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 6, lineHeight: 1.55 }}>
        Entry, stop and targets are not being estimated to fill the gap. Wait for confirmation.
      </div>
    </div>
  );
}

/* ---------------- decision-first primitives ----------------
   The board used to lead with raw sub-scores and let the trader assemble a
   decision. These invert that: verdict first, evidence underneath, working
   behind a toggle. Nothing new is computed - the same numbers are ordered
   by how quickly they answer "what do I do". */
const BANDS = [
  [80, "PRIME",  "🔥", C.gold],
  [70, "STRONG", "🟢", C.bull],
  [60, "WATCH",  "🟡", C.saffron],
  [0,  "LOW",    "⚪", C.lite],
];
function band(score) {
  const b = BANDS.find(([min]) => (score || 0) >= min) || BANDS[BANDS.length - 1];
  return { label: b[1], icon: b[2], color: b[3] };
}

const STAGE_ICON = ["", "", "🟡", "✅", "🎯", "🎯", "🎯"];

/* Trigger conditions, written from the row's own numbers. A high score is
   never an entry on its own - the conditions below are what turn it into one. */
function triggerConditions(s) {
  const out = [];
  const up = s.side === "CE";
  const lvl = up ? (s.levels || {}).pdh : (s.levels || {}).pdl;
  if (has(lvl)) out.push({ k: `Stock ${up ? "above" : "below"} ${rupee(lvl)}`,
                           ok: has(s.ltp) && (up ? s.ltp > lvl : s.ltp < lvl) });
  out.push({ k: "Volume above 1.5x average",
             ok: has(s.volRatio) ? s.volRatio >= 1.5 : null,
             note: has(s.volRatio) ? `${num(s.volRatio, 2)}x now` : "no live volume" });
  if (has(s.vwap)) out.push({ k: `${up ? "Holds above" : "Holds below"} VWAP ${rupee(s.vwap)}`,
                              ok: up ? s.ltp > s.vwap : s.ltp < s.vwap });
  const p = s.option && s.option.plan;
  if (p && p.ok) out.push({ k: `Premium clears ${rupee(p.entry_high)}`,
                            ok: has(s.option.prem) && s.option.prem >= p.entry_high });
  return out;
}

const CANCEL_IF = [
  "The stock loses VWAP on the side you are trading.",
  "Volume collapses back under average — the break had no one behind it.",
  "The breakout candle closes back inside the level.",
  "The index turns against the side.",
  "The option spread widens and liquidity thins.",
];

function CondList({ rows }) {
  return (
    <div style={{ marginTop: 6 }}>
      {rows.map((c, i) => (
        <div key={i} className="mono" style={{ fontSize: 10.5, lineHeight: 1.7,
          color: c.ok === true ? C.bull : c.ok === false ? C.dim : C.faint }}>
          <span style={{ width: 16, display: "inline-block" }}>
            {c.ok === true ? "✓" : c.ok === false ? "○" : "–"}
          </span>
          {text(c.k)}
          {c.note ? <span style={{ color: C.faint }}> · {text(c.note)}</span> : null}
        </div>
      ))}
    </div>
  );
}

/* the one card that answers "what do I do right now" */
function BestCall({ s, rank }) {
  const [open, setOpen] = useState(false);
  if (!s) return null;
  const b = band(s.score);
  const p = s.option && s.option.plan;
  const conds = triggerConditions(s);
  const metAll = conds.length > 0 && conds.every((c) => c.ok === true);
  const stage = STAGES[s.stage] || "WATCH";

  return (
    <div style={{ border: `1px solid ${b.color}66`, borderRadius: 4, padding: 14,
      background: `linear-gradient(180deg, ${b.color}0E, transparent 60%), ${C.panel}`,
      marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".18em" }}>
            {rank ? `#${rank} BEST SETUP` : "BEST CALL NOW"}
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 3 }}>
            {text(s.sym)}{s.option && has(s.option.strike) ? ` ${num(s.option.strike, 0)}` : ""}{" "}
            <span style={{ color: s.side === "CE" ? C.bull : C.bear }}>{text(s.side, "")}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 26, fontWeight: 600, color: b.color }}>
            {has(s.score) ? Math.round(s.score) : DASH}<span style={{ fontSize: 12, color: C.dim }}>/100</span>
          </div>
          <Tag color={b.color}>{b.icon} {b.label}</Tag>
        </div>
      </div>

      <div className="mono" style={{ fontSize: 11, color: C.saffron, marginTop: 8 }}>
        STATUS · {STAGE_ICON[s.stage] || ""} {stage}
        {metAll ? "" : " — conditions below are not all met yet"}
      </div>

      <div className="krt-cols2" style={{ marginTop: 10, gap: 10 }}>
        <div>
          <Row label="STOCK PRICE" value={rupee(s.ltp)} />
          <Row label="TRIGGER" value={text(s.trigger)} color={C.saffron} />
          <Row label="OPTION LTP" value={s.option ? rupee(s.option.prem) : DASH} />
        </div>
        <div>
          <Row label="ENTRY" value={p && p.ok ? `${rupee(p.entry_low)} – ${rupee(p.entry_high)}` : DASH} />
          <Row label="STOP LOSS" value={p && p.ok ? rupee(p.sl) : DASH} color={C.bear} />
          <Row label="T1 / T2 / T3" value={p && p.ok
            ? `${num(p.t1)} / ${num(p.t2)} / ${num(p.t3)}` : DASH} color={C.bull} />
          <Row label="RISK : REWARD" value={p && p.ok && has(p.rr) ? `1 : ${num(p.rr, 2)}` : DASH}
            color={C.saffron} />
        </div>
      </div>

      <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".14em", marginTop: 12 }}>
        TRIGGER CONDITIONS — CALL ONLY WHEN ALL CONFIRM
      </div>
      <CondList rows={conds} />

      {s.why && s.why.length > 0 && (
        <>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".14em", marginTop: 12 }}>
            WHY THIS WAS SELECTED
          </div>
          <CondList rows={s.why.slice(0, 6).map((w) => ({ k: w, ok: true }))} />
        </>
      )}

      <button onClick={() => setOpen(!open)} className="mono" style={{
        marginTop: 12, fontSize: 9.5, letterSpacing: ".1em", color: C.saffron,
        padding: "5px 12px", border: `1px solid ${C.saffron}55`, borderRadius: 2 }}>
        {open ? "HIDE DETAILS" : "VIEW DETAILS"}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <OptionPlan opt={s.option} score={s.score} />
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".14em", marginTop: 12 }}>
            CANCEL THE SETUP IF
          </div>
          {CANCEL_IF.map((c, i) => (
            <div key={i} className="mono" style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.7 }}>
              <span style={{ width: 16, display: "inline-block", color: C.bear }}>×</span>{c}
            </div>
          ))}
          {s.blocked && s.blocked.length > 0 && (
            <>
              <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".14em", marginTop: 12 }}>
                STILL MISSING
              </div>
              <CondList rows={s.blocked.map((w) => ({ k: w, ok: false }))} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* compact ranked list - one line each, no card walls */
function RankList({ rows, onPick, selected, hideBelow = 60 }) {
  const shown = rows.filter((r) => (r.score || 0) >= hideBelow);
  const hidden = rows.length - shown.length;
  if (!shown.length) {
    return <Empty>Nothing scored {hideBelow} or above. {rows.length
      ? `${rows.length} low-quality row${rows.length === 1 ? "" : "s"} are held back rather than shown.`
      : ""}</Empty>;
  }
  return (
    <>
      {shown.map((r, i) => {
        const b = band(r.score);
        const on = r.id === selected;
        return (
          <button key={r.id} onClick={() => onPick(r.id)} style={{
            display: "grid", gridTemplateColumns: "26px 1fr 46px 74px", gap: 8, width: "100%",
            alignItems: "center", textAlign: "left", padding: "9px 10px",
            borderBottom: `1px solid ${C.lineSoft}`,
            background: on ? `${C.saffron}12` : "transparent" }}>
            <span className="mono" style={{ fontSize: 10, color: i < 3 ? C.saffron : C.faint }}>
              #{i + 1}
            </span>
            <span style={{ fontSize: 12.5, minWidth: 0 }}>
              {text(r.sym)}{r.option && has(r.option.strike) ? ` ${num(r.option.strike, 0)}` : ""}{" "}
              <span style={{ color: r.side === "CE" ? C.bull : C.bear }}>{text(r.side, "")}</span>
              <span className="mono" style={{ display: "block", fontSize: 8.5, color: C.faint }}>
                {STAGES[r.stage] || ""}{r.option && has(r.option.prem) ? ` · ${rupee(r.option.prem)}` : ""}
              </span>
            </span>
            <span className="mono" style={{ fontSize: 14, textAlign: "right", color: b.color }}>
              {has(r.score) ? Math.round(r.score) : DASH}
            </span>
            <span className="mono" style={{ fontSize: 9.5, textAlign: "right", color: b.color }}>
              {b.icon} {b.label}
            </span>
          </button>
        );
      })}
      {hidden > 0 && (
        <div className="mono" style={{ fontSize: 9.5, color: C.faint, padding: "8px 10px", lineHeight: 1.5 }}>
          {hidden} row{hidden === 1 ? "" : "s"} below {hideBelow} are hidden. They are still in the
          scan — they are just not worth the screen space.
        </div>
      )}
    </>
  );
}


/* ---------------- setup dossier ---------------- */
function SetupDetail({ s }) {
  if (!s) return null;
  const risk = has(s.ltp) && has(s.sl) ? Math.abs(s.ltp - s.sl) : null;

  return (
    <div className="krt-in">
      <Panel title={`SETUP DOSSIER · ${text(s.sym)} ${text(s.side, "")}`} right={<Tag color={tierColor(s.tier)} solid>{s.tier}</Tag>}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div className="mono" style={{ fontSize: 34, fontWeight: 600, color: s.score >= 90 ? C.gold : C.text, lineHeight: 1 }}>
            {Math.round(s.score)}
          </div>
          <div>
            <div className="mono" style={{ fontSize: 10, color: C.dim, letterSpacing: ".12em" }}>KRT MASTER SCORE</div>
            <div className="mono" style={{ fontSize: 10.5, color: C.saffron }}>
              Stage · {STAGES[s.stage]}{s.grade ? ` · Grade ${text(s.grade, "")}` : ""}{s.confidence ? ` · ${text(s.confidence, "")}` : ""}
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          {Object.entries(s.breakdown).map(([k, v]) => {
            const m = s.breakdownMax[k];
            const full = v >= m;
            return (
              <div key={k} style={{ display: "grid", gridTemplateColumns: "112px 1fr 38px", gap: 8, alignItems: "center", padding: "3px 0" }}>
                <span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{k.toUpperCase()}</span>
                <Meter v={v} max={m} color={full ? C.bull : v / m > 0.7 ? C.saffron : C.bear} />
                <span className="mono" style={{ fontSize: 10, color: C.dim, textAlign: "right" }}>{v}/{m}</span>
              </div>
            );
          })}
        </div>

        <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, marginBottom: 6 }}>WHY THIS SCORED</div>
        {s.why.length ? (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {s.why.map((w, i) => (
              <li key={i} className="mono" style={{ fontSize: 11, color: C.text, padding: "3px 0 3px 12px", position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: C.saffron }}>›</span>{w}
              </li>
            ))}
          </ul>
        ) : <div className="mono" style={{ fontSize: 10.5, color: C.faint }}>No passing check carried a note.</div>}

        {s.blocked.length > 0 && (
          <>
            <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "12px 0 6px" }}>WHAT IS MISSING</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {s.blocked.map((w, i) => (
                <li key={i} className="mono" style={{ fontSize: 11, color: C.dim, padding: "3px 0 3px 12px", position: "relative" }}>
                  <span style={{ position: "absolute", left: 0, color: C.bear }}>×</span>{w}
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel title="LEVELS ON THE TAPE" style={{ marginTop: 12 }}>
        <Row label="LTP" value={rupee(s.ltp)} />
        <Row label="VWAP" value={rupee(s.vwap)} color={has(s.vwap) && has(s.ltp) ? (s.ltp > s.vwap ? C.bull : C.bear) : undefined} />
        <Row label="PREV DAY HIGH / LOW" value={has(s.levels.pdh) ? `${rupee(s.levels.pdh)} / ${rupee(s.levels.pdl)}` : DASH} />
        <Row label="PREV WEEK HIGH / LOW" value={has(s.levels.pwh) ? `${rupee(s.levels.pwh)} / ${rupee(s.levels.pwl)}` : DASH} />
        <Row label="PREV MONTH HIGH / LOW" value={has(s.levels.pmh) ? `${rupee(s.levels.pmh)} / ${rupee(s.levels.pml)}` : DASH} />
        <Row label="EMA 20 / 50 / 200" value={has(s.ema20) ? `${num(s.ema20, 1)} / ${num(s.ema50, 1)} / ${num(s.ema200, 1)}` : DASH} />
        <Row label="EMA STACK" value={text(s.stack)} />
        <Row label="ATR" value={has(s.atr) ? num(s.atr) : DASH} />
        <Row label="VOLUME vs AVERAGE" value={has(s.volRatio) ? `${num(s.volRatio, 2)}×` : DASH}
          color={has(s.volRatio) ? (s.volRatio >= 1.5 ? C.bull : C.saffron) : undefined} />
        <Row label="LEVELS TAKEN" value={has(s.levelCount) ? s.levelCount : DASH} />
        <Row label="DAY OPEN / HIGH / LOW"
          value={has(s.dayHigh) ? `${num(s.dayOpen)} / ${num(s.dayHigh)} / ${num(s.dayLow)}` : DASH} />
        <Row label="PRICE FROM" value={s.priceSource || DASH}
          color={s.quoted ? C.bull : C.saffron} />
        <Row label="PREV CLOSE FROM" value={s.prevSource === "quote" ? "broker quote" : s.prevSource ? "daily candle" : DASH}
          color={s.prevSource === "quote" ? C.bull : C.saffron} />
        <Row label="LEVELS DATED" value={s.prevDate || DASH}
          color={s.noTodayCandle ? C.saffron : undefined} />
        {s.noTodayCandle && (
          <div className="mono" style={{ fontSize: 10, color: C.saffron, marginTop: 8, lineHeight: 1.5 }}>
            The broker has not published today's daily candle yet, so these levels and the day's
            change are measured against {s.prevDate || "the last session on file"}. They are correct
            for that date — just check the date before treating a break as fresh.
          </div>
        )}
      </Panel>

      <Panel title="THE CONTRACT TO TRADE" style={{ marginTop: 12 }}>
        <OptionPlan opt={s.option} score={s.score} />
      </Panel>

      <Panel title="UNDERLYING MATHS · PER SHARE" style={{ marginTop: 12 }}>
        <Row label="ENTRY REFERENCE (LTP)" value={rupee(s.ltp)} />
        <Row label="STOP LOSS" value={rupee(s.sl)} color={C.bear} />
        <Row label="RISK PER UNIT" value={has(risk) ? rupee(risk) : DASH} color={C.bear} />
        {s.tgts.map((t, i) => (
          <Row key={i} label={`TARGET ${i + 1}`} value={rupee(t)} color={C.bull} />
        ))}
        <Row label="R:R AT T2" value={has(s.rr) ? `1 : ${num(s.rr, 2)}` : DASH} color={C.saffron} />
        {s.capped && <Row label="TARGET LADDER" value="TRIMMED — outside prime window" color={C.saffron} />}
        <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
          These are levels on the stock itself. The panel above converts them into premium for the
          contract you would actually buy.
        </div>
      </Panel>

      <Panel title="BREAK CONFIRMATION" style={{ marginTop: 12 }}>
        {s.fake ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Tag color={s.fake.ok ? C.bull : C.bear} solid>{s.fake.ok ? "CONFIRMED" : "FAKEOUT RISK"}</Tag>
            <span className="mono" style={{ fontSize: 11, color: C.dim }}>{text(s.fake.msg)}</span>
          </div>
        ) : <Empty>The fakeout filter has not reported on this setup.</Empty>}
      </Panel>
    </div>
  );
}

/* ============================================================
   TABS
   ============================================================ */

function CommandTab({ feed, openSetup }) {
  const snap = feed.snap;
  if (!snap) return <WarmingPanel feed={feed} />;

  const setups = feed.setups;
  const gold = setups.filter((s) => s.tier === "GOLD");
  const sectors = snap.sector_rows || [];
  const near = snap.near_trigger || [];
  const movers = snap.movers || {};
  const decision = snap.decision || {};
  const armed = near.filter((n) => has(n.distance)).slice(0, 1)[0];
  const leaders = (movers.volume_shockers || movers.gainers || []).slice(0, 20);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel pad={16} style={{ background: `radial-gradient(120% 140% at 50% -20%, ${C.saffron}14, transparent 60%), ${C.panel}` }}>
        <MoodBar mood={feed.mood} label={snap.bias_label} breadth={snap.breadth_panel}
          decision={decision} win={snap.window} fear={snap.fear} sectors={sectors} />
      </Panel>

      <Panel title="MARKET READ" right={<span className="mono krt-live" style={{ fontSize: 9.5, color: C.saffron }}>● {feed.stale ? "STALE" : "LIVE"}</span>}>
        {snap.read || decision.reason ? (
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, letterSpacing: "-.01em" }}>
            {text(snap.read, text(decision.reason))}
          </p>
        ) : <Empty>The engine has not published a read for this window.</Empty>}
        <div className="mono" style={{ fontSize: 11, color: C.saffron, marginTop: 10, lineHeight: 1.7,
          padding: 10, background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3 }}>
          {decision.side === "CE"
            ? "In plain terms: the engine is leaning to the CALL side. Look for CE setups; do not take PE against it."
            : decision.side === "PE"
            ? "In plain terms: the engine is leaning to the PUT side. Look for PE setups; do not take CE against it."
            : "In plain terms: neither side has cleared the bar. The engine is telling you to wait, not to pick one."}
          {has(decision.edge) ? ` The edge is ${num(decision.edge, 0)} points — how far the winning side is ahead of the other.` : ""}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <Tag color={decision.side === "CE" ? C.bull : decision.side === "PE" ? C.bear : C.saffron}>
            SIDE · {text(decision.side)}
          </Tag>
          {has(decision.edge) && <Tag color={C.dim}>EDGE · {num(decision.edge, 0)}</Tag>}
          {decision.best_sector && <Tag color={C.gold}>LEAD · {text(decision.best_sector)}</Tag>}
          {decision.sector_pick && (
            <Tag color={C.saffron}>PICK · {text(decision.sector_pick.sym)} {text(decision.sector_pick.side)}</Tag>
          )}
        </div>
        {decision.why && (
          <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.6 }}>{text(decision.why)}</div>
        )}
      </Panel>

      <div className="krt-cols">
        <div style={{ display: "grid", gap: 12 }}>
          <Panel title="GOLD SETUPS" right={<span className="mono" style={{ fontSize: 10, color: C.dim }}>{gold.length} live</span>} pad={10}>
            {gold.length ? gold.map((s) => <SetupCard key={s.id} s={s} onOpen={openSetup} />)
              : <Empty>Nothing has scored 90 or above. Silence is a valid output.</Empty>}
          </Panel>

          <Panel title="PRE-MOVE ENGINE · NEAR TRIGGER" pad={12}>
            {armed ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, gap: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>
                    {text(armed.sym)} <span className="mono" style={{ fontSize: 12, color: C.dim, fontWeight: 400 }}>{rupee(armed.ltp)}</span>
                  </div>
                  <Tag color={C.saffron} solid>{armed.side}</Tag>
                </div>
                <Row label="SCORE" value={armed.score} color={C.saffron} />
                <Row label="TIER" value={text(armed.tier)} />
                <Row label="SECTOR" value={text(armed.sector)} />
                <Row label={text(armed.level_name, "PENDING LEVEL")} value={rupee(armed.level)} color={C.saffron} />
                <Row label="DISTANCE TO LEVEL" value={has(armed.distance) ? `${num(armed.distance, 2)}%` : DASH} color={C.saffron} />
                <OptionPlan opt={armed.option} score={armed.score} />
                <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
                  {armed.blocking ? `Blocked by: ${text(armed.blocking, "unspecified")}` : "Price has not taken the level yet. Touching is not breaking."}
                </div>
                <div className="mono" style={{ fontSize: 10, color: C.saffron, marginTop: 6, lineHeight: 1.55 }}>
                  This is not a call yet. It becomes one only when {rupee(armed.level)} actually
                  trades with volume behind it — the premium above is what that contract costs right
                  now, so you can judge the cost before the trigger, not after.
                </div>
              </>
            ) : <Empty>Nothing is sitting within striking distance of an untaken level.</Empty>}
          </Panel>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <Panel title="VOLUME LEADERS" pad={0}
            right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{leaders.length}</span>}>
            {leaders.length ? (
              <div style={{ maxHeight: 340, overflowY: "auto" }}>
                {leaders.map((r, i) => (
                  <div key={r.sym + i} style={{
                    display: "grid", gridTemplateColumns: "22px 1fr 58px 46px", gap: 8, alignItems: "center",
                    padding: "7px 12px", borderBottom: `1px solid ${C.lineSoft}`,
                    background: i < 3 ? `${C.saffron}0A` : "transparent",
                  }}>
                    <span className="mono" style={{ fontSize: 10, color: i < 3 ? C.saffron : C.faint }}>{String(i + 1).padStart(2, "0")}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>{text(r.sym)}</span>
                    <span className="mono" style={{ fontSize: 11, color: (r.chg || 0) >= 0 ? C.bull : C.bear, textAlign: "right" }}>{signed(r.chg)}</span>
                    <span className="mono" style={{ fontSize: 11, textAlign: "right", color: (r.vol_ratio || 0) >= 2 ? C.gold : C.text }}>
                      {has(r.vol_ratio) ? `${num(r.vol_ratio, 1)}×` : DASH}
                    </span>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <OptionPlan opt={r.option} score={60} compact />
                    </div>
                  </div>
                ))}
              </div>
            ) : <Empty>No volume data on this scan.</Empty>}
          </Panel>

          <Panel title="SECTOR ROTATION" pad={12}>
            {sectors.length ? (
              <>
                {sectors.map((r) => {
                  const col = r.chg > 0.4 ? C.bull : r.chg < -0.4 ? C.bear : C.saffron;
                  return (
                    <div key={text(r.name, "?")} style={{ marginBottom: 9 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, gap: 8 }}>
                        <span className="mono" style={{ fontSize: 10.5, color: C.text }}>{text(r.name)}</span>
                        <span className="mono" style={{ fontSize: 10.5, color: col }}>
                          {signed(r.chg)} · {r.participation}% agree
                        </span>
                      </div>
                      <Meter v={Math.abs(r.chg) * 25} color={col} />
                    </div>
                  );
                })}
                {(() => {
                  const strong = sectors[0], weak = sectors[sectors.length - 1];
                  const pickIn = (name, side) => setups.find(
                    (x) => x.sector === name && x.side === side);
                  const ce = strong && pickIn(strong.name, "CE");
                  const pe = weak && pickIn(weak.name, "PE");
                  return (
                    <div style={{ marginTop: 12, borderTop: `1px solid ${C.lineSoft}`, paddingTop: 10 }}>
                      <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".12em", color: C.dim, marginBottom: 6 }}>
                        WHAT TO TAKE FROM EACH END
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: C.bull, lineHeight: 1.6 }}>
                        LEADING · {text(strong && strong.name)} {strong ? signed(strong.chg) : ""}
                      </div>
                      {ce ? <OptionPlan opt={ce.option} score={ce.score} compact />
                        : <div className="mono" style={{ fontSize: 10, color: C.faint, lineHeight: 1.5 }}>
                            No CE setup in the leading sector cleared the filter, so nothing is suggested here.
                          </div>}
                      <div className="mono" style={{ fontSize: 11, color: C.bear, lineHeight: 1.6, marginTop: 10 }}>
                        WEAKEST · {text(weak && weak.name)} {weak ? signed(weak.chg) : ""}
                      </div>
                      {pe ? <OptionPlan opt={pe.option} score={pe.score} compact />
                        : <div className="mono" style={{ fontSize: 10, color: C.faint, lineHeight: 1.5 }}>
                            No PE setup in the weakest sector cleared the filter, so nothing is suggested here.
                          </div>}
                    </div>
                  );
                })()}
                <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
                  Participation is how many members of the sector agree with its average — a sector
                  carried by one name shows a low number here.
                </div>
              </>
            ) : <Empty>No sector rows in this snapshot.</Empty>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function SetupsTab({ feed, openSetup, selected }) {
  const snap = feed.snap;
  if (!snap) return <WarmingPanel feed={feed} />;

  const setups = feed.setups;
  const ranked = [...setups].sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = ranked[0];
  const sel = setups.find((x) => x.id === selected) || best;
  const near = snap.near_trigger || [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title="⚡ KRT AI TRADE ENGINE" pad={12}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>
          {ranked.length} SCORED
        </span>}>
        {!best
          ? <Empty>Nothing cleared the level and volume filter on either side. An empty board is
              a decision too — it says there is no edge worth paying the spread for.</Empty>
          : planComplete(best.option)
          ? <BestCall s={best} rank={1} />
          : <Incomplete
              what={`${text(best.sym)} ${text(best.side, "")} scored ${Math.round(best.score)}, the highest on the board.`}
              why={best.option
                ? "Its contract quoted, but the premium plan would not resolve, so there is no entry or stop to give you."
                : "No option contract was quoted for it on this scan."} />}
      </Panel>

      <div className="krt-cols">
        <Panel title="🏆 LIVE SETUP RANKING" pad={0}
          right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>60+ ONLY</span>}>
          <RankList rows={ranked} onPick={openSetup} selected={sel && sel.id} />
        </Panel>

        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          {sel && sel.id !== (best && best.id) && <BestCall s={sel} />}

          <Panel title="🧠 AI DECISION" pad={12}>
            {sel ? (() => {
              const b = band(sel.score);
              const p = sel.option && sel.option.plan;
              return (
                <>
                  <Row label="PROBABILITY SCORE" value={`${Math.round(sel.score)} / 100`} color={b.color} />
                  <Row label="DIRECTION" value={sel.side === "CE" ? "BULLISH" : "BEARISH"}
                    color={sel.side === "CE" ? C.bull : C.bear} />
                  <Row label="SETUP QUALITY" value={`${b.icon} ${b.label}`} color={b.color} />
                  <Row label="STAGE" value={STAGES[sel.stage] || DASH} color={C.saffron} />
                  <Row label="OPTION LIQUIDITY"
                    value={!sel.option ? DASH : sel.option.liquid === false ? "POOR — WIDE SPREAD" : "GOOD"}
                    color={sel.option && sel.option.liquid === false ? C.bear : C.bull} />
                  <Row label="MARKET ALIGNMENT"
                    value={(snap.decision || {}).side === sel.side ? "YES"
                      : (snap.decision || {}).side === "WAIT" ? "MARKET SAYS WAIT" : "AGAINST THE MARKET"}
                    color={(snap.decision || {}).side === sel.side ? C.bull : C.bear} />
                  <Row label="RISK : REWARD" value={p && p.ok && has(p.rr) ? `1 : ${num(p.rr, 2)}` : DASH} />
                  <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.6 }}>
                    A high score is not a buy. It ranks the setup against the others on the board;
                    the trigger conditions decide whether it is an entry.
                  </div>
                </>
              );
            })() : <Empty>Pick a setup from the ranking to see the decision panel.</Empty>}
          </Panel>

          <Panel title="BLOCKED — WHAT IS STANDING IN THE WAY" pad={0}
            right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{near.length}</span>}>
            {near.length ? near.map((n, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                gap: 10, padding: "8px 12px", borderBottom: `1px solid ${C.lineSoft}` }}>
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 11 }}>
                    {text(n.sym)} <span style={{ color: n.side === "CE" ? C.bull : C.bear }}>{text(n.side, "")}</span>
                    <span style={{ color: C.dim }}> · {rupee(n.ltp)}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 9.5, color: C.bear, marginTop: 2 }}>{text(n.blocking)}</div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: C.faint }}>{n.score}</span>
              </div>
            )) : <Empty>Nothing is queued behind a blocking condition.</Empty>}
          </Panel>
        </div>
      </div>

      {sel && (
        <details>
          <summary className="mono" style={{ fontSize: 10, letterSpacing: ".12em", color: C.saffron,
            cursor: "pointer", padding: "8px 2px" }}>
            FULL DOSSIER · {text(sel.sym)} {text(sel.side, "")}
          </summary>
          <div style={{ marginTop: 10 }}><SetupDetail s={sel} /></div>
        </details>
      )}
    </div>
  );
}

function FlowTab({ feed }) {
  const snap = feed.snap;
  const [openSym, setOpenSym] = useState(null);
  if (!snap) return <WarmingPanel feed={feed} />;

  const cards = snap.index_cards || [];
  const radar = snap.index_radar || [];

  /* Both sides of each index are scored; the card only carries the winner, so
     the other side is read off the radar rather than guessed. */
  const sideScore = (sym, side) => {
    const r = radar.find((x) => x.sym === sym && x.side === side);
    return r ? r.score : null;
  };

  /* Rule: a card is only promoted to "best setup" when it carries an entry,
     a stop and targets. A strike with no plan is not a setup, and calling it
     one is how a trader ends up sizing a position off a blank. */
  const tradable = cards.filter((c) => c.option && c.option.plan && c.option.plan.ok);
  const best = [...tradable].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const bestIncomplete = !best
    && [...cards].sort((a, b) => (b.score || 0) - (a.score || 0))[0];

  const Signal = ({ c }) => {
    const ce = sideScore(c.sym, "CE"), pe = sideScore(c.sym, "PE");
    const tot = (ce || 0) + (pe || 0);
    const b = band(c.score);
    const idx = c.idx || {};
    const bias = c.score >= 70 ? (c.side === "CE" ? "BULLISH" : "BEARISH") : "SIDEWAYS";
    const action = c.qualified ? `${c.side} WATCH — conditions largely met`
      : c.score >= 70 ? `${c.side} LEAN — wait for the level`
      : "NO TRADE — wait for a breakout";
    const o = c.option;
    return (
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.lineSoft}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{text(c.sym)}</span>
            <span className="mono" style={{ fontSize: 11, color: C.dim }}> spot {num(idx.ltp)}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="mono" style={{ fontSize: 18, color: b.color }}>{c.score}<span style={{ fontSize: 10, color: C.dim }}>/100</span></div>
            <Tag color={bias === "BULLISH" ? C.bull : bias === "BEARISH" ? C.bear : C.saffron}>{bias}</Tag>
          </div>
        </div>

        {has(ce) && has(pe) && tot > 0 && (
          <div style={{ display: "flex", height: 5, marginTop: 8, borderRadius: 3, overflow: "hidden", background: C.lineSoft }}>
            <div style={{ width: `${(ce / tot) * 100}%`, background: C.bull }} />
            <div style={{ flex: 1, background: C.bear }} />
          </div>
        )}
        {has(ce) && has(pe) && (
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 4, display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: C.bull }}>CE {ce}</span><span style={{ color: C.bear }}>PE {pe}</span>
          </div>
        )}

        <div className="mono" style={{ fontSize: 11.5, color: c.qualified ? C.bull : C.saffron,
          marginTop: 10, lineHeight: 1.6 }}>
          ACTION · {action}
        </div>
        {has(idx.pdh) && has(idx.pdl) && (
          <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 4, lineHeight: 1.6 }}>
            Above {rupee(idx.pdh)} → CE watch · Below {rupee(idx.pdl)} → PE watch
          </div>
        )}

        {o && has(o.prem) && o.plan && o.plan.ok ? (
          <div style={{ marginTop: 8 }}>
            <div className="mono" style={{ fontSize: 10, color: C.dim, letterSpacing: ".1em" }}>
              BEST OPTION · LIVE {text(o.quoted_at, "")}
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: C.text, marginTop: 2 }}>
              {num(o.strike, 0)} {text(c.side, "")} · LTP {rupee(o.prem)}
            </div>
            <OptionPlan opt={o} score={c.score} />
          </div>
        ) : o && has(o.prem) ? (
          <div style={{ marginTop: 8, padding: 10, borderRadius: 3,
            background: `${C.bear}10`, border: `1px solid ${C.bear}44` }}>
            <div className="mono" style={{ fontSize: 10, color: C.bear, letterSpacing: ".1em" }}>
              DATA INCOMPLETE — NO TRADE
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 4, lineHeight: 1.55 }}>
              {num(o.strike, 0)} {text(c.side, "")} quotes at {rupee(o.prem)}, but no entry, stop or
              target could be produced. {text(o.why_untradable, "")}
            </div>
          </div>
        ) : (
          <div className="mono" style={{ fontSize: 10, color: C.faint, marginTop: 8, lineHeight: 1.5 }}>
            {text(c.note, "No contract quoted for this index on this scan.")}
          </div>
        )}

        <button onClick={() => setOpenSym(openSym === c.sym ? null : c.sym)} className="mono" style={{
          marginTop: 10, fontSize: 9.5, letterSpacing: ".1em", color: C.dim,
          padding: "4px 10px", border: `1px solid ${C.line}`, borderRadius: 2 }}>
          {openSym === c.sym ? "HIDE CHAIN DETAIL" : "CHAIN DETAIL"}
        </button>

        {openSym === c.sym && (
          <div style={{ marginTop: 10 }}>
            <Row label="PCR (NEAR STRIKES)" value={has(c.pcr) ? num(c.pcr, 2) : DASH}
              color={c.pcr > 1.15 ? C.bull : c.pcr < 0.85 ? C.bear : C.saffron} />
            <Row label="CE OI / PE OI" value={has(c.ce_oi) ? `${intl(c.ce_oi)} / ${intl(c.pe_oi)}` : DASH} />
            <Row label="CONTRACT" value={o && o.symbol ? o.symbol : DASH} />
            <Row label="PREV DAY HIGH / LOW" value={has(idx.pdh) ? `${num(idx.pdh)} / ${num(idx.pdl)}` : DASH} />
            <Row label="VWAP" value={has(idx.vwap) ? num(idx.vwap) : DASH} />
            {c.pcr_read && <div className="mono" style={{ fontSize: 10.5, color: C.saffron, marginTop: 6 }}>{text(c.pcr_read)}</div>}
            {(c.checks || []).length > 0 && (
              <CondList rows={c.checks.map((k) => ({ k: text(k.note, k.k), ok: !!k.ok }))} />
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {!best && bestIncomplete && (
        <Panel title="🔥 BEST INDEX SETUP NOW" pad={12}>
          <div className="mono" style={{ fontSize: 11, color: C.bear, letterSpacing: ".1em" }}>
            DATA INCOMPLETE — NO TRADE
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 6, lineHeight: 1.6 }}>
            {text(bestIncomplete.sym)} scored {bestIncomplete.score}, but no entry, stop or target
            could be produced for its contract.
            {bestIncomplete.option
              ? ` ${text(bestIncomplete.option.why_untradable, "The premium plan did not solve.")}`
              : " No strike was quoted for this index."}
            {" "}Nothing is promoted here without a complete plan.
          </div>
        </Panel>
      )}

      {best && (
        <Panel title="🔥 BEST INDEX SETUP NOW" pad={12}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 19, fontWeight: 700 }}>
              {text(best.sym)} {num(best.option.strike, 0)}{" "}
              <span style={{ color: best.side === "CE" ? C.bull : C.bear }}>{text(best.side, "")}</span>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="mono" style={{ fontSize: 22, color: band(best.score).color }}>{best.score}<span style={{ fontSize: 11, color: C.dim }}>/100</span></div>
              <Tag color={best.qualified ? C.bull : C.saffron}>{best.qualified ? "READY" : "NOT CONFIRMED"}</Tag>
            </div>
          </div>
          <OptionPlan opt={best.option} score={best.score} />
        </Panel>
      )}

      <Panel title="⚡ INDEX LIVE SIGNAL BOARD" pad={0}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>CE / PE / WAIT</span>}>
        {cards.length ? cards.map((c) => <Signal key={text(c.sym, "?")} c={c} />)
          : <Empty>No index option cards in this snapshot. The chain needs a connected broker.</Empty>}
      </Panel>

      <div className="mono" style={{ fontSize: 10, color: C.dim, lineHeight: 1.6, padding: "0 2px" }}>
        Gamma maps, OI velocity, IV percentile and Greeks are not shown. The backend does not
        compute them, and a number that looks precise but was invented is worse on this screen
        than an absent one.
      </div>
    </div>
  );
}

function RadarTab({ feed }) {
  const snap = feed.snap;
  if (!snap) return <WarmingPanel feed={feed} />;

  const scanners = snap.scanners || {};
  const surges = snap.surges || [];
  const breakout = snap.breakout_radar || [];
  const movers = snap.movers || {};

  const Bucket = ({ title, rows, side }) => (
    <Panel title={title} pad={0} right={<Tag color={side === "CE" ? C.bull : C.bear}>{(rows || []).length}</Tag>}>
      {rows && rows.length ? rows.map((r, i) => (
        <div key={r.sym + i} style={{ padding: "9px 12px", borderBottom: `1px solid ${C.lineSoft}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{text(r.sym)}</span>
            <span className="mono" style={{ fontSize: 11, color: side === "CE" ? C.bull : C.bear }}>
              {r.count}/7 · {rupee(r.ltp)}
            </span>
          </div>
          <Meter v={r.count} max={7} color={side === "CE" ? C.bull : C.bear} />
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 5, lineHeight: 1.5 }}>
            {text(r.conf, "")}{r.sector ? ` · ${text(r.sector, "")}` : ""}{has(r.vol_ratio) ? ` · ${num(r.vol_ratio, 1)}× vol` : ""}
          </div>
          {r.hits && r.hits.length > 0 && (
            <div className="mono" style={{ fontSize: 9, color: C.faint, marginTop: 3 }}>{r.hits.map((x) => text(x, "")).filter(Boolean).join(" · ")}</div>
          )}
          <OptionPlan opt={r.option} score={(r.count || 0) * 14} compact />
        </div>
      )) : <Empty>Nothing in this bucket right now.</Empty>}
    </Panel>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="krt-cols2">
        <Bucket title="BREAKOUT · ABOVE PREV DAY HIGH" rows={scanners.breakout} side="CE" />
        <Bucket title="BREAKDOWN · BELOW PREV DAY LOW" rows={scanners.breakdown} side="PE" />
      </div>

      <div className="krt-cols2">
        <Bucket title="OPENING RANGE UP" rows={scanners.orb_up} side="CE" />
        <Bucket title="OPENING RANGE DOWN" rows={scanners.orb_down} side="PE" />
      </div>

      <Panel title="ABNORMAL MOVE · FLAGGED, NEVER AUTO-TRADED" pad={0}
        right={<Tag color={surges.length ? C.saffron : C.dim}>{surges.length}</Tag>}>
        {surges.length ? surges.map((s, i) => (
          <div key={s.sym + i} style={{
            padding: "11px 14px", borderBottom: `1px solid ${C.lineSoft}`,
            background: s.kind === "CRASH" ? `${C.bear}0A` : `${C.bull}0A`,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{text(s.sym)}</span>
                <Tag color={s.kind === "CRASH" ? C.bear : C.bull} solid>{s.kind}</Tag>
              </div>
              <span className="mono" style={{ fontSize: 12, color: s.kind === "CRASH" ? C.bear : C.bull }}>
                {signed(s.pct)} in {s.minutes}m
              </span>
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
              {has(s.vol_ratio) ? `${num(s.vol_ratio, 1)}× volume` : "volume unknown"}
              {" · "}{s.vwap_lost ? "VWAP side confirms" : "VWAP does not confirm"}
              {" · "}{s.level_broken ? "level broken" : "level intact"}
            </div>
          </div>
        )) : <Empty>No abnormal moves flagged in the current window.</Empty>}
      </Panel>

      <Panel title="LEVEL BREAK ENGINE · PDH / PWH / PMH" pad={0}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{breakout.length}</span>}>
        {breakout.length ? (
          <>
            <div className="mono" style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 70px 60px 54px", gap: 8, padding: "8px 14px", fontSize: 9, letterSpacing: ".1em", color: C.dim, borderBottom: `1px solid ${C.lineSoft}` }}>
              <span>SYMBOL</span><span>PENDING LEVEL</span>
              <span style={{ textAlign: "right" }}>LEVEL</span>
              <span style={{ textAlign: "right" }}>AWAY</span>
              <span style={{ textAlign: "right" }}>VOL</span>
            </div>
            {breakout.map((r, i) => (
              <div key={r.sym + i} style={{
                display: "grid", gridTemplateColumns: "1fr 1.2fr 70px 60px 54px", gap: 8, alignItems: "center",
                padding: "7px 14px", borderBottom: `1px solid ${C.lineSoft}`,
                background: r.armed ? `${C.saffron}0A` : "transparent",
              }}>
                <span style={{ fontSize: 12 }}>
                  {text(r.sym)} {r.armed && <span className="mono" style={{ fontSize: 8.5, color: C.saffron }}>ARMED</span>}
                </span>
                <span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{text(r.name)}</span>
                <span className="mono" style={{ fontSize: 11, textAlign: "right", color: C.saffron }}>{rupee(r.level)}</span>
                <span className="mono" style={{ fontSize: 10.5, textAlign: "right", color: C.dim }}>
                  {has(r.distance) ? `${num(r.distance, 2)}%` : DASH}
                </span>
                <span className="mono" style={{ fontSize: 10, textAlign: "right", color: (r.vol_ratio || 0) >= 1.5 ? C.bull : C.dim }}>
                  {has(r.vol_ratio) ? `${num(r.vol_ratio, 1)}×` : DASH}
                </span>
                <div style={{ gridColumn: "1 / -1" }}>
                  <OptionPlan opt={r.option} score={r.armed ? 75 : 60} compact />
                </div>
              </div>
            ))}
            <div className="mono" style={{ fontSize: 9.5, color: C.dim, padding: "8px 14px", lineHeight: 1.5 }}>
              These levels have not been taken out yet. Touching a level is not breaking it.
            </div>
          </>
        ) : <Empty>Nothing is within range of an untaken level.</Empty>}
      </Panel>

      <div className="krt-cols2">
        <Panel title="TOP GAINERS" pad={0}>
          {(movers.gainers || []).length ? movers.gainers.map((r, i) => (
            <div key={r.sym + i} style={{ display: "grid", gridTemplateColumns: "1fr 70px 60px", gap: 8, alignItems: "center", padding: "7px 12px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <span style={{ fontSize: 12 }}>{text(r.sym)}</span>
              <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>{rupee(r.ltp)}</span>
              <span className="mono" style={{ fontSize: 11, textAlign: "right", color: C.bull }}>{signed(r.chg)}</span>
            </div>
          )) : <Empty>No movers on this scan.</Empty>}
        </Panel>
        <Panel title="TOP LOSERS" pad={0}>
          {(movers.losers || []).length ? movers.losers.map((r, i) => (
            <div key={r.sym + i} style={{ display: "grid", gridTemplateColumns: "1fr 70px 60px", gap: 8, alignItems: "center", padding: "7px 12px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <span style={{ fontSize: 12 }}>{text(r.sym)}</span>
              <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>{rupee(r.ltp)}</span>
              <span className="mono" style={{ fontSize: 11, textAlign: "right", color: C.bear }}>{signed(r.chg)}</span>
            </div>
          )) : <Empty>No movers on this scan.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

function NewsTab({ feed }) {
  const snap = feed.snap;
  if (!snap) return <WarmingPanel feed={feed} />;

  const news = snap.news || [];
  const bias = snap.news_bias || {};
  const toneCol = (b) => (b === "BULLISH" ? C.bull : b === "BEARISH" ? C.bear : C.dim);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title="NEWS BIAS" pad={12}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>CONTEXT, NOT A TRIGGER</span>}>
        <div className="mono" style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.65, marginBottom: 12 }}>
          These are headlines from the last eight hours that mention a symbol the scanner tracks.
          <span style={{ color: C.text }}> PUSHING UP and PUSHING DOWN list which of your symbols
          the news leans for or against</span>; ACTIONABLE counts the ones concrete enough to matter
          (an order win, a result, a regulatory action) rather than a routine price-update article.
          An em dash means nothing in your universe was mentioned — which is normal on a quiet day.
        </div>
        <div className="krt-cols3" style={{ gap: 10 }}>
          <div style={{ background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "10px 12px" }}>
            <div className="mono" style={{ fontSize: 9, color: C.dim, letterSpacing: ".12em" }}>PUSHING UP</div>
            <div className="mono" style={{ fontSize: 11.5, color: C.bull, marginTop: 4, lineHeight: 1.5 }}>
              {(bias.positive || []).length ? bias.positive.map((x) => text(x, "")).filter(Boolean).join(" · ") : DASH}
            </div>
          </div>
          <div style={{ background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "10px 12px" }}>
            <div className="mono" style={{ fontSize: 9, color: C.dim, letterSpacing: ".12em" }}>PUSHING DOWN</div>
            <div className="mono" style={{ fontSize: 11.5, color: C.bear, marginTop: 4, lineHeight: 1.5 }}>
              {(bias.negative || []).length ? bias.negative.map((x) => text(x, "")).filter(Boolean).join(" · ") : DASH}
            </div>
          </div>
          <div style={{ background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "10px 12px" }}>
            <div className="mono" style={{ fontSize: 9, color: C.dim, letterSpacing: ".12em" }}>ACTIONABLE</div>
            <div className="mono" style={{ fontSize: 22, color: C.saffron, marginTop: 3 }}>
              {has(bias.actionable) ? bias.actionable : DASH}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="HEADLINES" pad={0}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{news.length} IN LAST 8H</span>}>
        {news.length ? news.map((n, i) => (
          <div key={i} style={{
            padding: "12px 14px", borderBottom: `1px solid ${C.lineSoft}`,
            background: n.impact === "HIGH" ? `${C.saffron}0A` : "transparent",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 10, color: C.dim }}>{n.time}</span>
                {(n.symbols || []).map((s) => (
                  <span key={text(s, "?")} style={{ fontSize: 13, fontWeight: 600 }}>{text(s)}</span>
                ))}
                <Tag color={toneCol(n.bias)}>{text(n.bias)}</Tag>
                {n.impact === "HIGH" && <Tag color={C.saffron} solid>HIGH IMPACT</Tag>}
                {n.actionable && <Tag color={C.gold}>ACTIONABLE</Tag>}
              </div>
              <span className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".06em" }}>{text(n.tag, "")}</span>
            </div>
            <div style={{ fontSize: 12.5, color: C.text, marginTop: 6, lineHeight: 1.55 }}>
              {n.link ? (
                <a href={n.link} target="_blank" rel="noopener noreferrer" style={{ color: C.text, textDecoration: "none" }}>
                  {text(n.head)} <span style={{ color: C.saffron, fontSize: 10 }}>↗</span>
                </a>
              ) : text(n.head)}
            </div>
          </div>
        )) : <Empty>No headlines matched the scanned universe in the last eight hours.</Empty>}
      </Panel>

      <div className="mono" style={{ fontSize: 10, color: C.dim, lineHeight: 1.6, padding: "0 2px" }}>
        A headline is a reason to look, not a reason to enter. The engine only lets news raise or
        lower a score — it never triggers a setup on its own.
      </div>
    </div>
  );
}

/* ---------------- target ladder with completion state ----------------
   A target that has been hit must keep saying so, with the time it happened.
   A trade that finished must not still read RUNNING. */
function TargetLadder({ c }) {
  const hit = (t) => !!t;
  const rows = [
    ["T1", c.t1, c.t1_at], ["T2", c.t2, c.t2_at], ["T3", c.t3, c.t3_at],
  ];
  const stopped = String(c.result || c.status || "").toUpperCase().includes("SL");
  const done = stopped || hit(c.t3_at);
  return (
    <div style={{ marginTop: 8 }}>
      {rows.map(([k, v, at]) => (
        <div key={k} className="mono" style={{ fontSize: 11.5, lineHeight: 1.9,
          color: hit(at) ? C.bull : stopped ? C.faint : C.dim }}>
          <span style={{ width: 20, display: "inline-block" }}>{hit(at) ? "✅" : stopped ? "—" : "⏳"}</span>
          {k} {rupee(v)}
          {hit(at) ? <span style={{ color: C.bull }}> — HIT {text(at)}</span>
            : stopped ? <span style={{ color: C.faint }}> — not reached</span>
            : <span style={{ color: C.faint }}> — running</span>}
        </div>
      ))}
      <div className="mono" style={{ fontSize: 11.5, marginTop: 8,
        color: stopped ? C.bear : done ? C.bull : C.saffron, letterSpacing: ".08em" }}>
        {stopped ? `❌ SL HIT${c.closed_at ? ` — ${text(c.closed_at)}` : ""}`
          : done ? `✅ TRADE COMPLETED · T3 HIT ${text(c.t3_at)}`
          : hit(c.t2_at) ? "🎯 T2 DONE · T3 RUNNING"
          : hit(c.t1_at) ? "🎯 T1 DONE · T2 RUNNING"
          : c.triggered ? "⏳ IN POSITION" : "⌛ WAITING FOR ENTRY"}
      </div>
    </div>
  );
}


function JournalTab({ feed }) {
  const snap = feed.snap;
  const calls = feed.calls;
  if (!snap && !calls) return <WarmingPanel feed={feed} />;

  const risk = (snap && snap.risk) || {};
  const funnel = (calls && calls.funnel) || (snap && snap.funnel) || [];
  const today = (calls && calls.today) || [];
  const running = (calls && calls.running) || [];

  const usedPct = has(risk.day_pnl) && has(risk.loss_limit) && risk.loss_limit
    ? Math.min(100, Math.abs(Math.min(0, risk.day_pnl)) / risk.loss_limit * 100) : null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {risk.locked && (
        <Panel pad={12} style={{ background: `${C.bear}12`, border: `1px solid ${C.bear}55` }}>
          <div className="mono" style={{ fontSize: 11, color: C.bear, letterSpacing: ".1em", marginBottom: 6 }}>⚠ RISK MANAGER HAS LOCKED THE TERMINAL</div>
          <div className="mono" style={{ fontSize: 11, color: C.text, lineHeight: 1.6 }}>
            No new calls will be raised. Stop streak {risk.sl_streak ?? DASH} of {risk.max_sl ?? DASH} ·
            day P&amp;L {has(risk.day_pnl) ? `₹${intl(risk.day_pnl)}` : DASH} · manage open positions only.
          </div>
        </Panel>
      )}

      {running.length > 0 && (
        <Panel title="RUNNING CALLS" right={<span className="mono krt-live" style={{ fontSize: 9.5, color: C.bull }}>● IN POSITION</span>} pad={0}>
          {running.map((c, i) => (
            <div key={i} style={{ padding: "12px 14px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 17, fontWeight: 700 }}>
                  {text(c.underlying, text(c.sym, "?"))}{" "}
                  <span style={{ color: c.side === "CE" ? C.bull : C.bear }}>{text(c.side, "")}</span>
                </div>
                <div className="mono" style={{ fontSize: 16, color: C.text }}>{rupee(c.ltp)}</div>
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 2 }}>
                {text(c.symbol, "contract not recorded")}
                {has(c.score) ? ` · score ${c.score}` : ""}{c.tier ? ` · ${text(c.tier)}` : ""}
              </div>
              <div className="krt-cols2" style={{ marginTop: 8, gap: 10 }}>
                <div>
                  <Row label="ENTRY" value={rupee(c.entry)} />
                  <Row label="STOP LOSS" value={rupee(c.sl)} color={C.bear} />
                  <Row label="STATUS" value={text(c.status)} color={C.saffron} />
                  {has(c.entry) && has(c.ltp) && c.entry > 0 && (
                    <Row label="P&L NOW"
                      value={`${c.ltp >= c.entry ? "+" : ""}${num((c.ltp - c.entry) / c.entry * 100, 1)}%`}
                      color={c.ltp >= c.entry ? C.bull : C.bear} />
                  )}
                  {has(c.max_seen) && <Row label="HIGHEST SEEN" value={rupee(c.max_seen)} color={C.bull} />}
                  {has(c.min_seen) && <Row label="LOWEST SEEN" value={rupee(c.min_seen)} color={C.bear} />}
                </div>
                <div><TargetLadder c={c} /></div>
              </div>
              {c.advice && <div className="mono" style={{ fontSize: 10.5, color: C.saffron, marginTop: 8, lineHeight: 1.5 }}>{text(c.advice)}</div>}
              {c.timeline && (
                <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {c.timeline.filter((t) => t.t).map((t) => (
                    <span key={t.k}>{text(t.k, "")} <span style={{ color: C.text }}>{text(t.t, "")}</span></span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Panel>
      )}

      {(() => {
        const t = (calls && calls.today) || [];
        if (!t.length) return null;
        const filled = t.filter((c) => c.triggered);
        const n = (f) => filled.filter(f).length;
        const t3 = n((c) => c.t3_at), t2 = n((c) => c.t2_at && !c.t3_at);
        const t1 = n((c) => c.t1_at && !c.t2_at && !c.t3_at);
        const sl = n((c) => String(c.result || c.status || "").toUpperCase().includes("SL"));
        const open_ = filled.length - t1 - t2 - t3 - sl;
        const anyT1 = n((c) => c.t1_at);
        const rate = filled.length ? Math.round(100 * anyT1 / filled.length) : null;
        const cell = (label, v, col) => (
          <div style={{ background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "9px 10px" }}>
            <div className="mono" style={{ fontSize: 9, color: C.dim, letterSpacing: ".12em" }}>{label}</div>
            <div className="mono" style={{ fontSize: 20, color: col || C.text, marginTop: 2 }}>{v}</div>
          </div>
        );
        return (
          <Panel title="TODAY'S RESULT" pad={12}
            right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>FILLED CALLS ONLY</span>}>
            <div className="krt-cols3" style={{ gap: 8 }}>
              {cell("RAISED", t.length)}
              {cell("FILLED", filled.length, C.text)}
              {cell("NEVER FILLED", t.length - filled.length, C.dim)}
              {cell("T1 HIT", anyT1, C.bull)}
              {cell("STOPPED", sl, C.bear)}
              {cell("STILL OPEN", Math.max(0, open_), C.saffron)}
            </div>
            <div className="mono" style={{ fontSize: 12, color: C.text, marginTop: 12, lineHeight: 1.7 }}>
              {filled.length
                ? <>{filled.length} call{filled.length === 1 ? "" : "s"} filled today — {anyT1} reached
                    T1, {sl} stopped out{open_ > 0 ? `, ${open_} still running` : ""}.
                    {has(rate) ? ` That is a ${rate}% T1 rate on filled calls.` : ""}</>
                : "Calls were raised but none filled, so there is nothing to score yet."}
            </div>
            <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 8, lineHeight: 1.55 }}>
              Counted from calls that actually filled. A call that never reached its entry is
              neither a win nor a loss, and stops are counted in full — a hit rate that hides
              losers is not a hit rate.
            </div>
          </Panel>
        );
      })()}

      <div className="krt-cols2">
        <Panel title="RISK GUARDIAN">
          <Row label="DAILY LOSS LIMIT" value={has(risk.loss_limit) ? `₹${intl(risk.loss_limit)}` : DASH} />
          <Row label="DAY P&L" value={has(risk.day_pnl) ? `₹${intl(risk.day_pnl)}` : DASH}
            color={has(risk.day_pnl) ? (risk.day_pnl >= 0 ? C.bull : C.bear) : undefined} />
          <Row label="CONSECUTIVE SL" value={has(risk.sl_streak) ? `${risk.sl_streak} / ${risk.max_sl}` : DASH}
            color={has(risk.sl_streak) && risk.sl_streak > 0 ? C.saffron : undefined} />
          <Row label="OPEN POSITIONS" value={has(risk.open_count) ? risk.open_count : DASH} />
          <Row label="COOLDOWN" value={has(risk.cooldown_min) ? `${risk.cooldown_min} min` : DASH} />
          <Row label="STATUS" value={risk.locked ? "LOCKED" : has(risk.locked) ? "ACTIVE" : DASH}
            color={risk.locked ? C.bear : C.bull} />
          {has(usedPct) && <div style={{ marginTop: 12 }}><Meter v={usedPct} color={usedPct > 70 ? C.bear : C.saffron} /></div>}
          <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
            At the limit the board locks: <span style={{ color: C.bear }}>no new calls for the day</span>,
            regardless of setup quality.
          </div>
        </Panel>

        <Panel title="TODAY'S FUNNEL">
          {funnel.length ? (
            <>
              {funnel.map((f) => (
                <Row key={f.stage} label={String(f.stage).toUpperCase()} value={f.n} />
              ))}
              <div style={{ height: 10 }} />
              <Row label="CALLS RAISED TODAY" value={today.length} />
              <Row label="NET %" value={has(calls && calls.net_pct) ? `${num(calls.net_pct, 2)}%` : DASH}
                color={calls && calls.net_pct >= 0 ? C.bull : C.bear} />
            </>
          ) : <Empty>No calls have been raised today.</Empty>}
        </Panel>
      </div>

      {(() => {
        const done = (today || []).filter((c) => c.triggered &&
          (c.t1_at || c.t2_at || c.t3_at ||
           String(c.result || c.status || "").toUpperCase().includes("SL")));
        if (!done.length) return null;
        return (
          <Panel title="CLOSED & COMPLETED TODAY" pad={0}
            right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{done.length}</span>}>
            {done.map((c, i) => (
              <div key={i} style={{ padding: "12px 14px", borderBottom: `1px solid ${C.lineSoft}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>
                    {text(c.underlying, text(c.sym, "?"))}{" "}
                    <span style={{ color: c.side === "CE" ? C.bull : C.bear }}>{text(c.side, "")}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 13 }}>
                    entry {rupee(c.entry)} → {rupee(c.ltp)}
                    {has(c.entry) && has(c.ltp) && c.entry > 0 && (
                      <span style={{ color: c.ltp >= c.entry ? C.bull : C.bear }}>
                        {" "}({c.ltp >= c.entry ? "+" : ""}{num((c.ltp - c.entry) / c.entry * 100, 1)}%)
                      </span>
                    )}
                  </div>
                </div>
                <div className="mono" style={{ fontSize: 9.5, color: C.faint, marginTop: 2 }}>
                  {text(c.symbol, "")}
                </div>
                <TargetLadder c={c} />
              </div>
            ))}
            <div className="mono" style={{ fontSize: 9.5, color: C.dim, padding: "8px 14px", lineHeight: 1.55 }}>
              Completed and stopped calls stay here for the rest of the session. A finished trade
              must not keep reading RUNNING, and a loss must not quietly disappear.
            </div>
          </Panel>
        );
      })()}

      <Panel title="CALL LOG" pad={0} right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{today.length}</span>}>
        {today.length ? today.map((c, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 60px 70px 70px 90px", gap: 8, alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${C.lineSoft}` }}>
            <span style={{ fontSize: 12 }}>
              {text(c.underlying, text(c.sym, "?"))}{" "}
              <span style={{ color: c.side === "CE" ? C.bull : C.bear }}>{text(c.side, "")}</span>
              <span className="mono" style={{ fontSize: 9, color: C.faint, display: "block" }}>
                {text(c.symbol, "")}
              </span>
            </span>
            <span className="mono" style={{ fontSize: 10, color: C.dim, textAlign: "right" }}>
              {c.triggered ? "FILLED" : "MISSED"}
            </span>
            <span className="mono" style={{ fontSize: 10.5, textAlign: "right" }}>{rupee(c.entry)}</span>
            <span className="mono" style={{ fontSize: 10.5, textAlign: "right" }}>{rupee(c.ltp)}</span>
            <span className="mono" style={{ fontSize: 10, textAlign: "right",
              color: String(c.result || c.status || "").toUpperCase().includes("SL") ? C.bear
                : c.t1_at ? C.bull : C.dim }}>
              {text(c.badge, text(c.status))}
              {(() => {
                const e = c.entry, x = has(c.ltp) ? c.ltp : null;
                const pnl = has(e) && e && has(x) ? ((x - e) / e) * 100 : null;
                const closed = String(c.result || c.status || "").toUpperCase()
                  .match(/SL|EXIT|EXPIR/) || c.t3_at;
                if (!c.triggered || !has(pnl)) return null;
                return (
                  <span style={{ display: "block", fontSize: 10,
                    color: pnl >= 0 ? C.bull : C.bear }}>
                    {pnl >= 0 ? "+" : ""}{num(pnl, 1)}%{closed ? " final" : " now"}
                  </span>
                );
              })()}
              {(has(c.max_seen) || has(c.min_seen)) && (
                <span style={{ display: "block", fontSize: 8.5, color: C.faint }}>
                  peak {rupee(c.max_seen)} · low {rupee(c.min_seen)}
                </span>
              )}
              <span style={{ display: "block", fontSize: 8.5, color: C.faint }}>
                {c.t3_at ? `T3 ${c.t3_at}` : c.t2_at ? `T2 ${c.t2_at}` : c.t1_at ? `T1 ${c.t1_at}`
                  : c.closed_at ? `closed ${c.closed_at}` : c.entry_at ? `in ${c.entry_at}` : "not filled"}
              </span>
            </span>
          </div>
        )) : <Empty>Nothing raised today. A quiet log is not a broken one.</Empty>}
      </Panel>

      <div className="mono" style={{ fontSize: 10, color: C.dim, lineHeight: 1.6, padding: "0 2px" }}>
        Setup decay curves and end-of-day review notes are not shown — the backend does not record
        them, and writing them here would mean inventing your own trading history.
      </div>
    </div>
  );
}


/* ---------------- accumulation radar ---------------- */
function heatColor(score, thin) {
  if (!has(score)) return C.faint;
  if (thin) return C.faint;
  if (score >= 90) return C.bear;        // hottest
  if (score >= 80) return C.saffron;
  if (score >= 70) return C.gold;
  if (score >= 60) return C.dim;
  return C.faint;
}

function AccumCard({ r }) {
  const traps = r.traps || [];
  const tierCol = traps.length ? C.bear
    : r.thin ? C.dim
    : r.score >= 90 ? C.bear : r.score >= 80 ? C.bull
    : r.score >= 70 ? C.saffron : C.dim;

  return (
    <Panel
      title={`${text(r.sym)} ${has(r.strike) ? r.strike : ""} ${text(r.side, "")}`}
      right={<Tag color={tierCol} solid>{text(r.tier)}</Tag>}
      style={{ marginBottom: 12 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <div className="mono" style={{ fontSize: 32, fontWeight: 600, color: tierCol, lineHeight: 1 }}>
          {has(r.score) ? r.score : DASH}
        </div>
        <div>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".12em" }}>
            ACCUMULATION SCORE
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: C.saffron }}>
            {text(r.stage)}
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 10.5, color: C.text }}>{rupee(r.prem)}</div>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim }}>
            {r.measured}/{r.of} signals · {r.possible} pts measurable
          </div>
        </div>
      </div>

      {r.coverage_note && (
        <div className="mono" style={{
          fontSize: 10, color: C.dim, background: C.raised, border: `1px solid ${C.lineSoft}`,
          borderRadius: 3, padding: 10, marginBottom: 10, lineHeight: 1.55,
        }}>{text(r.coverage_note)}</div>
      )}

      {traps.length > 0 && (
        <div style={{
          background: `${C.bear}12`, border: `1px solid ${C.bear}55`,
          borderRadius: 3, padding: 10, marginBottom: 10,
        }}>
          <div className="mono" style={{ fontSize: 10, color: C.bear, letterSpacing: ".1em", marginBottom: 5 }}>
            ⚠ POSSIBLE TRAP — DO NOT ENTER ON THIS
          </div>
          {traps.map((t, i) => (
            <div key={i} className="mono" style={{ fontSize: 10.5, color: C.text, lineHeight: 1.55 }}>
              {text(t)}
            </div>
          ))}
        </div>
      )}

      {r.speed && (
        <Row label="ACCUMULATION SPEED"
          value={`${text(r.speed.label)} · ${r.speed.delta > 0 ? "+" : ""}${r.speed.delta} over ${r.speed.over_min}m`}
          color={r.speed.label === "RAPID" ? C.bull : r.speed.label === "FADING" ? C.bear : C.saffron} />
      )}
      {r.trail && r.trail.length > 1 && (
        <Row label="SCORE TRAIL" value={r.trail.join(" → ")} color={C.dim} />
      )}
      <Row label="OPEN INTEREST" value={intl(r.oi)} />
      <Row label="VOLUME" value={intl(r.vol)} />
      <Row label="SPREAD" value={has(r.spread) ? rupee(r.spread) : DASH} />
      <Row label="IMPLIED VOL"
        value={has(r.iv) ? `${num(r.iv, 2)}%${r.iv_source === "solved" ? " (solved)" : ""}` : DASH}
        color={has(r.iv) ? undefined : C.faint} />
      <Row label="DELTA" value={has(r.delta) ? num(r.delta, 3) : DASH} />
      <Row label="EXPIRY" value={text(r.expiry)} />
      <Row label="LOT SIZE" value={has(r.lotsize) ? intl(r.lotsize) : DASH} />
      <Row label="SAMPLES HELD" value={r.samples} />
      {r.iv_source === "solved" && (
        <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
          The broker quote carries no implied volatility, so this figure is solved from the premium
          with Black-Scholes. It is arithmetic on the quoted price, not a second data source.
        </div>
      )}

      <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "12px 0 6px" }}>
        SIGNAL BREAKDOWN
      </div>
      {(r.components || []).map((c) => (
        <div key={c.code} style={{
          display: "grid", gridTemplateColumns: "128px 1fr 44px", gap: 8,
          alignItems: "center", padding: "4px 0",
        }}>
          <span className="mono" style={{ fontSize: 9.5, color: c.available ? C.dim : C.faint }}>
            {text(c.label).toUpperCase()}
          </span>
          {c.available ? (
            <Meter v={c.earned} max={c.weight}
              color={c.earned >= c.weight ? C.bull : c.earned > 0 ? C.saffron : C.bear} />
          ) : (
            <span className="mono" style={{ fontSize: 9.5, color: C.faint }}>{text(c.detail)}</span>
          )}
          <span className="mono" style={{ fontSize: 9.5, textAlign: "right", color: c.available ? C.dim : C.faint }}>
            {c.available ? `${c.earned}/${c.weight}` : "n/a"}
          </span>
        </div>
      ))}
      {(r.components || []).filter((c) => c.available && c.detail).map((c) => (
        <div key={c.code + "d"} className="mono" style={{ fontSize: 9.5, color: C.faint, paddingLeft: 2, lineHeight: 1.5 }}>
          {text(c.label)}: {text(c.detail)}
        </div>
      ))}
    </Panel>
  );
}

function AccumTab({ feed }) {
  const snap = feed.snap;
  const [pick, setPick] = useState(null);
  const [open, setOpen] = useState(null);
  if (!snap) return <WarmingPanel feed={feed} />;

  const acc = snap.accumulation;
  if (!acc || acc.available === false) {
    return (
      <Panel title="⚡ OPTION STRIKE INTELLIGENCE">
        <Empty>{text(acc && acc.note,
          "No strike scan yet. This needs live strike quotes with open interest.")}</Empty>
      </Panel>
    );
  }

  const idxs = acc.indices || [];
  const ix = idxs.find((x) => x.sym === pick) || idxs[0];

  const BestStrike = ({ r, side }) => {
    if (!r) {
      return (
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 4, padding: 12 }}>
          <div className="mono" style={{ fontSize: 10, color: C.dim, letterSpacing: ".14em" }}>
            BEST {side} SETUP
          </div>
          <div className="mono" style={{ fontSize: 11, color: C.faint, marginTop: 8, lineHeight: 1.6 }}>
            NO TRADE on this side. Nothing scored 60 or above with clean coverage — the highest
            of a weak field is still a weak field.
          </div>
        </div>
      );
    }
    const blocked = (r.traps || []).length > 0 || r.thin;
    const b = band(r.score);
    const get = (code) => (r.components || []).find((c) => c.code === code);
    const line = (label, code) => {
      const c = get(code);
      return (
        <Row key={code} label={label}
          value={c ? (c.available ? (c.ok ? "STRONG" : "WEAK") : "n/a") : DASH}
          color={c && c.available ? (c.ok ? C.bull : C.bear) : undefined} />
      );
    };
    return (
      <div style={{ border: `1px solid ${blocked ? C.bear + "55" : b.color + "66"}`, borderRadius: 4,
        padding: 12, background: blocked ? `${C.bear}08` : `${b.color}0A` }}>
        <div className="mono" style={{ fontSize: 10, color: C.dim, letterSpacing: ".14em" }}>
          {side === "CE" ? "🏆" : "🔴"} BEST {side} SETUP
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {num(r.strike, 0)} <span style={{ color: side === "CE" ? C.bull : C.bear }}>{side}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="mono" style={{ fontSize: 20, color: b.color }}>
              {r.score}<span style={{ fontSize: 10, color: C.dim }}>/100</span>
            </div>
            <Tag color={blocked ? C.bear : b.color}>
              {blocked ? "NO TRADE" : `${b.icon} ${text(r.stage, b.label)}`}
            </Tag>
          </div>
        </div>
        <Row label="PREMIUM" value={rupee(r.prem)} />
        {line("OI BUILD-UP", "OI_VELOCITY")}
        {line("VOLUME", "VOLUME_BURST")}
        {line("MOMENTUM", "PREMIUM_HOLD")}
        {line("UNDERLYING", "UNDERLYING")}
        {has(r.iv) && <Row label="IMPLIED VOL" value={`${num(r.iv, 2)}%`} />}
        {blocked && (
          <div className="mono" style={{ fontSize: 10, color: C.bear, marginTop: 8, lineHeight: 1.55 }}>
            {(r.traps || [])[0] || text(r.coverage_note, "Coverage too thin to act on.")}
          </div>
        )}
        <button onClick={() => setOpen(open === `${side}best` ? null : `${side}best`)} className="mono"
          style={{ marginTop: 10, fontSize: 9.5, letterSpacing: ".1em", color: C.saffron,
            padding: "4px 10px", border: `1px solid ${C.saffron}55`, borderRadius: 2 }}>
          {open === `${side}best` ? "HIDE DETAILS" : "VIEW DETAILS"}
        </button>
        {open === `${side}best` && <div style={{ marginTop: 10 }}><AccumCard r={r} /></div>}
      </div>
    );
  };

  const Map = ({ side }) => {
    const rows = [...(ix[side] || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!rows.length) return null;
    const under = (x) => (x.components || []).find((c) => c.code === "UNDERLYING");
    const liq = (x) => (x.components || []).find((c) => c.code === "LIQUIDITY");
    const topClean = rows.find((r) =>
      !(r.traps || []).length && !r.thin && (r.score || 0) >= 60
      && (!under(r) || !under(r).available || under(r).ok)
      && (!liq(r) || !liq(r).available || liq(r).ok));
    return (
      <div style={{ marginBottom: 12 }}>
        <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".12em",
          color: side === "CE" ? C.bull : C.bear, marginBottom: 5 }}>{side} STRIKE MAP</div>
        {rows.map((r, i) => {
          const b = band(r.score);
          const trap = (r.traps || []).length > 0 || r.thin;
          /* The pick is not simply the top score. A strike that scores well on
             a wide spread, or with the underlying against it, is not the one to
             buy - the raw number would say otherwise. */
          const isBest = topClean && r.strike === topClean.strike && (r.score || 0) >= 60;
          return (
            <button key={i} onClick={() => setOpen(open === `${side}${r.strike}` ? null : `${side}${r.strike}`)}
              style={{ display: "grid", gridTemplateColumns: "1fr 46px 104px", gap: 8, width: "100%",
                alignItems: "center", textAlign: "left", padding: "7px 8px",
                borderBottom: `1px solid ${C.lineSoft}`,
                background: isBest ? `${side === "CE" ? C.bull : C.bear}1A` : "transparent",
                borderLeft: `3px solid ${isBest ? (side === "CE" ? C.bull : C.bear) : "transparent"}` }}>
              <span className="mono" style={{ fontSize: 12, color: C.text }}>
                {num(r.strike, 0)} {side}
                <span style={{ color: C.faint }}> · {rupee(r.prem)}</span>
              </span>
              <span className="mono" style={{ fontSize: 13, textAlign: "right", color: trap ? C.dim : b.color }}>
                {r.score}
              </span>
              <span className="mono" style={{ fontSize: 9, textAlign: "right",
                color: trap ? C.bear : isBest ? (side === "CE" ? C.bull : C.bear) : b.color }}>
                {trap ? "⚠ TRAP" : isBest ? "⭐ AI BEST PICK" : `${b.icon} ${b.label}`}
              </span>
              {open === `${side}${r.strike}` && (
                <div style={{ gridColumn: "1 / -1" }}><AccumCard r={r} /></div>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  if (!ix) return <Panel title="⚡ OPTION STRIKE INTELLIGENCE"><Empty>No index produced a quoted chain.</Empty></Panel>;

  /* A side's "best" is only a setup if it would actually be taken. The highest
     of a weak field is still a weak field, so anything under 60 is reported as
     NO TRADE rather than dressed up as the pick of the chain. */
  const bestOf = (side) => [...(ix[side] || [])]
    .filter((r) => !(r.traps || []).length && !r.thin && (r.score || 0) >= 60)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title={`⚡ OPTION STRIKE INTELLIGENCE · ${text(ix.sym)}`} pad={12}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>SPOT {num(ix.spot)}</span>}>
        {idxs.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {idxs.map((x) => (
              <button key={text(x.sym, "?")} onClick={() => setPick(x.sym)} className="mono" style={{
                fontSize: 10, padding: "4px 10px", borderRadius: 2,
                border: `1px solid ${x.sym === ix.sym ? C.saffron : C.line}`,
                color: x.sym === ix.sym ? C.saffron : C.dim }}>{text(x.sym)}</button>
            ))}
          </div>
        )}
        <div className="krt-cols2" style={{ gap: 10 }}>
          <BestStrike r={bestOf("CE")} side="CE" />
          <BestStrike r={bestOf("PE")} side="PE" />
        </div>
      </Panel>

      <Panel title="STRIKE MAP" pad={12}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>ATM ± 5 · TAP FOR DETAIL</span>}>
        <div className="mono" style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.6, marginBottom: 10 }}>
          The number is how strongly that strike looks like it is being accumulated — OI building,
          volume above its own average, premium holding. 🔥 is the highest that also passed the trap
          filter; ⚠ scored but failed it, so it is a warning rather than a pick.
        </div>
        <Map side="CE" />
        <Map side="PE" />
        <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 4, lineHeight: 1.6 }}>
          ⭐ AI BEST PICK is not just the highest score. A strike only earns it with a clean trap
          check, enough coverage, a score of 60 or more, the underlying agreeing and a spread worth
          paying. If no strike meets all of that, none is marked — that is a NO TRADE, not an
          oversight.
        </div>
      </Panel>

      <Panel title="WHAT THIS RADAR CANNOT SEE">
        {Object.entries(acc.unavailable || {}).map(([k, v]) => (
          <div key={k} style={{ padding: "6px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
            <div className="mono" style={{ fontSize: 10, color: C.bear, letterSpacing: ".1em" }}>{text(k)}</div>
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 3, lineHeight: 1.55 }}>{text(v)}</div>
          </div>
        ))}
        <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.6 }}>
          These carry no points and are not estimated. Each score is renormalised over the signals
          that could actually be measured, so a 90 from five signals is never shown as the same
          claim as a 90 from nine.
        </div>
      </Panel>
    </div>
  );
}

const MEDALS = ["🥇", "🥈", "🥉", "#4"];

const bandColor = (b) =>
  b === "ULTRA GOLDEN" || b === "GOLDEN JACKPOT" ? C.gold :
  b === "GOLDEN SETUP" ? C.bull : b === "WATCHLIST" ? C.saffron : C.dim;

function GoldenCard({ g, rank }) {
  const G = g.golden || {};
  const legs = g.legs || {};
  const z = g.zone;
  const mtf = g.mtf;
  const [open, setOpen] = useState(rank === 0);

  return (
    <Panel
      title={`${MEDALS[rank] || "#"} ${text(g.sym)} ${text(g.side, "")}`}
      right={<Tag color={bandColor(G.band)} solid>{text(G.band)}</Tag>}
      style={{ marginBottom: 12 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <div className="mono" style={{ fontSize: 34, fontWeight: 600, color: bandColor(G.band), lineHeight: 1 }}>
          {has(G.score) ? G.score : DASH}
        </div>
        <div>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".12em" }}>GOLDEN SCORE</div>
          <div className="mono" style={{ fontSize: 10.5, color: C.saffron }}>
            raw {has(G.raw) ? G.raw : DASH} × {G.regime_bias} regime · {text(G.regime, "")}
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 12 }}>{rupee(g.ltp)}</div>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim }}>
            {G.measured}/{G.of} modules · {G.possible} pts
          </div>
        </div>
      </div>

      <Row label={text(g.level_name, "TRIGGER LEVEL")} value={rupee(g.level)} color={C.saffron} />
      <Row label="STOP LOSS" value={rupee(legs.sl)} color={C.bear} />
      <Row label="TARGETS" value={[legs.t1, legs.t2, legs.t3].filter(has).length
        ? [legs.t1, legs.t2, legs.t3].filter(has).map((t) => num(t)).join(" / ") : DASH} color={C.bull} />
      <Row label="ENGINE SCORE" value={has(g.engine_score) ? g.engine_score : DASH} />

      <OptionPlan opt={g.option} score={G.score} />

      {g.times && Object.keys(g.times).length > 0 && (
        <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[["detected_at", "Detected"], ["confirmed_at", "Confirmed"], ["entry_at", "Entry hit"],
            ["t1_at", "T1 hit"], ["t2_at", "T2 hit"], ["t3_at", "T3 hit"]]
            .filter(([k]) => g.times[k])
            .map(([k, lbl]) => (
              <span key={k}>{lbl} <span style={{ color: k.startsWith("t") ? C.bull : C.text }}>
                {text(g.times[k])}</span></span>
            ))}
        </div>
      )}

      {G.coverage_note && (
        <div className="mono" style={{ fontSize: 10, color: C.saffron, background: C.raised,
          border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: 10, margin: "10px 0", lineHeight: 1.55 }}>
          {text(G.coverage_note)}
        </div>
      )}

      <button onClick={() => setOpen(!open)} className="mono" style={{
        marginTop: 10, fontSize: 9.5, letterSpacing: ".1em", color: C.saffron,
        padding: "4px 10px", border: `1px solid ${C.saffron}55`, borderRadius: 2 }}>
        {open ? "HIDE WHY" : "WHY THIS CALL?"}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, marginBottom: 6 }}>
            WHY AI SELECTED THIS
          </div>
          {(G.why || []).length ? (G.why || []).map((w, i) => (
            <div key={i} className="mono" style={{ fontSize: 10.5, color: C.text, padding: "2px 0 2px 14px", position: "relative", lineHeight: 1.55 }}>
              <span style={{ position: "absolute", left: 0, color: C.bull }}>✓</span>{text(w)}
            </div>
          )) : <div className="mono" style={{ fontSize: 10.5, color: C.faint }}>No module scored full marks.</div>}

          {(G.against || []).length > 0 && (
            <>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "10px 0 6px" }}>
                WHAT ARGUES AGAINST IT
              </div>
              {(G.against || []).map((w, i) => (
                <div key={i} className="mono" style={{ fontSize: 10.5, color: C.dim, padding: "2px 0 2px 14px", position: "relative", lineHeight: 1.55 }}>
                  <span style={{ position: "absolute", left: 0, color: C.bear }}>✗</span>{text(w)}
                </div>
              ))}
            </>
          )}

          {(G.missing || []).length > 0 && (
            <>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "10px 0 6px" }}>
                COULD NOT BE MEASURED
              </div>
              {(G.missing || []).map((w, i) => (
                <div key={i} className="mono" style={{ fontSize: 10, color: C.faint, padding: "2px 0 2px 14px", position: "relative", lineHeight: 1.5 }}>
                  <span style={{ position: "absolute", left: 0 }}>—</span>{text(w)}
                </div>
              ))}
            </>
          )}

          <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "12px 0 6px" }}>
            MODULE BREAKDOWN
          </div>
          {(G.components || []).map((c) => (
            <div key={c.k} style={{ display: "grid", gridTemplateColumns: "110px 1fr 44px", gap: 8, alignItems: "center", padding: "3px 0" }}>
              <span className="mono" style={{ fontSize: 9.5, color: c.available ? C.dim : C.faint }}>{text(c.k)}</span>
              {c.available
                ? <Meter v={c.earned} max={c.weight} color={c.earned >= c.weight ? C.bull : c.earned > 0 ? C.saffron : C.bear} />
                : <div style={{ height: 3, background: `repeating-linear-gradient(90deg, ${C.lineSoft} 0 4px, transparent 4px 8px)` }} />}
              <span className="mono" style={{ fontSize: 9.5, textAlign: "right", color: c.available ? C.dim : C.faint }}>
                {c.available ? `${c.earned}/${c.weight}` : "n/a"}
              </span>
            </div>
          ))}

          {mtf && (
            <>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "12px 0 6px" }}>
                MULTI-TIMEFRAME · {has(mtf.pct) ? `${mtf.pct}%` : DASH}
              </div>
              {Object.entries(mtf.frames || {}).map(([k, v]) => (
                <Row key={k} label={k.toUpperCase()} value={text(v.label)}
                  color={v.label === "BULLISH" ? C.bull : v.label === "BEARISH" ? C.bear : C.dim} />
              ))}
              <div className="mono" style={{ fontSize: 9.5, color: C.faint, marginTop: 4, lineHeight: 1.5 }}>
                {text(mtf.note)}
              </div>
            </>
          )}

          {z && (
            <>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "12px 0 6px" }}>
                🧠 HISTORICAL ZONE MEMORY
              </div>
              {z.tests ? (
                <>
                  <Row label="ZONE" value={rupee(z.level)} />
                  <Row label="TESTS IN HISTORY" value={z.tests} color={z.thin ? C.saffron : undefined} />
                  <Row label="WENT UP / DOWN" value={`${z.bullish} / ${z.bearish}`} />
                  <Row label="BULLISH REACTION" value={`${z.bull_pct}%`}
                    color={z.bull_pct >= 60 ? C.bull : z.bull_pct <= 40 ? C.bear : C.saffron} />
                  <Row label={`AVG MOVE (${z.forward_days}d)`} value={`+${z.avg_up}% / ${z.avg_dn}%`} />
                  <Row label="BEST / WORST" value={`+${z.best_up}% / ${z.worst_dn}%`} />
                  <div className="mono" style={{ fontSize: 9.5, color: z.thin ? C.saffron : C.faint, marginTop: 4, lineHeight: 1.5 }}>
                    {text(z.note)}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.6 }}>
                    {z.tests >= 4
                      ? <>The way to express this zone is the contract above — {text(g.option && g.option.symbol, "no contract quoted")}.
                          History says what tends to happen here; it does not say it will.</>
                      : <>Too few tests to lean on. The contract above is still the instrument, but
                          the zone adds nothing to the case for it.</>}
                  </div>
                </>
              ) : <div className="mono" style={{ fontSize: 10.5, color: C.faint }}>{text(z.note)}</div>}
            </>
          )}

          {g.chain && (
            <>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, margin: "12px 0 6px" }}>
                📊 OPTION CHAIN
              </div>
              <Row label="MAX PAIN" value={has(g.chain.strike) ? num(g.chain.strike, 0) : DASH} />
              <Row label="PCR" value={has(g.chain.pcr) ? num(g.chain.pcr, 2) : DASH}
                color={g.chain.pcr > 1.15 ? C.bull : g.chain.pcr < 0.85 ? C.bear : C.saffron} />
              <Row label="CE OI / PE OI" value={`${intl(g.chain.ce_oi)} / ${intl(g.chain.pe_oi)}`} />
              <div className="mono" style={{ fontSize: 9.5, color: C.faint, marginTop: 4, lineHeight: 1.5 }}>
                {text(g.chain.note)}
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

function GoldenTab({ feed }) {
  const snap = feed.snap;
  if (!snap) return <WarmingPanel feed={feed} />;
  const gj = snap.golden;
  if (!gj) {
    return (
      <Panel title="GOLDEN JACKPOT">
        <Empty>The quant core has not run on this snapshot yet.</Empty>
      </Panel>
    );
  }
  const reg = gj.regime || {};
  const top = gj.top || [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title="MARKET REGIME" pad={12}
        right={<Tag color={String(reg.label).startsWith("TRENDING") ? C.bull :
          reg.label === "SIDEWAYS" ? C.saffron : C.dim}>{text(reg.label)}</Tag>}>
        <Row label="VOLATILITY" value={text(reg.vol)} />
        <Row label="INDIA VIX" value={has(reg.vix) ? num(reg.vix, 2) : DASH} />
        <Row label="NIFTY DAY MOVE" value={has(reg.trend) ? `${reg.trend > 0 ? "+" : ""}${num(reg.trend, 2)}%` : DASH}
          color={reg.trend > 0 ? C.bull : reg.trend < 0 ? C.bear : C.dim} />
        <Row label="DAY RANGE" value={has(reg.day_range_pct) ? `${num(reg.day_range_pct, 2)}%` : DASH} />
        <Row label="BREAKOUT MULTIPLIER" value={`×${reg.breakout_bias}`}
          color={reg.breakout_bias > 1 ? C.bull : reg.breakout_bias < 1 ? C.bear : C.dim} />
        <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.6 }}>
          {text(reg.why_bias, "")}
        </div>
      </Panel>

      <Panel title="🏆 GOLDEN JACKPOT ALERTS" pad={10}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>TOP {top.length} OF {(gj.all || []).length} SCORED</span>}>
        {top.length
          ? top.map((g, i) => <GoldenCard key={`${text(g.sym)}-${text(g.side)}`} g={g} rank={i} />)
          : <Empty>{text(gj.note, "Nothing cleared the bar this scan. Showing nothing is a valid output.")}</Empty>}
      </Panel>

      {(gj.all || []).length > top.length && (
        <Panel title="EVERYTHING ELSE SCORED" pad={0}>
          {(gj.all || []).slice(top.length).map((g, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 70px 54px 90px", gap: 8, alignItems: "center", padding: "8px 14px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <span style={{ fontSize: 12 }}>
                {text(g.sym)} <span style={{ color: g.side === "CE" ? C.bull : C.bear }}>{text(g.side, "")}</span>
              </span>
              <span className="mono" style={{ fontSize: 10.5, textAlign: "right", color: C.dim }}>{rupee(g.ltp)}</span>
              <span className="mono" style={{ fontSize: 12, textAlign: "right", color: bandColor((g.golden || {}).band) }}>
                {has((g.golden || {}).score) ? g.golden.score : DASH}
              </span>
              <span className="mono" style={{ fontSize: 9, textAlign: "right", color: C.faint }}>
                {text((g.golden || {}).band)}
              </span>
            </div>
          ))}
        </Panel>
      )}

      <Panel title="WHAT THE QUANT CORE CANNOT SEE">
        {Object.entries(gj.unavailable || {}).map(([k, v]) => (
          <div key={k} style={{ padding: "6px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
            <div className="mono" style={{ fontSize: 10, color: C.bear, letterSpacing: ".1em" }}>{text(k)}</div>
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 3, lineHeight: 1.55 }}>{text(v)}</div>
          </div>
        ))}
        <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.6 }}>
          A score is a description of evidence that lines up, not a forecast. Historical zone
          reaction is drawn from roughly a year of daily candles, so a zone with three tests is
          three tests — the count is always shown and a thin one is held back rather than promoted.
          Nothing here is a guarantee; an option can lose the whole premium paid.
        </div>
      </Panel>
    </div>
  );
}

function SystemTab({ feed }) {
  const snap = feed.snap;
  const [diag, setDiag] = useState(null);
  const [acc, setAcc] = useState(null);

  useEffect(() => {
    (async () => {
      try { const r = await fetch("/api/health", { cache: "no-store" }); if (r.ok) setDiag(await r.json()); } catch { /* */ }
      try { const r = await fetch("/api/accuracy", { cache: "no-store" }); if (r.ok) setAcc(await r.json()); } catch { /* */ }
    })();
  }, [feed.snap]);

  const h = (snap && snap.health) || {};
  const fc = (snap && snap.feed_counts) || {};

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title="FEED HEALTH">
        <Row label="BROKER CONNECTED" value={has(diag && diag.broker) ? (diag.broker ? "YES" : "NO") : DASH}
          color={diag && diag.broker ? C.bull : C.bear} />
        <Row label="BROKER ERROR" value={text(diag && diag.broker_error, "none")} color={diag && diag.broker_error ? C.bear : C.dim} />
        <Row label="INSTRUMENTS LOADED" value={has(diag && diag.instruments) ? intl(diag.instruments) : DASH} />
        <Row label="SYMBOLS SCANNED" value={has(snap && snap.scanned) ? snap.scanned : DASH} />
        <Row label="QUOTES LIVE / OLD / MISSING"
          value={has(fc.live) ? `${fc.live} / ${fc.old} / ${fc.nodata}` : DASH}
          color={fc.old || fc.nodata ? C.saffron : C.bull} />
        <Row label="LAST SCAN" value={text(snap && snap.updated)} />
        <Row label="SCAN TIME" value={has(snap && snap.scan_ms) ? `${intl(snap.scan_ms)} ms` : DASH} />
        <Row label="SCAN ERROR" value={text(h.scan_error || (diag && diag.scan_error), "none")} color={h.scan_error ? C.bear : C.dim} />
        <Row label="TELEGRAM ALERTS" value={has(diag && diag.telegram) ? (diag.telegram ? "ON" : "OFF") : DASH} />
        <Row label="SERVER TIME (IST)" value={text(diag && diag.server_time)} />
      </Panel>

      {diag && diag.storage_warning && (
        <Panel pad={12} style={{ background: `${C.saffron}12`, border: `1px solid ${C.saffron}55` }}>
          <div className="mono" style={{ fontSize: 10.5, color: C.saffron, lineHeight: 1.5 }}>⚠ {text(diag.storage_warning)}</div>
        </Panel>
      )}

      <Panel title="ACCURACY">
        {acc ? Object.entries(acc).map(([k, v]) => (
          <Row key={k} label={k.replace(/_/g, " ").toUpperCase()}
            value={typeof v === "object" ? JSON.stringify(v) : String(v)} />
        )) : <Empty>Accuracy endpoint returned nothing yet.</Empty>}
        <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
          Hit rates count only calls that actually filled. A call that never triggered is neither a
          win nor a loss, and counting it as either would flatter the number.
        </div>
      </Panel>
    </div>
  );
}

function WarmingPanel({ feed }) {
  return (
    <Panel title={feed.sourceLabel}>
      <div className="mono" style={{ fontSize: 11.5, color: C.dim, lineHeight: 1.7, padding: "16px 0" }}>
        {feed.boot
          ? <>The backend is still starting up. Current stage: <span style={{ color: C.saffron }}>{feed.boot}</span>.</>
          : <>No snapshot has come back from <span style={{ color: C.saffron }}>/api/snapshot</span> yet.</>}
        {feed.err && <div style={{ marginTop: 8, color: C.bear }}>{feed.err}</div>}
        <div style={{ marginTop: 12 }}>
          The board is empty rather than filled with numbers that would be invented. It populates on
          its own the moment the scanner returns.
        </div>
      </div>
      <button onClick={feed.reload} className="mono" style={{
        fontSize: 10, letterSpacing: ".1em", color: C.saffron,
        padding: "6px 14px", border: `1px solid ${C.saffron}55`, borderRadius: 2,
      }}>RETRY NOW</button>
    </Panel>
  );
}

/* ---------------- shell ---------------- */
const TABS = [
  { id: "command", label: "COMMAND", sub: "mood · read" },
  { id: "setups", label: "SETUPS", sub: "AI trade engine" },
  { id: "flow", label: "FLOW", sub: "index signals" },
  { id: "radar", label: "RADAR", sub: "scanners · movers" },
  { id: "golden", label: "GOLDEN", sub: "top 3-4 only" },
  { id: "accum", label: "STRIKE AI", sub: "option intel" },
  { id: "news", label: "NEWS", sub: "headlines" },
  { id: "journal", label: "JOURNAL", sub: "calls · risk" },
  { id: "system", label: "SYSTEM", sub: "health · accuracy" },
];

function KRTTerminal() {
  const [tab, setTab] = useState("command");
  const feed = useFeed();
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!feed.setups.length) return;
    if (!feed.setups.some((s) => s.id === selected)) setSelected(feed.setups[0].id);
  }, [feed.setups, selected]);

  const open = (id) => { setSelected(id); setTab("setups"); };
  const srcColor = feed.source === "live" ? C.bull : feed.source === "stale" ? C.bear : C.saffron;

  return (
    <div className="krt">
      <style>{CSS}</style>
      <div className="krt-shell">
        <nav className="krt-rail" style={{ background: C.panel, borderRight: `1px solid ${C.line}` }}>
          <div className="krt-rail-brand" style={{ padding: "16px 14px 18px", borderBottom: `1px solid ${C.lineSoft}` }}>
            <div className="mono" style={{ fontSize: 9, letterSpacing: ".26em", color: C.saffron }}>KRT AI</div>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.15, marginTop: 4, letterSpacing: "-.02em" }}>
              OPTION<br />COMMAND<br />CENTER
            </div>
            <div className="mono" style={{ fontSize: 8.5, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
              Detect the move<br />before the crowd
            </div>
          </div>
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className="krt-rail-item"
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "11px 14px",
                  borderLeft: `2px solid ${on ? C.saffron : "transparent"}`,
                  background: on ? `${C.saffron}12` : "transparent",
                }}>
                <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".14em", color: on ? C.saffron : C.text, fontWeight: 600 }}>{t.label}</div>
                <div className="mono" style={{ fontSize: 8.5, color: C.dim, marginTop: 2 }}>{t.sub}</div>
              </button>
            );
          })}
        </nav>

        <main style={{ minWidth: 0 }}>
          <header style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            padding: "10px 16px", borderBottom: `1px solid ${C.line}`, background: C.panel, flexWrap: "wrap",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div className="mono" style={{ fontSize: 16, color: C.saffron, fontWeight: 600 }}>{fmtClock(feed.sec)}</div>
              <Tag color={feed.sessionOpen ? C.bull : C.dim}>{feed.sessionLabel}</Tag>
              {feed.indices.length ? feed.indices.map((x) => (
                <div key={text(x.name, "?")} className="mono" style={{ fontSize: 10.5 }}>
                  <span style={{ color: C.dim }}>{text(x.name)} </span>
                  <span>{num(x.ltp)} </span>
                  <span style={{ color: has(x.chg) ? (x.chg >= 0 ? C.bull : C.bear) : C.faint }}>{signed(x.chg)}</span>
                </div>
              )) : <span className="mono" style={{ fontSize: 10.5, color: C.faint }}>indices {DASH}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Tag color={srcColor}>{feed.sourceLabel}</Tag>
              <button onClick={feed.reload} className="mono" style={{
                fontSize: 9.5, letterSpacing: ".1em", color: C.dim, padding: "3px 8px",
                border: `1px solid ${C.line}`, borderRadius: 2,
              }}>REFRESH</button>
            </div>
          </header>

          {!feed.sessionIsToday && feed.sessionShown && !feed.stale && (
            <div style={{ padding: "8px 16px", background: `${C.line}`, borderBottom: `1px solid ${C.line}` }}>
              <span className="mono" style={{ fontSize: 10.5, color: C.dim }}>
                No session today. The board is reporting the last completed session,
                {" "}<span style={{ color: C.text }}>{feed.sessionShown}</span>
                {feed.sessionDetail ? ` · ${feed.sessionDetail}` : ""}.
              </span>
            </div>
          )}

          {feed.emptyReason && (
            <div style={{ padding: "10px 16px", background: `${C.bear}18`, borderBottom: `1px solid ${C.bear}55` }}>
              <div className="mono" style={{ fontSize: 11, color: C.bear, letterSpacing: ".1em", marginBottom: 4 }}>
                ⚠ THE SCAN RETURNED NOTHING
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: C.text, lineHeight: 1.6 }}>
                {text(feed.emptyReason)}
              </div>
              {feed.scanError && (
                <div className="mono" style={{ fontSize: 10.5, color: C.bear, marginTop: 6, lineHeight: 1.6 }}>
                  The last scan also raised an error: {text(feed.scanError)}
                </div>
              )}
              <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
                The empty panels below are that failure, not a quiet market. Nothing on this screen
                should be read as a signal until this clears.
              </div>
            </div>
          )}

          {feed.unquoted > 0 && !feed.stale && (
            <div style={{ padding: "8px 16px", background: `${C.bear}18`, borderBottom: `1px solid ${C.bear}55` }}>
              <span className="mono" style={{ fontSize: 10.5, color: C.bear }}>
                ⚠ {feed.unquoted} symbol{feed.unquoted === 1 ? "" : "s"} could not be quoted by the
                broker. Their price is inferred from the last daily candle and may not match your
                terminal — check the dossier's PRICE FROM row before acting on those.
              </span>
            </div>
          )}

          {feed.shiftedLevels && !feed.stale && (
            <div style={{ padding: "8px 16px", background: `${C.saffron}18`, borderBottom: `1px solid ${C.saffron}55` }}>
              <span className="mono" style={{ fontSize: 10.5, color: C.saffron }}>
                ⚠ Today's daily candle has not arrived from the broker. Previous close and PDH/PDL
                are dated {feed.prevDate || "the last session on file"} — the day's change is measured
                from there.
              </span>
            </div>
          )}

          {feed.stale && (
            <div style={{ padding: "8px 16px", background: `${C.bear}18`, borderBottom: `1px solid ${C.bear}55` }}>
              <span className="mono" style={{ fontSize: 10.5, color: C.bear }}>
                ⚠ The feed is not live. The board is showing its last print — do not act on these numbers.
              </span>
            </div>
          )}

          <div style={{ padding: 12 }}>
            {tab === "command" && <CommandTab feed={feed} openSetup={open} />}
            {tab === "setups" && <SetupsTab feed={feed} openSetup={setSelected} selected={selected} />}
            {tab === "flow" && <FlowTab feed={feed} />}
            {tab === "radar" && <RadarTab feed={feed} />}
            {tab === "golden" && <GoldenTab feed={feed} />}
            {tab === "accum" && <AccumTab feed={feed} />}
            {tab === "news" && <NewsTab feed={feed} />}
            {tab === "journal" && <JournalTab feed={feed} />}
            {tab === "system" && <SystemTab feed={feed} />}
          </div>

          <footer style={{ padding: "14px 16px 24px", borderTop: `1px solid ${C.line}` }}>
            <div className="mono" style={{ fontSize: 10, color: C.dim, lineHeight: 1.7, maxWidth: 760 }}>
              Every figure on this screen is read from the scanner running on your broker feed, or
              shown as {DASH} when the backend has nothing for it. Scores, levels and targets are not
              advice and not a promise — an option can lose the whole premium paid. Hit rates count
              only calls that actually filled. Check the feed banner before you act on anything here.
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

/* ============================================================
   FAILURE VISIBILITY
   A blank screen tells the trader nothing. Any render error is
   caught and printed here instead of unmounting the page.
   ============================================================ */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    this.setState({ info });
    try { window.__KRT_ERR = { message: String(err && err.message), stack: String(err && err.stack) }; } catch (e) { /* */ }
  }
  render() {
    if (!this.state.err) return this.props.children;
    const e = this.state.err;
    return (
      <div className="krt" style={{ padding: 20, minHeight: "100vh" }}>
        <style>{CSS}</style>
        <div className="mono" style={{ fontSize: 10, letterSpacing: ".26em", color: C.saffron }}>KRT AI</div>
        <div style={{ fontSize: 18, fontWeight: 700, margin: "8px 0 14px" }}>The terminal hit a rendering error.</div>
        <div className="mono" style={{
          fontSize: 11, color: C.bear, background: `${C.bear}12`, border: `1px solid ${C.bear}55`,
          borderRadius: 3, padding: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{String(e && e.message || e)}</div>
        <div className="mono" style={{
          fontSize: 9.5, color: C.dim, background: C.panel, border: `1px solid ${C.line}`,
          borderRadius: 3, padding: 12, marginTop: 10, lineHeight: 1.55,
          whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 280, overflow: "auto",
        }}>{String((e && e.stack) || "no stack").slice(0, 1800)}</div>
        <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 14, lineHeight: 1.6 }}>
          No market data is shown because the screen could not be trusted to draw it correctly.
          Send this message and the SYSTEM tab is not needed — the text above names the failure.
        </div>
        <button onClick={() => location.reload()} className="mono" style={{
          marginTop: 14, fontSize: 10, letterSpacing: ".1em", color: C.saffron,
          padding: "7px 16px", border: `1px solid ${C.saffron}55`, borderRadius: 2,
        }}>RELOAD</button>
      </div>
    );
  }
}

/* React owns #root and nothing else writes into it. The boot notice lives in
   a separate #krt-boot element, which is hidden the moment React takes over —
   sharing one container is what produced the earlier removeChild failure. */
function hideBoot() {
  try {
    const boot = document.getElementById("krt-boot");
    if (boot) boot.style.display = "none";
  } catch (e) { /* the notice staying visible is harmless */ }
}

function showBootError(title, detail) {
  try {
    const boot = document.getElementById("krt-boot");
    if (!boot) return;
    boot.style.display = "block";
    boot.textContent = "";
    const b = document.createElement("div"); b.className = "b"; b.textContent = "KRT AI";
    const h = document.createElement("div"); h.className = "h"; h.textContent = title;
    const e = document.createElement("div"); e.className = "e"; e.textContent = detail;
    boot.appendChild(b); boot.appendChild(h); boot.appendChild(e);
  } catch (err) { /* nothing further can be done from here */ }
}

try {
  const el = document.getElementById("root");
  if (!el) throw new Error("No #root element in the page — templates/index.html is not the one this bundle expects.");
  ReactDOM.createRoot(el).render(<Boundary><KRTTerminal /></Boundary>);
  window.__KRT_MOUNTED = true;
  hideBoot();
} catch (err) {
  showBootError("The terminal could not start.", String((err && err.stack) || err));
  throw err;
}

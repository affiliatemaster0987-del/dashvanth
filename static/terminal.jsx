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
const KRT_BUILD = "v22-1788235436";
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
  const ce = setups.filter((s) => s.side === "CE");
  const pe = setups.filter((s) => s.side === "PE");
  const sel = setups.find((s) => s.id === selected);
  const near = snap.near_trigger || [];
  const tiers = snap.tiers || {};

  return (
    <div className="krt-cols" style={{ gap: 12 }}>
      <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
        <Panel title="CE BOARD" pad={10} right={<Tag color={C.bull}>{ce.length}</Tag>}>
          {ce.length ? ce.map((s) => <SetupCard key={s.id} s={s} onOpen={openSetup} active={s.id === selected} />)
            : <Empty>Nothing on the CE side has cleared the level and volume filter.</Empty>}
        </Panel>
        <Panel title="PE BOARD" pad={10} right={<Tag color={C.bear}>{pe.length}</Tag>}>
          {pe.length ? pe.map((s) => <SetupCard key={s.id} s={s} onOpen={openSetup} active={s.id === selected} />)
            : <Empty>Nothing on the PE side has cleared the level and volume filter.</Empty>}
        </Panel>

        <Panel title="BLOCKED — WHAT IS STANDING IN THE WAY" pad={0}
          right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>{near.length}</span>}>
          {near.length ? (
            <>
              {near.map((n, i) => (
                <div key={n.sym + n.side + i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: `1px solid ${C.lineSoft}` }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 11, color: C.text }}>
                      {text(n.sym)} <span style={{ color: n.side === "CE" ? C.bull : C.bear }}>{text(n.side, "")}</span>
                      <span style={{ color: C.dim }}> · {rupee(n.ltp)}</span>
                    </div>
                    <div className="mono" style={{ fontSize: 9.5, color: C.bear, marginTop: 2 }}>{text(n.blocking)}</div>
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: C.faint, flexShrink: 0 }}>{n.score}</span>
                </div>
              ))}
              <div className="mono" style={{ fontSize: 9.5, color: C.dim, padding: "8px 12px", lineHeight: 1.5 }}>
                Tier counts this scan — JACKPOT {tiers.JACKPOT ?? DASH} · STRONG {tiers.STRONG ?? DASH} ·
                GOOD {tiers.GOOD ?? DASH} · WATCHLIST {tiers.WATCHLIST ?? DASH} · IGNORE {tiers.IGNORE ?? DASH}
              </div>
            </>
          ) : <Empty>Nothing is queued behind a blocking condition.</Empty>}
        </Panel>
      </div>

      <div>{sel ? <SetupDetail s={sel} /> : (
        <Panel title="SETUP DOSSIER">
          <Empty>Pick a setup from the board to see its score breakdown, the levels it is trading against, and what is still missing.</Empty>
        </Panel>
      )}</div>
    </div>
  );
}

function FlowTab({ feed }) {
  const snap = feed.snap;
  const [chainSym, setChainSym] = useState(null);
  const [chain, setChain] = useState(null);
  const [chainErr, setChainErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadChain = useCallback(async (rawSym, rawSide) => {
    const sym = text(rawSym, "");
    const side = text(rawSide, "CE");
    if (!sym) { setChainErr("This card carries no symbol to quote."); return; }
    setLoading(true); setChainErr(null); setChain(null); setChainSym(sym);
    try {
      const res = await fetch(`/api/chain/${encodeURIComponent(sym)}?side=${encodeURIComponent(side)}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `chain ${res.status}`);
      setChain(body);
    } catch (e) { setChainErr(String(e.message || e)); }
    setLoading(false);
  }, []);

  if (!snap) return <WarmingPanel feed={feed} />;

  const cards = snap.index_cards || [];
  const radar = snap.index_radar || [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title="INDEX OPTION CARDS" pad={0}
        right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>PCR · QUOTED CONTRACT</span>}>
        {cards.length ? cards.map((c) => {
          const o = c.option;
          return (
            <div key={text(c.sym, "?")} style={{ padding: "12px 14px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{text(c.sym)}</span>
                  <Tag color={c.side === "CE" ? C.bull : C.bear}>{c.side}</Tag>
                  {c.grade && <Tag color={C.dim}>GRADE {c.grade}</Tag>}
                  {c.qualified && <Tag color={C.gold} solid>QUALIFIED</Tag>}
                </div>
                <span className="mono" style={{ fontSize: 18, color: c.score >= 90 ? C.gold : C.text }}>{c.score}</span>
              </div>

              <div className="krt-cols2" style={{ marginTop: 10, gap: 10 }}>
                <div>
                  <Row label="SPOT" value={rupee(c.idx && c.idx.ltp)} />
                  <Row label="PCR (NEAR STRIKES)" value={has(c.pcr) ? num(c.pcr, 2) : DASH}
                    color={has(c.pcr) ? (c.pcr > 1.2 ? C.bull : c.pcr < 0.8 ? C.bear : C.saffron) : undefined} />
                  <Row label="CE OI / PE OI" value={has(c.ce_oi) ? `${intl(c.ce_oi)} / ${intl(c.pe_oi)}` : DASH} />
                </div>
                <div>
                  <Row label="CONTRACT" value={text(o && o.symbol)} />
                  <Row label="STRIKE" value={o && has(o.strike) ? o.strike : DASH} />
                  <Row label="PREMIUM" value={o && has(o.prem) ? rupee(o.prem) : DASH}
                    color={o && has(o.prem) ? C.text : undefined} />
                </div>
              </div>

              {c.pcr_read && (
                <div className="mono" style={{ fontSize: 10.5, color: C.saffron, marginTop: 8 }}>{text(c.pcr_read)}</div>
              )}
              {c.note && (
                <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 6 }}>{text(c.note)}</div>
              )}

              <button onClick={() => loadChain(c.sym, c.side)} className="mono" style={{
                marginTop: 10, fontSize: 9.5, letterSpacing: ".1em", color: C.saffron,
                padding: "4px 10px", border: `1px solid ${C.saffron}55`, borderRadius: 2,
              }}>LOAD LIVE CHAIN</button>
            </div>
          );
        }) : <Empty>No index option cards in this snapshot. The chain needs a connected broker.</Empty>}
      </Panel>

      {chainSym && (
        <Panel title={`LIVE CHAIN · ${text(chainSym, "")}`} pad={0}
          right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>
            {loading ? "QUOTING…" : chain ? `SPOT ${rupee(chain.spot)}` : DASH}
          </span>}>
          {loading && <Empty>Quoting strikes through the broker…</Empty>}
          {chainErr && <Empty>Chain unavailable — {chainErr}</Empty>}
          {chain && chain.rows && chain.rows.length ? (
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              <div className="mono" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, padding: "8px 14px", fontSize: 9, letterSpacing: ".1em", color: C.dim, borderBottom: `1px solid ${C.lineSoft}` }}>
                <span>STRIKE</span><span style={{ textAlign: "right" }}>PREMIUM</span>
                <span style={{ textAlign: "right" }}>OI</span><span style={{ textAlign: "right" }}>VOLUME</span>
              </div>
              {chain.rows.map((r, i) => {
                const best = chain.best && chain.best.strike === r.strike;
                return (
                  <div key={i} className="mono" style={{
                    display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8,
                    padding: "7px 14px", fontSize: 11, borderBottom: `1px solid ${C.lineSoft}`,
                    background: best ? `${C.saffron}12` : "transparent",
                  }}>
                    <span style={{ color: best ? C.saffron : C.text }}>
                      {r.strike}{best ? " ◂" : ""}
                    </span>
                    <span style={{ textAlign: "right" }}>{has(r.prem) ? rupee(r.prem) : DASH}</span>
                    <span style={{ textAlign: "right", color: C.dim }}>{has(r.oi) ? intl(r.oi) : DASH}</span>
                    <span style={{ textAlign: "right", color: C.dim }}>{has(r.volume) ? intl(r.volume) : DASH}</span>
                  </div>
                );
              })}
            </div>
          ) : (!loading && !chainErr && <Empty>The chain returned no quoting strikes.</Empty>)}
        </Panel>
      )}

      <Panel title="INDEX RADAR" pad={0}>
        {radar.length ? radar.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 80px", gap: 8, alignItems: "center", padding: "8px 14px", borderBottom: `1px solid ${C.lineSoft}` }}>
            <span style={{ fontSize: 12 }}>{text(r.sym)}</span>
            <span className="mono" style={{ fontSize: 11, color: r.side === "CE" ? C.bull : C.bear, textAlign: "right" }}>{text(r.side, "")}</span>
            <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>{r.score}</span>
            <span className="mono" style={{ fontSize: 10, textAlign: "right", color: r.qualified ? C.bull : C.faint }}>
              {r.qualified ? "QUALIFIED" : `GRADE ${text(r.grade)}`}
            </span>
          </div>
        )) : <Empty>No index scores in this snapshot.</Empty>}
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
                </div>
                <div>
                  <Row label="T1" value={rupee(c.t1)} color={c.t1_at ? C.bull : C.dim} />
                  <Row label="T2" value={rupee(c.t2)} color={c.t2_at ? C.bull : C.dim} />
                  <Row label="T3" value={rupee(c.t3)} color={c.t3_at ? C.bull : C.dim} />
                </div>
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
  if (!snap) return <WarmingPanel feed={feed} />;
  const acc = snap.accumulation || {};
  const idxs = acc.indices || [];
  const alerts = acc.alerts || [];
  const [open, setOpen] = useState(null);

  if (!acc.available) {
    return (
      <Panel title="INSTITUTIONAL ACCUMULATION RADAR">
        <Empty>{text(acc.note, "The radar has no quoted chain to work from.")}</Empty>
      </Panel>
    );
  }

  const unavailable = (idxs[0] && idxs[0].CE && idxs[0].CE[0] && idxs[0].CE[0].unavailable) || {};

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {alerts.length > 0 && (
        <Panel pad={14} style={{ background: `${C.saffron}12`, border: `1px solid ${C.saffron}66` }}>
          <div className="mono krt-live" style={{ fontSize: 11, color: C.saffron, letterSpacing: ".14em", marginBottom: 8 }}>
            🚨 ACCUMULATION ALERT
          </div>
          {alerts.slice(0, 4).map((a, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderBottom: `1px solid ${C.lineSoft}`, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>
                {text(a.sym)} {a.strike} <span style={{ color: a.side === "CE" ? C.bull : C.bear }}>{text(a.side, "")}</span>
              </span>
              <span className="mono" style={{ fontSize: 11, color: C.dim }}>
                {rupee(a.prem)} · {text(a.stage)}
                {a.speed ? ` · ${text(a.speed.label)}` : ""}
              </span>
              <span className="mono" style={{ fontSize: 16, color: C.saffron }}>{a.score}</span>
            </div>
          ))}
        </Panel>
      )}

      {idxs.map((ix) => (
        <Panel key={text(ix.sym, "?")} title={`STRIKE RADAR · ${text(ix.sym)}`} pad={12}
          right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>SPOT {num(ix.spot)}</span>}>
          <div className="mono" style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.65, marginBottom: 12,
            padding: 10, background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3 }}>
            Each row is one strike. The number is how strongly that contract looks like it is being
            accumulated — open interest building, volume above its own average, premium holding.
            <span style={{ color: C.text }}> The strike with the highest number is where the
            positioning is concentrated</span>, and 🔥 marks one that also passed the trap filter.
            A ⚠ means it scored but failed that filter, so it is a warning, not a pick. Tap any row
            to see the full breakdown.
          </div>
          {["CE", "PE"].map((side) => {
            const rows = ix[side] || [];
            const best = rows.filter((r) => has(r.score) && !(r.traps || []).length && !r.thin)
              .sort((a, b) => b.score - a.score)[0];
            return (
            <div key={side} style={{ marginBottom: 12 }}>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".12em", color: side === "CE" ? C.bull : C.bear, marginBottom: 5 }}>
                {side} RADAR
              </div>
              <div className="mono" style={{ fontSize: 11, color: best ? C.saffron : C.faint, marginBottom: 6, lineHeight: 1.5 }}>
                {best
                  ? `Strongest ${side} strike right now: ${num(best.strike, 0)} at ${rupee(best.prem)} — score ${best.score}.`
                  : `No ${side} strike on this chain cleared the trap and coverage filters. Nothing is being suggested.`}
              </div>
              {(ix[side] || []).length ? (ix[side] || []).map((r) => {
                const id = `${ix.sym}-${side}-${r.strike}`;
                const hot = has(r.score) && r.score >= 80 && !r.traps.length && !r.thin;
                return (
                  <button key={id} onClick={() => setOpen(open === id ? null : id)}
                    style={{
                      display: "grid", gridTemplateColumns: "78px 1fr 46px 22px",
                      gap: 8, alignItems: "center", width: "100%", textAlign: "left",
                      padding: "6px 8px", marginBottom: 3, borderRadius: 3,
                      background: hot ? `${C.saffron}14` : "transparent",
                      border: `1px solid ${open === id ? C.saffron + "66" : C.lineSoft}`,
                    }}>
                    <span className="mono" style={{ fontSize: 11, color: C.text }}>{r.strike}</span>
                    <Meter v={r.score || 0} max={100} color={heatColor(r.score, r.thin)} />
                    <span className="mono" style={{ fontSize: 11, textAlign: "right", color: heatColor(r.score, r.thin) }}>
                      {has(r.score) ? r.score : DASH}
                    </span>
                    <span className="mono" style={{ fontSize: 10, textAlign: "right" }}>
                      {r.traps.length ? "⚠" : hot ? "🔥" : ""}
                    </span>
                  </button>
                );
              }) : <Empty>No quoted strikes on this side.</Empty>}

              {(ix[side] || []).filter((r) => open === `${ix.sym}-${side}-${r.strike}`)
                .map((r) => <AccumCard key="open" r={r} />)}
            </div>
            );
          })}
        </Panel>
      ))}

      <Panel title="WHAT THIS RADAR CANNOT SEE">
        {Object.entries(unavailable).length ? Object.entries(unavailable).map(([k, v]) => (
          <div key={k} style={{ padding: "6px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
            <div className="mono" style={{ fontSize: 10, color: C.bear, letterSpacing: ".1em" }}>{k}</div>
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 3, lineHeight: 1.55 }}>{text(v)}</div>
          </div>
        )) : <Empty>Nothing scored yet.</Empty>}
        <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.6 }}>
          Scores are renormalised over the signals that could actually be measured, and every card
          shows how many that was. A 90 built from six signals is not the same as a 90 built from
          nine, so the count is never hidden. Accumulation is a probability read, not a detection —
          no feed can prove an institution is buying.
        </div>
      </Panel>
    </div>
  );
}

/* ---------------- golden jackpot ---------------- */
const bandColor = (b) =>
  b === "ULTRA GOLDEN" ? C.gold : b === "GOLDEN JACKPOT" ? C.gold :
  b === "GOLDEN SETUP" ? C.bull : b === "WATCHLIST" ? C.saffron : C.dim;

const MEDALS = ["🥇", "🥈", "🥉", "#4"];

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
  { id: "setups", label: "SETUPS", sub: "CE / PE board" },
  { id: "flow", label: "FLOW", sub: "index · chain" },
  { id: "radar", label: "RADAR", sub: "scanners · movers" },
  { id: "golden", label: "GOLDEN", sub: "top 3-4 only" },
  { id: "accum", label: "ACCUM", sub: "institution radar" },
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

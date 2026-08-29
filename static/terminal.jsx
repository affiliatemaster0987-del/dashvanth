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
const KRT_BUILD = "v13-1787998730";
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

const tierFor = (s) => (s >= 90 ? "GOLD" : s >= 80 ? "SILVER" : "LITE");
const tierColor = (t) => (t === "GOLD" ? C.gold : t === "SILVER" ? C.silver : C.lite);

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
    tier: tierFor(r.score || 0), score: r.score || 0,
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

  const shifted = useMemo(() => {
    if (!snap) return { any: false, date: null };
    const rows = [...(snap.indices || []), ...(snap.ce_box || []), ...(snap.pe_box || [])];
    const hit = rows.find((r) => r && r.no_today_candle);
    return { any: !!hit, date: hit ? text(hit.prev_date, "") : null };
  }, [snap]);

  const win = (snap && snap.window) || {};
  const sessionOpen = !!(has(win.open) ? win.open : win.key && win.key !== "CLOSED");
  const stale = !!(snap && snap.stale);
  const source = !snap ? "warming" : stale ? "stale" : "live";
  const sourceLabel = source === "live" ? "LIVE · BROKER FEED"
    : source === "stale" ? "FEED STALE · DO NOT TRADE"
    : boot ? `WARMING UP · ${String(boot).toUpperCase()}` : "NO FEED · BACKEND NOT READY";

  return {
    snap, calls, setups, mood, indices, sec, stale, source, sourceLabel,
    shiftedLevels: shifted.any, prevDate: shifted.date,
    sessionOpen, sessionLabel: sessionOpen ? "SESSION OPEN" : "SESSION CLOSED",
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

      <Panel title="TRADE MATHS · PER UNIT" style={{ marginTop: 12 }}>
        <Row label="ENTRY REFERENCE (LTP)" value={rupee(s.ltp)} />
        <Row label="STOP LOSS" value={rupee(s.sl)} color={C.bear} />
        <Row label="RISK PER UNIT" value={has(risk) ? rupee(risk) : DASH} color={C.bear} />
        {s.tgts.map((t, i) => (
          <Row key={i} label={`TARGET ${i + 1}`} value={rupee(t)} color={C.bull} />
        ))}
        <Row label="R:R AT T2" value={has(s.rr) ? `1 : ${num(s.rr, 2)}` : DASH} color={C.saffron} />
        {s.capped && <Row label="TARGET LADDER" value="TRIMMED — outside prime window" color={C.saffron} />}
        <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
          Per-unit figures. The scanner returns the underlying, not a contract — lot size and
          premium only exist once a strike is quoted through the chain, so no position cost is
          shown here rather than a guessed one.
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
                <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
                  {armed.blocking ? `Blocked by: ${text(armed.blocking, "unspecified")}` : "Price has not taken the level yet. Touching is not breaking."}
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
      <Panel title="NEWS BIAS" pad={12}>
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
                  {text(c.sym)} {text(c.strike, "")} <span style={{ color: c.side === "CE" ? C.bull : C.bear }}>{text(c.side, "")}</span>
                </div>
                <div className="mono" style={{ fontSize: 16, color: C.text }}>{rupee(c.ltp)}</div>
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
              {text(c.sym)} <span style={{ color: c.side === "CE" ? C.bull : C.bear }}>{text(c.side, "")}</span>
            </span>
            <span className="mono" style={{ fontSize: 10, color: C.dim, textAlign: "right" }}>
              {c.triggered ? "FILLED" : "MISSED"}
            </span>
            <span className="mono" style={{ fontSize: 10.5, textAlign: "right" }}>{rupee(c.entry)}</span>
            <span className="mono" style={{ fontSize: 10.5, textAlign: "right" }}>{rupee(c.ltp)}</span>
            <span className="mono" style={{ fontSize: 10, textAlign: "right", color: c.result === "SL" ? C.bear : c.result ? C.bull : C.dim }}>
              {text(c.badge, text(c.status))}
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

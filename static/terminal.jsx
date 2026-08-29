import React from "react";
import { useState, useEffect, useMemo, useRef } from "react";
import ReactDOMClient from "react-dom/client";
const ReactDOM = ReactDOMClient;
/* ============================================================
   LIVE FEED ADAPTER
   Maps /api/snapshot onto the shapes the design already expects.
   The design below is unchanged — this only feeds it.
   ============================================================ */

const WEIGHTS = {
  LEVEL: 16, VOLUME: 14, VWAP: 12, MARKET: 12, STRUCTURE: 10,
  SECTOR: 10, LIQUIDITY: 8, "OI CHAIN": 8, NEWS: 6, TIME: 4,
};

const PRETTY = {
  LEVEL: "Level", VOLUME: "Volume", VWAP: "VWAP", MARKET: "Market",
  STRUCTURE: "Structure", SECTOR: "Sector", LIQUIDITY: "Liquidity",
  "OI CHAIN": "Gamma / OI", NEWS: "News", TIME: "Timing",
};

function istSeconds() {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  return ist.getHours() * 3600 + ist.getMinutes() * 60 + ist.getSeconds();
}

function tierFor(score) {
  return score >= 90 ? "GOLD" : score >= 80 ? "SILVER" : "LITE";
}

/* stage 0..6 — WATCH BUILDING ARMED TRIGGERED T1 T2 T3 */
function stageFor(r) {
  const t = r.times || {};
  if (t.t3_at) return 6;
  if (t.t2_at) return 5;
  if (t.t1_at) return 4;
  if (t.entry_at) return 3;
  if (t.confirmed_at) return 2;
  if (t.detected_at) return 1;
  const failed = (r.failed || []).length;
  if (failed) return 0;
  return (r.score || 0) >= 85 ? 2 : 1;
}

/* one scanner row -> one design "setup" */
function toSetup(r, i) {
  const legs = r.legs || {};
  const ltp = r.ltp || 0;
  const sl = legs.sl != null ? legs.sl : +(ltp * 0.94).toFixed(2);
  const tgts = [legs.t1, legs.t2, legs.t3].filter((x) => x != null);
  const checks = r.checks || [];

  const breakdown = {};
  const breakdownMax = {};
  Object.keys(WEIGHTS).forEach((k) => {
    const c = checks.find((x) => x.k === k);
    breakdown[PRETTY[k]] = c && c.ok ? (c.pts != null ? c.pts : WEIGHTS[k]) : 0;
    breakdownMax[PRETTY[k]] = WEIGHTS[k];
  });

  const why = checks.filter((c) => c.ok && c.note).map((c) => c.note).slice(0, 6);
  const blocked = checks.filter((c) => !c.ok && c.note).map((c) => c.note);
  const lv = r.levels || {};
  const isCE = r.side === "CE";
  const trigger = isCE
    ? (lv.pdh != null ? `Above ₹${lv.pdh}` : "Level break")
    : (lv.pdl != null ? `Below ₹${lv.pdl}` : "Level break");

  const stage = stageFor(r);
  const t = r.times || {};

  return {
    id: `${r.sym}-${r.side}-${i}`,
    sym: r.sym,
    strike: "",                       // strike lives in the chain, not the scan
    side: r.side,
    tier: tierFor(r.score || 0),
    score: r.score || 0,
    stage,
    premium: ltp,
    entry: [+(ltp * 0.985).toFixed(2), +(ltp * 1.015).toFixed(2)],
    filled: t.entry_at ? ltp : null,
    sl,
    tgts: tgts.length ? tgts : [ltp],
    signalAt: null, entryAt: null, hits: [null, null, null],
    lot: r.lot || null,
    spot: ltp,
    trigger,
    why: why.length ? why : ["No passing check carried a note."],
    breakdown,
    breakdownMax,
    fresh: stage < 4,
    freshNote: blocked.length
      ? blocked[0]
      : stage >= 4 ? "Target already taken — R:R is poor from here."
      : "Waiting for the trigger with volume behind it.",
    _rr: legs.rr, _vwap: r.vwap, _atr: r.atr, _volRatio: r.vol_ratio,
    _sector: r.sector, _confidence: r.confidence, _grade: r.grade,
    _lights: r.lights || [], _levels: lv,
  };
}

function useFeed() {
  const [snap, setSnap] = useState(null);
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
          setBoot(body.boot || null);
          setSnap(null);
        } else {
          setSnap(body); setErr(null); setBoot(null);
        }
      } catch (e) {
        if (!dead) { setErr(String(e.message || e)); setSnap(null); }
      }
    };
    pull();
    const t = setInterval(pull, 15000);
    return () => { dead = true; clearInterval(t); };
  }, [nonce]);

  const live = !!snap;

  const setups = useMemo(() => {
    if (!snap) return [];
    const rows = [
      ...(snap.jackpot_ce || []), ...(snap.jackpot_pe || []),
      ...(snap.ce_box || []), ...(snap.pe_box || []),
    ];
    const seen = new Set();
    return rows
      .filter((r) => r && r.sym)
      .filter((r) => {
        const k = r.sym + r.side;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      })
      .map(toSetup)
      .sort((a, b) => b.score - a.score);
  }, [snap]);

  const mood = useMemo(() => {
    if (!snap) return { bull: 50, bear: 50 };
    const p = snap.pressure || {};
    if (p.buyers != null) {
      const bull = Math.round(p.buyers);
      return { bull, bear: Math.max(1, 100 - bull) };
    }
    const b = Math.round(snap.breadth || 50);
    return { bull: b, bear: Math.max(1, 100 - b) };
  }, [snap]);

  const indices = useMemo(() => {
    if (!snap || !snap.indices) return [];
    const arr = Array.isArray(snap.indices)
      ? snap.indices
      : Object.entries(snap.indices).map(([k, v]) => ({ name: k, ...(v || {}) }));
    return arr.slice(0, 3).map((x) => {
      const name = x.name || x.sym || "—";
      const ltp = x.ltp != null ? Number(x.ltp).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
      const chg = x.chg != null ? `${x.chg > 0 ? "+" : ""}${Number(x.chg).toFixed(2)}%` : "—";
      return [name, ltp, chg];
    });
  }, [snap]);

  const win = (snap && snap.window) || {};
  const sessionOpen = !!(win.open != null ? win.open : win.key && win.key !== "CLOSED");
  const stale = !!(snap && snap.stale);

  const source = !live ? "warming" : stale ? "stale" : "live";
  const sourceLabel =
    source === "live" ? "LIVE · BROKER FEED"
    : source === "stale" ? "FEED STALE · DO NOT TRADE"
    : (boot ? `WARMING UP · ${String(boot).toUpperCase()}` : "NO FEED · BACKEND NOT READY");

  const disclaimer = live
    ? "Scores, levels and targets come from the scanner running on your broker feed. They are not advice and not a promise — an option can lose the whole premium paid. Hit rates count only calls that actually filled. When the feed goes stale the board keeps its last print, so check the banner before you act on anything here."
    : `The backend has not returned a snapshot yet${err ? ` (${err})` : ""}, so the board is empty rather than filled with numbers that would be invented. Nothing is being shown as a trade call. The panels populate as soon as /api/snapshot returns.`;

  return {
    snap, setups, mood, indices, sec, live, stale, source, sourceLabel,
    sessionOpen, sessionLabel: sessionOpen ? "SESSION OPEN" : "SESSION CLOSED",
    disclaimer, err, boot,
    reload: () => setNonce((n) => n + 1),
  };
}

function Empty({ children }) {
  return (
    <div className="mono" style={{
      fontSize: 11, color: "#8A93A6", lineHeight: 1.6,
      padding: "22px 12px", textAlign: "center",
    }}>{children}</div>
  );
}



/* ============================================================
   KRT AI OPTION COMMAND CENTER
   Terminal shell — runs on SIMULATED data.
   No exchange feed is connected. Nothing here is a trade call.
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

/* ---------------- simulated session clock ---------------- */
const startSec = 9 * 3600 + 32 * 60 + 14;
const fmtClock = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
};
const rnd = (a, b) => a + Math.random() * (b - a);

/* ---------------- seed data ---------------- */
const SEED_SETUPS = [
  {
    id: "n24200ce", sym: "NIFTY", strike: 24200, side: "CE", tier: "GOLD",
    score: 94, stage: 5, premium: 64.0, entry: [48, 52], filled: 50, sl: 40, tgts: [62, 72, 84],
    signalAt: startSec, entryAt: startSec + 114, hits: [startSec + 664, null, null],
    lot: 75, spot: 24238.4, trigger: "24,182 hold + ORB",
    why: ["VWAP hold since 09:22", "CE writers unwinding at 24200", "Fresh PE writing 24100", "BankNifty confirming", "Breadth 72% advancing"],
    breakdown: { Structure: 14, Volume: 9, "Relative Strength": 10, "Futures Flow": 9, "Options Flow": 14, "Gamma / OI": 8, Liquidity: 8, "Market Breadth": 6, Sector: 4, News: 4, "Historical Match": 5, "Risk / Reward": 3 },
    fresh: false, freshNote: "T1 done — premium extended, R:R poor from here.",
  },
  {
    id: "vbl480ce", sym: "VBL", strike: 480, side: "CE", tier: "SILVER",
    score: 84, stage: 2, premium: 11.4, entry: [10.8, 12.2], filled: null, sl: 8.4, tgts: [15, 18.5, 23],
    signalAt: startSec + 420, entryAt: null, hits: [null, null, null],
    lot: 850, spot: 449.7, trigger: "Above ₹452.20",
    why: ["Accumulation 86/100", "Compression energy 88", "Liquidity vacuum 452 → 465", "Sector: beverages neutral"],
    breakdown: { Structure: 14, Volume: 8, "Relative Strength": 9, "Futures Flow": 8, "Options Flow": 11, "Gamma / OI": 6, Liquidity: 6, "Market Breadth": 6, Sector: 3, News: 4, "Historical Match": 5, "Risk / Reward": 3 },
    fresh: true, freshNote: "Waiting for ₹452.20 break with volume.",
  },
  {
    id: "ts190ce", sym: "TATASTEEL", strike: 190, side: "CE", tier: "LITE",
    score: 73, stage: 1, premium: 4.15, entry: [3.9, 4.4], filled: null, sl: 3.1, tgts: [5.4, 6.6, 8.0],
    signalAt: startSec + 610, entryAt: null, hits: [null, null, null],
    lot: 5500, spot: 187.2, trigger: "Above ₹188.60",
    why: ["Metal sector leadership", "Lagging vs HINDALCO — catch-up candidate", "Volume not yet confirming"],
    breakdown: { Structure: 11, Volume: 6, "Relative Strength": 8, "Futures Flow": 7, "Options Flow": 9, "Gamma / OI": 5, Liquidity: 7, "Market Breadth": 5, Sector: 5, News: 3, "Historical Match": 4, "Risk / Reward": 3 },
    fresh: true, freshNote: "Early. No trigger yet — watch only.",
  },
  {
    id: "sx81200pe", sym: "SENSEX", strike: 81200, side: "PE", tier: "GOLD",
    score: 91, stage: 3, premium: 88.5, entry: [84, 92], filled: null, sl: 68, tgts: [112, 132, 158],
    signalAt: startSec + 505, entryAt: null, hits: [null, null, null],
    lot: 20, spot: 81344, trigger: "Below 81,180",
    why: ["Index divergence vs NIFTY", "Heavyweight drag: HDFCBANK, INFY", "Call wall holding 81500", "Failed retest of PDH"],
    breakdown: { Structure: 14, Volume: 9, "Relative Strength": 9, "Futures Flow": 9, "Options Flow": 14, "Gamma / OI": 7, Liquidity: 8, "Market Breadth": 4, Sector: 4, News: 4, "Historical Match": 5, "Risk / Reward": 4 },
    fresh: true, freshNote: "Armed. Trigger not yet taken.",
  },
  {
    id: "xyz600pe", sym: "RAILTEL", strike: 600, side: "PE", tier: "SILVER",
    score: 82, stage: 1, premium: 19.7, entry: [18.5, 21], filled: null, sl: 15, tgts: [26, 31, 38],
    signalAt: startSec + 700, entryAt: null, hits: [null, null, null],
    lot: 1150, spot: 612.4, trigger: "Below ₹608",
    why: ["Regulatory disclosure — negative", "Support ₹620 already lost", "Futures short build-up", "Wait for price + volume confirmation"],
    breakdown: { Structure: 12, Volume: 9, "Relative Strength": 9, "Futures Flow": 9, "Options Flow": 11, "Gamma / OI": 6, Liquidity: 6, "Market Breadth": 4, Sector: 3, News: 5, "Historical Match": 5, "Risk / Reward": 3 },
    fresh: true, freshNote: "News-driven. Confirmation pending.",
  },
];

const STAGES = ["WATCH", "BUILDING", "ARMED", "TRIGGERED", "T1", "T2", "T3"];

const HERO20 = [
  ["VBL", 94, "+2.1%"], ["TATASTEEL", 91, "+1.8%"], ["IEX", 89, "+3.4%"], ["SBIN", 87, "+1.2%"],
  ["RELIANCE", 84, "+0.9%"], ["HINDALCO", 83, "+2.6%"], ["JSWSTEEL", 81, "+1.9%"], ["ICICIBANK", 79, "+0.7%"],
  ["BHARTIARTL", 77, "+0.5%"], ["LT", 76, "+1.1%"], ["AXISBANK", 74, "+0.6%"], ["ADANIPORTS", 72, "+1.4%"],
  ["MARUTI", 70, "+0.3%"], ["TITAN", 68, "-0.2%"], ["POWERGRID", 66, "+0.4%"], ["ONGC", 64, "+0.8%"],
  ["COALINDIA", 62, "+0.5%"], ["INFY", 55, "-0.9%"], ["TCS", 51, "-1.1%"], ["HCLTECH", 47, "-1.4%"],
];

const SECTORS = [
  ["METALS", 91, "up"], ["BANKING", 83, "up"], ["ENERGY", 71, "up"], ["AUTO", 63, "flat"],
  ["FMCG", 58, "flat"], ["PHARMA", 52, "flat"], ["REALTY", 46, "down"], ["IT", 39, "down"],
];

const CHAIN = [
  { k: 24000, ceOI: 42.1, ceChg: -8.2, peOI: 88.4, peChg: 12.1 },
  { k: 24100, ceOI: 51.7, ceChg: -14.6, peOI: 121.9, peChg: 31.4, tag: "PUT WALL" },
  { k: 24200, ceOI: 68.2, ceChg: -22.8, peOI: 74.3, peChg: 18.9, tag: "DECISION" },
  { k: 24300, ceOI: 91.5, ceChg: 4.2, peOI: 38.1, peChg: -6.3 },
  { k: 24400, ceOI: 134.8, ceChg: -3.1, peOI: 21.7, peChg: -9.8, tag: "CALL WALL" },
  { k: 24500, ceOI: 77.2, ceChg: 1.9, peOI: 12.4, peChg: -2.2 },
];

const NEWS = [
  { t: "10:43:21", sym: "RAILTEL", cat: "Regulatory action", tone: "NEG", impact: 82, px: "-1.8%", vol: "3.2×", note: "Exchange filing detected. Support ₹620 lost. Wait for volume confirmation before any PE entry." },
  { t: "10:12:05", sym: "TATASTEEL", cat: "Capacity addition", tone: "POS", impact: 64, px: "+1.8%", vol: "2.1×", note: "Price confirming. Sector already leading — adds weight to metals bias." },
  { t: "09:58:40", sym: "IEX", cat: "Volume/market data", tone: "POS", impact: 58, px: "+3.4%", vol: "2.8×", note: "Monthly volumes ahead of run-rate. Breakout held above PWH." },
  { t: "09:41:17", sym: "INFY", cat: "Management change", tone: "NEUT", impact: 41, px: "-0.9%", vol: "1.1×", note: "No price confirmation. IT sector weakest on the board. No action." },
];

const REJECTED = [
  ["HDFCBANK 1750 CE", "Breadth divergence", 68],
  ["ADANIENT 2400 CE", "Spread too wide", 61],
  ["ZOMATO 280 PE", "Fake breakdown risk", 59],
  ["DIVISLAB 6200 CE", "Sector weak", 54],
  ["BAJFINANCE 7400 PE", "Premium overpriced", 49],
];

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
  }}>{children}</span>
);

const Row = ({ label, value, color }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
    <span className="mono" style={{ fontSize: 10.5, color: C.dim, letterSpacing: ".04em" }}>{label}</span>
    <span className="mono" style={{ fontSize: 12.5, color: color || C.text, fontWeight: 500 }}>{value}</span>
  </div>
);

const Meter = ({ v, max = 100, color }) => (
  <div style={{ height: 3, background: C.lineSoft, borderRadius: 2, overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(100, (v / max) * 100))}%`, height: "100%", background: color, transition: "width .5s ease" }} />
  </div>
);

const tierColor = (t) => (t === "GOLD" ? C.gold : t === "SILVER" ? C.silver : C.lite);

/* ---------------- signature: mood tug-of-war ---------------- */
function MoodBar({ bull, bear }) {
  const total = bull + bear;
  const bullPct = (bull / total) * 100;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".18em", color: C.dim }}>MARKET MOOD</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-.02em", lineHeight: 1.1, marginTop: 3 }}>
            BULLISH EXPANSION
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 22, color: C.bull, fontWeight: 600 }}>{bull}</div>
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".1em" }}>BULL / BEAR</div>
          <div className="mono" style={{ fontSize: 22, color: C.bear, fontWeight: 600 }}>{bear}</div>
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
        {[
          ["BREADTH", "Positive", C.bull], ["VWAP", "Above", C.bull], ["FUT FLOW", "Long build-up", C.bull],
          ["OPT FLOW", "CE supportive", C.bull], ["VOLATILITY", "Expanding", C.saffron], ["REGIME", "Trend day", C.saffron],
        ].map(([k, v, col]) => (
          <div key={k} style={{ background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "7px 9px" }}>
            <div className="mono" style={{ fontSize: 9, color: C.dim, letterSpacing: ".12em" }}>{k}</div>
            <div className="mono" style={{ fontSize: 11.5, color: col, marginTop: 2 }}>{v}</div>
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
        border: `1px solid ${active ? C.saffron + "66" : C.line}`,
        borderLeft: `3px solid ${tierColor(s.tier)}`,
        borderRadius: 4, padding: 12, marginBottom: 8, transition: "border-color .2s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>
            {s.sym} {s.strike} <span style={{ color: s.side === "CE" ? C.bull : C.bear }}>{s.side}</span>
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
        <span style={{ color: C.dim }}>LTP <span style={{ color: C.text }}>₹{s.premium.toFixed(s.premium < 20 ? 2 : 1)}</span></span>
        <span style={{ color: C.dim }}>Entry <span style={{ color: C.text }}>₹{s.entry[0]}–{s.entry[1]}</span></span>
        <span style={{ color: C.dim }}>SL <span style={{ color: C.bear }}>₹{s.sl}</span></span>
        <span style={{ color: C.dim }}>Tgt <span style={{ color: C.bull }}>{s.tgts.join(" / ")}</span></span>
      </div>

      <StageRail stage={s.stage} />
    </button>
  );
}

/* ---------------- setup detail ---------------- */
function SetupDetail({ s, clock }) {
  if (!s) return null;
  const risk = (s.filled || s.entry[1]) - s.sl;
  const base = s.filled || s.entry[1];
  return (
    <div className="krt-in">
      <Panel title={`SETUP DOSSIER · ${s.sym} ${s.strike} ${s.side}`} right={<Tag color={tierColor(s.tier)} solid>{s.tier}</Tag>}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <div className="mono" style={{ fontSize: 34, fontWeight: 600, color: s.score >= 90 ? C.gold : C.text, lineHeight: 1 }}>
            {Math.round(s.score)}
          </div>
          <div>
            <div className="mono" style={{ fontSize: 10, color: C.dim, letterSpacing: ".12em" }}>KRT MASTER SCORE</div>
            <div className="mono" style={{ fontSize: 10.5, color: C.saffron }}>Stage · {STAGES[s.stage]}</div>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          {Object.entries(s.breakdown).map(([k, v]) => {
            const maxes = s.breakdownMax || {};
            const m = maxes[k];
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
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {s.why.map((w) => (
            <li key={w} className="mono" style={{ fontSize: 11, color: C.text, padding: "3px 0 3px 12px", position: "relative" }}>
              <span style={{ position: "absolute", left: 0, color: C.saffron }}>›</span>{w}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="RISK & POSITION CALCULATOR" style={{ marginTop: 12 }}>
        <Row label="LOT SIZE (EXCHANGE)" value={s.lot} />
        <Row label="ENTRY REFERENCE" value={`₹${base}`} />
        <Row label="1 LOT COST" value={`₹${(base * s.lot).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} />
        <Row label="STOP LOSS" value={`₹${s.sl}`} color={C.bear} />
        <Row label="MAX RISK / LOT" value={`₹${(risk * s.lot).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} color={C.bear} />
        {s.tgts.map((t, i) => (
          <Row key={i} label={`TARGET ${i + 1} · ₹${t}`}
            value={`+₹${((t - base) * s.lot).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
            color={C.bull} />
        ))}
        <Row label="R:R AT T2" value={`1 : ${((s.tgts[1] - base) / risk).toFixed(1)}`} color={C.saffron} />
      </Panel>

      <Panel title="FRESH ENTRY SAFETY" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Tag color={s.fresh ? C.bull : C.bear} solid>{s.fresh ? "RE-ENTRY POSSIBLE" : "NOT SAFE"}</Tag>
          <span className="mono" style={{ fontSize: 11, color: C.dim }}>{s.freshNote}</span>
        </div>
      </Panel>

      <Panel title="HISTORICAL MATCH" style={{ marginTop: 12 }}>
        <Row label="SIMILAR SETUPS FOUND" value="426" />
        <Row label="T1 BEFORE SL" value="72%" color={C.bull} />
        <Row label="T2 BEFORE SL" value="58%" color={C.bull} />
        <Row label="MEDIAN MAX MOVE" value="+34 pts" />
        <Row label="WORST REGIME" value="Low-volume range days" color={C.bear} />
        <div className="mono" style={{ fontSize: 9.5, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
          Placeholder statistics. Real probabilities require a backtest over your own tick history — the terminal must never invent these.
        </div>
      </Panel>
    </div>
  );
}

/* ---------------- tabs ---------------- */
function CommandTab({ mood, setups, clock, openSetup }) {
  const gold = setups.filter((s) => s.tier === "GOLD");
  const armed = setups.filter((s) => s.stage >= 2 && s.stage < 3);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel pad={16} style={{ background: `radial-gradient(120% 140% at 50% -20%, ${C.saffron}14, transparent 60%), ${C.panel}` }}>
        <MoodBar bull={mood.bull} bear={mood.bear} />
      </Panel>

      <Panel title="AI HEADLINE" right={<span className="mono krt-live" style={{ fontSize: 9.5, color: C.saffron }}>● LIVE</span>}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, letterSpacing: "-.01em" }}>
          NIFTY CE setups are the cleanest thing on the board. METALS is carrying the tape —
          watch <b style={{ color: C.saffron }}>TATASTEEL, HINDALCO, JSWSTEEL</b> for catch-up.
          BANKNIFTY is unclear; don't force it. SENSEX is diverging lower, so a PE hedge is armed.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <Tag color={C.gold}>BEST NOW · NIFTY 24200 CE</Tag>
          <Tag color={C.saffron}>RISK · MODERATE</Tag>
          <Tag color={C.dim}>AVOID · IT, weak midcaps</Tag>
        </div>
      </Panel>

      <div className="krt-cols">
        <div style={{ display: "grid", gap: 12 }}>
          <Panel title="GOLD SETUPS" right={<span className="mono" style={{ fontSize: 10, color: C.dim }}>{gold.length} live</span>} pad={10}>
            {gold.length ? gold.map((s) => <SetupCard key={s.id} s={s} onOpen={openSetup} />) : <Empty>No GOLD setup on the board right now. Silence is a valid output.</Empty>}
          </Panel>

          <Panel title="PRE-MOVE ENGINE · ARMED" pad={12}>
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>VBL <span className="mono" style={{ fontSize: 12, color: C.dim, fontWeight: 400 }}>₹449.70</span></div>
                <Tag color={C.saffron} solid>ARMED</Tag>
              </div>
            </div>
            <Row label="COMPRESSION ENERGY" value="88 / 100" color={C.saffron} />
            <Row label="ACCUMULATION" value="HIGH" color={C.bull} />
            <Row label="RELATIVE STRENGTH" value="STRONG" color={C.bull} />
            <Row label="TRIGGER ABOVE" value="₹452.20" color={C.saffron} />
            <Row label="LIQUIDITY VACUUM" value="₹452 → ₹465" color={C.bull} />
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
              Price is coiling, not breaking. Nothing to do until ₹452.20 trades with volume behind it.
            </div>
          </Panel>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <Panel title="HERO 20" pad={0}>
            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              {HERO20.map(([sym, sc, chg], i) => (
                <div key={sym} style={{
                  display: "grid", gridTemplateColumns: "22px 1fr 52px 46px", gap: 8, alignItems: "center",
                  padding: "7px 12px", borderBottom: `1px solid ${C.lineSoft}`,
                  background: i < 3 ? `${C.saffron}0A` : "transparent",
                }}>
                  <span className="mono" style={{ fontSize: 10, color: i < 3 ? C.saffron : "#4A5468" }}>{String(i + 1).padStart(2, "0")}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{sym}</span>
                  <span className="mono" style={{ fontSize: 11, color: chg.startsWith("+") ? C.bull : C.bear, textAlign: "right" }}>{chg}</span>
                  <span className="mono" style={{ fontSize: 12, textAlign: "right", color: sc >= 85 ? C.gold : C.text }}>{sc}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="SECTOR ROTATION" pad={12}>
            {SECTORS.map(([name, sc, dir]) => (
              <div key={name} style={{ marginBottom: 9 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span className="mono" style={{ fontSize: 10.5, color: dir === "up" ? C.text : C.dim }}>{name}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: sc >= 80 ? C.bull : sc >= 55 ? C.saffron : C.bear }}>{sc}</span>
                </div>
                <Meter v={sc} color={sc >= 80 ? C.bull : sc >= 55 ? C.saffron : C.bear} />
              </div>
            ))}
            <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
              Leader <span style={{ color: C.bull }}>HINDALCO</span> · Lagging but improving <span style={{ color: C.saffron }}>TATASTEEL</span> — catch-up candidate.
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function SetupsTab({ setups, openSetup, selected }) {
  const ce = setups.filter((s) => s.side === "CE");
  const pe = setups.filter((s) => s.side === "PE");
  const sel = setups.find((s) => s.id === selected);
  return (
    <div className="krt-cols" style={{ gap: 12 }}>
      <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
        <Panel title="JACKPOT CE BOARD" pad={10} right={<Tag color={C.bull}>{ce.length}</Tag>}>
          {ce.length ? ce.map((s) => <SetupCard key={s.id} s={s} onOpen={openSetup} active={s.id === selected} />) : <Empty>Nothing on the CE side has cleared the filter.</Empty>}
        </Panel>
        <Panel title="JACKPOT PE BOARD" pad={10} right={<Tag color={C.bear}>{pe.length}</Tag>}>
          {pe.length ? pe.map((s) => <SetupCard key={s.id} s={s} onOpen={openSetup} active={s.id === selected} />) : <Empty>Nothing on the PE side has cleared the filter.</Empty>}
        </Panel>
        <Panel title="REJECTED BY QUALITY FILTER" pad={0}>
          {REJECTED.map(([n, r, sc]) => (
            <div key={n} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div>
                <div className="mono" style={{ fontSize: 11, color: C.dim }}>{n}</div>
                <div className="mono" style={{ fontSize: 9.5, color: C.bear, marginTop: 2 }}>{r}</div>
              </div>
              <span className="mono" style={{ fontSize: 11, color: "#4A5468" }}>{sc}</span>
            </div>
          ))}
          <div className="mono" style={{ fontSize: 9.5, color: C.dim, padding: "8px 12px" }}>
            Below 72 never reaches the board. Silence is a valid output.
          </div>
        </Panel>
      </div>
      <div>{sel ? <SetupDetail s={sel} /> : (
        <Panel title="SETUP DOSSIER">
          <div className="mono" style={{ fontSize: 11.5, color: C.dim, lineHeight: 1.6, padding: "20px 0", textAlign: "center" }}>
            Pick a setup from the board to see its score breakdown, position maths and re-entry status.
          </div>
        </Panel>
      )}</div>
    </div>
  );
}

function FlowTab() {
  const maxOI = Math.max(...CHAIN.flatMap((r) => [r.ceOI, r.peOI]));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title="NIFTY OPTIONS POSITIONING · GAMMA MAP" pad={0}>
        <div style={{ padding: "10px 14px", display: "flex", gap: 18, borderBottom: `1px solid ${C.lineSoft}`, flexWrap: "wrap" }}>
          <div><div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".1em" }}>PUT WALL</div><div className="mono" style={{ fontSize: 15, color: C.bull }}>24100</div></div>
          <div><div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".1em" }}>DECISION</div><div className="mono" style={{ fontSize: 15, color: C.saffron }}>24200</div></div>
          <div><div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".1em" }}>CALL WALL</div><div className="mono" style={{ fontSize: 15, color: C.bear }}>24400</div></div>
          <div><div className="mono" style={{ fontSize: 9.5, color: C.dim, letterSpacing: ".1em" }}>GAMMA REGIME</div><div className="mono" style={{ fontSize: 15, color: C.saffron }}>EXPANSION</div></div>
        </div>
        <div>
          {CHAIN.map((r) => (
            <div key={r.k} style={{
              display: "grid", gridTemplateColumns: "1fr 78px 1fr", alignItems: "center", gap: 10,
              padding: "8px 14px", borderBottom: `1px solid ${C.lineSoft}`,
              background: r.tag ? `${C.saffron}0A` : "transparent",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                <span className="mono" style={{ fontSize: 10, color: r.ceChg < 0 ? C.bull : C.bear }}>
                  {r.ceChg > 0 ? "+" : ""}{r.ceChg}%
                </span>
                <div style={{ width: `${(r.ceOI / maxOI) * 100}%`, height: 14, background: `${C.bear}55`, borderRadius: 2 }} />
              </div>
              <div style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{r.k}</div>
                {r.tag && <div className="mono" style={{ fontSize: 8, color: C.saffron, letterSpacing: ".08em" }}>{r.tag}</div>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: `${(r.peOI / maxOI) * 100}%`, height: 14, background: `${C.bull}55`, borderRadius: 2 }} />
                <span className="mono" style={{ fontSize: 10, color: r.peChg > 0 ? C.bull : C.bear }}>
                  {r.peChg > 0 ? "+" : ""}{r.peChg}%
                </span>
              </div>
            </div>
          ))}
          <div className="mono" style={{ display: "flex", justifyContent: "space-between", padding: "7px 14px", fontSize: 9.5, color: C.dim, letterSpacing: ".1em" }}>
            <span>← CALL OI (lakh)</span><span>PUT OI (lakh) →</span>
          </div>
        </div>
      </Panel>

      <div className="krt-cols2">
        <Panel title="OI VELOCITY · 24200 CE">
          <Row label="PREMIUM VELOCITY" value="HIGH" color={C.saffron} />
          <Row label="CE OI CHANGE / MIN" value="−1.42 L" color={C.bull} />
          <Row label="OI ACCELERATION" value="Rising" color={C.bull} />
          <Row label="VOLUME / OI RATIO" value="2.87" color={C.bull} />
          <Row label="STRIKE MIGRATION" value="24200 → 24300" color={C.saffron} />
          <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
            Call writers are stepping back and buyers are rolling up a strike. Upside pressure increasing.
          </div>
        </Panel>

        <Panel title="CROSS-STRIKE FLOW">
          {[["24100 CE", "Stable", C.dim], ["24200 CE", "Strong buying", C.bull], ["24300 CE", "Volume rising", C.bull], ["24400 CE", "Writers reducing", C.bull], ["24100 PE", "Fresh writing", C.bull], ["24000 PE", "Adding", C.bull]].map(([k, v, col]) => (
            <Row key={k} label={k} value={v} color={col} />
          ))}
        </Panel>
      </div>

      <div className="krt-cols2">
        <Panel title="IV & GREEKS · 24200 CE">
          <Row label="PREMIUM MOVE" value="₹50 → ₹64" color={C.bull} />
          <Row label="UNDERLYING CONTRIBUTION" value="STRONG" color={C.bull} />
          <Row label="IV CONTRIBUTION" value="MODERATE" color={C.saffron} />
          <Row label="IV / IV PERCENTILE" value="14.2 · 61%" />
          <Row label="DELTA · GAMMA" value="0.58 · 0.0042" />
          <Row label="THETA / DAY" value="−₹4.1" color={C.bear} />
          <Row label="PREMIUM QUALITY" value="GOOD" color={C.bull} />
          <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
            The move is being paid for by spot, not by IV. That's the kind of premium that holds.
          </div>
        </Panel>

        <Panel title="INDEX CONFIRMATION">
          <Row label="NIFTY" value="Breakout held" color={C.bull} />
          <Row label="BANKNIFTY" value="Not confirming" color={C.bear} />
          <Row label="SENSEX" value="Diverging lower" color={C.bear} />
          <Row label="BREADTH" value="72% advancing" color={C.bull} />
          <Row label="HEAVYWEIGHTS" value="Mixed" color={C.saffron} />
          <div style={{ marginTop: 12, padding: 10, background: `${C.saffron}12`, border: `1px solid ${C.saffron}44`, borderRadius: 3 }}>
            <div className="mono" style={{ fontSize: 10, color: C.saffron, letterSpacing: ".1em", marginBottom: 4 }}>⚠ DIVERGENCE</div>
            <div className="mono" style={{ fontSize: 10.5, color: C.text, lineHeight: 1.5 }}>
              BankNifty isn't following. Any second NIFTY CE would be downgraded GOLD → SILVER.
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function RadarTab() {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="krt-cols2">
        <Panel title="CRASH RADAR" right={<Tag color={C.bear}>2</Tag>}>
          {[
            { s: "RAILTEL", risk: 86, sup: "₹620", below: "₹608", tg: ["₹598", "₹580", "₹552"], why: "Support lost · heavy sell volume · futures short build-up · negative disclosure" },
            { s: "HCLTECH", risk: 71, sup: "₹1,640", below: "₹1,628", tg: ["₹1,602", "₹1,571"], why: "Sector weakest · VWAP rejected twice · relative weakness" },
          ].map((x) => (
            <div key={x.s} style={{ padding: "10px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{x.s}</span>
                <span className="mono" style={{ fontSize: 13, color: C.bear }}>{x.risk}/100</span>
              </div>
              <Meter v={x.risk} color={C.bear} />
              <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 7 }}>
                Support {x.sup} · below {x.below} → <span style={{ color: C.bear }}>{x.tg.join(" · ")}</span>
              </div>
              <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 4, lineHeight: 1.5 }}>{x.why}</div>
            </div>
          ))}
        </Panel>

        <Panel title="SHORT SQUEEZE RADAR" right={<Tag color={C.bull}>1</Tag>}>
          <div style={{ padding: "10px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>IEX</span>
              <span className="mono" style={{ fontSize: 13, color: C.bull }}>91/100</span>
            </div>
            <Meter v={91} color={C.bull} />
            <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 7 }}>
              Trigger ₹850 · above → <span style={{ color: C.bull }}>₹872 · ₹895 · ₹930</span>
            </div>
            <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 4, lineHeight: 1.5 }}>
              Short covering · high relative strength · call unwinding · resistance absorbed on volume
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="FAKE BREAKOUT / TRAP ENGINE" right={<Tag color={C.bear}>1 ACTIVE</Tag>}>
        <div style={{ padding: 12, background: `${C.bear}12`, border: `1px solid ${C.bear}44`, borderRadius: 3 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>ZOMATO · bull trap</span>
            <Tag color={C.bear} solid>DO NOT CHASE CE</Tag>
          </div>
          <div className="mono" style={{ fontSize: 11, color: C.text, lineHeight: 1.7 }}>
            ₹284 broke and gave back. Volume didn't confirm, OI didn't confirm, VWAP lost on the retest.
            Classic liquidity sweep above the morning high — the buyers who chased are now the fuel.
          </div>
        </div>
      </Panel>

      <div className="krt-cols2">
        <Panel title="LEVEL BREAK ENGINE · PDH / PWH / PMH">
          {[["IEX", "PWH ₹842", "₹851", "2.1×", C.bull], ["VBL", "PDH ₹452.20", "₹449.70", "1.4×", C.saffron], ["TATASTEEL", "PDH ₹188.60", "₹187.20", "1.2×", C.saffron], ["INFY", "PDL ₹1,486", "₹1,481", "1.8×", C.bear]].map(([s, lvl, cur, vol, col]) => (
            <div key={s} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 60px 42px", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
              <span style={{ fontSize: 12 }}>{s}</span>
              <span className="mono" style={{ fontSize: 10, color: C.dim }}>{lvl}</span>
              <span className="mono" style={{ fontSize: 11, color: col, textAlign: "right" }}>{cur}</span>
              <span className="mono" style={{ fontSize: 10, color: C.dim, textAlign: "right" }}>{vol}</span>
            </div>
          ))}
        </Panel>

        <Panel title="LIQUIDITY MAP · VBL" pad={12}>
          {[["₹472", "Sell liquidity", C.bear], ["₹465", "Low volume zone", C.dim], ["₹452", "Breakout liquidity", C.saffron], ["₹448", "Major decision", C.text], ["₹439", "Buy liquidity", C.bull]].map(([p, l, col]) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
              <span className="mono" style={{ fontSize: 12, width: 44, color: col }}>{p}</span>
              <div style={{ flex: 1, height: 1, background: col + "44" }} />
              <span className="mono" style={{ fontSize: 10, color: C.dim }}>{l}</span>
            </div>
          ))}
          <div style={{ marginTop: 10, padding: 10, background: `${C.saffron}12`, border: `1px solid ${C.saffron}44`, borderRadius: 3 }}>
            <div className="mono" style={{ fontSize: 10.5, color: C.saffron, lineHeight: 1.5 }}>
              ⚡ Vacuum ₹452 → ₹465. Thin book between. If ₹452 holds above, the move can be quick.
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function NewsTab() {
  const toneCol = (t) => (t === "POS" ? C.bull : t === "NEG" ? C.bear : C.dim);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Panel title="NEWS INTELLIGENCE CENTER" right={<span className="mono" style={{ fontSize: 9.5, color: C.dim }}>SOURCE · EXCHANGE FILINGS (SIM)</span>} pad={0}>
        {NEWS.map((n) => (
          <div key={n.t} style={{ padding: "12px 14px", borderBottom: `1px solid ${C.lineSoft}`, background: n.impact >= 80 ? `${C.bear}0A` : "transparent" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ fontSize: 10, color: C.dim }}>{n.t}</span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{n.sym}</span>
                <Tag color={toneCol(n.tone)}>{n.tone}</Tag>
                {n.impact >= 80 && <Tag color={C.saffron} solid>HIGH IMPACT</Tag>}
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: C.dim }}>
                impact {n.impact} · px <span style={{ color: n.px.startsWith("+") ? C.bull : C.bear }}>{n.px}</span> · vol {n.vol}
              </div>
            </div>
            <div className="mono" style={{ fontSize: 10, color: C.saffron, marginTop: 6, letterSpacing: ".06em" }}>{n.cat.toUpperCase()}</div>
            <div className="mono" style={{ fontSize: 11, color: C.text, marginTop: 4, lineHeight: 1.6 }}>{n.note}</div>
          </div>
        ))}
      </Panel>

      <div className="krt-cols2">
        <Panel title="NEWS + PRICE CONFIRMATION">
          <div style={{ padding: 11, background: `${C.bull}12`, border: `1px solid ${C.bull}44`, borderRadius: 3, marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>TATASTEEL · confirmed</div>
            <Row label="NEWS SCORE" value="64" />
            <Row label="PRICE BREAKOUT" value="CONFIRMED" color={C.bull} />
            <Row label="VOLUME" value="2.1× normal" color={C.bull} />
            <Row label="FUTURES" value="Long build-up" color={C.bull} />
            <div className="mono" style={{ fontSize: 10.5, color: C.bull, marginTop: 8 }}>→ CE setup active</div>
          </div>
          <div style={{ padding: 11, background: `${C.bear}12`, border: `1px solid ${C.bear}44`, borderRadius: 3 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>INFY · not confirmed</div>
            <Row label="NEWS SCORE" value="41" />
            <Row label="PRICE CONFIRMATION" value="WEAK" color={C.bear} />
            <div className="mono" style={{ fontSize: 10.5, color: C.bear, marginTop: 8 }}>→ Do not enter yet</div>
          </div>
        </Panel>

        <Panel title="CHARTINK BRIDGE" right={<Tag color={C.bull}>CONNECTED (SIM)</Tag>}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>VBL</span>
              <span className="mono" style={{ fontSize: 10, color: C.dim }}>09:41:08</span>
            </div>
            <div className="mono" style={{ fontSize: 10, color: C.saffron, marginTop: 3 }}>4 / 4 SCANNER CONSENSUS</div>
          </div>
          {[["Breakout scanner", true], ["Volume spike scanner", true], ["VWAP scanner", true], ["Relative strength scanner", true]].map(([n, ok]) => (
            <Row key={n} label={n.toUpperCase()} value={ok ? "HIT" : "—"} color={ok ? C.bull : C.dim} />
          ))}
          <div style={{ height: 10 }} />
          {[["Structure", "PASS"], ["Volume", "PASS"], ["OI", "PASS"], ["Sector", "PASS"], ["News", "CLEAR"]].map(([k, v]) => (
            <Row key={k} label={`KRT · ${k.toUpperCase()}`} value={v} color={C.bull} />
          ))}
          <div className="mono" style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
            Chartink only nominates. KRT decides whether the nomination deserves a strike — here it converts to <span style={{ color: C.silver }}>VBL 480 CE · SILVER</span>.
          </div>
        </Panel>
      </div>
    </div>
  );
}

function JournalTab({ setups, clock }) {
  const live = setups.find((s) => s.stage >= 3);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {live && (
        <Panel title="LIVE TRADE MANAGER" right={<span className="mono krt-live" style={{ fontSize: 9.5, color: C.bull }}>● IN POSITION</span>}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 19, fontWeight: 700 }}>
              {live.sym} {live.strike} <span style={{ color: C.bull }}>{live.side}</span>
            </div>
            <div className="mono" style={{ fontSize: 20, color: C.bull }}>
              ₹{live.premium.toFixed(1)} <span style={{ fontSize: 12 }}>
                (+{(((live.premium - live.filled) / live.filled) * 100).toFixed(1)}%)
              </span>
            </div>
          </div>
          <StageRail stage={live.stage} />
          <div style={{ height: 14 }} />
          <Row label="SIGNAL TIME" value={fmtClock(live.signalAt)} />
          <Row label="ENTRY FILLED" value={`₹${live.filled} @ ${fmtClock(live.entryAt)}`} />
          <Row label="T1 · ₹62" value={live.hits[0] ? `HIT @ ${fmtClock(live.hits[0])}` : "PENDING"} color={live.hits[0] ? C.bull : C.dim} />
          <Row label="T2 · ₹72" value={live.hits[1] ? `HIT @ ${fmtClock(live.hits[1])}` : "PENDING"} color={live.hits[1] ? C.bull : C.dim} />
          <Row label="T3 · ₹84" value={live.hits[2] ? `HIT @ ${fmtClock(live.hits[2])}` : "PENDING"} color={live.hits[2] ? C.bull : C.dim} />
          <Row label="STOP LOSS" value={`₹${live.sl}`} color={C.bear} />
          <Row label="OPEN P&L · 1 LOT" value={`+₹${((live.premium - live.filled) * live.lot).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} color={C.bull} />
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Tag color={C.bull} solid>HOLD EXISTING</Tag>
            <Tag color={C.bear}>NO FRESH ENTRY — DON'T CHASE</Tag>
          </div>
        </Panel>
      )}

      <div className="krt-cols2">
        <Panel title="SETUP DECAY">
          {[[fmtClock(startSec - 14), 88], [fmtClock(startSec + 406), 84], [fmtClock(startSec + 946), 71], [fmtClock(startSec + 1246), 58]].map(([t, v]) => (
            <div key={t} style={{ display: "grid", gridTemplateColumns: "64px 1fr 30px", gap: 8, alignItems: "center", padding: "4px 0" }}>
              <span className="mono" style={{ fontSize: 10, color: C.dim }}>{t}</span>
              <Meter v={v} color={v >= 82 ? C.gold : v >= 72 ? C.silver : C.bear} />
              <span className="mono" style={{ fontSize: 10.5, textAlign: "right", color: v < 72 ? C.bear : C.text }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop: 10 }}><Tag color={C.bear} solid>EXPIRED — REMOVED FROM BOARD</Tag></div>
          <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
            A setup that hasn't triggered keeps losing confidence. Stale calls leave the board on their own.
          </div>
        </Panel>

        <Panel title="RISK GUARDIAN">
          <Row label="DAILY MAX LOSS" value="₹15,000" />
          <Row label="USED TODAY" value="₹4,200 (28%)" color={C.saffron} />
          <Row label="TRADES TAKEN" value="2 / 4" />
          <Row label="CONSECUTIVE SL" value="1 / 2" color={C.saffron} />
          <Row label="STATUS" value="ACTIVE" color={C.bull} />
          <div style={{ marginTop: 12 }}>
            <Meter v={28} color={C.saffron} />
          </div>
          <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
            At the limit the board locks: <span style={{ color: C.bear }}>no new trades for the day</span>, regardless of setup quality.
          </div>
        </Panel>
      </div>

      <Panel title="DAILY JOURNAL · 28-AUG-2026">
        <div className="krt-cols3" style={{ gap: 10 }}>
          {[["SIGNALS", 8, C.text], ["TRIGGERED", 5, C.saffron], ["TARGETS HIT", 4, C.bull], ["STOP LOSS", 1, C.bear], ["REJECTED", 17, C.dim], ["NO-TRADE AVOIDED", 11, C.dim]].map(([k, v, col]) => (
            <div key={k} style={{ background: C.raised, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "10px 12px" }}>
              <div className="mono" style={{ fontSize: 9, color: C.dim, letterSpacing: ".12em" }}>{k}</div>
              <div className="mono" style={{ fontSize: 22, color: col, marginTop: 3 }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: C.dim, marginBottom: 8 }}>END-OF-DAY REVIEW</div>
          {[
            ["Why winners worked", "Trend-day regime called correctly at 09:25. Breadth filter kept every entry on the strong side.", C.bull],
            ["Why the loser failed", "SENSEX PE taken during an index divergence that resolved upward. Divergence should downgrade, not trigger.", C.bear],
            ["Noisy inputs", "IV percentile added nothing today. Gamma flip and breadth carried the signal.", C.saffron],
          ].map(([h, b, col]) => (
            <div key={h} style={{ padding: "8px 0", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div className="mono" style={{ fontSize: 10, color: col, letterSpacing: ".06em" }}>{h.toUpperCase()}</div>
              <div className="mono" style={{ fontSize: 11, color: C.text, marginTop: 3, lineHeight: 1.6 }}>{b}</div>
            </div>
          ))}
          <div className="mono" style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
            Findings are logged, not applied. Weight changes go through a backtest before they touch the live model.
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ---------------- shell ---------------- */
const TABS = [
  { id: "command", label: "COMMAND", sub: "mood · headline" },
  { id: "setups", label: "SETUPS", sub: "jackpot board" },
  { id: "flow", label: "FLOW", sub: "OI · gamma · IV" },
  { id: "radar", label: "RADAR", sub: "crash · squeeze" },
  { id: "news", label: "NEWS", sub: "filings · chartink" },
  { id: "journal", label: "JOURNAL", sub: "trades · risk" },
];

function KRTTerminal() {
  const [tab, setTab] = useState("command");
  const feed = useFeed();
  const setups = feed.setups;
  const mood = feed.mood;
  const sec = feed.sec;
  const [selected, setSelected] = useState(null);

  // keep a valid selection as the board changes underneath us
  useEffect(() => {
    if (!setups.length) return;
    if (!setups.some((s) => s.id === selected)) setSelected(setups[0].id);
  }, [setups, selected]);

  const open = (id) => { setSelected(id); setTab("setups"); };

  return (
    <div className="krt">
      <style>{CSS}</style>
      <div className="krt-shell">
        {/* rail */}
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

        {/* main */}
        <main style={{ minWidth: 0 }}>
          <header style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            padding: "10px 16px", borderBottom: `1px solid ${C.line}`, background: C.panel, flexWrap: "wrap",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div className="mono" style={{ fontSize: 16, color: C.saffron, fontWeight: 600 }}>{fmtClock(sec)}</div>
              <Tag color={feed.sessionOpen ? C.bull : C.dim}>{feed.sessionLabel}</Tag>
              {feed.indices.map(([n, p, c]) => (
                <div key={n} className="mono" style={{ fontSize: 10.5 }}>
                  <span style={{ color: C.dim }}>{n} </span>
                  <span>{p} </span>
                  <span style={{ color: c.startsWith("+") ? C.bull : C.bear }}>{c}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Tag color={feed.source === "live" ? C.bull : feed.source === "stale" ? C.bear : C.saffron}>
                {feed.sourceLabel}
              </Tag>
              <button onClick={feed.reload} className="mono" style={{
                fontSize: 9.5, letterSpacing: ".1em", color: C.dim, padding: "3px 8px",
                border: `1px solid ${C.line}`, borderRadius: 2,
              }}>REFRESH</button>
            </div>
          </header>

          <div style={{ padding: 12 }}>
            {tab === "command" && <CommandTab mood={mood} setups={setups} clock={sec} openSetup={open} />}
            {tab === "setups" && <SetupsTab setups={setups} openSetup={setSelected} selected={selected} />}
            {tab === "flow" && <FlowTab />}
            {tab === "radar" && <RadarTab />}
            {tab === "news" && <NewsTab />}
            {tab === "journal" && <JournalTab setups={setups} clock={sec} />}
          </div>

          <footer style={{ padding: "14px 16px 24px", borderTop: `1px solid ${C.line}` }}>
            <div className="mono" style={{ fontSize: 10, color: C.dim, lineHeight: 1.7, maxWidth: 760 }}>
              {feed.disclaimer}
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}


/* ============================================================
   MOUNT
   ============================================================ */
ReactDOM.createRoot(document.getElementById("root")).render(<KRTTerminal />);

/* KRT AI Terminal - front end.
   Renders whatever the v3 backend returns from /api/snapshot, /api/calls,
   /api/chain, /api/diagnostics and /api/accuracy.

   Two rules this file follows everywhere:
   1. A missing field renders as "not available", never as a zero. A zero the
      trader believes is worse than an empty box that tells the truth.
   2. Green and red mean the market. Saffron means the interface. They never
      swap jobs, so colour alone always carries the same meaning. */

(() => {
  "use strict";

  /* ============================================================= helpers */
  const $ = (id) => document.getElementById(id);
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const has = (v) => v !== null && v !== undefined && v !== "";
  const num = (v, d = 2) => (has(v) && isFinite(v) ? Number(v).toFixed(d) : null);

  const money = (v) => {
    if (!has(v) || !isFinite(v)) return "—";
    const n = Number(v);
    return "\u20B9" + n.toFixed(n < 100 ? 2 : n < 10000 ? 1 : 0);
  };

  const pct = (v, d = 2) => {
    if (!has(v) || !isFinite(v)) return "—";
    const n = Number(v);
    return (n >= 0 ? "+" : "") + n.toFixed(d) + "%";
  };

  const dirClass = (v) => (!has(v) ? "muted" : Number(v) >= 0 ? "bull" : "bear");

  const sideClass = (s) => (s === "CE" ? "bull" : s === "PE" ? "bear" : "muted");

  const tierColour = (t) =>
    ({ JACKPOT: "var(--gold)", STRONG: "var(--silver)", GOOD: "var(--lite)",
       WATCHLIST: "var(--faint)", IGNORE: "var(--faint)" }[t] || "var(--lite)");

  const toneColour = (t) =>
    ({ bull: "var(--bull)", bear: "var(--bear)", gold: "var(--gold)",
       cool: "var(--blue)", muted: "var(--dim)" }[t] || "var(--dim)");

  const scoreColour = (n) =>
    !has(n) ? "var(--dim)"
      : n >= 90 ? "var(--gold)"
      : n >= 82 ? "var(--silver)"
      : n >= 70 ? "var(--text)"
      : "var(--dim)";

  /* Small builders. Keeping the markup in functions rather than template
     soup makes the panels below readable. */
  const tag = (text, colour, solid) =>
    `<span class="tag${solid ? " solid" : ""}" style="color:${colour}"><span>${esc(text)}</span></span>`;

  const row = (k, v, colour) =>
    `<div class="row"><span class="k">${esc(k)}</span>` +
    `<span class="v"${colour ? ` style="color:${colour}"` : ""}>${v}</span></div>`;

  const meter = (v, max, colour) => {
    const w = Math.max(0, Math.min(100, ((Number(v) || 0) / (max || 100)) * 100));
    return `<div class="meter"><i style="width:${w}%;background:${colour}"></i></div>`;
  };

  const stat = (k, v, colour) =>
    `<div class="stat"><div class="k">${esc(k)}</div>` +
    `<div class="v" style="color:${colour || "var(--text)"}">${v}</div></div>`;

  const card = (title, body, right, flush) =>
    `<section class="card">` +
    (title ? `<h2>${esc(title)}${right ? `<span>${right}</span>` : ""}</h2>` : "") +
    `<div class="body${flush ? " flush" : ""}">${body}</div></section>`;

  const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;

  const note = (t) => `<p class="note" style="margin:10px 0 0">${esc(t)}</p>`;

  /* ================================================================ state */
  const S = {
    snap: null,
    calls: null,
    diag: null,
    acc: null,
    chain: null,
    error: null,
    boot: null,
    selected: null,
    tab: "command",
    sub: { setups: "jackpot", radar: "scanners", scan: "breakout",
           movers: "gainers", journal: "running" },
    lastFetch: null,
  };

  /* ============================================================== fetch */
  async function api(path) {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((body && (body.detail || body.error)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  async function loadSnapshot() {
    try {
      S.snap = await api("/api/snapshot");
      S.error = null;
      S.boot = null;
    } catch (e) {
      if (e.status === 503 && e.body) {
        S.boot = e.body.boot || null;
        S.error = e.body.error || "warming up";
      } else {
        S.error = e.message;
      }
      S.snap = null;
    }
    S.lastFetch = new Date();
    renderTop();
    renderAlerts();
    render();
  }

  async function loadCalls() {
    try {
      S.calls = await api("/api/calls");
    } catch (e) {
      S.calls = { _error: e.message };
    }
    const n = S.calls && S.calls.today ? S.calls.today.length : 0;
    $("cnt-calls").textContent = n ? ` ${n}` : "";
    if (S.tab === "journal") render();
  }

  async function loadSystem() {
    const [d, a] = await Promise.all([
      api("/api/diagnostics").catch((e) => ({ _error: e.message })),
      api("/api/accuracy").catch((e) => ({ _error: e.message })),
    ]);
    S.diag = d;
    S.acc = a;
    if (S.tab === "system") render();
  }

  async function loadChain(sym, side) {
    S.chain = { loading: true, sym, side };
    render();
    try {
      S.chain = await api(`/api/chain/${encodeURIComponent(sym)}?side=${side}`);
    } catch (e) {
      S.chain = { _error: e.message, sym, side };
    }
    render();
  }

  /* ============================================================== topbar */
  function renderTop() {
    const s = S.snap;

    const now = new Date();
    $("clock").textContent = now.toLocaleTimeString("en-IN", {
      hour12: false, timeZone: "Asia/Kolkata",
    });

    const win = (s && s.window) || null;
    $("session").innerHTML = win
      ? tag(win.label || "—", win.tradable ? "var(--bull)" : "var(--dim)")
      : tag("CONNECTING", "var(--dim)");

    $("indices").innerHTML = ((s && s.indices) || [])
      .slice(0, 4)
      .map((i) =>
        `<span class="idx mono"><span class="k">${esc(i.sym)}</span> ` +
        `<b>${num(i.ltp, 2) ?? "—"}</b> ` +
        `<span class="${dirClass(i.chg)}">${pct(i.chg)}</span></span>`)
      .join("");

    const fc = (s && s.feed_counts) || null;
    $("feedstate").innerHTML = !s
      ? tag("NO SNAPSHOT", "var(--bear)")
      : s.stale
      ? tag("STALE FEED", "var(--bear)", true)
      : fc
      ? tag(`FEED ${fc.live}/${fc.live + fc.old + fc.nodata}`, "var(--bull)")
      : tag("LIVE", "var(--bull)");

    const t = (s && s.tiers) || {};
    const nSet = (t.JACKPOT || 0) + (t.STRONG || 0);
    $("cnt-setups").textContent = nSet ? ` ${nSet}` : "";
    const nRadar = ((s && s.breakout_radar) || []).length + ((s && s.surges) || []).length;
    $("cnt-radar").textContent = nRadar ? ` ${nRadar}` : "";
    const nNews = ((s && s.news) || []).filter((n) => n.actionable).length;
    $("cnt-news").textContent = nNews ? ` ${nNews}` : "";
  }

  /* ============================================================== alerts */
  function renderAlerts() {
    const s = S.snap;
    const out = [];

    if (!s && S.boot) {
      out.push(`<div class="banner warn"><b>WARMING UP</b>
        Backend is at stage "${esc(S.boot)}". The scanner needs one full pass before
        anything can be scored. This screen fills itself when it is done.</div>`);
    } else if (!s && S.error) {
      out.push(`<div class="banner bad"><b>NO SNAPSHOT</b>
        ${esc(S.error)}. Check the SYSTEM tab &mdash; broker session and instrument
        master are the two things that usually break first.</div>`);
    }

    if (s && s.stale) {
      out.push(`<div class="banner bad"><b>DATA IS NOT LIVE</b>
        The broker is returning the previous session's candles. VWAP, volume ratios and
        every score built on them would be wrong, so the scanners are deliberately empty.
        Nothing here should be traded.</div>`);
    }

    const risk = s && s.risk;
    if (risk && risk.locked) {
      out.push(`<div class="banner bad"><b>RISK LOCK ACTIVE</b>
        ${risk.sl_streak} stop${risk.sl_streak === 1 ? "" : "s"} in a row against a limit of
        ${risk.max_sl}. Day P&amp;L ${num(risk.day_pnl, 0) ?? "—"} against a
        ${num(risk.loss_limit, 0) ?? "—"} limit. No new calls are raised until the
        ${risk.cooldown_min} minute cooldown clears.</div>`);
    }

    if (s && s.health && s.health.scan_error) {
      out.push(`<div class="banner warn"><b>SCANNER ERROR</b>
        ${esc(s.health.scan_error)}</div>`);
    }

    if (S.calls && S.calls.storage_persistent === false) {
      out.push(`<div class="banner warn"><b>CALL HISTORY IS NOT SAVED</b>
        No persistent database is configured, so every restart wipes the record. Accuracy
        numbers built on it will be incomplete.</div>`);
    }

    $("alerts").innerHTML = out.join("");
  }

  /* ========================================================= stage rail */
  const CALL_STAGES = ["RAISED", "DETECTED", "CONFIRMED", "ENTRY", "T1", "T2", "T3"];

  function stageRail(call) {
    let at = 0;
    if (call.detected_at) at = 1;
    if (call.confirmed_at) at = 2;
    if (call.triggered || call.entry_at) at = 3;
    if (call.t1_at) at = 4;
    if (call.t2_at) at = 5;
    if (call.t3_at) at = 6;

    return `<div class="stagerail">` + CALL_STAGES.map((label, i) => {
      const cls = i === at ? "now" : i < at ? "done" : "";
      return `<div><div class="bar ${cls}"></div><div class="lbl ${cls}">${label}</div></div>`;
    }).join("") + `</div>`;
  }

  /* ========================================================= setup card */
  function setupCard(r, opts = {}) {
    if (!r) return "";
    const tier = r.tier_band || r.tier || "GOOD";
    const legs = r.legs || {};
    const on = S.selected === r.sym + r.side;
    const alertCls = r.alert ? ` alert-${r.alert}` : "";

    return `<button class="setup t-${esc(tier)}${on ? " on" : ""}${alertCls}"
        data-setup="${esc(r.sym)}" data-side="${esc(r.side)}">
      <div class="top">
        <div>
          <div class="sym">${esc(r.sym)}
            <span class="${sideClass(r.side)}">${esc(r.side || "")}</span></div>
          <div class="mono" style="font-size:10px;color:var(--dim);margin-top:3px">
            ${esc(r.sector || "—")} &middot; ${money(r.ltp)}
            ${has(r.vol_ratio) ? ` &middot; ${num(r.vol_ratio, 2)}x vol` : " &middot; volume not live"}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          ${tag(tier, tierColour(tier))}
          <div class="sc" style="color:${scoreColour(r.score)}">${has(r.score) ? r.score : "—"}</div>
        </div>
      </div>

      <div class="legs">
        <span><span class="k">SL</span> <span class="bear">${money(legs.sl)}</span></span>
        <span><span class="k">T1</span> <span class="bull">${money(legs.t1)}</span></span>
        <span><span class="k">T2</span> <span class="bull">${money(legs.t2)}</span></span>
        <span><span class="k">T3</span> <span class="bull">${money(legs.t3)}</span></span>
        ${has(legs.rr) ? `<span><span class="k">R:R</span> <span class="saf">${num(legs.rr, 2)}</span></span>` : ""}
      </div>

      ${lightsRow(r.lights)}
      ${opts.blocking && r.failed && r.failed.length
        ? `<div class="mono" style="font-size:10px;color:var(--bear);margin-top:8px">
             Blocked: ${esc(r.failed.join(", "))}</div>`
        : ""}
    </button>`;
  }

  function lightsRow(lights) {
    if (!lights || !lights.length) return "";
    return `<div class="lights">` + lights.map((l) =>
      `<span class="light ${esc(l.colour || "amber")}" title="${esc(l.note || "")}">${esc(l.label || l.key)}</span>`
    ).join("") + `</div>`;
  }

  /* ======================================================= setup dossier */
  function dossier(r) {
    if (!r) {
      return card("SETUP DOSSIER",
        empty("Pick a setup from the board to see its checks, levels and target ladder."));
    }

    const legs = r.legs || {};
    const conf = r.conf || {};
    const lv = r.levels || {};

    const checks = (r.checks || []).map((c) =>
      `<div class="check ${c.ok ? "ok" : "no"}">
         <span class="m">${c.ok ? "\u2713" : "\u2717"}</span>
         <span><b>${esc(c.k)}</b>${c.note ? " &mdash; " + esc(c.note) : ""}</span>
       </div>`).join("") || empty("No check detail on this row.");

    const levelRows = ["pdh", "pdl", "pwh", "pwl", "pmh", "pml"]
      .filter((k) => has(lv[k]))
      .map((k) => {
        const above = has(r.ltp) && r.ltp > lv[k];
        return row(k.toUpperCase(), money(lv[k]),
          above ? "var(--bull)" : "var(--bear)");
      }).join("");

    const fake = r.fake || {};

    return card(`DOSSIER \u00B7 ${r.sym} ${r.side}`, `
      <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:12px">
        <div class="mono" style="font-size:34px;font-weight:600;line-height:1;color:${scoreColour(r.score)}">
          ${has(r.score) ? r.score : "—"}</div>
        <div>
          <div class="mono" style="font-size:10px;color:var(--dim);letter-spacing:.12em">
            SCORE \u00B7 GRADE ${esc(r.grade || "—")}</div>
          <div class="mono" style="font-size:10.5px;color:var(--saffron)">
            ${esc(r.confidence || "")}${has(conf.count) ? ` \u00B7 ${conf.count}/${conf.total ?? "?"} confirmations` : ""}</div>
        </div>
      </div>

      ${has(conf.strength) ? meter(conf.strength, 100, "var(--saffron)") : ""}

      <div style="margin-top:14px">
        <div class="mono" style="font-size:10px;letter-spacing:.14em;color:var(--dim);margin-bottom:6px">
          MANDATORY CHECKS</div>
        ${checks}
      </div>

      ${r.failed && r.failed.length
        ? `<div class="banner bad" style="margin:12px 0 0"><b>NOT TRADEABLE</b>
             Failing ${esc(r.failed.join(", "))}. The engine will not raise a call on this
             row until that clears.</div>`
        : `<div class="banner good" style="margin:12px 0 0"><b>ALL MANDATORY CHECKS PASS</b>
             ${fake.ok === false
               ? "Break is not confirmed yet &mdash; wait for a close beyond the level."
               : "Break confirmed. The retest is the entry, not the spike."}</div>`}

      <div style="margin-top:14px">
        <div class="mono" style="font-size:10px;letter-spacing:.14em;color:var(--dim);margin-bottom:4px">
          TARGET LADDER</div>
        ${row("SPOT", money(r.ltp))}
        ${row("VWAP", money(r.vwap), has(r.vwap) && has(r.ltp) && r.ltp > r.vwap ? "var(--bull)" : "var(--bear)")}
        ${row("ATR", num(r.atr, 2) ?? "—")}
        ${row("STOP", money(legs.sl), "var(--bear)")}
        ${row("TARGET 1", money(legs.t1), "var(--bull)")}
        ${row("TARGET 2", money(legs.t2), "var(--bull)")}
        ${row("TARGET 3", money(legs.t3), "var(--bull)")}
        ${row("R:R AT T2", has(legs.rr) ? num(legs.rr, 2) : "—", "var(--saffron)")}
        ${legs.capped
          ? note("Targets are capped: this is not the prime window, so the engine is not paying for a full-day move.")
          : ""}
      </div>

      ${levelRows ? `<div style="margin-top:14px">
        <div class="mono" style="font-size:10px;letter-spacing:.14em;color:var(--dim);margin-bottom:4px">
          LEVELS \u00B7 green means price is above</div>${levelRows}</div>` : ""}

      ${r.stack ? `<div style="margin-top:12px">${row("EMA STACK", esc(r.stack.label || "—"))}
        ${row("EMA 20 / 50 / 200", `${num(r.ema20, 1) ?? "—"} / ${num(r.ema50, 1) ?? "—"} / ${num(r.ema200, 1) ?? "—"}`)}</div>` : ""}

      ${lightsRow(r.lights)}

      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="st mono" data-chain="${esc(r.sym)}" data-chainside="CE">LOAD CE CHAIN</button>
        <button class="st mono" data-chain="${esc(r.sym)}" data-chainside="PE">LOAD PE CHAIN</button>
      </div>
    `);
  }

  function findSetup(key) {
    const s = S.snap;
    if (!s || !key) return null;
    const pools = [s.jackpot_ce, s.jackpot_pe, s.ce_box, s.pe_box, s.focus,
                   s.lead_stocks, [s.top_ce], [s.top_pe]];
    for (const pool of pools) {
      const hit = (pool || []).find((r) => r && r.sym + r.side === key);
      if (hit) return hit;
    }
    return null;
  }

  /* ============================================================ COMMAND */
  function renderCommand() {
    const s = S.snap;
    if (!s) return empty("Waiting for the first snapshot.");

    const cmd = s.commander || {};
    const read = s.read || {};
    const press = s.pressure || {};
    const dec = s.decision || {};
    const bp = s.breadth_panel || {};
    const attr = s.attribution || {};

    const buyers = has(press.buyers) ? press.buyers : 50;

    const pressureBar = `
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px">
        <div>
          <div class="mono" style="font-size:10px;letter-spacing:.18em;color:var(--dim)">
            PRESSURE \u00B7 ${esc(press.control || "UNKNOWN")}</div>
          <div class="commander head" style="margin-top:3px;color:${toneColour(cmd.tone)}">
            ${esc(cmd.headline || "NO READ YET")}</div>
        </div>
        <div style="text-align:right">
          <div class="mono bull" style="font-size:22px;font-weight:600">${buyers}</div>
          <div class="mono" style="font-size:9.5px;color:var(--dim);letter-spacing:.1em">BUY / SELL</div>
          <div class="mono bear" style="font-size:22px;font-weight:600">${100 - buyers}</div>
        </div>
      </div>

      <div class="pressure">
        <div class="buy" style="width:${buyers}%"></div>
        <div class="sell" style="width:${100 - buyers}%"></div>
        <div class="mark seam" style="left:${buyers}%"></div>
        <span class="lb l mono">BUYERS</span>
        <span class="lb r mono">SELLERS</span>
      </div>

      ${cmd.order ? `<p class="commander order">${esc(cmd.order)}</p>` : ""}

      <div class="cols4" style="margin-top:12px">
        ${stat("MOOD", esc(read.mood || "—"),
          read.mood === "GREEDY" || read.mood === "CONFIDENT" ? "var(--bull)"
            : read.mood === "FEARFUL" ? "var(--bear)" : "var(--saffron)")}
        ${stat("FEAR", has(s.fear) ? s.fear : "—", "var(--saffron)")}
        ${stat("BREADTH", has(s.breadth) ? s.breadth + "%" : "—",
          has(s.breadth) && s.breadth >= 50 ? "var(--bull)" : "var(--bear)")}
        ${stat("CONVICTION", has(cmd.conviction) ? cmd.conviction : "—",
          scoreColour(cmd.conviction))}
      </div>`;

    const decisionCard = card("SIDE DECISION", `
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div class="mono" style="font-size:30px;font-weight:600;color:${
          dec.side === "CE" ? "var(--bull)" : dec.side === "PE" ? "var(--bear)" : "var(--dim)"}">
          ${esc(dec.side || "WAIT")}</div>
        <div style="flex:1;min-width:180px">
          ${row("CE SCORE", has(dec.ce) ? dec.ce : "—", "var(--bull)")}
          ${row("PE SCORE", has(dec.pe) ? dec.pe : "—", "var(--bear)")}
          ${row("EDGE", has(dec.edge) ? dec.edge + " pts" : "—", "var(--saffron)")}
        </div>
      </div>
      ${dec.reason ? note(dec.reason) : ""}
      ${read.simple ? `<p style="font-size:13.5px;line-height:1.6;margin:12px 0 0">${esc(read.simple)}</p>` : ""}
    `);

    const topSetups = (s.top_setups || []).length
      ? card("TOP SETUPS", (s.top_setups || []).map((t) => `
          <div style="padding:10px 0;border-bottom:1px solid var(--soft)">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <div>
                <span style="font-size:14px;font-weight:600">${esc(t.sym)}</span>
                <span class="${sideClass(t.side)}" style="font-size:14px;font-weight:600">${esc(t.side)}</span>
                <span class="mono" style="font-size:10px;color:var(--dim);margin-left:6px">${money(t.ltp)}</span>
              </div>
              <div style="text-align:right">
                ${tag(t.status || "—", t.status === "ENTRY READY" ? "var(--bull)" : "var(--saffron)")}
                <span class="mono" style="font-size:14px;margin-left:8px;color:${scoreColour(t.score)}">${t.score}</span>
              </div>
            </div>
            ${t.blocking ? `<div class="mono" style="font-size:10px;color:var(--bear);margin-top:5px">${esc(t.blocking)}</div>` : ""}
            ${lightsRow(t.lights)}
          </div>`).join(""))
      : card("TOP SETUPS", empty(
          s.stale ? "Feed is not live, so nothing is scored."
                  : "Nothing clears the filters right now. Waiting is the position."));

    const sectorRows = (s.sector_rows || []).length
      ? card("SECTOR ROTATION", (s.sector_rows || []).slice(0, 9).map((r) => `
          <div style="margin-bottom:9px">
            <div style="display:flex;justify-content:space-between;margin-bottom:3px">
              <span class="mono" style="font-size:10.5px">${esc(r.name)}
                <span style="color:var(--faint)">${esc(r.label || "")}</span></span>
              <span class="mono ${dirClass(r.chg)}" style="font-size:10.5px">${pct(r.chg)}</span>
            </div>
            ${meter(Math.abs(r.chg || 0) * 25, 100, Number(r.chg) >= 0 ? "var(--bull)" : "var(--bear)")}
            <div class="mono" style="font-size:9px;color:var(--dim);margin-top:3px">
              ${r.members} names &middot; ${r.participation}% agree &middot; ${r.vwap_participation}% above VWAP
              &middot; RS ${pct(r.rs)}</div>
          </div>`).join("") +
          (attr.buying_from || attr.selling_from
            ? `<div class="mono" style="font-size:10px;color:var(--dim);margin-top:10px;line-height:1.6">
                 Buying from <span class="bull">${esc((attr.buying_from || []).join(", ") || "nowhere clear")}</span><br>
                 Selling from <span class="bear">${esc((attr.selling_from || []).join(", ") || "nowhere clear")}</span></div>`
            : ""))
      : card("SECTOR ROTATION", empty("No sector data in this snapshot."));

    const breadthCard = card("MARKET BREADTH", `
      <div class="cols4" style="margin-bottom:12px">
        ${stat("ADVANCES", has(bp.advances) ? bp.advances : "—", "var(--bull)")}
        ${stat("DECLINES", has(bp.declines) ? bp.declines : "—", "var(--bear)")}
        ${stat("A/D RATIO", has(bp.ratio) ? bp.ratio : "—", "var(--saffron)")}
        ${stat("UNIVERSE", has(bp.universe) ? bp.universe : "—")}
      </div>
      ${row("ABOVE VWAP", has(bp.above_vwap_pct) ? bp.above_vwap_pct + "%" : "—",
        has(bp.above_vwap_pct) && bp.above_vwap_pct >= 50 ? "var(--bull)" : "var(--bear)")}
      ${row("ABOVE EMA 20", has(bp.above_ema_pct) ? bp.above_ema_pct + "%" : "—",
        has(bp.above_ema_pct) && bp.above_ema_pct >= 50 ? "var(--bull)" : "var(--bear)")}
      ${row("STRONG SECTORS", esc((bp.strong_sectors || []).join(", ") || "none"), "var(--bull)")}
      ${row("WEAK SECTORS", esc((bp.weak_sectors || []).join(", ") || "none"), "var(--bear)")}
      ${has(read.vix) ? row("VIX", num(read.vix, 2)) : ""}
    `);

    const funnelCard = (s.funnel || []).length
      ? card("SCAN FUNNEL", `<div class="cols4">` + (s.funnel || []).map((f) =>
          stat(f.stage.toUpperCase(), f.n, f.n ? "var(--saffron)" : "var(--dim)")).join("") +
          `</div>` + note(
            `${s.scanned ?? "?"} names scanned` +
            (has(s.scan_ms) ? ` in ${s.scan_ms} ms` : "") +
            `. Tiers: ` + Object.entries(s.tiers || {})
              .map(([k, v]) => `${k} ${v}`).join(" \u00B7 ")))
      : "";

    return card("", pressureBar) +
      `<div class="cols">
        <div>${decisionCard}${topSetups}${funnelCard}</div>
        <div>${sectorRows}${breadthCard}</div>
      </div>`;
  }

  /* ============================================================= SETUPS */
  function renderSetups() {
    const s = S.snap;
    if (!s) return empty("Waiting for the first snapshot.");

    const sub = S.sub.setups;
    const tabs = [
      ["jackpot", "JACKPOT"],
      ["ce", "CE BOX"],
      ["pe", "PE BOX"],
      ["near", "NEAR TRIGGER"],
      ["lead", "LEAD SECTOR"],
    ];

    let rows = [];
    let blank = "";
    if (sub === "jackpot") {
      rows = [...(s.jackpot_ce || []), ...(s.jackpot_pe || [])];
      blank = "No setup is clearing the jackpot bar. That is a normal reading, not a fault.";
    } else if (sub === "ce") {
      rows = s.ce_box || [];
      blank = "No CE candidate ranked this pass.";
    } else if (sub === "pe") {
      rows = s.pe_box || [];
      blank = "No PE candidate ranked this pass.";
    } else if (sub === "lead") {
      rows = s.lead_stocks || [];
      blank = "No lead-sector names ranked yet.";
    }

    let listHtml;
    if (sub === "near") {
      const near = s.near_trigger || [];
      listHtml = near.length
        ? `<div class="list">` + near.map((n) => `
            <div>
              <div>
                <div class="nm">${esc(n.sym)}
                  <span class="${sideClass(n.side)}">${esc(n.side)}</span>
                  <span class="mono" style="font-size:10px;color:var(--dim)"> ${esc(n.sector || "")}</span></div>
                <div class="sub">${n.level_name ? esc(n.level_name) + " " + money(n.level) : "no level in range"}
                  ${has(n.distance) ? ` &middot; ${num(n.distance, 2)}% away` : ""}</div>
                ${n.blocking ? `<div class="sub" style="color:var(--bear)">${esc(n.blocking)}</div>` : ""}
              </div>
              <div class="rt">
                <div style="color:${scoreColour(n.score)}">${n.score}</div>
                <div style="color:${tierColour(n.tier)};font-size:9px">${esc(n.tier || "")}</div>
              </div>
            </div>`).join("") + `</div>`
        : empty("Nothing sitting just under a level right now.");
    } else {
      listHtml = rows.length
        ? `<div style="padding:10px">` +
            rows.map((r) => setupCard(r, { blocking: true })).join("") + `</div>`
        : empty(s.stale ? "Feed is not live, so no rows are scored." : blank);
    }

    const board = card("BOARD",
      `<div class="subtabs">` + tabs.map(([k, label]) =>
        `<button class="st" data-sub="setups" data-val="${k}" aria-selected="${sub === k}">${label}</button>`
      ).join("") + `</div>` + listHtml, "", true);

    return `<div class="cols"><div>${board}</div><div>${dossier(findSetup(S.selected))}</div></div>`;
  }

  /* =============================================================== FLOW */
  function renderFlow() {
    const s = S.snap;
    if (!s) return empty("Waiting for the first snapshot.");

    const cards = (s.index_cards || []).map((c) => {
      const o = c.option || {};
      const legs = c.legs || {};
      return card(`${c.sym} \u00B7 ${c.side}`, `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
          <div class="mono" style="font-size:24px;font-weight:600;color:${scoreColour(c.score)}">${c.score}</div>
          <div style="text-align:right">
            ${tag(c.grade || "—", scoreColour(c.score))}
            ${c.qualified ? tag("QUALIFIED", "var(--bull)") : tag("NOT QUALIFIED", "var(--dim)")}
          </div>
        </div>

        ${row("SPOT", money((c.idx || {}).ltp), dirClass((c.idx || {}).chg))}
        ${row("CHANGE", pct((c.idx || {}).chg), dirClass((c.idx || {}).chg))}
        ${row("STRIKE", has(o.strike) ? `${o.strike} ${c.side}` : "chain not quoting")}
        ${row("PREMIUM", money(o.prem), "var(--saffron)")}
        ${o.zone ? row("ENTRY ZONE", `${money(o.zone.low)} \u2013 ${money(o.zone.high)}`) : ""}
        ${row("SPREAD", has(o.spread) ? money(o.spread) : "—",
          o.liquid ? "var(--bull)" : "var(--bear)")}
        ${row("LIQUID", o.liquid ? "YES" : "NO", o.liquid ? "var(--bull)" : "var(--bear)")}
        ${row("OI / VOLUME", `${has(o.oi) ? o.oi : "—"} / ${has(o.vol) ? o.vol : "—"}`)}
        ${row("PCR", has(c.pcr) ? c.pcr : "—", "var(--saffron)")}
        ${c.pcr_read ? note(c.pcr_read) : ""}

        <div style="margin-top:12px">
          ${row("SL", money(legs.sl), "var(--bear)")}
          ${row("T1 / T2 / T3", `${money(legs.t1)} \u00B7 ${money(legs.t2)} \u00B7 ${money(legs.t3)}`, "var(--bull)")}
        </div>

        ${(c.checks || []).length ? `<div style="margin-top:12px">` +
          (c.checks || []).map((k) =>
            `<div class="check ${k.ok ? "ok" : "no"}"><span class="m">${k.ok ? "\u2713" : "\u2717"}</span>
             <span>${esc(k.k)}${k.note ? " &mdash; " + esc(k.note) : ""}</span></div>`).join("") +
          `</div>` : ""}

        ${o.quoted_at ? note(`Premium quoted at ${o.quoted_at}. If that time is old, the price is old.`) : ""}
      `);
    }).join("");

    const radar = (s.index_radar || []).length
      ? card("INDEX RADAR", `<div class="list">` + (s.index_radar || []).map((r) => `
          <div>
            <div><div class="nm">${esc(r.sym || r.name || "—")}</div>
              <div class="sub">${esc(r.note || r.level_name || "")}</div></div>
            <div class="rt ${dirClass(r.chg)}">${has(r.chg) ? pct(r.chg) : ""}
              ${has(r.score) ? `<div style="color:${scoreColour(r.score)}">${r.score}</div>` : ""}</div>
          </div>`).join("") + `</div>`, "", true)
      : "";

    const ch = S.chain;
    let chainCard;
    if (!ch) {
      chainCard = card("OPTION CHAIN",
        empty("Open a setup in the SETUPS tab and load its chain, or use the buttons below."),
        "", false);
    } else if (ch.loading) {
      chainCard = card(`OPTION CHAIN \u00B7 ${ch.sym}`, empty("Quoting strikes\u2026"));
    } else if (ch._error) {
      chainCard = card(`OPTION CHAIN \u00B7 ${ch.sym}`,
        `<div class="banner bad"><b>CHAIN UNAVAILABLE</b>${esc(ch._error)}</div>`);
    } else {
      const rows = ch.rows || [];
      const maxOI = Math.max(1, ...rows.map((r) => Number(r.oi) || 0));
      const best = ch.best || {};
      chainCard = card(`OPTION CHAIN \u00B7 ${ch.symbol} ${ch.side}`, `
        ${row("SPOT", money(ch.spot))}
        ${best.strike ? row("ENGINE PICK", `${best.strike} ${ch.side} @ ${money(best.prem)}`, "var(--saffron)") : ""}
        ${has(best.delta) ? row("DELTA", num(best.delta, 3)) : ""}
        ${has(best.spread) ? row("SPREAD", money(best.spread),
          best.spread / (best.prem || 1) < 0.05 ? "var(--bull)" : "var(--bear)") : ""}
        <div style="margin-top:12px">
          ${rows.length ? rows.map((r) => `
            <div class="chain${best.strike === r.strike ? " tagged" : ""}">
              <div class="l">
                <span class="mono" style="font-size:10px;color:var(--dim)">${has(r.oi) ? r.oi : "—"}</span>
                <div class="oi ${ch.side === "CE" ? "ce" : "pe"}"
                     style="width:${((Number(r.oi) || 0) / maxOI) * 100}%"></div>
              </div>
              <div class="k"><b>${r.strike}</b>${best.strike === r.strike ? "<i>PICK</i>" : ""}</div>
              <div class="r">
                <span class="mono" style="font-size:11px">${money(r.prem)}</span>
                ${has(r.spread) ? `<span class="mono" style="font-size:9px;color:var(--dim)">sp ${num(r.spread, 2)}</span>` : ""}
              </div>
            </div>`).join("") : empty("No strikes quoted.")}
        </div>
      `);
    }

    const pickers = card("LOAD A CHAIN", `
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY"].map((sym) => `
          <button class="st mono" data-chain="${sym}" data-chainside="CE">${sym} CE</button>
          <button class="st mono" data-chain="${sym}" data-chainside="PE">${sym} PE</button>`).join("")}
      </div>
      ${note("A chain call quotes live strikes from the broker, so it costs a round trip. It is not polled automatically.")}
    `);

    return (cards ? `<div class="cols2">${cards}</div>` : card("INDEX CARDS",
      empty("No index cards in this snapshot. The chain may not be quoting."))) +
      `<div class="cols">${chainCard}<div>${pickers}${radar}</div></div>`;
  }

  /* ============================================================== RADAR */
  function renderRadar() {
    const s = S.snap;
    if (!s) return empty("Waiting for the first snapshot.");

    const sub = S.sub.radar;
    const head = card("", `<div class="subtabs" style="border:none;padding:0">
      ${[["scanners", "SCANNERS"], ["movers", "MOVERS"], ["breakout", "BREAKOUT / SURGE"]]
        .map(([k, l]) => `<button class="st" data-sub="radar" data-val="${k}" aria-selected="${sub === k}">${l}</button>`)
        .join("")}</div>`);

    if (sub === "scanners") {
      const buckets = s.scanners || {};
      const keys = [
        ["breakout", "BREAKOUT \u00B7 above PDH"],
        ["breakdown", "BREAKDOWN \u00B7 below PDL"],
        ["vwap_up", "ABOVE VWAP"],
        ["vwap_down", "BELOW VWAP"],
        ["orb_up", "ORB UP"],
        ["orb_down", "ORB DOWN"],
      ];
      const active = S.sub.scan;
      const rows = buckets[active] || [];

      return head + card("SCANNER BUCKETS",
        `<div class="subtabs">` + keys.map(([k, l]) =>
          `<button class="st" data-sub="scan" data-val="${k}" aria-selected="${active === k}">
             ${l}<span style="color:var(--saffron)"> ${(buckets[k] || []).length}</span></button>`).join("") +
        `</div>` +
        (rows.length
          ? `<div class="list">` + rows.map((r) => `
              <div class="${r.alert ? "alert-" + r.alert : ""}">
                <div>
                  <div class="nm">${esc(r.sym)}
                    <span class="${sideClass(r.side)}">${esc(r.side || "")}</span></div>
                  <div class="sub">${esc(r.sector || "")} &middot; ${money(r.ltp)}
                    ${has(r.vol_ratio) ? ` &middot; ${num(r.vol_ratio, 2)}x` : ""}</div>
                  ${r.option ? `<div class="sub saf">${esc(r.option.symbol || "")} @ ${money(r.option.prem)}</div>` : ""}
                </div>
                <div class="rt">
                  ${has(r.count) ? `<div class="saf">${r.count} hits</div>` : ""}
                  ${has(r.score) ? `<div style="color:${scoreColour(r.score)}">${r.score}</div>` : ""}
                </div>
              </div>`).join("") + `</div>`
          : empty(s.stale ? "Feed is not live, so the buckets are held empty on purpose."
                          : "Nothing in this bucket right now.")),
        "", true);
    }

    if (sub === "movers") {
      const mv = s.movers || {};
      const keys = [
        ["gainers", "GAINERS"], ["losers", "LOSERS"],
        ["volume_shockers", "VOLUME"], ["price_shockers", "PRICE"],
        ["active_by_value", "MOST ACTIVE"],
        ["above_vwap", "ABOVE VWAP"], ["below_vwap", "BELOW VWAP"],
      ];
      const active = S.sub.movers;
      const rows = mv[active] || [];

      return head + card("MOVERS",
        `<div class="subtabs">` + keys.map(([k, l]) =>
          `<button class="st" data-sub="movers" data-val="${k}" aria-selected="${active === k}">${l}</button>`).join("") +
        `</div>` +
        (rows.length
          ? `<div class="list">` + rows.map((r) => `
              <div>
                <div>
                  <div class="nm">${esc(r.sym)}
                    <span class="${sideClass(r.side)}">${esc(r.side || "")}</span></div>
                  <div class="sub">${esc(r.sector || "")} &middot; ${money(r.ltp)}
                    ${r.stack ? " &middot; " + esc(r.stack) : ""}</div>
                  ${r.option ? `<div class="sub saf">${esc(r.option.symbol || "")} @ ${money(r.option.prem)}</div>` : ""}
                </div>
                <div class="rt">
                  <div class="${dirClass(r.chg)}">${pct(r.chg)}</div>
                  ${has(r.vol_ratio) ? `<div class="muted" style="font-size:9.5px">${num(r.vol_ratio, 2)}x</div>` : ""}
                </div>
              </div>`).join("") + `</div>`
          : empty("No rows in this list.")),
        "", true);
    }

    const radar = s.breakout_radar || [];
    const surges = s.surges || [];
    return head + `<div class="cols2">
      ${card("BREAKOUT RADAR", radar.length
        ? `<div class="list">` + radar.map((r) => `
            <div>
              <div><div class="nm">${esc(r.sym)}
                <span class="${sideClass(r.side)}">${esc(r.side || "")}</span></div>
                <div class="sub">${esc(r.level_name || r.note || "")} ${has(r.level) ? money(r.level) : ""}</div></div>
              <div class="rt">${has(r.distance) ? `<div class="saf">${num(r.distance, 2)}%</div>` : ""}
                ${has(r.score) ? `<div style="color:${scoreColour(r.score)}">${r.score}</div>` : ""}</div>
            </div>`).join("") + `</div>`
        : empty("Nothing pressing a level."), "", true)}
      ${card("VOLUME SURGES", surges.length
        ? `<div class="list">` + surges.map((r) => `
            <div>
              <div><div class="nm">${esc(r.sym)}</div>
                <div class="sub">${esc(r.sector || "")} &middot; ${money(r.ltp)}</div></div>
              <div class="rt">${has(r.vol_ratio) ? `<div class="saf">${num(r.vol_ratio, 2)}x</div>` : ""}
                <div class="${dirClass(r.chg)}">${pct(r.chg)}</div></div>
            </div>`).join("") + `</div>`
        : empty("No volume surge on the tape."), "", true)}
    </div>`;
  }

  /* =============================================================== NEWS */
  function renderNews() {
    const s = S.snap;
    if (!s) return empty("Waiting for the first snapshot.");

    const news = s.news || [];
    const bias = s.news_bias || {};

    const impactColour = (i) =>
      i === "HIGH" ? "var(--bear)" : i === "MEDIUM" ? "var(--saffron)" : "var(--dim)";
    const tagColour = (t) =>
      t === "POS" ? "var(--bull)" : t === "NEG" ? "var(--bear)"
        : t === "HIGH" ? "var(--saffron)" : "var(--dim)";

    const list = news.length
      ? news.map((n) => `
          <div style="padding:12px 14px;border-bottom:1px solid var(--soft);
               ${n.impact === "HIGH" ? "background:rgba(255,77,94,.05)" : ""}">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <span class="mono" style="font-size:10px;color:var(--dim)">${esc(n.time || "")}</span>
              ${tag(n.tag || "NEU", tagColour(n.tag))}
              ${tag(n.impact || "LOW", impactColour(n.impact))}
              ${n.actionable ? tag("ACTIONABLE", "var(--saffron)", true) : ""}
              ${(n.symbols || []).map((sy) => tag(sy, "var(--blue)")).join("")}
            </div>
            <div style="font-size:13px;line-height:1.5">
              ${n.link ? `<a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.head)}</a>`
                       : esc(n.head)}
            </div>
          </div>`).join("")
      : empty("No headlines pulled this cycle. Check the news feed on the SYSTEM tab.");

    const biasCard = card("NEWS BIAS", `
      <div class="cols2">
        <div>
          <div class="mono bull" style="font-size:10px;letter-spacing:.12em;margin-bottom:6px">POSITIVE</div>
          ${(bias.positive || []).length
            ? (bias.positive || []).map((b) => `<div class="mono" style="font-size:11px;padding:3px 0">${esc(b.head || b)}</div>`).join("")
            : `<div class="note">nothing positive flagged</div>`}
        </div>
        <div>
          <div class="mono bear" style="font-size:10px;letter-spacing:.12em;margin-bottom:6px">NEGATIVE</div>
          ${(bias.negative || []).length
            ? (bias.negative || []).map((b) => `<div class="mono" style="font-size:11px;padding:3px 0">${esc(b.head || b)}</div>`).join("")
            : `<div class="note">nothing negative flagged</div>`}
        </div>
      </div>
      ${note("A headline is never a trade on its own. The scanner only marks a story actionable when it names a stock in the universe and carries a direction \u2014 price still has to confirm.")}
    `);

    return `<div class="cols">
      ${card(`HEADLINES \u00B7 ${news.length}`, list, "", true)}
      <div>${biasCard}</div>
    </div>`;
  }

  /* ============================================================ JOURNAL */
  function renderJournal() {
    const c = S.calls;
    if (!c) return empty("Loading call history\u2026");
    if (c._error) {
      return card("CALLS", `<div class="banner bad"><b>COULD NOT LOAD CALLS</b>${esc(c._error)}</div>`);
    }

    const sum = c.summary || {};
    const risk = c.risk || {};
    const sub = S.sub.journal;
    const buckets = {
      running: c.running || [],
      completed: c.completed || [],
      missed: c.missed || [],
      today: c.today || [],
    };
    const rows = buckets[sub] || [];

    const callRow = (call) => {
      const badge = call.badge || {};
      const advice = call.advice || {};
      const move = has(call.ltp) && has(call.entry) && call.entry
        ? ((call.ltp - call.entry) / call.entry) * 100 : null;

      return `<div class="setup t-${esc(call.tier || "GOOD")}${badge.blink ? " alert-JACKPOT" : ""}"
                   style="cursor:default">
        <div class="top">
          <div>
            <div class="sym">${esc(call.symbol || call.underlying || "—")}
              <span class="${sideClass(call.side)}">${esc(call.side || "")}</span></div>
            <div class="mono" style="font-size:10px;color:var(--dim);margin-top:3px">
              ${esc(call.tier || "")}${has(call.score) ? ` \u00B7 score ${call.score}` : ""}
              ${call.confidence ? ` \u00B7 ${esc(call.confidence)}` : ""}</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            ${tag(badge.label || call.status || "—", toneColour(badge.tone))}
            <div class="sc" style="color:${has(move) ? (move >= 0 ? "var(--bull)" : "var(--bear)") : "var(--dim)"}">
              ${has(call.ltp) ? money(call.ltp) : "—"}</div>
            ${has(move) ? `<div class="mono" style="font-size:10px;color:${move >= 0 ? "var(--bull)" : "var(--bear)"}">${pct(move, 1)}</div>` : ""}
          </div>
        </div>

        <div class="legs">
          <span><span class="k">ENTRY</span> ${money(call.entry)}</span>
          <span><span class="k">SL</span> <span class="bear">${money(call.sl)}</span></span>
          <span><span class="k">T1</span> <span class="${call.t1_at ? "bull" : "muted"}">${money(call.t1)}</span></span>
          <span><span class="k">T2</span> <span class="${call.t2_at ? "bull" : "muted"}">${money(call.t2)}</span></span>
          <span><span class="k">T3</span> <span class="${call.t3_at ? "bull" : "muted"}">${money(call.t3)}</span></span>
        </div>

        ${stageRail(call)}

        ${advice.verdict ? `<div class="mono" style="font-size:10.5px;margin-top:10px;
             color:${toneColour(advice.tone)}">
             <b>${esc(advice.verdict)}</b>${advice.note ? " \u2014 " + esc(advice.note) : ""}</div>` : ""}

        ${(call.timeline || []).some((t) => t.t)
          ? `<div class="mono" style="font-size:9.5px;color:var(--dim);margin-top:8px;
               display:flex;gap:12px;flex-wrap:wrap">
               ${(call.timeline || []).filter((t) => t.t)
                 .map((t) => `<span>${esc(t.k)} <span style="color:var(--text)">${esc(t.t)}</span></span>`).join("")}
             </div>` : ""}

        ${call.why ? `<div class="mono" style="font-size:10px;color:var(--dim);margin-top:6px">${esc(call.why)}</div>` : ""}
      </div>`;
    };

    const summaryCard = card("TODAY", `
      <div class="cols4" style="margin-bottom:12px">
        ${stat("RAISED", (c.today || []).length)}
        ${stat("TRIGGERED", sum.triggered ?? 0, "var(--saffron)")}
        ${stat("T1 HIT", sum.t1 ?? 0, "var(--bull)")}
        ${stat("STOPPED", sum.sl ?? 0, "var(--bear)")}
      </div>
      ${row("T2 / T3 HIT", `${sum.t2 ?? 0} / ${sum.t3 ?? 0}`, "var(--bull)")}
      ${row("NEVER FILLED", c.waiting ?? 0, "var(--dim)")}
      ${row("NET MOVE", pct(c.net_pct), dirClass(c.net_pct))}
      ${note("Net move sums the premium move on filled calls only. Calls that never filled are not counted either way.")}
    `);

    const riskCard = card("RISK GUARDIAN", `
      ${row("STATUS", risk.locked ? "LOCKED" : "ACTIVE", risk.locked ? "var(--bear)" : "var(--bull)")}
      ${row("CONSECUTIVE STOPS", `${risk.sl_streak ?? 0} / ${risk.max_sl ?? "—"}`,
        (risk.sl_streak ?? 0) >= (risk.max_sl ?? 99) ? "var(--bear)" : "var(--saffron)")}
      ${row("DAY P&L", has(risk.day_pnl) ? num(risk.day_pnl, 0) : "—", dirClass(risk.day_pnl))}
      ${row("LOSS LIMIT", has(risk.loss_limit) ? num(risk.loss_limit, 0) : "—")}
      ${row("COOLDOWN", has(risk.cooldown_min) ? risk.cooldown_min + " min" : "—")}
      ${row("OPEN CALLS", risk.open_count ?? (c.open || []).length)}
      ${has(risk.day_pnl) && has(risk.loss_limit) && risk.loss_limit
        ? meter(Math.abs(risk.day_pnl), Math.abs(risk.loss_limit),
            risk.day_pnl < 0 ? "var(--bear)" : "var(--bull)")
        : ""}
      ${note("The lock is not a suggestion. While it is on, the engine raises nothing and the only job left is managing what is already open.")}
    `);

    const funnelCard = (c.funnel || []).length
      ? card("FUNNEL", `<div class="cols4">` + (c.funnel || []).map((f) =>
          stat(f.stage.toUpperCase(), f.n, f.n ? "var(--saffron)" : "var(--dim)")).join("") + `</div>`)
      : "";

    const listCard = card("CALLS",
      `<div class="subtabs">` +
      [["running", "RUNNING"], ["completed", "COMPLETED"], ["missed", "NEVER FILLED"], ["today", "ALL TODAY"]]
        .map(([k, l]) => `<button class="st" data-sub="journal" data-val="${k}"
             aria-selected="${sub === k}">${l}<span style="color:var(--saffron)"> ${(buckets[k] || []).length}</span></button>`)
        .join("") + `</div>` +
      (rows.length
        ? `<div style="padding:10px">` + rows.map(callRow).join("") + `</div>`
        : empty(sub === "missed"
            ? "Every call raised today filled."
            : "Nothing in this bucket yet.")),
      "", true);

    return `<div class="cols"><div>${listCard}</div><div>${summaryCard}${riskCard}${funnelCard}</div></div>`;
  }

  /* ============================================================= SYSTEM */
  function renderSystem() {
    const d = S.diag;
    const a = S.acc;
    if (!d && !a) return empty("Loading system state\u2026");

    let subsystems = "";
    if (d && d._error) {
      subsystems = `<div class="banner bad"><b>DIAGNOSTICS UNAVAILABLE</b>${esc(d._error)}</div>`;
    } else if (d) {
      subsystems = (d.subsystems || []).map((sub) => `
        <div class="row">
          <span class="k">${esc(sub.name)}</span>
          <span class="v" style="color:${sub.ok ? "var(--bull)" : "var(--bear)"}">
            ${sub.ok ? "OK" : "FAIL"}
            <span style="color:var(--dim);font-size:10px"> ${esc(sub.detail || "")}</span></span>
        </div>`).join("");

      const lr = d.last_run || {};
      subsystems += `<div style="margin-top:14px">
        <div class="mono" style="font-size:10px;letter-spacing:.14em;color:var(--dim);margin-bottom:4px">LAST SCAN</div>
        ${row("SCANNED", `${lr.scanned ?? "—"} of ${lr.universe ?? "—"}`)}
        ${row("FRESH QUOTES", lr.fresh ?? "—", (lr.fresh || 0) > 0 ? "var(--bull)" : "var(--bear)")}
        ${row("DURATION", has(lr.ms) ? lr.ms + " ms" : "—")}
        ${lr.error ? row("ERROR", esc(lr.error), "var(--bear)") : ""}
      </div>`;
    }

    let accuracy = "";
    if (a && a._error) {
      accuracy = `<div class="banner bad"><b>ACCURACY UNAVAILABLE</b>${esc(a._error)}</div>`;
    } else if (a) {
      const o = a.overall || {};
      const e = a.expectancy || {};
      accuracy = `
        <div class="cols4" style="margin-bottom:12px">
          ${stat("SAMPLE", o.n ?? 0)}
          ${stat("T1 RATE", has(o.t1_pct) ? o.t1_pct + "%" : "—", "var(--bull)")}
          ${stat("T2 RATE", has(o.t2_pct) ? o.t2_pct + "%" : "—", "var(--bull)")}
          ${stat("SL RATE", has(o.sl_pct) ? o.sl_pct + "%" : "—", "var(--bear)")}
        </div>
        ${has(e.expectancy) ? row("EXPECTANCY", num(e.expectancy, 2), dirClass(e.expectancy)) : ""}
        ${has(e.avg_win) ? row("AVERAGE WIN", pct(e.avg_win), "var(--bull)") : ""}
        ${has(e.avg_loss) ? row("AVERAGE LOSS", pct(e.avg_loss), "var(--bear)") : ""}
        ${(a.segments || []).length ? `<div style="margin-top:14px">
          <div class="mono" style="font-size:10px;letter-spacing:.14em;color:var(--dim);margin-bottom:4px">BY SEGMENT</div>
          ${(a.segments || []).map((sg) =>
            row(esc(sg.name || sg.key || "—"),
              `${sg.n ?? 0} calls \u00B7 ${has(sg.t1_pct) ? sg.t1_pct + "%" : "—"}`)).join("")}
        </div>` : ""}
        ${a.note ? note(a.note) : ""}`;
    }

    const meta = S.snap ? card("SNAPSHOT", `
      ${row("UPDATED", esc(S.snap.updated || "—"))}
      ${row("WINDOW", esc((S.snap.window || {}).label || "—"))}
      ${row("SCANNED", S.snap.scanned ?? "—")}
      ${row("STALE", S.snap.stale ? "YES" : "NO", S.snap.stale ? "var(--bear)" : "var(--bull)")}
      ${row("BROKER", (S.snap.health || {}).broker ? "CONNECTED" : "DOWN",
        (S.snap.health || {}).broker ? "var(--bull)" : "var(--bear)")}
      ${row("PAGE FETCHED", S.lastFetch ? S.lastFetch.toLocaleTimeString("en-IN", { hour12: false }) : "—")}
    `) : "";

    return `<div class="cols2">
      ${card("SUBSYSTEMS", subsystems || empty("No diagnostics."))}
      <div>${card("CALL ACCURACY", accuracy || empty("No accuracy data."))}${meta}</div>
    </div>`;
  }

  /* ============================================================= render */
  const RENDERERS = {
    command: renderCommand,
    setups: renderSetups,
    flow: renderFlow,
    radar: renderRadar,
    news: renderNews,
    journal: renderJournal,
    system: renderSystem,
  };

  function render() {
    const host = qs(`.panel[data-panel="${S.tab}"]`);
    if (!host) return;
    try {
      host.innerHTML = RENDERERS[S.tab]();
    } catch (err) {
      console.error(err);
      host.innerHTML = `<div class="banner bad"><b>RENDER ERROR</b>
        ${esc(err.message)} &mdash; the payload did not have the shape this panel expects.</div>`;
    }
    host.classList.add("fadein");
    setTimeout(() => host.classList.remove("fadein"), 320);
  }

  /* =============================================================== wire */
  qsa(".bn").forEach((btn) => {
    btn.addEventListener("click", () => {
      qsa(".bn").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      qsa(".panel").forEach((p) => { p.hidden = p.dataset.panel !== btn.dataset.tab; });
      S.tab = btn.dataset.tab;
      window.scrollTo({ top: 0, behavior: "instant" });
      if (S.tab === "journal") loadCalls();
      if (S.tab === "system") loadSystem();
      render();
    });
  });

  document.addEventListener("click", (e) => {
    const sub = e.target.closest("[data-sub]");
    if (sub) {
      S.sub[sub.dataset.sub] = sub.dataset.val;
      render();
      return;
    }

    const setup = e.target.closest("[data-setup]");
    if (setup) {
      S.selected = setup.dataset.setup + setup.dataset.side;
      render();
      return;
    }

    const chain = e.target.closest("[data-chain]");
    if (chain) {
      loadChain(chain.dataset.chain, chain.dataset.chainside);
      if (S.tab !== "flow") {
        qsa(".bn").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === "flow")));
        qsa(".panel").forEach((p) => { p.hidden = p.dataset.panel !== "flow"; });
        S.tab = "flow";
        window.scrollTo({ top: 0, behavior: "instant" });
      }
    }
  });

  $("refresh").addEventListener("click", () => {
    loadSnapshot();
    if (S.tab === "journal") loadCalls();
    if (S.tab === "system") loadSystem();
  });

  /* ================================================================ boot */
  setInterval(() => {
    $("clock").textContent = new Date().toLocaleTimeString("en-IN", {
      hour12: false, timeZone: "Asia/Kolkata",
    });
  }, 1000);

  loadSnapshot();
  loadCalls();
  setInterval(loadSnapshot, 15000);
  setInterval(() => { if (S.tab === "journal") loadCalls(); }, 20000);
  setInterval(() => { if (S.tab === "system") loadSystem(); }, 30000);
})();

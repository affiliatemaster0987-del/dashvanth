# v4 frontend

Only three files changed. Every `.py` file, `render.yaml`, `requirements.txt` and
`.env.example` are byte-identical to v3 — the backend, the Angel One client, the
scoring engine and the Telegram alerts are untouched.

| File | What it is now |
|---|---|
| `templates/index.html` | Seven-tab shell: COMMAND, SETUPS, FLOW, RADAR, NEWS, JOURNAL, SYSTEM |
| `static/style.css` | Saffron-on-ink terminal skin |
| `static/app.js` | Renders `/api/snapshot`, `/api/calls`, `/api/chain`, `/api/diagnostics`, `/api/accuracy` |

No new endpoints. No new Python dependencies. Deploy exactly as before.

---

## Deploy

```bash
git add static/app.js static/style.css templates/index.html
git commit -m "v4 frontend"
git push
```

Render rebuilds on push. Hard-refresh the browser afterwards (`Ctrl+Shift+R`)
or the old CSS stays cached.

If you are rebuilding `app.js` from the three split parts:

```bash
cat app-js-PART-1.txt app-js-PART-2.txt app-js-PART-3.txt > static/app.js
```

Order matters. Nothing else needs joining.

---

## What each tab reads

**COMMAND** — `commander`, `pressure`, `decision`, `read`, `breadth_panel`,
`sector_rows`, `attribution`, `top_setups`, `funnel`, `tiers`.
The buyers-versus-sellers bar is `pressure.buyers`, drawn as a tug-of-war with
the saffron seam sitting where the two sides meet.

**SETUPS** — `jackpot_ce`, `jackpot_pe`, `ce_box`, `pe_box`, `near_trigger`,
`lead_stocks`. Clicking a row opens a dossier built from `checks`, `levels`,
`legs`, `conf`, `lights` and `stack`.

**FLOW** — `index_cards` with PCR and the quoted contract, plus `index_radar`.
The chain panel calls `/api/chain/{sym}` on demand; it is not polled, because
each call quotes live strikes through the broker.

**RADAR** — `scanners` buckets, `movers` lists, `breakout_radar`, `surges`.

**NEWS** — `news` and `news_bias`, with the `actionable` flag surfaced.

**JOURNAL** — `/api/calls`. Each call gets a stage rail
(RAISED → DETECTED → CONFIRMED → ENTRY → T1 → T2 → T3) driven by the
timestamp columns, plus `advice` and `badge` from the engine.

**SYSTEM** — `/api/diagnostics` and `/api/accuracy`.

---

## Two rules the rendering follows

**A missing field renders as an em dash, never as a zero.** If the chain is not
quoting, the card says the chain is not quoting. A zero the trader believes is
worse than a blank that tells the truth.

**Green and red mean the market; saffron means the interface.** They never swap
jobs, so colour alone always carries the same meaning. The only exceptions are
the three state banners, which have text labels as well as colour.

## Three states worth checking after deploy

The frontend has been exercised against all of them:

- **Cold start** — `/api/snapshot` returns 503 while the backend warms up. A
  WARMING UP banner shows the boot stage instead of an empty screen.
- **Stale feed** — `stale: true` puts a red banner at the top and the empty
  scanner buckets explain themselves rather than looking broken.
- **Risk lock** — `risk.locked` shows the stop streak, day P&L and remaining
  cooldown at the top of every tab.

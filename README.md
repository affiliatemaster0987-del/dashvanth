# KRT AI Terminal — Deploy Guide

## இது என்ன

FastAPI + Angel One SmartAPI live market decision terminal.

வெறும் scanner இல்லை. Market bias + stock structure + option chain + news +
risk + timing எல்லாத்தையும் சேர்த்து, கடைசியில் **ஒரே ஒரு instruction** தரும் —
"இப்போ என்ன செய்யணும்?"

---

## முக்கியமான Rules (code-ல hard-coded)

இந்த நான்கு rules எந்த சூழ்நிலையிலும் மாறாது:

1. **Mandatory filter fail ஆனா call இல்லை.** Score 95 இருந்தாலும்
   LEVEL / VOLUME / VWAP / MARKET / SECTOR / TIME / NEWS-ல ஒன்னு fail ஆனா
   `NO QUALITY CALL — WAIT` தான்.
2. **Level touch ≠ break.** Candle close + follow-through இருந்தா தான் valid.
   இல்லனா `FAKEOUT RISK`.
3. **Accuracy invent பண்ணாது.** எல்லா % உம் actual triggered calls-ல இருந்து
   compute ஆகுது. Entry trigger ஆகாத calls denominator-ல வராது.
4. **Fixed 10/20/30 points இல்லை.** Target = ATR × window multiplier, அப்புறம்
   nearest PDH/PWH/PMH level-க்கு clip. Afternoon-ல T3 தானா trim ஆகும்.

---

## Files

| File | வேலை |
|---|---|
| `app.py` | FastAPI routes + background scheduler (60s scan, 30s call repricing) |
| `engine.py` | Pure decision engine — scoring, targets, fakeout, strike, commander |
| `scanner.py` | Candles → VWAP, ATR, PDH/PWH/PMH levels, volume ratio, sector strength |
| `smart_client.py` | Angel SmartAPI wrapper — login, instruments, LTP, candles, chain |
| `news.py` | RSS headlines → POS / NEG / NEU / HIGH tagging + symbol matching |
| `tracker.py` | SQLite — call state machine, max excursion, accuracy analytics |
| `notify.py` | Telegram alerts (optional) |
| `templates/`, `static/` | Terminal UI |

---

## Local-ல run பண்ண

```bash
git clone <your-repo-url> && cd krt-ai-terminal-v3
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # உன் Angel credentials fill பண்ணு
uvicorn app:app --reload --port 8000
```

`http://localhost:8000` திறந்தா terminal வரும்.

---

## Angel One credentials எடுக்கிறது

1. https://smartapi.angelbroking.com → sign in → **My Apps** → Create App
2. கிடைக்கிறது: **API Key**
3. **TOTP secret**: Angel One → Profile → Settings → Enable TOTP →
   QR code-ஓட கூட காட்டப்படும் base32 string-ஐ copy பண்ணு
   (QR image இல்லை, அதுக்கு கீழ இருக்கிற text). அது தான் `ANGEL_TOTP_SECRET`.
4. `ANGEL_CLIENT_CODE` = உன் login ID, `ANGEL_PIN` = trading PIN.

`.env`-ஐ **எப்பவும்** commit பண்ணாதே. `.gitignore`-ல already இருக்கு.

---

## Render-ல deploy

1. GitHub-க்கு push பண்ணு (private repo).
2. Render → **New → Blueprint** → repo select பண்ணு.
   `render.yaml` automatic-ஆ படிக்கும்.
3. Environment tab-ல இந்த values fill பண்ணு:
   `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PIN`, `ANGEL_TOTP_SECRET`,
   (optional) `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

   **v2-ல இருந்து வர்றவங்களுக்கு:** பழைய `SMARTAPI_KEY`, `SMARTAPI_CLIENT`,
   `SMARTAPI_PIN`, `SMARTAPI_TOTP` பேர்களும் வேலை செய்யும். Render-ல
   ஏற்கனவே set பண்ணியிருந்தா எதுவும் மாத்த வேண்டாம்.
4. Deploy → `/api/health` check பண்ணு:

```json
{ "ok": true, "broker": true, "instruments": 98000, "last_scan": "10:24:03" }
```

`"broker": false` னா `broker_error` field-ல reason இருக்கும்.

### 💾 Call history permanent-ஆ வைக்க (இலவசம்)

Render free tier-ல filesystem ephemeral — restart ஆனா `terminal.db` அழிஞ்சிடும்.
அதனால தான் "Storage is not persistent" warning வந்துச்சு.

**இலவச fix — Supabase:**

1. https://supabase.com → free account → New Project
2. Project Settings → **Database** → Connection string → **URI** copy பண்ணு
   (`postgresql://postgres:[PASSWORD]@db.xxxx.supabase.co:5432/postgres`)
3. Render → Environment → புது variable:
   ```
   DATABASE_URL = <அந்த URI>
   ```
4. Save → auto-deploy

`/api/health`-ல check பண்ணு:
```json
{ "db_backend": "postgres", "db_persistent": true }
```

இனிமே server restart ஆனாலும் calls, targets, accuracy எதுவும் போகாது.
Supabase free tier 500 MB — இந்த terminal-க்கு வருஷக்கணக்கா போதும்.

`DATABASE_URL` set பண்ணலனா SQLite-ல தான் ஓடும், எல்லாம் வேலை செய்யும்,
ஆனா history restart-ல போயிடும்.

---

**Free plan warning:** Render free tier 15 நிமிஷம் idle ஆனா sleep ஆகிடும்,
அப்போ background scan நிக்கும். Market hours-ல தேவைனா paid instance
(Starter) use பண்ணு, இல்லனா cron-job.org-ல இருந்து 10 நிமிஷத்துக்கு ஒரு
முறை `/api/health` ping பண்ணு.

---

## API

| Route | வேலை |
|---|---|
| `GET /api/health` | Broker connection, instrument count, last scan |
| `GET /api/snapshot` | UI-க்கு தேவையான எல்லாம் — commander, calls, jackpot, news |
| `GET /api/chain/{sym}?side=CE` | Option chain + best strike |
| `GET /api/calls` | Today's calls + summary + risk state |
| `POST /api/calls?side=CE` | Top setup-ஐ tracked call ஆக்கு |
| `GET /api/accuracy?last=50` | Last-N accuracy + segment breakdown |

---

## Tuning

`config.py`-ல `UNIVERSE` மாத்தி எந்த F&O stocks scan பண்ணனும்னு சொல்லலாம்.
`SECTOR_MAP`-ல புது symbol சேர்க்கும்போது அதோட sector-ஐயும் சேர்.

`engine.py`-ல:
- `WEIGHTS` — ஒவ்வொரு check-க்கு எத்தனை points
- `MANDATORY` — எந்த check fail ஆனா call முழுசா cancel
- `target_engine` — ATR multipliers per window

2–3 வாரம் data சேர்ந்த பிறகு Accuracy Lab பாரு. T3 hit rate 30%-க்கு கீழ
இருந்தா `target_engine`-ல T3 multiplier-ஐ 1.9 → 1.5 குறை.

---

## Rate limits

SmartAPI-ல quote/historical endpoints ≈ 3 requests/second. `smart_client.py`-ல
throttle இருக்கு, daily candles session-க்கு ஒரு முறை cache ஆகும். Universe-ஐ
25 symbols-க்கு மேல வளர்த்தா scan interval-ஐ 60s-ல இருந்து அதிகப்படுத்து.

---

## Limitations (honest-ஆ)

- SmartAPI method names version-க்கு version மாறும். Login fail ஆனா
  https://smartapi.angelbroking.com/docs-ல latest signature check பண்ணு.
- News RSS feeds-ல symbol matching keyword-based. 100% accurate இல்லை.
- Option chain spread `getMarketData` FULL mode depth-ல இருந்து எடுக்கப்படுது
  (real bid-ask). Depth வரலனா 2% estimate fallback.
- Backtest module இல்லை. Accuracy Lab forward-tracked calls மட்டும் தான்.

---

## ⚠️ Disclaimer

இது ஒரு decision-support tool. Score என்பது எத்தனை confirmations align
ஆகியிருக்கு என்பதன் ranking — அது future prediction இல்லை, profit
guarantee இல்லை.

SEBI study படி intraday F&O-ல retail traders-ல பெரும்பான்மையானவர்கள்
நஷ்டம் அடைகிறார்கள். இந்த terminal உன் **discipline**-ஐ improve பண்ணும் —
edge-ஐ guarantee பண்ணாது. அதனால தான் Risk Manager-ஐ turn off பண்ண
option வேணும்னே கொடுக்கல.

Register-ஆன investment adviser இல்லை. எல்லா trade-க்கும் முழு
பொறுப்பு உன்னுடையது.

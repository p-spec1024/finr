# FINR v2.0 — Continuation Prompt

> Copy-paste this entire block into a new Claude chat to continue development. Select the FINR folder when prompted.

---

## Project Overview

**FINR v2.0** is a professional stock intelligence PWA for the **Indian NSE/BSE market**. Single-page application with:
- **Backend**: `server.js` (~3,456 lines) — Express + WebSocket server with Upstox live data, Zerodha integration, Gemini AI (multi-key rotation + Vertex AI fallback with Google Search grounding), Twelve Data for commodities/forex/global indices
- **Frontend**: `public/index.html` (~4,560 lines) — Full SPA with Tailwind CSS, Material Symbols, dark theme ("Precision Vault" design system)
- **Tests**: `tests/unit.js` (802 lines, 116 tests — all passing)
- **Libs**: `lib/marketContext.js`, `lib/signals.js`, `lib/technicals.js`, `lib/zerodha.js`
- **Deployed on**: Railway (Express server)

## File Structure

```
FINR/
├── server.js                 (~3,456 lines — main backend)
├── public/
│   ├── index.html            (~4,560 lines — entire frontend SPA)
│   ├── manifest.json         (PWA manifest)
│   ├── sw.js                 (Service Worker)
│   └── icons/                (icon-192.png, icon-512.png)
├── lib/
│   ├── marketContext.js      (Hardcoded structural market events)
│   ├── signals.js            (Trading signal generation)
│   ├── technicals.js         (RSI, EMA, MACD, Bollinger, Support/Resistance)
│   └── zerodha.js            (Zerodha API integration)
├── tests/
│   └── unit.js               (116 unit tests — ALL PASSING)
├── package.json              (v2.0.0)
└── .finr_config.enc          (Encrypted runtime config)
```

## Design System — "Precision Vault"

- Base: `#0a0a0a` / Surface: `#1c1b1b` / Card: `#242426`
- Gold accent: `#ffd60a` / Green: `#47e266` / Red: `#ffb4ab`
- Fonts: Manrope (headlines), DM Sans (body), DM Mono (data)
- Material Symbols Outlined for icons

## Architecture Details

### Data Source Architecture

There are TWO independent data pipelines:

1. **Upstox API** (OAuth REST polling) — NSE/BSE live stock quotes, indices (Nifty 50, Bank Nifty, FinNifty, MidCap, SENSEX), VIX, FII/DII data, Gift Nifty. Only works during Indian market hours (Mon-Fri, 9:15 AM – 3:30 PM IST).

2. **Twelve Data API** (free tier, 800 calls/day, 8/min) — Runs 24/7 with adaptive polling (5min during market hours, 10min after). Provides:
   - Commodities: Gold (XAU/USD), Crude WTI (CL)
   - Forex: USD/INR
   - Global Indices: S&P 500 (SPX), NASDAQ (IXIC), Dow Jones (DJI), Nikkei 225 (NI225)

**Important**: `TWELVE_DATA_API_KEY` must be set in Railway env vars (free at twelvedata.com). Gift Nifty stays on Upstox only — no free after-hours API exists for NSE IX futures.

### Twelve Data Config (server.js ~line 63-76)

```javascript
const TWELVE_DATA_SYMBOLS = [
  { key: 'GOLD',        symbol: 'XAU/USD',    name: 'Gold $/oz',   type: 'Commodity' },
  { key: 'CRUDE',       symbol: 'CL',         name: 'Crude WTI',   type: 'Commodity' },
  { key: 'USDINR',      symbol: 'USD/INR',    name: 'USD/INR',     type: 'Currency' },
  { key: 'SP500',       symbol: 'SPX',        name: 'S&P 500',     type: 'Index' },
  { key: 'NASDAQ',      symbol: 'IXIC',       name: 'NASDAQ',      type: 'Index' },
  { key: 'DOW',         symbol: 'DJI',        name: 'Dow Jones',   type: 'Index' },
  { key: 'NIKKEI',      symbol: 'NI225',      name: 'Nikkei 225',  type: 'Index' },
];
```

### AI Engine (server.js)
- **`callAI(prompt, opts)`** — Unified fallback chain:
  - For each model tier (gemini-3.0-flash → 2.5-flash → 2.0-flash):
    - Phase 1: Try all Gemini API keys (up to 3) for that model
    - Phase 2: Try Vertex AI with the same model
  - Handles 429 rate limits, 404 model-not-found, auto key rotation
  - `preferGrounded: true` option → Vertex AI with Google Search grounding
- **`callVertexAI(prompt, opts)`** — Tries 4 endpoint configs:
  - global/v1, global/v1beta1, us-central1/v1, us-central1/v1beta1
  - Retries without grounding if all 404 with grounding
- **Gemini models**: `GEMINI_MODELS = ['gemini-3.0-flash-preview-04-17', 'gemini-2.5-flash-preview-04-17', 'gemini-2.0-flash']`
- All AI callers use `callAI()`: options analysis, options recommendations, long-term picks, verify stock, options lab, news

### WebSocket (server.js → index.html)
- Server connects to Upstox WebSocket for live NSE data
- Sends `init` message with: stocks, indices, signals, vix, fiiDii
- Client processes quotes via `processUpstoxQuote()`, updates `S`, `IDX`, `VIX`, `FIIDII`
- Tick handler updates hero card, sparkline, ticker strip, and all relevant cards

### Frontend State (index.html)
```javascript
let S={}, SIG={}, IDX={}, VIX={...}, FIIDII={...}, GM={};
let PF=[], NT=[], OPTS=[], TRADES=[];
let curTab='home', curInsTab='picks', curPnlTab='dashboard';
let NEWS_ITEMS=[], MARKET_EVENTS=[];
let globalMarkets = {};  // From Twelve Data via /api/global
let newsFilterMode = 'all';  // 'all' | 'national' | 'international'
let sparkData = {};  // Per-index sparkline data accumulator
```

### Key Frontend Features

**Hero Card (top of Home tab)**:
- Index switcher chips: NIFTY 50, BANK NIFTY, FINNIFTY, MIDCAP, SENSEX, GIFT NIFTY
- Shows live price, change %, up/down arrow
- SVG sparkline chart (gradient area + polyline + animated pulse dot) — accumulates data points from WebSocket ticks (max 60 points, 30s throttle)
- `renderHeroForIndex()` handles data display + no-data state ("Awaiting data...")
- `collectSparkData()` accumulates price snapshots per index
- `renderSparkline()` draws the SVG sparkline

**Ticker Strip** (`#ti-wrap`):
- Scrolling strip below hero card showing all live data
- `renderTicker()` populates with: indices, VIX, global markets (from Twelve Data), top 5 movers
- Called on both WS init and every tick (runs regardless of active tab)

**Market Intelligence Card**:
- "Today's Behavior" — expandable card showing AI analysis with USD/INR, Crude, VIX, FII/DII
- "Next Session Outlook" — expandable card (same expand/collapse pattern as Today's Behavior)
  - `toggleNextDetail()` handles expand/collapse
  - Contains catalysts and reasoning sections
  - Auto-expands after 2:30 PM IST

**Economic Calendar**:
- Combines structural events (from `lib/marketContext.js`) with Gemini-grounded live events (30min cache)
- All events are clickable — open Google News search for the event
- Live AI-sourced events have a "LIVE" badge
- `renderEconCal()` and `renderFullEventCalendar()` handle display

### Key API Endpoints (server.js)
- `GET /api/news` — AI-generated news with scope (NATIONAL/INTERNATIONAL)
- `GET /api/market-prediction` — AI market behavior + next session outlook
- `GET /api/market-context` — Structural events + Gemini-grounded live events (with `searchUrl` on all events)
- `GET /api/global` — Twelve Data global markets (`{ globalMarkets, symbolCount }`)
- `GET /api/system-health` — Connection status for all services
- `GET /api/options/analysis/:symbol` — Options chain analysis
- `GET /api/long-term-picks` — AI stock picks
- `GET /api/options-lab` — Options scanner
- `POST /api/settings` — Save API keys/config
- `GET /api/live` — REST fallback for live stock data
- `GET /api/allIndices` — Proxied NSE allIndices data
- `GET /api/fiidiiTradeReact` — Proxied NSE FII/DII data

### NSE Direct API Integration
- Session-cookie-based fetching: first hits `nseindia.com` to get cookies, then uses them for API calls
- `/api/allIndices` → `https://www.nseindia.com/api/allIndices`
- `/api/fiidiiTradeReact` → `https://www.nseindia.com/api/fiidiiTradeReact`

### Tabs
1. **Home** — Hero index card (with sparkline), ticker strip, 6 collapsible cards: Live Market News (National/International filter), Flows & Macros, Economic Calendar, Market Breadth, Market Health gauge, Market Pulse chart. Also has Market Intelligence (AI prediction with today's behavior + next session outlook).
2. **Insights** — AI Picks + Options Lab (market hours gated: Mon-Fri 9:15-15:30 IST)
3. **Portfolio** — P&L Dashboard, Trade Journal, Holdings
4. **Settings** — 4 API connectors (Upstox, Zerodha, Gemini, Vertex AI), PIN, Event Calendar, System Health, Logs

## Recent Git History (latest first)

```
3ff7b3a  Twelve Data 24/7 polling for commodities/forex/global indices, remove Upstox global resolver
17b4370  SENSEX chip, sparkline hero chart, expandable Next Session, clickable events, ticker strip, global index fixes
4fa2e4b  feat: real NSE index prices + FII/DII from official API
aff7bdf  feat: real F
d0b9fd7  fix: timezone bug in IST calculation on Vercel (UTC servers)
ba7169a  fix: news filters, timestamps, global markets & peek display
a11b1e0  feat: home page timestamps, Gift Nifty, news filters, market hours gate, UI fixes
33340ba  feat: unified AI fallback chain with Vertex AI at each model tier + Connect/Disconnect All
```

**Note**: Commits `3ff7b3a` and `17b4370` have broken commit messages (heredoc didn't execute in terminal). The actual code changes ARE committed correctly.

## What Was Done in the Last Session (2 commits)

### Commit 17b4370 — UI Enhancements
1. **SENSEX chip** added to index switcher bar
2. **Hero card sparkline** — replaced 3 sub-index mini-cards with SVG trend graph (gradient area chart with polyline + animated pulse dot, accumulates 60 data points)
3. **Next Session Outlook** — made expandable like Today's Behavior card (was previously always visible)
4. **Economic Calendar events** — all clickable (open Google News search), AI-sourced events have LIVE badge
5. **Ticker strip renderer** — `renderTicker()` populates scrolling strip with indices, VIX, global markets, top movers
6. **Global index chips** — fixed "no data" state (was showing stale % from previous index)
7. **USD/INR and Crude** — show "--" instead of "$0" when data not yet loaded

### Commit 3ff7b3a — Twelve Data 24/7 Integration
1. **Twelve Data runs 24/7** — removed `isGlobalMarketWindow()` gating entirely
2. **Commodities/forex on Twelve Data** — Gold (XAU/USD), Crude (CL), USD/INR trade ~24/5, always current
3. **Global indices on Twelve Data** — S&P 500, NASDAQ, Dow, Nikkei 225
4. **Gift Nifty stays on Upstox** — no free after-hours API exists for NSE IX futures
5. **Removed Upstox global instrument resolver** — `resolveUpstoxGlobalInstruments()`, `processUpstoxGlobalQuote()`, `upstoxGlobalKeys` all removed (was dynamic MCX/Currency futures resolver)
6. **Adaptive polling** — 5min during market hours, 10min after hours
7. **Simplified `/api/global`** endpoint — just returns `{ globalMarkets, symbolCount }`

## Environment Variables (Railway)

Required:
- `UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, `UPSTOX_REDIRECT_URI` — Upstox OAuth
- `GEMINI_API_KEY` (+ optional `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`) — Gemini AI
- `TWELVE_DATA_API_KEY` — Free tier at twelvedata.com (800 calls/day)

Optional:
- `GCP_SERVICE_ACCOUNT` — Base64 JSON for Vertex AI
- `ZERODHA_API_KEY`, `ZERODHA_API_SECRET` — Zerodha integration
- `PIN_CODE` — App lock PIN

## Rules for Development

1. **NEVER create new files** — All frontend goes in `public/index.html`, all backend in `server.js`
2. **After EVERY change**, run `node tests/unit.js` — all 116 tests must pass
3. **Preserve the design system** — Use only Precision Vault colors and fonts
4. **IST timezone** — All market logic uses `Asia/Kolkata` (UTC+5:30)
5. **Market hours**: Mon-Fri, 9:15 AM (555 mins) – 3:30 PM (930 mins) IST
6. **AI responses**: Always parse JSON defensively (try/catch, regex fallback, individual object extraction)
7. **NO mock data** — Every data point must come from a real API. AI must not hallucinate (use Vertex AI grounding).
8. **Clean efficient code** — No unnecessary complexity

## "Next Session" Explanation

"Next Session" in the Market Intelligence card = the **next trading day on NSE**. If today is Friday, next session = Monday. AI predicts market direction based on overnight global cues, Gift Nifty, US futures, crude oil, FII flows, macro factors. Values: BULLISH, CAUTIOUSLY_BULLISH, NEUTRAL, CAUTIOUSLY_BEARISH, BEARISH.

---

**Continue from here. Ask me what you want to work on or what issues you're seeing.**

# FINR v2.0 — Continuation Prompt

## Repository
- **GitHub:** https://github.com/p-spec1024/finr.git
- **Branch:** main
- **Deployment:** Railway (auto-deploys on push)
- **Local Path:** C:\Users\prash\Documents\FINR
- **Workspace folder mounted at:** /sessions/[session-id]/mnt/FINR

## Core Files
- `server.js` (6175 lines) — Full Node.js/Express backend with AI engine, APIs, polling, predictions
- `public/index.html` (6793 lines) — Full frontend single-page PWA
- `tests/unit.js` (116 tests, all passing)

## What FINR Is
FINR v2.0 is a single-page PWA for Indian stock markets. It features:
- Live Nifty/BankNifty/VIX tracking via NSE + Upstox APIs
- AI analysis via Gemini/Vertex AI with Google Search grounding
- Options chain (PCR, Max Pain, IV), FII/DII flows
- Global markets via Twelve Data (Gold, Crude, S&P, Nasdaq, Nikkei, etc.)
- AI Stock Picks, Smart Screener, Options Lab
- Zerodha integration for portfolio tracking
- AES-256 encrypted config/data storage

## Design System
- Background: `#131313`, Cards: `#1c1b1b`, Gold accent: `#ffd60a`, Text: `#e5e2e1`, Muted: `#d0c6ab`
- Font: System + Google Material Symbols Outlined
- Tailwind CSS (CDN), no build system
- Mobile-first, responsive with desktop layout customization

## Recent Architecture (what was just built)

### 4-Phase Prediction Engine (NEW — just deployed March 30, 2026)
A forward-looking prediction system that generates LOCKED predictions at 4 key market moments:

**Phases:**
1. **Pre-Market** (8:00–9:14 AM IST) — Uses GIFT Nifty, US close, Asian markets, news via Google Search grounding
2. **Opening Verdict** (9:30 AM) — Analyzes first 15-min candle, gap fill probability, bull/bear trap risk
3. **Mid-Session** (12:30 PM) — Predicts afternoon using day range position, breadth evolution, VIX trajectory
4. **Power Hour** (2:00 PM) — Predicts closing behavior using full-day context, range analysis

**Server-side (`server.js`):**
- `phaseCache` — in-memory cache with date-rolling via `resetPhaseCache()`
- `getPhaseDataSnapshot()` — collects ALL quantitative data (OHLC, VIX, FII/DII, breadth, options, sectors, globals)
- `buildPhasePrompt(phase, snapshot, prevPhases)` — constructs per-phase AI prompts with self-awareness
- `GET /api/market-predictions` — returns all 4 phases with status (UPCOMING/AVAILABLE/LOCKED/SCORED)
- `storePrediction()` handles types: `phase_1_premarket`, `phase_2_opening`, `phase_3_midsession`, `phase_4_powerhour`
- `scorePrediction()` has 100-point weighted scoring per phase type
- `verifyPredictions()` runs 9:15 AM–6:00 PM for scoring (fixed from previous bug where post-market verification never triggered)
- Holiday handling: serves last trading day's predictions from `predictionHistory` when market is closed

**Frontend (`public/index.html`):**
- Prediction Timeline in Market Intelligence card (home page) with 4 scrollable phase pills
- Phase pills show status: gold=locked, green=scored, orange pulsing=available, gray=upcoming
- Active phase card shows direction, confidence, reasoning, phase-specific details, risk, key factors, score
- `loadPhases()`, `renderPhaseTimeline()`, `selectPhase()` functions
- Constants: `DIR_MAP`, `PHASE_ICONS`, `PHASE_NAMES`, `PHASE_TYPES_MAP`

**Accuracy Dashboard (Settings > AI Accuracy tab):**
- 4 phase accuracy cards in a 2x2 grid showing per-category breakdowns with progress bars
- IDs: `acc-p1-avg`, `acc-p2-avg`, `acc-p3-avg`, `acc-p4-avg` + per-category bars
- `renderAccBreakdown()` updated to populate phase accuracy from `/api/accuracy` response

### Existing Features (unchanged)
- **Live Pulse** (renamed from "Today's Behavior") — real-time market state, refreshes every 15 min during market hours via `/api/market-prediction`
- **Next Session Outlook** — post-market prediction for next trading day via `/api/next-session`
- **AI Accuracy Dashboard** — Settings page sub-tab with overall gauge, per-type breakdowns, weekly trend chart, recent/pending tables
- **Upstox connection** — REST polling with `connectionStatus` state machine: disconnected → authenticated → live

## Key Technical Details
- IST timezone: `getIST()` adds 5.5h to UTC, `getISTMins()` returns minutes since midnight IST
- `isMarketOpen()`: weekday 9:15 AM (555 mins) to 3:30 PM (930 mins)
- `callAI()` priority: Vertex AI grounded → Gemini keys (rotates 3) → Vertex ungrounded
- Gemini models tried: gemini-3-flash-preview, gemini-2.5-pro-preview, gemini-2.0-pro-exp-0801
- Predictions saved encrypted via `savePredictions()` to `predictions.enc`, max 365 entries
- NSE polling: 10 min market hours, 30 min after close
- Twelve Data: 24/5 polling for global commodities/forex/indices
- Gemini test timeout: 45000ms (increased from 25000ms)

## Current State (March 30, 2026)
- Latest commit: `af3e82e` — Fix prediction verification timing, add holiday support
- All 116 unit tests passing
- **March 31 is a market holiday** — holiday handling code deployed to show today's scored predictions
- Phase predictions are NEW — first day deployed, no historical accuracy data yet
- Today's predictions should get scored after 3:30 PM if the verification runs successfully

## Git Commands (for the user, from Windows terminal)
```bash
cd C:\Users\prash\Documents\FINR
git add -A && git commit -m "message" && git push origin main
```

## Known Issues / Things to Watch
1. Phase predictions haven't been tested with live market data yet (just deployed today March 30)
2. If Gemini API is slow/down, phase predictions won't generate (falls back gracefully)
3. File sync between Cowork workspace and user's local machine can have delays — always verify with `git status` and `find /c /v ""` to check line counts before committing
4. The user needs to run git commands from their Windows terminal (C:\Users\prash\Documents\FINR), not from the sandbox
5. Always run `node -c server.js` and `node tests/unit.js` after changes to verify syntax and tests pass

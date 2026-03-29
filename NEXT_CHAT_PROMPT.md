# FINR v2.0 — Next Chat Continuation Prompt

## Project Overview
FINR v2.0 is a Professional Stock Intelligence PWA for Indian Markets. It's a single-page Node.js/Express app with a Tailwind CSS frontend. The entire backend is in `server.js` (~5600+ lines), and the entire frontend is in `public/index.html` (~5500+ lines).

## Repository Location
```
C:\Users\prash\Documents\FINR\
```

**Key files:**
- `C:\Users\prash\Documents\FINR\server.js` — Full backend (Express, API routes, AI engine, polling, encryption)
- `C:\Users\prash\Documents\FINR\public\index.html` — Full frontend (single-page PWA, all HTML/CSS/JS)
- `C:\Users\prash\Documents\FINR\tests\unit.js` — 116 unit tests (all passing)
- `C:\Users\prash\Documents\FINR\.finr_predictions.enc` — Encrypted prediction history (AES-256)

---

## TASK: Build AI Accuracy Dashboard UI

### What's Already Built (Backend — Complete)
The prediction accuracy tracking engine is fully implemented in `server.js`. Here's what exists:

#### 1. Data Model (line ~63)
```javascript
let predictionHistory = []; // Array of prediction entries
const PREDICTIONS_FILE = path.join(__dirname, '.finr_predictions.enc');
```

#### 2. Persistence (lines ~637-645)
- `loadPredictions()` — Reads `.finr_predictions.enc`, decrypts with AES-256 via `dec()` helper
- `savePredictions()` — Encrypts with `enc()` helper, writes to file
- Both loaded at startup alongside `loadTrades()` and `loadPicks()`

#### 3. Prediction Capture (lines ~647-695)
`storePrediction(type, data)` captures snapshots when AI predictions are generated:
- **Hooked into** `/api/next-session` endpoint (after `nextSessionCache` is set)
- **Hooked into** `/api/market-prediction` endpoint (after `todayCache` is set)
- Supports types: `next_session`, `today_behavior` (extensible to `ai_pick`, `options_insight`)
- Deduplicates by type+predictedDate (keeps latest PENDING per combo)
- Keeps max 365 entries

Each prediction entry shape:
```javascript
{
  id: 'unique-id',
  type: 'next_session' | 'today_behavior',
  date: '2026-03-30',           // IST date when generated
  predictedDate: '2026-03-31',  // Date the prediction is FOR
  generatedAt: ISO timestamp,
  status: 'PENDING' | 'VERIFIED',
  prediction: { /* type-specific fields */ },
  actual: null | { /* actual market data */ },
  scores: null | { total, max, pct, breakdown: { ... } },
  verifiedAt: ISO timestamp (set after verification)
}
```

**Next Session prediction fields:**
```javascript
{ outlook, confidence, openingExpectation, niftyRange: {low, high}, bankNiftyRange: {low, high}, riskLevel, globalSentiment, giftNifty, keyDrivers, sectorOutlook }
```

**Today Behavior prediction fields:**
```javascript
{ behavior, confidence, explanation, niftySupport, niftyResistance }
```

#### 4. Verification (lines ~696-740)
`verifyPredictions()` runs during market hours (after 10 AM IST) via the NSE polling loop:
- Fetches actual Nifty/BankNifty prices, VIX, FII/DII from NSE cache
- Compares PENDING predictions whose `predictedDate` matches today
- Calls `scorePrediction()` to compute detailed scores
- Saves results back to encrypted file

#### 5. Scoring System (lines ~744-844)
`scorePrediction(pred)` — 100-point weighted scoring:

**Next Session (100 pts):**
| Category | Points | Logic |
|----------|--------|-------|
| Outlook Direction | 25 | BULLISH/BEARISH/NEUTRAL match (partial credit for adjacent) |
| Opening Expectation | 15 | GAP_UP/GAP_DOWN/FLAT_OPEN vs actual gap % |
| Nifty Range | 25 | Tolerance-based: 0.5%→22pts, 1%→18pts, 1.5%→12pts, 2.5%→6pts |
| Bank Nifty Range | 15 | Same tolerance-based scoring |
| Risk Assessment | 10 | HIGH/MODERATE/LOW vs VIX+FII-based actual risk |
| Confidence Calibration | 10 | |confidence - actualAccuracy| difference |

**Today Behavior (100 pts):**
| Category | Points | Logic |
|----------|--------|-------|
| Behavior Direction | 50 | Exact match 50, same direction 35, neutral mismatch 15 |
| Support/Resistance | 50 | Avg error: <0.5%→50, <1%→40, <2%→25, <3%→10 |

#### 6. API Endpoint — `GET /api/accuracy`
Returns aggregated accuracy stats. Query params: `?type=next_session&days=90`

Response shape:
```javascript
{
  total: 45,           // Total predictions in period
  verified: 30,        // Scored predictions
  pending: 15,         // Awaiting verification
  avgScore: 67,        // Overall average (0-100)
  highestScore: 92,
  lowestScore: 34,
  byType: {
    next_session: {
      count: 18, avgScore: 71,
      categories: {
        outlook: { avgPct: 80, samples: 18 },
        opening: { avgPct: 65, samples: 18 },
        niftyRange: { avgPct: 72, samples: 18 },
        bankNiftyRange: { avgPct: 58, samples: 18 },
        risk: { avgPct: 70, samples: 18 },
        calibration: { avgPct: 55, samples: 18 }
      }
    },
    today_behavior: {
      count: 12, avgScore: 62,
      categories: {
        behavior: { avgPct: 65, samples: 12 },
        levels: { avgPct: 59, samples: 12 }
      }
    }
  },
  trend: [/* Last 30 verified predictions with full breakdown */],
  weekly: [/* Last 12 weeks with avg/high/low/count */]
}
```

---

### What Needs To Be Built (Frontend — New)

**Add an "AI Accuracy" tab inside the Settings page (`id="pg-more"`).**

The Settings page currently has:
- A top action bar with "Save All" and "Connect All" buttons
- A 3-column grid with: API Connectors | System | AI Performance
- Navigation via `goTab('more')` from sidebar
- Located at line ~1426 in `index.html`

**Required UI implementation:**

1. **Add sub-tab navigation** at the top of the Settings page:
   - Tab 1: "Configuration" (existing settings content)
   - Tab 2: "AI Accuracy" (new dashboard)
   - Style: Match app's tab pattern (gold underline for active, dark bg)

2. **AI Accuracy Dashboard** should include:

   **a) Overall Score Card**
   - Big circular/arc gauge showing overall avg accuracy %
   - Color-coded: Green (>70%), Yellow (50-70%), Red (<50%)
   - Total predictions count, verified count, pending count

   **b) Per-Feature Breakdown Cards**
   - Next Session Outlook accuracy
   - Today's Behavior accuracy
   - Each showing: avg score, sample count, trend arrow (improving/declining)
   - Category-level bars (e.g., Outlook 80%, Range 72%, Risk 70%)

   **c) Trend Chart**
   - Line chart showing accuracy over time (weekly averages)
   - Use simple canvas/SVG — no external charting library needed
   - Gold line on dark background matching app theme

   **d) Recent Predictions Table**
   - Last 10-20 verified predictions
   - Columns: Date, Type, Score, Key Metrics, Status
   - Expandable rows to see full breakdown
   - Color-coded scores (green/yellow/red)

   **e) Pending Predictions Section**
   - List of predictions awaiting market data verification
   - Show predicted date, type, key prediction values

3. **Data fetching:**
   ```javascript
   async function fetchAccuracy() {
     const r = await fetch('/api/accuracy?days=90');
     const data = await r.json();
     // Render dashboard
   }
   ```

---

### App Design System (MUST FOLLOW)

**Colors:**
- Background: `#131313` (main), `#1c1b1b` (cards), `#242426` (inputs)
- Gold accent: `#ffd60a` (primary action color)
- Text: `#e5e2e1` (primary), `#d0c6ab` (labels/secondary), `#636366` (muted)
- Borders: `white/5` (subtle), `#353534` (dividers)
- Green: `#34c759` (positive/up), Red: `#ff453a` (negative/down)

**Typography:**
- Labels: `text-[10px] font-mono font-bold tracking-[0.2em] uppercase text-[#d0c6ab]`
- Values: `text-sm font-bold text-[#e5e2e1]`
- Headers: `text-[13px] font-extrabold text-[#e5e2e1]`

**Card Pattern:**
```html
<div class="bg-[#1c1b1b] rounded-xl overflow-hidden border border-white/5">
  <div class="px-4 py-3"><!-- content --></div>
</div>
```

**Responsive:** Mobile-first with `md:` breakpoints for desktop grid layouts.

**Icons:** Google Material Symbols Outlined (already loaded):
```html
<span class="material-symbols-outlined">icon_name</span>
```

---

### Technical Architecture Reference

**AI System:**
- Gemini AI with `preferGrounded: true` for Google Search grounding
- Vertex AI (primary) → Gemini API (fallback) via `callAI()` helper
- Responses parsed with `parseAIJson()` for robust JSON extraction

**Data Sources:**
- Upstox v2 API: Real-time Indian stock/index prices (9:15-15:30 IST)
- NSE API: FII/DII flows, VIX (market hours only)
- Twelve Data API: 24/5 global markets (Gold, Crude, USD/INR, S&P500, NASDAQ)

**IST Time Helpers:**
- `getIST()` → current IST Date object
- `getISTDay()` → 0-6 (Sun-Sat)
- `getISTMins()` → minutes since midnight IST
- `getISTDateStr()` → "YYYY-MM-DD" in IST
- `isMarketOpen()` → Mon-Fri 9:15-15:30 IST

**Encryption:**
- AES-256 via CryptoJS: `enc(data)` / `dec(ciphertext)`
- Used for: config, trades, picks, predictions

**Prediction Caches:**
```javascript
let todayCache = { data: null, lastFetch: 0, dateIST: '' };
let preMarketCache = { data: null, lastFetch: 0, dateIST: '' };
let nextSessionCache = { data: null, lastFetch: 0, predictedDate: '' };
```

---

### Tests
- `tests/unit.js` — 116 tests covering signal engine, technicals, encryption, portfolio, market hours, etc.
- Run with `npm test`
- All must pass after changes

---

### Summary of What To Do
1. Read the current `index.html` Settings section (around line 1426)
2. Add sub-tab navigation (Configuration | AI Accuracy) to the Settings page
3. Build the AI Accuracy dashboard with: overall gauge, per-feature cards, trend chart, predictions table, pending section
4. Wire it to `GET /api/accuracy?days=90`
5. Match the existing app design system exactly
6. Run syntax checks and all 116 tests

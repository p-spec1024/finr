# FINR v2.0 — Continuation Prompt

Copy-paste everything below this line into your new chat:

---

I'm continuing work on **FINR v2.0** — a Professional Stock Intelligence Platform deployed on Railway. The codebase is in the `FINR` folder. Before making ANY changes, read the relevant files first.

## PROJECT RULES (CRITICAL — FOLLOW ALWAYS)
1. **Short replies** — one step at a time
2. **Run 116 tests before every push**: `node tests/unit.js`
3. **Give git commands** every time changes are made
4. **Never break existing features** — read code before editing
5. **Never guess** — read the actual file lines before editing

---

## ARCHITECTURE

### Tech Stack
- **Backend**: Node.js + Express + WebSocket (`server.js` — 1898 lines)
- **Frontend**: Single-page HTML app (`public/index.html` — 2822 lines)
- **AI**: Google Gemini via `@google/genai` (multi-model fallback in `callGemini()`)
- **Live Data**: Upstox v2 REST polling (2s interval, batches of 25)
- **Deployment**: Railway

### Key Files
```
server.js              — Main server (1898 lines)
public/index.html      — Frontend SPA (2822 lines)
tests/unit.js          — 116 tests, 13 suites (802 lines)
lib/marketContext.js   — Market context engine (214 lines)
lib/signals.js         — Signal scoring engine
lib/technicals.js      — RSI, EMA, SMA, MACD, Bollinger
lib/zerodha.js         — Zerodha broker integration
package.json           — Dependencies (express, ws, axios, crypto-js, cors, helmet, dotenv, node-cron, @google/genai)
```

### server.js — Key Line Numbers
| Section | Lines |
|---------|-------|
| callGemini() (multi-model fallback) | 323–347 |
| /api/options-validate (POST) | 349 |
| /api/options-recommend (GET) — Gemini AI options | 396–494 |
| /api/settings, /api/verify-pin, /api/config-status | 495–531 |
| /api/gemini-status, /api/system-health, /api/logs | 533–574 |
| /api/portfolio, /api/notes, /api/options-trades | 575–637 |
| /api/alerts (GET/POST/clear) | 639–665 |
| /api/live, /api/global, /api/technical/:symbol | 667–699 |
| /api/fii-dii | 700–711 |
| /api/market-context | 713–715 |
| newsCache + /api/news (Gemini-powered, 10min cache) | 718–775 |
| /api/signals, /api/market-health | 776–796 |
| /api/zerodha-portfolio | 797 |
| /api/pnl, /api/trades, /api/trades/capture, /api/pnl/csv | 952–1031 |
| STOCK_UNIVERSE (165 stocks) | 1034–1234 |
| SECTOR_PE | 1236 |
| PENNY_STOCKS (48 stocks) | 1238–1290 |
| MOCK_BASE (demo prices) | 1503–1571 |
| WebSocket section | 1695–1712 |

**Total endpoints**: 37 (35 named + 1 wildcard)

### index.html — Key Line Numbers
| Section | Lines |
|---------|-------|
| CSS styles | 12–402 |
| Hero / Index row / Market context (h-ctx) | 448–467 |
| News card (news-card) | 470–490 |
| Market Health gauge + Breadth | 493–501 |
| Strong Buy / Events / FII-DII | 499–513 |
| Market tabs (Stocks, Sectors, Global, Gainers, Penny) | 515–580 |
| Portfolio tabs (Holdings, Zerodha, Options, Overview, P&L) | 592–745 |
| Insights tabs (AI Tools, Signals, Tracker) | 753–757 |
| applyTheme() / toggleTheme() | 1014–1021 |
| refreshAll() | 1022–1039 |
| PIN system (initPin, verPin, bypassPin) | 1045–1088 |
| initApp() | 1090–1128 |
| connectWS() + REST polling | 1132–1230 |
| renderAll() / renderHeroIdx() / renderGauge() / renderBreadth() | 1231–1344 |
| fetchMarketContext() / renderMarketContext() | 1346–1386 |
| fetchNews() / renderNews() / toggleNewsDetail() | 1393–1452 |
| renderAdvisor() | 1455–1491 |
| populateSectorDropdown() / renderStocks() / sortBy() | 1492–1528 |
| renderTicker() / renderVix() / renderGainersLosers() | 1529–1596 |
| computeLiveSectors() / renderSectors() | 1597–1677 |
| renderGlobalMarkets() | 1679–1713 |
| PENNY array (48 entries with manipulation field) | 1714–1767 |
| loadPennyStocks() / renderPenny() | 1768–1812 |
| renderSmartMoney() / renderFiiDii() / renderHomeFiiDii() | 1813–1898 |
| renderEconCal() / renderHomeEvents() | 1899–1917 |
| validateOptions() | 1918–1992 |
| getOptionsRecs() (Gemini AI options with full detail panel) | 1993–2086 |
| openMod() (stock detail modal) | 2087–2202 |
| Portfolio CRUD (loadPF, savePF, addH, editH, removeH, renderPF) | 2210–2281 |
| Zerodha data (doZerodhaRefresh, loadZerodhaData) | 2290–2330 |
| Options trades (loadOpts, saveOpts, addOptTrade, renderOpts) | 2331–2346 |
| Notes (loadNT, saveNote, delNT, renderNT) | 2347–2368 |
| Glossary / Settings / Health / Logs / Test Results | 2369–2438 |
| Alerts system | 2439–2514 |
| P&L Statement (full tax calc, daily/monthly/yearly views) | 2515–2771 |
| Navigation (toggleAcc, goPage, initNav) | 2772–2809 |
| Utility (fmt, fmtK, bdg, toast) | 2810–2822 |

### Key Technical Patterns
- **Upstox key format**: Request uses `NSE_EQ|ISIN`, response uses `NSE_EQ:SYMBOL`
- **STOCK_UNIVERSE fields**: instrumentKey, symbol, name, sector, pe, roe, de, div, target, cap
- **PENNY_STOCKS fields**: symbol, name, sector, price, risk, flag, vol, promoter (NO instrumentKey)
- **Frontend PENNY array**: Same as PENNY_STOCKS but adds `manipulation` field
- **MOCK_BASE**: Object mapping symbol → basePrice (used when market is closed)
- **callGemini()**: Multi-model fallback with rate limit handling
- **All ISINs verified** against: `https://upstox.com/stocks/<name>-share-price/<ISIN>/`

---

## WHAT'S BEEN COMPLETED (Phases 1–6)

### Phase 1 — Strong Buy Signals ✅
- Signal engine scoring stocks 0–100 based on fundamentals (PE, ROE, D/E, dividend, target upside, 52W position)
- Labels: STRONG BUY (80+), BUY (65–79), WATCH (50–64), HOLD (35–49), SELL (20–34), STRONG SELL (<20)
- Home page "Strong Buy" section showing top signals

### Phase 2 — Top Gainers/Losers ✅
- Live computed from actual price data
- Top 10 each (changed from 5)
- Scrollable card layout with % change badges

### Phase 4 — Sector Dropdowns + Live Sector Data ✅
- Replaced 10 cramped filter buttons with clean dropdown selects
- `computeLiveSectors()` replaces hardcoded SECTS array — sectors always reflect real-time data
- `renderSectors()` rewritten with expandable top movers per sector
- `populateSectorDropdown()` dynamically populates sector filter options

### Phase 5 — AI Options Recommendations (Deep Analysis) ✅
- `/api/options-recommend` enhanced: Gemini gets full fundamentals + technicals + sector performance + 52W data
- Response includes: sentiment, strategyType, fundamentals, technicals, targetTime, riskReward, maxLoss, hedgeSuggestion
- Frontend: sentiment emojis (🟢/🟡/🔴), strategy badges, fundamentals/technicals panels, hedge suggestions, "View Full Stock Analysis" button
- Supports naked options + hedging + vertical spreads

### Phase 6 — Live Market News ✅
- `/api/news` endpoint: Gemini generates 8 market-impacting news items with 10-min cache
- Fields: title, priority, impact, sentiment, source, icon, sectors (buy/avoid), detail
- Frontend: scrollable news cards with priority badges (HIGH/MEDIUM/LOW), sentiment indicators, click-to-expand detail with sector tags
- Auto-refreshes every 10 minutes
- Wired into `refreshAll()` button

### Also Done
- **Refresh button** in topbar with spin animation (Phase 4)
- **STOCK_UNIVERSE expanded** to 165 stocks with verified ISINs and fundamentals
- **PENNY_STOCKS cleaned**: 48 stocks, no duplicates with STOCK_UNIVERSE, all sub-₹350 speculative stocks
- **15 stocks moved** from PENNY to STOCK_UNIVERSE (were priced ₹500+)

---

## WHAT'S REMAINING

### Phase 3 — Stock Detail Modal (SKIPPED — I may come back to this)
- Clicking a stock opens a modal with: technicals (RSI, MACD, Bollinger, support/resistance), fundamentals table, price targets, analyst consensus
- The `openMod()` function exists at line 2087 but may need enhancement

### Phase 7 — UI Redesign (WAITING for my Excalidraw mockups)
- Full visual overhaul based on my mockup designs
- I haven't shared mockups yet

---

## TESTS (MUST PASS BEFORE EVERY PUSH)
```bash
node tests/unit.js
```
- **13 suites, 116 tests** — all currently passing
- Suites: Signal Engine, Technical Indicators, Encryption & Security, Portfolio Calculations, Market Context, Auth & URL Validation, Stock Universe Integrity, Zerodha Strategy Grouper, Market Hours Logic, Gemini Prompt Builder, Signal Classification Labels, Twelve Data & Post-Market, P&L Statement & Tax

---

## GIT STATUS
All phases (1, 2, 4, 5, 6) have been coded and tested. Git commands were provided after each phase but may not all have been pushed — check `git log` and `git status` first.

---

## IMPORTANT CONTEXT
- Upstox token expires daily — demo/mock data kicks in when market is closed
- Gemini API key is configured via `/api/settings` endpoint (encrypted with AES)
- The app has a PIN lock system (4-digit) with encrypted storage
- Railway deployment uses `railway.json` for config
- The frontend is a single HTML file — all JS is inline, no bundler
- Penny stocks have NO instrumentKey (can't get live prices from Upstox)
- `MOCK_BASE` provides fallback prices for all stocks when Upstox is down/closed
- The 12 original feature requests from my initial brief are numbered 1–12. Items 1–2, 4–6, 8–10 are done. Item 3 (stock modal) was skipped. Items 7, 11, 12 were part of the UI redesign (Phase 7, waiting for mockups).

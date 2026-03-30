Project: FINR v2.0 — Stock Intelligence PWA (Smart Screener — 5th Insights Tab)
Repository folder: `C:\Users\prash\Documents\FINR`
Key files:
* `server.js` — Node.js/Express backend (~4821 lines)
* `public/index.html` — Single-page frontend (~5154 lines)
* `lib/technicals.js` — Technical analysis engine (RSI, EMA, MACD, Bollinger, support/resistance) — 142 lines
* `lib/marketContext.js` — Dynamic macro/geopolitical events engine — 215 lines
* `tests/unit.js` — 116 unit tests (all passing)

Architecture:
* Gemini AI with multi-key rotation + Vertex AI fallback chain via `callAI()` — `preferGrounded: true` enables Google Search grounding for real-time data
* Upstox v2 API for real-time stock/index prices via REST polling + option chain data (PCR, Max Pain, IV, OI)
* NSE API for FII/DII flows, VIX, indices
* Twelve Data API for global markets (USD/INR, Crude, S&P500, etc.)
* `getTechnicalSignal()` computes RSI, EMA20/50/200, MACD, Bollinger, support/resistance, bestEntry, stopLoss
* `getMarketContext()` returns active macro events (tariffs, RBI, Fed, earnings) with priority/sectors/impact
* `calcSignal()` uses ONLY live data: 35pts 52W position + 65pts technicals (RSI/EMA/MACD/support) — returns `{ score, signal, allReasons, upside, downside, techBias, techScore }`
* `STOCK_UNIVERSE` has 165+ NSE stocks with `{ instrumentKey, symbol, name, sector, cap }` (NO static financials)
* `optionChainCache` has Nifty/Bank Nifty/stock option chains with PCR, Max Pain, IV, OI
* `NSE_LOT_SIZES` defined in both server.js and index.html — identifies F&O eligible stocks
* Market hours gating: `isMarketOpen()` (Mon-Fri 9:15-15:30 IST), `marketClosedResponse()` helper
* All insight features gated to Indian market hours — no mock/static/outdated data ever shown

Backend endpoints (line numbers):
* `/api/market-prediction` (line 1138) — Market Intelligence home
* `/api/market-pulse` (line 1365) — Market Pulse (institutional flow tracker)
* `/api/trade-plan` (line 1687) — Trade Planner (overlay)
* `/api/options-validate` (line 2085)
* `/api/options-recommend` (line 2132)
* `/api/ai-picks` (line 2265) — AI Picks
* `/api/verify-stock` (line 2418) — Verify Pick
* `/api/options-lab` (line 2719) — Options Lab

In-memory state available for the screener (all global variables in server.js):
* `liveStocks` — `{ [symbol]: { price, changePct, volume, dayHigh, dayLow, lastUpdate } }` — live prices for 165+ stocks
* `signalCache` — `{ [symbol]: { score, signal, allReasons, upside, downside, techBias, techScore } }` — FINR computed signals
* `fundamentals` — `{ [symbol]: { high52, low52 } }` — 52-week data
* `priceHistory` — `{ [symbol]: [price1, price2, ...] }` — recent price readings for technicals
* `STOCK_UNIVERSE` — array of `{ instrumentKey, symbol, name, sector, cap }`
* `optionChainCache.stocks` — `{ [symbol]: { pcr, maxPain, avgIV, totalCallOI, totalPutOI, strikes } }` — F&O data for select stocks
* `optionChainCache.nifty` / `optionChainCache.banknifty` — index chains
* `vixData` — `{ value, change, trend, isDefault }`
* `fiiDiiData` — `{ fii, dii, usdInr, crude, isDefault }`
* `liveIndices` — `{ 'Nifty 50': {price, changePct}, 'Nifty Bank': {...}, ... }`
* `NSE_LOT_SIZES` — `{ 'NIFTY': 75, 'RELIANCE': 250, ... }` — F&O lot sizes
* `FNO_STOCKS` — array of F&O eligible stock symbols (derived from NSE_LOT_SIZES excluding indices)

Frontend structure for Insights tabs:
* Navigation pills: `#insights-nav` contains buttons with IDs `nav-picks`, `nav-options`, `nav-verify`, `nav-pulse`
* Tab content divs: `#stab-picks`, `#stab-options`, `#stab-verify`, `#stab-market-pulse`
* Hidden sub-tab buttons: `#ins-tabs` contains buttons with `data-it="picks"`, `data-it="options"`, `data-it="verify"`, `data-it="market-pulse"`
* `switchInsightTab(tab)` function at ~line 2748 handles tab switching with activeMap: `{picks:'nav-picks', options:'nav-options', verify:'nav-verify', 'market-pulse':'nav-pulse'}`
* Active pill style: `text-[#ffd60a] bg-[#353534] font-bold border-b-2 border-[#ffd60a]`
* Inactive pill style: `text-[#d0c6ab] font-headline uppercase tracking-[0.05em] text-[0.6875rem] whitespace-nowrap hover:text-white transition-all`
* Each tab content loads data on tab switch (see line ~2768): `if (tab === 'picks') loadAiPicks(); else if (tab === 'options') loadOptionsLabInline(); else if (tab === 'market-pulse') loadMarketPulse();`

Existing Trade Planner overlay (already built):
* `openTradePlan(symbol)` — opens full-screen overlay, calls `/api/trade-plan`
* Triggered from AI Picks cards, Verify Pick results, and Market Pulse volume anomaly stocks
* Works by sliding up `#trade-plan-overlay` div (at bottom of body, line ~5128)

Completed tabs (DO NOT modify these — only ADD the 5th tab):
1. AI Picks — AI stock recommendations using live signals + grounded AI + "Plan Trade" button
2. Options Lab — Options trade recommendations using live option chains + AI
3. Verify Pick — 3-layer verification with confidence anchoring + "Plan This Trade" button
4. Market Pulse — Institutional flow tracker: FII/DII, OI heatmap, volume anomalies, sector heatmap, AI synthesis
5. Trade Planner (overlay) — Position sizing, entry/exit strategy, risk assessment, scenarios

What needs building: Smart Screener (5th Insights tab)

The Smart Screener lets the user filter and discover stocks from the 165+ stock universe using FINR's live computed data — signals, technicals, price action, sector, cap size, and F&O eligibility. No other free tool combines live RSI/EMA/MACD + FINR signal scores + option chain sentiment in a single screener for Indian markets.

Smart Screener concept:
* Backend: `/api/screener` endpoint that accepts filter criteria and returns matching stocks from in-memory data (NO AI call needed — this is pure computed data, fast response)
* Filters should include: signal score range, RSI zone (oversold/neutral/overbought), EMA alignment (bullish/bearish/any), MACD direction, sector, cap size (Large/Mid/Small), F&O eligible only, min/max changePct, near support, near 52W low/high
* Pre-built filter presets: "Oversold Quality" (RSI<35, score>55, above 200EMA), "Momentum Breakouts" (price above all EMAs, MACD bullish, score>60), "Value Dips" (near 52W low, score>40), "F&O High IV" (F&O eligible, IV data available), "Strong Buys" (score>75)
* Results: sorted by signal score desc, showing: symbol, name, sector, price, changePct, signal label, score, RSI, tech bias
* Each result row is tappable → opens Trade Planner overlay via `openTradePlan(symbol)`
* Frontend: filter pill buttons for presets + expandable custom filter panel + results list
* Market hours gating: if market closed and no signalCache data, show market closed message; if cache exists, show cached data with "last updated" timestamp
* If no stocks match filters, show "No stocks match — try adjusting filters"
* DO NOT use any AI calls for the screener — it should be instant (pure server-side filtering)
* DO NOT use mock/static data. All data comes from `liveStocks`, `signalCache`, `fundamentals`, `priceHistory`, `optionChainCache`, `STOCK_UNIVERSE`

UI design rules (match existing FINR UI exactly):
* Dark theme: bg `#0e0e0e`, cards `#1c1c1e`, darker cards `#242426`, borders `#353534`
* Gold accent: `#ffd60a`, gold bg `#ffd60a/10`, gold border `#ffd60a/30`
* Text: white `#e5e2e1`, secondary `#d0c6ab`, muted `#636366`
* Green (positive): `#47e266`, Red (negative): `#ffb4ab`, Orange (warning): `#ff9f0a`, Blue (info): `#64d2ff`
* Font: `font-headline` for headings, `font-mono` for data/numbers, `tnum` for tabular numbers
* `fmt()` function exists for Indian number formatting (uses commas: 1,23,456)
* Material Icons: `<span class="material-symbols-outlined">icon_name</span>`
* Pill buttons: `text-[10px] px-3 py-1 rounded-full font-bold` (active: gold bg + border, inactive: transparent)
* Cards: `bg-[#1c1c1e] rounded-xl p-4`
* Signal score colors: ≥65 green, ≥40 yellow, <40 red
* Loading state: spinning border animation `<div class="inline-block w-5 h-5 border-2 border-[#ffd60a] border-t-transparent rounded-full animate-spin"></div>`
* Market closed state: centered card with `schedule` icon, "Market Closed" title, timing info

Critical rules:
* I am a stock market expert — give world-class solutions
* You are the best stock market expert and master solution architect — design and build accordingly
* NO static/mock/outdated data anywhere — all real-time from computed state
* All features gated to Indian market hours (9:15 AM – 3:30 PM IST, Mon-Fri) — but screener can show cached signal data with last-updated time outside hours
* If real-time data not fetched, show last-updated time with cached data, or "Error fetching data" — NEVER mock
* Clean, efficient code — no dead code, no unused variables
* Read the existing code thoroughly before building — understand the patterns used in completed tabs
* The screener backend should be FAST (no AI calls) — pure in-memory filtering and sorting

Start by: Reading server.js and index.html completely, understanding all existing patterns (especially how Market Pulse and AI Picks work for reference), then build the complete Smart Screener — backend endpoint + frontend tab (5th pill + content div + JavaScript). Wire up the tab in `switchInsightTab` and the `activeMap`. Make each screener result tappable to open Trade Planner. After building, give the complete git commands for all updates.

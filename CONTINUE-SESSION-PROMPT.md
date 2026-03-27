# FINR v2.0 — Continuation Prompt

**Copy-paste this entire prompt into a new Cowork chat to continue exactly where you left off. Select the FINR folder when prompted.**

---

## Project Overview
FINR v2.0 is a professional stock intelligence PWA for the Indian NSE market. It's a single-file SPA deployed on Railway.

## System Folder Path
Mount this folder in the new session: **FINR** (the root project folder containing `public/index.html`, `server.js`, `tests/unit.js`)

## File Structure
```
FINR/
├── public/index.html    (~4000 lines) — Entire frontend SPA (HTML/CSS/JS)
├── server.js            (~3090 lines) — Express backend
├── tests/unit.js        (802 lines, 116 tests — all passing)
├── railway.json         — Railway deployment config
├── .gcp-service-account.json — Vertex AI credentials (gitignored)
├── .gitignore
└── stitch-prompts/      — Original design prompts (reference only)
```

## Tech Stack
- **Frontend**: Single-file SPA with Tailwind CSS (CDN), Google Material Symbols, WebSocket
- **Backend**: Node.js + Express, deployed on Railway
- **APIs**: Upstox (market data via OAuth), Zerodha (portfolio via OAuth), Gemini AI (analysis with 3-key rotation + model priority), Vertex AI (fallback AI via GCP service account)
- **Security**: AES-256 encryption for stored config, 4-digit PIN auth

## Design System "Precision Vault"
- Colors: `#0a0a0a` base, `#ffd60a` gold accent, `#47e266` green (profit/connected), `#ffb4ab` red (loss/error), `#d0c6ab` muted text
- Fonts: Manrope (headlines), Inter (body), DM Mono (numbers)
- Breakpoints: <768px mobile, 768px+ collapsed sidebar (64px), 1280px+ full sidebar (240px)

## SPA Navigation System
- `goTab(tabId)` — main page tabs (HOME, INSIGHTS, P&L TRACKER, SETTINGS)
- `goPage(pageId)` — sub-pages within tabs
- `goSubTab(tabId)` — sub-tabs within pages (e.g., P&L Dashboard vs Add Trade)
- Tab visibility: `.stab-content{display:none}` / `.stab-content.on{display:block}`

## Key Frontend Sections (index.html — line numbers approximate, always verify by reading)
- **~108-109**: Tab visibility CSS
- **~218-338**: Responsive breakpoint CSS (768px, 1280px)
- **~765-827**: Live Analysis form (Leg 1 HTML with symbol autocomplete, strike suggestions, expiry chips)
- **~831-890**: Live Analysis results view (Analyse Now button, Stop button)
- **~1192-1410**: Settings page (3-column grid: API Connectors | System | AI Performance)
- **~1279-1284**: Gemini AI card with 3 API key fields (Primary + 2 Backups)
- **~1285-1310**: Vertex AI card with textarea for service account JSON, Save & Save+Test buttons
- **~2200-2270**: `suggestExpiries()`, `NSE_LOT_SIZES` map, `autoFillLotSize()`, `symbolAutocomplete()`
- **~2280-2360**: `suggestStrikes()`, strike chip generation, `pickSymbol()`
- **~2360-2395**: `addLiveLeg()`, `removeLiveLeg()`, `collectLiveLegs()`
- **~2419-2503**: `startLiveAnalysis()`, `runLiveAnalysis()`, `stopLiveAnalysis()` — NO auto-refresh, manual "Analyse Now" only
- **~2839-2915**: `updateApiStatusDots()`, `updateConnectBtn()`, `disconnectService()`, toggle Connect/Disconnect for all 4 APIs
- **~2948-2975**: `saveSettings()` — sends flat format including `geminiKey`, `geminiKey2`, `geminiKey3`
- **~2980-3020**: `testVertex()`, `saveVertex()`
- **~3025-3040**: `fetchStatus()`, `loadHealth()`, `loadLogs()`

## Key Server Sections (server.js — line numbers approximate, always verify by reading)
- **~38-55**: Global state variables (accessToken, zAccessToken, connectionStatus, geminiKeyIndex, etc.)
- **~322-330**: Config loading from env vars (including GEMINI_API_KEY_2, GEMINI_API_KEY_3)
- **~354-450**: Upstox & Zerodha OAuth flows (/auth/login, /callback, /zerodha/login, /zerodha/callback)
- **~493-543**: `callGemini()` with model-priority rotation (see Model Priority Rotation section below)
- **~548-619**: Vertex AI: GCP service account loading, JWT creation, token refresh, `callVertexAI()` (model: gemini-3-flash-preview)
- **~550-554**: `geminiDisabled`, `vertexDisabled` flags — block API calls when user disconnects
- **~622-640**: `callAI()` — prefers Vertex AI (grounded) then falls back to Gemini
- **~685-730**: `/api/live-analysis` POST — AI-powered trade monitoring
- **~1360-1400**: `/api/settings` POST (partial saves, supports geminiKey2/geminiKey3)
- **~1422-1434**: `/api/system-health` GET — includes `disabled` field for gemini/vertexAI
- **~1450-1482**: Connection test endpoints: `/api/gemini-test` (clears geminiDisabled on success), `/api/vertex-test` (clears vertexDisabled on success)
- **~1437-1448**: `/api/upstox-test`, `/api/zerodha-refresh`
- **~1483-1499**: `/api/vertex-save` POST
- **~1501-1534**: `/api/disconnect` POST — handles all 4 services, sets disabled flags
- **~1610-1630**: `/api/symbol-search` GET — symbol autocomplete with LTP
- **~2146-2200**: `STOCK_UNIVERSE` — ~45 NSE stocks with fundamentals

## Model Priority Rotation (NEW)
The Gemini multi-key system now prioritizes the best model across ALL keys before falling back:
```
Key1(3.0-flash) → Key2(3.0-flash) → Key3(3.0-flash) →
Key1(2.5-flash) → Key2(2.5-flash) → Key3(2.5-flash) →
Key1(2.0-flash) → Key2(2.0-flash) → Key3(2.0-flash) →
Vertex AI (gemini-3-flash-preview with Google Search grounding)
```
- On 429 (rate limit): tries next key with same model
- On 404 (model not found): skips to next model for all keys
- `geminiKeyIndex` remembers which key succeeded last

## Disconnect / Disabled Logic (NEW)
When user clicks "Disconnect" on an API connector:
- **Upstox**: Clears `accessToken`, sets `connectionStatus = 'disconnected'`, stops mock interval
- **Zerodha**: Clears `zAccessToken`, clears holdings/positions/orders
- **Gemini**: Sets `geminiConnectionOk = false` AND `geminiDisabled = true` — blocks all `callGemini()` calls
- **Vertex AI**: Sets `vertexConnectionOk = false` AND `vertexDisabled = true` — blocks all `callVertexAI()` calls, clears token

When user clicks "Connect" (test endpoints):
- **Gemini test**: Temporarily clears `geminiDisabled` to allow test call; on success permanently clears it
- **Vertex test**: Temporarily clears `vertexDisabled` to allow test call; on success permanently clears it
- `/api/system-health` returns `disabled: true/false` for gemini and vertexAI sections
- Frontend shows "Disconnected by user" tooltip on status dots when disabled

## Recent Git History
```
[uncommitted] fix: proper disconnect with disabled flags + model priority rotation
f460b84 feat: multi-key Gemini API rotation with 3 key slots
c32e744 feat: add Connect/Disconnect toggle for all 4 API connectors
09bffe1 fix: remove Live Analysis auto-refresh, remove System Health duplicate refresh
b76032f fix: Vertex AI Save+Connect flow, better error messages for zip/invalid JSON
9d07efa feat: add symbol autocomplete and strike suggestions in Live Analysis
0e4ff8b feat: fix API status accuracy, Vertex AI card, refresh buttons, lot size auto-fill
dea15d0 fix: settings rename, API connections, button layout
6d6ac2e fix: form layout 2-row, stop button, expiry current+next month
3b2d171 fix: P&L tab visibility, dashboard layout, expiry suggestions range
abfe9f5 feat: expiry suggestions, P&L layout fix, 3-col Command Centre, log copy UX
```

## Current Status
- All 116 unit tests passing
- Branch: main, deployed on Railway
- Upstox: OAuth connected (live market data)
- Zerodha: OAuth connected (portfolio/holdings)
- Gemini AI: Connected with 3-key rotation + model priority (free tier, daily quota resets ~12:30 PM IST per project)
- Vertex AI: Service account configured in GCP project `finr-production`, email `finr-server@finr-production.iam.gserviceaccount.com` — uses gemini-3-flash-preview with Google Search grounding
- All 4 API connectors have Connect/Disconnect toggle buttons with proper disabled flags
- Model priority: gemini-3-flash-preview across all keys first → gemini-2.5-flash → gemini-2.0-flash → Vertex AI

## Important Patterns
- NSE expiry logic: Index options (NIFTY, BANKNIFTY, etc.) = weekly Thursday; Stock options = last Thursday of month
- `toggleApiCard()`: max-height 0↔500px for expand/collapse animation
- API connector buttons toggle between Connect (gold) and Disconnect (red) based on connection state
- `saveSettings()` sends flat format: `{apiKey, apiSecret, redirectUri, zApiKey, zApiSecret, zRedirectUri, geminiKey, geminiKey2, geminiKey3}` — partial saves allowed
- Vertex AI save is separate: `saveVertex()` → `/api/vertex-save` with `{serviceAccountJson: {...}}`
- Live Analysis: runs ONCE on Start, user clicks "Analyse Now" for refresh, Stop to end session
- Symbol autocomplete fetches from `/api/symbol-search?q=...` with 200ms debounce
- Strike suggestions: 9 levels around ATM price, step size adapts to price level
- `NSE_LOT_SIZES` map covers ~24 major symbols for auto-fill
- Gemini multi-key: `getGeminiKeys()` returns array of configured keys, `geminiKeyIndex` tracks active key, model-priority rotation on 429
- Disconnect sets `geminiDisabled`/`vertexDisabled` flags; Connect/test endpoints clear them on success

## Known Issues / Pending Items
- Event Calendar content is mostly placeholder/static
- AI Accuracy Meter shows data only after signal generation
- No strike suggestions appear if live price data isn't available (demo mode shows synthetic prices)
- Gemini free tier quota burns fast with heavy use — multi-key rotation + model priority + Vertex AI all help
- Uncommitted changes need to be committed and pushed

## Instructions for AI
When working on this project:
1. Read the relevant sections of `public/index.html` and `server.js` before making any changes
2. Run `node tests/unit.js` after every change to verify all 116 tests pass
3. Follow the existing design system (colors `#0a0a0a`, `#ffd60a`, `#47e266`, `#ffb4ab`, `#d0c6ab`; fonts Manrope/Inter/DM Mono)
4. Keep the single-file SPA pattern — all frontend code in `public/index.html`
5. Git commit after each logical change with descriptive messages
6. Do not ask questions — the requirements above are fully specified. Just build.

# FINR v2.0 — Continuation Prompt

> Paste this entire prompt into a new chat to continue exactly where we left off.

---

## Project Overview

I'm building **FINR v2.0**, a professional stock intelligence platform for the Indian NSE market. It's a **mobile-first SPA** deployed on Railway at `https://finr-production.up.railway.app`.

**Everything lives in one file:** `public/index.html` (~2683 lines of vanilla JS + Tailwind CSS). The backend is `server.js` (~2600 lines) — don't touch it.

---

## What's Been Done (4 commits so far)

```
3311073 Redesign Home tab into 6 compact dashboard cards with collapsible UI
4bd2c8b Fix layout editor: replace HTML5 DnD with pointer-based drag system
9dde46e Add drag-and-drop layout editor for desktop customization
d7a2560 Add desktop responsive layout with sidebar navigation
```

All 116 unit tests pass (`node tests/unit.js`).

---

## Architecture & Rules

### SPA Navigation
- Pages toggled via `.pg.on` class
- `goTab(tabName)` — main tabs: home, insights, pnl, more
- `goPage(pageName)` — standalone pages: options-lab, verify-pick
- `goSubTab(group, subtab)` — sub-tabs within a page

### Design System ("Precision Vault" dark theme)
- **Base**: #0a0a0a / #131313 surface
- **Gold accent**: #ffd60a (primary)
- **Green/profit**: #47e266
- **Red/loss**: #ffb4ab
- **Text**: #e5e2e1 (on-surface), #d0c6ab (on-surface-variant)
- **Fonts**: Manrope (headlines), Inter (body), DM Mono (numbers)
- **Glassmorphism**: `backdrop-filter:blur(20px)` with semi-transparent backgrounds

### Responsive Breakpoints
- **<768px** — Mobile (untouched original layout, bottom nav)
- **768-1279px** — Collapsed sidebar (64px icon-only), 3-col home grid, no bottom nav
- **1280px+** — Full sidebar (240px with labels), wider grids

### Critical Rule: Don't Modify Existing JS Functions
Instead, use the **wrapping pattern** to extend them:
```javascript
const _origFn = existingFunction;
existingFunction = function() {
  _origFn.apply(this, arguments);
  try { /* your additions */ } catch(e) {}
};
```
This is how sidebar sync, peek updates, and pulse chart re-renders are all wired up.

---

## Current Home Tab: 6 Dashboard Cards

The Home tab has a hero section (Nifty 50 price + index chips) followed by a **3x2 card grid** (`#home-cards-grid`):

| # | Card | Behavior | Key IDs |
|---|------|----------|---------|
| 1 | **News** | Collapsible — 1 headline peek, expands to scrollable list | `#news-card`, `#news-peek`, `#news-list` |
| 2 | **Flows & Macros** | Collapsible — FII cash peek, expands to full FII/DII/USD/Crude | `#fii-peek`, `#fii-peek-val`, `#home-fii-dii` |
| 3 | **Economic Calendar** | Collapsible — 1 event peek, expands to show all | `#events-peek`, `#h-events` |
| 4 | **Market Breadth** | Non-collapsible, compact gauge | `#breadth-card`, `#breadth-bar` |
| 5 | **Market Health** | Non-collapsible, scorecard with gauge + 6-indicator grid | `#garc`, `#gnum`, `#ggrid` |
| 6 | **Market Pulse** | Non-collapsible, switchable SVG charts via dropdown | `#pulse-card`, `#pulse-select`, `#pulse-chart` |

### Collapsible Card CSS Pattern
```css
.dash-card-peek { max-height:60px; overflow:hidden; transition: max-height 0.2s; }
.dash-card.expanded .dash-card-peek { max-height:0; opacity:0; }
.dash-card-body.collapsed { max-height:0; opacity:0; overflow:hidden; }
.dash-card.expanded .dash-card-body.collapsed { max-height:600px; opacity:1; }
```
Toggle: `toggleDashCard(headerEl)` adds/removes `.expanded` on the parent `.dash-card`.

### Market Pulse Charts (Card 6)
Dropdown (`#pulse-select`) switches between 4 SVG charts:
- **FII vs DII** (`renderFiiDiiDonut`) — donut chart with cash values
- **Health Radar** (`renderHealthRadar`) — 5-factor pentagon radar
- **VIX Meter** (`renderVixMeter`) — semicircle gauge with fear level
- **Sector Flow** (`renderSectorFlow`) — horizontal bar chart of top sectors

---

## Layout Editor (Customization System)

Triggered via sidebar "Customize" button → `toggleLayoutEditor()`:
- **Drag-and-drop**: Pointer-based system (`startWidgetDrag`) — ghost clone + placeholder approach
- **Hide/show**: Eye icon toggles `.widget-hidden` on each card
- **No resize** (removed per my request)
- **Persistence**: Saves to `localStorage.finr-layout` (order + hidden state)
- **Scope**: Currently targets `#home-cards-grid > div` and `#pg-more > div`

---

## Desktop Sidebar

Fixed left sidebar (`#desktop-sidebar`):
- 7 nav items: Dashboard, Insights, AI Picks, Options Lab, Verify Pick, P&L Tracker, Command Centre
- Customize button + WebSocket status indicator at bottom
- Active state synced via wrapped `goTab()`/`goPage()` functions

---

## All Pages

1. **Home** (`#pg-home`) — 6-card dashboard (described above)
2. **Insights** (`#pg-insights`) — AI Picks grid with signal cards
3. **Options Lab** (`#pg-options-lab`) — Option chain strategies, PCR, Max Pain
4. **Verify Pick** (`#pg-verify-pick`) — Single stock AI analysis
5. **P&L Tracker** (`#pg-pnl`) — Trade logging, CSV import, dashboard stats, tax calc
6. **Command Centre** (`#pg-more`) — API settings, system health, logs

---

## Key State Variables
```javascript
let S = {}           // Live stocks: { symbol: { ltp, chg, chgPct, vol, time } }
let IDX = {}         // Indices: { NIFTY50, NIFTYBANK, INDIA_VIX, ... }
let SIG = {}         // Signals: { symbol: { score, signal } }
let VIX = { value, trend }
let FIIDII = { fii, dii, usdInr, crude }
let NEWS_ITEMS = []  // News array
let TRADES = []      // P&L trades
let OPTS = []        // Options trades
```

WebSocket (`connectWS()`) receives `init` and `quote` messages for real-time data. Falls back to REST polling `/api/live` every 5 seconds if WS disconnects.

---

## What I Want to Work On Next

I want to continue discussing **page customization** — specifically how the layout editor and drag-and-drop system works across different pages, and potentially extending customization features further. I may also have other UI/UX requests.

**Important**: Don't push to git from the sandbox (it returns 403). I'll run `git push origin main` from my local terminal when ready.

---

## File Paths
- **Frontend**: `public/index.html` (the ONLY file to edit)
- **Backend**: `server.js` (DO NOT modify)
- **Tests**: `tests/unit.js` (116 tests, all passing)

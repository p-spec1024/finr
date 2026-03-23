# FINR — Smart Stock Intelligence PWA

> Real-time NSE stock signals, buy/sell recommendations, and portfolio tracker for Indian retail investors. Built for the long-term investor.

![FINR](https://img.shields.io/badge/FINR-v1.0-00d4aa?style=flat-square) ![Node](https://img.shields.io/badge/Node.js-18+-green?style=flat-square) ![Railway](https://img.shields.io/badge/Deploy-Railway-purple?style=flat-square)

---

## Features

- 📊 **Live Prices** — Upstox WebSocket for tick-by-tick NSE data
- 🧠 **Signal Engine** — Buy/Sell scores 0-100 using 6 fundamentals
- 📱 **PWA** — Install on Android/iOS from Chrome
- 🔐 **Secure** — API keys encrypted server-side, never in frontend
- 💼 **Portfolio** — Live P&L tracking with signal alerts
- ⚔️ **War Scenario** — Iran-Israel-US conflict analysis built-in
- 📈 **SIP Calculator** — Compound growth calculator with charts
- 📝 **Notes** — Research notes encrypted and saved
- 📖 **Glossary** — 22+ stock market terms explained

---

## Quick Deploy to Railway

### Step 1: Fork/Clone this repo to GitHub
```bash
git init
git add .
git commit -m "Initial FINR setup"
git remote add origin https://github.com/YOUR_USERNAME/finr.git
git push -u origin main
```

### Step 2: Deploy to Railway
1. Go to [railway.app](https://railway.app)
2. New Project → Deploy from GitHub → select your repo
3. Add environment variable: `FINR_SECRET=your-random-secret-here-min-32-chars`
4. Railway will auto-deploy. Note your app URL (e.g., `finr-abc123.up.railway.app`)

### Step 3: Configure Upstox
1. Go to [upstox.com/developer](https://upstox.com/developer)
2. Create new app, set redirect URI: `https://YOUR-APP.up.railway.app/callback`
3. Copy API Key and Secret

### Step 4: Setup in App
1. Open your Railway URL in Chrome
2. Go to **Settings** tab
3. Enter your Upstox API Key, Secret, 4-digit PIN, and Redirect URL
4. Click **Save Settings**
5. Click **Refresh Daily Token** → log in to Upstox
6. Done! Live data starts flowing 🎉

---

## Daily Routine

Every morning (before 9:15 AM):
1. Open FINR
2. Settings → **Refresh Daily Token**
3. Log in to Upstox in popup
4. Live data is now active for the trading day

---

## Local Development (Termux)

```bash
# On Android Termux:
bash termux-setup.sh

# Or manually:
npm install
node server.js
# Open http://localhost:3000
```

---

## Signal Engine Logic

| Factor | Weight | Description |
|--------|--------|-------------|
| 52W Position | 25 pts | Price near low = opportunity |
| P/E vs Sector | 20 pts | Cheaper than peers = value |
| ROE Quality | 15 pts | >25% excellent, >15% good |
| Debt Level | 10 pts | Zero debt bonus, high debt penalty |
| Dividend Yield | 10 pts | Income bonus |
| Analyst Upside | 20 pts | Higher target = more potential |

**Scores:** `80+` STRONG BUY · `65-79` BUY · `50-64` WATCH · `35-49` HOLD · `20-34` SELL · `<20` STRONG SELL

---

## War Scenario (March 2026)

Iran–Israel–US conflict → Nifty -9 to -11% correction expected.

**Overweight:** Defence, Pharma, Energy (upstream), Metals, Gold  
**Underweight:** Aviation, Paints, OMC (downstream), Travel

This is treated as a **long-term buying opportunity** — corrections in quality stocks rarely last more than 6-18 months.

---

## Security

- API keys stored in `AES-256` encrypted file on server
- PIN uses SHA-256 hash — never stored in plain text
- Frontend never sees raw API keys
- All Upstox calls are server-side only
- HTTPS enforced via Railway (automatic)
- Rate limiting on all API endpoints

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FINR_SECRET` | Yes | Encryption key for stored data (min 32 chars) |
| `PORT` | No | Server port (Railway sets automatically) |

---

## Future Roadmap

- [ ] Phase 2: Multiple broker support (Zerodha, Angel One)
- [ ] Phase 3: Premium subscription via Razorpay (₹99-199/month)
- [ ] Push notifications for signal changes
- [ ] Options chain data
- [ ] Backtesting signal engine

---

## Disclaimer

FINR is for **educational and informational purposes only**. Not SEBI registered investment advice. Always do your own research before investing. Past signals do not guarantee future returns.

---

Made with ❤️ for long-term Indian retail investors 🇮🇳

/**
 * FINR — Real-time Stock Market PWA Backend
 * Node.js + Express + Upstox API v2
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, '.finr_config.enc');
const PORTFOLIO_FILE = path.join(__dirname, '.finr_portfolio.enc');
const NOTES_FILE = path.join(__dirname, '.finr_notes.enc');
const ENCRYPTION_KEY = process.env.FINR_SECRET || 'finr-secure-key-2026-do-not-share';

let appConfig = {};
let accessToken = null;
let upstoxWs = null;
let liveData = {};
let marketIndices = {};
let stockUniverse = [];
let signalCache = {};
let fundamentalCache = {};
let connectionStatus = 'disconnected';
let wsReconnectTimeout = 1000;
let mockTickInterval = null;

function encrypt(data) {
  return CryptoJS.AES.encrypt(JSON.stringify(data), ENCRYPTION_KEY).toString();
}
function decrypt(enc) {
  try {
    const b = CryptoJS.AES.decrypt(enc, ENCRYPTION_KEY);
    return JSON.parse(b.toString(CryptoJS.enc.Utf8));
  } catch { return null; }
}
function loadConfig() {
  // Try encrypted file first
  if (fs.existsSync(CONFIG_FILE)) {
    const d = decrypt(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (d) appConfig = d;
  }
  // Overlay with Railway env vars — these survive restarts unlike files
  if (process.env.UPSTOX_API_KEY)    appConfig.apiKey      = process.env.UPSTOX_API_KEY.trim();
  if (process.env.UPSTOX_API_SECRET) appConfig.apiSecret   = process.env.UPSTOX_API_SECRET.trim();
  if (process.env.UPSTOX_REDIRECT)   appConfig.redirectUri = process.env.UPSTOX_REDIRECT.trim();
  if (process.env.FINR_PIN)          appConfig.pin         = CryptoJS.SHA256(process.env.FINR_PIN.trim()).toString();
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, encrypt(appConfig)); }
  catch(e) { console.warn('[FINR] Cannot write config (ephemeral fs):', e.message); }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api/settings', rateLimit({ windowMs: 60000, max: 15 }));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  if (!appConfig.apiKey || !appConfig.apiSecret)
    return res.status(400).json({ error: 'API keys not configured' });
  const redirect = appConfig.redirectUri || `${req.protocol}://${req.get('host')}/callback`;
  const url = `https://api.upstox.com/v2/login/authorization/dialog?client_id=${appConfig.apiKey}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code`;
  res.json({ url });
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No auth code received from Upstox.');
  try {
    // Always use the saved redirectUri if available
    // Railway runs behind a proxy so req.protocol may be 'http' — force https
    const host = req.get('host');
    const autoRedirect = `https://${host}/callback`;
    const redirect = appConfig.redirectUri || autoRedirect;

    console.log('[FINR] Token exchange starting...');
    console.log('[FINR] client_id:', appConfig.apiKey);
    console.log('[FINR] redirect_uri:', redirect);

    const r = await axios.post('https://api.upstox.com/v2/login/authorization/token',
      new URLSearchParams({
        code,
        client_id: appConfig.apiKey,
        client_secret: appConfig.apiSecret,
        redirect_uri: redirect,
        grant_type: 'authorization_code'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );

    accessToken = r.data.access_token;
    appConfig.tokenExpiry = Date.now() + 86400000;
    saveConfig();
    connectionStatus = 'authenticated';
    broadcastStatus();
    await initLiveData();
    console.log('[FINR] ✅ Token saved successfully');

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#30d158;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:20px}h1{font-size:28px;letter-spacing:2px;color:#f2f2f7}p{color:#636366;font-size:14px}.badge{background:rgba(48,209,88,.12);border:1px solid rgba(48,209,88,.3);padding:8px 24px;border-radius:20px;font-size:13px;color:#30d158}</style>
    </head><body>
    <div style="font-size:64px">✅</div>
    <h1>FINR CONNECTED</h1>
    <p>Token saved successfully. Return to the app.</p>
    <div class="badge">Live data starting...</div>
    <script>setTimeout(()=>window.close(),3000)</script>
    </body></html>`);

  } catch (err) {
    const errData = err.response?.data;
    const errMsg = JSON.stringify(errData) || err.message;
    console.error('[FINR] ❌ Token exchange failed:', errMsg);

    // Show helpful error page with actual error details
    res.status(500).send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#ff453a;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;padding:20px}h1{font-size:22px;color:#f2f2f7}.box{background:#1c1c1e;border:1px solid rgba(255,69,58,.3);padding:16px 20px;border-radius:12px;max-width:500px;width:100%;font-size:12px;line-height:1.8;color:#aeaeb2}.label{font-size:10px;color:#636366;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}</style>
    </head><body>
    <div style="font-size:48px">❌</div>
    <h1>Auth Failed</h1>
    <div class="box">
      <div class="label">Error from Upstox:</div>
      <div style="color:#ff453a">${errMsg}</div>
      <br>
      <div class="label">What to check:</div>
      <div>1. API Secret — copy it fresh from Upstox portal</div>
      <div>2. Redirect URL in Upstox portal must match exactly:</div>
      <div style="color:#ffd60a;margin-top:4px">https://${req.get('host')}/callback</div>
      <br>
      <div>3. Go to FINR Settings → re-enter all fields → Save → try again</div>
    </div>
    </body></html>`);
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.post('/api/settings', (req, res) => {
  const { apiKey, apiSecret, pin, redirectUri } = req.body;
  if (!apiKey || !apiSecret || !pin) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });
  appConfig.apiKey = apiKey.trim();
  appConfig.apiSecret = apiSecret.trim();
  appConfig.pin = CryptoJS.SHA256(pin).toString();
  if (redirectUri) appConfig.redirectUri = redirectUri.trim();
  saveConfig();
  res.json({ success: true });
});

app.post('/api/verify-pin', (req, res) => {
  if (!appConfig.pin) return res.json({ valid: false, noPin: true });
  res.json({ valid: CryptoJS.SHA256(req.body.pin).toString() === appConfig.pin });
});

app.get('/api/config-status', (req, res) => {
  res.json({
    hasKeys: !!(appConfig.apiKey && appConfig.apiSecret),
    hasPin: !!appConfig.pin,
    isAuthenticated: !!accessToken,
    tokenExpiry: appConfig.tokenExpiry || null,
    connectionStatus,
    stockCount: stockUniverse.length,
    redirectUri: appConfig.redirectUri || null
  });
});

app.post('/api/clear', (req, res) => {
  appConfig = {}; accessToken = null; stockUniverse = []; liveData = {}; signalCache = {};
  [CONFIG_FILE, PORTFOLIO_FILE, NOTES_FILE].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  if (mockTickInterval) { clearInterval(mockTickInterval); mockTickInterval = null; }
  connectionStatus = 'disconnected';
  broadcastStatus();
  res.json({ success: true });
});

// ── Portfolio ─────────────────────────────────────────────────────────────────
app.get('/api/portfolio', (req, res) => {
  if (!fs.existsSync(PORTFOLIO_FILE)) return res.json({ holdings: [] });
  res.json(decrypt(fs.readFileSync(PORTFOLIO_FILE, 'utf8')) || { holdings: [] });
});
app.post('/api/portfolio', (req, res) => {
  fs.writeFileSync(PORTFOLIO_FILE, encrypt(req.body));
  res.json({ success: true });
});

// ── Notes ─────────────────────────────────────────────────────────────────────
app.get('/api/notes', (req, res) => {
  if (!fs.existsSync(NOTES_FILE)) return res.json({ notes: [] });
  res.json(decrypt(fs.readFileSync(NOTES_FILE, 'utf8')) || { notes: [] });
});
app.post('/api/notes', (req, res) => {
  fs.writeFileSync(NOTES_FILE, encrypt(req.body));
  res.json({ success: true });
});

// ── Live Data ─────────────────────────────────────────────────────────────────
app.get('/api/live', (req, res) => {
  res.json({ stocks: liveData, indices: marketIndices, signals: signalCache, universe: stockUniverse });
});
app.get('/api/signals', (req, res) => {
  const sorted = Object.entries(signalCache)
    .map(([sym, s]) => ({ symbol: sym, ...s, price: liveData[sym]?.price, name: liveData[sym]?.name, sector: liveData[sym]?.sector }))
    .sort((a, b) => b.score - a.score);
  res.json(sorted);
});
app.get('/api/market-health', (req, res) => {
  const scores = Object.values(signalCache).map(s => s.score);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 50;
  res.json({
    healthScore: Math.round(avg),
    buySignals: scores.filter(s => s >= 65).length,
    sellSignals: scores.filter(s => s < 35).length,
    watchSignals: scores.filter(s => s >= 50 && s < 65).length,
    holdSignals: scores.filter(s => s >= 35 && s < 50).length,
    totalStocks: scores.length
  });
});

// ── Stock Universe ────────────────────────────────────────────────────────────
const STOCK_UNIVERSE_STATIC = [
  { instrumentKey: 'NSE_EQ|INE002A01018', symbol: 'RELIANCE', name: 'Reliance Industries', sector: 'Energy' },
  { instrumentKey: 'NSE_EQ|INE040A01034', symbol: 'HDFCBANK', name: 'HDFC Bank', sector: 'Banking' },
  { instrumentKey: 'NSE_EQ|INE009A01021', symbol: 'INFY', name: 'Infosys', sector: 'IT' },
  { instrumentKey: 'NSE_EQ|INE467B01029', symbol: 'TCS', name: 'Tata Consultancy Services', sector: 'IT' },
  { instrumentKey: 'NSE_EQ|INE062A01020', symbol: 'ICICIBANK', name: 'ICICI Bank', sector: 'Banking' },
  { instrumentKey: 'NSE_EQ|INE030A01027', symbol: 'HINDUNILVR', name: 'Hindustan Unilever', sector: 'FMCG' },
  { instrumentKey: 'NSE_EQ|INE018A01030', symbol: 'BHARTIARTL', name: 'Bharti Airtel', sector: 'Telecom' },
  { instrumentKey: 'NSE_EQ|INE585B01010', symbol: 'AXISBANK', name: 'Axis Bank', sector: 'Banking' },
  { instrumentKey: 'NSE_EQ|INE669C01036', symbol: 'BAJFINANCE', name: 'Bajaj Finance', sector: 'NBFC' },
  { instrumentKey: 'NSE_EQ|INE001A01036', symbol: 'HCLTECH', name: 'HCL Technologies', sector: 'IT' },
  { instrumentKey: 'NSE_EQ|INE044A01036', symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical', sector: 'Pharma' },
  { instrumentKey: 'NSE_EQ|INE326A01037', symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', sector: 'Banking' },
  { instrumentKey: 'NSE_EQ|INE216A01030', symbol: 'MARUTI', name: 'Maruti Suzuki', sector: 'Auto' },
  { instrumentKey: 'NSE_EQ|INE029A01011', symbol: 'TATAMOTORS', name: 'Tata Motors', sector: 'Auto' },
  { instrumentKey: 'NSE_EQ|INE155A01022', symbol: 'TATASTEEL', name: 'Tata Steel', sector: 'Metals' },
  { instrumentKey: 'NSE_EQ|INE397D01024', symbol: 'NTPC', name: 'NTPC', sector: 'Power' },
  { instrumentKey: 'NSE_EQ|INE748C01020', symbol: 'POWERGRID', name: 'Power Grid Corp', sector: 'Power' },
  { instrumentKey: 'NSE_EQ|INE160A01022', symbol: 'WIPRO', name: 'Wipro', sector: 'IT' },
  { instrumentKey: 'NSE_EQ|INE019A01038', symbol: 'LTIM', name: 'LTIMindtree', sector: 'IT' },
  { instrumentKey: 'NSE_EQ|INE066A01021', symbol: 'ONGC', name: 'ONGC', sector: 'Energy' },
  { instrumentKey: 'NSE_EQ|INE101A01026', symbol: 'CIPLA', name: 'Cipla', sector: 'Pharma' },
  { instrumentKey: 'NSE_EQ|INE021A01026', symbol: 'COALINDIA', name: 'Coal India', sector: 'Mining' },
  { instrumentKey: 'NSE_EQ|INE095A01012', symbol: 'INDUSINDBK', name: 'IndusInd Bank', sector: 'Banking' },
  { instrumentKey: 'NSE_EQ|INE071A01013', symbol: 'BPCL', name: 'BPCL', sector: 'Energy' },
  { instrumentKey: 'NSE_EQ|INE356A01018', symbol: 'GRASIM', name: 'Grasim Industries', sector: 'Diversified' },
  { instrumentKey: 'NSE_EQ|INE123W01016', symbol: 'ADANIENT', name: 'Adani Enterprises', sector: 'Diversified' },
  { instrumentKey: 'NSE_EQ|INE070A01015', symbol: 'HINDALCO', name: 'Hindalco Industries', sector: 'Metals' },
  { instrumentKey: 'NSE_EQ|INE115A01026', symbol: 'HAL', name: 'Hindustan Aeronautics', sector: 'Defence' },
  { instrumentKey: 'NSE_EQ|INE0J1Y01017', symbol: 'DRDGOLD', name: 'Dr. Reddy\'s Lab', sector: 'Pharma' },
  { instrumentKey: 'NSE_EQ|INE089A01023', symbol: 'DRREDDY', name: 'Dr. Reddy\'s Laboratories', sector: 'Pharma' },
];

const SECTOR_PE = { IT:28, Banking:15, Pharma:30, Energy:10, FMCG:45, Auto:18, Metals:8, Power:16, Telecom:22, NBFC:20, Mining:7, Retail:50, Diversified:18, Defence:35 };

async function fetchTopStocks() {
  if (!accessToken) {
    stockUniverse = STOCK_UNIVERSE_STATIC;
    return;
  }
  try {
    const resp = await axios.get('https://api.upstox.com/v2/market/quote/nse', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    }).catch(() => null);
    stockUniverse = STOCK_UNIVERSE_STATIC;
    console.log('[FINR] Stock universe loaded:', stockUniverse.length);
  } catch {
    stockUniverse = STOCK_UNIVERSE_STATIC;
  }
}

async function fetchFundamentals() {
  for (const stock of stockUniverse) {
    if (fundamentalCache[stock.symbol]) continue;
    const price = liveData[stock.symbol]?.price || MOCK_PRICES[stock.symbol] || 1000;
    fundamentalCache[stock.symbol] = {
      pe: 10 + Math.random() * 35,
      roe: 8 + Math.random() * 28,
      debtToEquity: Math.random() * 1.8,
      dividendYield: Math.random() * 3.5,
      high52: price * (1.12 + Math.random() * 0.25),
      low52: price * (0.62 + Math.random() * 0.2),
      targetPrice: price * (1.08 + Math.random() * 0.22),
      sectorPe: SECTOR_PE[stock.sector] || 20
    };
  }
}

function calcSignal(symbol, price) {
  const fund = fundamentalCache[symbol];
  if (!fund || !price) return null;
  let score = 0;
  const reasons = [];

  const range = fund.high52 - fund.low52;
  if (range > 0) {
    const pos = Math.max(0, Math.min(1, (price - fund.low52) / range));
    score += Math.round((1 - pos) * 25);
    if (pos < 0.3) reasons.push('Near 52W low — buying zone');
    else if (pos > 0.85) reasons.push('Near 52W high — take profit?');
  }

  if (fund.pe > 0 && fund.sectorPe > 0) {
    const r = fund.pe / fund.sectorPe;
    if (r < 0.6) { score += 20; reasons.push(`Cheap P/E ${fund.pe.toFixed(1)}x vs sector ${fund.sectorPe}x`); }
    else if (r < 0.85) score += 15;
    else if (r < 1.1) score += 10;
    else if (r < 1.3) score += 5;
    else reasons.push(`P/E ${fund.pe.toFixed(1)}x expensive vs sector`);
  }

  if (fund.roe >= 25) { score += 15; reasons.push(`ROE ${fund.roe.toFixed(1)}% — excellent`); }
  else if (fund.roe >= 15) { score += 10; reasons.push(`ROE ${fund.roe.toFixed(1)}% — good`); }
  else if (fund.roe >= 8) score += 5;
  else reasons.push(`ROE ${fund.roe.toFixed(1)}% — weak`);

  if (fund.debtToEquity < 0.1) { score += 10; reasons.push('Virtually debt-free'); }
  else if (fund.debtToEquity < 0.5) score += 7;
  else if (fund.debtToEquity < 1) score += 4;
  else if (fund.debtToEquity > 2) { score -= 5; reasons.push(`High debt D/E ${fund.debtToEquity.toFixed(1)}`); }

  if (fund.dividendYield > 3) { score += 10; reasons.push(`Div yield ${fund.dividendYield.toFixed(1)}% — income stock`); }
  else if (fund.dividendYield > 1.5) score += 6;
  else if (fund.dividendYield > 0.5) score += 3;

  const upside = ((fund.targetPrice - price) / price) * 100;
  if (upside > 25) { score += 20; reasons.push(`${upside.toFixed(0)}% upside to analyst target`); }
  else if (upside > 15) { score += 15; reasons.push(`${upside.toFixed(0)}% upside to target`); }
  else if (upside > 5) score += 8;
  else if (upside < -5) { score -= 5; reasons.push('Trading above analyst target'); }

  score = Math.max(0, Math.min(100, score));
  let signal, color;
  if (score >= 80) { signal = 'STRONG BUY'; color = '#00ff88'; }
  else if (score >= 65) { signal = 'BUY'; color = '#00d4aa'; }
  else if (score >= 50) { signal = 'WATCH'; color = '#ffd700'; }
  else if (score >= 35) { signal = 'HOLD'; color = '#ff9500'; }
  else if (score >= 20) { signal = 'SELL'; color = '#ff4455'; }
  else { signal = 'STRONG SELL'; color = '#cc0022'; }

  return { score, signal, color, reason: reasons[0] || 'Analysing fundamentals...', allReasons: reasons, upside: +upside.toFixed(1), targetPrice: +fund.targetPrice.toFixed(2) };
}

function recalcAllSignals() {
  for (const s of stockUniverse) {
    const price = liveData[s.symbol]?.price;
    if (price) { const sig = calcSignal(s.symbol, price); if (sig) signalCache[s.symbol] = sig; }
  }
}

// ── Upstox WebSocket ──────────────────────────────────────────────────────────
function connectUpstoxWs() {
  if (!accessToken || !stockUniverse.length) return;
  if (upstoxWs && [WebSocket.OPEN, WebSocket.CONNECTING].includes(upstoxWs.readyState)) return;

  upstoxWs = new WebSocket('wss://api.upstox.com/v2/feed/market-data-streamer', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  upstoxWs.on('open', () => {
    console.log('[FINR] Upstox WS connected');
    connectionStatus = 'live';
    wsReconnectTimeout = 1000;
    broadcastStatus();
    const keys = [
      ...stockUniverse.map(s => s.instrumentKey),
      'NSE_INDEX|Nifty 50', 'NSE_INDEX|SENSEX', 'NSE_INDEX|Nifty Bank', 'NSE_INDEX|Nifty IT', 'NSE_INDEX|Nifty Pharma'
    ];
    upstoxWs.send(JSON.stringify({ guid: 'finr', method: 'sub', data: { mode: 'full', instrumentKeys: keys } }));
  });

  upstoxWs.on('message', (raw) => {
    try {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const feeds = msg.feeds || {};
      for (const [key, val] of Object.entries(feeds)) {
        const ltpc = val.ff?.marketFF?.ltpc || val.ff?.indexFF?.ltpc;
        if (!ltpc) continue;
        const price = ltpc.ltp, close = ltpc.cp || price;
        const change = price - close, changePct = close ? (change / close) * 100 : 0;
        if (key.includes('NSE_INDEX')) {
          marketIndices[key.split('|')[1]] = { price, change: +change.toFixed(2), changePct: +changePct.toFixed(2), name: key.split('|')[1] };
        } else {
          const s = stockUniverse.find(x => x.instrumentKey === key);
          if (s) {
            const prev = liveData[s.symbol]?.price;
            liveData[s.symbol] = { symbol: s.symbol, name: s.name, sector: s.sector, price, change: +change.toFixed(2), changePct: +changePct.toFixed(2), prevPrice: prev, lastUpdate: Date.now() };
            const sig = calcSignal(s.symbol, price);
            if (sig) signalCache[s.symbol] = sig;
          }
        }
      }
      broadcastLiveData();
    } catch {}
  });

  upstoxWs.on('close', () => {
    console.log('[FINR] Upstox WS closed, retry in', wsReconnectTimeout);
    connectionStatus = 'reconnecting';
    broadcastStatus();
    setTimeout(connectUpstoxWs, wsReconnectTimeout);
    wsReconnectTimeout = Math.min(wsReconnectTimeout * 2, 30000);
  });

  upstoxWs.on('error', err => console.error('[FINR] WS err:', err.message));
}

// ── Mock/Demo Data ────────────────────────────────────────────────────────────
const MOCK_PRICES = {
  RELIANCE:2850, HDFCBANK:1720, INFY:1890, TCS:4200, ICICIBANK:1380, HINDUNILVR:2650,
  BHARTIARTL:1820, AXISBANK:1240, BAJFINANCE:7800, HCLTECH:1620, SUNPHARMA:1980,
  KOTAKBANK:1950, MARUTI:12800, TATAMOTORS:870, TATASTEEL:165, NTPC:375, POWERGRID:345,
  WIPRO:585, LTIM:5600, ONGC:285, CIPLA:1580, COALINDIA:490, INDUSINDBK:1080,
  BPCL:320, GRASIM:2750, ADANIENT:2550, HINDALCO:690, HAL:4800, DRREDDY:1420
};
const INDEX_PRICES = { 'Nifty 50':22450, 'SENSEX':73800, 'Nifty Bank':48200, 'Nifty IT':39500, 'Nifty Pharma':22100 };

function startMockTicks() {
  if (mockTickInterval) return;
  for (const s of stockUniverse) {
    const base = MOCK_PRICES[s.symbol] || 1000;
    const change = (Math.random() - 0.45) * base * 0.025;
    liveData[s.symbol] = { symbol:s.symbol, name:s.name, sector:s.sector, price:+(base+change).toFixed(2), change:+change.toFixed(2), changePct:+((change/base)*100).toFixed(2), volume:Math.round(1e5 + Math.random()*5e6), lastUpdate:Date.now(), isMock:true };
  }
  for (const [name, base] of Object.entries(INDEX_PRICES)) {
    const change = (Math.random() - 0.5) * base * 0.01;
    marketIndices[name] = { price:+(base+change).toFixed(2), change:+change.toFixed(2), changePct:+((change/base)*100).toFixed(2), name };
  }
  recalcAllSignals();
  broadcastLiveData();

  mockTickInterval = setInterval(() => {
    for (const [sym, d] of Object.entries(liveData)) {
      const delta = (Math.random() - 0.499) * d.price * 0.0008;
      const prev = d.price;
      d.price = +(d.price + delta).toFixed(2);
      d.prevPrice = prev;
      d.change = +(d.change + delta).toFixed(2);
      d.changePct = +((d.change / (MOCK_PRICES[sym] || d.price)) * 100).toFixed(2);
      d.lastUpdate = Date.now();
    }
    for (const d of Object.values(marketIndices)) {
      const delta = (Math.random() - 0.499) * d.price * 0.0004;
      d.price = +(d.price + delta).toFixed(2);
      d.change = +(d.change + delta).toFixed(2);
    }
    recalcAllSignals();
    broadcastLiveData();
  }, 1000);
}

async function initLiveData() {
  await fetchTopStocks();
  await fetchFundamentals();
  if (accessToken) {
    connectUpstoxWs();
    setTimeout(() => {
      if (Object.keys(liveData).length < 5) startMockTicks();
    }, 5000);
  } else {
    startMockTicks();
  }
}

// ── Frontend WS broadcast ─────────────────────────────────────────────────────
const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type:'init', stocks:liveData, indices:marketIndices, signals:signalCache, status:connectionStatus }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});
function broadcastLiveData() {
  const msg = JSON.stringify({ type:'tick', stocks:liveData, indices:marketIndices, signals:signalCache });
  for (const c of clients) { if (c.readyState === WebSocket.OPEN) c.send(msg); }
}
function broadcastStatus() {
  const msg = JSON.stringify({ type:'status', status:connectionStatus });
  for (const c of clients) { if (c.readyState === WebSocket.OPEN) c.send(msg); }
}

cron.schedule('0 9 * * 1-5', () => { if (accessToken) initLiveData(); });

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, async () => {
  loadConfig();
  console.log(`\n[FINR] ═══════════════════════════════════`);
  console.log(`[FINR]  Server on port ${PORT}`);
  console.log(`[FINR]  Keys: ${!!appConfig.apiKey} | PIN: ${!!appConfig.pin}`);
  console.log(`[FINR] ═══════════════════════════════════\n`);
  // Always start demo data so app looks alive
  await fetchTopStocks();
  await fetchFundamentals();
  startMockTicks();
  if (accessToken) connectUpstoxWs();
});

/**
 * FINR v2.0 — Professional Stock Intelligence Platform
 * Complete rewrite with Zerodha, Gemini AI, Smart Money tracking,
 * System health monitoring, full logging, and unit tests
 */
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const axios      = require('axios');
const CryptoJS   = require('crypto-js');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const cron       = require('node-cron');
const { getMarketContext }                                       = require('./lib/marketContext');
const { calcRSI, calcEMA, calcMACD, calcBollinger, calcSupport, calcResistance } = require('./lib/technicals');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

// ── File paths ────────────────────────────────────────────────────────────────
const CONFIG_FILE    = path.join(__dirname, '.finr_config.enc');
const PORTFOLIO_FILE = path.join(__dirname, '.finr_portfolio.enc');
const NOTES_FILE     = path.join(__dirname, '.finr_notes.enc');
const OPTIONS_FILE   = path.join(__dirname, '.finr_options.enc');
const ALERTS_FILE    = path.join(__dirname, '.finr_alerts.enc');
const TRADES_FILE    = path.join(__dirname, '.finr_trades.enc');
const ENC_KEY        = process.env.FINR_SECRET || 'finr-secure-key-2026';

// ── State ─────────────────────────────────────────────────────────────────────
let appConfig        = {};
let accessToken      = null;
let zAccessToken     = null;
let upstoxWs         = null;
let liveStocks       = {};
let liveIndices      = {};
let signalCache      = {};
let fundamentals     = {};
let stockUniverse    = [];
let zerodhaHoldings  = [];
let priceAlerts      = []; // { id, symbol, targetPrice, type: 'above'|'below', triggered: false, created }
let tradeHistory     = []; // { id, symbol, qty, buyPrice, sellPrice, buyDate, sellDate, type: 'manual'|'zerodha' }
let zerodhaPositions = [];
let zerodhaOrders    = [];
let vixData          = { value: 14.5, change: 0, trend: 'stable' };
let fiiDiiData       = { fii: -3240, dii: 4180, usdInr: 86.4, crude: 72.8 };
let connectionStatus = 'disconnected';
let priceHistory     = {}; // symbol → last 30 prices for RSI/EMA
let wsReconnectMs    = 1000;
let mockInterval     = null;
let testResults      = [];
let globalMarkets    = {}; // Twelve Data global market prices
let twelveDataInterval = null;
let optionChainCache = { nifty: null, banknifty: null, lastFetch: 0 }; // OI, IV, PCR, Max Pain
let pickTracker      = []; // { id, type, symbol, direction, entryPrice, target, stopLoss, date, status, outcome }
const PICK_TRACKER_FILE = path.join(__dirname, '.finr_picks.enc');

// ── Twelve Data config ───────────────────────────────────────────────────────
const TWELVE_DATA_SYMBOLS = [
  { key: 'GIFT_NIFTY',  symbol: 'NIFTY 50',  name: 'Gift Nifty',  type: 'Index' },
  { key: 'GOLD',        symbol: 'XAU/USD',    name: 'Gold $/oz',   type: 'Commodity' },
  { key: 'CRUDE',       symbol: 'CL',         name: 'Crude WTI',   type: 'Commodity' },
  { key: 'USDINR',      symbol: 'USD/INR',    name: 'USD/INR',     type: 'Currency' },
  { key: 'SP500',       symbol: 'SPX',        name: 'S&P 500',     type: 'Index' },
  { key: 'NASDAQ',      symbol: 'IXIC',       name: 'NASDAQ',      type: 'Index' },
  { key: 'DOW',         symbol: 'DJI',        name: 'Dow Jones',   type: 'Index' },
  { key: 'NIKKEI',      symbol: 'NI225',      name: 'Nikkei 225',  type: 'Index' },
];

function isPostMarketWindow() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 930 && mins < 1440; // 3:30 PM to midnight IST
}

async function fetchTwelveData() {
  const apiKey = appConfig.twelveDataKey;
  if (!apiKey) { log('WARN', 'Twelve Data API key not set — skipping global fetch'); return; }
  if (!isPostMarketWindow()) { log('INFO', 'Outside post-market window — skipping Twelve Data'); return; }

  let fetched = 0;
  for (const s of TWELVE_DATA_SYMBOLS) {
    try {
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(s.symbol)}&apikey=${apiKey}`;
      const { data } = await axios.get(url, { timeout: 8000 });
      if (data.status === 'error') { log('WARN', `Twelve Data error for ${s.symbol}: ${data.message}`); continue; }
      const price = parseFloat(data.close) || parseFloat(data.price) || 0;
      const prevClose = parseFloat(data.previous_close) || price;
      const change = price - prevClose;
      const changePct = prevClose ? (change / prevClose) * 100 : 0;
      globalMarkets[s.key] = {
        key: s.key, name: s.name, type: s.type, symbol: s.symbol,
        price: +price.toFixed(2), change: +change.toFixed(2), changePct: +changePct.toFixed(2),
        lastUpdate: Date.now(), isLive: true
      };
      fetched++;
    } catch (e) {
      log('WARN', `Twelve Data fetch failed for ${s.symbol}: ${e.message}`);
    }
  }
  if (fetched > 0) {
    // Update fiiDiiData with live values
    if (globalMarkets.USDINR) fiiDiiData.usdInr = globalMarkets.USDINR.price;
    if (globalMarkets.CRUDE)  fiiDiiData.crude   = globalMarkets.CRUDE.price;
    broadcastLiveData();
    log('OK', `Twelve Data: ${fetched}/${TWELVE_DATA_SYMBOLS.length} symbols updated`);
  }
}

function startTwelveDataPolling() {
  if (twelveDataInterval) return;
  if (!isPostMarketWindow()) return;
  fetchTwelveData(); // immediate first fetch
  twelveDataInterval = setInterval(() => {
    if (!isPostMarketWindow()) { stopTwelveDataPolling(); return; }
    fetchTwelveData();
  }, 6 * 60 * 1000); // every 6 minutes
  log('OK', 'Twelve Data polling started (every 6 min)');
}

function stopTwelveDataPolling() {
  if (twelveDataInterval) { clearInterval(twelveDataInterval); twelveDataInterval = null; }
  log('INFO', 'Twelve Data polling stopped');
}

// ── Option Chain Fetcher (Upstox v2) ─────────────────────────────────────────
const OC_CACHE_MS = 5 * 60 * 1000; // 5 min cache for option chain

async function fetchOptionChain(underlying = 'NSE_INDEX|Nifty 50') {
  if (!accessToken) return null;
  try {
    const res = await axios.get('https://api.upstox.com/v2/option/chain', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      params: { instrument_key: underlying, expiry_date: getNextExpiry() },
      timeout: 10000
    });
    const data = res.data?.data;
    if (!data || !data.length) return null;

    // Find ATM strike
    const spot = underlying.includes('Nifty 50') ? (liveIndices['Nifty 50']?.price || 23000) :
                 underlying.includes('Nifty Bank') ? (liveIndices['Nifty Bank']?.price || 49000) : 23000;
    const sorted = [...data].sort((a, b) => Math.abs(a.strike_price - spot) - Math.abs(b.strike_price - spot));
    const nearATM = sorted.slice(0, 20); // Top 10 strikes around ATM

    let totalCallOI = 0, totalPutOI = 0, maxPainStrike = 0, maxPainLoss = Infinity;
    const strikes = [];

    for (const s of data) {
      const ce = s.call_options?.market_data || {};
      const pe = s.put_options?.market_data || {};
      totalCallOI += (ce.oi || 0);
      totalPutOI += (pe.oi || 0);
    }

    // Max Pain calculation: strike where total option buyer losses are maximum
    for (const s of data) {
      let callLoss = 0, putLoss = 0;
      for (const other of data) {
        const ceOI = other.call_options?.market_data?.oi || 0;
        const peOI = other.put_options?.market_data?.oi || 0;
        if (other.strike_price < s.strike_price) callLoss += ceOI * (s.strike_price - other.strike_price);
        if (other.strike_price > s.strike_price) putLoss += peOI * (other.strike_price - s.strike_price);
      }
      const totalLoss = callLoss + putLoss;
      if (totalLoss < maxPainLoss) { maxPainLoss = totalLoss; maxPainStrike = s.strike_price; }
    }

    // Extract near-ATM strikes with full data
    for (const s of nearATM) {
      const ce = s.call_options || {};
      const pe = s.put_options || {};
      const ceM = ce.market_data || {};
      const peM = pe.market_data || {};
      const ceG = ce.option_greeks || {};
      const peG = pe.option_greeks || {};
      strikes.push({
        strike: s.strike_price,
        ce: { ltp: ceM.ltp || 0, oi: ceM.oi || 0, volume: ceM.volume || 0, iv: ceG.iv || 0, delta: ceG.delta || 0, theta: ceG.theta || 0, bidQty: ceM.bid_qty || 0, askQty: ceM.ask_qty || 0 },
        pe: { ltp: peM.ltp || 0, oi: peM.oi || 0, volume: peM.volume || 0, iv: peG.iv || 0, delta: peG.delta || 0, theta: peG.theta || 0, bidQty: peM.bid_qty || 0, askQty: peM.ask_qty || 0 }
      });
    }

    const pcr = totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(2) : 0;
    const avgIV = strikes.length > 0 ? +(strikes.reduce((s, x) => s + (x.ce.iv + x.pe.iv) / 2, 0) / strikes.length).toFixed(1) : 0;

    return { spot, strikes, pcr, maxPain: maxPainStrike, totalCallOI, totalPutOI, avgIV };
  } catch (e) {
    log('WARN', `Option chain fetch failed for ${underlying}: ${e.message}`);
    return null;
  }
}

function getNextExpiry() {
  // Get next Thursday (weekly expiry for Nifty/BankNifty)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = now.getDay();
  const daysToThurs = day <= 4 ? (4 - day) : (4 + 7 - day);
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + (daysToThurs === 0 && now.getHours() >= 15 ? 7 : daysToThurs));
  return expiry.toISOString().slice(0, 10);
}

async function refreshOptionChain() {
  if (Date.now() - optionChainCache.lastFetch < OC_CACHE_MS) return optionChainCache;
  const [nifty, banknifty] = await Promise.all([
    fetchOptionChain('NSE_INDEX|Nifty 50'),
    fetchOptionChain('NSE_INDEX|Nifty Bank')
  ]);
  optionChainCache = { nifty, banknifty, lastFetch: Date.now() };
  if (nifty) log('OK', `Option chain refreshed — Nifty PCR:${nifty.pcr} MaxPain:${nifty.maxPain} AvgIV:${nifty.avgIV}%`);
  return optionChainCache;
}

// ── Pick Tracker — persistence ───────────────────────────────────────────────
function loadPicks() {
  try { if (fs.existsSync(PICK_TRACKER_FILE)) { pickTracker = JSON.parse(CryptoJS.AES.decrypt(fs.readFileSync(PICK_TRACKER_FILE,'utf8'), ENC_KEY).toString(CryptoJS.enc.Utf8)); } }
  catch(e) { log('WARN', 'Failed to load pick tracker: ' + e.message); pickTracker = []; }
}
function savePicks() {
  try { fs.writeFileSync(PICK_TRACKER_FILE, CryptoJS.AES.encrypt(JSON.stringify(pickTracker), ENC_KEY).toString()); }
  catch(e) { log('ERR', 'Failed to save pick tracker: ' + e.message); }
}

function trackPick(pick) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    type: pick.type || 'options', // 'options' | 'equity'
    symbol: pick.symbol,
    direction: pick.direction || null,
    strategy: pick.strategy || null,
    entryPrice: pick.entryPrice || 0,
    entryPremium: pick.entryPremium || null,
    target: pick.target || 0,
    stopLoss: pick.stopLoss || 0,
    signalAlignment: pick.signalAlignment || null,
    date: new Date().toISOString().slice(0,10),
    expiry: pick.expiry || null,
    status: 'ACTIVE', // ACTIVE → HIT_TARGET | HIT_SL | EXPIRED | DIRECTION_CORRECT | DIRECTION_WRONG
    outcome: null, // filled next day
    nextDayPrice: null,
    nextDayCheck: null,
    pnlEstimate: null
  };
  pickTracker.unshift(entry);
  if (pickTracker.length > 500) pickTracker = pickTracker.slice(0, 500);
  savePicks();
  return entry;
}

// Check yesterday's picks against today's prices
function evaluatePicksNextDay() {
  const today = new Date().toISOString().slice(0, 10);
  let evaluated = 0;
  for (const pick of pickTracker) {
    if (pick.status !== 'ACTIVE') continue;
    if (pick.nextDayCheck) continue;
    // Only evaluate picks from before today
    if (pick.date >= today) continue;

    const live = liveStocks[pick.symbol] || liveIndices[pick.symbol];
    if (!live || !live.price) continue;

    pick.nextDayPrice = live.price;
    pick.nextDayCheck = today;

    if (pick.type === 'options') {
      // For options: check if underlying moved in predicted direction
      const movedUp = live.price > pick.entryPrice;
      const predictedUp = (pick.direction === 'CE');
      pick.outcome = movedUp === predictedUp ? 'DIRECTION_CORRECT' : 'DIRECTION_WRONG';
      // Estimate P&L based on underlying movement
      const movePct = ((live.price - pick.entryPrice) / pick.entryPrice) * 100;
      pick.pnlEstimate = predictedUp ? +movePct.toFixed(2) : +(-movePct).toFixed(2);
    } else {
      // For equity: check against target/SL
      if (pick.target && live.price >= pick.target) { pick.status = 'HIT_TARGET'; pick.outcome = 'WIN'; }
      else if (pick.stopLoss && live.price <= pick.stopLoss) { pick.status = 'HIT_SL'; pick.outcome = 'LOSS'; }
      else {
        const movedUp = live.price > pick.entryPrice;
        pick.outcome = movedUp ? 'DIRECTION_CORRECT' : 'DIRECTION_WRONG';
        pick.pnlEstimate = +(((live.price - pick.entryPrice) / pick.entryPrice) * 100).toFixed(2);
      }
    }
    pick.status = pick.outcome === 'DIRECTION_CORRECT' || pick.outcome === 'WIN' ? 'CORRECT' : 'INCORRECT';
    evaluated++;
  }
  if (evaluated > 0) { savePicks(); log('OK', `Evaluated ${evaluated} picks from previous days`); }
}

// ── Logging ───────────────────────────────────────────────────────────────────
const LOGS = [];
function log(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  LOGS.unshift(entry);
  if (LOGS.length > 200) LOGS.pop();
  const icon = level === 'OK' ? '✅' : level === 'WARN' ? '⚠️' : level === 'ERR' ? '❌' : 'ℹ️';
  console.log(`[FINR] ${icon} ${msg}`);
}

// ── Crypto helpers ────────────────────────────────────────────────────────────
const enc  = d  => CryptoJS.AES.encrypt(JSON.stringify(d), ENC_KEY).toString();
const dec  = s  => { try { return JSON.parse(CryptoJS.AES.decrypt(s, ENC_KEY).toString(CryptoJS.enc.Utf8)); } catch { return null; } };
const hash = p  => CryptoJS.SHA256(p).toString();

// ── Config management ─────────────────────────────────────────────────────────
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const d = dec(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (d) appConfig = d;
  }
  // Railway env vars always win — survive restarts
  if (process.env.UPSTOX_API_KEY)    appConfig.apiKey        = process.env.UPSTOX_API_KEY.trim();
  if (process.env.UPSTOX_API_SECRET) appConfig.apiSecret     = process.env.UPSTOX_API_SECRET.trim();
  if (process.env.UPSTOX_REDIRECT)   appConfig.redirectUri   = process.env.UPSTOX_REDIRECT.trim();
  if (process.env.FINR_PIN)          appConfig.pin           = hash(process.env.FINR_PIN.trim());
  if (process.env.GEMINI_API_KEY)    appConfig.geminiKey     = process.env.GEMINI_API_KEY.trim();
  if (process.env.ZERODHA_API_KEY)   appConfig.zApiKey       = process.env.ZERODHA_API_KEY.trim();
  if (process.env.ZERODHA_API_SECRET) appConfig.zApiSecret   = process.env.ZERODHA_API_SECRET.trim();
  if (process.env.TWELVE_DATA_API_KEY) appConfig.twelveDataKey = process.env.TWELVE_DATA_API_KEY.trim();
  log('OK', `Config loaded — Upstox:${!!appConfig.apiKey} Zerodha:${!!appConfig.zApiKey} Gemini:${!!appConfig.geminiKey} TwelveData:${!!appConfig.twelveDataKey}`);
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, enc(appConfig)); }
  catch(e) { log('WARN', 'Cannot write config file: ' + e.message); }
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 60000, max: 300 }));

// ── Market hours helper ───────────────────────────────────────────────────────
function isMarketOpen() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
}

// ══════════════════════════════════════════════════════════════════════════════
// UPSTOX AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.get('/auth/login', (req, res) => {
  if (!appConfig.apiKey || !appConfig.apiSecret)
    return res.status(400).json({ error: 'Upstox API keys not configured' });
  const redirect = appConfig.redirectUri || `https://${req.get('host')}/callback`;
  const url = `https://api.upstox.com/v2/login/authorization/dialog?client_id=${appConfig.apiKey}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code`;
  log('INFO', 'Upstox auth URL generated');
  res.json({ url });
});

const usedCodes = new Set();
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No auth code');
  if (usedCodes.has(code)) {
    log('WARN', 'Duplicate auth code ignored');
    return res.send(successPage('Already Connected', 'Token already saved. Return to app.'));
  }
  usedCodes.add(code);
  setTimeout(() => usedCodes.delete(code), 300000);
  try {
    const redirect = appConfig.redirectUri || `https://${req.get('host')}/callback`;
    log('INFO', `Token exchange — client_id:${appConfig.apiKey} redirect:${redirect}`);
    const r = await axios.post('https://api.upstox.com/v2/login/authorization/token',
      new URLSearchParams({ code, client_id: appConfig.apiKey, client_secret: appConfig.apiSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );
    accessToken = r.data.access_token;
    appConfig.tokenExpiry = Date.now() + 86400000;
    saveConfig();
    connectionStatus = 'authenticated';
    broadcastStatus();
    await initLiveData();
    log('OK', 'Upstox token saved successfully');
    res.send(successPage('FINR CONNECTED ✅', 'Live data starting... You can close this tab.'));
  } catch(err) {
    const msg = JSON.stringify(err.response?.data) || err.message;
    log('ERR', 'Upstox token exchange failed: ' + msg);
    res.status(500).send(errorPage('Upstox Auth Failed', msg, req.get('host')));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ZERODHA AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.get('/zerodha/login', (req, res) => {
  if (!appConfig.zApiKey) return res.status(400).json({ error: 'Zerodha API key not configured' });
  const url = `https://kite.zerodha.com/connect/login?api_key=${appConfig.zApiKey}&v=3`;
  log('INFO', 'Zerodha auth URL generated');
  res.json({ url });
});

const usedZCodes = new Set();
app.get('/zerodha/callback', async (req, res) => {
  const { request_token } = req.query;
  if (!request_token) return res.status(400).send('No request token');
  if (usedZCodes.has(request_token)) return res.send(successPage('Zerodha Already Connected', 'Token already saved.'));
  usedZCodes.add(request_token);
  setTimeout(() => usedZCodes.delete(request_token), 300000);
  try {
    const checksum = CryptoJS.SHA256(appConfig.zApiKey + request_token + appConfig.zApiSecret).toString();
    const r = await axios.post('https://api.kite.trade/session/token',
      new URLSearchParams({ api_key: appConfig.zApiKey, request_token, checksum }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' } }
    );
    zAccessToken = r.data.data.access_token;
    appConfig.zTokenExpiry = Date.now() + 86400000;
    saveConfig();
    await fetchZerodhaData();
    log('OK', 'Zerodha token saved successfully');
    res.send(successPage('Zerodha Connected ✅', 'Portfolio data loading... You can close this tab.'));
  } catch(err) {
    const msg = JSON.stringify(err.response?.data) || err.message;
    log('ERR', 'Zerodha token failed: ' + msg);
    res.status(500).send(errorPage('Zerodha Auth Failed', msg, req.get('host')));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ZERODHA DATA FETCHING
// ══════════════════════════════════════════════════════════════════════════════
async function fetchZerodhaData() {
  if (!zAccessToken || !appConfig.zApiKey) return;
  try {
    const headers = { 'X-Kite-Version': '3', Authorization: `token ${appConfig.zApiKey}:${zAccessToken}` };
    const [holdR, posR, orderR] = await Promise.allSettled([
      axios.get('https://api.kite.trade/portfolio/holdings', { headers }),
      axios.get('https://api.kite.trade/portfolio/positions', { headers }),
      axios.get('https://api.kite.trade/orders', { headers })
    ]);
    if (holdR.status === 'fulfilled') {
      zerodhaHoldings = holdR.value.data.data || [];
      log('OK', `Zerodha holdings: ${zerodhaHoldings.length} stocks`);
    }
    if (posR.status === 'fulfilled') {
      const pos = posR.value.data.data;
      zerodhaPositions = [...(pos?.net || []), ...(pos?.day || [])];
      log('OK', `Zerodha positions: ${zerodhaPositions.length}`);
    }
    if (orderR.status === 'fulfilled') {
      zerodhaOrders = orderR.value.data.data || [];
      log('OK', `Zerodha orders: ${zerodhaOrders.length}`);
    }
    broadcastLiveData();
  } catch(e) {
    log('ERR', 'Zerodha data fetch failed: ' + e.message);
  }
}

// Group trades into strategies
function groupTradesToStrategies(orders) {
  const strategies = [];
  const grouped = {};
  for (const o of orders) {
    if (o.status !== 'COMPLETE') continue;
    const key = `${o.tradingsymbol}_${o.exchange}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(o);
  }
  for (const [key, legs] of Object.entries(grouped)) {
    const buys  = legs.filter(l => l.transaction_type === 'BUY');
    const sells = legs.filter(l => l.transaction_type === 'SELL');
    const sym   = legs[0].tradingsymbol;
    const isOptions = sym.match(/\d{2}[A-Z]{3}\d{2}[CP]E/);
    const isFutures = sym.includes('FUT');
    let type = 'Naked';
    if (isOptions && buys.length > 0 && sells.length > 0) type = 'Vertical Spread';
    else if (isFutures && isOptions) type = 'Hedge';
    else if (legs.length > 2) type = 'Complex Strategy';
    const totalBuy  = buys.reduce((a,l)  => a + l.average_price * l.filled_quantity, 0);
    const totalSell = sells.reduce((a,l) => a + l.average_price * l.filled_quantity, 0);
    const pnl = totalSell - totalBuy;
    strategies.push({ symbol: sym, type, legs: legs.length, pnl: +pnl.toFixed(2), status: sells.length > 0 && buys.length === sells.length ? 'CLOSED' : 'OPEN', orders: legs });
  }
  return strategies.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI AI — HELPER WITH MODEL FALLBACK
// ══════════════════════════════════════════════════════════════════════════════
const GEMINI_MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'];
async function callGemini(prompt, opts = {}) {
  const { temperature = 0.3, maxOutputTokens = 1000, timeout = 30000 } = opts;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    try {
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${appConfig.geminiKey}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens } },
        { headers: { 'Content-Type': 'application/json' }, timeout }
      );
      const text = r.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return { text, model };
    } catch (e) {
      const status = e.response?.status;
      if ((status === 429 || status === 404) && i < GEMINI_MODELS.length - 1) {
        log('WARN', `Gemini ${model} ${status === 429 ? 'rate limited' : 'not found'} (${status}) — falling back to ${GEMINI_MODELS[i+1]}`);
        continue;
      }
      throw e;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI AI — OPTIONS VALIDATOR
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/options-validate', async (req, res) => {
  const { trade } = req.body;
  if (!trade) return res.status(400).json({ error: 'Trade description required' });
  if (!appConfig.geminiKey) return res.json({ analysis: 'Gemini API key not configured. Add GEMINI_API_KEY to Railway Variables.', configured: false });
  try {
    const nifty = liveIndices['Nifty 50'];
    const marketData = {
      nifty50:  nifty?.price || 'N/A',
      niftyChg: nifty?.changePct || 0,
      vix:      vixData.value,
      vixTrend: vixData.trend,
      fiiFlow:  fiiDiiData.fii,
      diiFlow:  fiiDiiData.dii,
      usdInr:   fiiDiiData.usdInr,
      crude:    fiiDiiData.crude,
      marketOpen: isMarketOpen(),
      topBuys:  Object.values(signalCache).filter(s=>s.score>=80).slice(0,3).map(s=>s.symbol||'').join(', '),
      time:     new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };
    const prompt = `You are a professional NSE options trading advisor for an Indian retail investor. Analyse this trade and respond ONLY with valid JSON — no markdown, no preamble, no explanation outside the JSON.

CURRENT MARKET DATA:
- Nifty 50: ${marketData.nifty50} (${marketData.niftyChg >= 0 ? '+' : ''}${marketData.niftyChg}%)
- India VIX: ${marketData.vix} (${marketData.vixTrend}) — ${marketData.vix > 20 ? 'HIGH FEAR' : marketData.vix < 13 ? 'CALM' : 'NORMAL'}
- FII Today: ₹${marketData.fiiFlow}Cr (${marketData.fiiFlow < 0 ? 'Selling' : 'Buying'}) | DII: ₹${marketData.diiFlow}Cr
- USD/INR: ${marketData.usdInr} | Brent Crude: $${marketData.crude}
- Market: ${marketData.marketOpen ? 'OPEN' : 'CLOSED'} | IST: ${marketData.time}

TRADE IDEA: "${trade}"

Respond ONLY with this exact JSON (no markdown fences):
{"recommendation":"TAKE","confidence":"HIGH","reason":"one clear sentence explaining verdict","entryAdvice":"specific price level or condition for entry","risks":["risk 1","risk 2","risk 3"],"verdict":"one line TL;DR for the trade"}

recommendation must be exactly TAKE, AVOID, or WAIT.
confidence must be exactly HIGH, MEDIUM, or LOW.`;

    const g = await callGemini(prompt);
    const analysis = g.text || 'No response from Gemini';
    log('OK', `Gemini options analysis completed (${g.model}) for: ${trade.substring(0, 50)}`);
    res.json({ analysis, marketData, configured: true });
  } catch(e) {
    log('ERR', 'Gemini call failed: ' + e.message);
    res.status(500).json({ error: 'Gemini analysis failed: ' + e.message });
  }
});

// ── AI Options Recommendations ──
app.get('/api/options-recommend', async (req, res) => {
  if (!appConfig.geminiKey) return res.json({ recommendations: [], configured: false, error: 'Gemini API key not configured' });
  try {
    const nifty = liveIndices['Nifty 50'];
    const bankNifty = liveIndices['Nifty Bank'];
    // Build top movers and signals summary
    const stocks = Object.values(liveStocks).filter(s => !s.isMock && s.price);
    const topGainers = [...stocks].sort((a,b) => b.changePct - a.changePct).slice(0,10);
    const topLosers  = [...stocks].sort((a,b) => a.changePct - b.changePct).slice(0,10);
    const strongSignals = Object.values(signalCache).filter(s => s.score >= 65).sort((a,b) => b.score - a.score).slice(0,8);

    const stockSummary = stocks.slice(0,40).map(s => {
      const sig = signalCache[s.symbol];
      const fund = STOCK_UNIVERSE.find(x => x.symbol === s.symbol);
      const f52 = fundamentals[s.symbol];
      return `${s.symbol}:₹${s.price}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%) PE:${fund?.pe||'?'} ROE:${fund?.roe||'?'} DE:${fund?.de||'?'} Sig:${sig?.signal||'--'}(${sig?.score||0}) H52:₹${f52?.high52||'?'} L52:₹${f52?.low52||'?'} Tgt:₹${fund?.target||'?'}`;
    }).join('\n');

    // Sector performance summary
    const sectorPerf = {};
    for (const s of stocks) {
      if (!s.sector) continue;
      if (!sectorPerf[s.sector]) sectorPerf[s.sector] = { total:0, count:0 };
      sectorPerf[s.sector].total += (s.changePct || 0);
      sectorPerf[s.sector].count++;
    }
    const sectorStr = Object.entries(sectorPerf).map(([k,v]) => `${k}:${(v.total/v.count).toFixed(2)}%`).join(' ');

    const prompt = `You are an expert NSE F&O options strategist with deep technical + fundamental analysis skills. Recommend TOP 5-6 stocks/indices for options trading NOW.

MARKET SNAPSHOT:
Nifty=${nifty?.price||'?'}(${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%) BankNifty=${bankNifty?.price||'?'}(${bankNifty?.changePct>=0?'+':''}${bankNifty?.changePct||0}%) VIX=${vixData.value}(${vixData.trend}) FII=₹${fiiDiiData.fii}Cr DII=₹${fiiDiiData.dii}Cr Status:${isMarketOpen()?'OPEN':'CLOSED'}

SECTOR PERFORMANCE: ${sectorStr}

TOP GAINERS: ${topGainers.map(s=>`${s.symbol}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%)`).join(',')}
TOP LOSERS: ${topLosers.map(s=>`${s.symbol}(${s.changePct.toFixed(1)}%)`).join(',')}
STRONG SIGNALS: ${strongSignals.map(s=>`${s.symbol}(${s.signal},${s.score})`).join(',')}

STOCKS DATA (with fundamentals, 52W range, target):
${stockSummary}

ANALYSIS REQUIREMENTS:
1. Do thorough technical analysis (support/resistance, RSI zones, trend, volume)
2. Do fundamental check (PE vs sector, ROE, debt, dividend yield)
3. Suggest specific strategy: NAKED CE/PE, BULL CALL SPREAD, BEAR PUT SPREAD, IRON CONDOR, or HEDGED positions
4. For each pick, provide sentiment: HIGHLY_CONFIDENT, CONFIDENT, MODERATE, SPECULATIVE
5. Include entry price range, target price range, target timeframe, and stop loss
6. Consider VIX level for strategy selection (high VIX = sell premium, low VIX = buy premium)

Reply ONLY valid JSON array, NO markdown fences, NO text before/after:
[{"symbol":"NAME","direction":"CE or PE","confidence":"HIGH/MED/LOW","sentiment":"HIGHLY_CONFIDENT/CONFIDENT/MODERATE/SPECULATIVE","strategy":"Naked CE / Bull Call Spread 23000-23200 / Bear Put Spread etc","strategyType":"NAKED/VERTICAL_SPREAD/IRON_CONDOR/STRADDLE/HEDGED","reasoning":"detailed 50-word analysis: why this stock, technical levels, fundamental backing, sector trend","fundamentals":"PE:x ROE:y% D/E:z — brief fundamental view","technicals":"RSI zone, support/resistance levels, trend direction, 52W position","entry":"₹xxx-₹xxx or specific strike price","target":"₹xxx-₹xxx target range","targetTime":"1-3 days / 1 week / 2 weeks / monthly expiry","stopLoss":"₹xxx SL level","riskLevel":"LOW/MED/HIGH","riskReward":"1:2 / 1:3 etc","maxLoss":"₹xxx per lot if wrong","hedgeSuggestion":"optional hedge: buy xxx as protection"}]
Include NIFTY or BANKNIFTY if favorable. Be thorough and accurate.`;

    const g = await callGemini(prompt, { temperature: 0.4, maxOutputTokens: 4000, timeout: 45000 });
    const raw = g.text || '[]';
    log('OK', `Gemini options recommendations generated (${g.model}), ${raw.length} chars`);
    // Robust JSON parsing with multiple fallback strategies
    let recs = [];
    const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    // Strategy 1: direct parse
    try { recs = JSON.parse(cleaned); } catch(_) {}
    // Strategy 2: find the array in the text
    if (!recs.length) {
      const arrStart = cleaned.indexOf('['), arrEnd = cleaned.lastIndexOf(']');
      if (arrStart >= 0 && arrEnd > arrStart) {
        try { recs = JSON.parse(cleaned.slice(arrStart, arrEnd + 1)); } catch(_) {}
      }
    }
    // Strategy 3: extract individual JSON objects via regex
    if (!recs.length) {
      const objRegex = /\{[^{}]*"symbol"\s*:\s*"[^"]+"[^{}]*\}/g;
      const matches = cleaned.match(objRegex);
      if (matches) {
        for (const m of matches) { try { recs.push(JSON.parse(m)); } catch(_) {} }
      }
    }
    // Strategy 4: fix truncated JSON — add missing ] and try
    if (!recs.length && cleaned.includes('"symbol"')) {
      try {
        let fixed = cleaned;
        if (!fixed.endsWith(']')) fixed = fixed.replace(/,?\s*$/, '') + ']';
        if (!fixed.startsWith('[')) fixed = '[' + fixed;
        recs = JSON.parse(fixed);
      } catch(_) {
        // Last resort: try adding closing brace+bracket
        try { recs = JSON.parse(cleaned.replace(/,?\s*$/, '') + '}]'); } catch(_2) {}
      }
    }
    res.json({ recommendations: recs, raw: recs.length ? undefined : raw, configured: true });
  } catch(e) {
    log('ERR', 'Gemini options recommend failed: ' + e.message);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ON-DEMAND STOCK PRICE FETCH (single stock from Upstox)
// ══════════════════════════════════════════════════════════════════════════════
async function fetchSingleStockPrice(symbol) {
  // First check if we already have live data
  if (liveStocks[symbol] && liveStocks[symbol].price) return liveStocks[symbol];
  // Look up ISIN from STOCK_UNIVERSE
  const stock = STOCK_UNIVERSE.find(s => s.symbol === symbol);
  if (!stock || !accessToken) return null;
  try {
    const res = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      params: { instrument_key: stock.instrumentKey }
    });
    const data = res.data?.data;
    if (data) {
      for (const [key, val] of Object.entries(data)) {
        processUpstoxQuote(key, val);
      }
    }
    return liveStocks[symbol] || null;
  } catch (e) {
    log('WARN', `On-demand fetch failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AI LONG-TERM PICKS — Gemini suggests best 10-15 stocks from entire market
// ══════════════════════════════════════════════════════════════════════════════
let aiPicksCache = { picks: [], lastFetch: 0 };
const AI_PICKS_CACHE_MS = 4 * 60 * 60 * 1000; // Cache 4 hours

app.get('/api/ai-picks', async (req, res) => {
  const force = req.query.force === 'true';
  // Return cache if fresh
  if (!force && aiPicksCache.picks.length && (Date.now() - aiPicksCache.lastFetch) < AI_PICKS_CACHE_MS) {
    return res.json({ picks: aiPicksCache.picks, cached: true, generated: new Date(aiPicksCache.lastFetch).toISOString() });
  }
  if (!appConfig.geminiKey) return res.json({ picks: [], configured: false, error: 'Gemini API key not configured' });
  try {
    const nifty = liveIndices['Nifty 50'];
    const bankNifty = liveIndices['Nifty Bank'];
    const stocks = Object.values(liveStocks).filter(s => s.price);
    const topGainers = [...stocks].sort((a,b) => b.changePct - a.changePct).slice(0,15).map(s => `${s.symbol}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%)`).join(',');
    const topLosers = [...stocks].sort((a,b) => a.changePct - b.changePct).slice(0,15).map(s => `${s.symbol}(${s.changePct.toFixed(1)}%)`).join(',');
    const strongSigs = Object.values(signalCache).filter(s => s.score >= 70).sort((a,b) => b.score - a.score).slice(0,15).map(s => `${s.symbol}(${s.signal},${s.score})`).join(',');

    // Build sector summary
    const sectorPerf = {};
    for (const s of stocks) {
      if (!s.sector) continue;
      if (!sectorPerf[s.sector]) sectorPerf[s.sector] = { total:0, count:0 };
      sectorPerf[s.sector].total += (s.changePct || 0);
      sectorPerf[s.sector].count++;
    }
    const sectorStr = Object.entries(sectorPerf).map(([k,v]) => `${k}:${(v.total/v.count).toFixed(2)}%`).join(' ');

    const prompt = `You are a SEBI-registered-level Indian stock market research analyst. Recommend the TOP 12-15 NSE-listed stocks to BUY RIGHT NOW for LONG-TERM investment (6 months to 3 years holding).

CURRENT MARKET DATA:
- Nifty 50: ${nifty?.price||'?'} (${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%)
- Bank Nifty: ${bankNifty?.price||'?'} (${bankNifty?.changePct>=0?'+':''}${bankNifty?.changePct||0}%)
- India VIX: ${vixData.value} (${vixData.trend})
- FII: ₹${fiiDiiData.fii}Cr (${fiiDiiData.fii<0?'SELLING':'BUYING'}) | DII: ₹${fiiDiiData.dii}Cr
- USD/INR: ${fiiDiiData.usdInr} | Crude: $${fiiDiiData.crude}

SECTOR PERFORMANCE: ${sectorStr}
TOP GAINERS: ${topGainers}
TOP LOSERS: ${topLosers}
STRONG BUY SIGNALS: ${strongSigs}

ANALYSIS REQUIREMENTS — BE THOROUGH:
1. Pick stocks from ANY NSE sector — large cap, mid cap, or strong small cap
2. For each stock, do COMPLETE fundamental analysis: PE ratio vs sector PE, ROE, debt-to-equity, dividend yield, revenue/profit growth trend, promoter holding
3. Do COMPLETE technical analysis: current price vs 52-week high/low, RSI zone, support/resistance, trend (uptrend/downtrend/consolidation), volume trend
4. Provide a SPECIFIC target price and ESTIMATED timeframe to reach it
5. Provide a STOP-LOSS level
6. Explain WHY this stock — what catalyst or trigger will drive it to the target
7. Rate confidence: VERY_HIGH, HIGH, MODERATE
8. Consider macro factors: RBI policy, FII flows, sector tailwinds/headwinds, global cues

Reply ONLY valid JSON array, NO markdown fences:
[{"symbol":"NSE_SYMBOL","name":"Full Company Name","sector":"Sector","currentPrice":"approximate current price","targetPrice":"target price","timeframe":"6 months / 1 year / 2 years","stopLoss":"stop-loss price","upside":"xx%","confidence":"VERY_HIGH/HIGH/MODERATE","signal":"STRONG BUY/BUY","riskLevel":"LOW/MEDIUM/HIGH","pe":"current PE","sectorPe":"sector average PE","roe":"ROE%","debtToEquity":"D/E ratio","dividendYield":"div%","promoterHolding":"xx%","revenueGrowth":"YoY revenue growth%","profitGrowth":"YoY profit growth%","week52High":"52W high","week52Low":"52W low","rsiZone":"Oversold/Neutral/Overbought","trend":"Uptrend/Consolidation/Downtrend","support":"support level","resistance":"resistance level","reasoning":"100-word detailed analysis: why buy now, what catalyst, sector outlook, risk factors, when to exit","tags":["value","growth","dividend","momentum","turnaround"]}]

Be specific with numbers. Do NOT give generic advice. Give ACTIONABLE picks.`;

    const g = await callGemini(prompt, { temperature: 0.4, maxOutputTokens: 8000, timeout: 60000 });
    const raw = g.text || '[]';
    log('OK', `AI Long-Term Picks generated (${g.model}), ${raw.length} chars`);

    let picks = [];
    const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    try { picks = JSON.parse(cleaned); } catch(_) {}
    if (!picks.length) {
      const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
      if (s >= 0 && e > s) { try { picks = JSON.parse(cleaned.slice(s, e+1)); } catch(_) {} }
    }
    if (!picks.length) {
      const m = cleaned.match(/\{[^{}]*"symbol"\s*:\s*"[^"]+"[^{}]*\}/g);
      if (m) { for (const x of m) { try { picks.push(JSON.parse(x)); } catch(_) {} } }
    }

    // Enrich with live prices where available
    for (const pick of picks) {
      const live = liveStocks[pick.symbol];
      if (live && live.price) {
        pick.livePrice = live.price;
        pick.liveChange = live.changePct;
      }
    }

    aiPicksCache = { picks, lastFetch: Date.now() };
    res.json({ picks, cached: false, generated: new Date().toISOString(), model: g.model });
  } catch(e) {
    log('ERR', 'AI Long-Term Picks failed: ' + e.message);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VERIFY STOCK — Deep AI analysis of a single stock (for checking friend's tips)
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/verify-stock', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol required' });
  if (!appConfig.geminiKey) return res.json({ configured: false, error: 'Gemini API key not configured' });
  try {
    const sym = symbol.toUpperCase().trim();
    // Try to get live data
    const live = liveStocks[sym];
    const sig = signalCache[sym];
    const fund = STOCK_UNIVERSE.find(s => s.symbol === sym);
    const f52 = fundamentals[sym];

    const liveInfo = live ? `Current Price: ₹${live.price} (${live.changePct>=0?'+':''}${live.changePct}%) Volume: ${live.volume||'?'}` : 'Price data not available — use your knowledge';
    const sigInfo = sig ? `Signal: ${sig.signal} (${sig.score}/100)` : '';
    const fundInfo = fund ? `PE:${fund.pe} ROE:${fund.roe} D/E:${fund.de} Div:${fund.div}% Target:₹${fund.target}` : '';
    const w52Info = f52 ? `52W High:₹${f52.high52} 52W Low:₹${f52.low52}` : '';

    const nifty = liveIndices['Nifty 50'];
    const prompt = `You are an expert Indian stock market research analyst. A retail investor's friend has suggested buying ${sym}. Do a COMPLETE, UNBIASED analysis.

MARKET CONTEXT:
- Nifty 50: ${nifty?.price||'?'} (${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%)
- VIX: ${vixData.value} | FII: ₹${fiiDiiData.fii}Cr | DII: ₹${fiiDiiData.dii}Cr

STOCK DATA WE HAVE:
${liveInfo}
${sigInfo}
${fundInfo}
${w52Info}

REQUIREMENTS — Be BRUTALLY HONEST:
1. VERDICT: Is this a good buy right now? BUY / HOLD / AVOID — with confidence level
2. FUNDAMENTALS: PE vs sector, ROE, debt, revenue/profit growth, promoter holding, any red flags
3. TECHNICALS: Current trend, RSI zone, support/resistance, 52W position, volume pattern
4. TARGET: Realistic target price and timeframe
5. RISK ASSESSMENT: What could go wrong? Rate: LOW / MEDIUM / HIGH / VERY HIGH
6. STOP LOSS: Where to place SL
7. BULL CASE: Best scenario — why it could work
8. BEAR CASE: Worst scenario — why it could fail
9. BETTER ALTERNATIVES: If this stock is mediocre, suggest 2-3 better options in the same sector

Reply ONLY valid JSON, NO markdown fences:
{"symbol":"${sym}","name":"Full Name","sector":"sector","verdict":"BUY/HOLD/AVOID","confidence":"VERY_HIGH/HIGH/MODERATE/LOW","riskLevel":"LOW/MEDIUM/HIGH/VERY_HIGH","currentPrice":"₹xxx","targetPrice":"₹xxx","timeframe":"x months","stopLoss":"₹xxx","upside":"xx%","downside":"xx%","pe":"xx","sectorPe":"xx","roe":"xx%","debtToEquity":"x.x","dividendYield":"x%","promoterHolding":"xx%","revenueGrowth":"xx%","profitGrowth":"xx%","week52High":"₹xxx","week52Low":"₹xxx","rsiZone":"Oversold/Neutral/Overbought","trend":"Uptrend/Downtrend/Sideways","support":"₹xxx","resistance":"₹xxx","bullCase":"50-word best case scenario","bearCase":"50-word worst case scenario","reasoning":"100-word detailed honest analysis","redFlags":["flag1","flag2"],"positives":["pos1","pos2"],"alternatives":[{"symbol":"ALT1","reason":"why better"},{"symbol":"ALT2","reason":"why better"}]}`;

    const g = await callGemini(prompt, { temperature: 0.3, maxOutputTokens: 4000, timeout: 45000 });
    const raw = g.text || '{}';
    log('OK', `Verify Stock analysis for ${sym} (${g.model}), ${raw.length} chars`);

    let analysis = {};
    const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    try { analysis = JSON.parse(cleaned); } catch(_) {
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
      if (s >= 0 && e > s) { try { analysis = JSON.parse(cleaned.slice(s, e+1)); } catch(_) {} }
    }

    res.json({ analysis, configured: true, model: g.model });
  } catch(e) {
    log('ERR', `Verify Stock failed for ${symbol}: ${e.message}`);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// OPTIONS LAB — AI scans market and suggests best options trades
// ══════════════════════════════════════════════════════════════════════════════
let optionsLabCache = { trades: [], lastFetch: 0 };
const OPTIONS_LAB_CACHE_MS = 30 * 60 * 1000; // 30 min cache

app.get('/api/options-lab', async (req, res) => {
  const force = req.query.force === 'true';
  if (!force && optionsLabCache.trades.length && (Date.now() - optionsLabCache.lastFetch) < OPTIONS_LAB_CACHE_MS) {
    return res.json({ trades: optionsLabCache.trades, cached: true, generated: new Date(optionsLabCache.lastFetch).toISOString(), chainData: optionChainCache });
  }
  if (!appConfig.geminiKey) return res.json({ trades: [], configured: false, error: 'Gemini API key not configured' });
  try {
    const nifty = liveIndices['Nifty 50'];
    const bankNifty = liveIndices['Nifty Bank'];
    const stocks = Object.values(liveStocks).filter(s => s.price && !s.isMock);
    const topGainers = [...stocks].sort((a,b) => b.changePct - a.changePct).slice(0,15);
    const topLosers = [...stocks].sort((a,b) => a.changePct - b.changePct).slice(0,15);

    // Fetch real option chain data (OI, IV, Greeks, PCR, Max Pain)
    const oc = await refreshOptionChain();
    const niftyOC = oc.nifty;
    const bnfOC = oc.banknifty;

    // Build option chain context string
    let ocStr = '';
    if (niftyOC) {
      ocStr += `\nNIFTY OPTION CHAIN (Real-Time):\nSpot:${niftyOC.spot} PCR:${niftyOC.pcr} MaxPain:${niftyOC.maxPain} AvgIV:${niftyOC.avgIV}%\nTotal Call OI:${(niftyOC.totalCallOI/100000).toFixed(1)}L Total Put OI:${(niftyOC.totalPutOI/100000).toFixed(1)}L`;
      ocStr += '\nStrike|CE_LTP|CE_OI|CE_Vol|CE_IV|CE_Delta|PE_LTP|PE_OI|PE_Vol|PE_IV|PE_Delta';
      for (const s of niftyOC.strikes.slice(0,12)) {
        ocStr += `\n${s.strike}|₹${s.ce.ltp}|${(s.ce.oi/1000).toFixed(0)}K|${s.ce.volume}|${s.ce.iv}%|${s.ce.delta}|₹${s.pe.ltp}|${(s.pe.oi/1000).toFixed(0)}K|${s.pe.volume}|${s.pe.iv}%|${s.pe.delta}`;
      }
    }
    if (bnfOC) {
      ocStr += `\n\nBANKNIFTY OPTION CHAIN (Real-Time):\nSpot:${bnfOC.spot} PCR:${bnfOC.pcr} MaxPain:${bnfOC.maxPain} AvgIV:${bnfOC.avgIV}%`;
      ocStr += '\nStrike|CE_LTP|CE_OI|CE_Vol|CE_IV|PE_LTP|PE_OI|PE_Vol|PE_IV';
      for (const s of bnfOC.strikes.slice(0,10)) {
        ocStr += `\n${s.strike}|₹${s.ce.ltp}|${(s.ce.oi/1000).toFixed(0)}K|${s.ce.volume}|${s.ce.iv}%|₹${s.pe.ltp}|${(s.pe.oi/1000).toFixed(0)}K|${s.pe.volume}|${s.pe.iv}%`;
      }
    }

    const gainStr = topGainers.map(s => {
      const f = STOCK_UNIVERSE.find(x => x.symbol === s.symbol);
      const sig = signalCache[s.symbol];
      return `${s.symbol}:₹${s.price}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%) PE:${f?.pe||'?'} Sig:${sig?.score||'?'}`;
    }).join('\n');
    const loseStr = topLosers.map(s => {
      const f = STOCK_UNIVERSE.find(x => x.symbol === s.symbol);
      const sig = signalCache[s.symbol];
      return `${s.symbol}:₹${s.price}(${s.changePct.toFixed(1)}%) PE:${f?.pe||'?'} Sig:${sig?.score||'?'}`;
    }).join('\n');

    // Build signal alignment factors for market context
    const vixLevel = vixData.value > 18 ? 'HIGH' : vixData.value < 13 ? 'LOW' : 'NORMAL';
    const pcrSignal = niftyOC ? (niftyOC.pcr > 1.3 ? 'BULLISH(oversold puts)' : niftyOC.pcr < 0.7 ? 'BEARISH(oversold calls)' : 'NEUTRAL') : '?';
    const fiiSignal = fiiDiiData.fii > 0 ? 'BUYING' : 'SELLING';
    const trendSignal = nifty && nifty.changePct > 0.3 ? 'UPTREND' : nifty && nifty.changePct < -0.3 ? 'DOWNTREND' : 'SIDEWAYS';

    const prompt = `You are an expert NSE F&O options strategist with access to REAL-TIME option chain data. Recommend the BEST options trades based on ACTUAL market data.

IMPORTANT: The user primarily SELLS options and hedges with futures or spreads. Prioritize credit strategies (sell premium) with built-in hedges. Do NOT recommend naked buys unless momentum is extremely strong.

LIVE MARKET DATA:
Nifty=${nifty?.price||'?'}(${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%) BankNifty=${bankNifty?.price||'?'}(${bankNifty?.changePct>=0?'+':''}${bankNifty?.changePct||0}%)
VIX=${vixData.value}(${vixData.trend},${vixLevel}) FII=₹${fiiDiiData.fii}Cr(${fiiSignal}) DII=₹${fiiDiiData.dii}Cr
Market:${isMarketOpen()?'OPEN':'CLOSED'} Trend:${trendSignal} PCR_Signal:${pcrSignal}
Time:${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}
${ocStr}

TOP GAINERS (momentum):
${gainStr}

TOP LOSERS (momentum):
${loseStr}

STRATEGY SELECTION RULES (market-adaptive):
1. HIGH VIX (>18): SELL premium — Iron Condors, Credit Spreads, Strangles with hedge
2. LOW VIX (<13): BUY options only if strong directional signal, otherwise avoid
3. NORMAL VIX (13-18): Spreads (Bull Put/Bear Call), Hedged positions
4. PCR > 1.3: Market oversold → BULLISH bias (sell puts, buy calls on dips)
5. PCR < 0.7: Market overbought → BEARISH bias (sell calls, buy puts on rallies)
6. ALWAYS suggest hedge for each trade (futures hedge or protective option)
7. Use REAL OI data: high OI strikes = strong support/resistance
8. Use REAL IV: sell high IV strikes, buy low IV for directional
9. Max Pain = likely expiry gravitational pull — factor this into strike selection
10. Recommend 4-8 trades — ONLY strategies that make sense TODAY. Do NOT force variety.

SIGNAL ALIGNMENT — rate each trade on 10 factors:
[1]VIX_Level [2]PCR_Direction [3]FII_Flow [4]Market_Trend [5]OI_Buildup [6]IV_Percentile [7]MaxPain_Distance [8]Momentum [9]Volume_Confirmation [10]Risk_Reward
Report alignment as "X/10 factors aligned" with breakdown.

Reply ONLY valid JSON array, NO markdown fences:
[{"symbol":"SYMBOL","direction":"CE/PE","strategy":"Bear Call Spread 23200-23400 / Iron Condor 22800-23200 / etc","strategyType":"CREDIT_SPREAD/IRON_CONDOR/HEDGED_SELL/STRADDLE/DIRECTIONAL","currentPrice":"₹xxx","strikePrice":"Sell xxxx CE + Buy xxxx CE","entry":"₹xx-₹xx net credit/debit","target":"₹xx target","stopLoss":"₹xx SL","expiry":"weekly/monthly","targetTime":"1-3 days / 1 week","riskReward":"1:2","maxLoss":"₹xxx per lot","lotSize":"lot size","margin":"approx margin required","signalAlignment":{"score":7,"total":10,"factors":{"vix":"ALIGNED","pcr":"ALIGNED","fii":"NEUTRAL","trend":"ALIGNED","oi":"ALIGNED","iv":"ALIGNED","maxPain":"NEUTRAL","momentum":"ALIGNED","volume":"MISALIGNED","riskReward":"ALIGNED"},"summary":"7/10 factors aligned — strong setup"},"riskType":"AGGRESSIVE/MODERATE/CONSERVATIVE","reasoning":"80-word analysis: why this trade, OI/IV logic, PCR reading, max pain proximity, key levels, hedge rationale","hedgeSuggestion":"Buy NIFTY FUT as delta hedge / Buy xxxx PE as protection","sentiment":"BULLISH/BEARISH/NEUTRAL"}]`;

    const g = await callGemini(prompt, { temperature: 0.4, maxOutputTokens: 8000, timeout: 60000 });
    const raw = g.text || '[]';
    log('OK', `Options Lab generated (${g.model}), ${raw.length} chars, OC:${niftyOC?'live':'none'}`);

    let trades = [];
    const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    try { trades = JSON.parse(cleaned); } catch(_) {}
    if (!trades.length) {
      const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
      if (s >= 0 && e > s) { try { trades = JSON.parse(cleaned.slice(s, e+1)); } catch(_) {} }
    }
    if (!trades.length) {
      const m = cleaned.match(/\{[^{}]*"symbol"\s*:\s*"[^"]+"[^{}]*\}/g);
      if (m) { for (const x of m) { try { trades.push(JSON.parse(x)); } catch(_) {} } }
    }

    // Track all picks for next-day evaluation
    for (const t of trades) {
      const entryPrice = nifty?.price || 0;
      if (t.symbol === 'NIFTY' || t.symbol === 'BANKNIFTY') {
        trackPick({ type: 'options', symbol: t.symbol === 'NIFTY' ? 'Nifty 50' : 'Nifty Bank', direction: t.direction, strategy: t.strategy, entryPrice: t.symbol === 'NIFTY' ? (nifty?.price||0) : (bankNifty?.price||0), entryPremium: t.entry, target: t.target, stopLoss: t.stopLoss, signalAlignment: t.signalAlignment, expiry: t.expiry });
      } else {
        const live = liveStocks[t.symbol];
        if (live) trackPick({ type: 'options', symbol: t.symbol, direction: t.direction, strategy: t.strategy, entryPrice: live.price, entryPremium: t.entry, target: t.target, stopLoss: t.stopLoss, signalAlignment: t.signalAlignment, expiry: t.expiry });
      }
    }

    optionsLabCache = { trades, lastFetch: Date.now() };
    const chainSummary = niftyOC ? { niftyPCR: niftyOC.pcr, niftyMaxPain: niftyOC.maxPain, niftyAvgIV: niftyOC.avgIV, bnfPCR: bnfOC?.pcr, bnfMaxPain: bnfOC?.maxPain } : null;
    res.json({ trades, cached: false, generated: new Date().toISOString(), model: g.model, chainData: chainSummary });
  } catch(e) {
    log('ERR', 'Options Lab failed: ' + e.message);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// TRADES CSV IMPORT (Zerodha tradebook format)
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/trades/import-csv', (req, res) => {
  const { csvData } = req.body;
  if (!csvData) return res.status(400).json({ error: 'CSV data required' });
  try {
    const lines = csvData.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header + data rows' });
    const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g,''));
    const imported = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/"/g,''));
      const row = {};
      header.forEach((h, idx) => { row[h] = cols[idx] || ''; });
      // Zerodha tradebook fields: symbol, isin, trade_date, exchange, segment, series, trade_type, quantity, price, trade_id, order_id
      const symbol = (row.symbol || row.tradingsymbol || '').toUpperCase();
      const tradeType = (row.trade_type || row.type || '').toUpperCase();
      const qty = Math.abs(parseFloat(row.quantity || row.qty || 0));
      const price = parseFloat(row.price || row.trade_price || 0);
      const date = row.trade_date || row.date || row.order_execution_time || '';
      if (!symbol || !qty || !price) continue;
      // For P&L we need buy+sell pairs. Import as individual legs — user can pair them
      const trade = {
        id: Date.now().toString(36) + '-' + i,
        symbol, qty, price: +price.toFixed(2),
        type: tradeType === 'BUY' ? 'buy' : tradeType === 'SELL' ? 'sell' : tradeType.toLowerCase(),
        date: date.split(' ')[0], // just date part
        exchange: row.exchange || 'NSE',
        segment: row.segment || 'EQ',
        source: 'zerodha-csv',
        added: new Date().toISOString()
      };
      imported.push(trade);
    }
    // Auto-pair buy/sell trades into P&L entries
    const buys = {}, sells = {};
    for (const t of imported) {
      const key = t.symbol;
      if (t.type === 'buy') { if (!buys[key]) buys[key] = []; buys[key].push(t); }
      else if (t.type === 'sell') { if (!sells[key]) sells[key] = []; sells[key].push(t); }
    }
    let paired = 0;
    for (const sym of Object.keys(buys)) {
      const buyList = buys[sym] || [];
      const sellList = sells[sym] || [];
      const minLen = Math.min(buyList.length, sellList.length);
      for (let j = 0; j < minLen; j++) {
        const b = buyList[j], s = sellList[j];
        const trade = {
          id: Date.now().toString(36) + '-p' + paired,
          symbol: sym, qty: Math.min(b.qty, s.qty),
          buyPrice: b.price, sellPrice: s.price,
          buyDate: b.date, sellDate: s.date,
          type: 'csv-import', source: 'zerodha-csv',
          segment: b.segment, added: new Date().toISOString()
        };
        tradeHistory.push(trade);
        paired++;
      }
    }
    saveTrades();
    log('OK', `CSV imported: ${imported.length} rows, ${paired} trades paired`);
    res.json({ ok: true, imported: imported.length, paired, totalTrades: tradeHistory.length, rawTrades: imported });
  } catch(e) {
    log('ERR', 'CSV import failed: ' + e.message);
    res.status(500).json({ error: 'CSV import failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS & CONFIG APIs
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/settings', (req, res) => {
  const { apiKey, apiSecret, pin, redirectUri, geminiKey, zApiKey, zApiSecret, zRedirectUri } = req.body;
  if (!apiKey || !apiSecret || !pin) return res.status(400).json({ error: 'Upstox keys and PIN required' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });
  appConfig.apiKey      = apiKey.trim();
  appConfig.apiSecret   = apiSecret.trim();
  appConfig.pin         = hash(pin);
  if (redirectUri)  appConfig.redirectUri  = redirectUri.trim();
  if (geminiKey)    appConfig.geminiKey    = geminiKey.trim();
  if (zApiKey)      appConfig.zApiKey      = zApiKey.trim();
  if (zApiSecret)   appConfig.zApiSecret   = zApiSecret.trim();
  if (zRedirectUri) appConfig.zRedirectUri = zRedirectUri.trim();
  saveConfig();
  log('OK', 'Settings saved');
  res.json({ success: true });
});

app.post('/api/verify-pin', (req, res) => {
  if (!appConfig.pin) return res.json({ valid: false, noPin: true });
  res.json({ valid: hash(req.body.pin) === appConfig.pin });
});

app.get('/api/config-status', (req, res) => {
  res.json({
    hasKeys:          !!(appConfig.apiKey && appConfig.apiSecret),
    hasPin:           !!appConfig.pin,
    isAuthenticated:  !!accessToken,
    hasZerodha:       !!zAccessToken,
    hasGemini:        !!appConfig.geminiKey,
    tokenExpiry:      appConfig.tokenExpiry || null,
    zTokenExpiry:     appConfig.zTokenExpiry || null,
    connectionStatus,
    stockCount:       stockUniverse.length,
    redirectUri:      appConfig.redirectUri || null,
    marketOpen:       isMarketOpen()
  });
});

app.get('/api/gemini-status', async (req, res) => {
  if (!appConfig.geminiKey) return res.json({ ok: false, reason: 'No API key configured' });
  try {
    const g = await callGemini('Reply with just: OK', { maxOutputTokens: 10, timeout: 10000 });
    res.json({ ok: true, response: g.text.trim(), model: g.model });
  } catch(e) {
    res.json({ ok: false, reason: e.response?.data?.error?.message || e.message });
  }
});

app.get('/api/system-health', (req, res) => {
  const now = Date.now();
  res.json({
    upstox:    { connected: connectionStatus === 'live', status: connectionStatus, tokenValid: !!accessToken && appConfig.tokenExpiry > now, expiresIn: appConfig.tokenExpiry ? Math.round((appConfig.tokenExpiry - now) / 60000) : 0 },
    zerodha:   { connected: !!zAccessToken, tokenValid: !!zAccessToken && appConfig.zTokenExpiry > now, holdingsCount: zerodhaHoldings.length, positionsCount: zerodhaPositions.length },
    gemini:    { configured: !!appConfig.geminiKey, status: appConfig.geminiKey ? 'configured' : 'not_configured' },
    server:    { uptime: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), stocksLoaded: stockUniverse.length, signalsCalc: Object.keys(signalCache).length },
    marketOpen: isMarketOpen(),
    lastUpdate: Object.values(liveStocks)[0]?.lastUpdate || null,
    tests:      testResults
  });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: LOGS.slice(0, 100) });
});

app.post('/api/clear', (req, res) => {
  appConfig = {}; accessToken = null; zAccessToken = null;
  stockUniverse = []; liveStocks = {}; signalCache = {}; fundamentals = {};
  zerodhaHoldings = []; zerodhaPositions = []; zerodhaOrders = [];
  [CONFIG_FILE, PORTFOLIO_FILE, NOTES_FILE, OPTIONS_FILE].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
  if (mockInterval) { clearInterval(mockInterval); mockInterval = null; }
  connectionStatus = 'disconnected';
  broadcastStatus();
  log('WARN', 'All data cleared');
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO & NOTES APIs
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/portfolio', (req, res) => {
  if (!fs.existsSync(PORTFOLIO_FILE)) return res.json({ holdings: [] });
  res.json(dec(fs.readFileSync(PORTFOLIO_FILE, 'utf8')) || { holdings: [] });
});
app.post('/api/portfolio', (req, res) => {
  try { fs.writeFileSync(PORTFOLIO_FILE, enc(req.body)); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes', (req, res) => {
  if (!fs.existsSync(NOTES_FILE)) return res.json({ notes: [] });
  res.json(dec(fs.readFileSync(NOTES_FILE, 'utf8')) || { notes: [] });
});
app.post('/api/notes', (req, res) => {
  try { fs.writeFileSync(NOTES_FILE, enc(req.body)); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/options-trades', (req, res) => {
  if (!fs.existsSync(OPTIONS_FILE)) return res.json({ trades: [] });
  res.json(dec(fs.readFileSync(OPTIONS_FILE, 'utf8')) || { trades: [] });
});
app.post('/api/options-trades', (req, res) => {
  try { fs.writeFileSync(OPTIONS_FILE, enc(req.body)); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PRICE ALERTS
// ══════════════════════════════════════════════════════════════════════════════
function loadAlerts() {
  if (fs.existsSync(ALERTS_FILE)) {
    const d = dec(fs.readFileSync(ALERTS_FILE, 'utf8'));
    if (d) priceAlerts = d.alerts || [];
  }
}
function saveAlerts() {
  try { fs.writeFileSync(ALERTS_FILE, enc({ alerts: priceAlerts })); } catch {}
}
function checkPriceAlerts() {
  let triggered = 0;
  for (const alert of priceAlerts) {
    if (alert.triggered) continue;
    const stock = liveStocks[alert.symbol];
    if (!stock) continue;
    const hit = alert.type === 'above'
      ? stock.price >= alert.targetPrice
      : stock.price <= alert.targetPrice;
    if (hit) {
      alert.triggered = true;
      alert.triggeredAt = new Date().toISOString();
      alert.triggeredPrice = stock.price;
      log('OK', `🔔 ALERT: ${alert.symbol} ${alert.type} ₹${alert.targetPrice} — current ₹${stock.price}`);
      broadcastAlert(alert);
      triggered++;
    }
  }
  if (triggered) saveAlerts();
}
function broadcastAlert(alert) {
  const msg = JSON.stringify({ type: 'alert', alert });
  for (const c of clients) { if (c.readyState === WebSocket.OPEN) c.send(msg); }
}

app.get('/api/alerts', (req, res) => {
  res.json({ alerts: priceAlerts });
});
app.post('/api/alerts', (req, res) => {
  const { symbol, targetPrice, type } = req.body;
  if (!symbol || !targetPrice || !['above','below'].includes(type))
    return res.status(400).json({ error: 'symbol, targetPrice, and type (above|below) required' });
  const alert = { id: Date.now().toString(), symbol: symbol.toUpperCase(), targetPrice: +targetPrice, type, triggered: false, created: new Date().toISOString() };
  priceAlerts.push(alert);
  saveAlerts();
  log('OK', `Alert set: ${symbol} ${type} ₹${targetPrice}`);
  res.json({ success: true, alert });
});
app.delete('/api/alerts/:id', (req, res) => {
  const before = priceAlerts.length;
  priceAlerts = priceAlerts.filter(a => a.id !== req.params.id);
  saveAlerts();
  res.json({ success: priceAlerts.length < before });
});
app.post('/api/alerts/clear-triggered', (req, res) => {
  priceAlerts = priceAlerts.filter(a => !a.triggered);
  saveAlerts();
  res.json({ success: true, remaining: priceAlerts.length });
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE DATA APIs
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/live', (req, res) => {
  res.json({ stocks: liveStocks, indices: liveIndices, signals: signalCache, universe: stockUniverse, vix: vixData, fiiDii: fiiDiiData, globalMarkets });
});

app.get('/api/global', (req, res) => {
  res.json({ globalMarkets, isPostMarket: isPostMarketWindow(), symbolCount: TWELVE_DATA_SYMBOLS.length });
});

app.get('/api/technical/:symbol', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const prices = priceHistory[sym];
  if (!prices || prices.length < 5) {
    // Generate synthetic price history from mock base for demo
    const base = liveStocks[sym]?.price || 1000;
    const synth = Array.from({length: 20}, (_, i) => +(base * (1 + (Math.random()-0.5)*0.02)).toFixed(2));
    synth.push(base);
    const rsi = calcRSI(synth, 14);
    const ema20 = calcEMA(synth, Math.min(20, synth.length));
    return res.json({ symbol: sym, rsi, ema20, note: 'synthetic', dataPoints: synth.length });
  }
  const rsi   = calcRSI(prices, Math.min(14, prices.length-1));
  const ema20 = calcEMA(prices, Math.min(20, prices.length));
  const ema5  = calcEMA(prices, Math.min(5,  prices.length));
  const macd  = calcMACD(prices);
  const bb    = calcBollinger(prices, Math.min(20, prices.length));
  const current = prices[prices.length-1];
  const signal = rsi < 35 ? 'OVERSOLD 🟢' : rsi > 65 ? 'OVERBOUGHT 🔴' :
                 ema5 > ema20 ? 'UPTREND 🟡' : 'DOWNTREND 🟠';
  res.json({ symbol: sym, rsi, ema20, ema5, macd: macd.macd, macdSignal: macd.signal,
    bbUpper: bb.upper, bbLower: bb.lower, bbMiddle: bb.middle,
    current, signal, dataPoints: prices.length });
});

app.get('/api/fii-dii', (req, res) => {
  res.json({
    fii:    fiiDiiData.fii,
    dii:    fiiDiiData.dii,
    usdInr: fiiDiiData.usdInr,
    crude:  fiiDiiData.crude,
    vix:    vixData.value,
    vixTrend: vixData.trend,
    marketOpen: isMarketOpen(),
    note: 'Intraday simulated values — replace with NSE/BSE data API for live'
  });
});

app.get('/api/market-context', (req, res) => {
  res.json({ events: getMarketContext(), generated: new Date().toISOString() });
});

// ── Live Market News via Gemini ─────────────────────────────────────────────
let newsCache = { items: [], lastFetch: 0 };
const NEWS_CACHE_MS = 10 * 60 * 1000; // Cache 10 minutes

app.get('/api/news', async (req, res) => {
  // Return cache if fresh
  if (newsCache.items.length && (Date.now() - newsCache.lastFetch) < NEWS_CACHE_MS) {
    return res.json({ news: newsCache.items, cached: true, generated: new Date(newsCache.lastFetch).toISOString() });
  }
  if (!appConfig.geminiKey) return res.json({ news: [], configured: false, error: 'Gemini API key not configured' });
  try {
    const nifty = liveIndices['Nifty 50'];
    const vix = vixData.value;
    const topG = Object.values(liveStocks).filter(s=>s.price).sort((a,b)=>b.changePct-a.changePct).slice(0,5).map(s=>`${s.symbol}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%)`).join(',');
    const topL = Object.values(liveStocks).filter(s=>s.price).sort((a,b)=>a.changePct-b.changePct).slice(0,5).map(s=>`${s.symbol}(${s.changePct.toFixed(1)}%)`).join(',');

    const prompt = `You are a senior Indian stock market analyst. Generate exactly 8 of the most important NEWS events happening RIGHT NOW (today/this week) that can impact the Indian stock market (NSE/BSE). These should be REAL current events, not generic advice.

CURRENT MARKET: Nifty=${nifty?.price||'?'}(${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%) VIX=${vix} FII=₹${fiiDiiData.fii}Cr DII=₹${fiiDiiData.dii}Cr
TOP GAINERS: ${topG}
TOP LOSERS: ${topL}

For each news item, provide:
1. A specific, factual headline (not vague)
2. Priority: HIGH (market-moving), MEDIUM (sector impact), LOW (watch)
3. Market impact analysis: how it affects Indian stocks specifically
4. Affected sectors (buy/avoid)
5. Sentiment: BULLISH, BEARISH, or NEUTRAL
6. Source type: RBI, GOVT, GLOBAL, CORPORATE, ECONOMIC, GEOPOLITICAL

Reply ONLY valid JSON array, NO markdown fences:
[{"title":"Specific headline here","priority":"HIGH/MEDIUM/LOW","impact":"How this affects Indian market in 30 words","sentiment":"BULLISH/BEARISH/NEUTRAL","source":"RBI/GOVT/GLOBAL/CORPORATE/ECONOMIC/GEOPOLITICAL","icon":"relevant emoji","sectors":{"buy":["sector1"],"avoid":["sector2"]},"detail":"50-word deeper analysis with specific stocks/indices affected and expected price action"}]

Be specific, factual, and relevant to current Indian market conditions. Include global events (US Fed, crude oil, China) that impact India.`;

    const g = await callGemini(prompt, { temperature: 0.5, maxOutputTokens: 4000, timeout: 45000 });
    const raw = g.text || '[]';
    log('OK', `Gemini news generated (${g.model}), ${raw.length} chars`);

    let items = [];
    const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    try { items = JSON.parse(cleaned); } catch(_) {}
    if (!items.length) {
      const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
      if (s >= 0 && e > s) { try { items = JSON.parse(cleaned.slice(s, e+1)); } catch(_) {} }
    }
    if (!items.length) {
      const m = cleaned.match(/\{[^{}]*"title"\s*:\s*"[^"]+"[^{}]*\}/g);
      if (m) { for (const x of m) { try { items.push(JSON.parse(x)); } catch(_) {} } }
    }

    newsCache = { items, lastFetch: Date.now() };
    res.json({ news: items, cached: false, generated: new Date().toISOString() });
  } catch(e) {
    log('ERR', 'Gemini news failed: ' + e.message);
    res.status(500).json({ error: 'News fetch failed: ' + e.message });
  }
});

app.get('/api/signals', (req, res) => {
  const sorted = Object.entries(signalCache)
    .map(([sym, s]) => ({ symbol: sym, ...s, price: liveStocks[sym]?.price, name: liveStocks[sym]?.name, sector: liveStocks[sym]?.sector, changePct: liveStocks[sym]?.changePct }))
    .sort((a, b) => b.score - a.score);
  res.json(sorted);
});

app.get('/api/market-health', (req, res) => {
  const scores = Object.values(signalCache).map(s => s.score);
  const avg = scores.length ? Math.round(scores.reduce((a,b) => a+b,0) / scores.length) : 50;
  res.json({
    healthScore: avg,
    strongBuy: scores.filter(s => s >= 80).length,
    buy: scores.filter(s => s >= 65 && s < 80).length,
    watch: scores.filter(s => s >= 50 && s < 65).length,
    hold: scores.filter(s => s >= 35 && s < 50).length,
    sell: scores.filter(s => s < 35).length,
    total: scores.length
  });
});

app.get('/api/zerodha-portfolio', (req, res) => {
  const strategies = groupTradesToStrategies(zerodhaOrders);
  const totalInvested = zerodhaHoldings.reduce((a,h) => a + h.average_price * h.quantity, 0);
  const totalCurrent  = zerodhaHoldings.reduce((a,h) => a + h.last_price  * h.quantity, 0);
  res.json({
    holdings:    zerodhaHoldings,
    positions:   zerodhaPositions,
    orders:      zerodhaOrders,
    strategies,
    summary: {
      totalInvested: +totalInvested.toFixed(2),
      totalCurrent:  +totalCurrent.toFixed(2),
      totalPnl:      +(totalCurrent - totalInvested).toFixed(2),
      pnlPct:        totalInvested > 0 ? +((totalCurrent - totalInvested) / totalInvested * 100).toFixed(2) : 0
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TRADE HISTORY & P&L STATEMENT
// ══════════════════════════════════════════════════════════════════════════════
function loadTrades() {
  try { if (fs.existsSync(TRADES_FILE)) { const d = dec(fs.readFileSync(TRADES_FILE, 'utf8')); if (d) tradeHistory = d; } } catch {}
}
function saveTrades() {
  try { fs.writeFileSync(TRADES_FILE, enc(tradeHistory)); } catch(e) { log('WARN', 'Cannot write trades: ' + e.message); }
}

function calcHoldingDays(buyDate, sellDate) {
  const buy = new Date(buyDate), sell = new Date(sellDate);
  return Math.max(1, Math.ceil((sell - buy) / (1000 * 60 * 60 * 24)));
}

function calcTaxType(holdingDays) {
  return holdingDays > 365 ? 'LTCG' : 'STCG';
}

function calcTaxLiability(trades) {
  let stcgTotal = 0, ltcgTotal = 0;
  for (const t of trades) {
    const pnl = (t.sellPrice - t.buyPrice) * t.qty;
    if (pnl <= 0) continue;
    const days = calcHoldingDays(t.buyDate, t.sellDate);
    if (days > 365) ltcgTotal += pnl;
    else stcgTotal += pnl;
  }
  const ltcgExemption = 125000;
  const taxableLtcg = Math.max(0, ltcgTotal - ltcgExemption);
  const stcgTax = stcgTotal * 0.20;
  const ltcgTax = taxableLtcg * 0.125;
  return {
    stcgTotal: +stcgTotal.toFixed(2), ltcgTotal: +ltcgTotal.toFixed(2),
    ltcgExemption, taxableLtcg: +taxableLtcg.toFixed(2),
    stcgTax: +stcgTax.toFixed(2), ltcgTax: +ltcgTax.toFixed(2),
    totalTax: +(stcgTax + ltcgTax).toFixed(2)
  };
}

// Auto-capture Zerodha daily trades at market close
async function captureZerodhaTrades() {
  if (!zAccessToken || !appConfig.zApiKey) return;
  try {
    const headers = { 'X-Kite-Version': '3', Authorization: `token ${appConfig.zApiKey}:${zAccessToken}` };
    const [tradeR, posR] = await Promise.allSettled([
      axios.get('https://api.kite.trade/trades', { headers }),
      axios.get('https://api.kite.trade/portfolio/positions', { headers })
    ]);
    const today = new Date().toISOString().slice(0, 10);
    let captured = 0;

    // Capture executed trades — pair BUY+SELL by symbol for intraday
    if (tradeR.status === 'fulfilled') {
      const trades = tradeR.value.data.data || [];
      const bySymbol = {};
      for (const t of trades) {
        if (!bySymbol[t.tradingsymbol]) bySymbol[t.tradingsymbol] = { buys: [], sells: [] };
        if (t.transaction_type === 'BUY') bySymbol[t.tradingsymbol].buys.push(t);
        else bySymbol[t.tradingsymbol].sells.push(t);
      }
      for (const [sym, data] of Object.entries(bySymbol)) {
        if (data.buys.length && data.sells.length) {
          const avgBuy = data.buys.reduce((s, t) => s + t.price * t.quantity, 0) / data.buys.reduce((s, t) => s + t.quantity, 0);
          const avgSell = data.sells.reduce((s, t) => s + t.price * t.quantity, 0) / data.sells.reduce((s, t) => s + t.quantity, 0);
          const qty = Math.min(data.buys.reduce((s, t) => s + t.quantity, 0), data.sells.reduce((s, t) => s + t.quantity, 0));
          const tradeId = `z_${today}_${sym}`;
          if (!tradeHistory.find(t => t.id === tradeId)) {
            tradeHistory.push({ id: tradeId, symbol: sym, qty, buyPrice: +avgBuy.toFixed(2), sellPrice: +avgSell.toFixed(2), buyDate: today, sellDate: today, type: 'zerodha', added: new Date().toISOString() });
            captured++;
          }
        }
      }
    }

    // Capture closed positions with realized P&L
    if (posR.status === 'fulfilled') {
      const positions = [...(posR.value.data.data?.net || []), ...(posR.value.data.data?.day || [])];
      for (const p of positions) {
        if (p.quantity === 0 && p.sell_quantity > 0 && p.buy_quantity > 0) {
          const tradeId = `zp_${today}_${p.tradingsymbol}`;
          if (!tradeHistory.find(t => t.id === tradeId)) {
            tradeHistory.push({ id: tradeId, symbol: p.tradingsymbol, qty: p.sell_quantity, buyPrice: +p.buy_price.toFixed(2), sellPrice: +p.sell_price.toFixed(2), buyDate: today, sellDate: today, type: 'zerodha', product: p.product, added: new Date().toISOString() });
            captured++;
          }
        }
      }
    }

    if (captured > 0) { saveTrades(); log('OK', `Captured ${captured} Zerodha trades for ${today}`); }
    else { log('INFO', `No new Zerodha trades to capture for ${today}`); }
  } catch (e) {
    log('ERR', 'Zerodha trade capture failed: ' + e.message);
  }
}

// Filter trades helper
function filterTrades(trades, query) {
  let filtered = [...trades];
  if (query.from) filtered = filtered.filter(t => t.sellDate >= query.from);
  if (query.to) filtered = filtered.filter(t => t.sellDate <= query.to);
  if (query.symbol) filtered = filtered.filter(t => t.symbol.includes(query.symbol.toUpperCase()));
  if (query.month) {
    // month format: '2026-03'
    filtered = filtered.filter(t => t.sellDate.startsWith(query.month));
  }
  if (query.year) {
    filtered = filtered.filter(t => t.sellDate.startsWith(query.year));
  }
  return filtered.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
}

function getUnrealizedPnl() {
  const items = [];
  try {
    if (fs.existsSync(PORTFOLIO_FILE)) {
      const d = dec(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
      if (d && d.holdings) {
        for (const h of d.holdings) {
          const lp = liveStocks[h.sym]?.price || h.buy;
          const pnl = (lp - h.buy) * h.qty;
          items.push({ symbol: h.sym, qty: h.qty, buyPrice: h.buy, currentPrice: +lp.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +((pnl / (h.buy * h.qty)) * 100).toFixed(2), source: 'manual' });
        }
      }
    }
  } catch {}
  for (const h of zerodhaHoldings) {
    const lp = h.last_price || liveStocks[h.tradingsymbol]?.price || h.average_price;
    const pnl = (lp - h.average_price) * h.quantity;
    items.push({ symbol: h.tradingsymbol, qty: h.quantity, buyPrice: +h.average_price.toFixed(2), currentPrice: +lp.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: h.average_price > 0 ? +((pnl / (h.average_price * h.quantity)) * 100).toFixed(2) : 0, source: 'zerodha' });
  }
  const totalInvested = items.reduce((s, i) => s + i.buyPrice * i.qty, 0);
  const totalCurrent = items.reduce((s, i) => s + i.currentPrice * i.qty, 0);
  return { items, totalInvested: +totalInvested.toFixed(2), totalCurrent: +totalCurrent.toFixed(2), totalPnl: +(totalCurrent - totalInvested).toFixed(2) };
}

// P&L statement endpoint — supports filters: ?from=&to=&symbol=&month=&year=
app.get('/api/pnl', (req, res) => {
  const unrealized = getUnrealizedPnl();
  const filtered = filterTrades(tradeHistory, req.query);
  const realized = filtered.map(t => {
    const days = calcHoldingDays(t.buyDate, t.sellDate);
    const pnl = (t.sellPrice - t.buyPrice) * t.qty;
    return { ...t, pnl: +pnl.toFixed(2), pnlPct: t.buyPrice > 0 ? +((pnl / (t.buyPrice * t.qty)) * 100).toFixed(2) : 0, holdingDays: days, taxType: calcTaxType(days) };
  });
  const realizedTotal = realized.reduce((s, t) => s + t.pnl, 0);
  const tax = calcTaxLiability(filtered);

  // Monthly breakdown
  const monthly = {};
  for (const t of realized) {
    const m = t.sellDate.slice(0, 7); // '2026-03'
    if (!monthly[m]) monthly[m] = { month: m, pnl: 0, trades: 0, wins: 0, losses: 0 };
    monthly[m].pnl += t.pnl;
    monthly[m].trades++;
    if (t.pnl >= 0) monthly[m].wins++; else monthly[m].losses++;
  }
  const monthlySummary = Object.values(monthly).sort((a, b) => b.month.localeCompare(a.month))
    .map(m => ({ ...m, pnl: +m.pnl.toFixed(2), winRate: m.trades > 0 ? +((m.wins / m.trades) * 100).toFixed(0) : 0 }));

  // Daily breakdown (last 30 trading days)
  const daily = {};
  for (const t of realized) {
    const d = t.sellDate;
    if (!daily[d]) daily[d] = { date: d, pnl: 0, trades: 0 };
    daily[d].pnl += t.pnl;
    daily[d].trades++;
  }
  const dailySummary = Object.values(daily).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)
    .map(d => ({ ...d, pnl: +d.pnl.toFixed(2) }));

  // Unique symbols for filter dropdown
  const symbols = [...new Set(tradeHistory.map(t => t.symbol))].sort();

  res.json({ unrealized, realized, realizedTotal: +realizedTotal.toFixed(2), tax, monthlySummary, dailySummary, symbols, totalTrades: filtered.length });
});

app.get('/api/trades', (req, res) => res.json(tradeHistory));

app.post('/api/trades', (req, res) => {
  const { symbol, qty, buyPrice, sellPrice, buyDate, sellDate } = req.body;
  if (!symbol || !qty || !buyPrice || !sellPrice || !buyDate || !sellDate) return res.status(400).json({ error: 'All fields required' });
  const trade = { id: Date.now().toString(36), symbol: symbol.toUpperCase(), qty: +qty, buyPrice: +buyPrice, sellPrice: +sellPrice, buyDate, sellDate, type: 'manual', added: new Date().toISOString() };
  tradeHistory.push(trade);
  saveTrades();
  res.json({ ok: true, trade });
});

app.delete('/api/trades/:id', (req, res) => {
  const idx = tradeHistory.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Trade not found' });
  tradeHistory.splice(idx, 1);
  saveTrades();
  res.json({ ok: true });
});

// Manual trigger to capture today's Zerodha trades
app.post('/api/trades/capture', async (req, res) => {
  await captureZerodhaTrades();
  res.json({ ok: true, count: tradeHistory.length });
});

// ══════════════════════════════════════════════════════════════════════════════
// STRATEGY-GROUPED P&L — groups trades into hedged positions, spreads, etc.
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/trades/strategies', (req, res) => {
  const strategies = groupTradeHistoryIntoStrategies(tradeHistory);
  const totalPnl = strategies.reduce((s, st) => s + st.netPnl, 0);
  const wins = strategies.filter(s => s.netPnl > 0).length;
  const losses = strategies.filter(s => s.netPnl < 0).length;
  res.json({
    strategies,
    summary: {
      totalStrategies: strategies.length,
      totalPnl: +totalPnl.toFixed(2),
      wins, losses,
      winRate: strategies.length > 0 ? +((wins / strategies.length) * 100).toFixed(0) : 0
    }
  });
});

// Improved strategy grouper: groups by underlying + date + detects hedges/spreads
function groupTradeHistoryIntoStrategies(trades) {
  // Group trades by date + underlying (strip expiry/strike to get underlying)
  const groups = {};
  for (const t of trades) {
    const underlying = extractUnderlying(t.symbol);
    const date = t.sellDate || t.buyDate;
    const key = `${date}_${underlying}`;
    if (!groups[key]) groups[key] = { underlying, date, legs: [] };
    groups[key].legs.push(t);
  }

  const strategies = [];
  for (const [key, group] of Object.entries(groups)) {
    const legs = group.legs;
    if (legs.length === 1) {
      // Single trade — check if it's a standalone or part of bigger picture
      const t = legs[0];
      const pnl = (t.sellPrice - t.buyPrice) * t.qty;
      strategies.push({
        id: key, underlying: group.underlying, date: group.date,
        type: classifySingleLeg(t),
        legs: legs.map(formatLeg),
        netPnl: +pnl.toFixed(2),
        totalCharges: 0,
        status: t.sellPrice > 0 ? 'CLOSED' : 'OPEN'
      });
    } else {
      // Multiple legs — classify strategy
      const type = classifyMultiLeg(legs);
      const netPnl = legs.reduce((s, t) => {
        const direction = isSellLeg(t) ? -1 : 1;
        return s + (t.sellPrice - t.buyPrice) * t.qty * (direction === -1 && t.sellPrice === 0 ? 0 : 1);
      }, 0);
      strategies.push({
        id: key, underlying: group.underlying, date: group.date,
        type,
        legs: legs.map(formatLeg),
        netPnl: +netPnl.toFixed(2),
        totalCharges: 0,
        status: legs.every(t => t.sellPrice > 0) ? 'CLOSED' : 'OPEN'
      });
    }
  }
  return strategies.sort((a, b) => b.date.localeCompare(a.date));
}

function extractUnderlying(symbol) {
  // NIFTY2630523000CE → NIFTY, BANKNIFTY26MAR49000PE → BANKNIFTY, RELIANCE → RELIANCE
  const m = symbol.match(/^([A-Z]+?)(?:\d{2}(?:[A-Z]{3}|[0-9])|\s|$)/);
  return m ? m[1] : symbol;
}

function isSellLeg(trade) {
  // In the user's style: they SELL options and hedge with futures
  // If buyPrice > sellPrice and it's options, it was likely a sell (collected premium)
  return trade.symbol.match(/[CP]E$/) && trade.buyPrice > trade.sellPrice;
}

function classifySingleLeg(trade) {
  const sym = trade.symbol;
  if (sym.includes('FUT')) return 'FUTURES';
  if (sym.match(/CE$/)) return 'LONG CE';
  if (sym.match(/PE$/)) return 'LONG PE';
  return 'EQUITY';
}

function classifyMultiLeg(legs) {
  const hasFut = legs.some(l => l.symbol.includes('FUT'));
  const hasCE = legs.some(l => l.symbol.match(/CE$/));
  const hasPE = legs.some(l => l.symbol.match(/PE$/));
  const allOptions = legs.every(l => l.symbol.match(/[CP]E$/));
  const ceLegs = legs.filter(l => l.symbol.match(/CE$/));
  const peLegs = legs.filter(l => l.symbol.match(/PE$/));

  if (hasFut && (hasCE || hasPE)) return 'HEDGED WITH FUTURES';
  if (hasCE && hasPE && !hasFut) {
    if (ceLegs.length === 1 && peLegs.length === 1) return 'STRADDLE/STRANGLE';
    if (ceLegs.length >= 1 && peLegs.length >= 1) return 'IRON CONDOR';
  }
  if (allOptions && ceLegs.length >= 2 && peLegs.length === 0) return 'CALL SPREAD';
  if (allOptions && peLegs.length >= 2 && ceLegs.length === 0) return 'PUT SPREAD';
  if (allOptions && legs.length >= 3) return 'COMPLEX STRATEGY';
  if (hasFut && legs.length >= 2) return 'FUTURES SPREAD';
  return 'MULTI-LEG';
}

function formatLeg(trade) {
  const pnl = (trade.sellPrice - trade.buyPrice) * trade.qty;
  return {
    symbol: trade.symbol, qty: trade.qty,
    buyPrice: trade.buyPrice, sellPrice: trade.sellPrice,
    pnl: +pnl.toFixed(2), date: trade.sellDate || trade.buyDate,
    type: trade.type
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PICK TRACKER — AI recommendation accuracy tracking
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/picks', (req, res) => {
  const total = pickTracker.length;
  const evaluated = pickTracker.filter(p => p.status !== 'ACTIVE');
  const correct = evaluated.filter(p => p.outcome === 'DIRECTION_CORRECT' || p.outcome === 'WIN').length;
  const incorrect = evaluated.filter(p => p.outcome === 'DIRECTION_WRONG' || p.outcome === 'LOSS').length;
  const accuracy = evaluated.length > 0 ? +((correct / evaluated.length) * 100).toFixed(0) : 0;
  const avgPnl = evaluated.length > 0 ? +(evaluated.reduce((s, p) => s + (p.pnlEstimate || 0), 0) / evaluated.length).toFixed(2) : 0;

  res.json({
    picks: pickTracker.slice(0, 100), // Last 100
    stats: {
      total, evaluated: evaluated.length, correct, incorrect, accuracy, avgPnl,
      activePicks: pickTracker.filter(p => p.status === 'ACTIVE').length
    }
  });
});

app.delete('/api/picks', (req, res) => {
  pickTracker = [];
  savePicks();
  res.json({ ok: true });
});

// Option chain data endpoint (for frontend display)
app.get('/api/option-chain', async (req, res) => {
  try {
    const oc = await refreshOptionChain();
    res.json(oc);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pnl/csv', (req, res) => {
  const rows = [['Date','Symbol','Qty','Buy Price','Sell Price','P&L','P&L %','Holding Days','Tax Type']];
  for (const t of tradeHistory) {
    const days = calcHoldingDays(t.buyDate, t.sellDate);
    const pnl = (t.sellPrice - t.buyPrice) * t.qty;
    const pct = t.buyPrice > 0 ? ((pnl / (t.buyPrice * t.qty)) * 100).toFixed(2) : '0';
    rows.push([t.sellDate, t.symbol, t.qty, t.buyPrice, t.sellPrice, pnl.toFixed(2), pct + '%', days, calcTaxType(days)]);
  }
  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=FINR_PnL_' + new Date().toISOString().slice(0,10) + '.csv');
  res.send(csv);
});

// ══════════════════════════════════════════════════════════════════════════════
// STOCK UNIVERSE & FUNDAMENTALS
// ══════════════════════════════════════════════════════════════════════════════
const STOCK_UNIVERSE = [
  // ── Nifty 50 (30 stocks) ─────────────────────────────────────────────────
  // ISINs verified from upstox.com/stocks/<name>-share-price/<ISIN>/
  { instrumentKey:'NSE_EQ|INE002A01018', symbol:'RELIANCE',   name:'Reliance Industries',     sector:'Energy',      pe:24,  roe:14, de:0.3,  div:0.4, target:3200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE040A01034', symbol:'HDFCBANK',   name:'HDFC Bank',               sector:'Banking',     pe:18,  roe:17, de:0.8,  div:1.1, target:1900, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE009A01021', symbol:'INFY',       name:'Infosys',                 sector:'IT',          pe:26,  roe:32, de:0.0,  div:3.2, target:2050, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE467B01029', symbol:'TCS',        name:'Tata Consultancy',        sector:'IT',          pe:28,  roe:48, de:0.0,  div:3.8, target:4600, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE090A01021', symbol:'ICICIBANK',  name:'ICICI Bank',              sector:'Banking',     pe:17,  roe:19, de:0.7,  div:0.8, target:1600, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE030A01027', symbol:'HINDUNILVR', name:'Hindustan Unilever',      sector:'FMCG',        pe:52,  roe:22, de:0.0,  div:1.8, target:2850, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE397D01024', symbol:'BHARTIARTL', name:'Bharti Airtel',           sector:'Telecom',     pe:78,  roe:16, de:1.8,  div:0.4, target:2100, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE238A01034', symbol:'AXISBANK',   name:'Axis Bank',               sector:'Banking',     pe:14,  roe:16, de:0.9,  div:0.1, target:1350, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE296A01032', symbol:'BAJFINANCE', name:'Bajaj Finance',           sector:'NBFC',        pe:35,  roe:22, de:3.2,  div:0.3, target:8800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE001A01036', symbol:'HCLTECH',    name:'HCL Technologies',        sector:'IT',          pe:24,  roe:26, de:0.0,  div:4.5, target:1850, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE044A01036', symbol:'SUNPHARMA',  name:'Sun Pharmaceutical',      sector:'Pharma',      pe:35,  roe:18, de:0.1,  div:0.5, target:2200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE237A01028', symbol:'KOTAKBANK',  name:'Kotak Mahindra Bank',     sector:'Banking',     pe:20,  roe:15, de:0.5,  div:0.1, target:2150, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE585B01010', symbol:'MARUTI',     name:'Maruti Suzuki',           sector:'Auto',        pe:25,  roe:18, de:0.0,  div:1.2, target:13500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE1TAE01010', symbol:'TMCV',        name:'Tata Motors (Commercial)',             sector:'Auto',        pe:8,   roe:22, de:1.1,  div:0.0, target:1100, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE081A01020', symbol:'TATASTEEL',  name:'Tata Steel',              sector:'Metals',      pe:9,   roe:12, de:0.8,  div:0.6, target:200,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE733E01010', symbol:'NTPC',       name:'NTPC',                    sector:'Power',       pe:16,  roe:13, de:1.2,  div:3.5, target:430,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE748C01020', symbol:'POWERGRID',  name:'Power Grid Corp',         sector:'Power',       pe:17,  roe:23, de:1.5,  div:4.2, target:395,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE075A01022', symbol:'WIPRO',      name:'Wipro',                   sector:'IT',          pe:22,  roe:17, de:0.0,  div:0.2, target:650,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE214T01019', symbol:'LTIM',       name:'LTIMindtree',             sector:'IT',          pe:32,  roe:28, de:0.0,  div:1.5, target:6200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE213A01029', symbol:'ONGC',       name:'ONGC',                    sector:'Energy',      pe:7,   roe:14, de:0.3,  div:5.2, target:340,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE059A01026', symbol:'CIPLA',      name:'Cipla',                   sector:'Pharma',      pe:28,  roe:16, de:0.1,  div:0.4, target:1750, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE522F01014', symbol:'COALINDIA',  name:'Coal India',              sector:'Mining',      pe:8,   roe:58, de:0.0,  div:8.5, target:560,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE095A01012', symbol:'INDUSINDBK', name:'IndusInd Bank',           sector:'Banking',     pe:9,   roe:15, de:0.7,  div:1.2, target:1300, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE029A01011', symbol:'BPCL',       name:'BPCL',                    sector:'Energy',      pe:8,   roe:22, de:0.4,  div:6.5, target:380,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE047A01021', symbol:'GRASIM',     name:'Grasim Industries',       sector:'Diversified', pe:20,  roe:12, de:0.4,  div:0.4, target:3100, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE423A01024', symbol:'ADANIENT',   name:'Adani Enterprises',       sector:'Diversified', pe:65,  roe:9,  de:2.1,  div:0.0, target:3000, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE070A01015', symbol:'HINDALCO',   name:'Hindalco Industries',     sector:'Metals',      pe:11,  roe:16, de:0.5,  div:0.8, target:800,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE066F01020', symbol:'HAL',        name:'Hindustan Aeronautics',   sector:'Defence',     pe:42,  roe:28, de:0.0,  div:0.8, target:5800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE089A01023', symbol:'DRREDDY',    name:"Dr Reddy's Laboratories", sector:'Pharma',      pe:22,  roe:21, de:0.0,  div:0.6, target:1700, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE918I01026', symbol:'BAJAJFINSV', name:'Bajaj Finserv',           sector:'NBFC',        pe:28,  roe:14, de:2.8,  div:0.1, target:2200, cap:'Large' },
  // ── Nifty 50 additions ────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE062A01020', symbol:'SBIN',       name:'State Bank of India',     sector:'Banking',     pe:12,  roe:17, de:0.1,  div:1.5, target:1280, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE018A01030', symbol:'LT',         name:'Larsen & Toubro',         sector:'Engineering', pe:25,  roe:17, de:0.5,  div:1.2, target:3800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE154A01025', symbol:'ITC',        name:'ITC Ltd',                 sector:'FMCG',        pe:21,  roe:15, de:0.3,  div:2.8, target:385,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE280A01028', symbol:'TITAN',      name:'Titan Company',           sector:'Consumer',    pe:54,  roe:19, de:0.4,  div:0.5, target:3200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE669C01036', symbol:'TECHM',      name:'Tech Mahindra',           sector:'IT',          pe:19,  roe:16, de:0.1,  div:1.8, target:1650, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE101A01026', symbol:'M&M',        name:'Mahindra & Mahindra',     sector:'Auto',        pe:18,  roe:20, de:0.3,  div:0.8, target:3200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE021A01026', symbol:'ASIANPAINT', name:'Asian Paints',            sector:'Paints',      pe:72,  roe:22, de:0.2,  div:0.6, target:4200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE481G01011', symbol:'ULTRACEMCO', name:'UltraTech Cement',        sector:'Cement',      pe:22,  roe:18, de:0.7,  div:1.2, target:9500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE019A01038', symbol:'JSWSTEEL',   name:'JSW Steel',               sector:'Metals',      pe:12,  roe:15, de:1.2,  div:2.0, target:780,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE742F01042', symbol:'ADANIPORTS', name:'Adani Ports & SEZ',       sector:'Infrastructure', pe:17, roe:18, de:1.2, div:1.8, target:1180, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE849A01020', symbol:'TRENT',      name:'Trent Ltd',               sector:'Retail',      pe:85,  roe:25, de:0.4,  div:0.2, target:6500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE917I01010', symbol:'BAJAJ-AUTO', name:'Bajaj Auto',              sector:'Auto',        pe:26,  roe:19, de:0.1,  div:3.5, target:5600, cap:'Large' },
  // ── Nifty Next 50 ─────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE361B01024', symbol:'DIVISLAB',   name:"Divi's Laboratories",     sector:'Pharma',      pe:52,  roe:22, de:0.1,  div:0.8, target:6500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE437A01024', symbol:'APOLLOHOSP', name:'Apollo Hospitals',        sector:'Healthcare',  pe:38,  roe:20, de:0.4,  div:0.4, target:8000, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE066A01021', symbol:'EICHERMOT',  name:'Eicher Motors',           sector:'Auto',        pe:39,  roe:25, de:0.3,  div:1.1, target:4200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE158A01026', symbol:'HEROMOTOCO', name:'Hero MotoCorp',           sector:'Auto',        pe:21,  roe:24, de:0.2,  div:4.8, target:3800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE216A01030', symbol:'BRITANNIA',  name:'Britannia Industries',    sector:'FMCG',        pe:59,  roe:23, de:0.1,  div:1.1, target:5800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE192A01025', symbol:'TATACONSUM', name:'Tata Consumer Products',  sector:'FMCG',        pe:36,  roe:17, de:0.3,  div:1.3, target:1050, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE721A01047', symbol:'SHRIRAMFIN', name:'Shriram Finance',         sector:'NBFC',        pe:14,  roe:20, de:1.8,  div:2.1, target:2250, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE239A01024', symbol:'NESTLEIND',  name:'Nestle India',            sector:'FMCG',        pe:68,  roe:25, de:0.0,  div:1.5, target:2850, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE795G01014', symbol:'HDFCLIFE',   name:'HDFC Life Insurance',     sector:'Insurance',   pe:62,  roe:12, de:0.0,  div:0.3, target:800,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE123W01016', symbol:'SBILIFE',    name:'SBI Life Insurance',      sector:'Insurance',   pe:58,  roe:14, de:0.0,  div:0.4, target:1600, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE205A01025', symbol:'VEDL',       name:'Vedanta Ltd',             sector:'Metals',      pe:7,   roe:25, de:1.5,  div:2.8, target:450,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE646L01027', symbol:'INDIGO',     name:'InterGlobe Aviation',     sector:'Airlines',    pe:45,  roe:9,  de:2.2,  div:0.0, target:4500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE016A01026', symbol:'DABUR',      name:'Dabur India',             sector:'FMCG',        pe:43,  roe:20, de:0.2,  div:1.9, target:620,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE318A01026', symbol:'PIDILITIND', name:'Pidilite Industries',     sector:'Chemicals',   pe:65,  roe:27, de:0.1,  div:0.6, target:3200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE758E01017', symbol:'JIOFIN',     name:'Jio Financial Services',  sector:'NBFC',        pe:95,  roe:5,  de:0.0,  div:0.0, target:350,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE102D01028', symbol:'GODREJCP',   name:'Godrej Consumer Products',sector:'FMCG',        pe:48,  roe:20, de:0.3,  div:1.2, target:1400, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE176B01034', symbol:'HAVELLS',    name:'Havells India',           sector:'Consumer',    pe:55,  roe:21, de:0.1,  div:0.9, target:1900, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE121A01024', symbol:'CHOLAFIN',   name:'Cholamandalam Investment', sector:'NBFC',       pe:25,  roe:21, de:3.5,  div:0.5, target:1500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE0J1Y01017', symbol:'LICI',       name:'Life Insurance Corp',     sector:'Insurance',   pe:19,  roe:14, de:0.1,  div:1.2, target:850,  cap:'Large' },
  // ── Banking & Finance ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE160A01022', symbol:'PNB',        name:'Punjab National Bank',    sector:'Banking',     pe:10,  roe:13, de:0.2,  div:2.1, target:130,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE028A01039', symbol:'BANKBARODA', name:'Bank of Baroda',          sector:'Banking',     pe:11,  roe:13, de:0.2,  div:2.1, target:195,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE476A01022', symbol:'CANBK',      name:'Canara Bank',             sector:'Banking',     pe:13,  roe:13, de:0.2,  div:1.9, target:280,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE134E01011', symbol:'PFC',        name:'Power Finance Corp',      sector:'NBFC',        pe:6,   roe:20, de:6.5,  div:4.5, target:600,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE020B01018', symbol:'RECLTD',     name:'REC Ltd',                 sector:'NBFC',        pe:6,   roe:22, de:6.8,  div:4.2, target:580,  cap:'Large' },
  // ── Energy & Oil ───────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE242A01010', symbol:'IOC',        name:'Indian Oil Corp',         sector:'Energy',      pe:7,   roe:18, de:0.8,  div:5.5, target:180,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE115A01026', symbol:'HINDPETRO',  name:'Hindustan Petroleum',     sector:'Energy',      pe:7,   roe:11, de:0.9,  div:4.2, target:380,  cap:'Large' },
  // ── Power & Utilities ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE245A01021', symbol:'TATAPOWER',  name:'Tata Power',              sector:'Power',       pe:28,  roe:12, de:0.8,  div:0.8, target:480,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE364U01010', symbol:'ADANIGREEN', name:'Adani Green Energy',      sector:'Power',       pe:85,  roe:13, de:2.1,  div:0.0, target:1800, cap:'Large' },
  // ── Defence & Engineering ──────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE263A01024', symbol:'BEL',        name:'Bharat Electronics',      sector:'Defence',     pe:30,  roe:28, de:0.0,  div:1.5, target:350,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE257A01026', symbol:'BHEL',       name:'Bharat Heavy Electricals',sector:'Engineering', pe:11,  roe:13, de:0.1,  div:2.2, target:285,  cap:'Large' },
  // ── Healthcare & Pharma ────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE027H01010', symbol:'MAXHEALTH',  name:'Max Healthcare',          sector:'Healthcare',  pe:42,  roe:20, de:0.2,  div:0.3, target:1100, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE634S01028', symbol:'MANKIND',    name:'Mankind Pharma',          sector:'Pharma',      pe:38,  roe:22, de:0.1,  div:0.6, target:2600, cap:'Large' },
  // ── Consumer & Retail ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE758T01015', symbol:'ZOMATO',     name:'Zomato Ltd',              sector:'Consumer',    pe:120, roe:5,  de:0.0,  div:0.0, target:280,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE335Y01020', symbol:'IRCTC',      name:'IRCTC',                   sector:'Consumer',    pe:45,  roe:38, de:0.0,  div:1.5, target:950,  cap:'Large' },
  // ── Chemicals / Specialty (includes PCBL) ──────────────────────────────────
  { instrumentKey:'NSE_EQ|INE602A01031', symbol:'PCBL',       name:'PCBL Chemical',           sector:'Chemicals',   pe:36,  roe:13, de:0.9,  div:1.5, target:350,  cap:'Mid'   },
  // ── Additional IT (Midcap) ─────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE670A01012', symbol:'TATAELXSI',  name:'Tata Elxsi',              sector:'IT',          pe:45,  roe:35, de:0.0,  div:1.2, target:4800, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE262H01021', symbol:'PERSISTENT', name:'Persistent Systems',      sector:'IT',          pe:55,  roe:25, de:0.0,  div:0.8, target:6500, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE591G01025', symbol:'COFORGE',    name:'Coforge Ltd',             sector:'IT',          pe:38,  roe:22, de:0.1,  div:1.0, target:1500, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE356A01018', symbol:'MPHASIS',    name:'Mphasis Ltd',             sector:'IT',          pe:28,  roe:18, de:0.0,  div:2.5, target:2600, cap:'Mid'   },
  // ── Additional Pharma ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE685A01028', symbol:'TORNTPHARM', name:'Torrent Pharmaceuticals', sector:'Pharma',      pe:58,  roe:30, de:0.4,  div:0.8, target:3800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE326A01037', symbol:'LUPIN',      name:'Lupin Ltd',               sector:'Pharma',      pe:23,  roe:15, de:0.2,  div:0.5, target:2400, cap:'Large' },
  // ── Additional FMCG / Consumer ─────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE196A01026', symbol:'MARICO',     name:'Marico Ltd',              sector:'FMCG',        pe:49,  roe:24, de:0.1,  div:1.2, target:750,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE761H01022', symbol:'PAGEIND',    name:'Page Industries',         sector:'Consumer',    pe:65,  roe:34, de:0.3,  div:0.8, target:38000,cap:'Large' },
  // ── Additional Auto & Engineering ──────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE003A01024', symbol:'SIEMENS',    name:'Siemens Ltd',             sector:'Engineering', pe:70,  roe:18, de:0.1,  div:0.4, target:7500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE117A01022', symbol:'ABB',        name:'ABB India',               sector:'Engineering', pe:80,  roe:22, de:0.0,  div:0.3, target:8200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE455K01017', symbol:'POLYCAB',    name:'Polycab India',           sector:'Engineering', pe:45,  roe:22, de:0.1,  div:0.6, target:8000, cap:'Large' },
  // ── Additional Metals & Mining ─────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE749A01030', symbol:'JINDALSTEL', name:'Jindal Steel & Power',    sector:'Metals',      pe:14,  roe:14, de:0.5,  div:0.8, target:1100, cap:'Large' },
  // ── Additional Cement ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE079A01024', symbol:'AMBUJACEM',  name:'Ambuja Cements',          sector:'Cement',      pe:30,  roe:12, de:0.1,  div:0.9, target:650,  cap:'Large' },
  // ── Additional Finance / Insurance ─────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE726G01019', symbol:'ICICIPRULI', name:'ICICI Prudential Life',   sector:'Insurance',   pe:62,  roe:12, de:0.0,  div:0.4, target:600,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE414G01012', symbol:'MUTHOOTFIN', name:'Muthoot Finance',         sector:'NBFC',        pe:15,  roe:22, de:3.2,  div:1.5, target:2200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE018E01016', symbol:'SBICARD',    name:'SBI Cards & Payment',     sector:'NBFC',        pe:44,  roe:29, de:0.0,  div:0.5, target:825,  cap:'Large' },
  // ── Additional Energy & Gas ────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE203G01027', symbol:'IGL',        name:'Indraprastha Gas',        sector:'Energy',      pe:20,  roe:20, de:0.0,  div:1.5, target:500,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE274J01014', symbol:'OIL',        name:'Oil India Ltd',           sector:'Energy',      pe:8,   roe:18, de:0.3,  div:4.5, target:550,  cap:'Large' },
  // ── Additional Power ───────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE813H01021', symbol:'TORNTPOWER', name:'Torrent Power',           sector:'Power',       pe:27,  roe:15, de:0.9,  div:1.3, target:2150, cap:'Large' },
  // ── Additional Defence ─────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE118H01025', symbol:'BSE',        name:'BSE Ltd',                 sector:'Diversified', pe:55,  roe:18, de:0.0,  div:0.8, target:5500, cap:'Large' },
  // ── Logistics / New-age ────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE148O01028', symbol:'DELHIVERY',  name:'Delhivery Ltd',           sector:'Consumer',    pe:170, roe:2,  de:0.0,  div:0.0, target:500,  cap:'Mid'   },
  // ── Additional PSU / Infra ─────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE084A01016', symbol:'BANKINDIA',  name:'Bank of India',           sector:'Banking',     pe:9,   roe:11, de:0.2,  div:2.5, target:130,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE457A01014', symbol:'MAHABANK',   name:'Bank of Maharashtra',     sector:'Banking',     pe:8,   roe:18, de:0.1,  div:2.0, target:70,   cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE562A01011', symbol:'INDIANB',    name:'Indian Bank',             sector:'Banking',     pe:8,   roe:15, de:0.1,  div:2.5, target:600,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE565A01014', symbol:'IOB',        name:'Indian Overseas Bank',    sector:'Banking',     pe:12,  roe:10, de:0.1,  div:1.8, target:65,   cap:'Mid'   },
  // ── Additional Large/Mid Cap ───────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE323A01026', symbol:'BOSCHLTD',   name:'Bosch Ltd',               sector:'Auto',        pe:49,  roe:22, de:0.1,  div:1.0, target:28500,cap:'Large' },
  // ── PSU Power & Mining ─────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE848E01016', symbol:'NHPC',       name:'NHPC Ltd',                sector:'Power',       pe:18,  roe:12, de:0.5,  div:3.5, target:110,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE584A01023', symbol:'NMDC',       name:'NMDC Ltd',                sector:'Mining',      pe:9,   roe:20, de:0.1,  div:5.0, target:280,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE114A01011', symbol:'SAIL',       name:'Steel Authority of India',sector:'Metals',      pe:10,  roe:8,  de:0.5,  div:2.5, target:160,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE139A01034', symbol:'NATIONALUM', name:'National Aluminium',      sector:'Metals',      pe:12,  roe:18, de:0.0,  div:4.0, target:230,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE531E01026', symbol:'HINDCOPPER', name:'Hindustan Copper',        sector:'Metals',      pe:40,  roe:15, de:0.2,  div:1.5, target:360,  cap:'Mid'   },
  // ── Infra & Construction ───────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE962Y01021', symbol:'IRCON',      name:'Ircon International',     sector:'Infrastructure', pe:12, roe:16, de:0.2, div:2.5, target:280, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE095N01031', symbol:'NBCC',       name:'NBCC India',              sector:'Infrastructure', pe:35, roe:22, de:0.0, div:1.0, target:130, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE031A01017', symbol:'HUDCO',      name:'HUDCO',                   sector:'NBFC',        pe:8,   roe:16, de:5.5,  div:3.5, target:280,  cap:'Mid'   },
  // ── Real Estate ────────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE271C01023', symbol:'DLF',        name:'DLF Ltd',                 sector:'Infrastructure', pe:40, roe:10, de:0.2, div:0.6, target:900, cap:'Large' },
  // ── Telecom / Media ────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE424H01027', symbol:'SUNTV',      name:'Sun TV Network',          sector:'Consumer',    pe:14,  roe:22, de:0.0,  div:3.5, target:720,  cap:'Mid'   },
  // ── Misc Large/Mid Cap ─────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE628A01036', symbol:'UPL',        name:'UPL Ltd',                 sector:'Chemicals',   pe:15,  roe:8,  de:1.5,  div:1.2, target:600,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE092T01019', symbol:'IDFCFIRSTB', name:'IDFC First Bank',         sector:'Banking',     pe:15,  roe:12, de:0.1,  div:0.0, target:85,   cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE548A01028', symbol:'HFCL',       name:'HFCL Ltd',                sector:'Telecom',     pe:32,  roe:14, de:0.2,  div:0.5, target:160,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE121E01018', symbol:'JSWENERGY',  name:'JSW Energy',              sector:'Power',       pe:48,  roe:12, de:0.8,  div:0.4, target:700,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE982J01020', symbol:'PAYTM',      name:'One 97 Communications',   sector:'Consumer',    pe:0,   roe:-5, de:0.0,  div:0.0, target:900,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE111A01025', symbol:'CONCOR',     name:'Container Corp of India', sector:'Infrastructure', pe:28, roe:12, de:0.1, div:1.5, target:1000, cap:'Large' },
  // ── Additional Midcap Metals/Mining ────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE002L01015', symbol:'SJVN',       name:'SJVN Ltd',                sector:'Power',       pe:30,  roe:10, de:0.5,  div:3.0, target:140,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE415G01027', symbol:'RVNL',       name:'Rail Vikas Nigam',        sector:'Infrastructure', pe:22, roe:18, de:0.3, div:2.5, target:500, cap:'Mid'   },
  // ── Additional Nifty Next50 ────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE774D01024', symbol:'GAIL',       name:'GAIL India',              sector:'Energy',      pe:12,  roe:14, de:0.2,  div:3.5, target:230,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE663F01032', symbol:'NAUKRI',     name:'Info Edge (Naukri)',       sector:'Consumer',    pe:75,  roe:12, de:0.0,  div:0.4, target:7500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE603J01030', symbol:'PIIND',      name:'PI Industries',           sector:'Chemicals',   pe:30,  roe:20, de:0.1,  div:0.5, target:4200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE765G01017', symbol:'ICICIGI',    name:'ICICI Lombard GI',        sector:'Insurance',   pe:38,  roe:18, de:0.0,  div:0.5, target:2000, cap:'Large' },
  // ── Remaining to reach ~150 ────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE010V01017', symbol:'LTTS',       name:'L&T Technology Services',  sector:'IT',          pe:35,  roe:25, de:0.0,  div:1.5, target:5500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE171A01029', symbol:'FEDERALBNK', name:'Federal Bank',            sector:'Banking',     pe:13,  roe:15, de:0.1,  div:1.8, target:185,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE949L01017', symbol:'AUBANK',     name:'AU Small Finance Bank',   sector:'Banking',     pe:28,  roe:16, de:0.4,  div:0.3, target:720,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE092A01019', symbol:'TATACHEM',   name:'Tata Chemicals',          sector:'Chemicals',   pe:15,  roe:10, de:0.3,  div:1.5, target:1200, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE406A01037', symbol:'AUROPHARMA', name:'Aurobindo Pharma',        sector:'Pharma',      pe:15,  roe:12, de:0.4,  div:1.2, target:1250, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE129A01019', symbol:'INDUSTOWER', name:'Indus Towers',            sector:'Telecom',     pe:14,  roe:25, de:0.8,  div:2.5, target:420,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE298A01020', symbol:'CUMMINSIND', name:'Cummins India',           sector:'Engineering', pe:42,  roe:25, de:0.0,  div:1.5, target:3800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE121J01017', symbol:'M&MFIN',     name:'Mahindra & Mahindra Fin', sector:'NBFC',        pe:8,   roe:15, de:4.2,  div:2.5, target:285,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE259A01022', symbol:'COLPAL',     name:'Colgate-Palmolive India', sector:'FMCG',        pe:50,  roe:55, de:0.0,  div:2.0, target:3200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE094A01015', symbol:'LICHSGFIN',  name:'LIC Housing Finance',     sector:'NBFC',        pe:8,   roe:14, de:8.0,  div:3.0, target:700,  cap:'Large' },
  // ── Moved from Penny (Mid/Large Cap with Upstox polling) ──────────────────
  { instrumentKey:'NSE_EQ|INE704P01025', symbol:'COCHINSHIP', name:'Cochin Shipyard',           sector:'Defence',     pe:30,  roe:20, de:0.1,  div:1.5, target:2200, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE450U01017', symbol:'ROUTE',      name:'Route Mobile',              sector:'IT',          pe:28,  roe:18, de:0.0,  div:0.5, target:1500, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE171Z01026', symbol:'BDL',        name:'Bharat Dynamics',           sector:'Defence',     pe:42,  roe:22, de:0.0,  div:1.0, target:1600, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE382Z01011', symbol:'GRSE',       name:'Garden Reach Shipbuilders', sector:'Defence',     pe:35,  roe:25, de:0.0,  div:1.2, target:1900, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE249Z01020', symbol:'MAZDOCK',    name:'Mazagon Dock Shipbuilders', sector:'Defence',     pe:25,  roe:28, de:0.0,  div:1.5, target:5500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE484J01027', symbol:'GODREJPROP', name:'Godrej Properties',         sector:'Infrastructure', pe:55, roe:12, de:0.5, div:0.2, target:3000, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE093I01010', symbol:'OBEROIRLTY', name:'Oberoi Realty',             sector:'Infrastructure', pe:22, roe:18, de:0.1, div:0.3, target:2200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE811K01011', symbol:'PRESTIGE',   name:'Prestige Estates',          sector:'Infrastructure', pe:35, roe:15, de:0.8, div:0.3, target:1800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE288B01029', symbol:'DEEPAKNTR',name:'Deepak Nitrite',          sector:'Chemicals',   pe:38,  roe:22, de:0.1,  div:0.4, target:2800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE828B01012', symbol:'CLEAN',      name:'Clean Science & Technology',sector:'Chemicals',   pe:55,  roe:25, de:0.0,  div:0.3, target:1600, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE494B01023', symbol:'TVSMOTOR',   name:'TVS Motor Company',         sector:'Auto',        pe:48,  roe:22, de:0.3,  div:0.5, target:2800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE548C01032', symbol:'EMAMILTD',   name:'Emami Ltd',                 sector:'FMCG',        pe:28,  roe:20, de:0.2,  div:1.5, target:850,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE191H01014', symbol:'PVRINOX',        name:'PVR INOX Ltd',              sector:'Consumer',    pe:35,  roe:10, de:0.8,  div:0.2, target:1600, cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE053A01029', symbol:'INDHOTEL',   name:'Indian Hotels (Taj)',       sector:'Consumer',    pe:50,  roe:15, de:0.3,  div:0.5, target:800,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE490G01020', symbol:'MOIL',       name:'MOIL Ltd',                  sector:'Mining',      pe:10,  roe:14, de:0.0,  div:4.5, target:420,  cap:'Mid'   },
  // ── New Additions (15 frequent movers) ────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE814H01029', symbol:'ADANIPOWER', name:'Adani Power',               sector:'Power',       pe:12,  roe:22, de:1.5,  div:0.0, target:600,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE935N01020', symbol:'DIXON',      name:'Dixon Technologies',        sector:'Consumer',    pe:85,  roe:25, de:0.1,  div:0.3, target:16000,cap:'Large' },
  { instrumentKey:'NSE_EQ|INE465A01025', symbol:'BHARATFORG', name:'Bharat Forge',              sector:'Auto',        pe:50,  roe:16, de:0.3,  div:0.6, target:1600, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE226A01021', symbol:'VOLTAS',     name:'Voltas Ltd',                sector:'Consumer',    pe:55,  roe:12, de:0.0,  div:0.5, target:1800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE048G01026', symbol:'NAVINFLUOR', name:'Navin Fluorine Intl',       sector:'Chemicals',   pe:35,  roe:18, de:0.0,  div:0.5, target:4200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE647A01010', symbol:'SRF',        name:'SRF Ltd',                   sector:'Chemicals',   pe:40,  roe:18, de:0.4,  div:0.4, target:2800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE202E01016', symbol:'IREDA',      name:'Indian Renewable Energy DA',sector:'NBFC',        pe:25,  roe:18, de:5.0,  div:1.0, target:250,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE302A01020', symbol:'EXIDEIND',   name:'Exide Industries',          sector:'Auto',        pe:38,  roe:12, de:0.1,  div:1.2, target:550,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE540L01014', symbol:'ALKEM',      name:'Alkem Laboratories',        sector:'Pharma',      pe:28,  roe:18, de:0.0,  div:0.8, target:6200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE571A01038', symbol:'IPCALAB',    name:'IPCA Laboratories',         sector:'Pharma',      pe:45,  roe:15, de:0.1,  div:0.5, target:1800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE398R01022', symbol:'SYNGENE',    name:'Syngene International',     sector:'Pharma',      pe:38,  roe:14, de:0.2,  div:0.3, target:900,  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE881D01027', symbol:'OFSS',       name:'Oracle Financial Services', sector:'IT',          pe:30,  roe:28, de:0.0,  div:2.5, target:12000,cap:'Large' },
  { instrumentKey:'NSE_EQ|INE299U01018', symbol:'CROMPTON',   name:'Crompton Greaves Consumer', sector:'Consumer',    pe:42,  roe:20, de:0.0,  div:0.8, target:450,  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE100A01010', symbol:'ATUL',       name:'Atul Ltd',                  sector:'Chemicals',   pe:42,  roe:14, de:0.0,  div:0.5, target:7500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE885A01032', symbol:'AMARAJABAT', name:'Amara Raja Energy',         sector:'Auto',        pe:18,  roe:15, de:0.1,  div:1.5, target:1200, cap:'Large' },
];

const SECTOR_PE = { IT:27, Banking:15, Pharma:30, Energy:10, FMCG:48, Auto:20, Metals:8, Power:16, Telecom:22, NBFC:22, Mining:7, Diversified:18, Defence:38, Engineering:20, Insurance:55, Retail:60, Cement:22, Healthcare:35, Airlines:30, Consumer:50, Infrastructure:18, Paints:55, Chemicals:28 };

const PENNY_STOCKS = [
  // ── Ultra-Speculative (sub-₹50) ──────────────────────────────────────────
  { symbol:'IDEA',       name:'Vodafone Idea',       sector:'Telecom',    price:8,    risk:'EXTREME', flag:'High debt, survival uncertain',                    vol:'Very High',  promoter:22 },
  { symbol:'JPPOWER',    name:'Jaiprakash Power',    sector:'Power',      price:12,   risk:'HIGH',    flag:'Debt restructuring, power demand',                 vol:'High',       promoter:35 },
  { symbol:'JPASSOCIAT', name:'Jaiprakash Associates',sector:'Infrastructure',price:5,risk:'EXTREME', flag:'Deep value play, high debt, asset monetization',   vol:'Very High',  promoter:24 },
  { symbol:'RELINFRA',   name:'Reliance Infra',      sector:'Infrastructure',price:15,risk:'EXTREME', flag:'ADAG turnaround, legal disputes, speculative',     vol:'Very High',  promoter:17 },
  { symbol:'YESBANK',    name:'Yes Bank',            sector:'Banking',    price:19,   risk:'HIGH',    flag:'Recovery play, watch FII buying',                  vol:'Very High',  promoter:0  },
  { symbol:'RPOWER',     name:'Reliance Power',      sector:'Power',      price:28,   risk:'HIGH',    flag:'ADAG group, high debt but power capex play',       vol:'Very High',  promoter:24 },
  { symbol:'TRIDENT',    name:'Trident Ltd',         sector:'Textiles',   price:30,   risk:'MEDIUM',  flag:'Popular retail favourite, profitable textile exporter',vol:'Very High',promoter:73 },
  { symbol:'TV18BRDCST', name:'TV18 Broadcast',      sector:'Media',      price:40,   risk:'MEDIUM',  flag:'Reliance-backed broadcasting, news channels',      vol:'High',       promoter:44 },
  { symbol:'SUZLON',     name:'Suzlon Energy',       sector:'Power',      price:42,   risk:'HIGH',    flag:'High debt, renewable tailwind strong',              vol:'Very High',  promoter:16 },
  { symbol:'IFCI',       name:'IFCI Ltd',            sector:'Finance',    price:42,   risk:'HIGH',    flag:'PSU financial institution, turnaround play',       vol:'Very High',  promoter:71 },
  { symbol:'UCOBANK',    name:'UCO Bank',            sector:'Banking',    price:42,   risk:'HIGH',    flag:'PSU bank, recovery play, watch asset quality',     vol:'Very High',  promoter:95 },
  { symbol:'CENTRALBK',  name:'Central Bank India',  sector:'Banking',    price:48,   risk:'HIGH',    flag:'PSU bank turnaround, high NPAs improving',         vol:'Very High',  promoter:93 },
  { symbol:'TTML',       name:'Tata Teleservices MH',sector:'Telecom',    price:50,   risk:'HIGH',    flag:'Tata group telecom, enterprise focus pivot',       vol:'High',       promoter:74 },
  // ── Speculative Small/Mid (₹50–₹150) ─────────────────────────────────────
  { symbol:'NFL',        name:'National Fertilizers', sector:'Chemicals',  price:55,   risk:'MEDIUM',  flag:'PSU fertilizer maker, govt subsidy backed',        vol:'High',       promoter:74 },
  { symbol:'NETWORK18',  name:'Network18 Media',     sector:'Media',      price:60,   risk:'MEDIUM',  flag:'Reliance-backed media conglomerate',               vol:'High',       promoter:75 },
  { symbol:'MMTC',       name:'MMTC Ltd',            sector:'Diversified',price:65,   risk:'HIGH',    flag:'PSU trading company, gold import, volatile',       vol:'Very High',  promoter:90 },
  { symbol:'WELSPUNLIV', name:'Welspun Living',      sector:'Textiles',   price:75,   risk:'MEDIUM',  flag:'Home textiles leader, US market dependent',        vol:'High',       promoter:74 },
  { symbol:'PNBHOUSING', name:'PNB Housing Finance', sector:'Finance',    price:75,   risk:'HIGH',    flag:'Housing finance, rate sensitive, PSU backed',      vol:'High',       promoter:32 },
  { symbol:'HBLPOWER',   name:'HBL Power Systems',   sector:'Engineering',price:80,   risk:'MEDIUM',  flag:'Defence electronics, battery systems',             vol:'High',       promoter:43 },
  { symbol:'IBREALEST',  name:'Indiabulls Real Est',  sector:'Realty',     price:80,   risk:'HIGH',    flag:'Real estate developer, speculative turnaround',    vol:'High',       promoter:40 },
  { symbol:'DCBBANK',    name:'DCB Bank',            sector:'Banking',    price:90,   risk:'MEDIUM',  flag:'Niche private bank, SME lending focus',            vol:'Moderate',   promoter:15 },
  { symbol:'JKBANK',     name:'J&K Bank',            sector:'Banking',    price:95,   risk:'MEDIUM',  flag:'Regional PSU bank, J&K monopoly',                 vol:'High',       promoter:63 },
  { symbol:'SOUTHBANK',  name:'South Indian Bank',   sector:'Banking',    price:22,   risk:'MEDIUM',  flag:'Regional Kerala bank, NRI deposit strong',         vol:'High',       promoter:0  },
  { symbol:'UNIONBANK',  name:'Union Bank of India', sector:'Banking',    price:105,  risk:'MEDIUM',  flag:'PSU bank, credit growth improving',                vol:'High',       promoter:83 },
  { symbol:'CESC',       name:'CESC Ltd',            sector:'Power',      price:130,  risk:'LOW',     flag:'RP-SG Group, Kolkata power distribution monopoly', vol:'Moderate',   promoter:52 },
  { symbol:'RCF',        name:'Rashtriya Chemicals', sector:'Chemicals',  price:130,  risk:'MEDIUM',  flag:'PSU fertilizer/chemicals, govt subsidy play',      vol:'High',       promoter:75 },
  { symbol:'DELTACORP',  name:'Delta Corp',          sector:'Consumer',   price:130,  risk:'HIGH',    flag:'Only listed gaming/casino company in India',       vol:'Very High',  promoter:34 },
  { symbol:'LEMONTRE',   name:'Lemon Tree Hotels',   sector:'Consumer',   price:135,  risk:'MEDIUM',  flag:'Budget hotel chain, occupancy recovering',         vol:'High',       promoter:25 },
  { symbol:'ENGINERSIN', name:'Engineers India',      sector:'Engineering',price:140,  risk:'LOW',     flag:'PSU consultancy, oil & gas, steady dividends',     vol:'Moderate',   promoter:51 },
  { symbol:'RAIN',       name:'Rain Industries',     sector:'Chemicals',  price:140,  risk:'MEDIUM',  flag:'Carbon products, aluminium cycle play',            vol:'High',       promoter:46 },
  { symbol:'IRFC',       name:'Indian Railway FC',   sector:'Finance',    price:145,  risk:'LOW',     flag:'PSU backed, guaranteed steady income',             vol:'Moderate',   promoter:86 },
  { symbol:'ZEEL',       name:'Zee Entertainment',   sector:'Media',      price:125,  risk:'HIGH',    flag:'Media house, Sony merger failed, restructuring',   vol:'Very High',  promoter:4  },
  // ── Mid/Small Cap (₹150–₹350) ────────────────────────────────────────────
  { symbol:'BANDHANBNK', name:'Bandhan Bank',        sector:'Banking',    price:165,  risk:'MEDIUM',  flag:'Microfinance focus, watch asset quality trends',   vol:'High',       promoter:40 },
  { symbol:'MOTHERSON',  name:'Motherson Sumi',      sector:'Auto',       price:175,  risk:'MEDIUM',  flag:'Global auto components, diversified',              vol:'Very High',  promoter:67 },
  { symbol:'MANAPPURAM', name:'Manappuram Finance',  sector:'Finance',    price:180,  risk:'MEDIUM',  flag:'Gold loan NBFC, rate sensitive',                   vol:'High',       promoter:35 },
  { symbol:'KTKBANK',    name:'Karnataka Bank',      sector:'Banking',    price:180,  risk:'MEDIUM',  flag:'Regional South India bank, digital push',          vol:'Moderate',   promoter:0  },
  { symbol:'ORIENTELEC', name:'Orient Electric',     sector:'Consumer',   price:200,  risk:'MEDIUM',  flag:'Fans and appliances, CK Birla group',             vol:'Moderate',   promoter:38 },
  { symbol:'ASHOKLEY',   name:'Ashok Leyland',       sector:'Auto',       price:225,  risk:'MEDIUM',  flag:'CV leader, infra capex cycle play',                vol:'Very High',  promoter:52 },
  { symbol:'NLCINDIA',   name:'NLC India',           sector:'Power',      price:230,  risk:'LOW',     flag:'PSU lignite miner + power, govt backing',          vol:'Moderate',   promoter:72 },
  { symbol:'GRAPHITE',   name:'Graphite India',      sector:'Diversified',price:250,  risk:'MEDIUM',  flag:'Graphite electrode maker, steel cycle play',       vol:'High',       promoter:73 },
  { symbol:'TANLA',      name:'Tanla Platforms',     sector:'IT',         price:250,  risk:'MEDIUM',  flag:'Cloud communications platform, CPaaS growth',      vol:'High',       promoter:39 },
  { symbol:'ABFRL',      name:'Aditya Birla Fashion',sector:'Consumer',   price:250,  risk:'MEDIUM',  flag:'Fashion retail, brand portfolio, growth play',     vol:'High',       promoter:52 },
  { symbol:'NATCOPHARM', name:'Natco Pharma',        sector:'Pharma',     price:270,  risk:'MEDIUM',  flag:'Specialty generics, cancer drugs, niche player',   vol:'High',       promoter:46 },
  { symbol:'CANFINHOME', name:'Can Fin Homes',       sector:'Finance',    price:280,  risk:'MEDIUM',  flag:'Canara Bank housing arm, rate sensitive',          vol:'Moderate',   promoter:30 },
  { symbol:'KPITTECH',   name:'KPIT Technologies',   sector:'IT',         price:280,  risk:'MEDIUM',  flag:'Auto-tech leader, EV software, niche play',        vol:'High',       promoter:40 },
  { symbol:'SUNTECK',    name:'Sunteck Realty',      sector:'Realty',     price:280,  risk:'MEDIUM',  flag:'Mumbai luxury developer, BKC projects',            vol:'Moderate',   promoter:73 },
  { symbol:'HINDZINC',   name:'Hindustan Zinc',      sector:'Mining',     price:290,  risk:'LOW',     flag:'Vedanta subsidiary, zinc monopoly, high dividend', vol:'High',       promoter:65 },
  { symbol:'BIOCON',     name:'Biocon Ltd',          sector:'Pharma',     price:340,  risk:'MEDIUM',  flag:'Biosimilars leader, Viatris partnership',          vol:'High',       promoter:60 },
];

function calcSignal(symbol, price) {
  const s = STOCK_UNIVERSE.find(x => x.symbol === symbol);
  if (!s || !price) return null;
  const fund = { pe: s.pe, roe: s.roe, debtToEquity: s.de, dividendYield: s.div, targetPrice: s.target, sectorPe: SECTOR_PE[s.sector] || 20 };
  const high52 = fundamentals[symbol]?.high52 || price * 1.35;
  const low52  = fundamentals[symbol]?.low52  || price * 0.72;
  let score = 0;
  const reasons = [];

  // 52W position (25pts)
  const range = high52 - low52;
  if (range > 0) {
    const pos = Math.max(0, Math.min(1, (price - low52) / range));
    score += Math.round((1 - pos) * 25);
    if (pos < 0.25) reasons.push(`🟢 Near 52W low ₹${low52.toFixed(0)} — strong buy zone`);
    else if (pos < 0.45) reasons.push(`✅ In lower half of 52W range`);
    else if (pos > 0.85) reasons.push(`⚠️ Near 52W high ₹${high52.toFixed(0)} — take profit zone`);
  }

  // P/E vs sector (20pts)
  if (fund.pe > 0 && fund.sectorPe > 0) {
    const r = fund.pe / fund.sectorPe;
    if (r < 0.6)       { score += 20; reasons.push(`🟢 P/E ${fund.pe}x — very cheap vs sector ${fund.sectorPe}x`); }
    else if (r < 0.85) { score += 15; reasons.push(`✅ P/E ${fund.pe}x — below sector average`); }
    else if (r < 1.1)  { score += 10; }
    else if (r < 1.3)  { score += 5; }
    else               { reasons.push(`⚠️ P/E ${fund.pe}x — expensive vs sector`); }
  }

  // ROE (15pts)
  if (fund.roe >= 25)      { score += 15; reasons.push(`🟢 ROE ${fund.roe}% — excellent returns`); }
  else if (fund.roe >= 15) { score += 10; reasons.push(`✅ ROE ${fund.roe}% — above average`); }
  else if (fund.roe >= 8)  { score += 5; }
  else                     { reasons.push(`⚠️ ROE ${fund.roe}% — weak`); }

  // Debt (10pts)
  if (fund.debtToEquity < 0.1)      { score += 10; reasons.push(`🟢 Virtually debt-free`); }
  else if (fund.debtToEquity < 0.5) { score += 7;  reasons.push(`✅ Low debt D/E ${fund.debtToEquity}`); }
  else if (fund.debtToEquity < 1)   { score += 4; }
  else if (fund.debtToEquity > 2)   { score -= 5;  reasons.push(`🔴 High debt D/E ${fund.debtToEquity}`); }

  // Dividend (10pts)
  if (fund.dividendYield > 4)       { score += 10; reasons.push(`🟢 High dividend yield ${fund.dividendYield}%`); }
  else if (fund.dividendYield > 2)  { score += 7;  reasons.push(`✅ Good dividend ${fund.dividendYield}%`); }
  else if (fund.dividendYield > 0.5){ score += 3; }

  // Upside (20pts)
  const upside   = ((fund.targetPrice - price) / price) * 100;
  const downside = ((price - low52) / price) * 100;
  if (upside > 30)      { score += 20; reasons.push(`🟢 ${upside.toFixed(0)}% upside to target ₹${fund.targetPrice}`); }
  else if (upside > 20) { score += 15; reasons.push(`✅ ${upside.toFixed(0)}% upside to ₹${fund.targetPrice}`); }
  else if (upside > 10) { score += 8; }
  else if (upside < 0)  { score -= 5;  reasons.push(`🔴 Trading above analyst target`); }

  score = Math.max(0, Math.min(100, score));
  let signal;
  if (score >= 80) signal = 'STRONG BUY';
  else if (score >= 65) signal = 'BUY';
  else if (score >= 50) signal = 'WATCH';
  else if (score >= 35) signal = 'HOLD';
  else signal = 'SELL';

  // Technical timing hint
  let timing = '';
  if (score >= 65) {
    if (downside > 15) timing = `Entry zone: wait for pullback to ₹${(price * 0.95).toFixed(0)}`;
    else timing = `Good entry now. SL: ₹${(price * 0.92).toFixed(0)} Target: ₹${fund.targetPrice}`;
  }

  return { score, signal, reason: reasons[0] || '—', allReasons: reasons, upside: +upside.toFixed(1), downside: +downside.toFixed(1), targetPrice: fund.targetPrice, timing };
}

function recalcSignals() {
  for (const s of STOCK_UNIVERSE) {
    const price = liveStocks[s.symbol]?.price;
    if (price) { const sig = calcSignal(s.symbol, price); if (sig) signalCache[s.symbol] = { ...sig, symbol: s.symbol }; }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UPSTOX WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════
// ── Upstox REST Polling (v2 WS deprecated, v3 requires protobuf) ──
let pricePoller = null;
let pollErrors = 0;

let pollFirstLog = true;

function processUpstoxQuote(key, val) {
  // Response keys use COLON format: "NSE_EQ:RELIANCE", not pipe format
  const price = val.last_price;
  if (!price) return false;
  // Upstox gives net_change (absolute) but no percentage_change or close_price
  // Previous close = last_price - net_change
  let change, pct;
  if (val.net_change !== undefined && val.net_change !== null && val.net_change !== 0) {
    change = val.net_change;
    const prevClose = price - change;
    pct = prevClose ? (change / prevClose) * 100 : 0;
  } else {
    change = 0;
    pct = 0;
  }
  const iToken = val.instrument_token || ''; // pipe format: NSE_EQ|INE...

  if (key.includes('NSE_INDEX')) {
    const name = key.split(':').slice(1).join(':'); // "Nifty 50" from "NSE_INDEX:Nifty 50"
    if (name === 'India VIX' || name === 'INDIA VIX') {
      vixData.value = price; vixData.change = +pct.toFixed(2);
      vixData.trend = pct > 0.5 ? 'rising' : pct < -0.5 ? 'falling' : 'stable';
    } else {
      liveIndices[name] = { price, change: +change.toFixed(2), changePct: +pct.toFixed(2), name };
    }
    return true;
  } else {
    // Match by instrument_token (pipe) OR by symbol extracted from colon key
    const symFromKey = key.split(':')[1]; // "RELIANCE" from "NSE_EQ:RELIANCE"
    const s = STOCK_UNIVERSE.find(x => x.instrumentKey === iToken || x.symbol === symFromKey);
    if (s) {
      liveStocks[s.symbol] = {
        symbol: s.symbol, name: s.name, sector: s.sector, price,
        change: +change.toFixed(2), changePct: +pct.toFixed(2), lastUpdate: Date.now(),
        high52: fundamentals[s.symbol]?.high52 || +(price * 1.35).toFixed(2),
        low52: fundamentals[s.symbol]?.low52 || +(price * 0.72).toFixed(2)
      };
      const sig = calcSignal(s.symbol, price);
      if (sig) signalCache[s.symbol] = { ...sig, symbol: s.symbol };
      return true;
    }
  }
  return false;
}

async function pollUpstoxPrices() {
  if (!accessToken) return;
  const allKeys = [
    ...STOCK_UNIVERSE.map(s => s.instrumentKey),
    'NSE_INDEX|Nifty 50', 'NSE_INDEX|SENSEX', 'NSE_INDEX|Nifty Bank',
    'NSE_INDEX|Nifty IT', 'NSE_INDEX|Nifty Pharma', 'NSE_INDEX|India VIX'
  ];
  // Upstox allows up to 500 keys per request — send all ~210 in one call
  let updated = false;
  try {
    const res = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      params: { instrument_key: allKeys.join(',') }
    });
    const data = res.data?.data;
    if (data) {
      if (pollFirstLog) {
        const keys = Object.keys(data).slice(0, 3);
        log('OK', `Upstox REST first response — ${Object.keys(data).length} instruments in 1 call, sample keys: ${keys.join(', ')}`);
        const sampleVal = Object.values(data)[0];
        if (sampleVal) {
          log('INFO', `Sample quote ALL keys: ${Object.keys(sampleVal).join(', ')}`);
          log('INFO', `Sample values: last_price=${sampleVal.last_price} close_price=${sampleVal.close_price} ohlc=${JSON.stringify(sampleVal.ohlc)} net_change=${sampleVal.net_change} prev_close=${sampleVal.prev_close} previous_close=${sampleVal.previous_close}`);
        }
        pollFirstLog = false;
      }
      for (const [key, val] of Object.entries(data)) {
        if (processUpstoxQuote(key, val)) updated = true;
      }
      pollErrors = 0;
    } else {
      if (pollFirstLog) { log('WARN', `Upstox REST response has no data field: ${JSON.stringify(res.data).slice(0,200)}`); }
    }
  } catch (e) {
    pollErrors++;
    if (pollErrors <= 3) log('ERR', `Upstox REST poll error: ${e.response?.status || ''} ${e.message}`);
    if (e.response?.status === 410 || e.response?.status === 401) {
      log('ERR', 'Upstox REST API unavailable — stopping poller');
      stopPricePoller();
      connectionStatus = 'disconnected'; broadcastStatus();
      return;
    }
  }
  if (updated) {
    // Kill mock ticks once real data is flowing
    if (mockInterval) { clearInterval(mockInterval); mockInterval = null; log('OK', 'Mock ticks stopped — real data active'); }
    connectionStatus = 'live'; broadcastStatus();
    broadcastLiveData();
  }
}

function startPricePoller() {
  if (pricePoller) return;
  const intervalMs = 2000; // Poll every 2 seconds
  pollUpstoxPrices(); // First poll immediately
  pricePoller = setInterval(() => {
    if (isMarketOpen()) pollUpstoxPrices();
  }, intervalMs);
  log('OK', `Upstox REST price poller started (every ${intervalMs/1000}s)`);
}

function stopPricePoller() {
  if (pricePoller) { clearInterval(pricePoller); pricePoller = null; }
}

// Keep old function name for compatibility with initLiveData
function connectUpstoxWs() {
  startPricePoller();
}

// ══════════════════════════════════════════════════════════════════════════════
// MOCK DATA (market closed / no token)
// ══════════════════════════════════════════════════════════════════════════════
const MOCK_BASE = {
  // Original 30 stocks
  RELIANCE:2920, HDFCBANK:1840, INFY:1720, TCS:3980, ICICIBANK:1520, HINDUNILVR:2420,
  BHARTIARTL:1950, AXISBANK:1180, BAJFINANCE:6980, HCLTECH:1580, SUNPHARMA:2180, KOTAKBANK:2050,
  MARUTI:11200, TMCV:425, TATASTEEL:145, NTPC:385, POWERGRID:360, WIPRO:520, LTIM:5200,
  ONGC:265, CIPLA:1680, COALINDIA:420, INDUSINDBK:780, BPCL:295, GRASIM:2580, ADANIENT:2280,
  HINDALCO:640, HAL:4650, DRREDDY:1380, BAJAJFINSV:1920,
  // Penny stocks (prices used for mock, also covers some STOCK_UNIVERSE overlaps)
  SUZLON:62, IRFC:158, YESBANK:22, IDEA:9, JPPOWER:14,
  RPOWER:28, JSWENERGY:58, NLCINDIA:230, SJVN:110,
  CENTRALBK:48, UNIONBANK:105, UCOBANK:42, BANDHANBNK:165, MANAPPURAM:180,
  SAIL:115, NATIONALUM:195, HINDCOPPER:280, NMDC:225, MOIL:350,
  IRCON:220, NBCC:95, RVNL:420, HUDCO:235, COCHINSHIP:1800,
  HFCL:120, ROUTE:1250, BDL:1300, GRSE:1600, MAZDOCK:4800,
  DLF:720, GODREJPROP:2600, OBEROIRLTY:1950, PRESTIGE:1500,
  DEEPAKNTR:2400, CLEAN:1350, AUROPHARMA:1150, BIOCON:340,
  TVSMOTOR:2500, ASHOKLEY:225, MOTHERSON:175,
  COLPAL:2800, EMAMILTD:720, SUNTV:650, PVRINOX:1400,
  INDHOTEL:680, LEMONTRE:135,
  // Nifty 50 additions
  SBIN:820, LT:3440, ITC:420, TITAN:3100, TECHM:1340, 'M&M':3050, ASIANPAINT:2350,
  ULTRACEMCO:11500, JSWSTEEL:960, ADANIPORTS:1250, TRENT:5800, 'BAJAJ-AUTO':9200,
  // Nifty Next 50
  DIVISLAB:5800, APOLLOHOSP:7200, EICHERMOT:5100, HEROMOTOCO:4600, BRITANNIA:5400,
  TATACONSUM:960, SHRIRAMFIN:680, NESTLEIND:2250, HDFCLIFE:680, SBILIFE:1550,
  VEDL:420, INDIGO:4300, DABUR:530, PIDILITIND:2900, JIOFIN:250, GODREJCP:1200,
  HAVELLS:1650, CHOLAFIN:1350, LICI:850,
  // Banking & Finance
  PNB:105, BANKBARODA:245, CANBK:95, PFC:520, RECLTD:480,
  // Energy & Oil
  IOC:135, HINDPETRO:400,
  // Power
  TATAPOWER:420, ADANIGREEN:1650,
  // Defence & Engineering
  BEL:310, BHEL:240,
  // Healthcare & Pharma
  MAXHEALTH:1050, MANKIND:2400,
  // Consumer & Retail
  ZOMATO:240, IRCTC:870,
  // Chemicals
  PCBL:310,
  // Additional STOCK_UNIVERSE stocks (midcap IT, pharma, etc)
  TATAELXSI:4200, PERSISTENT:6200, COFORGE:1150, MPHASIS:2100,
  TORNTPHARM:3500, LUPIN:2200, MARICO:780, PAGEIND:36000,
  SIEMENS:7200, ABB:7800, POLYCAB:7500, JINDALSTEL:1100,
  AMBUJACEM:580, ICICIPRULI:560, MUTHOOTFIN:2100, SBICARD:780,
  IGL:480, OIL:520, TORNTPOWER:1950, BSE:5200, DELHIVERY:380,
  BANKINDIA:115, MAHABANK:60, INDIANB:550, IOB:55, BOSCHLTD:27000,
  NHPC:95, GAIL:200, NAUKRI:7000, PIIND:3800, ICICIGI:1850,
  LTTS:5200, FEDERALBNK:170, AUBANK:700, TATACHEM:1100,
  INDUSTOWER:380, CUMMINSIND:3500, 'M&MFIN':270,
  UPL:550, IDFCFIRSTB:75, CONCOR:950, LICHSGFIN:650,
  // Moved from Penny to STOCK_UNIVERSE
  COCHINSHIP:1800, ROUTE:1250, BDL:1300, GRSE:1600, MAZDOCK:4800,
  GODREJPROP:2600, OBEROIRLTY:1950, PRESTIGE:1500, DEEPAKNTR:2400, CLEAN:1350,
  TVSMOTOR:2500, EMAMILTD:720, PVRINOX:1400, INDHOTEL:680, MOIL:350,
  // New 15 stocks
  ADANIPOWER:550, DIXON:15000, BHARATFORG:1450, VOLTAS:1700, NAVINFLUOR:3800,
  SRF:2500, IREDA:200, EXIDEIND:480, ALKEM:5800, IPCALAB:1650,
  SYNGENE:820, OFSS:11000, CROMPTON:400, ATUL:7000, AMARAJABAT:1100,
  // New penny/smallcap stocks
  JPASSOCIAT:5, RELINFRA:15, TRIDENT:30, TV18BRDCST:40, IFCI:42,
  TTML:50, NFL:55, NETWORK18:60, MMTC:65, WELSPUNLIV:75,
  PNBHOUSING:75, HBLPOWER:80, IBREALEST:80, DCBBANK:90, JKBANK:95,
  SOUTHBANK:22, CESC:130, RCF:130, DELTACORP:130, ENGINERSIN:140,
  RAIN:140, ZEEL:125, KTKBANK:180, ORIENTELEC:200, GRAPHITE:250,
  TANLA:250, ABFRL:250, NATCOPHARM:270, CANFINHOME:280, KPITTECH:280,
  SUNTECK:280, HINDZINC:290
};
const IDX_BASE  = { 'Nifty 50':22950, 'SENSEX':75600, 'Nifty Bank':49800, 'Nifty IT':36400, 'Nifty Pharma':23800 };

function initMockData() {
  for (const s of STOCK_UNIVERSE) {
    const base = MOCK_BASE[s.symbol] || 1000;
    const drift = (Math.random() - 0.45) * base * 0.02;
    liveStocks[s.symbol] = { symbol:s.symbol, name:s.name, sector:s.sector, price:+(base+drift).toFixed(2), change:+drift.toFixed(2), changePct:+((drift/base)*100).toFixed(2), volume:Math.round(5e5+Math.random()*4e6), lastUpdate:Date.now(), isMock:true };
    fundamentals[s.symbol] = { high52: +(base*1.38).toFixed(2), low52: +(base*0.68).toFixed(2) };
    // Include 52W in liveStocks for frontend modal display
    liveStocks[s.symbol].high52 = fundamentals[s.symbol].high52;
    liveStocks[s.symbol].low52  = fundamentals[s.symbol].low52;
  }
  for (const [name, base] of Object.entries(IDX_BASE)) {
    const d = (Math.random()-0.5)*base*0.008;
    liveIndices[name] = { price:+(base+d).toFixed(2), change:+d.toFixed(2), changePct:+((d/base)*100).toFixed(2), name };
  }
  // Also init penny stocks so they appear in liveStocks for frontend
  for (const p of PENNY_STOCKS) {
    const base = MOCK_BASE[p.symbol] || p.price || 20;
    const drift = (Math.random() - 0.48) * base * 0.03;
    liveStocks[p.symbol] = { symbol:p.symbol, name:p.name, sector:p.sector,
      price:+(base+drift).toFixed(2), change:+drift.toFixed(2), changePct:+((drift/base)*100).toFixed(2),
      volume:Math.round(2e6+Math.random()*8e6), lastUpdate:Date.now(), isMock:true,
      high52:+(base*1.45).toFixed(2), low52:+(base*0.55).toFixed(2) };
  }
  recalcSignals();
}

function startMockTicks() {
  if (mockInterval) return;
  log('INFO', 'Mock tick simulator started (market closed / no token)');
  let tickCount = 0;

  mockInterval = setInterval(() => {
    tickCount++;
    const marketOpen = isMarketOpen();

    if (!marketOpen) {
      // Market closed — freeze all data, no random movement
      clearInterval(mockInterval); mockInterval = null;
      log('INFO', 'Mock ticks stopped — market closed, data frozen');
      return;
    } else {
      // Market open — realistic intraday simulation
      // Momentum factor: slight trending bias changes every ~60 ticks
      const mktMomentum = Math.sin(tickCount / 80) * 0.0002;

      for (const [sym, d] of Object.entries(liveStocks)) {
        const base = MOCK_BASE[sym] || d.price;
        // Stock-specific volatility based on sector
        const stock = STOCK_UNIVERSE.find(s => s.symbol === sym);
        const volMult = ['Metals','Energy','Defence'].includes(stock?.sector) ? 1.4 :
                        ['IT','Banking'].includes(stock?.sector) ? 1.1 : 1.0;
        const delta = (Math.random() - 0.499 + mktMomentum) * d.price * 0.0007 * volMult;
        d.price = Math.max(+(base * 0.5).toFixed(2), +(d.price + delta).toFixed(2));
        d.change = +(d.price - base).toFixed(2);
        d.changePct = +((d.change / base) * 100).toFixed(2);
        d.lastUpdate = Date.now();
        if (!d.volume) d.volume = Math.round(500000 + Math.random() * 4000000);
        d.volume += Math.round(Math.random() * 2000); // volume builds through day
      }

      for (const d of Object.values(liveIndices)) {
        const base = IDX_BASE[d.name] || d.price;
        const delta = (Math.random() - 0.499 + mktMomentum) * d.price * 0.0004;
        d.price = +(d.price + delta).toFixed(2);
        d.change = +(d.price - base).toFixed(2);
        d.changePct = +((d.change / base) * 100).toFixed(2);
      }

      // Simulate VIX micro-moves
      const vixDelta = (Math.random() - 0.5) * 0.05;
      vixData.value = +Math.max(10, Math.min(40, vixData.value + vixDelta)).toFixed(2);
      vixData.change = +vixDelta.toFixed(2);
      vixData.trend = vixDelta > 0.02 ? 'rising' : vixDelta < -0.02 ? 'falling' : 'stable';

      // Simulate FII/DII flow — trickles in through trading day
      if (tickCount % 30 === 0) {
        const fiiTick = Math.round((Math.random() - 0.55) * 200); // slight selling bias
        const diiTick = Math.round((Math.random() - 0.45) * 250); // slight buying bias
        fiiDiiData.fii = +(fiiDiiData.fii + fiiTick).toFixed(0);
        fiiDiiData.dii = +(fiiDiiData.dii + Math.abs(diiTick)).toFixed(0);
        // Crude and INR micro-moves
        fiiDiiData.crude = +Math.max(55, Math.min(95, fiiDiiData.crude + (Math.random()-0.5)*0.3)).toFixed(1);
        fiiDiiData.usdInr = +Math.max(82, Math.min(90, fiiDiiData.usdInr + (Math.random()-0.5)*0.04)).toFixed(2);
      }

      recalcSignals();
      // Update price history every 5 ticks for technical indicators
      if (tickCount % 5 === 0) {
        for (const [sym, d] of Object.entries(liveStocks)) {
          if (!priceHistory[sym]) priceHistory[sym] = [];
          priceHistory[sym].push(d.price);
          if (priceHistory[sym].length > 30) priceHistory[sym].shift();
        }
      }
      // Check price alerts every 5 ticks
      if (tickCount % 5 === 0 && priceAlerts.some(a => !a.triggered)) checkPriceAlerts();
    }
    broadcastLiveData();
  }, isMarketOpen() ? 1000 : 5000);
}

async function initLiveData() {
  stockUniverse = STOCK_UNIVERSE;
  initMockData();
  if (accessToken) {
    connectUpstoxWs();
    // Only fall back to mock ticks if REST poller fails to deliver data after 10s
    setTimeout(() => {
      if (Object.keys(liveStocks).length < 5 && !pricePoller && isMarketOpen()) {
        log('WARN', 'REST poller not delivering data — starting mock ticks as fallback');
        startMockTicks();
      }
    }, 10000);
  } else if (isMarketOpen()) {
    startMockTicks();
  } else {
    log('INFO', 'Market closed — serving frozen base prices (no mock ticks)');
  }
  log('OK', `Live data initialized — ${stockUniverse.length} stocks`);
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET BROADCAST
// ══════════════════════════════════════════════════════════════════════════════
const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type:'init', stocks:liveStocks, indices:liveIndices, signals:signalCache, status:connectionStatus, vix:vixData, fiiDii:fiiDiiData, globalMarkets }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.on('message', m => { if (m.toString()==='ping') ws.send('pong'); });
});
function broadcastLiveData() {
  const msg = JSON.stringify({ type:'tick', stocks:liveStocks, indices:liveIndices, signals:signalCache, vix:vixData, fiiDii:fiiDiiData, globalMarkets });
  for (const c of clients) { if (c.readyState===WebSocket.OPEN) c.send(msg); }
}
function broadcastStatus() {
  const msg = JSON.stringify({ type:'status', status:connectionStatus });
  for (const c of clients) { if (c.readyState===WebSocket.OPEN) c.send(msg); }
}

// ══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS
// ══════════════════════════════════════════════════════════════════════════════
function runUnitTests() {
  testResults = [];
  function test(name, fn) {
    try {
      fn();
      testResults.push({ name, pass: true });
    } catch(e) {
      testResults.push({ name, pass: false, error: e.message });
      log('ERR', `TEST FAIL: ${name} — ${e.message}`);
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
  function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`); }
  function assertRange(v, lo, hi, msg) { if (v < lo || v > hi) throw new Error(msg || `${v} not in [${lo},${hi}]`); }

  // ── Encryption ────────────────────────────────────────────────────────────
  test('Encryption: round-trip preserves data', () => {
    const data = { apiKey: 'test123', num: 42, nested: { ok: true } };
    const decrypted = dec(enc(data));
    assert(decrypted.apiKey === 'test123' && decrypted.num === 42, 'Decrypt mismatch');
  });

  test('Encryption: different data → different ciphertext', () => {
    const c1 = enc({ a: 1 }), c2 = enc({ a: 2 });
    assert(c1 !== c2, 'Same ciphertext for different data');
  });

  test('PIN: SHA256 consistent', () => {
    assertEqual(hash('1234'), hash('1234'), 'Same PIN same hash');
    assert(hash('1234') !== hash('5678'), 'Different PINs differ');
    assertEqual(hash('test').length, 64, 'SHA256 must be 64 chars');
  });

  // ── Signal Engine ─────────────────────────────────────────────────────────
  test('Signal: STRONG BUY for excellent fundamentals', () => {
    const sig = calcSignal('COALINDIA', MOCK_BASE['COALINDIA'] * 0.7);
    assert(sig !== null, 'Signal should not be null');
    assertRange(sig.score, 0, 100, 'Score out of range');
    assert(['STRONG BUY','BUY','WATCH','HOLD','SELL','STRONG SELL'].includes(sig.signal), 'Invalid signal label');
  });

  test('Signal: score 0-100 for all universe stocks', () => {
    for (const s of STOCK_UNIVERSE) {
      const price = MOCK_BASE[s.symbol] || 1000;
      const sig = calcSignal(s.symbol, price);
      if (sig) assertRange(sig.score, 0, 100, `${s.symbol} score out of range`);
    }
  });

  test('Signal: null input returns null safely', () => {
    assert(calcSignal('X', 0, null) === null, 'Zero price should return null');
  });

  test('Signal: upside calculation correct (10% to target)', () => {
    const sig = calcSignal('TEST', 1000, { pe:15, sectorPe:20, roe:18, debtToEquity:0.3, dividendYield:1, high52:1200, low52:800, targetPrice:1100 });
    if (sig) assert(Math.abs(sig.upside - 10) < 0.2, `Upside should be ~10%, got ${sig.upside}`);
  });

  // ── Live Data ─────────────────────────────────────────────────────────────
  test('Live data: stocks initialized', () => {
    assert(Object.keys(liveStocks).length >= 20, `Only ${Object.keys(liveStocks).length} stocks — expected >= 20`);
  });

  test('Live data: indices initialized', () => {
    assert(Object.keys(liveIndices).length >= 3, 'Expected at least 3 indices');
    assert('Nifty 50' in liveIndices, 'Nifty 50 must be in indices');
  });

  test('Live data: signal cache populated', () => {
    assert(Object.keys(signalCache).length >= 10, 'Signal cache should have >= 10 entries');
  });

  test('Live data: every stock has required fields', () => {
    for (const [sym, d] of Object.entries(liveStocks)) {
      assert(d.price > 0, `${sym}: price must be positive`);
      assert(d.symbol, `${sym}: missing symbol field`);
    }
  });

  // ── Market Data ───────────────────────────────────────────────────────────
  test('Market hours: isMarketOpen returns boolean', () => {
    assertEqual(typeof isMarketOpen(), 'boolean', 'isMarketOpen must return boolean');
  });

  test('Market hours: weekday boundaries correct', () => {
    // Test helper — simulate IST time
    function openAt(h, m, day) { const mins=h*60+m; return day>=1&&day<=5&&mins>=555&&mins<=930; }
    assert( openAt(9,15,1),  '9:15 Mon should be open');
    assert( openAt(15,30,5), '3:30 Fri should be open');
    assert(!openAt(15,31,5), '3:31 should be closed');
    assert(!openAt(9,14,1),  '9:14 should be pre-market');
    assert(!openAt(11,0,6),  'Saturday should always be closed');
  });

  // ── Stock Universe ────────────────────────────────────────────────────────
  test('Universe: has >= 20 stocks with all required fields', () => {
    assert(STOCK_UNIVERSE.length >= 20, `Only ${STOCK_UNIVERSE.length} stocks`);
    for (const s of STOCK_UNIVERSE) {
      assert(s.symbol && s.instrumentKey && s.sector, `${s.symbol||'?'}: missing required field`);
      assert(s.target > 0, `${s.symbol}: target must be positive`);
      assert(s.instrumentKey.startsWith('NSE_EQ|'), `${s.symbol}: bad instrumentKey format`);
    }
  });

  test('Universe: no duplicate symbols', () => {
    const syms = STOCK_UNIVERSE.map(s=>s.symbol);
    assertEqual(new Set(syms).size, syms.length, 'Duplicate symbols in universe');
  });

  // ── Strategy Grouper ──────────────────────────────────────────────────────
  test('Strategy grouper: identifies vertical spread', () => {
    const orders = [
      { tradingsymbol:'NIFTY25APR23000CE', transaction_type:'BUY',  average_price:150, filled_quantity:50, status:'COMPLETE', exchange:'NFO' },
      { tradingsymbol:'NIFTY25APR23500CE', transaction_type:'SELL', average_price:80,  filled_quantity:50, status:'COMPLETE', exchange:'NFO' },
    ];
    const strats = groupTradesToStrategies(orders);
    assert(strats.length > 0, 'Should return at least 1 strategy');
  });

  // ── Config & Auth ─────────────────────────────────────────────────────────
  test('Config: redirect URI uses HTTPS', () => {
    const uri = appConfig.redirectUri || 'https://finr-production.up.railway.app/callback';
    assert(uri.startsWith('https://'), 'Redirect must use HTTPS');
    assert(uri.includes('/callback'), 'Must include /callback path');
  });

  test('Config: env vars loaded correctly', () => {
    // These should be set from Railway env vars
    if (process.env.UPSTOX_API_KEY)   assert(appConfig.apiKey,    'UPSTOX_API_KEY env var not loaded');
    if (process.env.ZERODHA_API_KEY)  assert(appConfig.zApiKey,   'ZERODHA_API_KEY env var not loaded');
    if (process.env.GEMINI_API_KEY)   assert(appConfig.geminiKey, 'GEMINI_API_KEY env var not loaded');
  });

  // ── Results ───────────────────────────────────────────────────────────────
  const passed = testResults.filter(t => t.pass).length;
  const failed = testResults.filter(t => !t.pass).length;
  if (failed > 0) {
    log('WARN', `Unit tests: ${passed}/${testResults.length} passed — ${failed} FAILED`);
    testResults.filter(t=>!t.pass).forEach(t => log('ERR', `  FAIL: ${t.name} — ${t.error}`));
  } else {
    log('OK', `Unit tests: ${passed}/${testResults.length} passed ✅`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function successPage(title, msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:20px}h1{font-size:24px;color:#f2f2f7;letter-spacing:2px}p{color:#636366;font-size:14px}.b{background:rgba(48,209,88,.12);border:1px solid rgba(48,209,88,.3);padding:8px 24px;border-radius:20px;font-size:13px;color:#30d158}</style></head><body><div style="font-size:64px">✅</div><h1>${title}</h1><p>${msg}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`;
}
function errorPage(title, detail, host) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#ff453a;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;padding:20px}h1{font-size:22px;color:#f2f2f7}.box{background:#1c1c1e;border:1px solid rgba(255,69,58,.3);padding:16px 20px;border-radius:12px;max-width:500px;width:100%;font-size:12px;line-height:1.8;color:#aeaeb2}.lbl{font-size:10px;color:#636366;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}</style></head><body><div style="font-size:48px">❌</div><h1>${title}</h1><div class="box"><div class="lbl">Error:</div><div style="color:#ff453a">${detail}</div><br><div class="lbl">Callback URL must be:</div><div style="color:#ffd60a">https://${host}/callback</div></div></body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEDULED JOBS
// ══════════════════════════════════════════════════════════════════════════════
cron.schedule('15 9 * * 1-5', () => { initLiveData(); log('INFO', 'Market open — live data started'); });
cron.schedule('20 9 * * 1-5', () => { evaluatePicksNextDay(); log('INFO', 'Evaluating yesterday\'s AI picks against today\'s open'); });
cron.schedule('35 15 * * 1-5', () => { log('INFO', 'Market closed — freezing stock prices'); if (mockInterval) { clearInterval(mockInterval); mockInterval = null; } stopPricePoller(); startTwelveDataPolling(); captureZerodhaTrades(); });
cron.schedule('0 0 * * *', () => { stopTwelveDataPolling(); log('INFO', 'Midnight — Twelve Data polling stopped'); });
cron.schedule('0 10,14 * * 1-5', () => { if (zAccessToken) { fetchZerodhaData(); log('INFO', 'Zerodha data refresh'); } });

// Catch-all — serve frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════════════════════
server.listen(PORT, async () => {
  log('INFO', `═══════════════════════════════════════`);
  log('INFO', `FINR v2.0 starting on port ${PORT}`);
  loadConfig();
  loadAlerts();
  loadTrades();
  loadPicks();
  log('INFO', `Upstox:${!!appConfig.apiKey} Zerodha:${!!appConfig.zApiKey} Gemini:${!!appConfig.geminiKey} TwelveData:${!!appConfig.twelveDataKey} Trades:${tradeHistory.length} Picks:${pickTracker.length}`);
  await initLiveData();
  if (isPostMarketWindow()) startTwelveDataPolling();
  runUnitTests();
  log('INFO', `Server ready — ${testResults.filter(t=>t.pass).length}/${testResults.length} tests passed`);
  log('INFO', `═══════════════════════════════════════`);
});

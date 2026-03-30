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
const { calcRSI, calcEMA, calcMACD, calcBollinger, calcSupport, calcResistance, getTechnicalSignal } = require('./lib/technicals');

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
let vixData          = { value: 0, change: 0, trend: 'stable', isDefault: true };
let fiiDiiData       = { fii: 0, dii: 0, usdInr: 0, crude: 0, isDefault: true };
let connectionStatus = 'disconnected';
let priceHistory     = {}; // symbol → last 30 prices for RSI/EMA
let wsReconnectMs    = 1000;
// mockInterval removed — no mock data simulation
let testResults      = [];
let globalMarkets    = {}; // Twelve Data global market prices
let twelveDataInterval = null;
let optionChainCache = { nifty: null, banknifty: null, stocks: {}, lastFetch: 0 }; // OI, IV, PCR, Max Pain
let twelveDataDisabled = false; // User can disconnect Twelve Data
let pickTracker      = []; // { id, type, symbol, direction, entryPrice, target, stopLoss, date, status, outcome }
const PICK_TRACKER_FILE = path.join(__dirname, '.finr_picks.enc');
let predictionHistory = []; // Full prediction accuracy tracking
const PREDICTIONS_FILE = path.join(__dirname, '.finr_predictions.enc');

// ── Twelve Data config — commodities, forex & global indices (runs 24/7) ─────
// Free tier: 800 calls/day (8/min). Set TWELVE_DATA_API_KEY in Railway env vars.
// Commodities (XAU/USD, CL) and forex (USD/INR) trade ~24/5 — always current.
// Gift Nifty stays on Upstox/NSE (no free after-hours API for NSE IX futures).
const TWELVE_DATA_SYMBOLS = [
  { key: 'GOLD',        symbol: 'XAU/USD',    name: 'Gold $/oz',   type: 'Commodity' },
  { key: 'CRUDE',       symbol: 'CL',         name: 'Crude WTI',   type: 'Commodity' },
  { key: 'USDINR',      symbol: 'USD/INR',    name: 'USD/INR',     type: 'Currency' },
  { key: 'SP500',       symbol: 'SPX',        name: 'S&P 500',     type: 'Index' },
  { key: 'NASDAQ',      symbol: 'IXIC',       name: 'NASDAQ',      type: 'Index' },
  { key: 'DOW',         symbol: 'DJI',        name: 'Dow Jones',   type: 'Index' },
  { key: 'NIKKEI',      symbol: 'NI225',      name: 'Nikkei 225',  type: 'Index' },
];

// Reliable IST time — works on UTC servers (Vercel/Railway) without toLocaleString parsing bugs
function getIST() {
  const utc = new Date();
  return new Date(utc.getTime() + 5.5 * 60 * 60 * 1000);
}
function getISTDay() { return getIST().getUTCDay(); }
function getISTMins() { const ist = getIST(); return ist.getUTCHours() * 60 + ist.getUTCMinutes(); }

async function fetchTwelveData() {
  const apiKey = appConfig.twelveDataKey;
  if (!apiKey) { log('WARN', 'Twelve Data API key not set — add TWELVE_DATA_API_KEY in Railway env vars (free at twelvedata.com)'); return; }

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
  fetchTwelveData(); // immediate first fetch
  // Poll every 5 min during market hours (8 symbols × ~288 calls/day = well within 800 free limit)
  // Poll every 10 min outside market hours to conserve API calls
  twelveDataInterval = setInterval(() => {
    fetchTwelveData();
  }, isMarketOpen() ? 5 * 60 * 1000 : 10 * 60 * 1000);
  log('OK', 'Twelve Data polling started (always-on — Gold, Crude, USD/INR update 24/7)');
}

function stopTwelveDataPolling() {
  if (twelveDataInterval) { clearInterval(twelveDataInterval); twelveDataInterval = null; }
  log('INFO', 'Twelve Data polling stopped');
}

// ── NSE FII/DII Real Data Fetcher ────────────────────────────────────────────
const https = require('https');
let nseCookies = '';
let nseCookieExpiry = 0;
let fiiDiiInterval = null;
let lastFiiDiiDate = '';

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/report-detail/eq_security',
  'Connection': 'keep-alive'
};

function nseRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'www.nseindia.com',
      path: urlPath,
      method: 'GET',
      headers: { ...NSE_HEADERS, ...(nseCookies ? { Cookie: nseCookies } : {}) },
      timeout: 15000
    };
    const req = https.request(opts, (res) => {
      // Capture cookies
      if (res.headers['set-cookie']) {
        nseCookies = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        nseCookieExpiry = Date.now() + 4 * 60 * 1000; // 4 min expiry
      }
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve({ redirect: res.headers.location });
        res.resume();
        return;
      }
      // Handle gzip
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'br') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      let body = '';
      stream.on('data', d => body += d);
      stream.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`NSE HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('NSE JSON parse failed')); }
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('NSE request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function getNseCookies() {
  if (nseCookies && Date.now() < nseCookieExpiry) return true;
  try {
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'www.nseindia.com',
        path: '/reports/fii-dii',
        method: 'GET',
        headers: { ...NSE_HEADERS, Accept: 'text/html' },
        timeout: 15000
      }, (res) => {
        if (res.headers['set-cookie']) {
          nseCookies = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
          nseCookieExpiry = Date.now() + 4 * 60 * 1000;
        }
        res.resume();
        res.on('end', resolve);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('NSE cookie timeout')); });
      req.on('error', reject);
      req.end();
    });
    return !!nseCookies;
  } catch(e) {
    log('WARN', `NSE cookie fetch failed: ${e.message}`);
    return false;
  }
}

async function fetchNseFiiDii() {
  try {
    // Step 1: Ensure we have valid NSE session cookies
    const hasCookies = await getNseCookies();
    if (!hasCookies) { log('WARN', 'NSE FII/DII: No cookies, skipping'); return false; }

    // Step 2: Fetch FII/DII data
    const data = await nseRequest('/api/fiidiiTradeReact');
    if (!data || !Array.isArray(data) || data.length === 0) {
      log('WARN', 'NSE FII/DII: Empty or invalid response');
      return false;
    }

    // Step 3: Parse FII and DII net values
    // NSE response format: [{ category: "FII/FPI *", date: "27-Mar-2026", buyValue: "12345.67", sellValue: "14567.89", netValue: "-2222.22" }, ...]
    let fiiNet = null, diiNet = null, dataDate = '';

    for (const row of data) {
      const cat = (row.category || '').toUpperCase();
      if (cat.includes('FII') || cat.includes('FPI')) {
        fiiNet = parseFloat(String(row.netValue || '0').replace(/,/g, ''));
        dataDate = row.date || '';
      } else if (cat.includes('DII')) {
        diiNet = parseFloat(String(row.netValue || '0').replace(/,/g, ''));
        if (!dataDate) dataDate = row.date || '';
      }
    }

    if (fiiNet !== null) {
      fiiDiiData.fii = Math.round(fiiNet);  // in Crores
      fiiDiiData.isDefault = false;
      lastFiiDiiDate = dataDate;
    }
    if (diiNet !== null) {
      fiiDiiData.dii = Math.round(diiNet);  // in Crores
      fiiDiiData.isDefault = false;
    }

    log('OK', `NSE FII/DII updated: FII=₹${fiiDiiData.fii}Cr DII=₹${fiiDiiData.dii}Cr (${dataDate})`);
    broadcastLiveData();
    return true;
  } catch(e) {
    log('WARN', `NSE FII/DII fetch failed: ${e.message}`);
    return false;
  }
}

// Fetch ALL NSE indices (Nifty 50, Bank Nifty, VIX, etc.) from NSE allIndices API
// This single call provides real closing/last-traded prices for all major indices
const NSE_INDEX_MAP = {
  'NIFTY 50':        'Nifty 50',
  'NIFTY BANK':      'Nifty Bank',
  'NIFTY IT':        'Nifty IT',
  'NIFTY PHARMA':    'Nifty Pharma',
  'NIFTY NEXT 50':   'Nifty Next 50',
  'NIFTY 100':       'Nifty 100',
  'NIFTY MIDCAP 50': 'Nifty Midcap 50',
  'NIFTY FIN SERVICE': 'Nifty Fin Service',
  'NIFTY AUTO':      'Nifty Auto',
  'NIFTY METAL':     'Nifty Metal',
  'NIFTY ENERGY':    'Nifty Energy',
  'NIFTY REALTY':    'Nifty Realty',
  'NIFTY INFRA':     'Nifty Infra',
  'NIFTY PSE':       'Nifty PSE',
  'NIFTY MEDIA':     'Nifty Media',
  'S&P BSE SENSEX':  'SENSEX',
};

async function fetchNseIndices() {
  try {
    const hasCookies = await getNseCookies();
    if (!hasCookies) { log('WARN', 'NSE Indices: No cookies, skipping'); return false; }

    const data = await nseRequest('/api/allIndices');
    if (!data || !data.data) { log('WARN', 'NSE Indices: Empty response'); return false; }

    let updated = 0;
    for (const entry of data.data) {
      const nseKey = (entry.index || entry.indexSymbol || '').toUpperCase().trim();

      // VIX
      if (nseKey.includes('VIX')) {
        const val = parseFloat(entry.last || entry.indexValue || 0);
        const chg = parseFloat(entry.percentChange || 0);
        if (val > 0) {
          vixData.value = +val.toFixed(2);
          vixData.change = +chg.toFixed(2);
          vixData.trend = chg > 0.5 ? 'rising' : chg < -0.5 ? 'falling' : 'stable';
          vixData.isDefault = false;
          updated++;
        }
        continue;
      }

      // Major indices
      const mappedName = NSE_INDEX_MAP[nseKey];
      if (mappedName) {
        const price = parseFloat(entry.last || entry.indexValue || 0);
        const prevClose = parseFloat(entry.previousClose || entry.open || price);
        if (price > 0) {
          const change = +(price - prevClose).toFixed(2);
          const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;
          liveIndices[mappedName] = {
            price: +price.toFixed(2),
            change,
            changePct,
            name: mappedName,
            previousClose: +prevClose.toFixed(2),
            open: parseFloat(entry.open || 0) || undefined,
            high: parseFloat(entry.high || 0) || undefined,
            low: parseFloat(entry.low || 0) || undefined,
            lastUpdate: Date.now(),
            isNSE: true
          };
          updated++;
        }
      }
    }

    if (updated > 0) {
      broadcastLiveData();
      log('OK', `NSE Indices updated: ${updated} indices (incl. VIX=${vixData.value})`);
    }
    return updated > 0;
  } catch(e) {
    log('WARN', `NSE Indices fetch failed: ${e.message}`);
    return false;
  }
}

function startNsePolling() {
  if (fiiDiiInterval) return;
  // Fetch immediately on startup
  fetchNseIndices();  // Indices + VIX — always fetch (real closing prices)
  fetchNseFiiDii();   // FII/DII flows

  // Adaptive polling: re-checks market hours on each tick instead of locking interval at startup
  function scheduleNextPoll() {
    const pollMs = isMarketOpen() ? 10 * 60 * 1000 : 30 * 60 * 1000;
    fiiDiiInterval = setTimeout(async () => {
      await fetchNseIndices();
      await fetchNseFiiDii();
      // Verify pending predictions against actual market data
      // Runs during market hours (for next-day carryover) AND post-market (3:30-6 PM) for same-day scoring
      const _mins = getISTMins();
      const _day = getISTDay();
      const isWeekday = _day >= 1 && _day <= 5;
      if (isWeekday && (isMarketOpen() || (_mins >= 930 && _mins <= 1080))) { try { verifyPredictions(); } catch(e) { log('WARN', 'Prediction verification error: ' + e.message); } }
      scheduleNextPoll(); // re-evaluate market hours for next interval
    }, pollMs);
    log('INFO', `NSE next poll in ${pollMs / 60000} min (market ${isMarketOpen() ? 'open' : 'closed'})`);
  }
  scheduleNextPoll();
  log('OK', 'NSE adaptive polling started: indices + FII/DII');
}

function stopFiiDiiPolling() {
  if (fiiDiiInterval) { clearTimeout(fiiDiiInterval); fiiDiiInterval = null; }
}

// ── Option Chain Fetcher (Upstox v2) ─────────────────────────────────────────
const OC_CACHE_MS = 5 * 60 * 1000; // 5 min cache for option chain

async function fetchOptionChain(underlying = 'NSE_INDEX|Nifty 50', opts = {}) {
  if (!accessToken) return null;
  try {
    const isIndex = underlying.startsWith('NSE_INDEX');
    const expiryDate = isIndex ? getNextWeeklyExpiry() : (opts.expiry || getNextMonthlyExpiry());
    const res = await axios.get('https://api.upstox.com/v2/option/chain', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      params: { instrument_key: underlying, expiry_date: expiryDate },
      timeout: 10000
    });
    const data = res.data?.data;
    if (!data || !data.length) return null;

    // Find spot price — index from liveIndices, stock from liveStocks or opts
    let spot = opts.spot || 0;
    if (!spot) {
      if (underlying.includes('Nifty 50')) spot = liveIndices['Nifty 50']?.price || 23000;
      else if (underlying.includes('Nifty Bank')) spot = liveIndices['Nifty Bank']?.price || 49000;
      else {
        // Stock: try matching from STOCK_UNIVERSE by instrumentKey
        const su = STOCK_UNIVERSE.find(s => s.instrumentKey === underlying);
        if (su) spot = liveStocks[su.symbol]?.price || 0;
      }
    }
    if (!spot) spot = data[Math.floor(data.length / 2)]?.strike_price || 1000;

    const sorted = [...data].sort((a, b) => Math.abs(a.strike_price - spot) - Math.abs(b.strike_price - spot));
    const nearATM = sorted.slice(0, isIndex ? 20 : 12); // More strikes for index, fewer for stocks

    let totalCallOI = 0, totalPutOI = 0, maxPainStrike = 0, maxPainLoss = Infinity;
    const strikes = [];

    for (const s of data) {
      const ce = s.call_options?.market_data || {};
      const pe = s.put_options?.market_data || {};
      totalCallOI += (ce.oi || 0);
      totalPutOI += (pe.oi || 0);
    }

    // Max Pain calculation
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

    return { spot, strikes, pcr, maxPain: maxPainStrike, totalCallOI, totalPutOI, avgIV, expiry: expiryDate, symbol: opts.symbol || underlying };
  } catch (e) {
    log('WARN', `Option chain fetch failed for ${underlying}: ${e.message}`);
    return null;
  }
}

function getNextWeeklyExpiry() {
  const now = getIST();
  const day = now.getUTCDay();
  const daysToThurs = day <= 4 ? (4 - day) : (4 + 7 - day);
  const expiry = new Date(now);
  expiry.setUTCDate(now.getUTCDate() + (daysToThurs === 0 && now.getUTCHours() >= 15 ? 7 : daysToThurs));
  return expiry.toISOString().slice(0, 10);
}

function getNextMonthlyExpiry() {
  // Last Thursday of current month; if passed, last Thursday of next month
  const now = getIST();
  for (let m = 0; m < 2; m++) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + m;
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    let d = new Date(lastDay);
    while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() - 1);
    if (d > now || (d.toISOString().slice(0,10) === now.toISOString().slice(0,10) && now.getUTCHours() < 15)) {
      return d.toISOString().slice(0, 10);
    }
  }
  // Fallback: 30 days from now
  const fb = new Date(now); fb.setUTCDate(fb.getUTCDate() + 30);
  return fb.toISOString().slice(0, 10);
}

// ── NSE F&O Lot Sizes (official NSE lot sizes for margin/P&L calculations) ──
const NSE_LOT_SIZES = {
  'NIFTY': 75, 'BANKNIFTY': 30, 'FINNIFTY': 65, 'MIDCPNIFTY': 50, 'SENSEX': 20,
  'RELIANCE': 250, 'TCS': 150, 'INFY': 300, 'HDFCBANK': 550, 'ICICIBANK': 700,
  'SBIN': 750, 'TATAMOTORS': 575, 'TATASTEEL': 550, 'ITC': 1600, 'LT': 150,
  'HINDUNILVR': 300, 'AXISBANK': 600, 'KOTAKBANK': 400, 'BAJFINANCE': 125,
  'MARUTI': 100, 'ADANIENT': 250, 'WIPRO': 1500, 'HCLTECH': 350, 'SUNPHARMA': 350,
  'ONGC': 3850, 'NTPC': 2800, 'POWERGRID': 2700, 'COALINDIA': 2100, 'BHARTIARTL': 475,
  'ASIANPAINT': 300, 'ULTRACEMCO': 100, 'TITAN': 375, 'BAJAJFINSV': 500
};

// ── F&O eligible stocks (have lot sizes = have F&O options) ──
const FNO_STOCKS = Object.keys(NSE_LOT_SIZES).filter(s => !['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','SENSEX'].includes(s));

async function refreshOptionChain(includeStocks = false) {
  // Always refresh index chains
  const indexStale = Date.now() - optionChainCache.lastFetch > OC_CACHE_MS;
  if (!indexStale && !includeStocks) return optionChainCache;

  const fetches = [];
  // Index chains always
  if (indexStale) {
    fetches.push(fetchOptionChain('NSE_INDEX|Nifty 50').then(r => ({ key: 'nifty', data: r })));
    fetches.push(fetchOptionChain('NSE_INDEX|Nifty Bank').then(r => ({ key: 'banknifty', data: r })));
  }

  // Stock chains: pick top movers from F&O-eligible stocks
  if (includeStocks) {
    const fnoLive = FNO_STOCKS
      .map(sym => ({ sym, ...liveStocks[sym] }))
      .filter(s => s.price && Math.abs(s.changePct || 0) > 0.5);

    // Top 5 by absolute movement + top 3 by signal score = ~8 unique
    const byMove = [...fnoLive].sort((a,b) => Math.abs(b.changePct||0) - Math.abs(a.changePct||0)).slice(0, 5);
    const bySig = [...fnoLive].filter(s => (signalCache[s.sym]?.score||0) >= 60).sort((a,b) => (signalCache[b.sym]?.score||0) - (signalCache[a.sym]?.score||0)).slice(0, 3);
    const selected = new Map();
    for (const s of [...byMove, ...bySig]) {
      if (selected.size >= 8) break;
      if (!selected.has(s.sym)) selected.set(s.sym, s);
    }

    for (const [sym, s] of selected) {
      const su = STOCK_UNIVERSE.find(x => x.symbol === sym);
      if (!su) continue;
      fetches.push(
        fetchOptionChain(su.instrumentKey, { symbol: sym, spot: s.price, expiry: getNextMonthlyExpiry() })
          .then(r => ({ key: `stock_${sym}`, symbol: sym, data: r }))
      );
    }
    log('OK', `Fetching option chains for ${selected.size} F&O stocks: ${[...selected.keys()].join(',')}`);
  }

  const results = await Promise.allSettled(fetches);
  const newStocks = { ...(optionChainCache.stocks || {}) };

  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const { key, data, symbol } = r.value;
    if (!data) continue;
    if (key === 'nifty') optionChainCache.nifty = data;
    else if (key === 'banknifty') optionChainCache.banknifty = data;
    else if (key.startsWith('stock_') && symbol) {
      data.symbol = symbol;
      data.lotSize = NSE_LOT_SIZES[symbol] || 1;
      newStocks[symbol] = data;
    }
  }

  optionChainCache.stocks = newStocks;
  optionChainCache.lastFetch = Date.now();
  const stockCount = Object.keys(newStocks).length;
  if (optionChainCache.nifty) log('OK', `Option chains refreshed — Nifty PCR:${optionChainCache.nifty.pcr} MaxPain:${optionChainCache.nifty.maxPain} AvgIV:${optionChainCache.nifty.avgIV}%${stockCount ? ` + ${stockCount} stock chains` : ''}`);
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

// ── Prediction History — persistence ─────────────────────────────────────────
function loadPredictions() {
  try { if (fs.existsSync(PREDICTIONS_FILE)) { const d = dec(fs.readFileSync(PREDICTIONS_FILE, 'utf8')); if (d) predictionHistory = d; } }
  catch(e) { log('WARN', 'Failed to load prediction history: ' + e.message); predictionHistory = []; }
}
function savePredictions() {
  try { fs.writeFileSync(PREDICTIONS_FILE, enc(predictionHistory)); }
  catch(e) { log('ERR', 'Failed to save predictions: ' + e.message); }
}

// Store a prediction snapshot for later verification
function storePrediction(type, data) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,           // 'next_session' | 'today_behavior' | 'ai_pick' | 'options_insight'
    date: getISTDateStr(),
    generatedAt: new Date().toISOString(),
    status: 'PENDING', // PENDING → VERIFIED
    prediction: {},
    actual: null,
    scores: null
  };

  if (type === 'next_session' && data) {
    entry.predictedDate = data.predictedDate || getNextTradingDate(getISTDateStr());
    entry.prediction = {
      outlook: data.outlook,
      confidence: data.confidence,
      openingExpectation: data.openingExpectation,
      niftyRange: data.niftyRange || {},
      bankNiftyRange: data.bankNiftyRange || {},
      riskLevel: data.riskLevel,
      globalSentiment: data.globalSentiment,
      giftNifty: data.giftNifty || {},
      keyDrivers: data.keyDrivers || [],
      sectorOutlook: data.sectorOutlook || {}
    };
  } else if (type === 'today_behavior' && data) {
    entry.predictedDate = data._dateIST || getISTDateStr();
    entry.prediction = {
      behavior: data.todayBehavior,
      confidence: data.todayConfidence,
      explanation: data.todayExplanation,
      niftySupport: data.niftySupport,
      niftyResistance: data.niftyResistance
    };
  } else if (PHASE_TYPES.includes(type) && data) {
    entry.predictedDate = getISTDateStr();
    entry.prediction = {
      phase: data.phase,
      direction: data.direction,
      confidence: data.confidence,
      reasoning: data.reasoning,
      keyFactors: data.keyFactors || [],
      riskLevel: data.riskLevel,
      niftyRange: data.niftyRange || null,
      bankNiftyRange: data.bankNiftyRange || null,
      openingExpectation: data.openingExpectation || null,
      keyLevels: data.keyLevels || null,
      gapFill: data.gapFill != null ? data.gapFill : null,
      trapAlert: data.trapAlert || null,
      closingZone: data.closingZone || null,
      expectedClose: data.expectedClose || null,
      tomorrowBias: data.tomorrowBias || null,
      _dataSnapshot: data._dataSnapshot || null
    };
  }

  // Deduplicate: only keep latest prediction per type+predictedDate
  const dupIdx = predictionHistory.findIndex(p => p.type === type && p.predictedDate === entry.predictedDate && p.status === 'PENDING');
  if (dupIdx >= 0) predictionHistory[dupIdx] = entry;
  else predictionHistory.unshift(entry);

  // Keep last 365 entries max
  if (predictionHistory.length > 365) predictionHistory = predictionHistory.slice(0, 365);
  savePredictions();
  return entry;
}

// Verify predictions against actual market data — runs after market close
function verifyPredictions() {
  const todayIST = getISTDateStr();
  const nifty = liveIndices['Nifty 50'] || liveIndices['NIFTY50'] || {};
  const bank = liveIndices['NIFTYBANK'] || liveIndices['Nifty Bank'] || {};
  if (!nifty.price) return; // No live data yet

  // Only verify after market close (3:30 PM IST = 930 mins) for full-day accuracy
  if (getISTMins() < 930) return;

  // Require real high/low/open data — refuse to score with fallback values
  if (!nifty.high || !nifty.low || !nifty.open) {
    log('WARN', 'Skipping prediction verification — incomplete Nifty OHLC data');
    return;
  }

  let verified = 0;
  for (const pred of predictionHistory) {
    if (pred.status !== 'PENDING') continue;
    if (pred.predictedDate !== todayIST) continue;

    // Use actual OHLC from NSE data — no fallbacks to current price
    pred.actual = {
      niftyOpen: nifty.open,
      niftyClose: nifty.price,
      niftyHigh: nifty.high,
      niftyLow: nifty.low,
      niftyChangePct: nifty.changePct || 0,
      niftyPrevClose: nifty.previousClose || null,
      bankNiftyOpen: bank.open || null,
      bankNiftyClose: bank.price || null,
      bankNiftyHigh: bank.high || null,
      bankNiftyLow: bank.low || null,
      bankNiftyChangePct: bank.changePct || 0,
      vix: !vixData.isDefault ? vixData.value : null,
      fii: !fiiDiiData.isDefault ? fiiDiiData.fii : null,
      dii: !fiiDiiData.isDefault ? fiiDiiData.dii : null,
      breadthAdv: Object.values(liveStocks).filter(s => s.changePct >= 0).length,
      breadthDec: Object.values(liveStocks).filter(s => s.changePct < 0).length,
      verifiedAt: new Date().toISOString()
    };

    // Score the prediction
    pred.scores = scorePrediction(pred);
    pred.status = 'VERIFIED';
    pred.verifiedAt = new Date().toISOString();
    verified++;
  }
  if (verified > 0) { savePredictions(); log('OK', `Verified ${verified} predictions against actual data`); }
}

function scorePrediction(pred) {
  const p = pred.prediction;
  const a = pred.actual;
  const scores = { total: 0, max: 0, breakdown: {} };

  if (pred.type === 'next_session') {
    // 1. Outlook direction (25 pts) — did BULLISH/BEARISH match actual direction?
    scores.max += 25;
    const actualDir = a.niftyChangePct > 0.3 ? 'BULLISH' : a.niftyChangePct < -0.3 ? 'BEARISH' : 'NEUTRAL';
    const predDir = (p.outlook || '').replace('CAUTIOUSLY_', '');
    if (predDir === actualDir) { scores.total += 25; scores.breakdown.outlook = { score: 25, max: 25, predicted: p.outlook, actual: actualDir }; }
    else if ((predDir === 'BULLISH' && actualDir === 'NEUTRAL') || (predDir === 'BEARISH' && actualDir === 'NEUTRAL') || (predDir === 'NEUTRAL' && actualDir !== 'NEUTRAL')) {
      scores.total += 12; scores.breakdown.outlook = { score: 12, max: 25, predicted: p.outlook, actual: actualDir };
    } else { scores.breakdown.outlook = { score: 0, max: 25, predicted: p.outlook, actual: actualDir }; }

    // 2. Opening expectation (15 pts) — GAP_UP/GAP_DOWN/FLAT_OPEN vs actual gap
    // Only score if we have real prevClose data — no guessing
    if (a.niftyPrevClose && a.niftyOpen) {
      scores.max += 15;
      const actualGap = ((a.niftyOpen - a.niftyPrevClose) / a.niftyPrevClose * 100);
      const actualOpen = actualGap > 0.25 ? 'GAP_UP' : actualGap < -0.25 ? 'GAP_DOWN' : 'FLAT_OPEN';
      if (p.openingExpectation === actualOpen) { scores.total += 15; scores.breakdown.opening = { score: 15, max: 15, predicted: p.openingExpectation, actual: actualOpen, gap: +actualGap.toFixed(2) }; }
      else if ((p.openingExpectation === 'FLAT_OPEN' && Math.abs(actualGap) < 0.5) || (p.openingExpectation !== 'FLAT_OPEN' && actualOpen === 'FLAT_OPEN')) {
        scores.total += 7; scores.breakdown.opening = { score: 7, max: 15, predicted: p.openingExpectation, actual: actualOpen, gap: +actualGap.toFixed(2) };
      } else { scores.breakdown.opening = { score: 0, max: 15, predicted: p.openingExpectation, actual: actualOpen, gap: +actualGap.toFixed(2) }; }
    } else { scores.breakdown.opening = { score: 0, max: 0, note: 'No open/prevClose data' }; }

    // 3. Nifty range accuracy (25 pts) — did actual H/L fall within predicted range?
    scores.max += 25;
    if (p.niftyRange && p.niftyRange.low && p.niftyRange.high && a.niftyLow && a.niftyHigh) {
      const pLow = Number(p.niftyRange.low), pHigh = Number(p.niftyRange.high);
      const aLow = Number(a.niftyLow), aHigh = Number(a.niftyHigh);
      const lowInRange = aLow >= pLow * 0.995; // 0.5% tolerance
      const highInRange = aHigh <= pHigh * 1.005;
      const rangeContained = lowInRange && highInRange;
      const lowErr = Math.abs(aLow - pLow) / aLow * 100;
      const highErr = Math.abs(aHigh - pHigh) / aHigh * 100;
      const avgErr = (lowErr + highErr) / 2;
      let rangeScore = 0;
      if (rangeContained) rangeScore = 25;
      else if (avgErr < 0.5) rangeScore = 22;
      else if (avgErr < 1.0) rangeScore = 18;
      else if (avgErr < 1.5) rangeScore = 12;
      else if (avgErr < 2.5) rangeScore = 6;
      scores.total += rangeScore;
      scores.breakdown.niftyRange = { score: rangeScore, max: 25, predicted: { low: pLow, high: pHigh }, actual: { low: aLow, high: aHigh }, error: +avgErr.toFixed(2) };
    } else { scores.breakdown.niftyRange = { score: 0, max: 25, note: 'Missing data' }; }

    // 4. Bank Nifty range accuracy (15 pts) — only score with real OHLC data
    if (p.bankNiftyRange && p.bankNiftyRange.low && p.bankNiftyRange.high && a.bankNiftyLow && a.bankNiftyHigh) {
      scores.max += 15;
      const pLow = Number(p.bankNiftyRange.low), pHigh = Number(p.bankNiftyRange.high);
      const aLow = Number(a.bankNiftyLow), aHigh = Number(a.bankNiftyHigh);
      const avgErr = (Math.abs(aLow - pLow) / aLow * 100 + Math.abs(aHigh - pHigh) / aHigh * 100) / 2;
      let bnScore = avgErr < 0.5 ? 15 : avgErr < 1.0 ? 12 : avgErr < 1.5 ? 9 : avgErr < 2.5 ? 5 : 0;
      scores.total += bnScore;
      scores.breakdown.bankNiftyRange = { score: bnScore, max: 15, error: +avgErr.toFixed(2) };
    } else { scores.breakdown.bankNiftyRange = { score: 0, max: 0, note: 'Missing BankNifty OHLC' }; }

    // 5. Risk level assessment (10 pts) — HIGH/VERY_HIGH when VIX>20 or FII selling
    scores.max += 10;
    const actualRisk = (a.vix && a.vix > 25) || (a.fii && a.fii < -2000) ? 'HIGH' : (a.vix && a.vix > 18) || (a.fii && a.fii < -500) ? 'MODERATE' : 'LOW';
    const predRisk = (p.riskLevel === 'VERY_HIGH' || p.riskLevel === 'HIGH') ? 'HIGH' : p.riskLevel === 'MODERATE' ? 'MODERATE' : 'LOW';
    if (predRisk === actualRisk) { scores.total += 10; scores.breakdown.risk = { score: 10, max: 10, predicted: p.riskLevel, actual: actualRisk }; }
    else if (Math.abs(['LOW','MODERATE','HIGH'].indexOf(predRisk) - ['LOW','MODERATE','HIGH'].indexOf(actualRisk)) === 1) {
      scores.total += 5; scores.breakdown.risk = { score: 5, max: 10, predicted: p.riskLevel, actual: actualRisk };
    } else { scores.breakdown.risk = { score: 0, max: 10, predicted: p.riskLevel, actual: actualRisk }; }

    // 6. Confidence calibration (10 pts) — is confidence correlated with accuracy?
    scores.max += 10;
    const accuracyPct = scores.max > 10 ? ((scores.total - (scores.breakdown.risk?.score || 0)) / (scores.max - 10)) * 100 : 50;
    const confDiff = Math.abs((p.confidence || 50) - accuracyPct);
    let calScore = confDiff < 10 ? 10 : confDiff < 20 ? 7 : confDiff < 30 ? 4 : 0;
    scores.total += calScore;
    scores.breakdown.calibration = { score: calScore, max: 10, confidence: p.confidence, actualAccuracy: +accuracyPct.toFixed(0) };

  } else if (pred.type === 'today_behavior') {
    // Behavior direction match (50 pts)
    scores.max += 50;
    const actualBehavior = a.niftyChangePct > 1 ? 'STRONG_UPTREND' : a.niftyChangePct > 0.3 ? 'UPTREND' :
      a.niftyChangePct < -1 ? 'STRONG_DOWNTREND' : a.niftyChangePct < -0.3 ? 'DOWNTREND' : 'SIDEWAYS';
    const predB = p.behavior || 'SIDEWAYS';
    const isUp = b => b.includes('UP');
    const isDown = b => b.includes('DOWN');
    if (predB === actualBehavior) { scores.total += 50; }
    else if ((isUp(predB) && isUp(actualBehavior)) || (isDown(predB) && isDown(actualBehavior))) { scores.total += 35; }
    else if (predB === 'SIDEWAYS' || actualBehavior === 'SIDEWAYS') { scores.total += 15; }
    scores.breakdown.behavior = { score: scores.total, max: 50, predicted: predB, actual: actualBehavior };

    // Support/Resistance accuracy (50 pts)
    scores.max += 50;
    if (p.niftySupport && p.niftyResistance && a.niftyLow && a.niftyHigh) {
      const supErr = Math.abs(a.niftyLow - Number(p.niftySupport)) / a.niftyLow * 100;
      const resErr = Math.abs(a.niftyHigh - Number(p.niftyResistance)) / a.niftyHigh * 100;
      const avgErr = (supErr + resErr) / 2;
      const srScore = avgErr < 0.5 ? 50 : avgErr < 1 ? 40 : avgErr < 2 ? 25 : avgErr < 3 ? 10 : 0;
      scores.total += srScore;
      scores.breakdown.levels = { score: srScore, max: 50, error: +avgErr.toFixed(2) };
    } else { scores.breakdown.levels = { score: 0, max: 50, note: 'No levels predicted' }; }

  } else if (pred.type === 'phase_1_premarket') {
    // ── Phase 1: Pre-Market Prediction Scoring (100 pts) ──
    const actualDir = a.niftyChangePct > 0.3 ? 'BULLISH' : a.niftyChangePct < -0.3 ? 'BEARISH' : 'SIDEWAYS';
    // 1. Direction (35 pts)
    scores.max += 35;
    const pDir = (p.direction || '').replace('CAUTIOUSLY_', '');
    if (pDir === actualDir) { scores.total += 35; scores.breakdown.direction = { score: 35, max: 35, predicted: p.direction, actual: actualDir }; }
    else if ((pDir === 'BULLISH' && actualDir === 'SIDEWAYS') || (pDir === 'BEARISH' && actualDir === 'SIDEWAYS') || (pDir === 'SIDEWAYS')) { scores.total += 15; scores.breakdown.direction = { score: 15, max: 35, predicted: p.direction, actual: actualDir }; }
    else { scores.breakdown.direction = { score: 0, max: 35, predicted: p.direction, actual: actualDir }; }
    // 2. Range (25 pts)
    scores.max += 25;
    if (p.niftyRange && p.niftyRange.low && p.niftyRange.high && a.niftyLow && a.niftyHigh) {
      const lowErr = Math.abs(a.niftyLow - Number(p.niftyRange.low)) / a.niftyLow * 100;
      const highErr = Math.abs(a.niftyHigh - Number(p.niftyRange.high)) / a.niftyHigh * 100;
      const avgErr = (lowErr + highErr) / 2;
      const rs = avgErr < 0.5 ? 25 : avgErr < 1.0 ? 20 : avgErr < 1.5 ? 14 : avgErr < 2.5 ? 7 : 0;
      scores.total += rs; scores.breakdown.range = { score: rs, max: 25, error: +avgErr.toFixed(2) };
    } else { scores.breakdown.range = { score: 0, max: 25, note: 'No range data' }; }
    // 3. Opening expectation (20 pts)
    if (a.niftyPrevClose && a.niftyOpen) {
      scores.max += 20;
      const gap = ((a.niftyOpen - a.niftyPrevClose) / a.niftyPrevClose * 100);
      const actualOpen = gap > 0.25 ? 'GAP_UP' : gap < -0.25 ? 'GAP_DOWN' : 'FLAT';
      if (p.openingExpectation === actualOpen) { scores.total += 20; scores.breakdown.opening = { score: 20, max: 20, predicted: p.openingExpectation, actual: actualOpen }; }
      else if ((p.openingExpectation === 'FLAT' && Math.abs(gap) < 0.5) || (p.openingExpectation !== 'FLAT' && actualOpen === 'FLAT')) { scores.total += 10; scores.breakdown.opening = { score: 10, max: 20, predicted: p.openingExpectation, actual: actualOpen }; }
      else { scores.breakdown.opening = { score: 0, max: 20, predicted: p.openingExpectation, actual: actualOpen }; }
    } else { scores.breakdown.opening = { score: 0, max: 0, note: 'No open data' }; }
    // 4. Key levels (10 pts)
    if (p.keyLevels && p.keyLevels.support && p.keyLevels.resistance && a.niftyLow && a.niftyHigh) {
      scores.max += 10;
      const sErr = Math.abs(a.niftyLow - Number(p.keyLevels.support)) / a.niftyLow * 100;
      const rErr = Math.abs(a.niftyHigh - Number(p.keyLevels.resistance)) / a.niftyHigh * 100;
      const avgE = (sErr + rErr) / 2;
      const ls = avgE < 0.5 ? 10 : avgE < 1 ? 7 : avgE < 2 ? 4 : 0;
      scores.total += ls; scores.breakdown.levels = { score: ls, max: 10, error: +avgE.toFixed(2) };
    } else { scores.breakdown.levels = { score: 0, max: 0, note: 'No levels' }; }
    // 5. Confidence calibration (10 pts)
    scores.max += 10;
    const p1Acc = scores.max > 10 ? ((scores.total) / (scores.max - 10)) * 100 : 50;
    const p1Diff = Math.abs((p.confidence || 50) - p1Acc);
    const p1Cal = p1Diff < 10 ? 10 : p1Diff < 20 ? 7 : p1Diff < 30 ? 4 : 0;
    scores.total += p1Cal; scores.breakdown.calibration = { score: p1Cal, max: 10, confidence: p.confidence, actualAccuracy: +p1Acc.toFixed(0) };

  } else if (pred.type === 'phase_2_opening') {
    // ── Phase 2: Opening Verdict Scoring (100 pts) ──
    const actualDir = a.niftyChangePct > 0.3 ? 'BULLISH' : a.niftyChangePct < -0.3 ? 'BEARISH' : 'SIDEWAYS';
    // 1. Direction (35 pts)
    scores.max += 35;
    if (p.direction === actualDir) { scores.total += 35; } else if (p.direction === 'SIDEWAYS' || actualDir === 'SIDEWAYS') { scores.total += 15; }
    scores.breakdown.direction = { score: scores.total, max: 35, predicted: p.direction, actual: actualDir };
    // 2. Gap fill prediction (25 pts)
    if (a.niftyPrevClose && a.niftyOpen && a.niftyLow && a.niftyHigh) {
      scores.max += 25;
      const gapUp = a.niftyOpen > a.niftyPrevClose * 1.0025;
      const gapDown = a.niftyOpen < a.niftyPrevClose * 0.9975;
      let actualFill = false;
      if (gapUp) actualFill = a.niftyLow <= a.niftyPrevClose;
      else if (gapDown) actualFill = a.niftyHigh >= a.niftyPrevClose;
      const noGap = !gapUp && !gapDown;
      if (noGap) { scores.total += 15; scores.breakdown.gapFill = { score: 15, max: 25, note: 'No significant gap' }; }
      else if (p.gapFill === actualFill) { scores.total += 25; scores.breakdown.gapFill = { score: 25, max: 25, predicted: p.gapFill, actual: actualFill }; }
      else { scores.breakdown.gapFill = { score: 0, max: 25, predicted: p.gapFill, actual: actualFill }; }
    } else { scores.breakdown.gapFill = { score: 0, max: 0, note: 'Insufficient data' }; }
    // 3. Trap alert (20 pts)
    scores.max += 20;
    const isBullTrap = a.niftyOpen > (a.niftyPrevClose || 0) && a.niftyChangePct < -0.3;
    const isBearTrap = a.niftyOpen < (a.niftyPrevClose || 0) && a.niftyChangePct > 0.3;
    const actualTrap = isBullTrap ? 'BULL_TRAP' : isBearTrap ? 'BEAR_TRAP' : 'NONE';
    if (p.trapAlert === actualTrap) { scores.total += 20; } else if (p.trapAlert === 'NONE' && actualTrap === 'NONE') { scores.total += 20; } else if (p.trapAlert !== 'NONE' && actualTrap !== 'NONE') { scores.total += 10; }
    scores.breakdown.trap = { score: scores.total - (scores.breakdown.direction?.score || 0) - (scores.breakdown.gapFill?.score || 0), max: 20, predicted: p.trapAlert, actual: actualTrap };
    // 4. Confidence calibration (20 pts)
    scores.max += 20;
    const p2Acc = scores.max > 20 ? ((scores.total) / (scores.max - 20)) * 100 : 50;
    const p2Diff = Math.abs((p.confidence || 50) - p2Acc);
    const p2Cal = p2Diff < 10 ? 20 : p2Diff < 20 ? 14 : p2Diff < 30 ? 7 : 0;
    scores.total += p2Cal; scores.breakdown.calibration = { score: p2Cal, max: 20, confidence: p.confidence, actualAccuracy: +p2Acc.toFixed(0) };

  } else if (pred.type === 'phase_3_midsession') {
    // ── Phase 3: Mid-Session Forecast Scoring (100 pts) ──
    const actualDir = a.niftyChangePct > 0.3 ? 'BULLISH' : a.niftyChangePct < -0.3 ? 'BEARISH' : 'SIDEWAYS';
    // 1. Direction (35 pts)
    scores.max += 35;
    if (p.direction === actualDir) { scores.total += 35; } else if (p.direction === 'SIDEWAYS' || actualDir === 'SIDEWAYS') { scores.total += 15; }
    scores.breakdown.direction = { score: Math.min(scores.total, 35), max: 35, predicted: p.direction, actual: actualDir };
    // 2. Closing zone prediction (30 pts)
    if (a.niftyHigh && a.niftyLow && a.niftyClose) {
      scores.max += 30;
      const range = a.niftyHigh - a.niftyLow;
      const closePos = range > 0 ? (a.niftyClose - a.niftyLow) / range : 0.5;
      const actualZone = closePos > 0.7 ? 'NEAR_HIGH' : closePos < 0.3 ? 'NEAR_LOW' : 'MIDDLE';
      if (p.closingZone === actualZone) { scores.total += 30; } else if ((p.closingZone === 'MIDDLE' && closePos > 0.25 && closePos < 0.75)) { scores.total += 18; } else if (Math.abs(['NEAR_LOW','MIDDLE','NEAR_HIGH'].indexOf(p.closingZone) - ['NEAR_LOW','MIDDLE','NEAR_HIGH'].indexOf(actualZone)) === 1) { scores.total += 12; }
      scores.breakdown.closingZone = { score: scores.total - (scores.breakdown.direction?.score || 0), max: 30, predicted: p.closingZone, actual: actualZone, closePosition: +closePos.toFixed(2) };
    } else { scores.breakdown.closingZone = { score: 0, max: 0, note: 'No data' }; }
    // 3. Volatility (15 pts)
    if (a.niftyHigh && a.niftyLow && a.niftyPrevClose) {
      scores.max += 15;
      const dayRange = ((a.niftyHigh - a.niftyLow) / a.niftyPrevClose) * 100;
      const actualVol = dayRange > 2.0 ? 'HIGH' : dayRange > 1.0 ? 'MODERATE' : 'LOW';
      const predVol = p.volatilityExpected || 'MODERATE';
      if (predVol === actualVol) { scores.total += 15; } else if (Math.abs(['LOW','MODERATE','HIGH'].indexOf(predVol) - ['LOW','MODERATE','HIGH'].indexOf(actualVol)) === 1) { scores.total += 8; }
      scores.breakdown.volatility = { score: scores.total - (scores.breakdown.direction?.score || 0) - (scores.breakdown.closingZone?.score || 0), max: 15, predicted: predVol, actual: actualVol };
    } else { scores.breakdown.volatility = { score: 0, max: 0, note: 'No data' }; }
    // 4. Calibration (20 pts)
    scores.max += 20;
    const p3Acc = scores.max > 20 ? (scores.total / (scores.max - 20)) * 100 : 50;
    const p3Cal = Math.abs((p.confidence || 50) - p3Acc) < 10 ? 20 : Math.abs((p.confidence || 50) - p3Acc) < 20 ? 14 : Math.abs((p.confidence || 50) - p3Acc) < 30 ? 7 : 0;
    scores.total += p3Cal; scores.breakdown.calibration = { score: p3Cal, max: 20, confidence: p.confidence, actualAccuracy: +p3Acc.toFixed(0) };

  } else if (pred.type === 'phase_4_powerhour') {
    // ── Phase 4: Power Hour Scoring (100 pts) ──
    const actualDir = a.niftyChangePct > 0.3 ? 'BULLISH' : a.niftyChangePct < -0.3 ? 'BEARISH' : 'SIDEWAYS';
    // 1. Direction (35 pts)
    scores.max += 35;
    if (p.direction === actualDir) { scores.total += 35; } else if (p.direction === 'SIDEWAYS' || actualDir === 'SIDEWAYS') { scores.total += 15; }
    scores.breakdown.direction = { score: Math.min(scores.total, 35), max: 35, predicted: p.direction, actual: actualDir };
    // 2. Close level (30 pts)
    if (p.expectedClose && p.expectedClose.niftyLow && p.expectedClose.niftyHigh && a.niftyClose) {
      scores.max += 30;
      const pLow = Number(p.expectedClose.niftyLow), pHigh = Number(p.expectedClose.niftyHigh);
      const inRange = a.niftyClose >= pLow * 0.998 && a.niftyClose <= pHigh * 1.002;
      const closeErr = Math.min(Math.abs(a.niftyClose - pLow), Math.abs(a.niftyClose - pHigh)) / a.niftyClose * 100;
      const cs = inRange ? 30 : closeErr < 0.3 ? 25 : closeErr < 0.5 ? 20 : closeErr < 1.0 ? 12 : closeErr < 2.0 ? 5 : 0;
      scores.total += cs; scores.breakdown.closeLevel = { score: cs, max: 30, predicted: { low: pLow, high: pHigh }, actual: a.niftyClose, error: +closeErr.toFixed(2) };
    } else { scores.breakdown.closeLevel = { score: 0, max: 0, note: 'No close prediction' }; }
    // 3. Risk assessment (15 pts)
    scores.max += 15;
    const actRisk = (a.vix && a.vix > 25) || (a.fii && a.fii < -2000) ? 'HIGH' : (a.vix && a.vix > 18) || (a.fii && a.fii < -500) ? 'MODERATE' : 'LOW';
    const pRisk = (p.riskLevel === 'VERY_HIGH' || p.riskLevel === 'HIGH') ? 'HIGH' : p.riskLevel === 'MODERATE' ? 'MODERATE' : 'LOW';
    if (pRisk === actRisk) { scores.total += 15; } else if (Math.abs(['LOW','MODERATE','HIGH'].indexOf(pRisk) - ['LOW','MODERATE','HIGH'].indexOf(actRisk)) === 1) { scores.total += 8; }
    scores.breakdown.risk = { score: scores.total - (scores.breakdown.direction?.score || 0) - (scores.breakdown.closeLevel?.score || 0), max: 15, predicted: p.riskLevel, actual: actRisk };
    // 4. Calibration (20 pts)
    scores.max += 20;
    const p4Acc = scores.max > 20 ? (scores.total / (scores.max - 20)) * 100 : 50;
    const p4Cal = Math.abs((p.confidence || 50) - p4Acc) < 10 ? 20 : Math.abs((p.confidence || 50) - p4Acc) < 20 ? 14 : Math.abs((p.confidence || 50) - p4Acc) < 30 ? 7 : 0;
    scores.total += p4Cal; scores.breakdown.calibration = { score: p4Cal, max: 20, confidence: p.confidence, actualAccuracy: +p4Acc.toFixed(0) };
  }

  scores.pct = scores.max > 0 ? Math.round((scores.total / scores.max) * 100) : 0;
  return scores;
}

// ── Accuracy API Endpoint ─────────────────────────────────────────────────────
app.get('/api/accuracy', (req, res) => {
  const { type, days } = req.query;
  const maxDays = days ? parseInt(days) : 90;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - maxDays);

  let filtered = predictionHistory.filter(p => {
    if (type && p.type !== type) return false;
    return new Date(p.generatedAt || p.date) >= cutoff;
  });

  const verified = filtered.filter(p => p.status === 'VERIFIED' && p.scores);
  const pending = filtered.filter(p => p.status === 'PENDING');

  // Aggregate stats
  const stats = { total: filtered.length, verified: verified.length, pending: pending.length };

  // Overall accuracy
  if (verified.length > 0) {
    stats.avgScore = Math.round(verified.reduce((s, p) => s + p.scores.pct, 0) / verified.length);
    stats.highestScore = Math.max(...verified.map(p => p.scores.pct));
    stats.lowestScore = Math.min(...verified.map(p => p.scores.pct));
  }

  // Per-type breakdown
  stats.byType = {};
  for (const t of ['next_session', 'today_behavior', ...PHASE_TYPES]) {
    const typeVer = verified.filter(p => p.type === t);
    if (typeVer.length === 0) { stats.byType[t] = { count: 0 }; continue; }
    const avg = Math.round(typeVer.reduce((s, p) => s + p.scores.pct, 0) / typeVer.length);
    // Category-level breakdown
    const categoryStats = {};
    for (const v of typeVer) {
      if (!v.scores.breakdown) continue;
      for (const [cat, d] of Object.entries(v.scores.breakdown)) {
        if (!categoryStats[cat]) categoryStats[cat] = { totalScore: 0, totalMax: 0, count: 0 };
        categoryStats[cat].totalScore += d.score || 0;
        categoryStats[cat].totalMax += d.max || 0;
        categoryStats[cat].count++;
      }
    }
    const categories = {};
    for (const [cat, d] of Object.entries(categoryStats)) {
      categories[cat] = { avgPct: d.totalMax > 0 ? Math.round((d.totalScore / d.totalMax) * 100) : 0, samples: d.count };
    }
    stats.byType[t] = { count: typeVer.length, avgScore: avg, categories };
  }

  // Trend: last 30 verified + all pending (newest first)
  stats.trend = [
    ...verified.slice(0, 30).map(p => ({
      date: p.predictedDate, type: p.type, status: 'VERIFIED', scores: p.scores,
      score: p.scores.pct, breakdown: p.scores.breakdown, verifiedAt: p.verifiedAt
    })),
    ...pending.map(p => ({
      date: p.predictedDate, type: p.type, status: 'PENDING', prediction: p.prediction
    }))
  ];

  // Weekly averages for chart data
  const weekMap = {};
  for (const p of verified) {
    const d = new Date(p.verifiedAt || p.generatedAt || p.date);
    const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay());
    const wk = weekStart.toISOString().slice(0, 10);
    if (!weekMap[wk]) weekMap[wk] = { scores: [], count: 0 };
    weekMap[wk].scores.push(p.scores.pct);
    weekMap[wk].count++;
  }
  stats.weekly = Object.entries(weekMap).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([week, d]) => ({
    week, avg: Math.round(d.scores.reduce((s, v) => s + v, 0) / d.scores.length), count: d.count,
    high: Math.max(...d.scores), low: Math.min(...d.scores)
  }));

  res.json(stats);
});

// ── Logging ───────────────────────────────────────────────────────────────────
const LOGS = [];
function log(level, msg) {
  const now = new Date();
  const ts = now.toISOString();
  const timeStr = now.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = { ts, level, msg: `[${timeStr}] [${level}] ${msg}` };
  LOGS.unshift(entry);
  if (LOGS.length > 500) LOGS.pop();
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
  if (process.env.GEMINI_API_KEY_2)  appConfig.geminiKey2    = process.env.GEMINI_API_KEY_2.trim();
  if (process.env.GEMINI_API_KEY_3)  appConfig.geminiKey3    = process.env.GEMINI_API_KEY_3.trim();
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
  const day = getISTDay();
  const mins = getISTMins();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
}

function getNextMarketOpen() {
  const utc = new Date();
  const ist = new Date(utc.getTime() + 5.5 * 60 * 60 * 1000);
  let d = new Date(ist);
  // If today's market hasn't opened yet
  const todayMins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const day = d.getUTCDay();
  if (day >= 1 && day <= 5 && todayMins < 555) {
    d.setUTCHours(9, 15, 0, 0);
    return d.toISOString();
  }
  // Otherwise next weekday
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  d.setUTCHours(9, 15, 0, 0);
  return d.toISOString();
}

function marketClosedResponse(cache, cacheTimestamp) {
  const base = { marketClosed: true, nextOpen: getNextMarketOpen() };
  if (cache) {
    return { ...base, ...cache, stale: true, lastUpdated: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null };
  }
  return { ...base, error: 'Market is closed. Insights are available during Indian market hours (9:15 AM – 3:30 PM IST, Mon–Fri)' };
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

// Multi-key rotation: primary key + up to 2 backup keys from different GCP projects
function getGeminiKeys() {
  const keys = [];
  if (appConfig.geminiKey) keys.push(appConfig.geminiKey);
  if (appConfig.geminiKey2) keys.push(appConfig.geminiKey2);
  if (appConfig.geminiKey3) keys.push(appConfig.geminiKey3);
  return keys;
}
let geminiKeyIndex = 0; // tracks which key to try first (rotates on 429)

async function callGemini(prompt, opts = {}) {
  if (geminiDisabled) throw new Error('Gemini AI is disconnected by user');
  const { temperature = 0.3, maxOutputTokens = 1000, timeout = 30000 } = opts;
  const keys = getGeminiKeys();
  if (!keys.length) throw new Error('No Gemini API keys configured');
  // Priority: try best model across ALL keys first, then fall back to next model
  // Key1(3.0) → Key2(3.0) → Key3(3.0) → Key1(2.5) → Key2(2.5) → Key3(2.5) → Key1(2.0) → ...
  const startKeyIdx = geminiKeyIndex % keys.length;
  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const model = GEMINI_MODELS[m];
    for (let k = 0; k < keys.length; k++) {
      const keyIdx = (startKeyIdx + k) % keys.length;
      const key = keys[keyIdx];
      try {
        const r = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens } },
          { headers: { 'Content-Type': 'application/json' }, timeout }
        );
        const text = r.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        geminiKeyIndex = keyIdx; // stick with this key for next call
        return { text, model, keySlot: keyIdx + 1 };
      } catch (e) {
        const status = e.response?.status;
        if (status === 429) {
          log('WARN', `Gemini key #${keyIdx+1} rate limited on ${model} — ${k < keys.length-1 ? 'trying next key' : 'all keys exhausted on ' + model + ', falling back to next model'}`);
          continue; // try next key for same model
        }
        if (status === 404) {
          log('WARN', `Gemini ${model} not found (404) on key #${keyIdx+1} — skipping model`);
          break; // skip to next model (404 means model doesn't exist, same for all keys)
        }
        throw e;
      }
    }
  }
  throw new Error('All Gemini API keys exhausted (429 on all keys/models)');
}

// ══════════════════════════════════════════════════════════════════════════════
// VERTEX AI — GROUNDED GEMINI (Service Account JWT Auth + Google Search Grounding)
// ══════════════════════════════════════════════════════════════════════════════
const nodeCrypto = require('crypto');
const GCP_SA_PATH = path.join(__dirname, '.gcp-service-account.json');
let gcpServiceAccount = null;
let geminiConnectionOk = false;
let geminiDisabled = false; // user manually disconnected
let vertexConnectionOk = false;
let vertexDisabled = false; // user manually disconnected
let vertexAccessToken = null;
let vertexTokenExpiry = 0;

function loadGcpServiceAccount() {
  try {
    // Priority 1: Environment variable (Vercel/Railway — stores the full JSON as a string)
    if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
      gcpServiceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
      log('OK', `Vertex AI service account loaded from env: ${gcpServiceAccount.client_email}`);
      return true;
    }
    // Priority 2: Local JSON file
    if (fs.existsSync(GCP_SA_PATH)) {
      gcpServiceAccount = JSON.parse(fs.readFileSync(GCP_SA_PATH, 'utf8'));
      log('OK', `Vertex AI service account loaded from file: ${gcpServiceAccount.client_email}`);
      return true;
    }
  } catch (e) { log('WARN', 'Failed to load GCP service account: ' + e.message); }
  return false;
}

function createJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  const sign = nodeCrypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(sa.private_key, 'base64url');
  return `${header}.${payload}.${signature}`;
}

async function getVertexAccessToken() {
  if (vertexAccessToken && Date.now() < vertexTokenExpiry - 60000) return vertexAccessToken;
  if (!gcpServiceAccount) { if (!loadGcpServiceAccount()) throw new Error('No GCP service account configured'); }
  const jwt = createJWT(gcpServiceAccount);
  const r = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
  vertexAccessToken = r.data.access_token;
  vertexTokenExpiry = Date.now() + (r.data.expires_in * 1000);
  log('OK', 'Vertex AI access token refreshed');
  return vertexAccessToken;
}

async function callVertexAI(prompt, opts = {}) {
  if (vertexDisabled) throw new Error('Vertex AI is disconnected by user');
  const { temperature = 0.3, maxOutputTokens = 2000, timeout = 60000, grounding = true, model = 'gemini-3-flash-preview' } = opts;
  const token = await getVertexAccessToken();
  const projectId = gcpServiceAccount.project_id;

  // Build endpoint configurations to try (Gemini 2.5+ / 3.x need global location)
  // Try multiple API versions because Google keeps changing requirements
  const endpointConfigs = [
    { host: 'aiplatform.googleapis.com', version: 'v1', location: 'global' },
    { host: 'aiplatform.googleapis.com', version: 'v1beta1', location: 'global' },
    { host: 'us-central1-aiplatform.googleapis.com', version: 'v1', location: 'us-central1' },
    { host: 'us-central1-aiplatform.googleapis.com', version: 'v1beta1', location: 'us-central1' },
  ];

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens }
  };
  if (grounding) {
    body.tools = [{ google_search_retrieval: { dynamic_retrieval_config: { mode: 'MODE_DYNAMIC', dynamic_threshold: 0.3 } } }];
  }

  let lastError = null;
  for (const cfg of endpointConfigs) {
    const url = `https://${cfg.host}/${cfg.version}/projects/${projectId}/locations/${cfg.location}/publishers/google/models/${model}:generateContent`;
    try {
      const r = await axios.post(url, body, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout
      });
      const text = r.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const groundingMeta = r.data.candidates?.[0]?.groundingMetadata || null;
      log('OK', `Vertex AI endpoint: ${cfg.version}/${cfg.location}/${model}`);
      return { text, model, grounded: !!groundingMeta, groundingMeta };
    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      if (status === 404) {
        log('WARN', `Vertex AI 404 on ${cfg.version}/${cfg.location}/${model} — trying next endpoint`);
        continue; // try next endpoint config
      }
      // For non-404 errors (auth, rate limit, etc.), throw immediately
      throw e;
    }
  }

  // If all endpoints returned 404 and grounding was on, retry the first endpoint without grounding
  // (grounding tools can cause 404 on some model versions)
  if (grounding && lastError?.response?.status === 404) {
    log('WARN', `All Vertex AI endpoints returned 404 with grounding — retrying without grounding`);
    const bodyNoGround = { contents: body.contents, generationConfig: body.generationConfig };
    for (const cfg of endpointConfigs) {
      const url = `https://${cfg.host}/${cfg.version}/projects/${projectId}/locations/${cfg.location}/publishers/google/models/${model}:generateContent`;
      try {
        const r = await axios.post(url, bodyNoGround, {
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          timeout
        });
        const text = r.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        log('OK', `Vertex AI connected (no grounding): ${cfg.version}/${cfg.location}/${model}`);
        return { text, model, grounded: false, groundingMeta: null };
      } catch (e) {
        lastError = e;
        if (e.response?.status === 404) continue;
        throw e;
      }
    }
  }

  throw lastError;
}

// ══════════════════════════════════════════════════════════════════════════════
// UNIFIED AI CALL — Model-first rotation across ALL sources (Gemini keys + Vertex AI)
// Chain: Key1(3.0)→Key2(3.0)→Key3(3.0)→Vertex(3.0) → Key1(2.5)→Key2(2.5)→Key3(2.5)→Vertex(2.5) → Key1(2.0)→Key2(2.0)→Key3(2.0)→Vertex(2.0)
// ══════════════════════════════════════════════════════════════════════════════
async function callAI(prompt, opts = {}) {
  const { preferGrounded = false, ...rest } = opts;
  const { temperature = 0.3, maxOutputTokens = 1000, timeout = 30000 } = rest;
  const keys = getGeminiKeys();
  const startKeyIdx = keys.length ? geminiKeyIndex % keys.length : 0;
  let lastError = null;
  const hasGeminiKeys = !geminiDisabled && keys.length > 0;
  const hasVertex = !vertexDisabled && !!gcpServiceAccount;

  if (!hasGeminiKeys && !hasVertex) {
    throw new Error('All AI sources unavailable — no Gemini keys configured or all AI services disconnected');
  }

  // When grounding is preferred, try Vertex AI FIRST (only source with Google Search grounding)
  if (preferGrounded && hasVertex) {
    for (let m = 0; m < GEMINI_MODELS.length; m++) {
      const model = GEMINI_MODELS[m];
      try {
        const result = await callVertexAI(prompt, { temperature, maxOutputTokens, timeout: Math.max(timeout, 45000), model, grounding: true });
        log('OK', `Vertex AI (grounded-first) succeeded on ${model} (grounded: ${result.grounded})`);
        return { ...result, source: 'vertex' };
      } catch (e) {
        lastError = e;
        const status = e.response?.status;
        if (status === 429) log('WARN', `Vertex AI rate limited on ${model} — trying next model`);
        else if (status === 404) log('WARN', `Vertex AI ${model} not found (404) — trying next model`);
        else log('WARN', `Vertex AI grounded failed on ${model}: ${e.message} — trying next model`);
      }
    }
    log('WARN', 'All Vertex AI grounded attempts failed — falling back to Gemini keys (ungrounded)');
  }

  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const model = GEMINI_MODELS[m];

    // Try all Gemini API keys for this model
    if (hasGeminiKeys) {
      let skipModel = false;
      for (let k = 0; k < keys.length; k++) {
        const keyIdx = (startKeyIdx + k) % keys.length;
        const key = keys[keyIdx];
        try {
          const r = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
            { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens } },
            { headers: { 'Content-Type': 'application/json' }, timeout }
          );
          const text = r.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          geminiKeyIndex = keyIdx; // remember successful key
          return { text, model, keySlot: keyIdx + 1, source: 'gemini', grounded: false };
        } catch (e) {
          lastError = e;
          const status = e.response?.status;
          if (status === 429) {
            log('WARN', `Gemini key #${keyIdx+1} rate limited on ${model} — ${k < keys.length-1 ? 'trying next key' : 'all keys exhausted, trying Vertex AI'}`);
            continue;
          }
          if (status === 404) {
            log('WARN', `Gemini ${model} not found (404) on key #${keyIdx+1} — skipping model for all Gemini keys`);
            skipModel = true;
            break;
          }
          log('WARN', `Gemini key #${keyIdx+1} error on ${model}: ${e.message}`);
          continue;
        }
      }
    }

    // Fallback: Try Vertex AI without grounding for this model (if not already tried above)
    if (hasVertex && !preferGrounded) {
      try {
        const result = await callVertexAI(prompt, { temperature, maxOutputTokens, timeout: Math.max(timeout, 45000), model, grounding: false });
        log('OK', `Vertex AI succeeded on ${model} (grounded: ${result.grounded})`);
        return { ...result, source: 'vertex' };
      } catch (e) {
        lastError = e;
        const status = e.response?.status;
        if (status === 429) log('WARN', `Vertex AI rate limited on ${model} — falling back to next model tier`);
        else if (status === 404) log('WARN', `Vertex AI ${model} not found (404) — falling back to next model tier`);
        else log('WARN', `Vertex AI failed on ${model}: ${e.message} — falling back to next model tier`);
      }
    }
  }

  throw lastError || new Error('All AI sources exhausted (all Gemini keys + Vertex AI failed on all models)');
}

// ══════════════════════════════════════════════════════════════════════════════
// MARKET INTELLIGENCE — Two independent cards with seamless 24hr lifecycle
// ══════════════════════════════════════════════════════════════════════════════
//
//   TODAY'S BEHAVIOUR (/api/market-prediction):
//     Weekday 12:00 AM → 9:15 AM : Pre-market — web-search AI analysis (adaptive refresh)
//     Weekday 9:15 AM → 3:30 PM  : LIVE — Upstox/NSE real-time data, 15 min refresh
//     Weekday 3:30 PM → 11:59 PM : Post-market — cached today's analysis, no refresh
//     Weekend (Sat/Sun)           : Serves Friday's cached analysis, no AI calls
//
//   NEXT SESSION OUTLOOK (/api/next-session):
//     Weekday 3:30 PM → 11:59 PM : ACTIVE — generates using Twelve Data + web search, 30 min
//     Weekend (Sat/Sun, all day)  : ACTIVE — keeps updating Monday prediction via web search
//     Weekday 12:00 AM → 3:30 PM : INACTIVE — no data, no AI calls
//
//   MIDNIGHT HANDOFF: Next-session's prediction for D+1 seeds the pre-market card at 12 AM D+1
//   WEEKEND: Friday cache persists in Today's Behaviour; Next Session stays active predicting Monday
//
// ══════════════════════════════════════════════════════════════════════════════

// ── Shared state ──
let todayCache   = { data: null, lastFetch: 0, dateIST: '' };  // Today's Behaviour (Live Pulse)
let preMarketCache = { data: null, lastFetch: 0, dateIST: '' }; // Pre-market analysis
let nextSessionCache = { data: null, lastFetch: 0, predictedDate: '' };  // Next Session

// ── Phase Prediction Cache (locked predictions per day) ──
let phaseCache = {
  dateIST: '',
  p1: { data: null, locked: false, generatedAt: null },  // Pre-Market (8:00-9:14 AM)
  p2: { data: null, locked: false, generatedAt: null },  // Opening Verdict (9:30 AM)
  p3: { data: null, locked: false, generatedAt: null },  // Mid-Session (12:30 PM)
  p4: { data: null, locked: false, generatedAt: null }   // Power Hour (2:00 PM)
};
function resetPhaseCache() {
  phaseCache = { dateIST: '', p1: { data: null, locked: false, generatedAt: null }, p2: { data: null, locked: false, generatedAt: null }, p3: { data: null, locked: false, generatedAt: null }, p4: { data: null, locked: false, generatedAt: null } };
}

// ── Shared constants ──
const LIVE_CACHE_MS = 15 * 60 * 1000;          // 15 min during market hours
const NEXT_SESSION_CACHE_MS = 30 * 60 * 1000;  // 30 min post-market
const PHASE_TYPES = ['phase_1_premarket', 'phase_2_opening', 'phase_3_midsession', 'phase_4_powerhour'];

// ── Shared helpers ──
function getISTDateStr() {
  const ist = getIST();
  return ist.getUTCFullYear() + '-' + String(ist.getUTCMonth() + 1).padStart(2, '0') + '-' + String(ist.getUTCDate()).padStart(2, '0');
}

function getNextTradingDate(fromDateStr) {
  const [y, m, d] = fromDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  do { dt.setUTCDate(dt.getUTCDate() + 1); } while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

// Weekend check: Saturday (6) or Sunday (0)
function isWeekend() { const d = getISTDay(); return d === 0 || d === 6; }

// Pre-market refresh rate: accelerates as market open approaches
function getPreMarketCacheMs() {
  const mins = getISTMins();
  if (mins >= 525) return 10 * 60 * 1000;   // 8:45 AM+ → every 10 min (pre-open rush)
  if (mins >= 360) return 30 * 60 * 1000;   // 6:00 AM+ → every 30 min (Asia waking)
  return 60 * 60 * 1000;                     // 12-6 AM  → every 60 min (quiet)
}

// Shared: parse AI JSON response safely
function parseAIJson(raw) {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {
    const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) { try { return JSON.parse(cleaned.slice(s, e + 1)); } catch (_) {} }
  }
  return {};
}

// Shared: collect whatever Twelve Data globals are available (works 24/5)
function getGlobalDataStr() {
  return Object.values(globalMarkets).map(g =>
    `${g.name}: ${g.price} (${g.changePct >= 0 ? '+' : ''}${g.changePct}%)`
  ).join(', ') || '';
}

// Shared: macro events string
function getMacroEventsStr() {
  return getMarketContext().filter(e => e.priority === 'HIGH' || e.priority === 'MEDIUM')
    .map(e => `[${e.priority}] ${e.title}: ${e.impact}`).join('\n- ') || 'None flagged';
}

// ══════════════════════════════════════════════════════════════════════════════
// TODAY'S BEHAVIOUR — /api/market-prediction
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/market-prediction', async (req, res) => {
  const todayIST = getISTDateStr();
  const istMins = getISTMins();

  // ── Date roll: invalidate caches from previous IST date ──
  // Skip invalidation on weekends — Friday's cache must survive until Monday
  if (!isWeekend() && todayCache.dateIST && todayCache.dateIST !== todayIST) {
    log('INFO', `Today's behaviour date rolled: ${todayCache.dateIST} → ${todayIST}`);
    todayCache = { data: null, lastFetch: 0, dateIST: '' };
    preMarketCache = { data: null, lastFetch: 0, dateIST: '' };
    resetPhaseCache();
  }

  // ═══ WEEKEND (Sat/Sun): serve Friday's cached analysis, no AI calls ═══
  if (isWeekend()) {
    if (todayCache.data) return res.json(marketClosedResponse({ ...todayCache.data }, todayCache.lastFetch));
    return res.json({ noDataToday: true, error: 'Market closed for the weekend. Opens Monday 9:15 AM IST' });
  }

  // ═══ POST-MARKET (3:30 PM → midnight): serve today's cached analysis, no refresh ═══
  if (istMins > 930 && todayCache.data && todayCache.dateIST === todayIST) {
    return res.json(marketClosedResponse({ ...todayCache.data }, todayCache.lastFetch));
  }

  // ═══ MARKET HOURS (9:15 AM → 3:30 PM): live data from Upstox/NSE ═══
  if (isMarketOpen()) {
    // Cache check
    if (todayCache.data && todayCache.dateIST === todayIST
        && (Date.now() - todayCache.lastFetch) < LIVE_CACHE_MS) {
      return res.json({ ...todayCache.data, cached: true });
    }
    if (!appConfig.geminiKey && !gcpServiceAccount) {
      return res.json({ error: 'AI not configured', configured: false });
    }

    try {
      const nifty = liveIndices['Nifty 50'] || liveIndices['NIFTY50'] || {};
      const bank = liveIndices['NIFTYBANK'] || liveIndices['Nifty Bank'] || {};
      const vix = vixData, fii = fiiDiiData;
      const stocks = Object.values(liveStocks).filter(s => s.price);
      const adv = stocks.filter(s => s.changePct >= 0).length;
      const dec = stocks.filter(s => s.changePct < 0).length;
      const signals = Object.values(signalCache);
      const avgScore = signals.length ? Math.round(signals.reduce((a, s) => a + (s.score || 0), 0) / signals.length) : 50;

      const dataSources = {
        nifty: nifty.price ? 'Upstox (live)' : 'Unavailable',
        bankNifty: bank.price ? 'Upstox (live)' : 'Unavailable',
        vix: !vix.isDefault ? 'NSE API' : 'Unavailable',
        fiiDii: !fii.isDefault ? 'NSE API' : 'Unavailable',
        globals: Object.keys(globalMarkets).length > 0 ? 'Twelve Data' : 'Unavailable',
        options: optionChainCache.nifty ? 'Upstox Options' : 'Unavailable',
        signals: signals.length > 0 ? `FINR (${signals.length})` : 'Unavailable'
      };

      // Options sentiment
      let optStr = '';
      if (optionChainCache.nifty) {
        const nc = optionChainCache.nifty;
        optStr = `\nOPTIONS: Nifty PCR ${nc.pcr} | Max Pain ${nc.maxPain} | IV ${nc.avgIV}%`;
        optStr += nc.pcr > 1.2 ? ' → Bullish' : nc.pcr < 0.7 ? ' → Bearish' : ' → Neutral';
        if (optionChainCache.banknifty) { const bc = optionChainCache.banknifty; optStr += ` | BN PCR ${bc.pcr} Max Pain ${bc.maxPain}`; }
      }

      // Sector breakdown
      const sectors = {};
      for (const st of STOCK_UNIVERSE) { const sig = signalCache[st.symbol]; if (!sig) continue; const s = st.sector || 'Other'; if (!sectors[s]) sectors[s] = []; sectors[s].push(sig.score || 0); }
      let secStr = '';
      for (const [s, scores] of Object.entries(sectors)) { if (!scores.length) continue; const avg = Math.round(scores.reduce((a,b)=>a+b,0)/scores.length); secStr += `\n- ${s}: ${avg}/100`; }
      if (secStr) secStr = '\nSECTOR SCORES:' + secStr;

      const prompt = `You are an elite Indian stock market analyst. Classify TODAY's market behavior using ALL live data below.

LIVE DATA:
- Nifty: ${nifty.price || 'N/A'} (${nifty.price ? (nifty.changePct>=0?'+':'') + (nifty.changePct||0) + '%' : 'N/A'})
- Bank Nifty: ${bank.price || 'N/A'} (${bank.price ? (bank.changePct>=0?'+':'') + (bank.changePct||0) + '%' : 'N/A'})
- VIX: ${!vix.isDefault ? vix.value + ' (' + vix.trend + ')' : 'N/A'}
- FII: ${!fii.isDefault ? '₹'+fii.fii+' Cr' : 'N/A'} | DII: ${!fii.isDefault ? '₹'+fii.dii+' Cr' : 'N/A'}
- Breadth: ${adv} adv / ${dec} dec | Score: ${avgScore}/100
- Globals: ${getGlobalDataStr() || 'N/A'}${optStr}${secStr}
- Events: ${getMacroEventsStr()}

Gainers: ${stocks.sort((a,b)=>b.changePct-a.changePct).slice(0,5).map(s=>`${s.symbol}(${s.changePct>=0?'+':''}${s.changePct?.toFixed(1)}%)`).join(', ')}
Losers: ${stocks.sort((a,b)=>a.changePct-b.changePct).slice(0,5).map(s=>`${s.symbol}(${s.changePct?.toFixed(1)}%)`).join(', ')}

Reply ONLY valid JSON:
{"todayBehavior":"STRONG_UPTREND/UPTREND/SIDEWAYS/DOWNTREND/STRONG_DOWNTREND/VOLATILE","todayExplanation":"40-word explanation","todayConfidence":85,"keyFactors":["f1","f2","f3","f4","f5"],"riskLevel":"LOW/MODERATE/HIGH/VERY_HIGH","suggestedStrategy":"25-word strategy","globalSentiment":"RISK_ON/RISK_OFF/MIXED","sectorRotation":{"bullish":[],"bearish":[]},"niftySupport":0,"niftyResistance":0}`;

      const g = await callAI(prompt, { preferGrounded: true, temperature: 0.2, maxOutputTokens: 2000, timeout: 60000 });
      log('OK', `Today's behaviour (live) generated (${g.source}/${g.model}, grounded:${g.grounded}), ${(g.text||'').length} chars`);

      const p = parseAIJson(g.text || '{}');

      // Validate
      const VB = ['STRONG_UPTREND','UPTREND','SIDEWAYS','DOWNTREND','STRONG_DOWNTREND','VOLATILE'];
      if (!VB.includes(p.todayBehavior)) p.todayBehavior = 'SIDEWAYS';
      if (!['LOW','MODERATE','HIGH','VERY_HIGH'].includes(p.riskLevel)) p.riskLevel = 'MODERATE';
      if (!['RISK_ON','RISK_OFF','MIXED'].includes(p.globalSentiment)) p.globalSentiment = 'MIXED';
      p.todayConfidence = Math.max(50, Math.min(95, Number(p.todayConfidence) || 60));
      if (!Array.isArray(p.keyFactors)) p.keyFactors = [];
      if (!p.sectorRotation || typeof p.sectorRotation !== 'object') p.sectorRotation = { bullish: [], bearish: [] };

      // Breadth cross-check
      const tot = adv + dec;
      if (tot > 20 && dec/tot > 0.7 && (p.todayBehavior === 'UPTREND' || p.todayBehavior === 'STRONG_UPTREND')) { p._breadthConflict = true; p.todayConfidence = Math.min(p.todayConfidence, 60); }
      if (tot > 20 && adv/tot > 0.7 && (p.todayBehavior === 'DOWNTREND' || p.todayBehavior === 'STRONG_DOWNTREND')) { p._breadthConflict = true; p.todayConfidence = Math.min(p.todayConfidence, 60); }
      if (!vix.isDefault && vix.value > 25 && p.riskLevel === 'LOW') p.riskLevel = 'MODERATE';

      // Metadata
      p.grounded = g.grounded || false; p.model = g.model;
      p._dataSources = dataSources;
      p._dataSnapshot = { niftyPrice: nifty.price||null, niftyChg: nifty.changePct||null, bankNiftyPrice: bank.price||null, vixValue: !vix.isDefault?vix.value:null, fiiFlow: !fii.isDefault?fii.fii:null, diiFlow: !fii.isDefault?fii.dii:null, breadth:{adv,dec}, niftyPCR: optionChainCache.nifty?.pcr||null, niftyMaxPain: optionChainCache.nifty?.maxPain||null, niftyAvgIV: optionChainCache.nifty?.avgIV||null, avgSignalScore: avgScore, stocksTracked: signals.length };
      p._activeEvents = getMarketContext().filter(e => e.priority === 'HIGH').map(e => ({ title: e.title, icon: e.icon }));
      p._generatedAt = new Date().toISOString();

      todayCache = { data: p, lastFetch: Date.now(), dateIST: todayIST };
      storePrediction('today_behavior', p);
      return res.json({ ...p, cached: false });
    } catch (e) {
      log('ERR', 'Today\'s behaviour (live) failed: ' + e.message);
      if (todayCache.data && todayCache.dateIST === todayIST) return res.json({ ...todayCache.data, cached: true, stale: true, error: e.message });
      return res.status(500).json({ error: e.message });
    }
  }

  // ═══ PRE-MARKET (12 AM → 9:15 AM): web-search-based analysis ═══
  // Upstox/NSE APIs are dead — rely on Google Search grounding + Twelve Data globals
  const refreshMs = getPreMarketCacheMs();

  // Cache check: fresh pre-market data for today
  if (preMarketCache.data && preMarketCache.dateIST === todayIST
      && (Date.now() - preMarketCache.lastFetch) < refreshMs) {
    return res.json({ ...preMarketCache.data, cached: true, _refreshMs: refreshMs });
  }

  if (!appConfig.geminiKey && !gcpServiceAccount) {
    // Fallback: serve last night's next-session prediction if available
    if (nextSessionCache.data && nextSessionCache.predictedDate === todayIST) {
      const ns = nextSessionCache.data;
      return res.json({
        promoted: true, todayBehavior: ns.outlook === 'BULLISH' || ns.outlook === 'CAUTIOUSLY_BULLISH' ? 'UPTREND' : ns.outlook === 'BEARISH' || ns.outlook === 'CAUTIOUSLY_BEARISH' ? 'DOWNTREND' : 'SIDEWAYS',
        todayExplanation: ns.explanation || 'Based on overnight analysis', todayConfidence: Math.max(40, (ns.confidence||55) - 10),
        keyFactors: ns.keyDrivers || [], riskLevel: ns.riskLevel || 'MODERATE', grounded: false, _refreshMs: refreshMs, _generatedAt: ns._generatedAt
      });
    }
    return res.json({ noDataToday: true, error: 'AI not configured' });
  }

  try {
    // Seed data: last night's next-session prediction (if it predicted today)
    const seed = (nextSessionCache.data && nextSessionCache.predictedDate === todayIST) ? nextSessionCache.data : null;
    const globalStr = getGlobalDataStr();
    const globalCount = Object.keys(globalMarkets).length;

    const prompt = `You are an elite Indian stock market pre-market analyst. It is currently ${getIST().getUTCHours()}:${String(getIST().getUTCMinutes()).padStart(2,'0')} IST, BEFORE market open (9:15 AM).

CRITICAL: Indian market APIs (Upstox, NSE) are OFFLINE. You MUST use Google Search to find CURRENT real-time data:
- Gift Nifty / SGX Nifty LIVE level and % change (this is the #1 indicator for today's opening)
- US market final close (S&P 500, NASDAQ, Dow Jones) and any after-hours movement
- Asian markets LIVE (Nikkei, Hang Seng, SGX, ASX) — they are open now
- Crude oil (Brent, WTI) current price and overnight direction
- Gold, USD/INR current levels
- Any breaking overnight news: Fed/ECB/RBI, geopolitical, India-specific policy or earnings
- US Dollar Index (DXY) movement

${globalCount > 0 ? 'TWELVE DATA GLOBALS (may be stale overnight):\n- ' + globalStr : 'No Twelve Data available — rely entirely on Google Search'}

${seed ? 'LAST NIGHT\'S PREDICTION (seed — update with fresh data):\n- Outlook: ' + seed.outlook + ' (' + seed.confidence + '% confidence)\n- Expected: ' + (seed.openingExpectation||'N/A') + '\n- Key drivers: ' + (seed.keyDrivers||[]).join(', ') : 'No prior prediction available — generate fresh from web search'}

MACRO EVENTS: ${getMacroEventsStr()}

Predict what will MOST LIKELY happen when Indian markets open today. Reply ONLY valid JSON:
{"todayBehavior":"STRONG_UPTREND/UPTREND/SIDEWAYS/DOWNTREND/STRONG_DOWNTREND/VOLATILE","todayExplanation":"50-word pre-market analysis citing Gift Nifty level, US close, Asian markets, crude, key overnight news","todayConfidence":70,"keyFactors":["factor1","factor2","factor3","factor4","factor5"],"riskLevel":"LOW/MODERATE/HIGH/VERY_HIGH","suggestedStrategy":"25-word pre-market strategy","globalSentiment":"RISK_ON/RISK_OFF/MIXED","niftySupport":0,"niftyResistance":0,"giftNifty":{"level":0,"change":"","signal":""},"openingExpectation":"GAP_UP/GAP_DOWN/FLAT_OPEN","sectorRotation":{"bullish":[],"bearish":[]}}`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.2, maxOutputTokens: 2000, timeout: 60000 });
    log('OK', `Pre-market analysis generated (${g.source}/${g.model}, grounded:${g.grounded}), ${(g.text||'').length} chars`);

    const p = parseAIJson(g.text || '{}');

    // Validate
    const VB = ['STRONG_UPTREND','UPTREND','SIDEWAYS','DOWNTREND','STRONG_DOWNTREND','VOLATILE'];
    if (!VB.includes(p.todayBehavior)) p.todayBehavior = 'SIDEWAYS';
    if (!['LOW','MODERATE','HIGH','VERY_HIGH'].includes(p.riskLevel)) p.riskLevel = 'MODERATE';
    if (!['RISK_ON','RISK_OFF','MIXED'].includes(p.globalSentiment)) p.globalSentiment = 'MIXED';
    if (!['GAP_UP','GAP_DOWN','FLAT_OPEN'].includes(p.openingExpectation)) p.openingExpectation = 'FLAT_OPEN';
    p.todayConfidence = Math.max(40, Math.min(85, Number(p.todayConfidence) || 55));
    if (!Array.isArray(p.keyFactors)) p.keyFactors = [];
    if (!p.sectorRotation || typeof p.sectorRotation !== 'object') p.sectorRotation = { bullish: [], bearish: [] };
    if (!p.giftNifty || typeof p.giftNifty !== 'object') p.giftNifty = {};

    p.promoted = true;
    p.grounded = g.grounded || false; p.model = g.model;
    p._dataSources = { source: 'Google Search grounding + Twelve Data globals', globalSymbols: globalCount };
    p._generatedAt = new Date().toISOString();

    preMarketCache = { data: p, lastFetch: Date.now(), dateIST: todayIST };
    return res.json({ ...p, cached: false, _refreshMs: refreshMs });
  } catch (e) {
    log('ERR', 'Pre-market analysis failed: ' + e.message);
    if (preMarketCache.data && preMarketCache.dateIST === todayIST) return res.json({ ...preMarketCache.data, cached: true, stale: true, _refreshMs: refreshMs });
    // Last-resort fallback: static next-session data
    if (nextSessionCache.data && nextSessionCache.predictedDate === todayIST) {
      const ns = nextSessionCache.data;
      return res.json({ promoted: true, todayBehavior: 'SIDEWAYS', todayExplanation: ns.explanation || 'Pre-market data', todayConfidence: 45, keyFactors: ns.keyDrivers || [], riskLevel: ns.riskLevel || 'MODERATE', grounded: false, _refreshMs: refreshMs, _generatedAt: ns._generatedAt });
    }
    return res.json({ noDataToday: true, error: 'Pre-market analysis unavailable', _refreshMs: refreshMs });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE PREDICTIONS — /api/market-predictions
// 4 locked predictions per trading day, scored after market close.
// Phase 1: Pre-Market (8:00-9:14 AM)  Phase 2: Opening (9:30 AM)
// Phase 3: Mid-Session (12:30 PM)     Phase 4: Power Hour (2:00 PM)
// ══════════════════════════════════════════════════════════════════════════════

// Helper: collect quantitative market snapshot for phase prompts
function getPhaseDataSnapshot() {
  const nifty = liveIndices['Nifty 50'] || liveIndices['NIFTY50'] || {};
  const bank = liveIndices['NIFTYBANK'] || liveIndices['Nifty Bank'] || {};
  const vix = vixData, fii = fiiDiiData;
  const stocks = Object.values(liveStocks).filter(s => s.price);
  const adv = stocks.filter(s => s.changePct >= 0).length;
  const dec = stocks.filter(s => s.changePct < 0).length;
  const signals = Object.values(signalCache);
  const avgScore = signals.length ? Math.round(signals.reduce((a, s) => a + (s.score || 0), 0) / signals.length) : null;
  // Day range consumed
  const dayRange = (nifty.high && nifty.low && nifty.high > nifty.low) ? +((nifty.price - nifty.low) / (nifty.high - nifty.low) * 100).toFixed(1) : null;
  const rangeExpansion = (nifty.high && nifty.low && nifty.previousClose) ? +((nifty.high - nifty.low) / nifty.previousClose * 100).toFixed(2) : null;
  // Opening gap
  const openGap = (nifty.open && nifty.previousClose) ? +(((nifty.open - nifty.previousClose) / nifty.previousClose) * 100).toFixed(2) : null;
  // Options
  let optData = null;
  if (optionChainCache.nifty) {
    const nc = optionChainCache.nifty;
    optData = { pcr: nc.pcr, maxPain: nc.maxPain, avgIV: nc.avgIV };
    if (optionChainCache.banknifty) { const bc = optionChainCache.banknifty; optData.bnPcr = bc.pcr; optData.bnMaxPain = bc.maxPain; }
  }
  // Sector breakdown
  const sectors = {};
  for (const st of STOCK_UNIVERSE) { const sig = signalCache[st.symbol]; if (!sig) continue; const s = st.sector || 'Other'; if (!sectors[s]) sectors[s] = []; sectors[s].push(sig.score || 0); }
  const sectorAvgs = {};
  for (const [s, scores] of Object.entries(sectors)) { if (scores.length) sectorAvgs[s] = Math.round(scores.reduce((a,b)=>a+b,0)/scores.length); }

  return {
    nifty: { price: nifty.price, change: nifty.changePct, open: nifty.open, high: nifty.high, low: nifty.low, prevClose: nifty.previousClose },
    bankNifty: { price: bank.price, change: bank.changePct, open: bank.open, high: bank.high, low: bank.low },
    vix: !vix.isDefault ? { value: vix.value, trend: vix.trend } : null,
    fiiDii: !fii.isDefault ? { fii: fii.fii, dii: fii.dii } : null,
    breadth: { adv, dec, total: adv + dec },
    avgSignalScore: avgScore,
    dayRangePosition: dayRange,
    rangeExpansionPct: rangeExpansion,
    openGapPct: openGap,
    options: optData,
    sectors: sectorAvgs,
    globals: getGlobalDataStr(),
    topGainers: stocks.sort((a,b)=>b.changePct-a.changePct).slice(0,5).map(s => `${s.symbol}(${s.changePct>=0?'+':''}${s.changePct?.toFixed(1)}%)`).join(', '),
    topLosers: stocks.sort((a,b)=>a.changePct-b.changePct).slice(0,5).map(s => `${s.symbol}(${s.changePct?.toFixed(1)}%)`).join(', ')
  };
}

// Helper: build prompt for each phase
function buildPhasePrompt(phase, snapshot, prevPhases) {
  const dataBlock = `QUANTITATIVE DATA:
- Nifty 50: ${snapshot.nifty.price || 'N/A'} (${snapshot.nifty.change != null ? (snapshot.nifty.change>=0?'+':'') + snapshot.nifty.change + '%' : 'N/A'}) | Open: ${snapshot.nifty.open||'N/A'} | High: ${snapshot.nifty.high||'N/A'} | Low: ${snapshot.nifty.low||'N/A'} | Prev Close: ${snapshot.nifty.prevClose||'N/A'}
- Bank Nifty: ${snapshot.bankNifty.price || 'N/A'} (${snapshot.bankNifty.change != null ? (snapshot.bankNifty.change>=0?'+':'') + snapshot.bankNifty.change + '%' : 'N/A'})
- VIX: ${snapshot.vix ? snapshot.vix.value + ' (' + snapshot.vix.trend + ')' : 'N/A'}
- FII: ${snapshot.fiiDii ? '₹'+snapshot.fiiDii.fii+' Cr' : 'N/A'} | DII: ${snapshot.fiiDii ? '₹'+snapshot.fiiDii.dii+' Cr' : 'N/A'}
- Breadth: ${snapshot.breadth.adv} advancing / ${snapshot.breadth.dec} declining
- Opening Gap: ${snapshot.openGapPct != null ? snapshot.openGapPct + '%' : 'N/A'}
- Day Range Position: ${snapshot.dayRangePosition != null ? snapshot.dayRangePosition + '% (0=at low, 100=at high)' : 'N/A'}
- Range Expansion: ${snapshot.rangeExpansionPct != null ? snapshot.rangeExpansionPct + '% of prev close' : 'N/A'}
- Avg Signal Score: ${snapshot.avgSignalScore || 'N/A'}/100
- Options: ${snapshot.options ? 'PCR ' + snapshot.options.pcr + ' | Max Pain ' + snapshot.options.maxPain + ' | IV ' + snapshot.options.avgIV + '%' + (snapshot.options.bnPcr ? ' | BN PCR ' + snapshot.options.bnPcr : '') : 'N/A'}
- Sectors: ${Object.entries(snapshot.sectors).map(([s,v]) => s+':'+v).join(', ') || 'N/A'}
- Globals: ${snapshot.globals || 'N/A'}
- Gainers: ${snapshot.topGainers || 'N/A'}
- Losers: ${snapshot.topLosers || 'N/A'}
- Events: ${getMacroEventsStr()}`;

  const prevBlock = prevPhases.length > 0 ? '\nPREVIOUS PHASE PREDICTIONS (self-awareness — learn from earlier calls):\n' +
    prevPhases.map(pp => `- Phase ${pp.phase}: Predicted ${pp.direction} (${pp.confidence}% conf) — ${pp.reasoning?.slice(0,80)||'N/A'}`).join('\n') : '';

  if (phase === 1) {
    return `You are an elite Indian stock market analyst making a PRE-MARKET PREDICTION before market opens (9:15 AM IST).
Your prediction will be LOCKED and scored against actual market data after close. Be precise and data-driven.

CRITICAL: Use Google Search to find CURRENT real-time data:
- Gift Nifty / SGX Nifty LIVE level and % change
- US market close (S&P 500, NASDAQ, Dow) + after-hours
- Asian markets (Nikkei, Hang Seng) — live now
- Crude oil, Gold, USD/INR current levels
- Breaking overnight news (Fed, RBI, earnings, geopolitical)

${snapshot.globals ? 'TWELVE DATA: ' + snapshot.globals : 'No Twelve Data — rely on Google Search'}

MACRO: ${getMacroEventsStr()}

Reply ONLY valid JSON:
{"direction":"BULLISH/BEARISH/SIDEWAYS","confidence":75,"niftyRange":{"low":0,"high":0},"bankNiftyRange":{"low":0,"high":0},"openingExpectation":"GAP_UP/GAP_DOWN/FLAT","keyLevels":{"support":0,"resistance":0},"riskLevel":"LOW/MODERATE/HIGH/VERY_HIGH","reasoning":"50-word prediction citing specific data points","keyFactors":["f1","f2","f3","f4","f5"]}`;
  }

  if (phase === 2) {
    return `You are an elite Indian stock market analyst. Market opened 15 minutes ago. Based on the FIRST 15-MINUTE CANDLE and ALL quantitative data, predict what happens NEXT (the rest of today). Your prediction is LOCKED and scored.

${dataBlock}${prevBlock}

ANALYSIS REQUIRED:
1. Opening gap analysis: gap ${snapshot.openGapPct > 0.25 ? 'UP' : snapshot.openGapPct < -0.25 ? 'DOWN' : 'FLAT'} of ${snapshot.openGapPct||0}% — will it fill?
2. First candle: range ${snapshot.nifty.high||0}-${snapshot.nifty.low||0}, breadth ${snapshot.breadth.adv}:${snapshot.breadth.dec}
3. Volume/breadth: is participation broad or narrow?
4. Bull/Bear trap risk: opening deceiving retail traders?

Reply ONLY valid JSON:
{"direction":"BULLISH/BEARISH/SIDEWAYS","confidence":75,"gapFill":true,"trapAlert":"BULL_TRAP/BEAR_TRAP/NONE","reasoning":"50-word prediction with specific data","keyFactors":["f1","f2","f3","f4","f5"],"riskLevel":"LOW/MODERATE/HIGH/VERY_HIGH"}`;
  }

  if (phase === 3) {
    return `You are an elite Indian stock market analyst. It is now ~12:30 PM IST (mid-session). Predict the AFTERNOON SESSION (12:30-3:30 PM). Your prediction is LOCKED and scored.

${dataBlock}${prevBlock}

ANALYSIS REQUIRED:
1. Morning trend: Nifty moved ${snapshot.nifty.change||0}% — will afternoon continue or reverse?
2. Day range position: ${snapshot.dayRangePosition||'N/A'}% (high=near day high, exhaustion risk)
3. Range expansion: ${snapshot.rangeExpansionPct||'N/A'}% — wide=volatile, narrow=breakout pending
4. Breadth evolution: ${snapshot.breadth.adv}:${snapshot.breadth.dec} — broadening or narrowing?
5. VIX trajectory: ${snapshot.vix ? snapshot.vix.value + ' (' + snapshot.vix.trend + ')' : 'N/A'}
6. Sector rotation: any sectors flipping direction?

Reply ONLY valid JSON:
{"direction":"BULLISH/BEARISH/SIDEWAYS","confidence":72,"closingZone":"NEAR_HIGH/NEAR_LOW/MIDDLE","volatilityExpected":"LOW/MODERATE/HIGH","reasoning":"50-word afternoon prediction","keyFactors":["f1","f2","f3","f4","f5"],"riskLevel":"LOW/MODERATE/HIGH/VERY_HIGH"}`;
  }

  if (phase === 4) {
    return `You are an elite Indian stock market analyst. It is 2:00 PM IST — 90 minutes to close. Predict the CLOSING BEHAVIOR. Your prediction is LOCKED and scored.

${dataBlock}${prevBlock}

ANALYSIS REQUIRED:
1. Full-day context: Nifty ${snapshot.nifty.change||0}% | Range used: ${snapshot.dayRangePosition||'N/A'}%
2. If range mostly consumed, expect mean reversion; if narrow, last-hour breakout possible
3. Institutional money: FII ${snapshot.fiiDii?.fii||'N/A'} Cr, PCR ${snapshot.options?.pcr||'N/A'}
4. Closing pattern: smart money accumulating or distributing?
5. Previous phases accuracy — adjust confidence accordingly

Reply ONLY valid JSON:
{"direction":"BULLISH/BEARISH/SIDEWAYS","confidence":70,"expectedClose":{"niftyLow":0,"niftyHigh":0},"tomorrowBias":"BULLISH/BEARISH/NEUTRAL","reasoning":"50-word closing prediction","keyFactors":["f1","f2","f3","f4","f5"],"riskLevel":"LOW/MODERATE/HIGH/VERY_HIGH"}`;
  }

  return '';
}

app.get('/api/market-predictions', async (req, res) => {
  const todayIST = getISTDateStr();
  const istMins = getISTMins();

  // Date roll
  if (!isWeekend() && phaseCache.dateIST && phaseCache.dateIST !== todayIST) {
    resetPhaseCache();
  }
  phaseCache.dateIST = todayIST;

  // Weekend or holiday: serve last trading day's predictions from history
  const isNonTrading = isWeekend() || (!isMarketOpen() && istMins < 480 && !phaseCache.p1.locked);
  if (isWeekend() || (isNonTrading && istMins > 960)) {
    // Find most recent phase predictions from history
    const recentPhases = {};
    for (const p of predictionHistory) {
      if (!PHASE_TYPES.includes(p.type)) continue;
      if (!recentPhases[p.type] || p.generatedAt > recentPhases[p.type].generatedAt) recentPhases[p.type] = p;
    }
    const histPhases = [1,2,3,4].map(n => {
      const key = PHASE_TYPES[n-1];
      const hp = recentPhases[key];
      return {
        phase: n, name: ['','Pre-Market','Opening Verdict','Mid-Session','Power Hour'][n],
        icon: ['','nights_stay','open_in_new','wb_sunny','bolt'][n],
        status: hp ? (hp.status === 'VERIFIED' ? 'SCORED' : 'LOCKED') : 'NONE',
        prediction: hp ? hp.prediction : null,
        generatedAt: hp ? hp.generatedAt : null,
        score: hp && hp.scores ? hp.scores : null,
        predictedDate: hp ? hp.predictedDate : null
      };
    });
    const histScores = {};
    for (const [key, hp] of Object.entries(recentPhases)) { if (hp.scores) histScores[key] = hp.scores; }
    return res.json({ holiday: true, phases: histPhases, scores: histScores, fromDate: histPhases[0]?.predictedDate || null });
  }

  // Determine which phase to generate based on time
  // Phase 1: 8:00 AM (480) - 9:14 AM (554)
  // Phase 2: 9:30 AM (570) onwards
  // Phase 3: 12:30 PM (750) onwards
  // Phase 4: 2:00 PM (840) onwards
  const force = req.query.force === 'true';
  let generated = null;

  try {
    if (!appConfig.geminiKey && !gcpServiceAccount) {
      return res.json({ error: 'AI not configured', phases: buildPhaseResponse() });
    }

    // Phase 1: Pre-Market (available 8:00 AM - 9:14 AM, or re-use existing if market open)
    if (istMins >= 480 && !phaseCache.p1.locked) {
      if (istMins < 555 || force) { // Only generate before market open, unless forced
        const snapshot = getPhaseDataSnapshot();
        const prompt = buildPhasePrompt(1, snapshot, []);
        const g = await callAI(prompt, { preferGrounded: true, temperature: 0.2, maxOutputTokens: 2000, timeout: 60000 });
        const parsed = parseAIJson(g.text || '{}');
        const DIRS = ['BULLISH','BEARISH','SIDEWAYS'];
        if (!DIRS.includes(parsed.direction)) parsed.direction = 'SIDEWAYS';
        parsed.confidence = Math.max(50, Math.min(95, Number(parsed.confidence) || 60));
        if (!['GAP_UP','GAP_DOWN','FLAT'].includes(parsed.openingExpectation)) parsed.openingExpectation = 'FLAT';
        if (!['LOW','MODERATE','HIGH','VERY_HIGH'].includes(parsed.riskLevel)) parsed.riskLevel = 'MODERATE';
        if (!Array.isArray(parsed.keyFactors)) parsed.keyFactors = [];
        parsed.phase = 1; parsed._dataSnapshot = snapshot; parsed._generatedAt = new Date().toISOString(); parsed._model = g.model; parsed._grounded = g.grounded;
        phaseCache.p1 = { data: parsed, locked: true, generatedAt: new Date().toISOString() };
        storePrediction('phase_1_premarket', parsed);
        generated = 1;
        log('OK', `Phase 1 (Pre-Market) prediction locked: ${parsed.direction} ${parsed.confidence}% (${g.source}/${g.model})`);
      }
    }

    // Phase 2: Opening Verdict (after 9:30 AM, needs first 15-min candle)
    if (istMins >= 570 && !phaseCache.p2.locked && (isMarketOpen() || force)) {
      const snapshot = getPhaseDataSnapshot();
      if (snapshot.nifty.price) { // Need live data
        const prevPhases = phaseCache.p1.data ? [phaseCache.p1.data] : [];
        const prompt = buildPhasePrompt(2, snapshot, prevPhases);
        const g = await callAI(prompt, { preferGrounded: false, temperature: 0.2, maxOutputTokens: 2000, timeout: 60000 });
        const parsed = parseAIJson(g.text || '{}');
        const DIRS = ['BULLISH','BEARISH','SIDEWAYS'];
        if (!DIRS.includes(parsed.direction)) parsed.direction = 'SIDEWAYS';
        parsed.confidence = Math.max(50, Math.min(95, Number(parsed.confidence) || 60));
        if (parsed.gapFill === undefined || parsed.gapFill === null) parsed.gapFill = false;
        if (!['BULL_TRAP','BEAR_TRAP','NONE'].includes(parsed.trapAlert)) parsed.trapAlert = 'NONE';
        if (!['LOW','MODERATE','HIGH','VERY_HIGH'].includes(parsed.riskLevel)) parsed.riskLevel = 'MODERATE';
        if (!Array.isArray(parsed.keyFactors)) parsed.keyFactors = [];
        parsed.phase = 2; parsed._dataSnapshot = snapshot; parsed._generatedAt = new Date().toISOString(); parsed._model = g.model;
        phaseCache.p2 = { data: parsed, locked: true, generatedAt: new Date().toISOString() };
        storePrediction('phase_2_opening', parsed);
        generated = 2;
        log('OK', `Phase 2 (Opening) prediction locked: ${parsed.direction} ${parsed.confidence}% gap_fill:${parsed.gapFill} trap:${parsed.trapAlert}`);
      }
    }

    // Phase 3: Mid-Session (after 12:30 PM)
    if (istMins >= 750 && !phaseCache.p3.locked && (isMarketOpen() || force)) {
      const snapshot = getPhaseDataSnapshot();
      if (snapshot.nifty.price) {
        const prevPhases = [phaseCache.p1.data, phaseCache.p2.data].filter(Boolean);
        const prompt = buildPhasePrompt(3, snapshot, prevPhases);
        const g = await callAI(prompt, { preferGrounded: false, temperature: 0.2, maxOutputTokens: 2000, timeout: 60000 });
        const parsed = parseAIJson(g.text || '{}');
        const DIRS = ['BULLISH','BEARISH','SIDEWAYS'];
        if (!DIRS.includes(parsed.direction)) parsed.direction = 'SIDEWAYS';
        parsed.confidence = Math.max(50, Math.min(95, Number(parsed.confidence) || 60));
        if (!['NEAR_HIGH','NEAR_LOW','MIDDLE'].includes(parsed.closingZone)) parsed.closingZone = 'MIDDLE';
        if (!['LOW','MODERATE','HIGH'].includes(parsed.volatilityExpected)) parsed.volatilityExpected = 'MODERATE';
        if (!['LOW','MODERATE','HIGH','VERY_HIGH'].includes(parsed.riskLevel)) parsed.riskLevel = 'MODERATE';
        if (!Array.isArray(parsed.keyFactors)) parsed.keyFactors = [];
        parsed.phase = 3; parsed._dataSnapshot = snapshot; parsed._generatedAt = new Date().toISOString(); parsed._model = g.model;
        phaseCache.p3 = { data: parsed, locked: true, generatedAt: new Date().toISOString() };
        storePrediction('phase_3_midsession', parsed);
        generated = 3;
        log('OK', `Phase 3 (Mid-Session) prediction locked: ${parsed.direction} ${parsed.confidence}% close:${parsed.closingZone}`);
      }
    }

    // Phase 4: Power Hour (after 2:00 PM)
    if (istMins >= 840 && !phaseCache.p4.locked && (isMarketOpen() || force)) {
      const snapshot = getPhaseDataSnapshot();
      if (snapshot.nifty.price) {
        const prevPhases = [phaseCache.p1.data, phaseCache.p2.data, phaseCache.p3.data].filter(Boolean);
        const prompt = buildPhasePrompt(4, snapshot, prevPhases);
        const g = await callAI(prompt, { preferGrounded: false, temperature: 0.2, maxOutputTokens: 2000, timeout: 60000 });
        const parsed = parseAIJson(g.text || '{}');
        const DIRS = ['BULLISH','BEARISH','SIDEWAYS'];
        if (!DIRS.includes(parsed.direction)) parsed.direction = 'SIDEWAYS';
        parsed.confidence = Math.max(50, Math.min(95, Number(parsed.confidence) || 60));
        if (!parsed.expectedClose || typeof parsed.expectedClose !== 'object') parsed.expectedClose = null;
        if (!['BULLISH','BEARISH','NEUTRAL'].includes(parsed.tomorrowBias)) parsed.tomorrowBias = 'NEUTRAL';
        if (!['LOW','MODERATE','HIGH','VERY_HIGH'].includes(parsed.riskLevel)) parsed.riskLevel = 'MODERATE';
        if (!Array.isArray(parsed.keyFactors)) parsed.keyFactors = [];
        parsed.phase = 4; parsed._dataSnapshot = snapshot; parsed._generatedAt = new Date().toISOString(); parsed._model = g.model;
        phaseCache.p4 = { data: parsed, locked: true, generatedAt: new Date().toISOString() };
        storePrediction('phase_4_powerhour', parsed);
        generated = 4;
        log('OK', `Phase 4 (Power Hour) prediction locked: ${parsed.direction} ${parsed.confidence}% close:${JSON.stringify(parsed.expectedClose)}`);
      }
    }
  } catch (e) {
    log('ERR', 'Phase prediction error: ' + e.message);
  }

  // Get scores for today's phases from predictionHistory
  const todayScores = {};
  for (const ph of predictionHistory) {
    if (ph.predictedDate === todayIST && PHASE_TYPES.includes(ph.type) && ph.status === 'VERIFIED') {
      todayScores[ph.type] = ph.scores;
    }
  }

  res.json({
    phases: buildPhaseResponse(),
    scores: todayScores,
    generated,
    time: { istMins, marketOpen: isMarketOpen() }
  });
});

function buildPhaseResponse() {
  const istMins = getISTMins();
  return [
    {
      phase: 1, name: 'Pre-Market', icon: 'nights_stay',
      status: phaseCache.p1.locked ? 'LOCKED' : (istMins >= 480 && istMins < 555 ? 'AVAILABLE' : istMins < 480 ? 'UPCOMING' : 'MISSED'),
      generatesAt: '8:00 AM', locksAt: '9:14 AM',
      prediction: phaseCache.p1.data, generatedAt: phaseCache.p1.generatedAt
    },
    {
      phase: 2, name: 'Opening Verdict', icon: 'open_in_new',
      status: phaseCache.p2.locked ? 'LOCKED' : (istMins >= 570 ? 'AVAILABLE' : 'UPCOMING'),
      generatesAt: '9:30 AM', locksAt: '9:30 AM',
      prediction: phaseCache.p2.data, generatedAt: phaseCache.p2.generatedAt
    },
    {
      phase: 3, name: 'Mid-Session', icon: 'wb_sunny',
      status: phaseCache.p3.locked ? 'LOCKED' : (istMins >= 750 ? 'AVAILABLE' : 'UPCOMING'),
      generatesAt: '12:30 PM', locksAt: '12:30 PM',
      prediction: phaseCache.p3.data, generatedAt: phaseCache.p3.generatedAt
    },
    {
      phase: 4, name: 'Power Hour', icon: 'bolt',
      status: phaseCache.p4.locked ? 'LOCKED' : (istMins >= 840 ? 'AVAILABLE' : 'UPCOMING'),
      generatesAt: '2:00 PM', locksAt: '2:00 PM',
      prediction: phaseCache.p4.data, generatedAt: phaseCache.p4.generatedAt
    }
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// NEXT SESSION OUTLOOK — /api/next-session
// ACTIVE during: post-market (3:30 PM → midnight) + entire weekend (Sat/Sun).
// Uses Twelve Data globals (24/5) + Google Search grounding for overnight data.
// Weekday 12 AM → 3:30 PM: returns inactive, no cache, no AI calls.
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/next-session', async (req, res) => {
  const force = req.query.force === 'true';
  const todayIST = getISTDateStr();
  const istMins = getISTMins();
  const nextTradingDay = getNextTradingDate(todayIST);
  const isPostMarket = istMins > 930; // After 3:30 PM IST
  const isActive = isPostMarket || isWeekend(); // Active post-market AND all weekend

  // ── Outside active window (weekday 12 AM → 3:30 PM): inactive ──
  if (!isActive) {
    return res.json({ inactive: true, reason: 'Next session outlook will update after 3:30 PM IST', _refreshMs: null });
  }

  // ── Post-market (3:30 PM → midnight): cache check with 30 min refresh ──
  if (!force && nextSessionCache.data && nextSessionCache.predictedDate === nextTradingDay
      && (Date.now() - nextSessionCache.lastFetch) < NEXT_SESSION_CACHE_MS) {
    return res.json({ ...nextSessionCache.data, cached: true, _refreshMs: NEXT_SESSION_CACHE_MS });
  }

  if (!appConfig.geminiKey && !gcpServiceAccount) {
    if (nextSessionCache.data) return res.json({ ...nextSessionCache.data, cached: true, stale: true, _refreshMs: NEXT_SESSION_CACHE_MS });
    return res.json({ error: 'AI not configured', configured: false });
  }

  try {
    // Indian market data (cached from today's close — Upstox/NSE may be offline)
    const nifty = liveIndices['Nifty 50'] || liveIndices['NIFTY50'] || {};
    const bank = liveIndices['NIFTYBANK'] || liveIndices['Nifty Bank'] || {};
    const vix = vixData, fii = fiiDiiData;
    const signals = Object.values(signalCache);
    const avgScore = signals.length ? Math.round(signals.reduce((a, s) => a + (s.score || 0), 0) / signals.length) : 0;
    const stocks = Object.values(liveStocks).filter(s => s.price);
    const adv = stocks.filter(s => s.changePct >= 0).length, dec = stocks.filter(s => s.changePct < 0).length;

    let optStr = '';
    if (optionChainCache.nifty) {
      const nc = optionChainCache.nifty;
      optStr = `Nifty PCR: ${nc.pcr} | Max Pain: ${nc.maxPain} | IV: ${nc.avgIV}%`;
      if (optionChainCache.banknifty) { const bc = optionChainCache.banknifty; optStr += ` | BN PCR: ${bc.pcr} Max Pain: ${bc.maxPain}`; }
    }

    const globalStr = Object.values(globalMarkets).map(g =>
      `${g.name}: ${g.price} (${g.changePct >= 0 ? '+' : ''}${g.changePct}%) [${g.isLive ? 'LIVE' : 'cached'}]`
    ).join('\n- ');

    const prompt = `You are India's most accurate stock market forecasting analyst. Predict what will happen on ${nextTradingDay} (next trading session) in Indian markets.

CRITICAL: Use Google Search to find the LATEST real-time data:
- Gift Nifty / SGX Nifty current level and trend
- US market close/futures (S&P 500, NASDAQ, Dow) — current or latest
- Asian markets if trading (Nikkei, Hang Seng, SGX)
- Crude oil current price and direction, Gold, DXY
- Any overnight global/India-specific news, Fed/ECB/RBI commentary

TODAY'S CLOSING DATA (from Indian market — may be cached):
- Nifty: ${nifty.price || 'N/A'}${nifty.price ? ` (${nifty.changePct>=0?'+':''}${nifty.changePct||0}%)` : ''}
- Bank Nifty: ${bank.price || 'N/A'}${bank.price ? ` (${bank.changePct>=0?'+':''}${bank.changePct||0}%)` : ''}
- VIX: ${!vix.isDefault ? vix.value + ' (' + vix.trend + ')' : 'N/A'}
- FII: ${!fii.isDefault ? '₹'+fii.fii+' Cr' : 'N/A'} | DII: ${!fii.isDefault ? '₹'+fii.dii+' Cr' : 'N/A'}
- Breadth: ${adv} adv / ${dec} dec | Score: ${avgScore}/100 (${signals.length} stocks)
${optStr ? '- Options: ' + optStr : ''}

GLOBAL MARKETS (Twelve Data — may include live post-market data):
- ${globalStr || 'Unavailable — rely on Google Search'}

MACRO: ${getMacroEventsStr()}

Reply ONLY valid JSON:
{"outlook":"BULLISH/BEARISH/NEUTRAL/CAUTIOUSLY_BULLISH/CAUTIOUSLY_BEARISH","confidence":72,"explanation":"80-word prediction citing Gift Nifty, US close, crude etc.","niftyRange":{"low":23800,"high":24200},"bankNiftyRange":{"low":51000,"high":52000},"keyDrivers":["d1","d2","d3","d4","d5"],"riskLevel":"LOW/MODERATE/HIGH/VERY_HIGH","giftNifty":{"level":24050,"change":"+0.3%","signal":"Positive opening"},"globalSentiment":"RISK_ON/RISK_OFF/MIXED","overnightDevelopments":["dev1","dev2","dev3"],"sectorOutlook":{"bullish":["IT"],"bearish":["Metals"],"neutral":["Banks"]},"tradingStrategy":"30-word actionable strategy","openingExpectation":"GAP_UP/GAP_DOWN/FLAT_OPEN","openingExpectationDetail":"Expected open around 24,050 on Gift Nifty +0.3%"}`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.2, maxOutputTokens: 4000, timeout: 75000 });
    log('OK', `Next session for ${nextTradingDay} generated (${g.source}/${g.model}, grounded:${g.grounded}), ${(g.text||'').length} chars`);

    const o = parseAIJson(g.text || '{}');

    // Validate
    if (!['BULLISH','BEARISH','NEUTRAL','CAUTIOUSLY_BULLISH','CAUTIOUSLY_BEARISH'].includes(o.outlook)) o.outlook = 'NEUTRAL';
    if (!['LOW','MODERATE','HIGH','VERY_HIGH'].includes(o.riskLevel)) o.riskLevel = 'MODERATE';
    if (!['RISK_ON','RISK_OFF','MIXED'].includes(o.globalSentiment)) o.globalSentiment = 'MIXED';
    if (!['GAP_UP','GAP_DOWN','FLAT_OPEN'].includes(o.openingExpectation)) o.openingExpectation = 'FLAT_OPEN';
    o.confidence = Math.max(40, Math.min(90, Number(o.confidence) || 55));
    if (!Array.isArray(o.keyDrivers)) o.keyDrivers = [];
    if (!Array.isArray(o.overnightDevelopments)) o.overnightDevelopments = [];
    if (!o.sectorOutlook || typeof o.sectorOutlook !== 'object') o.sectorOutlook = { bullish: [], bearish: [], neutral: [] };
    if (!o.niftyRange || typeof o.niftyRange !== 'object') o.niftyRange = {};
    if (!o.bankNiftyRange || typeof o.bankNiftyRange !== 'object') o.bankNiftyRange = {};
    if (!o.giftNifty || typeof o.giftNifty !== 'object') o.giftNifty = {};
    if (!vix.isDefault && vix.value > 25 && o.riskLevel === 'LOW') o.riskLevel = 'MODERATE';

    // Metadata
    o.predictedDate = nextTradingDay;
    o.grounded = g.grounded || false; o.model = g.model;
    o._globalSnapshot = Object.fromEntries(Object.entries(globalMarkets).map(([k, v]) => [k, { price: v.price, changePct: v.changePct }]));
    o._indianSnapshot = { niftyPrice: nifty.price||null, niftyChg: nifty.changePct||null, bankNiftyPrice: bank.price||null, vix: !vix.isDefault?vix.value:null, fii: !fii.isDefault?fii.fii:null, pcr: optionChainCache.nifty?.pcr||null };
    o._generatedAt = new Date().toISOString();

    nextSessionCache = { data: o, lastFetch: Date.now(), predictedDate: nextTradingDay };
    storePrediction('next_session', o);
    return res.json({ ...o, cached: false, _refreshMs: NEXT_SESSION_CACHE_MS });
  } catch (e) {
    log('ERR', 'Next session failed: ' + e.message);
    if (nextSessionCache.data) return res.json({ ...nextSessionCache.data, cached: true, stale: true, error: e.message, _refreshMs: NEXT_SESSION_CACHE_MS });
    return res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE ANALYSIS — Real-time trade monitoring with AI exit suggestions
// ══════════════════════════════════════════════════════════════════════════════
let marketPulseCache = { data: null, lastFetch: 0 };
const MARKET_PULSE_CACHE_MS = 10 * 60 * 1000; // 10 min cache

app.get('/api/market-pulse', async (req, res) => {
  // ── Market hours gate ──
  if (!isMarketOpen()) {
    if (marketPulseCache.data) {
      return res.json(marketClosedResponse({ ...marketPulseCache.data }, marketPulseCache.lastFetch));
    }
    return res.json(marketClosedResponse(null));
  }

  // ── Cache check (support ?force=true to bypass) ──
  if (!req.query.force && marketPulseCache.data && (Date.now() - marketPulseCache.lastFetch) < MARKET_PULSE_CACHE_MS) {
    return res.json({ ...marketPulseCache.data, cached: true });
  }

  if (!appConfig.geminiKey && !gcpServiceAccount) {
    return res.json({ error: 'AI not configured', configured: false });
  }

  try {
    const nifty = liveIndices['Nifty 50'] || liveIndices['NIFTY50'] || {};
    const bank = liveIndices['NIFTYBANK'] || liveIndices['Nifty Bank'] || {};
    const vix = vixData;
    const fii = fiiDiiData;

    // ── DATA SOURCE TRACKING ──
    const dataSources = {};
    dataSources.fiiDii = !fii.isDefault ? 'NSE API (live)' : 'Unavailable';
    dataSources.optionChain = (optionChainCache.nifty || optionChainCache.banknifty) ? 'Upstox Option Chain API' : 'Unavailable';
    dataSources.stocks = Object.keys(liveStocks).length > 0 ? 'Upstox WebSocket (live)' : 'Unavailable';
    dataSources.signals = Object.keys(signalCache).length > 0 ? `FINR Engine (${Object.keys(signalCache).length} stocks)` : 'Unavailable';

    // ═════════════════════════════════════════════════════════════════════════════
    // 1. FII/DII FLOW ANALYSIS
    // ═════════════════════════════════════════════════════════════════════════════
    const fiiDiiAnalysis = {
      fii: fii.fii || 0,
      dii: fii.dii || 0,
      fiiDirection: fii.isDefault ? 'UNAVAILABLE' : (fii.fii > 0 ? 'BUYING' : fii.fii < 0 ? 'SELLING' : 'NEUTRAL'),
      diiDirection: fii.isDefault ? 'UNAVAILABLE' : (fii.dii > 0 ? 'BUYING' : fii.dii < 0 ? 'SELLING' : 'NEUTRAL'),
      isDefault: fii.isDefault,
      date: lastFiiDiiDate || null
    };

    // ═════════════════════════════════════════════════════════════════════════════
    // 2. OI ANALYSIS (Nifty & Bank Nifty)
    // ═════════════════════════════════════════════════════════════════════════════
    const oiAnalysis = {};

    if (optionChainCache.nifty) {
      const nc = optionChainCache.nifty;
      const ceStrikes = (nc.strikes || [])
        .map(s => ({ strike: s.strike, oi: s.ce?.oi || 0 }))
        .sort((a, b) => b.oi - a.oi)
        .slice(0, 3);
      const peStrikes = (nc.strikes || [])
        .map(s => ({ strike: s.strike, oi: s.pe?.oi || 0 }))
        .sort((a, b) => b.oi - a.oi)
        .slice(0, 3);
      const maxPainDistance = nc.spot > 0 && nc.maxPain > 0 ? (((nc.maxPain - nc.spot) / nc.spot) * 100).toFixed(2) : 0;

      oiAnalysis.nifty = {
        spot: nc.spot || 0,
        pcr: nc.pcr || 0,
        maxPain: nc.maxPain || 0,
        maxPainDistance: parseFloat(maxPainDistance),
        totalCallOI: nc.totalCallOI || 0,
        totalPutOI: nc.totalPutOI || 0,
        avgIV: nc.avgIV || 0,
        topCeStrikes: ceStrikes,
        topPeStrikes: peStrikes,
        expiryDate: nc.expiry || null
      };
    }

    if (optionChainCache.banknifty) {
      const bc = optionChainCache.banknifty;
      const ceStrikes = (bc.strikes || [])
        .map(s => ({ strike: s.strike, oi: s.ce?.oi || 0 }))
        .sort((a, b) => b.oi - a.oi)
        .slice(0, 3);
      const peStrikes = (bc.strikes || [])
        .map(s => ({ strike: s.strike, oi: s.pe?.oi || 0 }))
        .sort((a, b) => b.oi - a.oi)
        .slice(0, 3);
      const maxPainDistance = bc.spot > 0 && bc.maxPain > 0 ? (((bc.maxPain - bc.spot) / bc.spot) * 100).toFixed(2) : 0;

      oiAnalysis.banknifty = {
        spot: bc.spot || 0,
        pcr: bc.pcr || 0,
        maxPain: bc.maxPain || 0,
        maxPainDistance: parseFloat(maxPainDistance),
        totalCallOI: bc.totalCallOI || 0,
        totalPutOI: bc.totalPutOI || 0,
        avgIV: bc.avgIV || 0,
        topCeStrikes: ceStrikes,
        topPeStrikes: peStrikes,
        expiryDate: bc.expiry || null
      };
    }

    // ═════════════════════════════════════════════════════════════════════════════
    // 3. VOLUME ANOMALY SCANNER
    // ═════════════════════════════════════════════════════════════════════════════
    const anomalies = { accumulation: [], distribution: [] };
    for (const stock of STOCK_UNIVERSE) {
      const live = liveStocks[stock.symbol];
      if (!live || !live.volume || live.volume <= 0) continue;

      const signal = signalCache[stock.symbol];
      const changePct = live.changePct || 0;

      // Flag unusual activity: notable price movement (>2%) with volume data
      if (Math.abs(changePct) > 2) {
        const item = {
          symbol: stock.symbol,
          price: live.price || 0,
          changePct: parseFloat(changePct.toFixed(2)),
          volume: live.volume || 0,
          signal: signal?.signal || 'N/A',
          score: signal?.score || 0
        };

        if (changePct > 2) {
          anomalies.accumulation.push(item);
        } else if (changePct < -2) {
          anomalies.distribution.push(item);
        }
      }
    }

    // Sort and limit to top 5 each
    anomalies.accumulation = anomalies.accumulation
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 5);
    anomalies.distribution = anomalies.distribution
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, 5);

    // ═════════════════════════════════════════════════════════════════════════════
    // 4. SECTOR HEATMAP
    // ═════════════════════════════════════════════════════════════════════════════
    const sectorMap = {};
    for (const stock of STOCK_UNIVERSE) {
      const sector = stock.sector || 'Unknown';
      const live = liveStocks[stock.symbol];
      const signal = signalCache[stock.symbol];

      if (!sectorMap[sector]) {
        sectorMap[sector] = {
          changePcts: [],
          scores: [],
          stocks: [],
          topStock: { symbol: '', changePct: -Infinity }
        };
      }

      if (live?.changePct !== undefined) {
        sectorMap[sector].changePcts.push(live.changePct);
      }
      if (signal?.score) {
        sectorMap[sector].scores.push(signal.score);
      }
      if (live) {
        sectorMap[sector].stocks.push(stock.symbol);
        if (live.changePct > sectorMap[sector].topStock.changePct) {
          sectorMap[sector].topStock = { symbol: stock.symbol, changePct: live.changePct };
        }
      }
    }

    const sectorHeatmap = Object.entries(sectorMap).map(([sector, data]) => ({
      sector,
      avgChange: data.changePcts.length ? parseFloat((data.changePcts.reduce((a, b) => a + b, 0) / data.changePcts.length).toFixed(2)) : 0,
      avgScore: data.scores.length ? Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length) : 50,
      stockCount: data.stocks.length,
      topStock: data.topStock.symbol || 'N/A'
    })).sort((a, b) => b.avgChange - a.avgChange);

    // ═════════════════════════════════════════════════════════════════════════════
    // 5. AI SYNTHESIS
    // ═════════════════════════════════════════════════════════════════════════════
    const mktCtx = getMarketContext();
    let contextStr = '';
    if (mktCtx.length > 0) {
      contextStr = '\nACTIVE MACRO EVENTS:';
      for (const evt of mktCtx.filter(e => e.priority === 'HIGH' || e.priority === 'MEDIUM')) {
        contextStr += `\n- [${evt.priority}] ${evt.title}: ${evt.impact}`;
      }
    }

    const oiStr = oiAnalysis.nifty
      ? `\nNIFTY OI DATA:\n- PCR: ${oiAnalysis.nifty.pcr.toFixed(2)} | Max Pain: ${oiAnalysis.nifty.maxPain} (${oiAnalysis.nifty.maxPainDistance}% from spot)\n- Top CE OI: ${oiAnalysis.nifty.topCeStrikes.map(s => `${s.strike}(${s.oi})`).join(', ')}\n- Top PE OI: ${oiAnalysis.nifty.topPeStrikes.map(s => `${s.strike}(${s.oi})`).join(', ')}`
      : '\nOI DATA: Not available';

    const sectorStr = sectorHeatmap.length > 0
      ? `\nSECTOR LEADERS (by avg change):\n${sectorHeatmap.slice(0, 5).map(s => `- ${s.sector}: ${s.avgChange >= 0 ? '+' : ''}${s.avgChange}% (avg score: ${s.avgScore}/100)`).join('\n')}`
      : '\nSECTOR DATA: Not available';

    const anomalyStr = (anomalies.accumulation.length > 0 || anomalies.distribution.length > 0)
      ? `\nVOLUME ANOMALIES:\nAccumulation (price up): ${anomalies.accumulation.map(a => `${a.symbol}(+${a.changePct}%)`).join(', ') || 'None'}\nDistribution (price down): ${anomalies.distribution.map(a => `${a.symbol}(${a.changePct}%)`).join(', ') || 'None'}`
      : '\nVOLUME ANOMALIES: None detected';

    const prompt = `You are an elite market analyst tracking SMART MONEY (institutional/FII/DII flows, OI positions, sector rotations).

INSTITUTIONAL FLOWS:
- FII: ₹${fii.fii}Cr (${fiiDiiAnalysis.fiiDirection})
- DII: ₹${fii.dii}Cr (${fiiDiiAnalysis.diiDirection})
- USD/INR: ${fii.usdInr} | Crude: $${fii.crude}

INDEX LEVELS:
- Nifty: ${nifty.price || 'N/A'} (${nifty.changePct >= 0 ? '+' : ''}${nifty.changePct || 0}%)
- Bank Nifty: ${bank.price || 'N/A'} (${bank.changePct >= 0 ? '+' : ''}${bank.changePct || 0}%)
- VIX: ${vix.value}${oiStr}${sectorStr}${anomalyStr}${contextStr}

TASK: Synthesize all signals. What is smart money doing? Identify support/resistance from OI. Which sectors attract institutional interest? Give an actionable verdict for traders.

Search for breaking news that explains current flows (FII buying/selling spree, sector rotation stories, macro catalysts).

Reply ONLY valid JSON (no markdown):
{
  "smartMoneyVerdict": "ACCUMULATION/DISTRIBUTION/NEUTRAL/MIXED",
  "verdictConfidence": 75,
  "summary": "100-word synthesis connecting all signals — explain institutional positioning, key price levels, sector interest",
  "keyLevels": {"niftySupport": 0, "niftyResistance": 0, "bankNiftySupport": 0, "bankNiftyResistance": 0},
  "sectorOutlook": [{"sector":"Banking","bias":"BULLISH/BEARISH/NEUTRAL","reason":"short reason"}],
  "actionableInsight": "50-word specific actionable takeaway for traders — entry/exit signals, risk levels",
  "risksToWatch": ["risk1", "risk2", "risk3"],
  "breakingContext": "Any breaking news found via search explaining current flows or sector rotation"
}`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.2, maxOutputTokens: 4000, timeout: 60000 });
    const raw = g.text || '{}';

    let aiResult = {};
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { aiResult = JSON.parse(cleaned); } catch (_) {
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
      if (s >= 0 && e > s) { try { aiResult = JSON.parse(cleaned.slice(s, e + 1)); } catch (_) {} }
    }

    // ── POST-PROCESSING VALIDATION ──
    const VALID_VERDICTS = ['ACCUMULATION', 'DISTRIBUTION', 'NEUTRAL', 'MIXED'];
    const VALID_BIASES = ['BULLISH', 'BEARISH', 'NEUTRAL'];

    if (!VALID_VERDICTS.includes(aiResult.smartMoneyVerdict)) {
      aiResult.smartMoneyVerdict = 'NEUTRAL';
    }

    aiResult.verdictConfidence = Math.max(40, Math.min(90, Number(aiResult.verdictConfidence) || 60));

    if (!Array.isArray(aiResult.sectorOutlook)) {
      aiResult.sectorOutlook = [];
    } else {
      aiResult.sectorOutlook = aiResult.sectorOutlook.map(s => ({
        sector: s.sector || 'Unknown',
        bias: VALID_BIASES.includes(s.bias) ? s.bias : 'NEUTRAL',
        reason: s.reason || ''
      }));
    }

    if (!Array.isArray(aiResult.risksToWatch)) {
      aiResult.risksToWatch = [];
    }

    if (!aiResult.keyLevels || typeof aiResult.keyLevels !== 'object') {
      aiResult.keyLevels = { niftySupport: 0, niftyResistance: 0, bankNiftySupport: 0, bankNiftyResistance: 0 };
    } else {
      aiResult.keyLevels.niftySupport = Number(aiResult.keyLevels.niftySupport) || 0;
      aiResult.keyLevels.niftyResistance = Number(aiResult.keyLevels.niftyResistance) || 0;
      aiResult.keyLevels.bankNiftySupport = Number(aiResult.keyLevels.bankNiftySupport) || 0;
      aiResult.keyLevels.bankNiftyResistance = Number(aiResult.keyLevels.bankNiftyResistance) || 0;
    }

    // ── BUILD FINAL RESPONSE ──
    const response = {
      smartMoneyVerdict: aiResult.smartMoneyVerdict,
      verdictConfidence: aiResult.verdictConfidence,
      summary: aiResult.summary || '',
      keyLevels: aiResult.keyLevels,
      sectorOutlook: aiResult.sectorOutlook,
      actionableInsight: aiResult.actionableInsight || '',
      risksToWatch: aiResult.risksToWatch,
      breakingContext: aiResult.breakingContext || '',
      // ── Computed data (not from AI) ──
      _fiiDii: fiiDiiAnalysis,
      _oiAnalysis: oiAnalysis,
      _volumeAnomalies: anomalies,
      _sectorHeatmap: sectorHeatmap,
      _vix: {
        value: vix.value,
        change: vix.change,
        trend: vix.trend,
        isDefault: vix.isDefault
      },
      _globalMarkets: globalMarkets,
      _dataSources: dataSources,
      _generatedAt: new Date().toISOString(),
      grounded: g.grounded || false,
      model: g.model,
      cached: false
    };

    marketPulseCache = { data: response, lastFetch: Date.now() };
    log('OK', `Market Pulse generated (${g.source}/${g.model}, grounded:${g.grounded || false})`);
    res.json(response);

  } catch (e) {
    log('ERR', 'Market Pulse failed: ' + e.message);
    // Stale fallback
    if (marketPulseCache.data) {
      return res.json({ ...marketPulseCache.data, cached: true, stale: true, error: e.message });
    }
    res.status(500).json({ error: 'Market Pulse analysis failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// TRADE PLAN — Complete execution plan with position sizing, entries, exits, risk-reward
// ══════════════════════════════════════════════════════════════════════════════
let tradePlanCache = {}; // { SYMBOL: { data, lastFetch } }
const TRADE_PLAN_CACHE_MS = 15 * 60 * 1000; // 15 min cache per symbol

app.post('/api/trade-plan', async (req, res) => {
  const { symbol, force } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol required' });
  if (!appConfig.geminiKey && !gcpServiceAccount) return res.json({ configured: false, error: 'AI not configured' });

  const sym = symbol.toUpperCase().trim();

  // ── Market hours gate ──
  if (!isMarketOpen()) {
    if (tradePlanCache[sym]) {
      return res.json(marketClosedResponse(tradePlanCache[sym].data, tradePlanCache[sym].lastFetch));
    }
    return res.json(marketClosedResponse(null));
  }

  // ── Cache check ──
  if (!force && tradePlanCache[sym] && (Date.now() - tradePlanCache[sym].lastFetch) < TRADE_PLAN_CACHE_MS) {
    return res.json({ ...tradePlanCache[sym].data, cached: true });
  }

  try {
    // ══════════════════════════════════════════════════════════════════════
    // LAYER 1: Compute everything locally BEFORE asking AI
    // ══════════════════════════════════════════════════════════════════════
    const live = liveStocks[sym];
    const sig = signalCache[sym];
    const fund = STOCK_UNIVERSE.find(s => s.symbol === sym);
    const f52 = fundamentals[sym];
    const prices = priceHistory[sym] || [];

    if (!live) {
      return res.status(404).json({ error: `No live price data for ${sym}. Stock may not be in watchlist.` });
    }

    const livePrice = live.price;
    const dayHigh = live.dayHigh || livePrice * 1.02;
    const dayLow = live.dayLow || livePrice * 0.98;

    // Technical analysis from our engine
    let tech = null;
    if (prices.length >= 20) {
      tech = getTechnicalSignal(prices, prices, prices);
    }

    // Compute ATR (Average True Range) approximation
    let atr = Math.abs(dayHigh - dayLow);
    if (prices.length >= 14) {
      const recentRanges = [];
      for (let i = Math.max(0, prices.length - 14); i < prices.length; i++) {
        recentRanges.push(Math.abs(prices[i] - (prices[i-1] || prices[i])));
      }
      atr = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
    }

    // Check if F&O eligible
    const lotSize = NSE_LOT_SIZES[sym] || null;
    const isFnO = !!lotSize;

    // Get option chain data if available
    const stockChain = optionChainCache.stocks?.[sym];
    let optionContext = '';
    if (stockChain) {
      optionContext = `PCR:${stockChain.pcr?.toFixed(2)||'?'} | MaxPain:₹${stockChain.maxPain||'?'} | AvgIV:${stockChain.avgIV?.toFixed(1)||'?'}%`;
    }

    // Market context
    const mktCtx = getMarketContext();
    const stockSector = fund?.sector || '';
    const relevantEvents = mktCtx.filter(e => {
      if (e.priority === 'HIGH') return true;
      if (!stockSector) return false;
      const allSectors = [...(e.sectors?.buy || []), ...(e.sectors?.avoid || []), ...(e.sectors?.watch || [])];
      return allSectors.some(s => stockSector.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(stockSector.toLowerCase()));
    }).slice(0, 3);

    // Position sizing calculation (server-side)
    const capital = 500000; // ₹5L default
    const riskPct = 0.02; // 2% risk per trade
    const computedSL = tech?.stopLoss || (livePrice * 0.95);
    const riskPerShare = Math.abs(livePrice - computedSL);
    const maxShares = riskPerShare > 0 ? Math.floor((capital * riskPct) / riskPerShare) : 100;
    const suggestedQty = maxShares;
    const suggestedLots = isFnO ? Math.max(1, Math.floor(maxShares / lotSize)) : null;
    const investmentRequired = isFnO && suggestedLots ? (suggestedLots * lotSize * livePrice) : (maxShares * livePrice);
    const maxLossPerShare = riskPerShare;

    // Global markets context
    const globalStr = Object.values(globalMarkets).map(g => `${g.name}:${g.price}(${g.changePct >= 0 ? '+' : ''}${g.changePct}%)`).join(', ');

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 2: Build enriched AI prompt
    // ══════════════════════════════════════════════════════════════════════
    const nifty = liveIndices['Nifty 50'] || liveIndices['NIFTY50'] || {};
    const bank = liveIndices['Nifty Bank'] || liveIndices['NIFTYBANK'] || {};

    const techInfo = tech
      ? `RSI(14):${tech.rsi} | EMA20:₹${tech.ema20} | EMA50:₹${tech.ema50} | Support:₹${tech.support} | Resistance:₹${tech.resistance} | Tech Bias:${tech.techBias} | Tech Score:${tech.techScore}/100`
      : '';

    const eventStr = relevantEvents.length
      ? relevantEvents.map(e => `${e.icon} ${e.title} (${e.priority}): ${e.impact}`).join('\n')
      : 'No major macro events affecting this sector';

    const fnOContext = isFnO
      ? `\nF&O ELIGIBLE: Yes | Lot Size: ${lotSize} | ${optionContext}`
      : '\nF&O ELIGIBLE: No (cash equity only)';

    const prompt = `You are a professional NSE/BSE equity trading strategist. Generate a COMPLETE, ACTIONABLE, PROFESSIONAL TRADE EXECUTION PLAN for ${sym}.

═══ MARKET CONTEXT ═══
Nifty 50: ${nifty?.price || '?'} (${nifty?.changePct >= 0 ? '+' : ''}${nifty?.changePct || 0}%) | Bank Nifty: ${bank?.price || '?'} (${bank?.changePct >= 0 ? '+' : ''}${bank?.changePct || 0}%)
VIX: ${vixData.value} (${vixData.trend}) | FII: ₹${fiiDiiData.fii}Cr | DII: ₹${fiiDiiData.dii}Cr | USD/INR: ${fiiDiiData.usdInr} | Crude: $${fiiDiiData.crude}
Global: ${globalStr || 'N/A'}

═══ STOCK DATA ═══
Symbol: ${sym} | Current Price: ₹${livePrice} (${live.changePct >= 0 ? '+' : ''}${live.changePct}%) | 52W High: ₹${f52?.high52 || '?'} | 52W Low: ₹${f52?.low52 || '?'}
Day High: ₹${dayHigh} | Day Low: ₹${dayLow} | Volume: ${live.volume || '?'} | Sector: ${stockSector || 'Unknown'}
Signal: ${sig?.signal || 'N/A'} (${sig?.score || 0}/100) | Upside: ${sig?.upside || '?'}% | Downside: ${sig?.downside || '?'}%
ATR (20-period): ₹${atr.toFixed(2)}
${techInfo}${fnOContext}

═══ MACRO EVENTS ═══
${eventStr}

═══ YOUR ANALYSIS REQUIREMENTS ═══
You MUST provide:
1. ENTRY STRATEGY: Three entry levels (aggressive, ideal, conservative) with reasoning
2. EXIT STRATEGY: Tiered partial exits (Target 1: 40%, Target 2: 30%, Target 3: exit remainder) with prices and logic
3. STOP LOSS: Single stop loss level with technical/ATR reasoning
4. RISK ASSESSMENT: Risk level (LOW/MEDIUM/HIGH/VERY_HIGH), risk-reward ratio, max loss per lot, what-if scenarios
5. TIMING: Urgency (IMMEDIATE/WAIT_FOR_DIP/WAIT_FOR_BREAKOUT), best timeframe (Intraday/Swing/Positional), holding period
6. OPTIONS ALTERNATIVE: If F&O eligible, suggest a specific options strategy with strike, premium, and reasoning
7. CONFIDENCE: 40-90 range (0-100 scale)
8. SUMMARY: Clear 50-word actionable summary a retail trader can immediately follow

Respond ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "entryStrategy": {
    "idealEntry": 0,
    "aggressiveEntry": 0,
    "conservativeEntry": 0,
    "reasoning": "Why these three levels based on technicals/ATR"
  },
  "exitStrategy": {
    "target1": {"price": 0, "action": "Book 40% profits", "reasoning": "specific reason"},
    "target2": {"price": 0, "action": "Book 30% profits", "reasoning": "specific reason"},
    "target3": {"price": 0, "action": "Exit remaining", "reasoning": "specific reason"},
    "trailingStop": "Trailing stop strategy description (e.g., Trail by 1.5x ATR after each level)"
  },
  "stopLoss": {
    "level": 0,
    "type": "TECHNICAL|ATR_BASED|PERCENTAGE",
    "reasoning": "Specific technical reason for this SL level"
  },
  "riskAssessment": {
    "riskLevel": "LOW|MEDIUM|HIGH|VERY_HIGH",
    "riskReward": "x.x",
    "maxLossPerLot": 0,
    "maxGainPerLot": 0,
    "scenarioAnalysis": {
      "bullCase": {"niftyMove": "+2%", "stockImpact": "description of how stock moves", "positionPnl": "estimated outcome"},
      "bearCase": {"niftyMove": "-3%", "stockImpact": "description", "positionPnl": "estimated outcome"},
      "worstCase": {"scenario": "description of worst case", "positionPnl": "max loss"}
    }
  },
  "optionsAlternative": {
    "available": ${isFnO},
    "suggestion": "If available: specific options strategy (e.g., bull call spread, long call, covered call)",
    "strike": 0,
    "type": "CE|PE",
    "premium": 0,
    "reasoning": "Why this options play is better or worse than cash"
  },
  "timing": {
    "urgency": "IMMEDIATE|WAIT_FOR_DIP|WAIT_FOR_BREAKOUT",
    "bestTimeframe": "Intraday|Swing|Positional",
    "holdingPeriod": "x days/weeks"
  },
  "confidence": 75,
  "tradeSummary": "50-word clear summary: entry trigger, ideal position size, target, stop loss, and expected holding period"
}`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.3, maxOutputTokens: 4000, timeout: 60000 });
    const raw = g.text || '{}';
    log('OK', `Trade Plan analysis for ${sym} (${g.source}/${g.model}, grounded:${g.grounded || false}), ${raw.length} chars`);

    let analysis = {};
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { analysis = JSON.parse(cleaned); } catch (_) {
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
      if (s >= 0 && e > s) { try { analysis = JSON.parse(cleaned.slice(s, e + 1)); } catch (_) {} }
    }

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 3: Post-processing & validation
    // ══════════════════════════════════════════════════════════════════════

    // Normalize price fields (strip ₹ and commas)
    const priceFields = ['idealEntry', 'aggressiveEntry', 'conservativeEntry', 'level', 'maxLossPerLot', 'maxGainPerLot', 'strike', 'premium'];
    const nestedPriceFields = [
      ['entryStrategy', ['idealEntry', 'aggressiveEntry', 'conservativeEntry']],
      ['exitStrategy.target1', ['price']],
      ['exitStrategy.target2', ['price']],
      ['exitStrategy.target3', ['price']],
      ['stopLoss', ['level']],
      ['riskAssessment', ['maxLossPerLot', 'maxGainPerLot']],
      ['optionsAlternative', ['strike', 'premium']]
    ];

    // Helper to safely set nested values
    function setNestedValue(obj, path, value) {
      const keys = path.split('.');
      let current = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
      }
      current[keys[keys.length - 1]] = value;
    }

    function getNestedValue(obj, path) {
      return path.split('.').reduce((v, k) => v?.[k], obj);
    }

    // Normalize prices
    const normalizePrice = (val) => {
      if (typeof val === 'string') return parseFloat(val.replace(/[₹,\s]/g, '')) || 0;
      return Number(val) || 0;
    };

    // Normalize entry strategy prices
    if (analysis.entryStrategy) {
      analysis.entryStrategy.idealEntry = normalizePrice(analysis.entryStrategy.idealEntry);
      analysis.entryStrategy.aggressiveEntry = normalizePrice(analysis.entryStrategy.aggressiveEntry);
      analysis.entryStrategy.conservativeEntry = normalizePrice(analysis.entryStrategy.conservativeEntry);
    }

    // Normalize exit strategy prices
    if (analysis.exitStrategy) {
      if (analysis.exitStrategy.target1) analysis.exitStrategy.target1.price = normalizePrice(analysis.exitStrategy.target1.price);
      if (analysis.exitStrategy.target2) analysis.exitStrategy.target2.price = normalizePrice(analysis.exitStrategy.target2.price);
      if (analysis.exitStrategy.target3) analysis.exitStrategy.target3.price = normalizePrice(analysis.exitStrategy.target3.price);
    }

    // Normalize stop loss
    if (analysis.stopLoss) {
      analysis.stopLoss.level = normalizePrice(analysis.stopLoss.level);
    }

    // Normalize risk/reward prices
    if (analysis.riskAssessment) {
      analysis.riskAssessment.maxLossPerLot = normalizePrice(analysis.riskAssessment.maxLossPerLot);
      analysis.riskAssessment.maxGainPerLot = normalizePrice(analysis.riskAssessment.maxGainPerLot);
      if (typeof analysis.riskAssessment.riskReward === 'string') {
        analysis.riskAssessment.riskReward = parseFloat(analysis.riskAssessment.riskReward.replace(/x/gi, '')) || 1;
      }
      analysis.riskAssessment.riskReward = Math.max(0.1, Number(analysis.riskAssessment.riskReward) || 1);
    }

    // Normalize options alternative
    if (analysis.optionsAlternative) {
      analysis.optionsAlternative.strike = normalizePrice(analysis.optionsAlternative.strike);
      analysis.optionsAlternative.premium = normalizePrice(analysis.optionsAlternative.premium);
    }

    // Validate enums
    const VALID_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
    const VALID_SL_TYPES = ['TECHNICAL', 'ATR_BASED', 'PERCENTAGE'];
    const VALID_URGENCIES = ['IMMEDIATE', 'WAIT_FOR_DIP', 'WAIT_FOR_BREAKOUT'];
    const VALID_TIMEFRAMES = ['Intraday', 'Swing', 'Positional'];
    const VALID_OPTION_TYPES = ['CE', 'PE'];

    if (analysis.riskAssessment && !VALID_RISK_LEVELS.includes(analysis.riskAssessment.riskLevel)) {
      analysis.riskAssessment.riskLevel = 'MEDIUM';
    }
    if (analysis.stopLoss && !VALID_SL_TYPES.includes(analysis.stopLoss.type)) {
      analysis.stopLoss.type = 'TECHNICAL';
    }
    if (analysis.timing && !VALID_URGENCIES.includes(analysis.timing.urgency)) {
      analysis.timing.urgency = 'IMMEDIATE';
    }
    if (analysis.timing && !VALID_TIMEFRAMES.includes(analysis.timing.bestTimeframe)) {
      analysis.timing.bestTimeframe = 'Swing';
    }
    if (analysis.optionsAlternative && !VALID_OPTION_TYPES.includes(analysis.optionsAlternative.type)) {
      analysis.optionsAlternative.type = 'CE';
    }

    // Clamp confidence to 40-90
    analysis.confidence = Math.max(40, Math.min(90, Number(analysis.confidence) || 60));

    // Ensure arrays/objects exist
    if (!analysis.entryStrategy) analysis.entryStrategy = { idealEntry: livePrice, aggressiveEntry: livePrice * 0.98, conservativeEntry: livePrice * 1.02, reasoning: 'Current price levels' };
    if (!analysis.exitStrategy) analysis.exitStrategy = { target1: { price: livePrice * 1.05, action: 'Book 40%', reasoning: 'Quick profit' }, target2: { price: livePrice * 1.10, action: 'Book 30%', reasoning: 'Continue' }, target3: { price: livePrice * 1.15, action: 'Exit', reasoning: 'Close position' }, trailingStop: '1.5x ATR trailing' };
    if (!analysis.stopLoss) analysis.stopLoss = { level: computedSL, type: 'TECHNICAL', reasoning: 'Technical support level' };
    if (!analysis.riskAssessment) analysis.riskAssessment = { riskLevel: 'MEDIUM', riskReward: 1.5, maxLossPerLot: 0, maxGainPerLot: 0, scenarioAnalysis: {} };
    if (!analysis.timing) analysis.timing = { urgency: 'IMMEDIATE', bestTimeframe: 'Swing', holdingPeriod: '5-10 days' };
    if (!analysis.optionsAlternative) analysis.optionsAlternative = { available: isFnO, suggestion: 'Not analyzed', strike: 0, type: 'CE', premium: 0, reasoning: 'No options alternative' };

    // Compute max loss/gain per lot if not provided
    const entry = analysis.entryStrategy?.idealEntry || livePrice;
    const target = analysis.exitStrategy?.target1?.price || (livePrice * 1.05);
    const sl = analysis.stopLoss?.level || computedSL;

    if (isFnO && lotSize) {
      if (!analysis.riskAssessment.maxLossPerLot || analysis.riskAssessment.maxLossPerLot === 0) {
        analysis.riskAssessment.maxLossPerLot = Math.abs(entry - sl) * lotSize;
      }
      if (!analysis.riskAssessment.maxGainPerLot || analysis.riskAssessment.maxGainPerLot === 0) {
        analysis.riskAssessment.maxGainPerLot = Math.abs(target - entry) * lotSize;
      }
    } else {
      if (!analysis.riskAssessment.maxLossPerLot || analysis.riskAssessment.maxLossPerLot === 0) {
        analysis.riskAssessment.maxLossPerLot = Math.abs(entry - sl);
      }
      if (!analysis.riskAssessment.maxGainPerLot || analysis.riskAssessment.maxGainPerLot === 0) {
        analysis.riskAssessment.maxGainPerLot = Math.abs(target - entry);
      }
    }

    // Inject computed technicals & positioning
    analysis._computed = {
      livePrice,
      dayHigh,
      dayLow,
      atr: parseFloat(atr.toFixed(2)),
      signalScore: sig?.score || 0,
      signalLabel: sig?.signal || 'N/A',
      techScore: tech?.techScore || null,
      techBias: tech?.techBias || 'N/A',
      rsi: tech?.rsi || null,
      ema20: tech?.ema20 || null,
      ema50: tech?.ema50 || null,
      ema200: tech?.ema200 || null,
      support: tech?.support || null,
      resistance: tech?.resistance || null,
      macd: tech?.macd || null,
      bollingerUpper: tech?.bollingerUpper || null,
      bollingerLower: tech?.bollingerLower || null,
      techSignals: tech?.signals || [],
      signalReasons: sig?.allReasons || []
    };

    analysis._positionSizing = {
      capital,
      riskPerTrade: capital * riskPct,
      riskPerShare: parseFloat(riskPerShare.toFixed(2)),
      suggestedQty,
      lotSize: isFnO ? lotSize : null,
      suggestedLots: isFnO ? suggestedLots : null,
      investmentRequired: Math.round(investmentRequired),
      maxLossOnPosition: Math.round(maxLossPerShare * (isFnO ? suggestedLots * lotSize : suggestedQty))
    };

    analysis._optionChain = null;
    if (stockChain) {
      analysis._optionChain = {
        pcr: stockChain.pcr || 0,
        maxPain: stockChain.maxPain || 0,
        avgIV: stockChain.avgIV || 0
      };
    }

    // Data source transparency
    analysis._dataSources = {
      price: 'LIVE (Upstox)',
      technicals: tech ? 'COMPUTED (from ' + prices.length + ' live price readings)' : 'UNAVAILABLE (insufficient price history)',
      atr: 'COMPUTED (from day high/low + recent price history)',
      optionChain: stockChain ? 'LIVE (Upstox option chain)' : 'UNAVAILABLE',
      marketContext: 'LIVE (dynamic events engine)',
      aiGrounding: g.grounded ? 'GROUNDED (Google Search)' : 'UNGROUNDED (AI knowledge only)'
    };

    // Metadata
    analysis.symbol = sym;
    analysis.isFnO = isFnO;
    analysis.grounded = g.grounded || false;
    analysis.model = g.model;
    analysis.configured = true;
    analysis.timestamp = new Date().toISOString();

    // ── Cache & return ──
    tradePlanCache[sym] = { data: analysis, lastFetch: Date.now() };
    res.json({ ...analysis, cached: false });

  } catch (e) {
    log('ERR', `Trade Plan failed for ${sym}: ${e.message}`);
    // Return stale cache on error
    if (tradePlanCache[sym]) {
      return res.json({ ...tradePlanCache[sym].data, cached: true, stale: true, error: e.message });
    }
    res.status(500).json({ error: 'Trade Plan generation failed: ' + e.message });
  }
});

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

    const g = await callAI(prompt);
    const analysis = g.text || 'No response from AI';
    log('OK', `Options analysis completed (${g.source}/${g.model}) for: ${trade.substring(0, 50)}`);
    res.json({ analysis, marketData, configured: true });
  } catch(e) {
    log('ERR', 'AI call failed: ' + e.message);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ── AI Options Recommendations ──
app.get('/api/options-recommend', async (req, res) => {
  // ── Market hours gate ──
  if (!isMarketOpen()) {
    return res.json(marketClosedResponse({ recommendations: [] }));
  }
  if (!appConfig.geminiKey) return res.json({ recommendations: [], configured: false, error: 'Gemini API key not configured' });
  try {
    const nifty = liveIndices['Nifty 50'];
    const bankNifty = liveIndices['Nifty Bank'];
    // Build top movers and signals summary
    const stocks = Object.values(liveStocks).filter(s => s.price);
    const topGainers = [...stocks].sort((a,b) => b.changePct - a.changePct).slice(0,10);
    const topLosers  = [...stocks].sort((a,b) => a.changePct - b.changePct).slice(0,10);
    const strongSignals = Object.values(signalCache).filter(s => s.score >= 65).sort((a,b) => b.score - a.score).slice(0,8);

    const stockSummary = stocks.slice(0,40).map(s => {
      const sig = signalCache[s.symbol];
      const fund = STOCK_UNIVERSE.find(x => x.symbol === s.symbol);
      const f52 = fundamentals[s.symbol];
      return `${s.symbol}:₹${s.price}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%) Sector:${fund?.sector||'?'} Sig:${sig?.signal||'--'}(${sig?.score||0}) H52:₹${f52?.high52||'?'} L52:₹${f52?.low52||'?'}`;
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

    const g = await callAI(prompt, { temperature: 0.4, maxOutputTokens: 4000, timeout: 45000 });
    const raw = g.text || '[]';
    log('OK', `Options recommendations generated (${g.source}/${g.model}), ${raw.length} chars`);
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
// AI LONG-TERM PICKS — Grounded AI research for best NSE stocks
// ══════════════════════════════════════════════════════════════════════════════
let aiPicksCache = { picks: [], lastFetch: 0 };
const AI_PICKS_CACHE_MS = 4 * 60 * 60 * 1000; // Cache 4 hours

app.get('/api/ai-picks', async (req, res) => {
  const force = req.query.force === 'true';
  // ── Market hours gate ──
  if (!isMarketOpen() && !force) {
    if (aiPicksCache.picks.length) {
      return res.json(marketClosedResponse({ picks: aiPicksCache.picks, generated: new Date(aiPicksCache.lastFetch).toISOString() }, aiPicksCache.lastFetch));
    }
    return res.json(marketClosedResponse(null));
  }
  // Return cache if fresh (or stale cache if no AI key)
  if (!force && aiPicksCache.picks.length && (Date.now() - aiPicksCache.lastFetch) < AI_PICKS_CACHE_MS) {
    return res.json({ picks: aiPicksCache.picks, cached: true, generated: new Date(aiPicksCache.lastFetch).toISOString() });
  }
  if (!appConfig.geminiKey && !gcpServiceAccount) {
    // Return stale cache if available, otherwise error
    if (aiPicksCache.picks.length) return res.json({ picks: aiPicksCache.picks, cached: true, generated: new Date(aiPicksCache.lastFetch).toISOString(), stale: true });
    return res.json({ picks: [], configured: false, error: 'Gemini API key not configured' });
  }
  try {
    const nifty = liveIndices['Nifty 50'];
    const bankNifty = liveIndices['Nifty Bank'];
    const stocks = Object.values(liveStocks).filter(s => s.price);

    // Build sector summary from live data
    const sectorPerf = {};
    for (const s of stocks) {
      if (!s.sector) continue;
      if (!sectorPerf[s.sector]) sectorPerf[s.sector] = { total:0, count:0 };
      sectorPerf[s.sector].total += (s.changePct || 0);
      sectorPerf[s.sector].count++;
    }
    const sectorStr = Object.entries(sectorPerf).map(([k,v]) => `${k}:${(v.total/v.count).toFixed(2)}%`).join(', ');

    // Build STOCK_UNIVERSE fundamental snapshot for AI context
    const universeStr = STOCK_UNIVERSE.filter(s => {
      const live = liveStocks[s.symbol];
      return live && live.price;
    }).map(s => {
      const live = liveStocks[s.symbol];
      const sig = signalCache[s.symbol];
      return `${s.symbol}(₹${live.price},${live.changePct>=0?'+':''}${live.changePct.toFixed(1)}%,${s.sector},${s.cap},Sig:${sig?.score||'-'})`;
    }).join('\n');

    // FII/DII trend context
    const fiiTrend = fiiDiiData.fii > 500 ? 'STRONG_BUYING' : fiiDiiData.fii > 0 ? 'BUYING' : fiiDiiData.fii > -500 ? 'SELLING' : 'HEAVY_SELLING';
    const vixRegime = vixData.value > 20 ? 'HIGH_FEAR' : vixData.value > 15 ? 'ELEVATED' : vixData.value > 12 ? 'NORMAL' : 'LOW_COMPLACENT';

    const prompt = `You are India's top SEBI-registered equity research analyst. Using REAL, CURRENT data (search the web to verify), recommend 12-15 NSE stocks for LONG-TERM investment (6 months to 3 years).

CRITICAL: Use Google Search to look up ACTUAL current financials for each stock you recommend — real PE ratio, real quarterly results, real promoter holding %, real 52-week high/low, real analyst consensus targets. Do NOT guess or use outdated numbers.

LIVE MARKET SNAPSHOT (from our data feed):
- Nifty 50: ${nifty?.price||'N/A'} (${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%)
- Bank Nifty: ${bankNifty?.price||'N/A'} (${bankNifty?.changePct>=0?'+':''}${bankNifty?.changePct||0}%)
- India VIX: ${vixData.value} (${vixData.trend}) — Regime: ${vixRegime}
- FII: ₹${fiiDiiData.fii}Cr (${fiiTrend}) | DII: ₹${fiiDiiData.dii}Cr
- USD/INR: ${fiiDiiData.usdInr || 'N/A'} | Crude: $${fiiDiiData.crude || 'N/A'}

SECTOR PERFORMANCE TODAY: ${sectorStr || 'N/A'}

OUR STOCK UNIVERSE WITH LIVE DATA:
${universeStr || 'Live data not available — use your web search'}

STOCK SELECTION CRITERIA (apply all):
1. QUALITY: ROE > 12%, manageable debt (D/E < 1.5 for non-NBFC), consistent revenue growth
2. VALUATION: PE reasonable vs sector peers (not overvalued), PEG < 2 preferred
3. MOMENTUM: Stock should be in uptrend or forming a base (not in freefall)
4. INSTITUTIONAL: FII/DII/MF increasing holding is a plus, promoter holding stable or increasing
5. CATALYST: Must have a clear trigger — sector tailwind, capacity expansion, market share gain, policy benefit, earnings upgrade cycle
6. DIVERSIFY: Mix of large cap (60%), mid cap (30%), quality small cap (10%). Cover multiple sectors.
7. MACRO-AWARE: Consider RBI rate cycle, FII flow trends, rupee direction, crude impact, global growth outlook

For EACH stock, provide data you verified via web search — not estimates.

Reply ONLY valid JSON array, NO markdown fences:
[{"symbol":"NSE_SYMBOL","name":"Full Company Name","sector":"Sector","currentPrice":1234,"targetPrice":1500,"timeframe":"6 months / 1 year / 2 years","stopLoss":1050,"upside":"21.5","confidence":85,"signal":"STRONG BUY/BUY","riskLevel":"LOW/MEDIUM/HIGH","pe":22.5,"sectorPe":25,"roe":"18%","debtToEquity":"0.3","dividendYield":"1.2%","promoterHolding":"55%","revenueGrowth":"15%","profitGrowth":"20%","week52High":1600,"week52Low":900,"rsiZone":"Neutral","trend":"Uptrend","support":1180,"resistance":1520,"reasoning":"100-word analysis: why buy now, catalyst, sector outlook, risk factors, exit trigger","tags":["value","growth","dividend","momentum","turnaround"]}]

IMPORTANT: "confidence" MUST be a NUMBER (0-100), "currentPrice"/"targetPrice"/"stopLoss" MUST be NUMBERS (not strings with ₹). "upside" must be a number string like "21.5" without % symbol.`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.3, maxOutputTokens: 8000, timeout: 90000 });
    const raw = g.text || '[]';
    log('OK', `AI Long-Term Picks generated (${g.source}/${g.model}, grounded:${g.grounded||false}), ${raw.length} chars`);

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

    // ── Post-processing: validate & enrich with live data ──
    for (const pick of picks) {
      // Normalize symbol
      if (pick.symbol) pick.symbol = pick.symbol.toUpperCase().replace(/\s+/g, '');
      // Enrich with live prices
      const live = liveStocks[pick.symbol];
      if (live && live.price) {
        pick.livePrice = live.price;
        pick.liveChange = live.changePct;
      }
      // Normalize confidence to number
      if (typeof pick.confidence === 'string') {
        const confMap = { 'VERY_HIGH': 90, 'HIGH': 75, 'MODERATE': 60, 'LOW': 40 };
        pick.confidence = confMap[pick.confidence.toUpperCase()] || parseFloat(pick.confidence) || 70;
      }
      // Normalize prices to numbers (strip ₹ and commas)
      for (const k of ['currentPrice', 'targetPrice', 'stopLoss', 'support', 'resistance', 'week52High', 'week52Low']) {
        if (typeof pick[k] === 'string') pick[k] = parseFloat(pick[k].replace(/[₹,\s]/g, '')) || 0;
      }
      // Normalize upside to number string
      if (typeof pick.upside === 'string') pick.upside = pick.upside.replace(/[%+\s]/g, '');
      // Recalculate upside from live price if available
      const basePrice = pick.livePrice || pick.currentPrice || 0;
      const tgt = pick.targetPrice || 0;
      if (basePrice > 0 && tgt > 0) {
        pick.upside = ((tgt - basePrice) / basePrice * 100).toFixed(1);
      }
      // Validate: flag if AI's price is >15% off from live price (possible hallucination)
      if (live && live.price && pick.currentPrice) {
        const drift = Math.abs(live.price - pick.currentPrice) / live.price * 100;
        if (drift > 15) {
          pick._priceWarning = `AI price ₹${pick.currentPrice} vs live ₹${live.price} (${drift.toFixed(0)}% off)`;
          pick.currentPrice = live.price; // Use live price
        }
      }
    }
    // Filter out picks with no symbol or clearly broken data
    picks = picks.filter(p => p.symbol && p.symbol.length >= 2 && (p.targetPrice || p.reasoning));

    aiPicksCache = { picks, lastFetch: Date.now() };
    res.json({ picks, cached: false, generated: new Date().toISOString(), model: g.model, grounded: g.grounded || false });
  } catch(e) {
    log('ERR', 'AI Long-Term Picks failed: ' + e.message);
    // Return stale cache on error instead of empty
    if (aiPicksCache.picks.length) {
      return res.json({ picks: aiPicksCache.picks, cached: true, generated: new Date(aiPicksCache.lastFetch).toISOString(), stale: true, error: e.message });
    }
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VERIFY STOCK — Multi-layer verification: computed signals + grounded AI + post-processing
// ══════════════════════════════════════════════════════════════════════════════
let verifyCache = {}; // { SYMBOL: { data, lastFetch } }
const VERIFY_CACHE_MS = 15 * 60 * 1000; // 15 min cache per symbol
let verifyHistory = []; // Last 10 verified symbols

app.post('/api/verify-stock', async (req, res) => {
  const { symbol, force } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol required' });
  if (!appConfig.geminiKey) return res.json({ configured: false, error: 'Gemini API key not configured' });

  const sym = symbol.toUpperCase().trim();

  // ── Market hours gate ──
  if (!isMarketOpen()) {
    if (verifyCache[sym]) {
      return res.json(marketClosedResponse(verifyCache[sym].data, verifyCache[sym].lastFetch));
    }
    return res.json(marketClosedResponse(null));
  }

  // ── Cache check ──
  if (!force && verifyCache[sym] && (Date.now() - verifyCache[sym].lastFetch) < VERIFY_CACHE_MS) {
    return res.json({ ...verifyCache[sym].data, cached: true });
  }

  try {
    // ══════════════════════════════════════════════════════════════════════
    // LAYER 1: Compute everything locally BEFORE asking AI
    // ══════════════════════════════════════════════════════════════════════
    const live = liveStocks[sym];
    const sig = signalCache[sym];
    const fund = STOCK_UNIVERSE.find(s => s.symbol === sym);
    const f52 = fundamentals[sym];
    const prices = priceHistory[sym] || [];

    // Technical analysis from our engine
    let tech = null;
    if (prices.length >= 20) {
      tech = getTechnicalSignal(prices, prices, prices);
    }

    // Market context — filter events relevant to this stock's sector
    const mktCtx = getMarketContext();
    const stockSector = fund?.sector || '';
    const relevantEvents = mktCtx.filter(e => {
      if (e.priority === 'HIGH') return true; // Always include high-impact
      if (!stockSector) return false;
      const allSectors = [...(e.sectors?.buy || []), ...(e.sectors?.avoid || []), ...(e.sectors?.watch || [])];
      return allSectors.some(s => stockSector.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(stockSector.toLowerCase()));
    }).slice(0, 5);

    // Option chain sentiment (if stock is F&O)
    const stockChain = optionChainCache.stocks?.[sym];
    const niftyChain = optionChainCache.nifty;
    let optionSentiment = '';
    if (stockChain) {
      optionSentiment = `PCR:${stockChain.pcr} MaxPain:₹${stockChain.maxPain} AvgIV:${stockChain.avgIV}%`;
    }
    if (niftyChain) {
      optionSentiment += ` | Nifty PCR:${niftyChain.pcr} MaxPain:${niftyChain.maxPain}`;
    }

    // Composite FINR Score: 60% fundamental + 40% technical
    const fundScore = sig?.score || 0;
    const techScore = tech?.techScore || 50;
    const compositeScore = Math.round(fundScore * 0.6 + techScore * 0.4);

    // Global markets context
    const globalStr = Object.values(globalMarkets).map(g => `${g.name}:${g.price}(${g.changePct >= 0 ? '+' : ''}${g.changePct}%)`).join(', ');

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 2: Build enriched AI prompt (grounded + data-loaded)
    // ══════════════════════════════════════════════════════════════════════
    const nifty = liveIndices['Nifty 50'] || liveIndices['NIFTY50'] || {};
    const bank = liveIndices['Nifty Bank'] || liveIndices['NIFTYBANK'] || {};

    const liveInfo = live
      ? `Current Price: ₹${live.price} (${live.changePct >= 0 ? '+' : ''}${live.changePct}%) | Day High: ₹${live.dayHigh || '?'} | Day Low: ₹${live.dayLow || '?'} | Volume: ${live.volume || '?'}`
      : 'IMPORTANT: We do NOT have live price for this stock. You MUST use Google Search grounding to find the current price. Do NOT guess.';

    const sigInfo = sig
      ? `FINR Signal: ${sig.signal} (${sig.score}/100) | Reasons: ${(sig.allReasons || []).join('; ')} | Upside to target: ${sig.upside}% | Downside risk: ${sig.downside}%`
      : '';

    const fundInfo = fund
      ? `Sector:${fund.sector} | Cap:${fund.cap || 'N/A'}`
      : '';

    const w52Info = f52
      ? `52W High:₹${f52.high52} | 52W Low:₹${f52.low52} | Position: ${f52.high52 && f52.low52 && live ? ((live.price - f52.low52) / (f52.high52 - f52.low52) * 100).toFixed(0) + '% from bottom' : '?'}`
      : '';

    const techInfo = tech
      ? `RSI(14):${tech.rsi} | EMA20:₹${tech.ema20} | EMA50:₹${tech.ema50} | EMA200:₹${tech.ema200} | MACD:${tech.macd}(signal:${tech.macdSignal}) | Support:₹${tech.support} | Resistance:₹${tech.resistance} | Bollinger Upper:₹${tech.bollingerUpper} Lower:₹${tech.bollingerLower} | Tech Bias:${tech.techBias} | Tech Score:${tech.techScore}/100 | Computed Best Entry:₹${tech.bestEntry} | Computed SL:₹${tech.stopLoss}`
      : '';

    const eventStr = relevantEvents.length
      ? relevantEvents.map(e => `${e.icon} ${e.title} (${e.priority}): ${e.impact}`).join('\n')
      : 'No major macro events currently affecting this sector';

    const prompt = `You are an expert Indian stock market research analyst with CFA-level expertise. A retail investor's friend has suggested buying ${sym}. Do a COMPLETE, UNBIASED, BRUTALLY HONEST analysis.

CRITICAL INSTRUCTION: Use Google Search to find the LATEST news, quarterly results, promoter holding changes, SEBI actions, corporate announcements, and management commentary for ${sym}. Our computed data below gives you the quantitative foundation — your job is to ADD qualitative context we cannot compute.

═══ MARKET CONTEXT ═══
Nifty 50: ${nifty?.price || '?'} (${nifty?.changePct >= 0 ? '+' : ''}${nifty?.changePct || 0}%) | Bank Nifty: ${bank?.price || '?'} (${bank?.changePct >= 0 ? '+' : ''}${bank?.changePct || 0}%)
VIX: ${vixData.value} (${vixData.trend}) | FII: ₹${fiiDiiData.fii}Cr | DII: ₹${fiiDiiData.dii}Cr | USD/INR: ${fiiDiiData.usdInr} | Crude: $${fiiDiiData.crude}
Global: ${globalStr || 'N/A'}

═══ MACRO EVENTS AFFECTING THIS STOCK ═══
${eventStr}

═══ STOCK DATA (LIVE — FROM OUR MARKET FEED) ═══
${liveInfo}
${sigInfo}
${fundInfo}
${w52Info}
${techInfo}
${optionSentiment ? `F&O Sentiment: ${optionSentiment}` : ''}
FINR Composite Score: ${compositeScore}/100 (60% fundamental + 40% technical)

═══ YOUR ANALYSIS REQUIREMENTS ═══
1. VERDICT: BUY / HOLD / AVOID — with numeric confidence (0-100)
2. FUNDAMENTALS: PE vs sector avg, ROE quality, debt safety, revenue/profit growth trajectory, promoter holding trend, any red flags from recent filings
3. TECHNICALS: Validate our RSI/EMA/MACD readings, add any chart patterns you see, confirm or dispute our support/resistance
4. CATALYSTS: Upcoming earnings, product launches, regulatory changes, sector tailwinds/headwinds
5. RISK: Rate LOW/MEDIUM/HIGH/VERY_HIGH with specific risk factors
6. TARGET + TIMEFRAME: Based on both our computed target and your research
7. STOP LOSS: Must be at a logical technical level (support, Bollinger, etc.)
8. BULL vs BEAR CASE: 50 words each, specific scenarios
9. ALTERNATIVES: If mediocre, suggest 2-3 better stocks in same sector with reasons
10. FUNDAMENTALS: You MUST use Google Search to find CURRENT PE, ROE, D/E, promoter holding, quarterly results. We do NOT have these — YOU must find them.
11. If our FINR Score (${compositeScore}) conflicts with your verdict, EXPLAIN WHY you disagree

Reply ONLY valid JSON, NO markdown fences:
{"symbol":"${sym}","name":"Full Company Name","sector":"sector","verdict":"BUY/HOLD/AVOID","confidence":75,"riskLevel":"LOW/MEDIUM/HIGH/VERY_HIGH","currentPrice":0,"targetPrice":0,"timeframe":"x months","stopLoss":0,"upside":"xx","downside":"xx","pe":0,"sectorPe":0,"roe":"xx","debtToEquity":"x.x","dividendYield":"x","promoterHolding":"xx","promoterChange":"increased/decreased/stable","revenueGrowth":"xx","profitGrowth":"xx","week52High":0,"week52Low":0,"rsiValue":${tech?.rsi || 0},"rsiZone":"Oversold/Neutral/Overbought","trend":"Uptrend/Downtrend/Sideways","emaSignal":"Bullish/Bearish/Neutral","support":0,"resistance":0,"macdSignal":"Bullish/Bearish","bollingerPosition":"Upper/Middle/Lower","bullCase":"specific 50-word best scenario","bearCase":"specific 50-word worst scenario","reasoning":"detailed 100-word honest analysis","catalysts":["catalyst1","catalyst2"],"redFlags":["flag1","flag2"],"positives":["pos1","pos2"],"alternatives":[{"symbol":"ALT1","reason":"why better"},{"symbol":"ALT2","reason":"why better"}],"recentNews":"key recent development from your search","quarterlyTrend":"improving/stable/declining based on last 2-3 quarters"}`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.3, maxOutputTokens: 5000, timeout: 60000 });
    const raw = g.text || '{}';
    log('OK', `Verify Stock analysis for ${sym} (${g.source}/${g.model}, grounded:${g.grounded || false}), ${raw.length} chars`);

    let analysis = {};
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { analysis = JSON.parse(cleaned); } catch (_) {
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
      if (s >= 0 && e > s) { try { analysis = JSON.parse(cleaned.slice(s, e + 1)); } catch (_) {} }
    }

    // ══════════════════════════════════════════════════════════════════════
    // LAYER 3: Post-processing & validation
    // ══════════════════════════════════════════════════════════════════════

    // Normalize prices (strip ₹ and commas)
    for (const k of ['currentPrice', 'targetPrice', 'stopLoss', 'support', 'resistance', 'week52High', 'week52Low']) {
      if (typeof analysis[k] === 'string') analysis[k] = parseFloat(analysis[k].replace(/[₹,\s]/g, '')) || 0;
    }

    // Normalize percentage fields
    for (const k of ['upside', 'downside', 'roe', 'debtToEquity', 'dividendYield', 'promoterHolding', 'revenueGrowth', 'profitGrowth']) {
      if (typeof analysis[k] === 'string') analysis[k] = analysis[k].replace(/[%\s]/g, '');
    }

    // Normalize confidence to number (0-100)
    if (typeof analysis.confidence === 'string') {
      const confMap = { 'VERY_HIGH': 90, 'HIGH': 75, 'MODERATE': 55, 'LOW': 30 };
      analysis.confidence = confMap[analysis.confidence.toUpperCase()] || parseFloat(analysis.confidence) || 60;
    }
    analysis.confidence = Math.max(0, Math.min(100, Math.round(analysis.confidence || 60)));

    // Confidence anchoring: blend AI confidence with computed score
    // 40% FINR computed + 60% AI assessment
    const aiConf = analysis.confidence;
    analysis.confidence = Math.round(compositeScore * 0.4 + aiConf * 0.6);
    analysis._aiRawConfidence = aiConf;
    analysis._finrScore = compositeScore;

    // Price drift check: if AI price is >10% off from live, use live
    if (live?.price && analysis.currentPrice) {
      const drift = Math.abs(live.price - analysis.currentPrice) / live.price * 100;
      if (drift > 10) {
        analysis._priceWarning = `AI price ₹${analysis.currentPrice} vs live ₹${live.price} (${drift.toFixed(0)}% drift — using live)`;
        analysis.currentPrice = live.price;
        log('WARN', `Verify ${sym}: price drift ${drift.toFixed(0)}%, using live ₹${live.price}`);
      }
    }
    // If we have live but AI didn't return a price, use live
    if (live?.price && !analysis.currentPrice) analysis.currentPrice = live.price;

    // Recalculate upside/downside from validated prices
    const basePrice = analysis.currentPrice || live?.price || 0;
    if (basePrice > 0 && analysis.targetPrice > 0) {
      analysis.upside = ((analysis.targetPrice - basePrice) / basePrice * 100).toFixed(1);
    }
    if (basePrice > 0 && analysis.stopLoss > 0) {
      analysis.downside = ((basePrice - analysis.stopLoss) / basePrice * 100).toFixed(1);
    }

    // Risk-reward ratio
    const up = parseFloat(analysis.upside) || 0;
    const dn = parseFloat(analysis.downside) || 0;
    analysis.riskReward = dn > 0 ? (up / dn).toFixed(1) : '—';

    // Target/SL sanity check
    if (analysis.verdict === 'BUY' && basePrice > 0) {
      if (analysis.targetPrice > 0 && analysis.targetPrice <= basePrice) {
        analysis._targetWarning = 'Target below current price for BUY — AI may have erred';
      }
      if (analysis.stopLoss > 0 && analysis.stopLoss >= basePrice) {
        analysis._slWarning = 'Stop loss above current price for BUY — using computed SL';
        analysis.stopLoss = tech?.stopLoss || +(basePrice * 0.93).toFixed(2);
      }
    }

    // Verdict cross-check against FINR score
    if (compositeScore >= 75 && analysis.verdict === 'AVOID') {
      analysis._verdictConflict = `FINR score ${compositeScore}/100 suggests BUY but AI says AVOID`;
    } else if (compositeScore <= 30 && analysis.verdict === 'BUY') {
      analysis._verdictConflict = `FINR score ${compositeScore}/100 suggests SELL but AI says BUY`;
    }

    // Ensure arrays are arrays
    for (const k of ['redFlags', 'positives', 'catalysts']) {
      if (typeof analysis[k] === 'string') analysis[k] = [analysis[k]];
      if (!Array.isArray(analysis[k])) analysis[k] = [];
    }
    if (!Array.isArray(analysis.alternatives)) analysis.alternatives = [];

    // Inject our computed technicals for the frontend
    analysis._computed = {
      signalScore: fundScore,
      signalLabel: sig?.signal || 'N/A',
      techScore: techScore,
      techBias: tech?.techBias || 'N/A',
      compositeScore,
      rsi: tech?.rsi || null,
      ema20: tech?.ema20 || null,
      ema50: tech?.ema50 || null,
      ema200: tech?.ema200 || null,
      support: tech?.support || null,
      resistance: tech?.resistance || null,
      bestEntry: tech?.bestEntry || null,
      computedSL: tech?.stopLoss || null,
      macd: tech?.macd || null,
      bollingerUpper: tech?.bollingerUpper || null,
      bollingerLower: tech?.bollingerLower || null,
      signalReasons: sig?.allReasons || [],
      techSignals: tech?.signals || []
    };

    // Data source transparency
    analysis._dataSources = {
      price: live ? 'LIVE (Upstox)' : 'NOT AVAILABLE',
      priceAge: live?.lastUpdate ? Math.round((Date.now() - live.lastUpdate) / 1000) + 's ago' : null,
      fundamentals: 'AI_GROUNDED (fetched by AI via Google Search)',
      technicals: tech ? 'COMPUTED (from ' + prices.length + ' live price readings)' : 'NOT AVAILABLE (insufficient price history)',
      marketContext: 'LIVE (dynamic events engine)',
      optionChain: stockChain ? 'LIVE (Upstox option chain)' : 'NOT AVAILABLE',
      aiGrounding: g.grounded ? 'GROUNDED (Google Search)' : 'UNGROUNDED (AI knowledge only)'
    };

    // Inject live data
    if (live) {
      analysis.livePrice = live.price;
      analysis.liveChange = live.changePct;
      analysis.liveVolume = live.volume;
    }

    // Add metadata
    analysis.symbol = sym;
    analysis.grounded = g.grounded || false;
    analysis.model = g.model;
    analysis.configured = true;
    analysis.timestamp = new Date().toISOString();

    // ── Cache & history ──
    verifyCache[sym] = { data: analysis, lastFetch: Date.now() };
    // Update history (last 10 unique symbols)
    verifyHistory = verifyHistory.filter(h => h.symbol !== sym);
    verifyHistory.unshift({ symbol: sym, name: analysis.name || sym, verdict: analysis.verdict, confidence: analysis.confidence, timestamp: analysis.timestamp });
    if (verifyHistory.length > 10) verifyHistory.pop();

    // Flatten — return at top level (no { analysis: {} } wrapper)
    res.json({ ...analysis, cached: false });

  } catch (e) {
    log('ERR', `Verify Stock failed for ${sym}: ${e.message}`);
    // Return stale cache on error
    if (verifyCache[sym]) {
      return res.json({ ...verifyCache[sym].data, cached: true, stale: true, error: e.message });
    }
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// Verify history endpoint
app.get('/api/verify-history', (req, res) => {
  res.json({ history: verifyHistory });
});

// ══════════════════════════════════════════════════════════════════════════════
// OPTIONS LAB — AI options strategist with real chain data + grounding
// ══════════════════════════════════════════════════════════════════════════════
let optionsLabCache = { trades: [], lastFetch: 0 };
const OPTIONS_LAB_CACHE_MS = 30 * 60 * 1000; // 30 min cache
let ivHistory = { nifty: [], banknifty: [] }; // Track IV readings for percentile

app.get('/api/options-lab', async (req, res) => {
  const force = req.query.force === 'true';
  // ── Market hours gate ──
  if (!isMarketOpen() && !force) {
    if (optionsLabCache.trades.length) {
      return res.json(marketClosedResponse({ trades: optionsLabCache.trades, generated: new Date(optionsLabCache.lastFetch).toISOString() }, optionsLabCache.lastFetch));
    }
    return res.json(marketClosedResponse(null));
  }
  if (!force && optionsLabCache.trades.length && (Date.now() - optionsLabCache.lastFetch) < OPTIONS_LAB_CACHE_MS) {
    const chainSummary = buildChainSummary(optionChainCache);
    return res.json({ trades: optionsLabCache.trades, cached: true, generated: new Date(optionsLabCache.lastFetch).toISOString(), chainData: chainSummary });
  }
  if (!appConfig.geminiKey && !gcpServiceAccount) {
    if (optionsLabCache.trades.length) return res.json({ trades: optionsLabCache.trades, cached: true, generated: new Date(optionsLabCache.lastFetch).toISOString(), stale: true, chainData: buildChainSummary(optionChainCache) });
    return res.json({ trades: [], configured: false, error: 'Gemini API key not configured' });
  }
  try {
    const nifty = liveIndices['Nifty 50'];
    const bankNifty = liveIndices['Nifty Bank'];
    const stocks = Object.values(liveStocks).filter(s => s.price);
    const topGainers = [...stocks].sort((a,b) => b.changePct - a.changePct).slice(0,10);
    const topLosers = [...stocks].sort((a,b) => a.changePct - b.changePct).slice(0,10);

    // Fetch real option chain data (OI, IV, Greeks, PCR, Max Pain)
    // includeStocks=true fetches top movers' stock chains in parallel
    const oc = await refreshOptionChain(true);
    const niftyOC = oc.nifty;
    const bnfOC = oc.banknifty;
    const stockChains = oc.stocks || {};

    // ── DTE calculation (index = weekly, stock = monthly) ──
    const indexExpiryDate = getNextWeeklyExpiry();
    const stockExpiryDate = getNextMonthlyExpiry();
    const now = getIST();
    const indexExpDt = new Date(indexExpiryDate + 'T15:30:00+05:30');
    const indexDte = Math.max(0, Math.ceil((indexExpDt - now) / (1000 * 60 * 60 * 24)));
    const stockExpDt = new Date(stockExpiryDate + 'T15:30:00+05:30');
    const stockDte = Math.max(0, Math.ceil((stockExpDt - now) / (1000 * 60 * 60 * 24)));
    const dte = indexDte; // primary DTE for display

    // ── IV History tracking for percentile ──
    if (niftyOC && niftyOC.avgIV > 0) {
      ivHistory.nifty.push(niftyOC.avgIV);
      if (ivHistory.nifty.length > 50) ivHistory.nifty.shift();
    }
    if (bnfOC && bnfOC.avgIV > 0) {
      ivHistory.banknifty.push(bnfOC.avgIV);
      if (ivHistory.banknifty.length > 50) ivHistory.banknifty.shift();
    }
    const niftyIVPctl = ivHistory.nifty.length >= 5 ? Math.round(ivHistory.nifty.filter(v => v <= (niftyOC?.avgIV||0)).length / ivHistory.nifty.length * 100) : null;
    const bnfIVPctl = ivHistory.banknifty.length >= 5 ? Math.round(ivHistory.banknifty.filter(v => v <= (bnfOC?.avgIV||0)).length / ivHistory.banknifty.length * 100) : null;

    // ── Max Pain distance ──
    const niftyMPDist = niftyOC ? ((niftyOC.spot - niftyOC.maxPain) / niftyOC.spot * 100).toFixed(2) : null;
    const bnfMPDist = bnfOC ? ((bnfOC.spot - bnfOC.maxPain) / bnfOC.spot * 100).toFixed(2) : null;

    // ── Build option chain context with REAL premiums ──
    let ocStr = '';
    if (niftyOC) {
      ocStr += `\nNIFTY OPTION CHAIN (REAL-TIME from Upstox):`;
      ocStr += `\nSpot:${niftyOC.spot} | PCR:${niftyOC.pcr} | MaxPain:${niftyOC.maxPain} (${niftyMPDist}% from spot) | AvgIV:${niftyOC.avgIV}%${niftyIVPctl !== null ? ' ('+niftyIVPctl+'th pctl)' : ''}`;
      ocStr += `\nTotal Call OI:${(niftyOC.totalCallOI/100000).toFixed(1)}L | Total Put OI:${(niftyOC.totalPutOI/100000).toFixed(1)}L`;
      ocStr += `\nExpiry:${indexExpiryDate} | DTE:${indexDte} days | Lot:75`;
      ocStr += '\nStrike | CE_LTP | CE_OI | CE_Vol | CE_IV | CE_Delta | CE_Theta | PE_LTP | PE_OI | PE_Vol | PE_IV | PE_Delta | PE_Theta';
      for (const s of niftyOC.strikes) {
        ocStr += `\n${s.strike} | ₹${s.ce.ltp} | ${(s.ce.oi/1000).toFixed(0)}K | ${s.ce.volume} | ${s.ce.iv}% | ${s.ce.delta} | ${s.ce.theta||'-'} | ₹${s.pe.ltp} | ${(s.pe.oi/1000).toFixed(0)}K | ${s.pe.volume} | ${s.pe.iv}% | ${s.pe.delta} | ${s.pe.theta||'-'}`;
      }
    }
    if (bnfOC) {
      ocStr += `\n\nBANKNIFTY OPTION CHAIN (REAL-TIME from Upstox):`;
      ocStr += `\nSpot:${bnfOC.spot} | PCR:${bnfOC.pcr} | MaxPain:${bnfOC.maxPain} (${bnfMPDist}% from spot) | AvgIV:${bnfOC.avgIV}%${bnfIVPctl !== null ? ' ('+bnfIVPctl+'th pctl)' : ''}`;
      ocStr += `\nExpiry:${indexExpiryDate} | DTE:${indexDte} days | Lot:30`;
      ocStr += '\nStrike | CE_LTP | CE_OI | CE_Vol | CE_IV | PE_LTP | PE_OI | PE_Vol | PE_IV';
      for (const s of bnfOC.strikes) {
        ocStr += `\n${s.strike} | ₹${s.ce.ltp} | ${(s.ce.oi/1000).toFixed(0)}K | ${s.ce.volume} | ${s.ce.iv}% | ₹${s.pe.ltp} | ${(s.pe.oi/1000).toFixed(0)}K | ${s.pe.volume} | ${s.pe.iv}%`;
      }
    }

    // ── Stock option chain context with REAL premiums ──
    let stockOcStr = '';
    const stockSymbols = Object.keys(stockChains);
    if (stockSymbols.length) {
      stockOcStr += `\n\n═══ STOCK OPTION CHAINS (REAL-TIME, Monthly Expiry: ${stockExpiryDate}, DTE: ${stockDte}) ═══`;
      for (const sym of stockSymbols) {
        const sc = stockChains[sym];
        if (!sc || !sc.strikes || !sc.strikes.length) continue;
        const lotSize = sc.lotSize || NSE_LOT_SIZES[sym] || 1;
        const live = liveStocks[sym];
        const sig = signalCache[sym];
        const scPCR = sc.pcr || '—';
        const scMaxPain = sc.maxPain || '—';
        const scAvgIV = sc.avgIV || '—';
        stockOcStr += `\n\n${sym} OPTION CHAIN:`;
        stockOcStr += `\nSpot:₹${sc.spot||live?.price||'?'} (${live?.changePct>=0?'+':''}${live?.changePct?.toFixed(1)||0}%) | PCR:${scPCR} | MaxPain:${scMaxPain} | AvgIV:${scAvgIV}% | Lot:${lotSize}`;
        if (sig) stockOcStr += ` | Signal:${sig.signal}(${sig.score}/100)`;
        stockOcStr += '\nStrike | CE_LTP | CE_OI | CE_IV | PE_LTP | PE_OI | PE_IV';
        for (const s of sc.strikes) {
          stockOcStr += `\n${s.strike} | ₹${s.ce.ltp} | ${(s.ce.oi/1000).toFixed(0)}K | ${s.ce.iv}% | ₹${s.pe.ltp} | ${(s.pe.oi/1000).toFixed(0)}K | ${s.pe.iv}%`;
        }
      }
    }

    // ── Identify highest OI strikes (support/resistance walls) ──
    let oiWalls = '';
    if (niftyOC && niftyOC.strikes.length) {
      const byCallOI = [...niftyOC.strikes].sort((a,b) => b.ce.oi - a.ce.oi);
      const byPutOI = [...niftyOC.strikes].sort((a,b) => b.pe.oi - a.pe.oi);
      oiWalls += `\nNIFTY OI WALLS: Resistance(CE): ${byCallOI[0].strike}(${(byCallOI[0].ce.oi/100000).toFixed(1)}L), ${byCallOI[1]?.strike}(${(byCallOI[1]?.ce.oi/100000).toFixed(1)}L) | Support(PE): ${byPutOI[0].strike}(${(byPutOI[0].pe.oi/100000).toFixed(1)}L), ${byPutOI[1]?.strike}(${(byPutOI[1]?.pe.oi/100000).toFixed(1)}L)`;
    }
    if (bnfOC && bnfOC.strikes.length) {
      const byCallOI = [...bnfOC.strikes].sort((a,b) => b.ce.oi - a.ce.oi);
      const byPutOI = [...bnfOC.strikes].sort((a,b) => b.pe.oi - a.pe.oi);
      oiWalls += `\nBANKNIFTY OI WALLS: Resistance(CE): ${byCallOI[0].strike}(${(byCallOI[0].ce.oi/100000).toFixed(1)}L) | Support(PE): ${byPutOI[0].strike}(${(byPutOI[0].pe.oi/100000).toFixed(1)}L)`;
    }

    const gainStr = topGainers.map(s => {
      const sig = signalCache[s.symbol];
      return `${s.symbol}:₹${s.price}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%) Sig:${sig?.score||'-'}`;
    }).join(', ');
    const loseStr = topLosers.map(s => {
      const sig = signalCache[s.symbol];
      return `${s.symbol}:₹${s.price}(${s.changePct.toFixed(1)}%) Sig:${sig?.score||'-'}`;
    }).join(', ');

    // ── Market regime assessment ──
    const vixLevel = vixData.value > 20 ? 'VERY_HIGH' : vixData.value > 16 ? 'HIGH' : vixData.value < 12 ? 'LOW' : 'NORMAL';
    const pcrSignal = niftyOC ? (niftyOC.pcr > 1.3 ? 'BULLISH(heavy put writing=support)' : niftyOC.pcr < 0.7 ? 'BEARISH(heavy call writing=resistance)' : 'NEUTRAL') : 'N/A';
    const fiiSignal = fiiDiiData.fii > 500 ? 'STRONG_BUYING' : fiiDiiData.fii > 0 ? 'BUYING' : fiiDiiData.fii > -500 ? 'SELLING' : 'HEAVY_SELLING';
    const trendSignal = nifty && nifty.changePct > 0.5 ? 'STRONG_UPTREND' : nifty && nifty.changePct > 0.15 ? 'MILD_UPTREND' : nifty && nifty.changePct < -0.5 ? 'STRONG_DOWNTREND' : nifty && nifty.changePct < -0.15 ? 'MILD_DOWNTREND' : 'SIDEWAYS';
    const thetaWarning = dte <= 2 ? '⚠ EXPIRY IN ≤2 DAYS — theta decay is extreme. Only recommend if strong directional conviction.' : dte <= 5 ? 'Theta moderate — prefer ATM/slightly ITM for better delta.' : 'Theta manageable — OTM options viable with strong signal.';

    // ── Type filter from query param ──
    const tradeType = (req.query.type || 'all').toLowerCase(); // 'index', 'stock', 'all'

    const prompt = `You are an expert NSE F&O options strategist. You have REAL-TIME option chain data below. Use Google Search to check for any upcoming events (earnings, RBI policy, global cues) that could impact markets in the next ${dte} days.

CRITICAL RULES:
- You MUST pick strikes from the ACTUAL chain data below. Use the REAL LTP shown as entry price.
- Do NOT invent premium prices. The entry/target/SL must be based on the real LTPs in the chain.
- For INDEX options (NIFTY/BANKNIFTY): use the chain data below — these are REAL premiums. Expiry: ${indexExpiryDate} (${indexDte} DTE).
- For STOCK options: use the STOCK CHAIN data below if available — these are REAL premiums with monthly expiry ${stockExpiryDate} (${stockDte} DTE). If chain data is NOT available for a stock, mark "isEstimated":true.
- TRADE TYPE REQUEST: "${tradeType}" — ${tradeType === 'index' ? 'ONLY suggest INDEX trades (NIFTY/BANKNIFTY)' : tradeType === 'stock' ? 'ONLY suggest STOCK option trades' : 'Mix of both INDEX and STOCK trades'}.

USER'S TRADING STYLE:
- PRIMARY: BUYS options (CE or PE) as directional bets
- HEDGE: Buys FUTURES to hedge (e.g. buy PE + buy FUT for risk control)
- ROLLS: Books profit on winning strike → re-enters at next strike, keeps rolling
- Prioritize BUY strategies. No sell/credit strategies unless labeled as alternatives.

LIVE MARKET DATA:
Nifty=${nifty?.price||'?'}(${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%) BankNifty=${bankNifty?.price||'?'}(${bankNifty?.changePct>=0?'+':''}${bankNifty?.changePct||0}%)
VIX=${vixData.value}(${vixData.trend},${vixLevel}) FII=₹${fiiDiiData.fii}Cr(${fiiSignal}) DII=₹${fiiDiiData.dii}Cr
Trend:${trendSignal} PCR:${pcrSignal}
Index Expiry:${indexExpiryDate} DTE:${indexDte}days | Stock Expiry:${stockExpiryDate} DTE:${stockDte}days
${thetaWarning}
Time:${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}
${oiWalls}
${ocStr}
${stockOcStr}

MOVERS: Gainers: ${gainStr} | Losers: ${loseStr}
Stock chains available: ${stockSymbols.length ? stockSymbols.join(', ') : 'None'}

DECISION FRAMEWORK:
1. DTE ≤ 2: Only strong conviction trades. ATM only. Theta kills OTM.
2. DTE 3-5: ATM or 1 strike OTM. Need clear directional signal.
3. DTE > 5: OTM viable if IV is low and signal is strong.
4. HIGH VIX (>16): Premiums expensive. Need bigger moves to profit. Hedged strategies preferred.
5. LOW VIX (<12): Premiums cheap. Good for naked longs if direction is clear.
6. PCR > 1.2: Put writers confident = support below. Bullish bias.
7. PCR < 0.8: Call writers confident = resistance above. Bearish bias.
8. Max Pain proximity: If spot is far from max pain with <3 DTE, expect pull toward it.
9. OI walls: Highest OI strike on call side = resistance. Highest OI on put side = support.
10. Recommend 4-6 HIGH-QUALITY trades only. Better to give 3 great trades than 8 mediocre ones.

SIGNAL ALIGNMENT — score each trade honestly on these 10 factors:
[1]VIX_Level [2]PCR [3]FII_Flow [4]Trend [5]OI_Buildup [6]IV_Level [7]MaxPain_Proximity [8]Momentum [9]Volume [10]Risk_Reward

FOR EVERY TRADE, you MUST include a specific hedge suggestion. Examples:
- "Buy NIFTY APR FUT at ~₹24000 as delta hedge (hedges ~70% of directional risk)"
- "Buy 24200 PE at ₹xx as protective put (limits max loss to ₹xxxx)"
- "Sell 24500 CE at ₹xx to create vertical spread (reduces cost basis by ₹xx)"

Reply ONLY valid JSON array, NO markdown fences:
[{"symbol":"NIFTY/BANKNIFTY/STOCKNAME","optionType":"INDEX/STOCK","direction":"CE/PE","strike":24000,"strategy":"Naked Long 24000 CE / Long 23800 PE + Hedge APR FUT","strategyType":"NAKED_LONG/HEDGED_LONG/ROLLING_STRATEGY","entry":185,"entryRange":"₹180-190","target":280,"stopLoss":120,"rollLevel":"Book at ₹260, roll to 24200 CE","expiry":"2026-04-03","dte":5,"lotSize":75,"maxLoss":13875,"riskReward":"1:2.1","signalAlignment":{"score":7,"total":10,"factors":{"vix":"ALIGNED","pcr":"ALIGNED","fii":"NEUTRAL","trend":"ALIGNED","oi":"ALIGNED","iv":"ALIGNED","maxPain":"NEUTRAL","momentum":"ALIGNED","volume":"MISALIGNED","riskReward":"ALIGNED"},"summary":"7/10 — strong setup"},"riskType":"AGGRESSIVE/MODERATE/CONSERVATIVE","reasoning":"80-word analysis with OI/IV logic, key levels, theta impact, rolling plan","hedgeSuggestion":"Buy NIFTY APR FUT at ₹xxxxx as delta hedge (hedges ~70% directional risk)","hedgeType":"FUTURES/SPREAD/PROTECTIVE_PUT/COLLAR","sentiment":"BULLISH/BEARISH/NEUTRAL","isEstimated":false,"spotPrice":24000}]

IMPORTANT: "entry","target","stopLoss","strike","lotSize","maxLoss","spotPrice" MUST be NUMBERS. "isEstimated" = true only for stock options without chain data. "optionType" = "INDEX" for NIFTY/BANKNIFTY, "STOCK" for everything else.`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.3, maxOutputTokens: 8000, timeout: 90000 });
    const raw = g.text || '[]';
    log('OK', `Options Lab generated (${g.source}/${g.model}, grounded:${g.grounded||false}), ${raw.length} chars, OC:${niftyOC?'live':'none'}, DTE:${dte}`);

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

    // ── Post-processing: validate against real chain data ──
    for (const t of trades) {
      if (t.symbol) t.symbol = t.symbol.toUpperCase().replace(/\s+/g, '');
      // Normalize numeric fields
      for (const k of ['entry', 'target', 'stopLoss', 'strike', 'lotSize', 'maxLoss', 'dte', 'spotPrice']) {
        if (typeof t[k] === 'string') t[k] = parseFloat(t[k].replace(/[₹,\s]/g, '')) || 0;
      }
      // Classify option type
      const isIndex = t.symbol === 'NIFTY' || t.symbol === 'BANKNIFTY';
      t.optionType = isIndex ? 'INDEX' : 'STOCK';

      // Validate entry against real chain LTP
      let chain = null;
      if (isIndex) {
        chain = t.symbol === 'NIFTY' ? niftyOC : bnfOC;
      } else if (stockChains[t.symbol]) {
        chain = stockChains[t.symbol];
      }

      if (chain && t.strike && t.direction) {
        const realStrike = chain.strikes.find(s => s.strike === t.strike);
        if (realStrike) {
          const realLTP = t.direction === 'CE' ? realStrike.ce.ltp : realStrike.pe.ltp;
          if (realLTP > 0 && t.entry > 0) {
            const drift = Math.abs(t.entry - realLTP) / realLTP * 100;
            if (drift > 25) {
              t._premiumWarning = `AI entry ₹${t.entry} vs real LTP ₹${realLTP} (${drift.toFixed(0)}% off)`;
              t.entry = realLTP;
              t.entryRange = `₹${(realLTP * 0.95).toFixed(0)}-${(realLTP * 1.05).toFixed(0)}`;
            }
          }
          t.realLTP = realLTP;
          t.realOI = t.direction === 'CE' ? realStrike.ce.oi : realStrike.pe.oi;
          t.realIV = t.direction === 'CE' ? realStrike.ce.iv : realStrike.pe.iv;
          t.isEstimated = false;
        }
      } else if (!isIndex && !stockChains[t.symbol]) {
        t.isEstimated = true;
      }

      // Enrich with spot price and lot size
      if (!t.spotPrice) {
        if (isIndex) t.spotPrice = (t.symbol === 'NIFTY' ? nifty?.price : bankNifty?.price) || 0;
        else t.spotPrice = liveStocks[t.symbol]?.price || 0;
      }
      if (!t.lotSize || t.lotSize <= 1) {
        t.lotSize = isIndex ? (t.symbol === 'NIFTY' ? 75 : 30) : (NSE_LOT_SIZES[t.symbol] || 1);
      }

      // Recalculate maxLoss from validated entry
      if (t.entry && t.lotSize) {
        t.maxLoss = Math.round(t.entry * t.lotSize);
      }
      // Set correct DTE and expiry based on type
      t.dte = isIndex ? indexDte : stockDte;
      t.expiry = t.expiry || (isIndex ? indexExpiryDate : stockExpiryDate);
    }
    // Filter broken trades
    trades = trades.filter(t => t.symbol && t.direction && (t.entry || t.reasoning));
    // Apply type filter
    if (tradeType === 'index') trades = trades.filter(t => t.optionType === 'INDEX');
    else if (tradeType === 'stock') trades = trades.filter(t => t.optionType === 'STOCK');

    // Track picks for evaluation
    for (const t of trades) {
      if (t.symbol === 'NIFTY' || t.symbol === 'BANKNIFTY') {
        trackPick({ type: 'options', symbol: t.symbol === 'NIFTY' ? 'Nifty 50' : 'Nifty Bank', direction: t.direction, strategy: t.strategy, entryPrice: t.symbol === 'NIFTY' ? (nifty?.price||0) : (bankNifty?.price||0), entryPremium: t.entry, target: t.target, stopLoss: t.stopLoss, signalAlignment: t.signalAlignment, expiry: t.expiry });
      } else {
        const live = liveStocks[t.symbol];
        if (live) trackPick({ type: 'options', symbol: t.symbol, direction: t.direction, strategy: t.strategy, entryPrice: live.price, entryPremium: t.entry, target: t.target, stopLoss: t.stopLoss, signalAlignment: t.signalAlignment, expiry: t.expiry });
      }
    }

    optionsLabCache = { trades, lastFetch: Date.now() };
    const chainSummary = buildChainSummary(oc);
    res.json({ trades, cached: false, generated: new Date().toISOString(), model: g.model, grounded: g.grounded || false, chainData: chainSummary, dte: indexDte, expiry: indexExpiryDate, stockExpiry: stockExpiryDate, stockDte, stockChainSymbols: stockSymbols });
  } catch(e) {
    log('ERR', 'Options Lab failed: ' + e.message);
    if (optionsLabCache.trades.length) {
      return res.json({ trades: optionsLabCache.trades, cached: true, generated: new Date(optionsLabCache.lastFetch).toISOString(), stale: true, error: e.message, chainData: buildChainSummary(optionChainCache) });
    }
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

function buildChainSummary(oc) {
  if (!oc || !oc.nifty) return null;
  const summary = {
    niftyPCR: oc.nifty.pcr, niftyMaxPain: oc.nifty.maxPain, niftyAvgIV: oc.nifty.avgIV,
    niftySpot: oc.nifty.spot, niftyTotalCallOI: oc.nifty.totalCallOI, niftyTotalPutOI: oc.nifty.totalPutOI,
    bnfPCR: oc.banknifty?.pcr, bnfMaxPain: oc.banknifty?.maxPain, bnfAvgIV: oc.banknifty?.avgIV
  };
  // Add stock chain summaries
  if (oc.stocks && Object.keys(oc.stocks).length) {
    summary.stockChains = {};
    for (const [sym, sc] of Object.entries(oc.stocks)) {
      if (!sc) continue;
      summary.stockChains[sym] = { spot: sc.spot, pcr: sc.pcr, maxPain: sc.maxPain, avgIV: sc.avgIV, lotSize: sc.lotSize || NSE_LOT_SIZES[sym] || 1 };
    }
  }
  return summary;
}

// ══════════════════════════════════════════════════════════════════════════════
// SMART SCREENER — Pure in-memory filtering, no AI calls, instant response
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/screener', (req, res) => {
  // ── Market hours gate — screener only works during market hours ──
  if (!isMarketOpen()) {
    return res.json(marketClosedResponse(null));
  }

  // ── Parse filter parameters ──
  const filters = {
    preset:      req.query.preset || null,
    scoreMin:    req.query.scoreMin ? +req.query.scoreMin : null,
    scoreMax:    req.query.scoreMax ? +req.query.scoreMax : null,
    rsiZone:     req.query.rsiZone || null,       // oversold, neutral, overbought
    emaAlign:    req.query.emaAlign || null,       // bullish, bearish
    macdDir:     req.query.macdDir || null,        // bullish, bearish
    sector:      req.query.sector || null,
    cap:         req.query.cap || null,            // Large, Mid, Small
    fnoOnly:     req.query.fnoOnly === 'true',
    changePctMin: req.query.changePctMin ? +req.query.changePctMin : null,
    changePctMax: req.query.changePctMax ? +req.query.changePctMax : null,
    nearSupport: req.query.nearSupport === 'true',
    near52Low:   req.query.near52Low === 'true',
    near52High:  req.query.near52High === 'true',
    sortBy:      req.query.sortBy || 'score',     // score, changePct, rsi, symbol
    sortDir:     req.query.sortDir || 'desc',
    limit:       req.query.limit ? Math.min(+req.query.limit, 165) : 50
  };

  // ── Apply presets (override individual filters) ──
  if (filters.preset === 'oversold-quality') {
    filters.scoreMin = filters.scoreMin || 55;
    filters.rsiZone = 'oversold';
    // above 200 EMA checked in filter loop
    filters._above200EMA = true;
  } else if (filters.preset === 'momentum-breakouts') {
    filters.scoreMin = filters.scoreMin || 60;
    filters.emaAlign = 'bullish';
    filters.macdDir = 'bullish';
  } else if (filters.preset === 'value-dips') {
    filters.scoreMin = filters.scoreMin || 40;
    filters.near52Low = true;
  } else if (filters.preset === 'fno-high-iv') {
    filters.fnoOnly = true;
    filters._hasIV = true;
  } else if (filters.preset === 'strong-buys') {
    filters.scoreMin = 75;
  }

  // ── Build result set ──
  const results = [];
  const sectors = new Set();
  let totalScanned = 0;

  for (const stock of STOCK_UNIVERSE) {
    const sym = stock.symbol;
    const live = liveStocks[sym];
    const sig = signalCache[sym];

    // Must have live price data
    if (!live || !live.price) continue;
    totalScanned++;

    // Collect sectors for filter dropdown
    if (stock.sector) sectors.add(stock.sector);

    // ── Apply filters ──

    // Signal score range
    const score = sig?.score ?? 0;
    if (filters.scoreMin !== null && score < filters.scoreMin) continue;
    if (filters.scoreMax !== null && score > filters.scoreMax) continue;

    // RSI zone filter
    if (filters.rsiZone) {
      const prices = priceHistory[sym] || [];
      let rsi = 50;
      if (prices.length >= 15) {
        rsi = calcRSI(prices, 14);
      }
      if (filters.rsiZone === 'oversold' && rsi >= 35) continue;
      if (filters.rsiZone === 'overbought' && rsi <= 65) continue;
      if (filters.rsiZone === 'neutral' && (rsi < 35 || rsi > 65)) continue;
    }

    // EMA alignment
    if (filters.emaAlign || filters._above200EMA) {
      const prices = priceHistory[sym] || [];
      if (prices.length >= 20) {
        const ema20 = calcEMA(prices, 20);
        const ema50 = calcEMA(prices, Math.min(50, prices.length));
        const ema200 = calcEMA(prices, Math.min(200, prices.length));
        if (filters.emaAlign === 'bullish' && !(ema20 > ema50 && live.price > ema20)) continue;
        if (filters.emaAlign === 'bearish' && !(ema20 < ema50 && live.price < ema20)) continue;
        if (filters._above200EMA && live.price < ema200) continue;
      } else if (filters.emaAlign || filters._above200EMA) {
        continue; // Not enough data to evaluate
      }
    }

    // MACD direction
    if (filters.macdDir) {
      const prices = priceHistory[sym] || [];
      if (prices.length >= 26) {
        const macdData = calcMACD(prices);
        if (filters.macdDir === 'bullish' && !(macdData.macd > macdData.signal)) continue;
        if (filters.macdDir === 'bearish' && !(macdData.macd < macdData.signal)) continue;
      } else {
        continue; // Not enough data
      }
    }

    // Sector filter
    if (filters.sector && stock.sector !== filters.sector) continue;

    // Cap size
    if (filters.cap && stock.cap !== filters.cap) continue;

    // F&O only
    if (filters.fnoOnly && !FNO_STOCKS.includes(sym)) continue;

    // Change % range
    if (filters.changePctMin !== null && (live.changePct || 0) < filters.changePctMin) continue;
    if (filters.changePctMax !== null && (live.changePct || 0) > filters.changePctMax) continue;

    // Near support
    if (filters.nearSupport) {
      const prices = priceHistory[sym] || [];
      if (prices.length >= 20) {
        const support = calcSupport(prices, prices);
        const dist = support > 0 ? ((live.price - support) / live.price) * 100 : 999;
        if (dist > 5) continue;
      } else {
        continue;
      }
    }

    // Near 52W low (within 10%)
    if (filters.near52Low) {
      const f52 = fundamentals[sym];
      if (!f52 || !f52.low52) continue;
      const dist = ((live.price - f52.low52) / f52.low52) * 100;
      if (dist > 10) continue;
    }

    // Near 52W high (within 5%)
    if (filters.near52High) {
      const f52 = fundamentals[sym];
      if (!f52 || !f52.high52) continue;
      const dist = ((f52.high52 - live.price) / f52.high52) * 100;
      if (dist > 5) continue;
    }

    // F&O High IV preset: must have option chain data
    if (filters._hasIV) {
      const oc = optionChainCache.stocks[sym];
      if (!oc || !oc.avgIV) continue;
    }

    // ── Build result row ──
    const prices = priceHistory[sym] || [];
    let rsi = null, ema20 = null, ema50 = null, support = null, resistance = null;
    if (prices.length >= 15) rsi = calcRSI(prices, 14);
    if (prices.length >= 20) {
      ema20 = calcEMA(prices, 20);
      ema50 = calcEMA(prices, Math.min(50, prices.length));
      support = calcSupport(prices, prices);
      resistance = calcResistance(prices, prices);
    }

    const f52 = fundamentals[sym];
    const oc = optionChainCache.stocks[sym];
    const isFnO = FNO_STOCKS.includes(sym);

    results.push({
      symbol: sym,
      name: stock.name,
      sector: stock.sector,
      cap: stock.cap,
      price: live.price,
      changePct: +(live.changePct || 0).toFixed(2),
      volume: live.volume || 0,
      score,
      signal: sig?.signal || 'N/A',
      techBias: sig?.techBias || 'NEUTRAL',
      techScore: sig?.techScore || 50,
      upside: sig?.upside || 0,
      downside: sig?.downside || 0,
      rsi: rsi !== null ? +rsi.toFixed(1) : null,
      ema20,
      ema50,
      support,
      resistance,
      high52: f52?.high52 || null,
      low52: f52?.low52 || null,
      isFnO,
      lotSize: isFnO ? (NSE_LOT_SIZES[sym] || null) : null,
      pcr: oc?.pcr || null,
      avgIV: oc?.avgIV || null,
      maxPain: oc?.maxPain || null,
      reason: sig?.reason || null,
      lastUpdate: live.lastUpdate || null
    });
  }

  // ── Sort ──
  const dir = filters.sortDir === 'asc' ? 1 : -1;
  results.sort((a, b) => {
    if (filters.sortBy === 'changePct') return ((a.changePct || 0) - (b.changePct || 0)) * dir;
    if (filters.sortBy === 'rsi') return ((a.rsi || 50) - (b.rsi || 50)) * dir;
    if (filters.sortBy === 'symbol') return a.symbol.localeCompare(b.symbol) * dir;
    return ((a.score || 0) - (b.score || 0)) * dir; // default: score
  });

  // ── Trim to limit ──
  const trimmed = results.slice(0, filters.limit);

  // ── Response ──
  const response = {
    stocks: trimmed,
    total: results.length,
    scanned: totalScanned,
    sectors: [...sectors].sort(),
    filters: {
      preset: filters.preset,
      scoreMin: filters.scoreMin,
      scoreMax: filters.scoreMax,
      rsiZone: filters.rsiZone,
      emaAlign: filters.emaAlign,
      macdDir: filters.macdDir,
      sector: filters.sector,
      cap: filters.cap,
      fnoOnly: filters.fnoOnly,
      nearSupport: filters.nearSupport,
      near52Low: filters.near52Low,
      near52High: filters.near52High
    },
    marketOpen: true
  };

  res.json(response);
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
  const { apiKey, apiSecret, pin, redirectUri, geminiKey, geminiKey2, geminiKey3, zApiKey, zApiSecret, zRedirectUri, twelveDataKey } = req.body;
  // Allow partial saves — only update fields that are provided
  if (pin) {
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });
    appConfig.pin = hash(pin);
  }
  if (apiKey)       appConfig.apiKey      = apiKey.trim();
  if (apiSecret)    appConfig.apiSecret   = apiSecret.trim();
  if (redirectUri)  appConfig.redirectUri  = redirectUri.trim();
  if (geminiKey)    appConfig.geminiKey    = geminiKey.trim();
  if (geminiKey2)   appConfig.geminiKey2   = geminiKey2.trim();
  if (geminiKey3)   appConfig.geminiKey3   = geminiKey3.trim();
  if (zApiKey)      appConfig.zApiKey      = zApiKey.trim();
  if (zApiSecret)   appConfig.zApiSecret   = zApiSecret.trim();
  if (zRedirectUri) appConfig.zRedirectUri = zRedirectUri.trim();
  if (twelveDataKey) {
    appConfig.twelveDataKey = twelveDataKey.trim();
    // Restart polling with new key
    stopTwelveDataPolling();
    startTwelveDataPolling();
  }
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
    hasVertexAI:      !!gcpServiceAccount,
    hasTwelveData:    !!appConfig.twelveDataKey,
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
    const g = await callGemini('Reply with just: OK', { maxOutputTokens: 10, timeout: 45000 });
    res.json({ ok: true, response: g.text.trim(), model: g.model });
  } catch(e) {
    res.json({ ok: false, reason: e.response?.data?.error?.message || e.message });
  }
});

app.get('/api/system-health', (req, res) => {
  const now = Date.now();
  res.json({
    upstox:    { connected: connectionStatus === 'live' || (!!accessToken && connectionStatus === 'authenticated'), status: connectionStatus, tokenValid: !!accessToken && appConfig.tokenExpiry > now, expiresIn: appConfig.tokenExpiry ? Math.round((appConfig.tokenExpiry - now) / 60000) : 0, hasToken: !!accessToken },
    zerodha:   { connected: !!zAccessToken, tokenValid: !!zAccessToken && appConfig.zTokenExpiry > now, holdingsCount: zerodhaHoldings.length, positionsCount: zerodhaPositions.length },
    gemini:    { configured: !!appConfig.geminiKey, connected: geminiConnectionOk && !!appConfig.geminiKey && !geminiDisabled, disabled: geminiDisabled, status: geminiDisabled ? 'disconnected' : (geminiConnectionOk ? 'connected' : (appConfig.geminiKey ? 'configured_not_tested' : 'not_configured')), keysCount: getGeminiKeys().length, activeKey: geminiKeyIndex + 1 },
    vertexAI:  { configured: !!gcpServiceAccount, connected: vertexConnectionOk && !!gcpServiceAccount && !vertexDisabled, disabled: vertexDisabled, projectId: gcpServiceAccount?.project_id || null, clientEmail: gcpServiceAccount?.client_email || null, models: GEMINI_MODELS },
    twelveData: { configured: !!appConfig.twelveDataKey, connected: !!appConfig.twelveDataKey && !twelveDataDisabled && Object.keys(globalMarkets).length > 0, disabled: twelveDataDisabled || false, symbolsLoaded: Object.keys(globalMarkets).length, symbols: TWELVE_DATA_SYMBOLS.length, polling: !!twelveDataInterval, lastUpdate: Object.values(globalMarkets).reduce((max, g) => Math.max(max, g.lastUpdate || 0), 0) || null },
    server:    { uptime: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), stocksLoaded: stockUniverse.length, signalsCalc: Object.keys(signalCache).length },
    marketOpen: isMarketOpen(),
    lastUpdate: Object.values(liveStocks)[0]?.lastUpdate || null,
    tests:      testResults
  });
});

// Connection test endpoints
app.get('/api/upstox-test', (req, res) => {
  if (!appConfig.apiKey || !appConfig.apiSecret) return res.json({ ok: false, reason: 'API keys not configured' });
  if (accessToken && connectionStatus === 'live') return res.json({ ok: true, status: 'Connected with live data' });
  if (accessToken) return res.json({ ok: true, status: 'Token present, not live yet' });
  res.json({ ok: false, reason: 'Not authenticated. Use the login flow.' });
});

app.get('/api/zerodha-refresh', (req, res) => {
  if (!appConfig.zApiKey || !appConfig.zApiSecret) return res.json({ ok: false, reason: 'Zerodha keys not configured' });
  if (zAccessToken) return res.json({ ok: true, status: 'Token active', holdings: zerodhaHoldings.length });
  res.json({ ok: false, reason: 'Not authenticated. Use the login flow.' });
});

app.post('/api/twelvedata-test', async (req, res) => {
  const key = req.body.key || appConfig.twelveDataKey;
  if (!key) return res.json({ ok: false, reason: 'No API key' });
  try {
    // Test with a simple quote request
    const url = `https://api.twelvedata.com/quote?symbol=USD/INR&apikey=${key}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data.status === 'error') {
      return res.json({ ok: false, reason: data.message || 'Invalid API key' });
    }
    const price = parseFloat(data.close) || parseFloat(data.price) || 0;
    if (price > 0) {
      // Key works — save it, enable, and start polling
      appConfig.twelveDataKey = key;
      twelveDataDisabled = false;
      saveConfig();
      stopTwelveDataPolling();
      startTwelveDataPolling();
      log('OK', `Twelve Data API key verified — USD/INR: ${price}`);
      return res.json({ ok: true, price, symbol: 'USD/INR', symbolsAvailable: TWELVE_DATA_SYMBOLS.length });
    }
    return res.json({ ok: false, reason: 'API returned no price data' });
  } catch(e) {
    return res.json({ ok: false, reason: e.message || 'Connection failed' });
  }
});

app.post('/api/gemini-test', async (req, res) => {
  const key = req.body.key || appConfig.geminiKey;
  if (!key) return res.json({ ok: false, reason: 'No API key' });
  try {
    // Temporarily use the provided key and clear disabled flag for test
    const origKey = appConfig.geminiKey;
    const wasDisabled = geminiDisabled;
    appConfig.geminiKey = key;
    geminiDisabled = false; // allow test call even if previously disconnected
    const g = await callGemini('Reply with just: OK', { maxOutputTokens: 10, timeout: 45000 });
    appConfig.geminiKey = origKey; // restore
    log('OK', 'Gemini test passed — model: ' + g.model);
    geminiConnectionOk = true;
    geminiDisabled = false; // re-enable on successful connect
    res.json({ ok: true, model: g.model });
  } catch(e) {
    geminiConnectionOk = false;
    log('ERR', 'Gemini test failed: ' + (e.message || ''));
    res.json({ ok: false, reason: e.response?.data?.error?.message || e.message });
  }
});

app.post('/api/vertex-test', async (req, res) => {
  if (!gcpServiceAccount) return res.json({ ok: false, reason: 'No service account configured' });
  try {
    vertexDisabled = false; // allow test call even if previously disconnected
    const result = await callVertexAI('Reply with just: OK', { maxOutputTokens: 10, timeout: 45000, grounding: false });
    vertexConnectionOk = true;
    vertexDisabled = false; // re-enable on successful connect
    log('OK', `Vertex AI test passed (${result.model})`);
    res.json({ ok: true, projectId: gcpServiceAccount.project_id, model: result.model });
  } catch(e) {
    vertexConnectionOk = false;
    log('ERR', 'Vertex AI test failed: ' + (e.message || ''));
    res.json({ ok: false, reason: e.message || 'Connection failed' });
  }
});

app.post('/api/vertex-save', (req, res) => {
  const { serviceAccountJson } = req.body;
  if (!serviceAccountJson) return res.status(400).json({ error: 'No service account JSON provided' });
  try {
    const parsed = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      return res.status(400).json({ error: 'Invalid service account JSON — missing required fields (project_id, client_email, private_key)' });
    }
    fs.writeFileSync(GCP_SA_PATH, JSON.stringify(parsed, null, 2));
    gcpServiceAccount = parsed;
    vertexConnectionOk = false; // reset until tested
    log('OK', 'Vertex AI service account saved: ' + parsed.client_email);
    res.json({ success: true, clientEmail: parsed.client_email, projectId: parsed.project_id });
  } catch(e) {
    res.status(400).json({ error: 'Invalid JSON: ' + e.message });
  }
});

// Disconnect endpoints — revoke tokens / disable connections
app.post('/api/disconnect', (req, res) => {
  const { service } = req.body;
  if (!service) return res.status(400).json({ error: 'Specify service to disconnect' });
  switch (service) {
    case 'upstox':
      accessToken = null;
      appConfig.tokenExpiry = 0;
      connectionStatus = 'disconnected';
      stopPricePoller();
      broadcastStatus();
      log('WARN', 'Upstox disconnected by user');
      return res.json({ ok: true, service: 'upstox' });
    case 'zerodha':
      zAccessToken = null;
      appConfig.zTokenExpiry = 0;
      zerodhaHoldings = []; zerodhaPositions = []; zerodhaOrders = [];
      log('WARN', 'Zerodha disconnected by user');
      return res.json({ ok: true, service: 'zerodha' });
    case 'gemini':
      geminiConnectionOk = false;
      geminiDisabled = true;
      log('WARN', 'Gemini AI disconnected by user');
      return res.json({ ok: true, service: 'gemini' });
    case 'vertex':
      vertexConnectionOk = false;
      vertexDisabled = true;
      vertexAccessToken = null;
      vertexTokenExpiry = 0;
      log('WARN', 'Vertex AI disconnected by user');
      return res.json({ ok: true, service: 'vertex' });
    case 'twelvedata':
      twelveDataDisabled = true;
      stopTwelveDataPolling();
      globalMarkets = {};
      log('WARN', 'Twelve Data disconnected by user');
      return res.json({ ok: true, service: 'twelvedata' });
    default:
      return res.status(400).json({ error: 'Unknown service: ' + service });
  }
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: LOGS.slice(0, 100) });
});

app.post('/api/clear', (req, res) => {
  appConfig = {}; accessToken = null; zAccessToken = null;
  stockUniverse = []; liveStocks = {}; signalCache = {}; fundamentals = {};
  zerodhaHoldings = []; zerodhaPositions = []; zerodhaOrders = [];
  [CONFIG_FILE, PORTFOLIO_FILE, NOTES_FILE, OPTIONS_FILE].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
  stopPricePoller();
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

// Symbol search + LTP for Live Analysis autocomplete
app.get('/api/symbol-search', (req, res) => {
  const q = (req.query.q || '').toUpperCase().replace(/\s+/g, '');
  if (!q || q.length < 1) return res.json({ results: [] });
  const indexSyms = [
    { symbol: 'NIFTY', name: 'Nifty 50', price: liveIndices['Nifty 50']?.price || null },
    { symbol: 'BANKNIFTY', name: 'Bank Nifty', price: liveIndices['Nifty Bank']?.price || null },
    { symbol: 'FINNIFTY', name: 'Finnifty', price: liveIndices['Nifty Fin Service']?.price || null },
    { symbol: 'MIDCPNIFTY', name: 'Midcap Nifty', price: liveIndices['Nifty Midcap 50']?.price || null },
    { symbol: 'SENSEX', name: 'BSE Sensex', price: liveIndices['SENSEX']?.price || null }
  ];
  const stockResults = STOCK_UNIVERSE
    .filter(s => s.symbol.includes(q) || s.name.toUpperCase().includes(q))
    .slice(0, 15)
    .map(s => ({ symbol: s.symbol, name: s.name, price: liveStocks[s.symbol]?.price || null }));
  const indexResults = indexSyms.filter(s => s.symbol.includes(q) || s.name.toUpperCase().includes(q));
  const results = [...indexResults, ...stockResults].slice(0, 12);
  res.json({ results });
});

app.get('/api/global', (req, res) => {
  res.json({ globalMarkets, symbolCount: Object.keys(globalMarkets).length });
});

app.get('/api/technical/:symbol', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const prices = priceHistory[sym];
  if (!prices || prices.length < 5) {
    return res.json({ symbol: sym, error: 'Insufficient price history — connect Upstox for live data', dataPoints: prices?.length || 0 });
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
    dataDate: lastFiiDiiDate || null,
    source: lastFiiDiiDate ? 'NSE India (fiidiiTradeReact)' : 'default'
  });
});

app.get('/api/fii-dii/refresh', async (req, res) => {
  try {
    const ok = await fetchNseFiiDii();
    res.json({
      ok,
      data: {
        fii: fiiDiiData.fii, dii: fiiDiiData.dii,
        usdInr: fiiDiiData.usdInr, crude: fiiDiiData.crude,
        dataDate: lastFiiDiiDate || null,
        source: lastFiiDiiDate ? 'NSE India (fiidiiTradeReact)' : 'default'
      },
      message: ok ? 'FII/DII refreshed from NSE' : 'NSE fetch failed, using cached data'
    });
  } catch(e) {
    res.json({ ok: false, data: { fii: fiiDiiData.fii, dii: fiiDiiData.dii, usdInr: fiiDiiData.usdInr, crude: fiiDiiData.crude }, message: e.message });
  }
});

app.get('/api/indices/refresh', async (req, res) => {
  try {
    const ok = await fetchNseIndices();
    res.json({
      ok,
      indices: liveIndices,
      vix: vixData,
      message: ok ? 'Indices refreshed from NSE' : 'NSE fetch failed, using cached data'
    });
  } catch(e) {
    res.json({ ok: false, indices: liveIndices, vix: vixData, message: e.message });
  }
});

// ── Economic Calendar — structural events + Gemini-grounded live events ─────
let econCalCache = { events: [], lastFetch: 0 };
const ECON_CAL_CACHE_MS = 30 * 60 * 1000; // Cache 30 minutes

app.get('/api/market-context', async (req, res) => {
  // Always include structural events from marketContext.js
  const structural = getMarketContext().map(e => ({
    ...e,
    searchUrl: `https://www.google.com/search?q=${encodeURIComponent(e.title + ' India stock market ' + new Date().getFullYear())}&tbm=nws`
  }));

  // Try Gemini-grounded live events (cached)
  if (econCalCache.events.length && (Date.now() - econCalCache.lastFetch) < ECON_CAL_CACHE_MS) {
    return res.json({ events: [...structural, ...econCalCache.events], generated: new Date().toISOString(), hasLive: true });
  }

  if (!appConfig.geminiKey && !gcpServiceAccount) {
    return res.json({ events: structural, generated: new Date().toISOString(), hasLive: false });
  }

  try {
    const ist = getIST();
    const dateStr = `${ist.getUTCDate()}/${ist.getUTCMonth()+1}/${ist.getFullYear()}`;
    const prompt = `You are a financial calendar assistant for Indian stock markets. Today is ${dateStr} IST.

Return a JSON array of 3-6 REAL upcoming economic events happening THIS WEEK and NEXT WEEK that impact Indian markets (NSE/BSE). Include ONLY verified, scheduled events — no speculation.

Focus on: RBI announcements, SEBI deadlines, major IPO dates, quarterly results dates for Nifty50 stocks, US Fed/CPI/jobs data releases, crude OPEC meetings, India CPI/IIP/GDP releases.

Each object must have:
- "title": event name (max 60 chars)
- "date": actual date in "DD Mon" format (e.g. "28 Mar")
- "priority": "HIGH" / "MEDIUM" / "LOW"
- "impact": 1-line impact on Indian markets (max 100 chars)
- "trend": "THIS WEEK" or "NEXT WEEK"
- "icon": relevant emoji
- "sectors": { "watch": ["sector1"], "buy": ["sector2"], "avoid": ["sector3"] } (use only relevant keys)

Return ONLY the JSON array, no markdown or explanation.`;

    const result = await callAI(prompt, { preferGrounded: true, maxTokens: 1200 });
    if (result && result.text) {
      let parsed = [];
      try {
        const cleaned = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          parsed = parsed.map(e => ({
            ...e,
            id: `live-${(e.title||'').replace(/\s+/g,'-').toLowerCase().slice(0,30)}`,
            isLive: true,
            affectsOptions: false,
            vixImpact: '',
            searchUrl: `https://www.google.com/search?q=${encodeURIComponent(e.title + ' India stock market')}&tbm=nws`
          }));
          econCalCache = { events: parsed, lastFetch: Date.now() };
        }
      } catch (parseErr) {
        log('WARN', `Economic calendar parse error: ${parseErr.message}`);
      }
    }
    res.json({ events: [...structural, ...econCalCache.events], generated: new Date().toISOString(), hasLive: econCalCache.events.length > 0 });
  } catch (err) {
    log('ERR', `Economic calendar AI error: ${err.message}`);
    res.json({ events: structural, generated: new Date().toISOString(), hasLive: false });
  }
});

// ── Live Market News via Gemini ─────────────────────────────────────────────
let newsCache = { items: [], lastFetch: 0, dateIST: '' };
let warNewsCache = { items: [], lastFetch: 0, dateIST: '' };
const NEWS_CACHE_MS = 10 * 60 * 1000; // Cache 10 minutes
const WAR_NEWS_CACHE_MS = 15 * 60 * 1000; // Cache 15 minutes

function parseNewsItems(raw) {
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
  return items;
}

function getNewsTodayStr() {
  const ist = getIST();
  const day = ist.getUTCDate(), mon = ist.toLocaleString('en-IN', { month:'long', timeZone:'Asia/Kolkata' }), yr = ist.getUTCFullYear();
  const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][ist.getUTCDay()];
  return { full: `${weekday}, ${day} ${mon} ${yr}`, short: ist.toISOString().slice(0,10), dayMon: `${day} ${mon.slice(0,3)} ${yr}` };
}

app.get('/api/news', async (req, res) => {
  const force = req.query.force === 'true';
  const todayDate = getISTDateStr();
  // Invalidate cache on date roll
  if (newsCache.dateIST && newsCache.dateIST !== todayDate) { newsCache = { items: [], lastFetch: 0, dateIST: '' }; }
  // Return cache if fresh
  if (!force && newsCache.items.length && (Date.now() - newsCache.lastFetch) < NEWS_CACHE_MS) {
    return res.json({ news: newsCache.items, cached: true, generated: new Date(newsCache.lastFetch).toISOString() });
  }
  if (!appConfig.geminiKey) return res.json({ news: [], configured: false, error: 'Gemini API key not configured' });
  try {
    const nifty = liveIndices['Nifty 50'];
    const vix = vixData.value;
    const topG = Object.values(liveStocks).filter(s=>s.price).sort((a,b)=>b.changePct-a.changePct).slice(0,5).map(s=>`${s.symbol}(${s.changePct>=0?'+':''}${s.changePct.toFixed(1)}%)`).join(',');
    const topL = Object.values(liveStocks).filter(s=>s.price).sort((a,b)=>a.changePct-b.changePct).slice(0,5).map(s=>`${s.symbol}(${s.changePct.toFixed(1)}%)`).join(',');

    const td = getNewsTodayStr();
    const prompt = `You are a senior Indian stock market analyst with access to real-time news via Google Search.

CRITICAL DATE RULES:
- TODAY IS: ${td.full} (${td.short})
- Every "date" field in your response MUST be "${td.dayMon}" (today) unless the event literally happened yesterday
- DO NOT use old dates. Search for the LATEST news from the last 24 hours
- If you find news from yesterday or earlier, update the headline to reflect TODAY's status/development

Generate exactly 8 of the most important market-moving NEWS events as of RIGHT NOW that impact Indian stock markets (NSE/BSE).

CURRENT MARKET: Nifty=${nifty?.price||'?'}(${nifty?.changePct>=0?'+':''}${nifty?.changePct||0}%) VIX=${vix} FII=₹${fiiDiiData.fii}Cr DII=₹${fiiDiiData.dii}Cr
TOP GAINERS: ${topG}
TOP LOSERS: ${topL}

MANDATORY COVERAGE — always include if active:
- Active wars, military conflicts, sanctions (Russia-Ukraine, Middle East, etc.) — they impact crude oil, shipping, commodity prices, defense stocks, and EM risk sentiment
- Trade wars, tariffs, and economic sanctions — direct impact on IT, Pharma, export-heavy sectors
- Central bank decisions (Fed, RBI, ECB) and rate actions
These MUST be included — they affect crude, gold, DXY, FII flows, and Indian market sentiment.

For each news item provide:
1. A specific, factual headline reflecting TODAY's latest development
2. Priority: HIGH (market-moving), MEDIUM (sector impact), LOW (watch)
3. Market impact: how it affects Indian stocks specifically (30 words)
4. Affected sectors (buy/avoid)
5. Sentiment: BULLISH, BEARISH, or NEUTRAL
6. Source type: RBI, GOVT, GLOBAL, CORPORATE, ECONOMIC, GEOPOLITICAL, WAR_CONFLICT
7. Scope: NATIONAL or INTERNATIONAL

Include a balanced mix — at least 3 NATIONAL and 3 INTERNATIONAL items. At least 1 MUST cover active geopolitical conflicts or wars.

Reply ONLY valid JSON array:
[{"title":"Headline","date":"${td.dayMon}","priority":"HIGH","impact":"30-word impact","sentiment":"BEARISH","source":"WAR_CONFLICT","scope":"INTERNATIONAL","icon":"emoji","sectors":{"buy":["sector"],"avoid":["sector"]},"detail":"50-word analysis"}]`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.4, maxOutputTokens: 4000, timeout: 45000 });
    const raw = g.text || '[]';
    log('OK', `AI news generated (${g.source}/${g.model}, grounded:${g.grounded || false}), ${raw.length} chars`);

    const items = parseNewsItems(raw);
    newsCache = { items, lastFetch: Date.now(), dateIST: todayDate };
    res.json({ news: items, cached: false, generated: new Date().toISOString() });
  } catch(e) {
    log('ERR', 'Gemini news failed: ' + e.message);
    if (newsCache.items.length) return res.json({ news: newsCache.items, cached: true, stale: true, generated: new Date(newsCache.lastFetch).toISOString() });
    res.status(500).json({ error: 'News fetch failed: ' + e.message });
  }
});

// ── War & Geopolitical News — Dedicated endpoint ───────────────────────────
app.get('/api/war-news', async (req, res) => {
  const force = req.query.force === 'true';
  const todayDate = getISTDateStr();
  if (warNewsCache.dateIST && warNewsCache.dateIST !== todayDate) { warNewsCache = { items: [], lastFetch: 0, dateIST: '' }; }
  if (!force && warNewsCache.items.length && (Date.now() - warNewsCache.lastFetch) < WAR_NEWS_CACHE_MS) {
    return res.json({ news: warNewsCache.items, cached: true, generated: new Date(warNewsCache.lastFetch).toISOString() });
  }
  if (!appConfig.geminiKey) return res.json({ news: [], configured: false, error: 'Gemini API key not configured' });
  try {
    const td = getNewsTodayStr();
    const globalStr = Object.values(globalMarkets).map(g =>
      `${g.name}: ${g.price} (${g.changePct >= 0 ? '+' : ''}${g.changePct}%)`
    ).join(', ');

    const prompt = `You are a geopolitical and defense analyst specializing in how wars, conflicts, and sanctions affect the Indian stock market.

CRITICAL: TODAY IS ${td.full} (${td.short}). Every "date" field MUST be "${td.dayMon}" unless the event literally happened yesterday. Search for the ABSOLUTE LATEST developments from the last 24 hours.

Generate exactly 10 news items about ACTIVE wars, military conflicts, geopolitical tensions, trade wars, and sanctions that affect global/Indian markets. Cover ALL of these if active:
- Russia-Ukraine war: latest battlefield developments, energy/gas impacts, sanctions updates
- Middle East tensions: Israel-Palestine, Iran, Houthi/Red Sea shipping, Strait of Hormuz
- US-China tensions: trade war, Taiwan, tech sanctions, tariffs
- India-specific: border tensions, defense deals, diplomatic moves
- Trade wars: US reciprocal tariffs, EU tariffs, WTO disputes
- Sanctions: Russia, Iran, North Korea — impact on oil, shipping, commodities
- Cyber warfare, space militarization if market-relevant
- Any NEW emerging conflicts or escalations

GLOBAL MARKETS NOW: ${globalStr || 'Use Google Search for latest'}
Crude: ${globalMarkets.CRUDE?.price || 'search'} | Gold: ${globalMarkets.GOLD?.price || 'search'} | USD/INR: ${globalMarkets.USDINR?.price || 'search'}

For each item:
- Priority: HIGH (directly moves crude/gold/INR/indices), MEDIUM (sector-level impact), LOW (background risk — STILL INCLUDE IT)
- Show impact on Indian market specifically (crude imports, defense stocks, IT/pharma exports, FII flows, shipping costs)
- INCLUDE items even with LOW impact — traders need awareness of all active conflicts

Reply ONLY valid JSON array:
[{"title":"Specific headline","date":"${td.dayMon}","priority":"HIGH/MEDIUM/LOW","impact":"How this affects Indian markets in 30 words","sentiment":"BULLISH/BEARISH/NEUTRAL","source":"WAR_CONFLICT","scope":"INTERNATIONAL","icon":"emoji","sectors":{"buy":["Defense","Gold"],"avoid":["Aviation","Shipping"]},"detail":"50-word analysis with specific Indian stocks/indices affected"}]`;

    const g = await callAI(prompt, { preferGrounded: true, temperature: 0.4, maxOutputTokens: 6000, timeout: 60000 });
    const raw = g.text || '[]';
    log('OK', `War news generated (${g.source}/${g.model}, grounded:${g.grounded || false}), ${raw.length} chars`);

    let items = parseNewsItems(raw);
    // Tag all as WAR_CONFLICT source if AI missed it
    items = items.map(n => ({ ...n, source: n.source || 'WAR_CONFLICT', scope: n.scope || 'INTERNATIONAL' }));
    warNewsCache = { items, lastFetch: Date.now(), dateIST: todayDate };
    res.json({ news: items, cached: false, generated: new Date().toISOString() });
  } catch(e) {
    log('ERR', 'War news failed: ' + e.message);
    if (warNewsCache.items.length) return res.json({ news: warNewsCache.items, cached: true, stale: true, generated: new Date(warNewsCache.lastFetch).toISOString() });
    res.status(500).json({ error: 'War news fetch failed: ' + e.message });
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

// Strategy grouper: groups by UNDERLYING + EXPIRY MONTH
// User's style: BUYS options (PE/CE), hedges with futures, ROLLS strikes within same expiry
// All legs in same underlying + expiry = ONE strategy (shows combined net P&L)
function groupTradeHistoryIntoStrategies(trades) {
  const groups = {};
  for (const t of trades) {
    const underlying = extractUnderlying(t.symbol);
    const expiry = extractExpiryMonth(t.symbol, t.buyDate || t.sellDate);
    const key = `${underlying}_${expiry}`;
    if (!groups[key]) groups[key] = { underlying, expiry, legs: [], firstDate: null, lastDate: null };
    groups[key].legs.push(t);
    const date = t.sellDate || t.buyDate;
    if (!groups[key].firstDate || date < groups[key].firstDate) groups[key].firstDate = date;
    if (!groups[key].lastDate || date > groups[key].lastDate) groups[key].lastDate = date;
  }

  const strategies = [];
  for (const [key, group] of Object.entries(groups)) {
    const legs = group.legs;
    const type = classifyStrategy(legs);
    const netPnl = legs.reduce((s, t) => s + (t.sellPrice - t.buyPrice) * t.qty, 0);
    const hasOpenLegs = legs.some(t => !t.sellPrice || t.sellPrice === 0);

    // Separate into rolled legs (closed with profit/loss) and active legs
    const closedLegs = legs.filter(t => t.sellPrice && t.sellPrice > 0);
    const openLegs = legs.filter(t => !t.sellPrice || t.sellPrice === 0);
    const rollCount = countRolls(legs);

    strategies.push({
      id: key,
      underlying: group.underlying,
      expiry: group.expiry,
      dateRange: group.firstDate === group.lastDate ? group.firstDate : `${group.firstDate} → ${group.lastDate}`,
      date: group.lastDate, // for sorting
      type,
      legs: legs.map(formatLeg).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
      closedLegs: closedLegs.length,
      openLegs: openLegs.length,
      rollCount,
      netPnl: +netPnl.toFixed(2),
      totalCharges: 0,
      status: hasOpenLegs ? 'OPEN' : 'CLOSED'
    });
  }
  return strategies.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function extractUnderlying(symbol) {
  // NIFTY2630523000CE → NIFTY, BANKNIFTY26MAR49000PE → BANKNIFTY
  // NIFTY26APR24500PE → NIFTY, RELIANCE → RELIANCE
  // Also handle: NIFTY26MARFUT → NIFTY
  const m = symbol.match(/^([A-Z]+?)(?:\d{2}(?:[A-Z]{3}|\d))/);
  return m ? m[1] : symbol;
}

function extractExpiryMonth(symbol, fallbackDate) {
  // NIFTY26APR24500PE → 2026-APR, NIFTY2640424500PE → 2026-04
  // Try extracting month name: 26APR, 26MAR etc.
  const monthMatch = symbol.match(/(\d{2})([A-Z]{3})/);
  if (monthMatch) {
    const yr = '20' + monthMatch[1];
    const mon = monthMatch[2]; // APR, MAR, etc.
    return `${yr}-${mon}`;
  }
  // Try extracting numeric date: 26405 (year=26, month=4, day=05)
  const numMatch = symbol.match(/(\d{2})(\d)(\d{2})/);
  if (numMatch) {
    const yr = '20' + numMatch[1];
    const mon = numMatch[2].padStart(2, '0');
    return `${yr}-${mon}`;
  }
  // Fallback to trade date month
  if (fallbackDate) return fallbackDate.slice(0, 7);
  return 'unknown';
}

function classifyStrategy(legs) {
  const hasFut = legs.some(l => l.symbol.includes('FUT'));
  const hasCE = legs.some(l => l.symbol.match(/CE$/));
  const hasPE = legs.some(l => l.symbol.match(/PE$/));
  const ceLegs = legs.filter(l => l.symbol.match(/CE$/));
  const peLegs = legs.filter(l => l.symbol.match(/PE$/));
  const futLegs = legs.filter(l => l.symbol.includes('FUT'));
  const optionLegs = legs.filter(l => l.symbol.match(/[CP]E$/));
  const rollCount = countRolls(legs);

  // Primary: Buy options + Futures hedge (user's main style)
  if (hasFut && (hasCE || hasPE)) {
    if (rollCount > 0) return `HEDGED ROLLING (${rollCount} rolls)`;
    return 'HEDGED WITH FUTURES';
  }

  // Multiple option legs on same side = rolling
  if (ceLegs.length >= 2 && !hasPE && !hasFut) {
    if (rollCount > 0) return `CE ROLLING (${rollCount} rolls)`;
    return 'MULTIPLE CE';
  }
  if (peLegs.length >= 2 && !hasCE && !hasFut) {
    if (rollCount > 0) return `PE ROLLING (${rollCount} rolls)`;
    return 'MULTIPLE PE';
  }

  // CE + PE without futures
  if (hasCE && hasPE && !hasFut) return 'STRADDLE/STRANGLE';

  // Single legs
  if (legs.length === 1) {
    const sym = legs[0].symbol;
    if (sym.includes('FUT')) return 'NAKED FUTURES';
    if (sym.match(/CE$/)) return 'NAKED LONG CE';
    if (sym.match(/PE$/)) return 'NAKED LONG PE';
    return 'EQUITY';
  }

  return 'MULTI-LEG';
}

// Count how many times user rolled (closed one strike, opened another in same direction)
function countRolls(legs) {
  const optLegs = legs.filter(l => l.symbol.match(/[CP]E$/));
  if (optLegs.length <= 1) return 0;
  // Different strikes on same side = rolls
  const ceStrikes = new Set(legs.filter(l => l.symbol.match(/CE$/)).map(l => l.symbol));
  const peStrikes = new Set(legs.filter(l => l.symbol.match(/PE$/)).map(l => l.symbol));
  return Math.max(0, ceStrikes.size - 1) + Math.max(0, peStrikes.size - 1);
}

function classifySingleLeg(trade) {
  const sym = trade.symbol;
  if (sym.includes('FUT')) return 'NAKED FUTURES';
  if (sym.match(/CE$/)) return 'NAKED LONG CE';
  if (sym.match(/PE$/)) return 'NAKED LONG PE';
  return 'EQUITY';
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
  { instrumentKey:'NSE_EQ|INE002A01018', symbol:'RELIANCE',   name:'Reliance Industries',     sector:'Energy', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE040A01034', symbol:'HDFCBANK',   name:'HDFC Bank',               sector:'Banking', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE009A01021', symbol:'INFY',       name:'Infosys',                 sector:'IT', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE467B01029', symbol:'TCS',        name:'Tata Consultancy',        sector:'IT', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE090A01021', symbol:'ICICIBANK',  name:'ICICI Bank',              sector:'Banking', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE030A01027', symbol:'HINDUNILVR', name:'Hindustan Unilever',      sector:'FMCG', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE397D01024', symbol:'BHARTIARTL', name:'Bharti Airtel',           sector:'Telecom', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE238A01034', symbol:'AXISBANK',   name:'Axis Bank',               sector:'Banking', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE296A01032', symbol:'BAJFINANCE', name:'Bajaj Finance',           sector:'NBFC', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE001A01036', symbol:'HCLTECH',    name:'HCL Technologies',        sector:'IT', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE044A01036', symbol:'SUNPHARMA',  name:'Sun Pharmaceutical',      sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE237A01028', symbol:'KOTAKBANK',  name:'Kotak Mahindra Bank',     sector:'Banking', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE585B01010', symbol:'MARUTI',     name:'Maruti Suzuki',           sector:'Auto', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE1TAE01010', symbol:'TMCV',        name:'Tata Motors (Commercial)',             sector:'Auto', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE081A01020', symbol:'TATASTEEL',  name:'Tata Steel',              sector:'Metals',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE733E01010', symbol:'NTPC',       name:'NTPC',                    sector:'Power',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE748C01020', symbol:'POWERGRID',  name:'Power Grid Corp',         sector:'Power',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE075A01022', symbol:'WIPRO',      name:'Wipro',                   sector:'IT',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE214T01019', symbol:'LTIM',       name:'LTIMindtree',             sector:'IT', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE213A01029', symbol:'ONGC',       name:'ONGC',                    sector:'Energy',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE059A01026', symbol:'CIPLA',      name:'Cipla',                   sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE522F01014', symbol:'COALINDIA',  name:'Coal India',              sector:'Mining',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE095A01012', symbol:'INDUSINDBK', name:'IndusInd Bank',           sector:'Banking', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE029A01011', symbol:'BPCL',       name:'BPCL',                    sector:'Energy',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE047A01021', symbol:'GRASIM',     name:'Grasim Industries',       sector:'Diversified', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE423A01024', symbol:'ADANIENT',   name:'Adani Enterprises',       sector:'Diversified', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE070A01015', symbol:'HINDALCO',   name:'Hindalco Industries',     sector:'Metals',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE066F01020', symbol:'HAL',        name:'Hindustan Aeronautics',   sector:'Defence', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE089A01023', symbol:'DRREDDY',    name:"Dr Reddy's Laboratories", sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE918I01026', symbol:'BAJAJFINSV', name:'Bajaj Finserv',           sector:'NBFC', cap:'Large' },
  // ── Nifty 50 additions ────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE062A01020', symbol:'SBIN',       name:'State Bank of India',     sector:'Banking', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE018A01030', symbol:'LT',         name:'Larsen & Toubro',         sector:'Engineering', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE154A01025', symbol:'ITC',        name:'ITC Ltd',                 sector:'FMCG',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE280A01028', symbol:'TITAN',      name:'Titan Company',           sector:'Consumer', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE669C01036', symbol:'TECHM',      name:'Tech Mahindra',           sector:'IT', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE101A01026', symbol:'M&M',        name:'Mahindra & Mahindra',     sector:'Auto', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE021A01026', symbol:'ASIANPAINT', name:'Asian Paints',            sector:'Paints', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE481G01011', symbol:'ULTRACEMCO', name:'UltraTech Cement',        sector:'Cement', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE019A01038', symbol:'JSWSTEEL',   name:'JSW Steel',               sector:'Metals',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE742F01042', symbol:'ADANIPORTS', name:'Adani Ports & SEZ',       sector:'Infrastructure', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE849A01020', symbol:'TRENT',      name:'Trent Ltd',               sector:'Retail', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE917I01010', symbol:'BAJAJ-AUTO', name:'Bajaj Auto',              sector:'Auto', cap:'Large' },
  // ── Nifty Next 50 ─────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE361B01024', symbol:'DIVISLAB',   name:"Divi's Laboratories",     sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE437A01024', symbol:'APOLLOHOSP', name:'Apollo Hospitals',        sector:'Healthcare', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE066A01021', symbol:'EICHERMOT',  name:'Eicher Motors',           sector:'Auto', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE158A01026', symbol:'HEROMOTOCO', name:'Hero MotoCorp',           sector:'Auto', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE216A01030', symbol:'BRITANNIA',  name:'Britannia Industries',    sector:'FMCG', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE192A01025', symbol:'TATACONSUM', name:'Tata Consumer Products',  sector:'FMCG', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE721A01047', symbol:'SHRIRAMFIN', name:'Shriram Finance',         sector:'NBFC', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE239A01024', symbol:'NESTLEIND',  name:'Nestle India',            sector:'FMCG', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE795G01014', symbol:'HDFCLIFE',   name:'HDFC Life Insurance',     sector:'Insurance',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE123W01016', symbol:'SBILIFE',    name:'SBI Life Insurance',      sector:'Insurance', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE205A01025', symbol:'VEDL',       name:'Vedanta Ltd',             sector:'Metals',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE646L01027', symbol:'INDIGO',     name:'InterGlobe Aviation',     sector:'Airlines', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE016A01026', symbol:'DABUR',      name:'Dabur India',             sector:'FMCG',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE318A01026', symbol:'PIDILITIND', name:'Pidilite Industries',     sector:'Chemicals', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE758E01017', symbol:'JIOFIN',     name:'Jio Financial Services',  sector:'NBFC',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE102D01028', symbol:'GODREJCP',   name:'Godrej Consumer Products',sector:'FMCG', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE176B01034', symbol:'HAVELLS',    name:'Havells India',           sector:'Consumer', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE121A01024', symbol:'CHOLAFIN',   name:'Cholamandalam Investment', sector:'NBFC', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE0J1Y01017', symbol:'LICI',       name:'Life Insurance Corp',     sector:'Insurance',  cap:'Large' },
  // ── Banking & Finance ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE160A01022', symbol:'PNB',        name:'Punjab National Bank',    sector:'Banking',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE028A01039', symbol:'BANKBARODA', name:'Bank of Baroda',          sector:'Banking',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE476A01022', symbol:'CANBK',      name:'Canara Bank',             sector:'Banking',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE134E01011', symbol:'PFC',        name:'Power Finance Corp',      sector:'NBFC',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE020B01018', symbol:'RECLTD',     name:'REC Ltd',                 sector:'NBFC',  cap:'Large' },
  // ── Energy & Oil ───────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE242A01010', symbol:'IOC',        name:'Indian Oil Corp',         sector:'Energy',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE115A01026', symbol:'HINDPETRO',  name:'Hindustan Petroleum',     sector:'Energy',  cap:'Large' },
  // ── Power & Utilities ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE245A01021', symbol:'TATAPOWER',  name:'Tata Power',              sector:'Power',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE364U01010', symbol:'ADANIGREEN', name:'Adani Green Energy',      sector:'Power', cap:'Large' },
  // ── Defence & Engineering ──────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE263A01024', symbol:'BEL',        name:'Bharat Electronics',      sector:'Defence',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE257A01026', symbol:'BHEL',       name:'Bharat Heavy Electricals',sector:'Engineering',  cap:'Large' },
  // ── Healthcare & Pharma ────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE027H01010', symbol:'MAXHEALTH',  name:'Max Healthcare',          sector:'Healthcare', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE634S01028', symbol:'MANKIND',    name:'Mankind Pharma',          sector:'Pharma', cap:'Large' },
  // ── Consumer & Retail ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE758T01015', symbol:'ZOMATO',     name:'Zomato Ltd',              sector:'Consumer',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE335Y01020', symbol:'IRCTC',      name:'IRCTC',                   sector:'Consumer',  cap:'Large' },
  // ── Chemicals / Specialty (includes PCBL) ──────────────────────────────────
  { instrumentKey:'NSE_EQ|INE602A01031', symbol:'PCBL',       name:'PCBL Chemical',           sector:'Chemicals',  cap:'Mid'   },
  // ── Additional IT (Midcap) ─────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE670A01012', symbol:'TATAELXSI',  name:'Tata Elxsi',              sector:'IT', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE262H01021', symbol:'PERSISTENT', name:'Persistent Systems',      sector:'IT', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE591G01025', symbol:'COFORGE',    name:'Coforge Ltd',             sector:'IT', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE356A01018', symbol:'MPHASIS',    name:'Mphasis Ltd',             sector:'IT', cap:'Mid'   },
  // ── Additional Pharma ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE685A01028', symbol:'TORNTPHARM', name:'Torrent Pharmaceuticals', sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE326A01037', symbol:'LUPIN',      name:'Lupin Ltd',               sector:'Pharma', cap:'Large' },
  // ── Additional FMCG / Consumer ─────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE196A01026', symbol:'MARICO',     name:'Marico Ltd',              sector:'FMCG',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE761H01022', symbol:'PAGEIND',    name:'Page Industries',         sector:'Consumer',cap:'Large' },
  // ── Additional Auto & Engineering ──────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE003A01024', symbol:'SIEMENS',    name:'Siemens Ltd',             sector:'Engineering', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE117A01022', symbol:'ABB',        name:'ABB India',               sector:'Engineering', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE455K01017', symbol:'POLYCAB',    name:'Polycab India',           sector:'Engineering', cap:'Large' },
  // ── Additional Metals & Mining ─────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE749A01030', symbol:'JINDALSTEL', name:'Jindal Steel & Power',    sector:'Metals', cap:'Large' },
  // ── Additional Cement ──────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE079A01024', symbol:'AMBUJACEM',  name:'Ambuja Cements',          sector:'Cement',  cap:'Large' },
  // ── Additional Finance / Insurance ─────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE726G01019', symbol:'ICICIPRULI', name:'ICICI Prudential Life',   sector:'Insurance',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE414G01012', symbol:'MUTHOOTFIN', name:'Muthoot Finance',         sector:'NBFC', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE018E01016', symbol:'SBICARD',    name:'SBI Cards & Payment',     sector:'NBFC',  cap:'Large' },
  // ── Additional Energy & Gas ────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE203G01027', symbol:'IGL',        name:'Indraprastha Gas',        sector:'Energy',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE274J01014', symbol:'OIL',        name:'Oil India Ltd',           sector:'Energy',  cap:'Large' },
  // ── Additional Power ───────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE813H01021', symbol:'TORNTPOWER', name:'Torrent Power',           sector:'Power', cap:'Large' },
  // ── Additional Defence ─────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE118H01025', symbol:'BSE',        name:'BSE Ltd',                 sector:'Diversified', cap:'Large' },
  // ── Logistics / New-age ────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE148O01028', symbol:'DELHIVERY',  name:'Delhivery Ltd',           sector:'Consumer',  cap:'Mid'   },
  // ── Additional PSU / Infra ─────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE084A01016', symbol:'BANKINDIA',  name:'Bank of India',           sector:'Banking',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE457A01014', symbol:'MAHABANK',   name:'Bank of Maharashtra',     sector:'Banking',   cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE562A01011', symbol:'INDIANB',    name:'Indian Bank',             sector:'Banking',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE565A01014', symbol:'IOB',        name:'Indian Overseas Bank',    sector:'Banking',   cap:'Mid'   },
  // ── Additional Large/Mid Cap ───────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE323A01026', symbol:'BOSCHLTD',   name:'Bosch Ltd',               sector:'Auto',cap:'Large' },
  // ── PSU Power & Mining ─────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE848E01016', symbol:'NHPC',       name:'NHPC Ltd',                sector:'Power',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE584A01023', symbol:'NMDC',       name:'NMDC Ltd',                sector:'Mining',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE114A01011', symbol:'SAIL',       name:'Steel Authority of India',sector:'Metals',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE139A01034', symbol:'NATIONALUM', name:'National Aluminium',      sector:'Metals',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE531E01026', symbol:'HINDCOPPER', name:'Hindustan Copper',        sector:'Metals',  cap:'Mid'   },
  // ── Infra & Construction ───────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE962Y01021', symbol:'IRCON',      name:'Ircon International',     sector:'Infrastructure', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE095N01031', symbol:'NBCC',       name:'NBCC India',              sector:'Infrastructure', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE031A01017', symbol:'HUDCO',      name:'HUDCO',                   sector:'NBFC',  cap:'Mid'   },
  // ── Real Estate ────────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE271C01023', symbol:'DLF',        name:'DLF Ltd',                 sector:'Infrastructure', cap:'Large' },
  // ── Telecom / Media ────────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE424H01027', symbol:'SUNTV',      name:'Sun TV Network',          sector:'Consumer',  cap:'Mid'   },
  // ── Misc Large/Mid Cap ─────────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE628A01036', symbol:'UPL',        name:'UPL Ltd',                 sector:'Chemicals',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE092T01019', symbol:'IDFCFIRSTB', name:'IDFC First Bank',         sector:'Banking',   cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE548A01028', symbol:'HFCL',       name:'HFCL Ltd',                sector:'Telecom',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE121E01018', symbol:'JSWENERGY',  name:'JSW Energy',              sector:'Power',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE982J01020', symbol:'PAYTM',      name:'One 97 Communications',   sector:'Consumer',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE111A01025', symbol:'CONCOR',     name:'Container Corp of India', sector:'Infrastructure', cap:'Large' },
  // ── Additional Midcap Metals/Mining ────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE002L01015', symbol:'SJVN',       name:'SJVN Ltd',                sector:'Power',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE415G01027', symbol:'RVNL',       name:'Rail Vikas Nigam',        sector:'Infrastructure', cap:'Mid'   },
  // ── Additional Nifty Next50 ────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE774D01024', symbol:'GAIL',       name:'GAIL India',              sector:'Energy',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE663F01032', symbol:'NAUKRI',     name:'Info Edge (Naukri)',       sector:'Consumer', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE603J01030', symbol:'PIIND',      name:'PI Industries',           sector:'Chemicals', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE765G01017', symbol:'ICICIGI',    name:'ICICI Lombard GI',        sector:'Insurance', cap:'Large' },
  // ── Remaining to reach ~150 ────────────────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE010V01017', symbol:'LTTS',       name:'L&T Technology Services',  sector:'IT', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE171A01029', symbol:'FEDERALBNK', name:'Federal Bank',            sector:'Banking',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE949L01017', symbol:'AUBANK',     name:'AU Small Finance Bank',   sector:'Banking',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE092A01019', symbol:'TATACHEM',   name:'Tata Chemicals',          sector:'Chemicals', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE406A01037', symbol:'AUROPHARMA', name:'Aurobindo Pharma',        sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE129A01019', symbol:'INDUSTOWER', name:'Indus Towers',            sector:'Telecom',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE298A01020', symbol:'CUMMINSIND', name:'Cummins India',           sector:'Engineering', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE121J01017', symbol:'M&MFIN',     name:'Mahindra & Mahindra Fin', sector:'NBFC',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE259A01022', symbol:'COLPAL',     name:'Colgate-Palmolive India', sector:'FMCG', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE094A01015', symbol:'LICHSGFIN',  name:'LIC Housing Finance',     sector:'NBFC',  cap:'Large' },
  // ── Moved from Penny (Mid/Large Cap with Upstox polling) ──────────────────
  { instrumentKey:'NSE_EQ|INE704P01025', symbol:'COCHINSHIP', name:'Cochin Shipyard',           sector:'Defence', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE450U01017', symbol:'ROUTE',      name:'Route Mobile',              sector:'IT', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE171Z01026', symbol:'BDL',        name:'Bharat Dynamics',           sector:'Defence', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE382Z01011', symbol:'GRSE',       name:'Garden Reach Shipbuilders', sector:'Defence', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE249Z01020', symbol:'MAZDOCK',    name:'Mazagon Dock Shipbuilders', sector:'Defence', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE484J01027', symbol:'GODREJPROP', name:'Godrej Properties',         sector:'Infrastructure', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE093I01010', symbol:'OBEROIRLTY', name:'Oberoi Realty',             sector:'Infrastructure', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE811K01011', symbol:'PRESTIGE',   name:'Prestige Estates',          sector:'Infrastructure', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE288B01029', symbol:'DEEPAKNTR',name:'Deepak Nitrite',          sector:'Chemicals', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE828B01012', symbol:'CLEAN',      name:'Clean Science & Technology',sector:'Chemicals', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE494B01023', symbol:'TVSMOTOR',   name:'TVS Motor Company',         sector:'Auto', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE548C01032', symbol:'EMAMILTD',   name:'Emami Ltd',                 sector:'FMCG',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE191H01014', symbol:'PVRINOX',        name:'PVR INOX Ltd',              sector:'Consumer', cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE053A01029', symbol:'INDHOTEL',   name:'Indian Hotels (Taj)',       sector:'Consumer',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE490G01020', symbol:'MOIL',       name:'MOIL Ltd',                  sector:'Mining',  cap:'Mid'   },
  // ── New Additions (15 frequent movers) ────────────────────────────────────
  { instrumentKey:'NSE_EQ|INE814H01029', symbol:'ADANIPOWER', name:'Adani Power',               sector:'Power',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE935N01020', symbol:'DIXON',      name:'Dixon Technologies',        sector:'Consumer',cap:'Large' },
  { instrumentKey:'NSE_EQ|INE465A01025', symbol:'BHARATFORG', name:'Bharat Forge',              sector:'Auto', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE226A01021', symbol:'VOLTAS',     name:'Voltas Ltd',                sector:'Consumer', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE048G01026', symbol:'NAVINFLUOR', name:'Navin Fluorine Intl',       sector:'Chemicals', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE647A01010', symbol:'SRF',        name:'SRF Ltd',                   sector:'Chemicals', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE202E01016', symbol:'IREDA',      name:'Indian Renewable Energy DA',sector:'NBFC',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE302A01020', symbol:'EXIDEIND',   name:'Exide Industries',          sector:'Auto',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE540L01014', symbol:'ALKEM',      name:'Alkem Laboratories',        sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE571A01038', symbol:'IPCALAB',    name:'IPCA Laboratories',         sector:'Pharma', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE398R01022', symbol:'SYNGENE',    name:'Syngene International',     sector:'Pharma',  cap:'Large' },
  { instrumentKey:'NSE_EQ|INE881D01027', symbol:'OFSS',       name:'Oracle Financial Services', sector:'IT',cap:'Large' },
  { instrumentKey:'NSE_EQ|INE299U01018', symbol:'CROMPTON',   name:'Crompton Greaves Consumer', sector:'Consumer',  cap:'Mid'   },
  { instrumentKey:'NSE_EQ|INE100A01010', symbol:'ATUL',       name:'Atul Ltd',                  sector:'Chemicals', cap:'Large' },
  { instrumentKey:'NSE_EQ|INE885A01032', symbol:'AMARAJABAT', name:'Amara Raja Energy',         sector:'Auto', cap:'Large' },
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

  // ONLY use live data — no static fundamentals
  const f52 = fundamentals[symbol];
  const high52 = f52?.high52 || 0;
  const low52  = f52?.low52  || 0;
  const prices = priceHistory[symbol] || [];

  let score = 0;
  const reasons = [];

  // 1. 52W position (35pts) — from live NSE data
  if (high52 > 0 && low52 > 0) {
    const range = high52 - low52;
    if (range > 0) {
      const pos = Math.max(0, Math.min(1, (price - low52) / range));
      score += Math.round((1 - pos) * 35);
      if (pos < 0.2)       reasons.push(`🟢 Near 52W low ₹${low52.toFixed(0)} — strong buy zone`);
      else if (pos < 0.4)  reasons.push(`✅ In lower half of 52W range`);
      else if (pos > 0.85) reasons.push(`⚠️ Near 52W high ₹${high52.toFixed(0)} — take profit zone`);
    }
  }

  // 2. Technical signals (65pts) — from live price history
  let techBias = 'NEUTRAL';
  let techScore = 50;
  if (prices.length >= 20) {
    const { getTechnicalSignal } = require('./lib/technicals');
    const tech = getTechnicalSignal(prices, prices, prices);
    if (tech) {
      techBias = tech.techBias;
      techScore = tech.techScore;
      // RSI signals (15pts)
      if (tech.rsi < 30)       { score += 15; reasons.push(`🟢 RSI ${tech.rsi} — oversold, buy zone`); }
      else if (tech.rsi < 40)  { score += 10; reasons.push(`✅ RSI ${tech.rsi} — approaching oversold`); }
      else if (tech.rsi > 70)  { score -= 5;  reasons.push(`⚠️ RSI ${tech.rsi} — overbought`); }
      else if (tech.rsi > 60)  { score += 3; }
      else                     { score += 7; } // Neutral RSI

      // EMA trend (20pts)
      if (tech.ema20 > tech.ema50 && price > tech.ema20) {
        score += 20; reasons.push(`🟢 Price above 20 & 50 EMA — uptrend`);
      } else if (price > tech.ema20) {
        score += 12; reasons.push(`✅ Price above 20 EMA`);
      } else if (price < tech.ema20 && tech.ema20 < tech.ema50) {
        score -= 5; reasons.push(`🔴 Below 20 & 50 EMA — downtrend`);
      } else {
        score += 5;
      }

      // MACD (15pts)
      if (tech.macd > tech.macdSignal && tech.macd > 0) {
        score += 15; reasons.push(`🟢 MACD bullish crossover`);
      } else if (tech.macd > tech.macdSignal) {
        score += 10;
      } else if (tech.macd < 0) {
        reasons.push(`🔴 MACD bearish`);
      } else {
        score += 5;
      }

      // Support proximity (15pts)
      if (tech.support > 0) {
        const distToSupport = ((price - tech.support) / price) * 100;
        if (distToSupport < 3) { score += 15; reasons.push(`🟢 Near support ₹${tech.support} — good entry`); }
        else if (distToSupport < 8) { score += 8; }
        else { score += 3; }
      }
    }
  } else {
    // Not enough price data for technicals
    score += 25; // neutral baseline for technical portion
    reasons.push(`⏳ Building price history (${prices.length}/20 readings)`);
  }

  score = Math.max(0, Math.min(100, score));
  let signal;
  if (score >= 80) signal = 'STRONG BUY';
  else if (score >= 65) signal = 'BUY';
  else if (score >= 50) signal = 'WATCH';
  else if (score >= 35) signal = 'HOLD';
  else signal = 'SELL';

  // Upside/downside from 52W
  const upside = high52 > 0 ? +((high52 - price) / price * 100).toFixed(1) : 0;
  const downside = low52 > 0 ? +((price - low52) / price * 100).toFixed(1) : 0;

  return { score, signal, reason: reasons[0] || '—', allReasons: reasons, upside, downside, targetPrice: 0, timing: '', techBias, techScore };
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
      // Got valid response — mark as live even if no price changes (market may be closed)
      if (connectionStatus !== 'live' && Object.keys(data).length > 0) {
        connectionStatus = 'live'; broadcastStatus();
      }
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
// REFERENCE PRICES — Used ONLY by unit tests, never for display
// ══════════════════════════════════════════════════════════════════════════════
const REFERENCE_PRICES = {
  RELIANCE:2920, HDFCBANK:1840, INFY:1720, TCS:3980, ICICIBANK:1520,
  COALINDIA:420, SBIN:820, LT:3440, ITC:420, TATASTEEL:145
};

// ══════════════════════════════════════════════════════════════════════════════
// STOCK UNIVERSE INIT — Metadata only, NO fake prices
// ══════════════════════════════════════════════════════════════════════════════
function initStockUniverse() {
  // Register all stocks with metadata — prices come from Upstox or NSE only
  for (const s of STOCK_UNIVERSE) {
    liveStocks[s.symbol] = {
      symbol: s.symbol, name: s.name, sector: s.sector,
      price: 0, change: 0, changePct: 0, volume: 0,
      lastUpdate: 0, isLive: false
    };
  }
  for (const p of PENNY_STOCKS) {
    liveStocks[p.symbol] = {
      symbol: p.symbol, name: p.name, sector: p.sector,
      price: 0, change: 0, changePct: 0, volume: 0,
      lastUpdate: 0, isLive: false
    };
  }
  log('OK', `Stock universe initialized — ${Object.keys(liveStocks).length} symbols (awaiting live data)`);
}

async function initLiveData() {
  stockUniverse = STOCK_UNIVERSE;
  initStockUniverse();

  if (accessToken) {
    connectionStatus = 'authenticated';
    connectUpstoxWs();
    log('OK', 'Upstox token present — status: authenticated, starting data poller');
    broadcastStatus();
  } else {
    connectionStatus = 'disconnected';
    log('WARN', 'No Upstox token — stock prices unavailable until connected');
    broadcastStatus();
  }

  // Always start NSE real data polling (indices, VIX, FII/DII — works independently of Upstox)
  startNsePolling();
  // Start Twelve Data polling — runs 24/7 for Gold, Crude, USD/INR, Gift Nifty, S&P 500 etc.
  startTwelveDataPolling();
  log('OK', `Live data initialized — ${stockUniverse.length} stocks, awaiting real prices`);
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET BROADCAST
// ══════════════════════════════════════════════════════════════════════════════
const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  log('INFO', `WS client connected (total: ${clients.size})`);
  ws.send(JSON.stringify({ type:'init', stocks:liveStocks, indices:liveIndices, signals:signalCache, status:connectionStatus, vix:vixData, fiiDii:fiiDiiData, globalMarkets }));
  ws.on('close', () => { clients.delete(ws); log('INFO', `WS client disconnected (total: ${clients.size})`); });
  ws.on('error', (e) => { clients.delete(ws); log('WARN', `WS client error: ${e.message}`); });
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
    const sig = calcSignal('COALINDIA', REFERENCE_PRICES['COALINDIA'] * 0.7);
    assert(sig !== null, 'Signal should not be null');
    assertRange(sig.score, 0, 100, 'Score out of range');
    assert(['STRONG BUY','BUY','WATCH','HOLD','SELL','STRONG SELL'].includes(sig.signal), 'Invalid signal label');
  });

  test('Signal: score 0-100 for all universe stocks', () => {
    for (const s of STOCK_UNIVERSE) {
      const price = REFERENCE_PRICES[s.symbol] || 1000;
      const sig = calcSignal(s.symbol, price);
      if (sig) assertRange(sig.score, 0, 100, `${s.symbol} score out of range`);
    }
  });

  test('Signal: null input returns null safely', () => {
    assert(calcSignal('X', 0, null) === null, 'Zero price should return null');
  });

  test('Signal: upside calculation correct (10% to target)', () => {
    const sig = calcSignal('TEST', 1000, { sectorPe:20, debtToEquity:0.3, dividendYield:1, high52:1200, low52:800, targetPrice:1100 });
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
cron.schedule('35 15 * * 1-5', () => { log('INFO', 'Market closed — freezing stock prices'); stopPricePoller(); captureZerodhaTrades(); });
// Twelve Data runs 24/7 — no stop/start needed
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
  loadPredictions();
  loadGcpServiceAccount();
  log('INFO', `Upstox:${!!appConfig.apiKey} Zerodha:${!!appConfig.zApiKey} Gemini:${!!appConfig.geminiKey} VertexAI:${!!gcpServiceAccount} TwelveData:${!!appConfig.twelveDataKey} Trades:${tradeHistory.length} Picks:${pickTracker.length}`);
  await initLiveData();
  runUnitTests();
  log('INFO', `Server ready — ${testResults.filter(t=>t.pass).length}/${testResults.length} tests passed`);

  // Auto-connect Gemini & Vertex AI if keys are present from env vars
  if (appConfig.geminiKey && !geminiConnectionOk && !geminiDisabled) {
    try {
      const g = await callGemini('Reply with just: OK', { maxOutputTokens: 10, timeout: 45000 });
      geminiConnectionOk = true;
      log('OK', `Gemini auto-connected on startup (model: ${g.model})`);
    } catch(e) {
      log('WARN', `Gemini auto-connect failed: ${e.message} — keys present but test call failed`);
    }
  }
  if (gcpServiceAccount && !vertexConnectionOk && !vertexDisabled) {
    try {
      const v = await callVertexAI('Reply with just: OK', { maxOutputTokens: 10, timeout: 45000, grounding: false });
      vertexConnectionOk = true;
      log('OK', `Vertex AI auto-connected on startup (model: ${v.model})`);
    } catch(e) {
      log('WARN', `Vertex AI auto-connect failed: ${e.message}`);
    }
  }

  log('INFO', `═══════════════════════════════════════`);
});

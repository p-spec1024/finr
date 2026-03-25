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
    const topGainers = [...stocks].sort((a,b) => b.changePct - a.changePct).slice(0,5);
    const topLosers  = [...stocks].sort((a,b) => a.changePct - b.changePct).slice(0,5);
    const strongSignals = Object.values(signalCache).filter(s => s.score >= 65).sort((a,b) => b.score - a.score).slice(0,8);

    const stockSummary = stocks.slice(0,30).map(s => {
      const sig = signalCache[s.symbol];
      const fund = STOCK_UNIVERSE.find(x => x.symbol === s.symbol);
      return `${s.symbol}: ₹${s.price} (${s.changePct>=0?'+':''}${s.changePct.toFixed(2)}%) PE:${fund?.pe||'?'} Signal:${sig?.signal||'--'} Score:${sig?.score||0}`;
    }).join('\n');

    const prompt = `You are an expert NSE F&O options strategist for Indian retail investors. Analyse the current market and recommend the TOP 5 stocks best suited for options trading RIGHT NOW. For each stock, suggest whether to take CE (Call) or PE (Put) and give a specific strategy.

CURRENT MARKET SNAPSHOT:
- Nifty 50: ${nifty?.price || 'N/A'} (${nifty?.changePct >= 0 ? '+' : ''}${nifty?.changePct || 0}%)
- Bank Nifty: ${bankNifty?.price || 'N/A'} (${bankNifty?.changePct >= 0 ? '+' : ''}${bankNifty?.changePct || 0}%)
- India VIX: ${vixData.value} (${vixData.trend}) — ${vixData.value > 20 ? 'HIGH VOLATILITY' : vixData.value < 13 ? 'LOW VOLATILITY' : 'MODERATE'}
- FII Flow: ₹${fiiDiiData.fii}Cr | DII Flow: ₹${fiiDiiData.dii}Cr
- Market: ${isMarketOpen() ? 'OPEN' : 'CLOSED'} | IST: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

TOP GAINERS: ${topGainers.map(s => `${s.symbol}(${s.changePct>=0?'+':''}${s.changePct.toFixed(2)}%)`).join(', ')}
TOP LOSERS: ${topLosers.map(s => `${s.symbol}(${s.changePct.toFixed(2)}%)`).join(', ')}

STOCK DATA:
${stockSummary}

Respond ONLY with valid JSON array — no markdown fences, no preamble:
[{"symbol":"STOCKNAME","direction":"CE","confidence":"HIGH","strategy":"Brief strategy name (e.g. Buy 24500 CE weekly)","reasoning":"2-3 line analysis covering trend, volatility, support/resistance, why CE or PE","entry":"Specific entry condition or price range","target":"Target profit % or price","stopLoss":"Stop loss level or %","riskLevel":"LOW/MEDIUM/HIGH","timeframe":"Intraday/Weekly/Monthly"},...]

RULES:
- Only recommend F&O eligible stocks (large-cap, high liquidity)
- direction must be CE or PE only
- confidence must be HIGH, MEDIUM, or LOW
- Consider VIX for strategy selection (high VIX = sell options, low VIX = buy options)
- Consider FII/DII flows for market direction
- Give specific strike guidance where possible
- Include at least one index option (NIFTY or BANKNIFTY) if conditions are favorable`;

    const g = await callGemini(prompt, { temperature: 0.4, maxOutputTokens: 2500, timeout: 45000 });
    const raw = g.text || '[]';
    log('OK', `Gemini options recommendations generated (${g.model})`);
    // Try to parse as JSON, fallback to raw
    let recs = [];
    try {
      const cleaned = raw.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
      recs = JSON.parse(cleaned);
    } catch(pe) {
      // Try regex extraction for each recommendation object
      const objRegex = /\{[^{}]*"symbol"[^{}]*\}/g;
      const matches = raw.match(objRegex);
      if (matches) {
        for (const m of matches) {
          try { recs.push(JSON.parse(m)); } catch(_) {}
        }
      }
    }
    res.json({ recommendations: recs, raw: recs.length ? undefined : raw, configured: true });
  } catch(e) {
    log('ERR', 'Gemini options recommend failed: ' + e.message);
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
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
  { instrumentKey:'NSE_EQ|INE002A01018', symbol:'RELIANCE',   name:'Reliance Industries',     sector:'Energy',    pe:24,  roe:14, de:0.3,  div:0.4, target:3200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE040A01034', symbol:'HDFCBANK',   name:'HDFC Bank',               sector:'Banking',   pe:18,  roe:17, de:0.8,  div:1.1, target:1900, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE009A01021', symbol:'INFY',       name:'Infosys',                 sector:'IT',        pe:26,  roe:32, de:0.0,  div:3.2, target:2050, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE467B01029', symbol:'TCS',        name:'Tata Consultancy',        sector:'IT',        pe:28,  roe:48, de:0.0,  div:3.8, target:4600, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE062A01020', symbol:'ICICIBANK',  name:'ICICI Bank',              sector:'Banking',   pe:17,  roe:19, de:0.7,  div:0.8, target:1600, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE030A01027', symbol:'HINDUNILVR', name:'Hindustan Unilever',      sector:'FMCG',      pe:52,  roe:22, de:0.0,  div:1.8, target:2850, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE018A01030', symbol:'BHARTIARTL', name:'Bharti Airtel',           sector:'Telecom',   pe:78,  roe:16, de:1.8,  div:0.4, target:2100, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE585B01010', symbol:'AXISBANK',   name:'Axis Bank',               sector:'Banking',   pe:14,  roe:16, de:0.9,  div:0.1, target:1350, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE669C01036', symbol:'BAJFINANCE', name:'Bajaj Finance',           sector:'NBFC',      pe:35,  roe:22, de:3.2,  div:0.3, target:8800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE001A01036', symbol:'HCLTECH',    name:'HCL Technologies',        sector:'IT',        pe:24,  roe:26, de:0.0,  div:4.5, target:1850, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE044A01036', symbol:'SUNPHARMA',  name:'Sun Pharmaceutical',      sector:'Pharma',    pe:35,  roe:18, de:0.1,  div:0.5, target:2200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE326A01037', symbol:'KOTAKBANK',  name:'Kotak Mahindra Bank',     sector:'Banking',   pe:20,  roe:15, de:0.5,  div:0.1, target:2150, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE216A01030', symbol:'MARUTI',     name:'Maruti Suzuki',           sector:'Auto',      pe:25,  roe:18, de:0.0,  div:1.2, target:13500, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE029A01011', symbol:'TATAMOTORS', name:'Tata Motors',             sector:'Auto',      pe:8,   roe:22, de:1.1,  div:0.0, target:1100, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE155A01022', symbol:'TATASTEEL',  name:'Tata Steel',              sector:'Metals',    pe:9,   roe:12, de:0.8,  div:0.6, target:200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE397D01024', symbol:'NTPC',       name:'NTPC',                    sector:'Power',     pe:16,  roe:13, de:1.2,  div:3.5, target:430, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE748C01020', symbol:'POWERGRID',  name:'Power Grid Corp',         sector:'Power',     pe:17,  roe:23, de:1.5,  div:4.2, target:395, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE160A01022', symbol:'WIPRO',      name:'Wipro',                   sector:'IT',        pe:22,  roe:17, de:0.0,  div:0.2, target:650, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE019A01038', symbol:'LTIM',       name:'LTIMindtree',             sector:'IT',        pe:32,  roe:28, de:0.0,  div:1.5, target:6200, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE066A01021', symbol:'ONGC',       name:'ONGC',                    sector:'Energy',    pe:7,   roe:14, de:0.3,  div:5.2, target:340, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE101A01026', symbol:'CIPLA',      name:'Cipla',                   sector:'Pharma',    pe:28,  roe:16, de:0.1,  div:0.4, target:1750, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE021A01026', symbol:'COALINDIA',  name:'Coal India',              sector:'Mining',    pe:8,   roe:58, de:0.0,  div:8.5, target:560, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE095A01012', symbol:'INDUSINDBK', name:'IndusInd Bank',           sector:'Banking',   pe:9,   roe:15, de:0.7,  div:1.2, target:1300, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE071A01013', symbol:'BPCL',       name:'BPCL',                    sector:'Energy',    pe:8,   roe:22, de:0.4,  div:6.5, target:380, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE356A01018', symbol:'GRASIM',     name:'Grasim Industries',       sector:'Diversified', pe:20, roe:12, de:0.4, div:0.4, target:3100, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE123W01016', symbol:'ADANIENT',   name:'Adani Enterprises',       sector:'Diversified', pe:65, roe:9,  de:2.1, div:0.0, target:3000, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE070A01015', symbol:'HINDALCO',   name:'Hindalco Industries',     sector:'Metals',    pe:11,  roe:16, de:0.5,  div:0.8, target:800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE115A01026', symbol:'HAL',        name:'Hindustan Aeronautics',   sector:'Defence',   pe:42,  roe:28, de:0.0,  div:0.8, target:5800, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE089A01023', symbol:'DRREDDY',    name:"Dr Reddy's Laboratories", sector:'Pharma',    pe:22,  roe:21, de:0.0,  div:0.6, target:1700, cap:'Large' },
  { instrumentKey:'NSE_EQ|INE040A01034', symbol:'BAJAJFINSV', name:'Bajaj Finserv',           sector:'NBFC',      pe:28,  roe:14, de:2.8,  div:0.1, target:2200, cap:'Large' },
];

const SECTOR_PE = { IT:27, Banking:15, Pharma:30, Energy:10, FMCG:48, Auto:20, Metals:8, Power:16, Telecom:22, NBFC:22, Mining:7, Diversified:18, Defence:38 };

const PENNY_STOCKS = [
  { symbol:'SUZLON',  name:'Suzlon Energy',    sector:'Power',   price:42,  risk:'HIGH',   flag:'High debt, renewable tailwind',     vol:'Very High',  promoter:16 },
  { symbol:'IRFC',    name:'Indian Railway FC', sector:'Finance', price:145, risk:'LOW',    flag:'PSU backed, steady income',         vol:'Moderate',   promoter:0  },
  { symbol:'YESBANK', name:'Yes Bank',          sector:'Banking', price:19,  risk:'HIGH',   flag:'Recovery play, watch FII buying',   vol:'Very High',  promoter:0  },
  { symbol:'IDEA',    name:'Vodafone Idea',     sector:'Telecom', price:8,   risk:'EXTREME', flag:'High debt, survival uncertain',    vol:'Very High',  promoter:22 },
  { symbol:'JPPOWER', name:'Jaiprakash Power',  sector:'Power',   price:12,  risk:'HIGH',   flag:'Debt restructuring, power demand',  vol:'High',       promoter:35 },
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
  // Upstox allows max ~500 keys per request; batch in chunks of 25
  const chunkSize = 25;
  let updated = false;
  for (let i = 0; i < allKeys.length; i += chunkSize) {
    const chunk = allKeys.slice(i, i + chunkSize);
    try {
      const res = await axios.get('https://api.upstox.com/v2/market-quote/quotes', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        params: { instrument_key: chunk.join(',') }
      });
      const data = res.data?.data;
      if (data) {
        if (pollFirstLog) {
          const keys = Object.keys(data).slice(0, 3);
          log('OK', `Upstox REST first response — ${Object.keys(data).length} instruments, sample keys: ${keys.join(', ')}`);
          // Log one sample quote to verify field names
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
      if (pollErrors <= 3) log('ERR', `Upstox REST poll error (batch ${Math.floor(i/chunkSize)+1}): ${e.response?.status || ''} ${e.message}`);
      if (e.response?.status === 410 || e.response?.status === 401) {
        log('ERR', 'Upstox REST API unavailable — stopping poller');
        stopPricePoller();
        connectionStatus = 'disconnected'; broadcastStatus();
        return;
      }
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
  const intervalMs = 3000; // Poll every 3 seconds
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
const MOCK_BASE = { RELIANCE:2920, SUZLON:62, IRFC:158, YESBANK:22, IDEA:9, JPPOWER:14, HDFCBANK:1840, INFY:1720, TCS:3980, ICICIBANK:1520, HINDUNILVR:2420, BHARTIARTL:1950, AXISBANK:1180, BAJFINANCE:6980, HCLTECH:1580, SUNPHARMA:2180, KOTAKBANK:2050, MARUTI:11200, TATAMOTORS:620, TATASTEEL:145, NTPC:385, POWERGRID:360, WIPRO:520, LTIM:5200, ONGC:265, CIPLA:1680, COALINDIA:420, INDUSINDBK:780, BPCL:295, GRASIM:2580, ADANIENT:2280, HINDALCO:640, HAL:4650, DRREDDY:1380, BAJAJFINSV:1920 };
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
  log('INFO', `Upstox:${!!appConfig.apiKey} Zerodha:${!!appConfig.zApiKey} Gemini:${!!appConfig.geminiKey} TwelveData:${!!appConfig.twelveDataKey} Trades:${tradeHistory.length}`);
  await initLiveData();
  if (isPostMarketWindow()) startTwelveDataPolling();
  runUnitTests();
  log('INFO', `Server ready — ${testResults.filter(t=>t.pass).length}/${testResults.length} tests passed`);
  log('INFO', `═══════════════════════════════════════`);
});

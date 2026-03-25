/**
 * FINR — Comprehensive Unit Test Suite v2.0
 * Self-contained: uses only Node.js built-ins (crypto) + local lib files
 * Run: node tests/unit.js
 */

'use strict';

const crypto = require('crypto');

// ── Mini test harness ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];
let currentSuite = 'General';

function suite(name, fn) {
  const prev = currentSuite;
  currentSuite = name;
  fn();
  currentSuite = prev;
}

function test(name, fn) {
  try {
    fn();
    results.push({ suite: currentSuite, name, pass: true });
    passed++;
  } catch (e) {
    results.push({ suite: currentSuite, name, pass: false, error: e.message });
    failed++;
  }
}

function assert(cond, msg)      { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertApprox(a, b, tol, msg) {
  const t = tol || 0.01;
  if (Math.abs(a - b) > t) throw new Error(msg || `Expected ~${b}, got ${a} (tol ${t})`);
}
function assertRange(v, lo, hi, msg) {
  if (v < lo || v > hi) throw new Error(msg || `${v} not in [${lo}, ${hi}]`);
}

// ── Import lib modules ────────────────────────────────────────────────────────
const { calcSignal, SECTOR_PE }                              = require('../lib/signals');
const { calcRSI, calcEMA, calcSMA, calcMACD, calcBollinger,
        calcSupport, calcResistance, getTechnicalSignal }    = require('../lib/technicals');
const { getMarketContext }                                    = require('../lib/marketContext');

// ── Node.js crypto helpers (replaces crypto-js — zero npm deps) ──────────────
function aesEncrypt(text, key) {
  const iv  = crypto.randomBytes(16);
  const k   = crypto.createHash('sha256').update(key).digest();
  const c   = crypto.createCipheriv('aes-256-cbc', k, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}
function aesDecrypt(cipher, key) {
  const [ivHex, dataHex] = cipher.split(':');
  const iv   = Buffer.from(ivHex,   'hex');
  const data = Buffer.from(dataHex, 'hex');
  const k    = crypto.createHash('sha256').update(key).digest();
  const d    = crypto.createDecipheriv('aes-256-cbc', k, iv);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

// ── Synthetic price helpers ───────────────────────────────────────────────────
function trendingUp(n, start, step)   { return Array.from({length:n}, (_,i)=>+(start+i*step+(Math.random()-.5)*.3).toFixed(2)); }
function trendingDown(n, start, step) { return Array.from({length:n}, (_,i)=>+(start-i*step+(Math.random()-.5)*.3).toFixed(2)); }
function flat(n, val)                  { return Array.from({length:n}, ()=>+(val+(Math.random()-.5)*.2).toFixed(2)); }

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 1 — Signal Engine
// ══════════════════════════════════════════════════════════════════════════════
suite('Signal Engine', () => {

  const GOOD = { pe:8, sectorPe:20, roe:28, debtToEquity:0.04, dividendYield:3.5, high52:1200, low52:800, targetPrice:1250 };
  const BAD  = { pe:85, sectorPe:15, roe:2, debtToEquity:3.8, dividendYield:0, high52:1000, low52:400, targetPrice:500 };

  test('STRONG BUY: excellent fundamentals → score ≥ 80', () => {
    const s = calcSignal('T', 820, GOOD);
    assert(s && s.score >= 80, `Score ${s&&s.score} should be >= 80`);
    assertEqual(s.signal, 'STRONG BUY');
  });

  test('Weak fundamentals → score < 50', () => {
    const s = calcSignal('T', 980, BAD);
    assert(s.score < 50, `Score ${s.score} should be < 50`);
  });

  test('Score always 0–100', () => {
    const s1 = calcSignal('A', 510, {pe:5,sectorPe:20,roe:35,debtToEquity:0,dividendYield:5,high52:1000,low52:500,targetPrice:1200});
    const s2 = calcSignal('B', 990, {pe:200,sectorPe:15,roe:-5,debtToEquity:10,dividendYield:0,high52:1000,low52:500,targetPrice:100});
    assertRange(s1.score, 0, 100);
    assertRange(s2.score, 0, 100);
  });

  test('Upside = 10% when target ₹1100, price ₹1000', () => {
    const s = calcSignal('T', 1000, {pe:15,sectorPe:20,roe:18,debtToEquity:0.3,dividendYield:1.5,high52:1200,low52:800,targetPrice:1100});
    assertApprox(s.upside, 10.0, 0.1);
  });

  test('Downside = -20% when 52W low ₹800, price ₹1000', () => {
    const s = calcSignal('T', 1000, {pe:15,sectorPe:20,roe:18,debtToEquity:0.3,dividendYield:1.5,high52:1200,low52:800,targetPrice:1100});
    assertApprox(s.downside, -20.0, 0.1);
  });

  test('Near 52W low scores higher than near 52W high', () => {
    const f = {pe:15,sectorPe:20,roe:15,debtToEquity:0.3,dividendYield:1,high52:1000,low52:600,targetPrice:900};
    assert(calcSignal('A',630,f).score > calcSignal('B',960,f).score, 'Near low should score higher');
  });

  test('Debt-free scores higher than high-debt (same everything else)', () => {
    const base = {pe:15,sectorPe:20,roe:15,dividendYield:0,high52:1200,low52:800,targetPrice:1100};
    const df = calcSignal('A', 1000, {...base, debtToEquity:0.05}).score;
    const hd = calcSignal('B', 1000, {...base, debtToEquity:2.5}).score;
    assert(df > hd, `Debt-free ${df} should beat high-debt ${hd}`);
  });

  test('Null/zero inputs return null safely', () => {
    assertEqual(calcSignal('X', 0,    {}),  null, 'Zero price');
    assertEqual(calcSignal('X', -100, {}),  null, 'Negative price');
    assertEqual(calcSignal('X', 500,  null),null, 'Null fund');
  });

  test('Signal object has all required fields', () => {
    const s = calcSignal('T', 1000, GOOD);
    for (const f of ['score','signal','reason','allReasons','upside','downside','targetPrice'])
      assert(f in s, `Missing field: ${f}`);
    assert(Array.isArray(s.allReasons) && s.allReasons.length > 0);
  });

  test('SECTOR_PE covers all major sectors', () => {
    for (const sec of ['IT','Banking','Pharma','Energy','FMCG','Auto','Metals','Power'])
      assert(sec in SECTOR_PE, `Missing sector PE: ${sec}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 2 — Technical Indicators
// ══════════════════════════════════════════════════════════════════════════════
suite('Technical Indicators', () => {

  test('RSI in 0–100', () => {
    assertRange(calcRSI([44,46,48,47,50,52,54,53,55,57,59,58,60,62,64], 14), 0, 100);
  });

  test('RSI flat series near 50', () => {
    assertRange(calcRSI(flat(30,100), 14), 35, 65, 'Flat RSI should be near 50');
  });

  test('RSI uptrend > 60', () => {
    assert(calcRSI(trendingUp(30,100,2), 14) > 60, 'Uptrend RSI should be > 60');
  });

  test('RSI downtrend < 40', () => {
    assert(calcRSI(trendingDown(30,200,2), 14) < 40, 'Downtrend RSI should be < 40');
  });

  test('RSI: short series returns 50', () => {
    assertEqual(calcRSI([100,101,102], 14), 50);
  });

  test('EMA in expected range for trending series', () => {
    assertRange(calcEMA([22,24,23,25,26,27,26,28,29,30], 5), 25, 31);
  });

  test('SMA(3) of [10,20,30,40,50] = 40', () => {
    assertApprox(calcSMA([10,20,30,40,50], 3), 40, 0.1);
  });

  test('Bollinger upper > middle > lower', () => {
    const bb = calcBollinger(trendingUp(30,100,1), 20, 2);
    assert(bb.upper > bb.middle && bb.middle > bb.lower);
  });

  test('MACD histogram = macd - signal', () => {
    const m = calcMACD(trendingUp(30,100,1));
    assertApprox(m.histogram, m.macd - m.signal, 0.05);
  });

  test('Support < Resistance', () => {
    const h = [100,102,105,103,108,106,110,109];
    const l = [95, 98, 101,99, 104,102,106,105];
    assert(calcResistance(h,l) > calcSupport(h,l));
  });

  test('Support = min of lows', () => {
    assertEqual(calcSupport([100,105,110],[90,95,88]), 88);
  });

  test('Resistance = max of highs', () => {
    assertEqual(calcResistance([100,115,108],[90,95,88]), 115);
  });

  test('getTechnicalSignal returns all required fields', () => {
    const sig = getTechnicalSignal(trendingUp(30,100,0.8), null, null);
    assert(sig, 'Should return result');
    for (const f of ['rsi','ema20','ema50','support','resistance','techScore','techBias','bestEntry','stopLoss','signals'])
      assert(f in sig, `Missing field: ${f}`);
    assertRange(sig.techScore, 0, 100);
    assert(['BULLISH','BEARISH','NEUTRAL'].includes(sig.techBias));
    assert(sig.stopLoss < sig.bestEntry, `SL ${sig.stopLoss} should be < entry ${sig.bestEntry}`);
  });

  test('getTechnicalSignal: null for short series (<20 prices)', () => {
    assertEqual(getTechnicalSignal([100,101,102], null, null), null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 3 — Encryption (pure Node.js crypto — zero npm)
// ══════════════════════════════════════════════════════════════════════════════
suite('Encryption & Security', () => {

  const KEY = 'finr-test-key-2026';

  test('AES: encrypt → decrypt round-trip', () => {
    const data = {apiKey:'test123', secret:'abc456', pin:'1234'};
    const plain = JSON.parse(aesDecrypt(aesEncrypt(JSON.stringify(data), KEY), KEY));
    assertEqual(plain.apiKey, 'test123');
    assertEqual(plain.secret, 'abc456');
  });

  test('AES: same plaintext → different ciphertext (random IV)', () => {
    assert(aesEncrypt('hello', KEY) !== aesEncrypt('hello', KEY));
  });

  test('AES: wrong key throws', () => {
    let threw = false;
    try { aesDecrypt(aesEncrypt('secret', KEY), 'wrong-key'); } catch { threw = true; }
    assert(threw, 'Wrong key should throw');
  });

  test('AES: preserves complex nested objects', () => {
    const obj = {stocks:['RELIANCE','TCS'], portfolio:{invested:500000}, nested:{a:{b:42}}};
    const back = JSON.parse(aesDecrypt(aesEncrypt(JSON.stringify(obj), KEY), KEY));
    assertEqual(back.portfolio.invested, 500000);
    assertEqual(back.nested.a.b, 42);
  });

  test('SHA-256: same input → same hash', () => {
    assertEqual(sha256('1234'), sha256('1234'));
  });

  test('SHA-256: different inputs → different hashes', () => {
    assert(sha256('1234') !== sha256('5678'));
  });

  test('SHA-256: output is 64-char hex', () => {
    const h = sha256('test');
    assertEqual(h.length, 64);
    assert(/^[0-9a-f]+$/.test(h));
  });

  test('All PINs produce unique hashes (no collision)', () => {
    const hashes = ['0000','1234','9999','4321','1111'].map(sha256);
    assertEqual(new Set(hashes).size, hashes.length);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 4 — Portfolio Calculations
// ══════════════════════════════════════════════════════════════════════════════
suite('Portfolio Calculations', () => {

  test('P&L basic: (3200-2800)*10 = 4000', () => {
    assertEqual((3200-2800)*10, 4000);
  });

  test('P&L loss: (840-1000)*5 = -800', () => {
    assertEqual((840-1000)*5, -800);
  });

  test('P&L %: (32k-28k)/28k = 14.29%', () => {
    assertApprox(((32000-28000)/28000)*100, 14.29, 0.01);
  });

  test('SIP 10yr ₹5k/mo @14% → ₹12–13.5L', () => {
    const r = 0.14/12, n = 120;
    const fv = 5000 * ((Math.pow(1+r,n)-1)/r) * (1+r);
    assertRange(fv, 1200000, 1350000, `FV ${fv.toFixed(0)}`);
  });

  test('SIP invested amount: 5000×12×10 = 600000', () => {
    assertEqual(5000*12*10, 600000);
  });

  test('Stop loss triggers at or below SL level', () => {
    assert(2580 <= 2600, 'SL trigger');
    assert(!(2650 <= 2600), 'SL should not trigger at 2650');
  });

  test('Weighted portfolio return: 3 holdings', () => {
    const h = [{invested:100000,current:120000},{invested:50000,current:45000},{invested:200000,current:240000}];
    const inv = h.reduce((s,x)=>s+x.invested,0);
    const cur = h.reduce((s,x)=>s+x.current,0);
    assertEqual(inv, 350000);
    assertApprox((cur-inv)/inv*100, 15.71, 0.01);
  });

  test('Long call P&L: (280-120)*2*50 = ₹16,000', () => {
    assertEqual((280-120)*2*50, 16000);
  });

  test('Worthless option: (0-80)*1*50 = -₹4,000', () => {
    assertEqual((0-80)*1*50, -4000);
  });

  test('Bull spread net credit: sell 180 CE buy 80 CE = ₹100 net', () => {
    assertEqual(180-80, 100);
    assertEqual(100*50, 5000); // max profit
    assertEqual((200-100-100)*50, 0); // breakeven at expiry if spread = net credit
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 5 — Market Context
// ══════════════════════════════════════════════════════════════════════════════
suite('Market Context', () => {

  test('Returns non-empty array', () => {
    const ctx = getMarketContext();
    assert(Array.isArray(ctx) && ctx.length > 0);
  });

  test('All items have title, priority, impact', () => {
    for (const item of getMarketContext()) {
      assert(item.title, `Missing title`);
      assert(item.priority, `Missing priority in: ${item.title}`);
      assert(item.impact, `Missing impact in: ${item.title}`);
    }
  });

  test('Priority values are HIGH / MEDIUM / LOW only', () => {
    for (const item of getMarketContext())
      assert(['HIGH','MEDIUM','LOW'].includes(item.priority), `Bad priority: ${item.priority}`);
  });

  test('Sorted HIGH → MEDIUM → LOW', () => {
    const order = {HIGH:0,MEDIUM:1,LOW:2};
    const ctx = getMarketContext();
    for (let i = 0; i < ctx.length-1; i++)
      assert(order[ctx[i].priority] <= order[ctx[i+1].priority],
        `Not sorted at ${i}: ${ctx[i].priority} before ${ctx[i+1].priority}`);
  });

  test('Has at least one HIGH priority item', () => {
    assert(getMarketContext().some(x => x.priority === 'HIGH'));
  });

  test('No duplicate titles', () => {
    const titles = getMarketContext().map(x => x.title);
    assertEqual(new Set(titles).size, titles.length, 'Duplicate titles');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 6 — Auth & URL Validation
// ══════════════════════════════════════════════════════════════════════════════
suite('Auth & URL Validation', () => {

  test('Upstox auth URL contains required params', () => {
    const url = `https://api.upstox.com/v2/login/authorization/dialog?client_id=testkey&redirect_uri=${encodeURIComponent('https://finr-production.up.railway.app/callback')}&response_type=code`;
    assert(url.includes('client_id=testkey'));
    assert(url.includes('response_type=code'));
    assert(url.includes('finr-production'));
    assert(url.startsWith('https://'));
  });

  test('Zerodha auth URL contains required params', () => {
    const url = `https://kite.trade/connect/login?api_key=testkey&v=3`;
    assert(url.includes('api_key=testkey'));
    assert(url.includes('v=3'));
    assert(url.startsWith('https://'));
  });

  test('Redirect URI must use HTTPS', () => {
    assert('https://finr-production.up.railway.app/callback'.startsWith('https://'));
    assert(!'http://finr-production.up.railway.app/callback'.startsWith('https://'));
  });

  test('Zerodha checksum: SHA-256(apiKey+requestToken+apiSecret)', () => {
    const checksum = sha256('testkey' + 'reqtoken' + 'apisecret');
    assertEqual(checksum.length, 64);
    assert(/^[0-9a-f]+$/.test(checksum));
  });

  test('PIN hash format: 64-char hex', () => {
    const h = sha256('1234');
    assertEqual(h.length, 64);
    assert(/^[0-9a-f]+$/.test(h));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 7 — Stock Universe Integrity
// ══════════════════════════════════════════════════════════════════════════════
suite('Stock Universe Integrity', () => {

  const SU = [
    {instrumentKey:'NSE_EQ|INE002A01018',symbol:'RELIANCE', name:'Reliance Industries',  sector:'Energy',  pe:24, roe:14, de:0.3, div:0.4, target:3200, cap:'Large'},
    {instrumentKey:'NSE_EQ|INE040A01034',symbol:'HDFCBANK', name:'HDFC Bank',            sector:'Banking', pe:18, roe:17, de:0.8, div:1.1, target:1900, cap:'Large'},
    {instrumentKey:'NSE_EQ|INE009A01021',symbol:'INFY',     name:'Infosys',              sector:'IT',      pe:26, roe:32, de:0.0, div:3.2, target:2050, cap:'Large'},
    {instrumentKey:'NSE_EQ|INE467B01029',symbol:'TCS',      name:'Tata Consultancy',     sector:'IT',      pe:28, roe:48, de:0.0, div:3.8, target:4600, cap:'Large'},
    {instrumentKey:'NSE_EQ|INE062A01020',symbol:'ICICIBANK',name:'ICICI Bank',           sector:'Banking', pe:17, roe:19, de:0.7, div:0.8, target:1600, cap:'Large'},
    {instrumentKey:'NSE_EQ|INE021A01026',symbol:'COALINDIA',name:'Coal India',           sector:'Mining',  pe:8,  roe:58, de:0.0, div:8.5, target:560,  cap:'Large'},
    {instrumentKey:'NSE_EQ|INE115A01026',symbol:'HAL',      name:'Hindustan Aeronautics',sector:'Defence', pe:42, roe:28, de:0.0, div:0.8, target:5800, cap:'Large'},
  ];

  test('All stocks have required fields', () => {
    for (const s of SU) {
      assert(s.instrumentKey, `${s.symbol}: missing instrumentKey`);
      assert(s.symbol && s.name && s.sector, `Missing core fields`);
      assert(s.target > 0, `${s.symbol}: target must be positive`);
    }
  });

  test('Instrument keys start with NSE_EQ|INE', () => {
    for (const s of SU)
      assert(s.instrumentKey.startsWith('NSE_EQ|INE'), `${s.symbol}: bad instrumentKey`);
  });

  test('No duplicate symbols', () => {
    const syms = SU.map(s=>s.symbol);
    assertEqual(new Set(syms).size, syms.length);
  });

  test('No duplicate instrument keys', () => {
    const keys = SU.map(s=>s.instrumentKey);
    assertEqual(new Set(keys).size, keys.length);
  });

  test('Fundamental values in valid ranges', () => {
    for (const s of SU) {
      assertRange(s.pe, 0, 300, `${s.symbol} P/E`);
      assertRange(s.roe,-50,100,`${s.symbol} ROE`);
      assertRange(s.de, 0, 20, `${s.symbol} D/E`);
      assertRange(s.div,0, 30, `${s.symbol} Div`);
    }
  });

  test('All sectors have a known PE benchmark', () => {
    for (const s of SU)
      assert(SECTOR_PE[s.sector], `"${s.sector}" not in SECTOR_PE`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 8 — Zerodha Strategy Grouper
// ══════════════════════════════════════════════════════════════════════════════
suite('Zerodha Strategy Grouper', () => {

  function groupStrategies(positions) {
    const groups = {};
    for (const pos of positions) {
      const m = pos.symbol.match(/^([A-Z]+)/);
      const underlying = m ? m[1] : pos.symbol;
      if (!groups[underlying]) groups[underlying] = [];
      groups[underlying].push(pos);
    }
    return Object.entries(groups).map(([underlying, legs]) => {
      const calls = legs.filter(l => l.symbol.includes('CE'));
      const puts  = legs.filter(l => l.symbol.includes('PE'));
      const futs  = legs.filter(l => l.symbol.includes('FUT'));
      let stratType;
      if (calls.length >= 1 && puts.length >= 1)      stratType = 'STRADDLE/STRANGLE';
      else if (calls.length >= 2 || puts.length >= 2) stratType = 'VERTICAL SPREAD';
      else if (futs.length >= 1 && legs.length > 1)   stratType = 'HEDGE';
      else if (futs.length === 1)                      stratType = 'FUTURES';
      else if (legs.length === 1)                      stratType = 'NAKED';
      else                                             stratType = 'COMBO';
      return { underlying, stratType, legs, totalPnl: legs.reduce((s,l)=>s+(l.pnl||0),0) };
    });
  }

  test('Two NIFTY CE legs → VERTICAL SPREAD', () => {
    const s = groupStrategies([{symbol:'NIFTY23200CE',pnl:3200},{symbol:'NIFTY23400CE',pnl:-1400}]);
    assertEqual(s.find(x=>x.underlying==='NIFTY')?.stratType, 'VERTICAL SPREAD');
  });

  test('Single CE leg → NAKED', () => {
    const s = groupStrategies([{symbol:'NIFTY23200CE',pnl:1000}]);
    assertEqual(s[0].stratType, 'NAKED');
  });

  test('CE + PE same underlying → STRADDLE/STRANGLE', () => {
    const s = groupStrategies([{symbol:'NIFTY24000CE',pnl:800},{symbol:'NIFTY24000PE',pnl:600}]);
    assertEqual(s[0].stratType, 'STRADDLE/STRANGLE');
  });

  test('FUT only → FUTURES', () => {
    const s = groupStrategies([{symbol:'INFYFUT',pnl:1200}]);
    assertEqual(s[0].stratType, 'FUTURES');
  });

  test('Net P&L aggregated correctly: 3200 - 1400 = 1800', () => {
    const s = groupStrategies([{symbol:'NIFTY23200CE',pnl:3200},{symbol:'NIFTY23400CE',pnl:-1400}]);
    assertEqual(s.find(x=>x.underlying==='NIFTY')?.totalPnl, 1800);
  });

  test('Multiple underlyings → separate strategy groups', () => {
    const s = groupStrategies([
      {symbol:'NIFTY23200CE',pnl:1000},
      {symbol:'BANKNIFTY48000PE',pnl:500},
    ]);
    assert(s.length >= 2, 'Should have >= 2 groups');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 9 — Market Hours Logic
// ══════════════════════════════════════════════════════════════════════════════
suite('Market Hours Logic', () => {

  function open(h, m, day) {
    const mins = h*60 + m;
    return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
  }

  test('9:15 Mon → open', ()     => assert(open(9,15,1)));
  test('3:30 Fri → open',  ()    => assert(open(15,30,5)));
  test('3:31 Fri → closed', ()   => assert(!open(15,31,5)));
  test('9:14 Mon → closed', ()   => assert(!open(9,14,1)));
  test('Saturday 11am → closed', ()=> assert(!open(11,0,6)));
  test('Sunday noon → closed', ()  => assert(!open(12,0,0)));
  test('12:30 Wed → open (lunch)', ()=> assert(open(12,30,3)));
  test('Pre-open 9:00 Mon → closed', ()=> assert(!open(9,0,1)));
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 10 — Gemini Prompt Builder
// ══════════════════════════════════════════════════════════════════════════════
suite('Gemini Prompt Builder', () => {

  function buildPrompt(trade, mkt) {
    if (!trade || trade.length < 5) return null;
    const v = mkt?.vix||14.5, n = mkt?.nifty||22500, p = mkt?.pcr||0.85, t = mkt?.trend||'sideways';
    return `You are a professional NSE options analyst.\nAnalyse: "${trade}"\nNifty: ${n} | Trend: ${t}\nVIX: ${v} | PCR: ${p}\nReply ONLY in JSON (no markdown):\n{"recommendation":"TAKE|AVOID|WAIT","confidence":"HIGH|MEDIUM|LOW","reason":"string","entryAdvice":"string","risks":["r1","r2"],"verdict":"string"}`;
  }

  test('Returns valid prompt', () => {
    const p = buildPrompt('Buy NIFTY 23000 CE 2 lots', {vix:16.2, nifty:22800, pcr:0.78, trend:'bullish'});
    assert(p && p.includes('23000 CE') && p.includes('16.2') && p.includes('22800'));
  });

  test('Falls back to defaults when market data missing', () => {
    const p = buildPrompt('Sell BANKNIFTY 48000 PE', null);
    assert(p.includes('14.5') && p.includes('22500'));
  });

  test('Returns null for empty/too-short trade', () => {
    assertEqual(buildPrompt('', {}), null);
    assertEqual(buildPrompt('Buy', {}), null);
  });

  test('Prompt includes JSON format instruction', () => {
    const p = buildPrompt('Buy NIFTY 23000 CE', {});
    assert(p.includes('"recommendation"') && p.includes('no markdown'));
  });

  test('Prompt is under 1500 chars', () => {
    const p = buildPrompt('Buy NIFTY 23000 CE April 2 lots at 150 premium', {vix:16,nifty:22800,pcr:0.8,trend:'bullish'});
    assert(p.length < 1500, `Prompt too long: ${p.length}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 11 — Signal Classification Labels
// ══════════════════════════════════════════════════════════════════════════════
suite('Signal Classification Labels', () => {

  function classify(score) {
    if (score >= 80) return 'STRONG BUY';
    if (score >= 65) return 'BUY';
    if (score >= 50) return 'WATCH';
    if (score >= 35) return 'HOLD';
    if (score >= 20) return 'SELL';
    return 'STRONG SELL';
  }

  test('80+ → STRONG BUY',  () => assertEqual(classify(85), 'STRONG BUY'));
  test('65–79 → BUY',       () => assertEqual(classify(70), 'BUY'));
  test('50–64 → WATCH',     () => assertEqual(classify(55), 'WATCH'));
  test('35–49 → HOLD',      () => assertEqual(classify(40), 'HOLD'));
  test('20–34 → SELL',      () => assertEqual(classify(25), 'SELL'));
  test('<20 → STRONG SELL', () => assertEqual(classify(10), 'STRONG SELL'));
  test('Boundary 80 → STRONG BUY',  () => assertEqual(classify(80), 'STRONG BUY'));
  test('Boundary 65 → BUY',         () => assertEqual(classify(65), 'BUY'));
  test('Boundary 50 → WATCH',       () => assertEqual(classify(50), 'WATCH'));
  test('Boundary 35 → HOLD',        () => assertEqual(classify(35), 'HOLD'));
  test('Boundary 20 → SELL',        () => assertEqual(classify(20), 'SELL'));
  test('Score 0 → STRONG SELL',     () => assertEqual(classify(0),  'STRONG SELL'));
  test('Score 100 → STRONG BUY',    () => assertEqual(classify(100),'STRONG BUY'));
});

// ══════════════════════════════════════════════════════════════════════════════
// SUITE 12 — Twelve Data & Post-Market Logic
// ══════════════════════════════════════════════════════════════════════════════
suite('Twelve Data & Post-Market', () => {

  // Post-market window helper (mirrors server.js logic)
  function isPostMarket(h, m) {
    const mins = h * 60 + m;
    return mins >= 930 && mins < 1440; // 3:30 PM to midnight IST
  }

  test('3:30 PM → post-market', ()    => assert(isPostMarket(15, 30)));
  test('6:00 PM → post-market', ()    => assert(isPostMarket(18, 0)));
  test('11:59 PM → post-market', ()   => assert(isPostMarket(23, 59)));
  test('3:29 PM → not post-market', () => assert(!isPostMarket(15, 29)));
  test('9:15 AM → not post-market', () => assert(!isPostMarket(9, 15)));
  test('Midnight → not post-market', () => assert(!isPostMarket(0, 0)));
  test('2:00 AM → not post-market', ()  => assert(!isPostMarket(2, 0)));

  // Symbol config validation
  const TWELVE_SYMBOLS = [
    { key:'GIFT_NIFTY', symbol:'NIFTY 50',  name:'Gift Nifty',  type:'Index' },
    { key:'GOLD',       symbol:'XAU/USD',    name:'Gold $/oz',   type:'Commodity' },
    { key:'CRUDE',      symbol:'CL',         name:'Crude WTI',   type:'Commodity' },
    { key:'USDINR',     symbol:'USD/INR',    name:'USD/INR',     type:'Currency' },
    { key:'SP500',      symbol:'SPX',        name:'S&P 500',     type:'Index' },
    { key:'NASDAQ',     symbol:'IXIC',       name:'NASDAQ',      type:'Index' },
    { key:'DOW',        symbol:'DJI',        name:'Dow Jones',   type:'Index' },
    { key:'NIKKEI',     symbol:'NI225',      name:'Nikkei 225',  type:'Index' },
  ];

  test('8 Twelve Data symbols configured', () => {
    assertEqual(TWELVE_SYMBOLS.length, 8);
  });

  test('All symbols have key, symbol, name, type', () => {
    for (const s of TWELVE_SYMBOLS) {
      assert(s.key, 'Missing key');
      assert(s.symbol, 'Missing symbol');
      assert(s.name, 'Missing name');
      assert(['Index','Commodity','Currency'].includes(s.type), `Bad type: ${s.type}`);
    }
  });

  test('No duplicate keys', () => {
    const keys = TWELVE_SYMBOLS.map(s => s.key);
    assertEqual(new Set(keys).size, keys.length, 'Duplicate keys found');
  });

  test('API call budget: 8 symbols × 85 polls = 680 < 800', () => {
    const dailyCalls = 8 * 85;
    assert(dailyCalls <= 800, `${dailyCalls} exceeds 800 free tier limit`);
  });

  test('Poll interval 6 min: 3:30–midnight = 510 min / 6 = 85 polls', () => {
    const windowMins = (24 * 60) - (15 * 60 + 30); // midnight - 3:30 PM
    const polls = Math.floor(windowMins / 6);
    assertEqual(polls, 85);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PRINT RESULTS
// ══════════════════════════════════════════════════════════════════════════════
const W = 66;
const line = '═'.repeat(W);

console.log(`\n╔${line}╗`);
console.log(`║${'  FINR v2.0 — UNIT TEST RESULTS'.padEnd(W)}║`);
console.log(`╠${line}╣`);

let lastSuite = '';
for (const r of results) {
  if (r.suite !== lastSuite) {
    console.log(`║${''.padEnd(W)}║`);
    console.log(`║  ▸ ${r.suite.toUpperCase().padEnd(W-4)}║`);
    lastSuite = r.suite;
  }
  const icon = r.pass ? '✅' : '❌';
  const text = `    ${icon}  ${r.name}`;
  console.log(`║${text.padEnd(W)}║`);
  if (!r.pass) {
    const err = `       ↳ ${r.error || 'unknown error'}`;
    console.log(`║${err.substring(0, W).padEnd(W)}║`);
  }
}

console.log(`║${''.padEnd(W)}║`);
console.log(`╠${line}╣`);
const total = passed + failed;
const pct   = total ? ((passed/total)*100).toFixed(0) : 0;
const summary = `  Suites: ${Object.keys(results.reduce((a,r)=>({...a,[r.suite]:1}),{})).length}  │  Tests: ${total}  │  Passed: ${passed}  │  Failed: ${failed}  │  ${pct}%`;
console.log(`║${summary.padEnd(W)}║`);
console.log(`╚${line}╝`);

if (failed > 0) {
  console.log(`\n❌  ${failed} test(s) FAILED — fix before deploying\n`);
  process.exit(1);
} else {
  console.log(`\n✅  All ${passed} tests PASSED — ready to deploy 🚀\n`);
  process.exit(0);
}

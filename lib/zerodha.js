/**
 * FINR Zerodha Integration
 * Fetches P&L, holdings, positions, trade history
 * Uses Kite Connect Personal API (free)
 */
const axios = require('axios');

class ZerodhaClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.accessToken = null;
    this.baseURL = 'https://api.kite.trade';
  }

  getLoginURL(redirectUri) {
    return `https://kite.trade/connect/login?api_key=${this.apiKey}&v=3`;
  }

  async generateSession(requestToken) {
    const CryptoJS = require('crypto-js');
    const checksum = CryptoJS.SHA256(this.apiKey + requestToken + this.apiSecret).toString();
    const r = await axios.post(`${this.baseURL}/session/token`,
      new URLSearchParams({ api_key: this.apiKey, request_token: requestToken, checksum }),
      { headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    this.accessToken = r.data.data.access_token;
    return this.accessToken;
  }

  headers() {
    return {
      'X-Kite-Version': '3',
      'Authorization': `token ${this.apiKey}:${this.accessToken}`
    };
  }

  // Holdings — long term stocks (CNC)
  async getHoldings() {
    const r = await axios.get(`${this.baseURL}/portfolio/holdings`, { headers: this.headers() });
    return (r.data.data || []).map(h => ({
      symbol: h.tradingsymbol,
      exchange: h.exchange,
      qty: h.quantity,
      avgPrice: h.average_price,
      lastPrice: h.last_price,
      pnl: h.pnl,
      pnlPct: h.average_price > 0 ? +((h.pnl / (h.average_price * h.quantity)) * 100).toFixed(2) : 0,
      currentValue: h.last_price * h.quantity,
      invested: h.average_price * h.quantity,
      dayChange: h.day_change,
      dayChangePct: h.day_change_percentage
    }));
  }

  // Positions — active F&O, intraday
  async getPositions() {
    const r = await axios.get(`${this.baseURL}/portfolio/positions`, { headers: this.headers() });
    const all = [...(r.data.data?.net || []), ...(r.data.data?.day || [])];
    return all.map(p => ({
      symbol: p.tradingsymbol,
      exchange: p.exchange,
      product: p.product, // MIS, CNC, NRML
      qty: p.quantity,
      avgPrice: p.average_price,
      lastPrice: p.last_price,
      pnl: p.pnl,
      unrealised: p.unrealised,
      realised: p.realised,
      value: p.value,
      buyQty: p.buy_quantity,
      sellQty: p.sell_quantity,
      buyPrice: p.buy_price,
      sellPrice: p.sell_price,
      instrumentType: p.instrument_type // EQ, CE, PE, FUT
    }));
  }

  // Today's orders
  async getOrders() {
    const r = await axios.get(`${this.baseURL}/orders`, { headers: this.headers() });
    return (r.data.data || []).map(o => ({
      orderId: o.order_id,
      symbol: o.tradingsymbol,
      transactionType: o.transaction_type, // BUY/SELL
      qty: o.quantity,
      price: o.price,
      avgPrice: o.average_price,
      status: o.status,
      product: o.product,
      orderType: o.order_type,
      instrumentType: o.instrument_type,
      timestamp: o.order_timestamp
    }));
  }

  // Today's trades (executed)
  async getTrades() {
    const r = await axios.get(`${this.baseURL}/trades`, { headers: this.headers() });
    return (r.data.data || []).map(t => ({
      tradeId: t.trade_id,
      orderId: t.order_id,
      symbol: t.tradingsymbol,
      exchange: t.exchange,
      transactionType: t.transaction_type,
      qty: t.quantity,
      price: t.price,
      product: t.product,
      fillTimestamp: t.fill_timestamp,
      instrumentType: t.instrument_type
    }));
  }

  // Funds / margin available
  async getFunds() {
    const r = await axios.get(`${this.baseURL}/user/margins`, { headers: this.headers() });
    const eq = r.data.data?.equity || {};
    const com = r.data.data?.commodity || {};
    return {
      equity: {
        available: eq.available?.live_balance || 0,
        used: eq.utilised?.debits || 0,
        total: eq.net || 0,
        openingBalance: eq.available?.opening_balance || 0
      },
      commodity: {
        available: com.available?.live_balance || 0
      }
    };
  }

  // Group options positions into strategies
  groupOptionsStrategies(positions) {
    const options = positions.filter(p =>
      p.instrumentType === 'CE' || p.instrumentType === 'PE' || p.instrumentType === 'FUT'
    );

    if (options.length === 0) return [];

    // Group by underlying (NIFTY, BANKNIFTY, stock name)
    const groups = {};
    for (const pos of options) {
      const underlying = extractUnderlying(pos.symbol);
      if (!groups[underlying]) groups[underlying] = [];
      groups[underlying].push(pos);
    }

    const strategies = [];
    for (const [underlying, legs] of Object.entries(groups)) {
      const strategy = classifyStrategy(underlying, legs);
      strategies.push(strategy);
    }
    return strategies;
  }
}

function extractUnderlying(symbol) {
  // NIFTY24APR23000CE → NIFTY
  // BANKNIFTY24APR45000PE → BANKNIFTY
  // INFY24APR1400CE → INFY
  const match = symbol.match(/^([A-Z]+)/);
  return match ? match[1] : symbol;
}

function classifyStrategy(underlying, legs) {
  const calls = legs.filter(l => l.instrumentType === 'CE');
  const puts  = legs.filter(l => l.instrumentType === 'PE');
  const futs  = legs.filter(l => l.instrumentType === 'FUT');

  const totalPnl = legs.reduce((sum, l) => sum + (l.pnl || 0), 0);
  const netQty = legs.reduce((sum, l) => sum + (l.qty || 0), 0);

  let strategyType = 'NAKED';
  let description = '';

  if (calls.length > 0 && puts.length > 0 && futs.length === 0) {
    if (calls.length === 1 && puts.length === 1) {
      strategyType = netQty === 0 ? 'STRADDLE/STRANGLE' : 'COMBO';
      description = `${calls[0].qty > 0 ? 'Long' : 'Short'} Call + ${puts[0].qty > 0 ? 'Long' : 'Short'} Put`;
    }
  } else if ((calls.length === 2 && puts.length === 0) || (puts.length === 2 && calls.length === 0)) {
    strategyType = 'VERTICAL SPREAD';
    const instruments = calls.length === 2 ? calls : puts;
    const type = calls.length === 2 ? 'Call' : 'Put';
    description = `Bull/Bear ${type} Spread`;
  } else if (futs.length > 0 && (calls.length > 0 || puts.length > 0)) {
    strategyType = 'HEDGE';
    description = `${futs.length} Fut leg + ${calls.length + puts.length} option leg(s)`;
  } else if (futs.length > 0) {
    strategyType = 'FUTURES';
    description = `${futs[0].qty > 0 ? 'Long' : 'Short'} Futures`;
  } else if (calls.length === 1 || puts.length === 1) {
    strategyType = 'NAKED';
    const l = legs[0];
    description = `${l.qty > 0 ? 'Long' : 'Short'} ${l.instrumentType}`;
  }

  // Calculate max profit / max loss for spreads
  let maxProfit = null, maxLoss = null, breakEven = null;
  if (strategyType === 'VERTICAL SPREAD') {
    const instruments = calls.length === 2 ? calls : puts;
    const netPremium = instruments.reduce((sum, l) => sum + (l.avgPrice * l.qty), 0);
    maxLoss = Math.abs(netPremium) * 75; // assuming Nifty lot size
  }

  return {
    underlying,
    strategyType,
    description,
    legs: legs.map(l => ({
      symbol: l.symbol,
      type: l.instrumentType,
      qty: l.qty,
      avgPrice: l.avgPrice,
      lastPrice: l.lastPrice,
      pnl: l.pnl
    })),
    totalPnl: +totalPnl.toFixed(2),
    maxProfit,
    maxLoss,
    breakEven,
    status: legs.some(l => l.qty !== 0) ? 'OPEN' : 'CLOSED'
  };
}

module.exports = { ZerodhaClient };

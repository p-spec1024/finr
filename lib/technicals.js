/**
 * FINR Technical Analysis Engine
 * RSI, EMA, MACD, Support/Resistance, Bollinger Bands
 */

function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return +(100 - (100 / (1 + avgGain / avgLoss))).toFixed(2);
}

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return +ema.toFixed(2);
}

function calcSMA(prices, period) {
  if (!prices || prices.length < period) return prices[prices.length - 1] || 0;
  const slice = prices.slice(-period);
  return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2);
}

function calcMACD(prices) {
  if (!prices || prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macd = +(ema12 - ema26).toFixed(2);
  // simplified signal
  const signal = +(macd * 0.85).toFixed(2);
  return { macd, signal, histogram: +(macd - signal).toFixed(2) };
}

function calcBollinger(prices, period = 20, stdDev = 2) {
  if (!prices || prices.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper: +(mean + stdDev * sd).toFixed(2),
    middle: +mean.toFixed(2),
    lower: +(mean - stdDev * sd).toFixed(2)
  };
}

function calcSupport(highs, lows) {
  if (!lows || lows.length === 0) return 0;
  // recent swing lows
  const recent = lows.slice(-20);
  return +Math.min(...recent).toFixed(2);
}

function calcResistance(highs, lows) {
  if (!highs || highs.length === 0) return 0;
  const recent = highs.slice(-20);
  return +Math.max(...recent).toFixed(2);
}

function getTechnicalSignal(prices, highs, lows) {
  if (!prices || prices.length < 20) return null;
  const current = prices[prices.length - 1];
  const rsi = calcRSI(prices, 14);
  const ema20 = calcEMA(prices, 20);
  const ema50 = calcEMA(prices, Math.min(50, prices.length));
  const ema200 = calcEMA(prices, Math.min(200, prices.length));
  const support = calcSupport(highs || prices, lows || prices);
  const resistance = calcResistance(highs || prices, lows || prices);
  const bb = calcBollinger(prices, 20);
  const macd = calcMACD(prices);

  const signals = [];
  let bullish = 0, bearish = 0;

  // RSI signals
  if (rsi < 30)      { signals.push({ icon: '🟢', text: `RSI ${rsi} — Oversold, buy zone` }); bullish += 2; }
  else if (rsi < 40) { signals.push({ icon: '🟢', text: `RSI ${rsi} — Approaching oversold` }); bullish += 1; }
  else if (rsi > 70) { signals.push({ icon: '🔴', text: `RSI ${rsi} — Overbought, caution` }); bearish += 2; }
  else if (rsi > 60) { signals.push({ icon: '🟡', text: `RSI ${rsi} — Elevated, watch closely` }); bearish += 1; }

  // Moving average signals
  if (ema20 > ema50 && current > ema20)
    { signals.push({ icon: '🟢', text: `Price above 20 & 50 EMA — uptrend intact` }); bullish += 2; }
  else if (current < ema20 && ema20 < ema50)
    { signals.push({ icon: '🔴', text: `Below 20 & 50 EMA — downtrend` }); bearish += 2; }

  if (ema50 > ema200)
    { signals.push({ icon: '🟢', text: `Golden Cross — 50EMA above 200EMA` }); bullish += 2; }
  else
    { signals.push({ icon: '🔴', text: `Death Cross — 50EMA below 200EMA` }); bearish += 1; }

  // Support/Resistance
  const distToSupport = support > 0 ? +((current - support) / support * 100).toFixed(1) : 0;
  const distToResist  = resistance > 0 ? +((resistance - current) / current * 100).toFixed(1) : 0;
  if (distToSupport < 3)
    { signals.push({ icon: '🟢', text: `Near support ₹${support} — good entry` }); bullish += 2; }
  if (distToResist < 3)
    { signals.push({ icon: '🟡', text: `Near resistance ₹${resistance} — take partial profits` }); }

  // Bollinger
  if (current <= bb.lower)
    { signals.push({ icon: '🟢', text: `At lower Bollinger Band — mean reversion opportunity` }); bullish += 1; }
  else if (current >= bb.upper)
    { signals.push({ icon: '🔴', text: `At upper Bollinger Band — stretched` }); bearish += 1; }

  // MACD
  if (macd.histogram > 0 && macd.macd > macd.signal)
    { signals.push({ icon: '🟢', text: `MACD bullish crossover` }); bullish += 1; }
  else if (macd.histogram < 0)
    { signals.push({ icon: '🔴', text: `MACD bearish — momentum weak` }); bearish += 1; }

  const techScore = Math.min(100, Math.max(0, Math.round(50 + (bullish - bearish) * 8)));
  let techBias = bullish > bearish ? 'BULLISH' : bullish < bearish ? 'BEARISH' : 'NEUTRAL';

  return {
    rsi, ema20, ema50, ema200,
    support, resistance,
    bollingerUpper: bb.upper, bollingerLower: bb.lower,
    macd: macd.macd, macdSignal: macd.signal,
    signals: signals.slice(0, 5),
    techScore, techBias,
    bestEntry: support > 0 ? support : +(current * 0.97).toFixed(2),
    stopLoss: support > 0 ? +(support * 0.97).toFixed(2) : +(current * 0.93).toFixed(2)
  };
}

module.exports = { calcRSI, calcEMA, calcSMA, calcMACD, calcBollinger, calcSupport, calcResistance, getTechnicalSignal };

/**
 * FINR Signal Engine
 * Calculates buy/sell signals based on fundamental + technical data
 */

const SECTOR_PE = {
  IT: 28, Banking: 15, Pharma: 30, Energy: 10, FMCG: 45,
  Auto: 18, Metals: 8, Power: 16, Telecom: 22, NBFC: 20,
  Mining: 7, Retail: 50, Diversified: 18, Defence: 35,
  Healthcare: 32, Chemicals: 25, Realty: 22, Consumer: 35,
  Financial: 18, Unknown: 20
};

function calcSignal(symbol, price, fund) {
  if (!fund || !price || price <= 0) return null;

  let score = 0;
  const reasons = [];

  // 1. Position vs 52-week range (25 pts)
  const range = (fund.high52 || 0) - (fund.low52 || 0);
  if (range > 0) {
    const pos = Math.max(0, Math.min(1, (price - fund.low52) / range));
    const rangeScore = Math.round((1 - pos) * 25);
    score += rangeScore;
    if (pos < 0.2)       reasons.push('🎯 Near 52W low — excellent entry zone');
    else if (pos < 0.4)  reasons.push('📍 In lower half of 52W range — good value');
    else if (pos > 0.85) reasons.push('⚠️ Near 52W high — limited upside from range');
  }

  // 2. P/E vs sector average (20 pts)
  const sectorPe = fund.sectorPe || SECTOR_PE[fund.sector] || 20;
  if (fund.pe > 0 && sectorPe > 0) {
    const r = fund.pe / sectorPe;
    if (r < 0.5)       { score += 20; reasons.push(`💚 P/E ${fund.pe.toFixed(1)}x — deeply undervalued vs sector ${sectorPe}x`); }
    else if (r < 0.75) { score += 15; reasons.push(`💚 P/E ${fund.pe.toFixed(1)}x — cheap vs sector ${sectorPe}x`); }
    else if (r < 1.0)  { score += 10; }
    else if (r < 1.25) { score += 5; }
    else if (r > 1.5)  { reasons.push(`🔴 P/E ${fund.pe.toFixed(1)}x — expensive vs sector ${sectorPe}x`); }
  }

  // 3. ROE quality (15 pts)
  if (fund.roe >= 25)      { score += 15; reasons.push(`⭐ ROE ${fund.roe.toFixed(1)}% — excellent capital efficiency`); }
  else if (fund.roe >= 18) { score += 12; reasons.push(`✅ ROE ${fund.roe.toFixed(1)}% — strong returns`); }
  else if (fund.roe >= 12) { score += 8; }
  else if (fund.roe >= 6)  { score += 4; }
  else if (fund.roe < 0)   { score -= 5; reasons.push(`🔴 Negative ROE — loss making`); }

  // 4. Debt level (10 pts)
  const d2e = fund.debtToEquity || 0;
  if (d2e < 0.1)      { score += 10; reasons.push('💰 Virtually debt-free — very safe'); }
  else if (d2e < 0.5) { score += 7; }
  else if (d2e < 1.0) { score += 4; }
  else if (d2e < 2.0) { score += 1; }
  else                { score -= 5; reasons.push(`⚠️ High debt D/E ${d2e.toFixed(1)} — risk factor`); }

  // 5. Dividend yield (10 pts)
  const dy = fund.dividendYield || 0;
  if (dy > 4)      { score += 10; reasons.push(`💵 Div yield ${dy.toFixed(1)}% — strong income`); }
  else if (dy > 2) { score += 6; reasons.push(`💵 Div yield ${dy.toFixed(1)}%`); }
  else if (dy > 1) { score += 3; }

  // 6. Upside to analyst target (20 pts)
  const upside = fund.targetPrice > 0
    ? +((((fund.targetPrice - price) / price) * 100).toFixed(1))
    : 0;
  if (upside > 30)      { score += 20; reasons.push(`🚀 ${upside}% upside to analyst target`); }
  else if (upside > 20) { score += 15; reasons.push(`📈 ${upside}% upside to analyst target`); }
  else if (upside > 10) { score += 8; reasons.push(`📊 ${upside}% upside to target`); }
  else if (upside > 0)  { score += 3; }
  else                  { reasons.push(`📉 Trading above analyst target`); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Downside to 52W low
  const downside = fund.low52 > 0
    ? +(((fund.low52 - price) / price * 100).toFixed(1))
    : 0;

  let signal, color, signalClass;
  if (score >= 80)      { signal = 'STRONG BUY'; color = '#30d158'; signalClass = 'sb'; }
  else if (score >= 65) { signal = 'BUY';         color = '#0a84ff'; signalClass = 'b'; }
  else if (score >= 50) { signal = 'WATCH';        color = '#ffd60a'; signalClass = 'w'; }
  else if (score >= 35) { signal = 'HOLD';         color = '#ff9f0a'; signalClass = 'h'; }
  else if (score >= 20) { signal = 'SELL';         color = '#ff453a'; signalClass = 's'; }
  else                  { signal = 'STRONG SELL';  color = '#bf5af2'; signalClass = 'ss'; }

  return {
    score, signal, color, signalClass,
    reason: reasons[0] || 'Analysing fundamentals...',
    allReasons: reasons,
    upside,
    downside,
    targetPrice: +(fund.targetPrice || 0).toFixed(2)
  };
}

// Batch calculate for all stocks
function calcAllSignals(stockUniverse, liveData, fundamentalCache) {
  const signals = {};
  for (const stock of stockUniverse) {
    const price = liveData[stock.symbol]?.price;
    const fund = fundamentalCache[stock.symbol];
    if (price && fund) {
      const sig = calcSignal(stock.symbol, price, fund);
      if (sig) signals[stock.symbol] = sig;
    }
  }
  return signals;
}

module.exports = { calcSignal, calcAllSignals, SECTOR_PE };

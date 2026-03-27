/**
 * FINR Dynamic Market Context Engine
 * Reflects current macro/geopolitical landscape (March 2026)
 * Sorted: HIGH → MEDIUM → LOW impact
 */

function getMarketContext() {
  // Use UTC offset math to get correct IST on Vercel (UTC-based servers)
  const utc  = new Date();
  const ist  = new Date(utc.getTime() + 5.5 * 60 * 60 * 1000);
  const month = ist.getUTCMonth() + 1; // 1-12
  const day   = ist.getUTCDate();
  const hour  = ist.getUTCHours();

  const events = [];

  // ── US TARIFF WAR (highest impact 2026) ───────────────────────────────────
  events.push({
    id: 'us-tariffs',
    title: 'US Reciprocal Tariff War',
    priority: 'HIGH',
    impact: 'Trump tariffs on China, EU, India under negotiation. IT and pharma exporters face headwinds. FII outflow risk from EM.',
    sectors: { avoid: ['IT','Pharma exporters','Auto exports'], buy: ['Domestic consumption','FMCG','Power'] },
    trend: 'ONGOING',
    icon: '🇺🇸',
    affectsOptions: true,
    vixImpact: 'Spikes on tariff announcements'
  });

  // ── RBI POLICY ────────────────────────────────────────────────────────────
  const rbiMonths = [2, 4, 6, 8, 10, 12];
  const isRbiMonth = rbiMonths.includes(month);
  const isRbiWeek  = isRbiMonth && day >= 4 && day <= 8;

  if (isRbiWeek) {
    events.push({
      id: 'rbi-mpc',
      title: `RBI MPC Decision — ${getMonthName(month)} ${ist.getFullYear()}`,
      priority: 'HIGH',
      impact: 'Rate decision this week. Rate cut = Banking, NBFC, Realty rally. CPI data key input.',
      sectors: { buy: ['Banking','NBFC','Realty'], watch: ['IT','FMCG'] },
      trend: 'THIS WEEK',
      icon: '🏦',
      affectsOptions: true,
      vixImpact: 'VIX spikes on decision day'
    });
  } else if (isRbiMonth) {
    events.push({
      id: 'rbi-mpc-upcoming',
      title: `RBI MPC Meeting — ${getMonthName(month)}`,
      priority: 'MEDIUM',
      impact: 'Rate decision this month. Easing cycle underway — expect 25bps cut if CPI stays below 5%.',
      sectors: { watch: ['Banking','NBFC','Realty'] },
      trend: 'THIS MONTH',
      icon: '🏦',
      affectsOptions: false,
      vixImpact: 'Mild until decision week'
    });
  }

  // ── US FED ────────────────────────────────────────────────────────────────
  // 2026 FOMC meetings: Jan 28-29, Mar 18-19, May 6-7, Jun 17-18, Jul 29-30, Sep 16-17, Oct 28-29, Dec 9-10
  const fedMeetingMonths = [1, 3, 5, 6, 7, 9, 10, 12];
  const fedWeekDays = { 1:[28,29], 3:[18,19], 5:[6,7], 6:[17,18], 7:[29,30], 9:[16,17], 10:[28,29], 12:[9,10] };
  const isFedWeek = fedMeetingMonths.includes(month) && fedWeekDays[month]?.some(d => Math.abs(d - day) <= 2);

  events.push({
    id: 'us-fed',
    title: isFedWeek ? 'US Fed FOMC — Decision This Week!' : 'US Fed Policy Watch',
    priority: isFedWeek ? 'HIGH' : 'MEDIUM',
    impact: 'Fed rate path impacts FII flows. Every cut = more EM capital inflows. Dollar weakness = Nifty positive.',
    sectors: { watch: ['IT','Banking','Metals'] },
    trend: isFedWeek ? 'THIS WEEK' : 'ONGOING',
    icon: '🇺🇸',
    affectsOptions: true,
    vixImpact: 'Dollar Index moves affect INR and Nifty'
  });

  // ── EARNINGS SEASON ───────────────────────────────────────────────────────
  const earningsMonths = [1, 4, 7, 10];
  if (earningsMonths.includes(month)) {
    events.push({
      id: 'earnings',
      title: `Q${[4,1,2,3][earningsMonths.indexOf(month)]} Earnings Season`,
      priority: 'MEDIUM',
      impact: 'Quarterly results underway. Stock-specific moves ±5–15% on result day. Avoid naked options before results.',
      sectors: { watch: ['IT','Banking','Pharma','Auto','Metals'] },
      trend: 'ONGOING',
      icon: '📊',
      affectsOptions: true,
      vixImpact: 'Elevated IV for stocks reporting this week'
    });
  }

  // ── UNION BUDGET ──────────────────────────────────────────────────────────
  if (month === 1 && day < 2) {
    events.push({
      id: 'budget',
      title: 'Union Budget — Feb 1st',
      priority: 'HIGH',
      impact: 'Most anticipated annual event. Capital gains, sector allocation, fiscal deficit all market-moving.',
      sectors: { watch: ['All'] },
      trend: 'IMMINENT',
      icon: '📋',
      affectsOptions: true,
      vixImpact: 'VIX typically spikes in budget week'
    });
  }

  // ── INDIA ELECTIONS / STATE POLLS ─────────────────────────────────────────
  const electionMonths = [2, 3, 10, 11]; // rough Bihar, Delhi, state elections 2026
  if (electionMonths.includes(month)) {
    events.push({
      id: 'elections',
      title: 'State Election Season',
      priority: 'MEDIUM',
      impact: 'State election results affect policy sentiment. PSU and infra stocks sensitive to coalition dynamics.',
      sectors: { watch: ['PSU','Infra','Defence'] },
      trend: 'SEASONAL',
      icon: '🗳️',
      affectsOptions: false,
      vixImpact: 'Mild elevation before result day'
    });
  }

  // ── CHINA SLOWDOWN RISK ────────────────────────────────────────────────────
  events.push({
    id: 'china',
    title: 'China Slowdown & Trade Diversion',
    priority: 'MEDIUM',
    impact: 'China deceleration hurts metals demand. But trade diversion from US tariffs benefits Indian manufacturers.',
    sectors: { avoid: ['Metals'], buy: ['Manufacturing','Chemicals','Defence exports'] },
    trend: 'STRUCTURAL',
    icon: '🇨🇳',
    affectsOptions: false,
    vixImpact: 'Minimal direct VIX impact'
  });

  // ── FII FLOWS ─────────────────────────────────────────────────────────────
  events.push({
    id: 'fii-flows',
    title: 'FII Net Selling — DII Absorbing',
    priority: 'MEDIUM',
    impact: 'FIIs net sellers YTD. DIIs (SIP + insurance) providing support. Nifty holding key support zones.',
    sectors: { buy: ['FMCG','Consumer'], avoid: ['Midcap'] },
    trend: 'ONGOING',
    icon: '📉',
    affectsOptions: false,
    vixImpact: 'Mild VIX elevation on sharp FII sell days'
  });

  // ── INDIA GROWTH MACRO ─────────────────────────────────────────────────────
  events.push({
    id: 'india-growth',
    title: 'India Growth Story Intact — 6.8% GDP',
    priority: 'MEDIUM',
    impact: 'Fastest growing major economy. Capex cycle, infra, manufacturing PLI schemes driving earnings.',
    sectors: { buy: ['Infra','Capex','Defence','Manufacturing','PSU Banks'] },
    trend: 'STRUCTURAL',
    icon: '🇮🇳',
    affectsOptions: false,
    vixImpact: 'Positive medium-term backdrop'
  });

  // ── INDIA VIX ─────────────────────────────────────────────────────────────
  events.push({
    id: 'india-vix',
    title: 'India VIX — Watch Live Before Options',
    priority: 'LOW',
    impact: 'VIX > 18: prefer option buying. VIX 12–17: balanced. VIX < 12: option selling zone.',
    sectors: { watch: ['All'] },
    trend: 'DAILY',
    icon: '⚡',
    affectsOptions: true,
    vixImpact: 'Check live VIX — drives options premium'
  });

  // ── CRUDE OIL ─────────────────────────────────────────────────────────────
  events.push({
    id: 'crude',
    title: 'Crude Oil — OPEC+ Supply Watch',
    priority: 'LOW',
    impact: 'Crude at $70–85 is Goldilocks for India. Above $90 = inflation risk. Below $65 = OMC margin boost.',
    sectors: { buy: ['OMC'], avoid: ['Aviation'] },
    trend: 'WATCH',
    icon: '🛢️',
    affectsOptions: false,
    vixImpact: 'Sharp crude moves affect OMC/airlines'
  });

  // ── RUPEE ─────────────────────────────────────────────────────────────────
  events.push({
    id: 'inr',
    title: 'USD/INR — ₹84–87 Managed Float',
    priority: 'LOW',
    impact: 'RBI defending ₹87. Weak rupee helps IT and pharma exporters. Hurts import-heavy sectors.',
    sectors: { buy: ['IT exporters','Pharma'], watch: ['Metals','Oil importers'] },
    trend: 'WATCH',
    icon: '💱',
    affectsOptions: false,
    vixImpact: 'Sharp INR moves affect FII sentiment'
  });

  // Sort HIGH → MEDIUM → LOW
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  events.sort((a, b) => order[a.priority] - order[b.priority]);

  return events;
}

function getMonthName(m) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
}

module.exports = { getMarketContext };

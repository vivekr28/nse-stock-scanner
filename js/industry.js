// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRY — industry-level analysis, RS scoring, and charts
// ═══════════════════════════════════════════════════════════════════════════════

// ── Compute industry money flow for current and previous period ──
function computeIndustryMoneyFlow(period) {
  const numDays = { '1w': 5, '1m': 21, '3m': 63, '6m': 126, '1y': 250 }[period] || 126;
  const totalAvail = Store.dates.length;

  // Current period = last numDays trading days
  const currentDates = Store.dates.slice(-Math.min(numDays, totalAvail));
  const currentSet = new Set(currentDates);

  // Previous period = the numDays before the current period
  const prevEnd = totalAvail - currentDates.length;
  const prevStart = Math.max(0, prevEnd - numDays);
  const prevDates = Store.dates.slice(prevStart, prevEnd);
  const prevSet = new Set(prevDates);

  const symbolFlowCurrent = {};
  const symbolFlowPrev = {};

  for (const key in Store.dailyBySymbol) {
    const days = Store.dailyBySymbol[key];
    let cur = 0, prev = 0;
    for (const d of days) {
      const t = d.turnover || 0;
      if (currentSet.has(d.date)) cur += t;
      else if (prevSet.has(d.date)) prev += t;
    }
    symbolFlowCurrent[key] = cur;
    symbolFlowPrev[key] = prev;
  }

  return { current: symbolFlowCurrent, previous: symbolFlowPrev,
           currentDays: currentDates.length, prevDays: prevDates.length };
}

// ── Store chart bar regions for hover/click ──
let _chartBars = [];   // [{x, y, w, h, ind}]
let _chartData = [];   // full indList reference for popup

function renderIndustryAnalysis() {
  const minStocks = parseInt(document.getElementById('indMinStocks').value) || 1;
  const minMcap = parseNum(document.getElementById('indMinMcap').value) || 0;
  const sortBy = document.getElementById('industrySort').value;
  const mfPeriod = document.getElementById('moneyFlowPeriod').value;

  // Show/hide money flow period dropdown + all-periods toggle
  const mfGroup = document.getElementById('mfPeriodGroup');
  if (mfGroup) mfGroup.style.display = sortBy === 'money_flow' ? '' : 'none';
  const mfAllGroup = document.getElementById('mfAllPeriodsGroup');
  if (mfAllGroup) mfAllGroup.style.display = sortBy === 'money_flow' ? '' : 'none';

  // Show/hide + populate the all-periods money flow comparison table
  // (respects the same Min Stocks / Min Market Cap filters as the main table)
  const allPeriodsOn = sortBy === 'money_flow' && document.getElementById('mfAllPeriodsToggle').checked;
  const mfAllSection = document.getElementById('mfAllPeriodsSection');
  if (mfAllSection) mfAllSection.style.display = allPeriodsOn ? '' : 'none';
  // Default the all-periods table's sort to whichever period is selected in the
  // Money Flow Period dropdown (mirrors the main table, which always sorts by the
  // selected period's MF Chg%). A manual column click still overrides this until
  // the period dropdown itself is changed again.
  if (mfPeriod !== _mfAllPeriodTrack) {
    _mfAllPeriodTrack = mfPeriod;
    mfAllSortCol = mfPeriod;
    mfAllSortDir = -1;
  }
  if (allPeriodsOn) renderMoneyFlowAllPeriodsTable(computeAllPeriodsMoneyFlow(minStocks, minMcap));

  // Compute money flow per symbol for current and previous period
  const mfData = computeIndustryMoneyFlow(mfPeriod);

  // Group stocks by industry
  const industries = {};
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const ind = s.industry || 'Undefined-Diversified';
    if (!industries[ind]) industries[ind] = {
      stocks: [], totalTurnover: 0, totalMonthlyChange: 0,
      above: 0, below: 0, totalMcap: 0,
      totalDistFrom52H: 0, totalDistFromSMA: 0,
      moneyFlowCurrent: 0, moneyFlowPrev: 0,
      sector: s.sector || '-'
    };
    industries[ind].stocks.push(s);
    industries[ind].totalTurnover += (s.turnover || 0);
    industries[ind].totalMonthlyChange += (s.monthlyChangePct || 0);
    industries[ind].totalMcap += (s.marketCap || 0);
    industries[ind].totalDistFrom52H += (s.distFrom52H || 0);
    if (!isNaN(s.distFromSMA)) industries[ind].totalDistFromSMA += s.distFromSMA;
    if (s.aboveSMA) industries[ind].above++;
    else industries[ind].below++;
    industries[ind].moneyFlowCurrent += (mfData.current[key] || 0);
    industries[ind].moneyFlowPrev += (mfData.previous[key] || 0);
  }

  // Build industry list with computed metrics
  let indList = Object.entries(industries).map(([name, data]) => {
    const n = data.stocks.length;
    const avgMonthlyChange = data.totalMonthlyChange / n;
    const breadth = n > 0 ? (data.above / n * 100) : 0;
    const avgDist52H = data.totalDistFrom52H / n;
    const avgDistSMA = data.totalDistFromSMA / n;

    // Money flow % change: (current - previous) / previous * 100
    let moneyFlowChg = 0;
    if (data.moneyFlowPrev > 0) {
      moneyFlowChg = ((data.moneyFlowCurrent - data.moneyFlowPrev) / data.moneyFlowPrev) * 100;
    } else if (data.moneyFlowCurrent > 0) {
      moneyFlowChg = 100; // went from 0 to something
    }

    return {
      name,
      sector: data.sector,
      stockCount: n,
      avgMonthlyChange,
      totalTurnover: data.totalTurnover,
      totalMcap: data.totalMcap,
      breadth,
      above: data.above,
      below: data.below,
      avgDist52H,
      avgDistSMA,
      moneyFlow: data.moneyFlowCurrent,
      moneyFlowPrev: data.moneyFlowPrev,
      moneyFlowChg,
      topGainer: data.stocks.sort((a, b) => b.monthlyChangePct - a.monthlyChangePct)[0],
      topLoser: data.stocks.sort((a, b) => a.monthlyChangePct - b.monthlyChangePct)[0],
      stocks: data.stocks
    };
  });

  // Apply filters
  indList = indList.filter(i => i.stockCount >= minStocks);
  if (minMcap > 0) indList = indList.filter(i => i.totalMcap >= minMcap);

  // ── Compute Relative Strength Score (shared with screener.js F9 — see utils.js) ──
  computeRSScores(indList);

  // Sort
  switch (sortBy) {
    case 'rs_score': indList.sort((a, b) => b.rsScore - a.rsScore); break;
    case 'avg_change': indList.sort((a, b) => b.avgMonthlyChange - a.avgMonthlyChange); break;
    case 'breadth': indList.sort((a, b) => b.breadth - a.breadth); break;
    case 'mcap': indList.sort((a, b) => b.totalMcap - a.totalMcap); break;
    case 'turnover': indList.sort((a, b) => b.totalTurnover - a.totalTurnover); break;
    case 'avg_dist52h': indList.sort((a, b) => a.avgDist52H - b.avgDist52H); break;
    case 'stocks': indList.sort((a, b) => b.stockCount - a.stockCount); break;
    case 'money_flow': indList.sort((a, b) => b.moneyFlowChg - a.moneyFlowChg); break;
  }

  // Save for popup lookups
  _chartData = indList;

  // ── Summary stats ──
  const totalStocks = indList.reduce((s, i) => s + i.stockCount, 0);
  const totalMcap = indList.reduce((s, i) => s + i.totalMcap, 0);
  const totalAbove = indList.reduce((s, i) => s + i.above, 0);
  const totalBelow = indList.reduce((s, i) => s + i.below, 0);
  const avgBreadth = (totalAbove + totalBelow) > 0 ? (totalAbove / (totalAbove + totalBelow) * 100) : 0;

  document.getElementById('indCount').textContent = indList.length;
  document.getElementById('indStockCount').textContent = totalStocks.toLocaleString();
  document.getElementById('indTotalMcap').textContent = fmtCr(totalMcap);
  document.getElementById('indAvgBreadth').textContent = avgBreadth.toFixed(1) + '%';

  // ── Horizontal Bar Chart (replaced by the all-periods table when that's shown) ──
  const rsChartSection = document.getElementById('rsChartSection');
  if (rsChartSection) rsChartSection.style.display = allPeriodsOn ? 'none' : '';
  if (!allPeriodsOn) renderMetricChart(indList.slice(0, 40), sortBy, mfPeriod, mfData);

  // ── Industry Table (all filtered industries; manual header sort layered on the filter order) ──
  // A manual column sort only lasts until the Sort By metric / MF period changes, so picking a
  // new Sort By always brings the table back in step with the chart.
  const sortTrack = sortBy === 'money_flow' ? sortBy + '|' + mfPeriod : sortBy;
  if (sortTrack !== _indSortTrack) {
    _indSortTrack = sortTrack;
    indSortCol = null;
  }
  _indBreakdown = {
    list: indList,
    sortBy,
    sortLabel: document.getElementById('industrySort').selectedOptions[0].textContent,
    mfLabel: { '1w': '1W', '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y' }[mfPeriod] || '6M'
  };
  renderIndustryBreakdownTable();

  // ── Industry Heatmap ──
  const grid = document.getElementById('industryGrid');
  grid.innerHTML = indList.slice(0, 30).map(ind => {
    const rsColor = ind.rsScore >= 70 ? 142 : ind.rsScore >= 40 ? 40 : 0;
    const sat = Math.min(ind.rsScore * 0.8, 70);
    const bg = `hsla(${rsColor}, ${sat}%, 40%, 0.15)`;
    const border = `hsla(${rsColor}, ${sat}%, 50%, 0.3)`;
    const scoreColor = ind.rsScore >= 70 ? 'var(--green)' : ind.rsScore >= 40 ? 'var(--orange)' : 'var(--red)';
    const mfChgColor2 = ind.moneyFlowChg >= 0 ? 'var(--green)' : 'var(--red)';
    const mfSign = ind.moneyFlowChg >= 0 ? '+' : '';
    return `
      <div class="sector-card" style="background:${bg};border-color:${border};cursor:pointer;" onclick="openIndustryCharts('${ind.name.replace(/'/g, "\\'")}')">
        <h4>
          <span>${ind.name}</span>
          <span style="color:${scoreColor};font-weight:700">${ind.rsScore.toFixed(0)}</span>
        </h4>
        <table class="mini-table">
          <tr><td style="color:var(--text2)">Stocks</td><td style="text-align:right">${ind.stockCount}</td></tr>
          <tr><td style="color:var(--text2)">Mkt Cap</td><td style="text-align:right">${fmtCr(ind.totalMcap)}</td></tr>
          <tr><td style="color:var(--text2)">1M Chg%</td><td style="text-align:right" class="${ind.avgMonthlyChange >= 0 ? 'positive' : 'negative'}">${ind.avgMonthlyChange.toFixed(2)}%</td></tr>
          <tr><td style="color:var(--text2)">Breadth</td><td style="text-align:right">${ind.breadth.toFixed(0)}%</td></tr>
          <tr><td style="color:var(--text2)">MF Chg</td><td style="text-align:right;color:${mfChgColor2}">${mfSign}${ind.moneyFlowChg.toFixed(1)}%</td></tr>
        </table>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRY BREAKDOWN TABLE — click-to-sort headers.
// Default order = the filter order shown in the chart (Sort By metric); a header click
// re-sorts the table only (chart and heatmap keep the filter order).
// ═══════════════════════════════════════════════════════════════════════════════
let indSortCol = null;     // null = default (filter) order
let indSortDir = -1;
let _indSortTrack = null;  // Sort By (+ MF period) the manual sort was last cleared for
let _indBreakdown = { list: [], sortBy: 'rs_score', sortLabel: '', mfLabel: '6M' };

// Columns whose natural first-click direction is ascending (A→Z, closest to 52W high,
// worst loser first); everything else starts high→low. Matches the Sort By order for avg_dist52h.
const IND_ASC_COLS = new Set(['name', 'sector', 'avgDist52H', 'topLoser']);
const indColDir = key => IND_ASC_COLS.has(key) ? 1 : -1;

function indBreakdownCols(mfLabel) {
  return [
    { key: 'name', label: 'Industry' },
    { key: 'sector', label: 'Sector' },
    { key: 'rsScore', label: 'RS Score' },
    { key: 'stockCount', label: 'Stocks' },
    { key: 'totalMcap', label: 'Mkt Cap (Cr)' },
    { key: 'avgMonthlyChange', label: 'Avg 1M Chg%' },
    { key: 'breadth', label: 'Breadth' },
    { key: 'avgDist52H', label: 'Avg Dist 52WH' },
    { key: 'totalTurnover', label: 'Turnover (Cr)' },
    { key: 'moneyFlow', label: `MF ${mfLabel} (Cr)` },
    { key: 'moneyFlowPrev', label: `Prev ${mfLabel} (Cr)` },
    { key: 'moneyFlowChg', label: 'MF Chg%' },
    { key: 'topGainer', label: 'Top 1M Gainer', get: i => i.topGainer ? i.topGainer.monthlyChangePct : null },
    { key: 'topLoser', label: 'Top 1M Loser', get: i => i.topLoser ? i.topLoser.monthlyChangePct : null }
  ];
}

function indDefaultSort() {
  const col = (METRIC_CONFIG[_indBreakdown.sortBy] || METRIC_CONFIG.rs_score).key;
  return { col, dir: indColDir(col) };
}

function indEffectiveSort() {
  return indSortCol ? { col: indSortCol, dir: indSortDir } : indDefaultSort();
}

function sortIndustryBreakdown(key) {
  const cur = indEffectiveSort();
  const dir = cur.col === key ? -cur.dir : indColDir(key);
  const def = indDefaultSort();
  if (key === def.col && dir === def.dir) {
    indSortCol = null; // back on the filter order
  } else {
    indSortCol = key;
    indSortDir = dir;
  }
  renderIndustryBreakdownTable();
}

function resetIndustryBreakdownSort() {
  indSortCol = null;
  renderIndustryBreakdownTable();
}

function renderIndustryBreakdownTable() {
  const { list, sortLabel, mfLabel } = _indBreakdown;
  const cols = indBreakdownCols(mfLabel);
  const eff = indEffectiveSort();

  let sorted = list; // already in filter order
  if (indSortCol) {
    const c = cols.find(x => x.key === indSortCol);
    const get = c.get || (i => i[c.key]);
    const missing = v => v == null || (typeof v === 'number' && isNaN(v));
    // Array.sort is stable, so ties keep their filter order; missing values always sink to the bottom.
    sorted = [...list].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (missing(va) || missing(vb)) return (missing(va) ? 1 : 0) - (missing(vb) ? 1 : 0);
      if (typeof va === 'string') return indSortDir * va.localeCompare(vb);
      return indSortDir * (va - vb);
    });
  }

  document.getElementById('industryHead').innerHTML = '<th>#</th>' + cols.map(c =>
    `<th onclick="sortIndustryBreakdown('${c.key}')">${c.label}<span class="sort-arrow">${eff.col === c.key ? (eff.dir > 0 ? '▲' : '▼') : ''}</span></th>`
  ).join('');

  const note = document.getElementById('indBreakdownNote');
  if (note) {
    note.textContent = indSortCol
      ? 'Sorted by ' + cols.find(x => x.key === indSortCol).label
      : 'Filter order (' + sortLabel + ') — click a column header to re-sort';
  }
  const resetBtn = document.getElementById('indBreakdownReset');
  if (resetBtn) resetBtn.style.display = indSortCol ? '' : 'none';

  document.getElementById('industryBody').innerHTML = sorted.map((ind, idx) => {
    const rsColor = ind.rsScore >= 70 ? 'var(--green)' : ind.rsScore >= 40 ? 'var(--orange)' : 'var(--red)';
    const mfChgColor = ind.moneyFlowChg >= 0 ? 'var(--green)' : 'var(--red)';
    const mfChgSign = ind.moneyFlowChg >= 0 ? '+' : '';
    return `
    <tr style="cursor:pointer" onclick="openIndustryCharts('${ind.name.replace(/'/g, "\\'")}')">
      <td>${idx + 1}</td>
      <td style="font-weight:600">${ind.name}</td>
      <td style="color:var(--text2)">${ind.sector}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;height:8px;background:var(--bg3);border-radius:4px;overflow:hidden;">
            <div style="width:${ind.rsScore}%;height:100%;background:${rsColor};border-radius:4px;"></div>
          </div>
          <span style="font-size:11px;min-width:30px;color:${rsColor};font-weight:600">${ind.rsScore.toFixed(0)}</span>
        </div>
      </td>
      <td>${ind.stockCount}</td>
      <td>${fmtCr(ind.totalMcap)}</td>
      <td class="${ind.avgMonthlyChange >= 0 ? 'positive' : 'negative'}">${ind.avgMonthlyChange.toFixed(2)}%</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;height:8px;background:var(--red);border-radius:4px;overflow:hidden;">
            <div style="width:${ind.breadth}%;height:100%;background:var(--green);"></div>
          </div>
          <span style="font-size:11px;min-width:35px;">${ind.breadth.toFixed(0)}%</span>
        </div>
      </td>
      <td>${ind.avgDist52H.toFixed(1)}%</td>
      <td>${fmtTurnoverCr(ind.totalTurnover)}</td>
      <td>${fmtCr(ind.moneyFlow)}</td>
      <td style="color:var(--text2)">${fmtCr(ind.moneyFlowPrev)}</td>
      <td style="color:${mfChgColor};font-weight:600">${mfChgSign}${ind.moneyFlowChg.toFixed(1)}%</td>
      <td class="positive">${ind.topGainer ? ind.topGainer.symbol + ' (' + fmtPct(ind.topGainer.monthlyChangePct) + ')' : '-'}</td>
      <td class="negative">${ind.topLoser ? ind.topLoser.symbol + ' (' + fmtPct(ind.topLoser.monthlyChangePct) + ')' : '-'}</td>
    </tr>`;
  }).join('');
}

// ── Metric config for chart rendering ──
const METRIC_CONFIG = {
  rs_score:    { key: 'rsScore',          unit: '',    dec: 0, maxVal: 100,
                 title: 'Industry Relative Strength',
                 tip: 'Composite score (0-100) combining breadth (40%), avg monthly change rank (30%), and proximity to 52-week high (30%). Higher = stronger industry.' },
  avg_change:  { key: 'avgMonthlyChange', unit: '%',   dec: 2, maxVal: null,
                 title: 'Industry by Avg Monthly Change %',
                 tip: 'Average 1-month price change across all stocks in the industry. Positive = industry trending up over the past month.' },
  breadth:     { key: 'breadth',          unit: '%',   dec: 1, maxVal: 100,
                 title: 'Industry by Breadth (% Above 20 SMA)',
                 tip: 'Percentage of stocks trading above their 20-day Simple Moving Average. Higher breadth = broader participation in the rally.' },
  mcap:        { key: 'totalMcap',        unit: ' Cr', dec: 0, maxVal: null,
                 title: 'Industry by Market Capitalisation',
                 tip: 'Total market capitalisation of all stocks in the industry, in Crores. Indicates the weight/size of the industry.' },
  turnover:    { key: 'totalTurnover',    unit: ' Cr', dec: 0, maxVal: null,
                 title: 'Industry by Total Turnover',
                 tip: 'Total traded turnover (value) of the industry in Crores. Higher turnover = more liquidity and market interest.' },
  avg_dist52h: { key: 'avgDist52H',       unit: '%',   dec: 1, maxVal: null,
                 title: 'Industry by Avg Distance from 52-Week High',
                 tip: 'Average % distance of stocks from their 52-week high. Closer to 0% = near highs; large negative = beaten down.' },
  stocks:      { key: 'stockCount',       unit: '',    dec: 0, maxVal: null,
                 title: 'Industry by Number of Stocks',
                 tip: 'Number of listed stocks in the industry that pass the current filters.' },
  money_flow:  { key: 'moneyFlowChg',     unit: '%',   dec: 1, maxVal: null,
                 title: 'Industry by Money Flow Change',
                 tip: 'Percentage change in cumulative turnover vs the prior equivalent period. Positive = more money flowing in than before; negative = declining interest.' }
};

// ── Horizontal Bar Chart (adapts to selected metric) ──
function renderMetricChart(data, sortBy, mfPeriod, mfData) {
  const cfg = { ...METRIC_CONFIG[sortBy] || METRIC_CONFIG.rs_score };

  // Append period to money_flow title
  if (sortBy === 'money_flow') {
    const periodLabel = { '1w': 'Last 1 Week', '1m': 'Last 1 Month', '3m': 'Last 3 Months', '6m': 'Last 6 Months', '1y': 'Last 1 Year' }[mfPeriod] || 'Last 6 Months';
    const daysInfo = mfData ? ' (' + mfData.currentDays + ' vs ' + mfData.prevDays + ' trading days)' : '';
    cfg.title = 'Money Flow Change — ' + periodLabel + daysInfo;
  }

  // Update chart heading and tooltip
  const heading = document.getElementById('industryChartTitle');
  if (heading) {
    heading.textContent = cfg.title;
    heading.title = cfg.tip;
  }
  const tipEl = document.getElementById('industryChartTip');
  if (tipEl) tipEl.textContent = cfg.tip;

  const canvas = document.getElementById('rsChart');
  const ctx = canvas.getContext('2d');
  const barH = 22;
  const gap = 4;
  const margin = { top: 10, right: 110, bottom: 20, left: 220 };
  const totalH = margin.top + margin.bottom + data.length * (barH + gap);
  const W = Math.max(canvas.parentElement.clientWidth, window.innerWidth - 80, 500);

  canvas.width = W;
  canvas.height = totalH;

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, W, totalH);

  const plotW = W - margin.left - margin.right;

  // Determine max value for scaling
  let maxAbs = cfg.maxVal;
  if (maxAbs === null) {
    maxAbs = Math.max(...data.map(d => Math.abs(d[cfg.key])));
    if (maxAbs === 0) maxAbs = 1;
  }

  // Reset bar regions for hover/click
  _chartBars = [];

  data.forEach((ind, i) => {
    const y = margin.top + i * (barH + gap);
    const val = ind[cfg.key];
    const ratio = Math.abs(val) / maxAbs;
    const barW = Math.max(ratio * plotW, 1);

    // Store bar region for interactivity
    _chartBars.push({ x: 0, y, w: W, h: barH, ind });

    // Color logic
    let color;
    if (sortBy === 'rs_score') {
      color = val >= 70 ? '#05df72' : val >= 40 ? '#ffb900' : '#f87171';
    } else if (sortBy === 'avg_change' || sortBy === 'money_flow') {
      color = val >= 0 ? '#05df72' : '#f87171';
    } else if (sortBy === 'breadth') {
      color = val >= 50 ? '#05df72' : val >= 30 ? '#ffb900' : '#f87171';
    } else if (sortBy === 'avg_dist52h') {
      color = val >= -10 ? '#05df72' : val >= -25 ? '#ffb900' : '#f87171';
    } else {
      color = '#ffb900';
    }

    // Background track
    ctx.fillStyle = color + '1a';
    ctx.fillRect(margin.left, y, plotW, barH);

    // Filled bar
    ctx.fillStyle = color;
    ctx.fillRect(margin.left, y, barW, barH);

    // Industry label
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const label = ind.name.length > 28 ? ind.name.slice(0, 26) + '..' : ind.name;
    ctx.fillText(label, margin.left - 8, y + barH / 2);

    // Value label
    let dispVal;
    if (sortBy === 'money_flow') {
      const sign = val >= 0 ? '+' : '';
      dispVal = sign + val.toFixed(1) + '%  (' + fmtCr(ind.moneyFlow) + ' vs ' + fmtCr(ind.moneyFlowPrev) + ')';
    } else if (sortBy === 'mcap' || sortBy === 'turnover') {
      dispVal = fmtCr(val);
    } else {
      dispVal = val.toFixed(cfg.dec) + cfg.unit;
    }
    ctx.fillStyle = color;
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(dispVal, margin.left + barW + 6, y + barH / 2);
  });

  // Vertical gridlines
  ctx.strokeStyle = '#33415566';
  ctx.lineWidth = 1;
  const gridSteps = 4;
  for (let step = 0; step <= gridSteps; step++) {
    const frac = step / gridSteps;
    const x = margin.left + frac * plotW;
    ctx.beginPath();
    ctx.moveTo(x, margin.top - 5);
    ctx.lineTo(x, totalH - margin.bottom);
    ctx.stroke();

    let gridLabel;
    if (sortBy === 'mcap' || sortBy === 'turnover') {
      gridLabel = fmtCr(frac * maxAbs);
    } else {
      gridLabel = (frac * maxAbs).toFixed(cfg.maxVal !== null ? 0 : cfg.dec);
      if (cfg.unit === '%') gridLabel += '%';
    }
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(gridLabel, x, totalH - 5);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS TOOLTIP — shows stock count + market cap on hover
// ═══════════════════════════════════════════════════════════════════════════════
(function() {
  let _tooltipEl = null;

  function getTooltip() {
    if (!_tooltipEl) {
      _tooltipEl = document.createElement('div');
      _tooltipEl.id = 'indChartTooltip';
      _tooltipEl.style.cssText =
        'position:fixed;pointer-events:none;z-index:9999;display:none;' +
        'background:#1e293b;border:1px solid #334155;border-radius:6px;padding:8px 12px;' +
        'font-size:12px;color:#f1f5f9;box-shadow:0 4px 12px rgba(0,0,0,.5);max-width:280px;line-height:1.5;';
      document.body.appendChild(_tooltipEl);
    }
    return _tooltipEl;
  }

  function findBar(e) {
    const canvas = document.getElementById('rsChart');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = mx * scaleX;
    const cy = my * scaleY;
    for (const bar of _chartBars) {
      if (cx >= bar.x && cx <= bar.x + bar.w && cy >= bar.y && cy <= bar.y + bar.h) {
        return bar;
      }
    }
    return null;
  }

  document.addEventListener('mousemove', function(e) {
    const canvas = document.getElementById('rsChart');
    if (!canvas || !canvas.contains(e.target) && e.target !== canvas) {
      getTooltip().style.display = 'none';
      return;
    }
    const bar = findBar(e);
    if (!bar) {
      getTooltip().style.display = 'none';
      canvas.style.cursor = 'default';
      return;
    }
    canvas.style.cursor = 'pointer';
    const ind = bar.ind;
    const tip = getTooltip();
    tip.innerHTML =
      '<div style="font-weight:600;margin-bottom:4px;color:#fff;">' + ind.name + '</div>' +
      '<div style="color:#94a3b8;font-size:11px;margin-bottom:4px;">' + ind.sector + '</div>' +
      '<div>Stocks: <b>' + ind.stockCount + '</b></div>' +
      '<div>Mkt Cap: <b>' + fmtCr(ind.totalMcap) + '</b></div>' +
      '<div>Breadth: <b>' + ind.breadth.toFixed(0) + '%</b> &nbsp; RS: <b>' + ind.rsScore.toFixed(0) + '</b></div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">Click to view stocks</div>';
    tip.style.display = 'block';
    // Position near cursor
    const tx = e.clientX + 14;
    const ty = e.clientY - 10;
    tip.style.left = Math.min(tx, window.innerWidth - 300) + 'px';
    tip.style.top = Math.min(ty, window.innerHeight - 140) + 'px';
  });

  document.addEventListener('mouseout', function(e) {
    if (e.target && e.target.id === 'rsChart') {
      getTooltip().style.display = 'none';
    }
  });

  // ── Click on chart bar opens the industry charts modal ──
  document.addEventListener('click', function(e) {
    const canvas = document.getElementById('rsChart');
    if (!canvas || e.target !== canvas) return;
    const bar = findBar(e);
    if (bar) openIndustryCharts(bar.ind.name);
  });
})();

// ═══════════════════════════════════════════════════════════════════════════════
// MONEY FLOW — ALL PERIODS TABLE (1W/1M/3M/6M/1Y side by side, per industry)
// ═══════════════════════════════════════════════════════════════════════════════
const MF_ALL_PERIODS = ['1w', '1m', '3m', '6m', '1y'];
const MF_ALL_PERIOD_LABELS = { '1w': '1W', '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y' };

let mfAllSortCol = '1m';
let mfAllSortDir = -1;
let _mfAllPeriodsData = [];
let _mfAllPeriodTrack = null; // last mfPeriod the sort column was auto-synced to

// % change: (current - previous) / previous * 100, same convention as the
// single-period table (computeIndustryMoneyFlow's current/previous windows).
function mfPctChange(cur, prev) {
  if (prev > 0) return ((cur - prev) / prev) * 100;
  if (cur > 0) return 100;
  return 0;
}

function computeAllPeriodsMoneyFlow(minStocks, minMcap) {
  const flowByPeriod = {};
  MF_ALL_PERIODS.forEach(p => { flowByPeriod[p] = computeIndustryMoneyFlow(p); });

  const industries = {};
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const ind = s.industry || 'Undefined-Diversified';
    if (!industries[ind]) {
      industries[ind] = { name: ind, sector: s.sector || '-', stockCount: 0, totalMcap: 0, periods: {} };
      MF_ALL_PERIODS.forEach(p => { industries[ind].periods[p] = { cur: 0, prev: 0 }; });
    }
    industries[ind].stockCount++;
    industries[ind].totalMcap += (s.marketCap || 0);
    MF_ALL_PERIODS.forEach(p => {
      industries[ind].periods[p].cur += (flowByPeriod[p].current[key] || 0);
      industries[ind].periods[p].prev += (flowByPeriod[p].previous[key] || 0);
    });
  }

  let list = Object.values(industries);
  MF_ALL_PERIODS.forEach(p => {
    list.forEach(ind => { ind.periods[p].chg = mfPctChange(ind.periods[p].cur, ind.periods[p].prev); });
  });

  list = list.filter(i => i.stockCount >= (minStocks || 1));
  if (minMcap > 0) list = list.filter(i => i.totalMcap >= minMcap);

  return list;
}

function sortMfAllPeriods(key) {
  if (mfAllSortCol === key) { mfAllSortDir *= -1; }
  else { mfAllSortCol = key; mfAllSortDir = key === 'name' || key === 'sector' ? 1 : -1; }
  renderMoneyFlowAllPeriodsTable(_mfAllPeriodsData);
}

function renderMoneyFlowAllPeriodsTable(data) {
  _mfAllPeriodsData = data;

  // Period columns sort by % change (where money is flowing in/out fastest), not raw Cr size.
  const sortVal = ind => MF_ALL_PERIODS.includes(mfAllSortCol) ? ind.periods[mfAllSortCol].chg : ind[mfAllSortCol];
  const sorted = [...data].sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    if (typeof va === 'string') return mfAllSortDir * va.localeCompare(vb);
    return mfAllSortDir * (va - vb);
  });

  const cols = [
    { key: 'name', label: 'Industry' },
    { key: 'sector', label: 'Sector' },
    { key: 'stockCount', label: 'Stocks' },
    { key: 'totalMcap', label: 'Mkt Cap (Cr)' },
    ...MF_ALL_PERIODS.map(p => ({ key: p, label: `${MF_ALL_PERIOD_LABELS[p]} (Cr)` }))
  ];

  document.getElementById('mfAllPeriodsHead').innerHTML = cols.map(c =>
    `<th onclick="sortMfAllPeriods('${c.key}')" style="cursor:pointer">${c.label}<span class="sort-arrow">${mfAllSortCol === c.key ? (mfAllSortDir > 0 ? '▲' : '▼') : ''}</span></th>`
  ).join('');

  document.getElementById('mfAllPeriodsBody').innerHTML = sorted.map(ind => `
    <tr>
      <td style="font-weight:600;cursor:pointer" onclick="openIndustryCharts('${ind.name.replace(/'/g, "\\'")}')">${ind.name}</td>
      <td style="color:var(--text2)">${ind.sector}</td>
      <td>${ind.stockCount}</td>
      <td>${fmtCr(ind.totalMcap)}</td>
      ${MF_ALL_PERIODS.map(p => {
        const { cur, chg } = ind.periods[p];
        const cls = chg >= 0 ? 'positive' : 'negative';
        const sign = chg >= 0 ? '+' : '';
        return `<td>${fmtCr(cur)} <span class="${cls}" style="font-size:11px;">(${sign}${chg.toFixed(1)}%)</span></td>`;
      }).join('')}
    </tr>`
  ).join('');
}

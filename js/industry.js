// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRY — industry-level analysis, RS scoring, and charts
// ═══════════════════════════════════════════════════════════════════════════════

const MF_PERIOD_DAYS = { '1w': 5, '1m': 21, '3m': 63, '6m': 126, '1y': 250 };

// ── Money Flow Rate of Change: ROC timeframe (lag) ──
// The ROC compares the MF Chg% reading now against the same reading `lag` ago. The lag
// can be any timeframe equal to or shorter than the Money Flow window (window itself =
// the original behaviour), so a 6M window can be read against 1W, 1M, 3M or 6M ago.
const MF_ROC_LAGS = ['1w', '1m', '3m', '6m', '1y'];

// Lag keys valid for a window, shortest first.
function mfRocValidLags(period) {
  const n = MF_PERIOD_DAYS[period] || 126;
  return MF_ROC_LAGS.filter(k => MF_PERIOD_DAYS[k] <= n);
}

// The lag to use: the requested one if it fits the window, else the window's own length.
function mfRocResolveLag(period, lag) {
  return mfRocValidLags(period).includes(lag) ? lag : (MF_PERIOD_DAYS[period] ? period : '6m');
}

// Disables lag <option>s longer than the selected window and snaps an invalid selection
// down to the longest valid one. Options stay in the DOM (rather than being rebuilt) so
// a preset can set the lag select's value before or after the window's.
function mfRocSyncLagSelect(periodSelId, lagSelId) {
  const periodSel = document.getElementById(periodSelId);
  const lagSel = document.getElementById(lagSelId);
  if (!periodSel || !lagSel) return;
  const valid = mfRocValidLags(periodSel.value);
  for (const opt of lagSel.options) {
    opt.disabled = opt.hidden = !valid.includes(opt.value);
  }
  lagSel.value = mfRocResolveLag(periodSel.value, lagSel.value);
}

// ── Compute industry money flow for current and previous period ──
// endOffsetDays > 0 shifts the "current" anchor back that many trading days,
// so the same window/previous-window comparison can be replayed as of a past
// date - used for the Money Flow Rate of Change filter (see renderIndustryAnalysis).
function computeIndustryMoneyFlow(period, endOffsetDays = 0) {
  const numDays = MF_PERIOD_DAYS[period] || 126;
  const totalAvail = Store.dates.length - endOffsetDays;
  if (totalAvail <= 0) return { current: {}, previous: {}, currentDays: 0, prevDays: 0 };

  // Current period = last numDays trading days as of the (possibly shifted) anchor
  const currentDates = Store.dates.slice(Math.max(0, totalAvail - numDays), totalAvail);
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

// Money Flow Rate of Change per industry, for the Scanner's F17 filter: the industry's
// MF Chg% reading over `period` now, minus that same reading as of `lag` ago (`lag` is
// the window itself or any shorter timeframe, see mfRocResolveLag). Returns
// { industryName: pp }. Industries are grouped from Store.latestBySymbol, the same way
// the Industry Analysis tab does it.
function computeIndustryMoneyFlowRocMap(period, lag) {
  const mfNow = computeIndustryMoneyFlow(period);
  const mfPast = computeIndustryMoneyFlow(period, MF_PERIOD_DAYS[mfRocResolveLag(period, lag)]);
  const flowsNow = {}, flowsPast = {};
  for (const key in Store.latestBySymbol) {
    const ind = Store.latestBySymbol[key].industry || 'Undefined-Diversified';
    if (!flowsNow[ind]) flowsNow[ind] = { current: 0, prev: 0 };
    if (!flowsPast[ind]) flowsPast[ind] = { current: 0, prev: 0 };
    flowsNow[ind].current += (mfNow.current[key] || 0);
    flowsNow[ind].prev += (mfNow.previous[key] || 0);
    flowsPast[ind].current += (mfPast.current[key] || 0);
    flowsPast[ind].prev += (mfPast.previous[key] || 0);
  }
  const roc = {};
  for (const ind in flowsNow) {
    roc[ind] = mfPctChange(flowsNow[ind].current, flowsNow[ind].prev)
      - mfPctChange(flowsPast[ind].current, flowsPast[ind].prev);
  }
  return roc;
}

// ── IPOs listed per industry (Sort By -> IPOs Listed) ──
// A stock counts when its NSE listing date (EQUITY_L.csv via Store.latestBySymbol[].listingDate) falls after the
// same date N calendar months before the latest data date, up to and including it. That is "new NSE listings":
// IPOs plus any demerger / SME-migration listings. A listing date shared by IPO_BULK_DAY_MIN or more stocks is a
// bulk admission of already-listed companies to NSE (live data: 102 on one day in Apr-2026 and 136 in Aug-2026,
// vs. at most 6 on any ordinary day), not a run of IPOs, so those days are left out - EXCEPT stocks whose
// listing-day turnover was IPO-scale (>= IPO_BULK_KEEP_TURNOVER_CR): a genuine IPO can list on the same day
// (MOLBIO and DHOOTTRANS did, trading Rs 1,586 Cr and Rs 3,586 Cr on day one, while the other 234 bulk-admitted
// companies never passed Rs 29 Cr).
const IPO_PERIOD_MONTHS = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 };
const IPO_PERIOD_LABELS = { '1m': 'Last 1 Month', '3m': 'Last 3 Months', '6m': 'Last 6 Months', '1y': 'Last 1 Year' };
const IPO_PERIOD_SHORT = { '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y' };
const IPO_BULK_DAY_MIN = 20;
const IPO_BULK_KEEP_TURNOVER_CR = 100;

// Turnover (Rs Cr; the data is in lakhs) on a stock's listing day, 0 when that bar isn't there. The listing day
// is the stock's first bar, so only the first few are looked at.
function listingDayTurnoverCr(key, listingDate) {
  const days = (Store.dailyBySymbol || {})[key];
  if (!days) return 0;
  for (let i = 0; i < days.length && i < 5; i++) {
    if (listingDateToIso(days[i].date) === listingDate) return (days[i].turnover || 0) / 100;
  }
  return 0;
}

// 'YYYY-MM-DD' minus whole calendar months, clamping the day (31-Mar minus 1 month = 28/29-Feb). '' when unreadable.
function isoMinusMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const total = parseInt(m[1], 10) * 12 + (parseInt(m[2], 10) - 1) - months;
  const y = Math.floor(total / 12), mo = total % 12;
  const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(Math.min(parseInt(m[3], 10), daysInMonth)).padStart(2, '0')}`;
}

// { from, to, bulkDays, counts(stock, key) } for a period key; a listing counts when from < date <= to and either
// its day is not a bulk day or the stock traded like an IPO that day. bulkDays = the bulk days inside the window,
// [{date, count, kept: [symbols counted anyway]}]. `to` is '' when there is no data yet.
function ipoWindow(period) {
  const dates = Store.dates || [];
  const to = dates.length ? listingDateToIso(dates[dates.length - 1]) : '';
  const from = to ? isoMinusMonths(to, IPO_PERIOD_MONTHS[period] || 3) : '';
  const perDay = {};
  for (const key in Store.latestBySymbol) {
    const d = Store.latestBySymbol[key].listingDate;
    if (d) perDay[d] = (perDay[d] || 0) + 1;
  }
  const bulkSet = new Set(Object.keys(perDay).filter(d => perDay[d] >= IPO_BULK_DAY_MIN));
  const keptAnyway = (s, key) => listingDayTurnoverCr(key, s.listingDate) >= IPO_BULK_KEEP_TURNOVER_CR;
  const counts = (s, key) => {
    if (!(to && s.listingDate && s.listingDate > from && s.listingDate <= to)) return false;
    return !bulkSet.has(s.listingDate) || keptAnyway(s, key);
  };
  const bulkDays = [...bulkSet].filter(d => d > from && d <= to).sort().map(date => {
    const kept = [];
    for (const key in Store.latestBySymbol) {
      const s = Store.latestBySymbol[key];
      if (s.listingDate === date && keptAnyway(s, key)) kept.push(s.symbol);
    }
    return { date, count: perDay[date], kept: kept.sort() };
  });
  return { from, to, bulkDays, counts };
}

const IND_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function isoToDmy(iso) { // '2026-04-20' -> '20-Apr-2026'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}-${IND_MONTH_NAMES[parseInt(m[2], 10) - 1]}-${m[1]}` : (iso || '');
}

// ── Last render's industry list ──
let _chartData = [];   // the filtered, sorted industry list of the last render (the table and heatmap draw from it; tests read it)

function renderIndustryAnalysis() {
  const minStocks = parseInt(document.getElementById('indMinStocks').value) || 1;
  const minMcap = parseNum(document.getElementById('indMinMcap').value) || 0;
  const sortBy = document.getElementById('industrySort').value;
  const mfPeriod = document.getElementById('moneyFlowPeriod').value;
  const isRoc = sortBy === 'money_flow_roc';
  const mfRocPeriod = document.getElementById('mfRocPeriod').value;
  const effectivePeriod = isRoc ? mfRocPeriod : mfPeriod;
  const isIpo = sortBy === 'ipo';
  const isEw = sortBy === 'ew_sma';
  const ewLens = isEw ? indEwLens() : [];
  const ewGroup = document.getElementById('ewSmaGroup');
  if (ewGroup) ewGroup.style.display = isEw ? '' : 'none';
  const ipoPeriod = ((document.getElementById('ipoPeriod') || {}).value) || '3m';
  const ipoWin = ipoWindow(ipoPeriod);
  const ipoGroup = document.getElementById('ipoPeriodGroup');
  if (ipoGroup) ipoGroup.style.display = isIpo ? '' : 'none';
  mfRocSyncLagSelect('mfRocPeriod', 'mfRocLag');
  const mfRocLag = mfRocResolveLag(mfRocPeriod, document.getElementById('mfRocLag').value);

  // Show/hide money flow period dropdown + all-periods toggle
  const mfGroup = document.getElementById('mfPeriodGroup');
  if (mfGroup) mfGroup.style.display = sortBy === 'money_flow' ? '' : 'none';
  const mfAllGroup = document.getElementById('mfAllPeriodsGroup');
  if (mfAllGroup) mfAllGroup.style.display = sortBy === 'money_flow' ? '' : 'none';
  const mfRocGroup = document.getElementById('mfRocPeriodGroup');
  if (mfRocGroup) mfRocGroup.style.display = isRoc ? '' : 'none';
  const mfRocLagGroup = document.getElementById('mfRocLagGroup');
  if (mfRocLagGroup) mfRocLagGroup.style.display = isRoc ? '' : 'none';

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

  // Compute money flow per symbol for current and previous period. In ROC mode,
  // also replay the same window/previous-window comparison as of the ROC timeframe
  // ago, so we can compare "MF Chg% now" against "MF Chg% back then" per industry.
  const mfData = computeIndustryMoneyFlow(effectivePeriod);
  const mfPastData = isRoc ? computeIndustryMoneyFlow(effectivePeriod, MF_PERIOD_DAYS[mfRocLag]) : null;

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
      moneyFlowPastCurrent: 0, moneyFlowPastPrev: 0,
      ipoStocks: [],
      sector: s.sector || '-'
    };
    industries[ind].stocks.push(s);
    if (ipoWin.counts(s, key)) industries[ind].ipoStocks.push(s);
    industries[ind].totalTurnover += (s.turnover || 0);
    industries[ind].totalMonthlyChange += (s.monthlyChangePct || 0);
    industries[ind].totalMcap += (s.marketCap || 0);
    industries[ind].totalDistFrom52H += (s.distFrom52H || 0);
    if (!isNaN(s.distFromSMA)) industries[ind].totalDistFromSMA += s.distFromSMA;
    if (s.aboveSMA) industries[ind].above++;
    else industries[ind].below++;
    industries[ind].moneyFlowCurrent += (mfData.current[key] || 0);
    industries[ind].moneyFlowPrev += (mfData.previous[key] || 0);
    if (isRoc) {
      industries[ind].moneyFlowPastCurrent += (mfPastData.current[key] || 0);
      industries[ind].moneyFlowPastPrev += (mfPastData.previous[key] || 0);
    }
  }

  // Build industry list with computed metrics
  let indList = Object.entries(industries).map(([name, data]) => {
    const n = data.stocks.length;
    const avgMonthlyChange = data.totalMonthlyChange / n;
    const breadth = n > 0 ? (data.above / n * 100) : 0;
    const avgDist52H = data.totalDistFrom52H / n;
    const avgDistSMA = data.totalDistFromSMA / n;

    // Money flow % change: (current - previous) / previous * 100
    const moneyFlowChg = mfPctChange(data.moneyFlowCurrent, data.moneyFlowPrev);

    // Rate of change: the same MF Chg% reading, one ROC timeframe ago, vs now.
    // Positive = the reading has been climbing (improving) even if still negative;
    // negative = it's been sliding (fading) even if still positive.
    const moneyFlowChgPast = isRoc ? mfPctChange(data.moneyFlowPastCurrent, data.moneyFlowPastPrev) : 0;
    const moneyFlowRoc = isRoc ? (moneyFlowChg - moneyFlowChgPast) : 0;

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
      moneyFlowChgPast,
      moneyFlowRoc,
      ipoCount: data.ipoStocks.length,
      // newest listing first, symbols only - for the chart tooltip and the table
      ipoSymbols: [...data.ipoStocks]
        .sort((a, b) => b.listingDate.localeCompare(a.listingDate) || a.symbol.localeCompare(b.symbol))
        .map(x => x.symbol),
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

  // EW Chart Above SMA: keep the industries whose equal-weight index closes above EVERY ticked SMA (after the RS scores, so those stay
  // what the other views show). The index and its SMAs are js/group-trend.js's gtGroupMap - the same figures as the Stock Scanner's F38.
  if (isEw) {
    const ew = typeof gtGroupMap === 'function' ? gtGroupMap('industry') : {};
    indList.forEach(i => {
      const g = ew[i.name];
      for (const len of IND_EW_LENGTHS) i['ewDist' + len] = g && g.sma[len] > 0 ? (g.close / g.sma[len] - 1) * 100 : NaN;
    });
    indList = indList.filter(i => ewLens.every(len => i['ewDist' + len] > 0));
  }

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
    case 'money_flow_roc': indList.sort((a, b) => b.moneyFlowRoc - a.moneyFlowRoc); break;
    // ties (most industries have 0-2) go to the stronger industry
    case 'ipo': indList.sort((a, b) => (b.ipoCount - a.ipoCount) || (b.rsScore - a.rsScore)); break;
    // furthest above the longest ticked SMA first
    case 'ew_sma': { const k = 'ewDist' + ewLens[ewLens.length - 1]; indList.sort((a, b) => b[k] - a[k]); break; }
  }

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

  // ── What the Sort By metric means: the line above the Industry Breakdown table (the IPO view also names the bulk days left out) ──
  const ipoInfo = isIpo ? { period: ipoPeriod, from: ipoWin.from, to: ipoWin.to, bulkDays: ipoWin.bulkDays } : null;
  renderMetricNote(sortBy, effectivePeriod, mfData, mfRocLag, ipoInfo, ewLens);

  // ── Industry Table (all filtered industries; manual header sort layered on the filter order) ──
  // A manual column sort only lasts until the Sort By metric / MF period changes, so picking a
  // new Sort By always brings the table back in step with the Sort By metric.
  const sortTrack = sortBy === 'money_flow_roc' ? sortBy + '|' + effectivePeriod + '|' + mfRocLag
    : sortBy === 'money_flow' ? sortBy + '|' + effectivePeriod
    : isIpo ? sortBy + '|' + ipoPeriod
    : isEw ? sortBy + '|' + ewLens.join() : sortBy;
  if (sortTrack !== _indSortTrack) {
    _indSortTrack = sortTrack;
    indSortCol = null;
  }
  const periodLabels = { '1w': '1W', '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y' };
  _indBreakdown = {
    list: indList,
    sortBy,
    sortLabel: document.getElementById('industrySort').selectedOptions[0].textContent,
    mfLabel: periodLabels[effectivePeriod] || '6M',
    isRoc,
    rocPeriodLabel: periodLabels[mfRocLag] || '3M',
    ipoLabel: isIpo ? (IPO_PERIOD_SHORT[ipoPeriod] || '3M') : null,
    ewLens
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
    const rocRow = isRoc
      ? `<tr><td style="color:var(--text2)">MF RoC</td><td style="text-align:right;color:${ind.moneyFlowRoc >= 0 ? 'var(--green)' : 'var(--red)'}">${ind.moneyFlowRoc >= 0 ? '+' : ''}${ind.moneyFlowRoc.toFixed(1)}pp</td></tr>`
      : '';
    return `
      <div class="sector-card" style="background:${bg};border-color:${border};cursor:pointer;" onclick="openIndustryCharts('${ind.name.replace(/'/g, "\\'")}', _indBreakdownNames)">
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
          ${rocRow}
          ${isIpo ? `<tr><td style="color:var(--text2)">IPOs ${IPO_PERIOD_SHORT[ipoPeriod] || ''}</td><td style="text-align:right;font-weight:600">${ind.ipoCount}</td></tr>` : ''}
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

// EW Chart Above SMA view: the SMAs offered (20 is the default, at least one is always ticked) and the extra columns
const IND_EW_LENGTHS = [20, 50];
function indEwLens() {
  const on = id => { const e = document.getElementById(id); return !!(e && e.checked); };
  let lens = IND_EW_LENGTHS.filter(len => on('ewSma' + len));
  if (!lens.length) {
    const e = document.getElementById('ewSma20');
    if (e) e.checked = true;
    lens = [20];
  }
  return lens;
}

function indBreakdownCols(mfLabel, isRoc, rocPeriodLabel, ipoLabel, ewLens) {
  const cols = [
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
    { key: 'moneyFlowChg', label: 'MF Chg%' }
  ];
  if (ipoLabel) {
    // right after the Stocks column
    cols.splice(4, 0,
      { key: 'ipoCount', label: `IPOs (${ipoLabel})` },
      { key: 'ipoSymbols', label: 'Listed', get: i => i.ipoSymbols.join(', ') }
    );
  }
  if (ewLens && ewLens.length) {
    // right after Breadth
    cols.splice(7, 0, ...ewLens.map(len => ({ key: 'ewDist' + len, label: `EW vs ${len} SMA` })));
  }
  if (isRoc) {
    cols.push(
      { key: 'moneyFlowChgPast', label: `MF Chg% (${rocPeriodLabel} ago)` },
      { key: 'moneyFlowRoc', label: 'MF Rate of Change' }
    );
  }
  cols.push(
    { key: 'topGainer', label: 'Top 1M Gainer', get: i => i.topGainer ? i.topGainer.monthlyChangePct : null },
    { key: 'topLoser', label: 'Top 1M Loser', get: i => i.topLoser ? i.topLoser.monthlyChangePct : null }
  );
  return cols;
}

function indDefaultSort() {
  const ew = _indBreakdown.sortBy === 'ew_sma' && _indBreakdown.ewLens && _indBreakdown.ewLens.length ? _indBreakdown.ewLens : null;
  const col = ew ? 'ewDist' + ew[ew.length - 1] : (METRIC_CONFIG[_indBreakdown.sortBy] || METRIC_CONFIG.rs_score).key;
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

// "Copy industries": the names the table lists (so Min Stocks / Min Market Cap are applied) as one comma-separated line - for the Stock Scanner's Industry picker
function copyBreakdownIndustries() {
  return copyNamesToClipboard(_indBreakdownNames, document.getElementById('indBreakdownCopy'));
}

function resetIndustryBreakdownSort() {
  indSortCol = null;
  renderIndustryBreakdownTable();
}

// The two extra cells of the IPO view: how many, and which (newest first).
// The EW view's cells: how far the industry's equal-weight index is above (green) / below (red) each ticked SMA
function ewCells(ind, ewLens) {
  return (ewLens || []).map(len => {
    const v = ind['ewDist' + len];
    return isNaN(v) ? '<td>-</td>' : `<td style="color:${v > 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">${v > 0 ? '+' : ''}${v.toFixed(1)}%</td>`;
  }).join('');
}

function ipoCells(ind, ipoLabel) {
  if (!ipoLabel) return '';
  const syms = ind.ipoSymbols.map(x => x.replace(/&/g, '&amp;')).join(', ');
  return `
      <td style="font-weight:600">${ind.ipoCount}</td>
      <td style="color:var(--text2);font-size:11px;white-space:normal;min-width:160px;">${syms || '-'}</td>`;
}

let _indBreakdownNames = [];   // the industries the Breakdown table lists now, in the order shown (what "Copy industries" copies)

function renderIndustryBreakdownTable() {
  const { list, sortLabel, mfLabel, isRoc, rocPeriodLabel, ipoLabel, ewLens } = _indBreakdown;
  const cols = indBreakdownCols(mfLabel, isRoc, rocPeriodLabel, ipoLabel, ewLens);
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

  _indBreakdownNames = sorted.map(i => i.name);

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
    const rocCells = isRoc ? `
      <td style="color:var(--text2)">${ind.moneyFlowChgPast >= 0 ? '+' : ''}${ind.moneyFlowChgPast.toFixed(1)}%</td>
      <td style="color:${ind.moneyFlowRoc >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">${ind.moneyFlowRoc >= 0 ? '+' : ''}${ind.moneyFlowRoc.toFixed(1)}pp</td>` : '';
    return `
    <tr style="cursor:pointer" onclick="openIndustryCharts('${ind.name.replace(/'/g, "\\'")}', _indBreakdownNames)">
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
      <td>${ind.stockCount}</td>${ipoCells(ind, ipoLabel)}
      <td>${fmtCr(ind.totalMcap)}</td>
      <td class="${ind.avgMonthlyChange >= 0 ? 'positive' : 'negative'}">${ind.avgMonthlyChange.toFixed(2)}%</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;height:8px;background:var(--red);border-radius:4px;overflow:hidden;">
            <div style="width:${ind.breadth}%;height:100%;background:var(--green);"></div>
          </div>
          <span style="font-size:11px;min-width:35px;">${ind.breadth.toFixed(0)}%</span>
        </div>
      </td>${ewCells(ind, ewLens)}
      <td>${ind.avgDist52H.toFixed(1)}%</td>
      <td>${fmtTurnoverCr(ind.totalTurnover)}</td>
      <td>${fmtCr(ind.moneyFlow)}</td>
      <td style="color:var(--text2)">${fmtCr(ind.moneyFlowPrev)}</td>
      <td style="color:${mfChgColor};font-weight:600">${mfChgSign}${ind.moneyFlowChg.toFixed(1)}%</td>${rocCells}
      <td class="positive">${ind.topGainer ? ind.topGainer.symbol + ' (' + fmtPct(ind.topGainer.monthlyChangePct) + ')' : '-'}</td>
      <td class="negative">${ind.topLoser ? ind.topLoser.symbol + ' (' + fmtPct(ind.topLoser.monthlyChangePct) + ')' : '-'}</td>
    </tr>`;
  }).join('');
}

// ── Metric config: the table column each Sort By metric orders by (key), and what it means (title / tip) ──
const METRIC_CONFIG = {
  rs_score:    { key: 'rsScore',
                 title: 'Industry Relative Strength',
                 tip: 'Composite score (0-100) combining breadth (40%), avg monthly change rank (30%), and proximity to 52-week high (30%). Higher = stronger industry.' },
  avg_change:  { key: 'avgMonthlyChange',
                 title: 'Industry by Avg Monthly Change %',
                 tip: 'Average 1-month price change across all stocks in the industry. Positive = industry trending up over the past month.' },
  breadth:     { key: 'breadth',
                 title: 'Industry by Breadth (% Above 20 SMA)',
                 tip: 'Percentage of stocks trading above their 20-day Simple Moving Average. Higher breadth = broader participation in the rally.' },
  mcap:        { key: 'totalMcap',
                 title: 'Industry by Market Capitalisation',
                 tip: 'Total market capitalisation of all stocks in the industry, in Crores. Indicates the weight/size of the industry.' },
  turnover:    { key: 'totalTurnover',
                 title: 'Industry by Total Turnover',
                 tip: 'Total traded turnover (value) of the industry in Crores. Higher turnover = more liquidity and market interest.' },
  avg_dist52h: { key: 'avgDist52H',
                 title: 'Industry by Avg Distance from 52-Week High',
                 tip: 'Average % distance of stocks from their 52-week high. Closer to 0% = near highs; large negative = beaten down.' },
  stocks:      { key: 'stockCount',
                 title: 'Industry by Number of Stocks',
                 tip: 'Number of listed stocks in the industry that pass the current filters.' },
  money_flow:  { key: 'moneyFlowChg',
                 title: 'Industry by Money Flow Change',
                 tip: 'Percentage change in cumulative turnover vs the prior equivalent period. Positive = more money flowing in than before; negative = declining interest.' },
  money_flow_roc: { key: 'moneyFlowRoc',
                 title: 'Industry by Money Flow Rate of Change',
                 tip: 'Change in the MF Chg% reading itself, comparing now to the same reading one ROC timeframe ago (in percentage points; the timeframe can be the window itself or any shorter one). Positive = the flow reading is improving even if still negative; negative = it is fading even if still positive.' },
  ipo:         { key: 'ipoCount',
                 title: 'IPOs Listed by Industry',
                 tip: 'Number of stocks whose NSE listing date falls in the selected period, per industry.' },
  ew_sma:      { key: 'ewDist20',
                 title: 'Industries with the EW Chart Above SMA',
                 tip: 'Industries whose equal-weight index (every stock\'s daily % move averaged across the industry, the Industry Chart in the chart popup) closes above the ticked SMA; with both ticked it must be above both. Ordered by how far it is above the longer SMA.' }
};

// ── The line above the Industry Breakdown table: what the Sort By metric is (title + tip) ──
function indMetricText(sortBy, mfPeriod, mfData, rocLag, ipoInfo, ewLens) {
  const cfg = { ...METRIC_CONFIG[sortBy] || METRIC_CONFIG.rs_score };

  // Append period to money_flow title
  if (sortBy === 'money_flow' || sortBy === 'money_flow_roc') {
    const periodLabel = { '1w': 'Last 1 Week', '1m': 'Last 1 Month', '3m': 'Last 3 Months', '6m': 'Last 6 Months', '1y': 'Last 1 Year' }[mfPeriod] || 'Last 6 Months';
    const daysInfo = mfData ? ' (' + mfData.currentDays + ' vs ' + mfData.prevDays + ' trading days)' : '';
    const lagInfo = sortBy === 'money_flow_roc' && rocLag ? ', vs ' + rocLag.toUpperCase() + ' ago' : '';
    cfg.title = (sortBy === 'money_flow' ? 'Money Flow Change — ' : 'Money Flow Rate of Change — ') + periodLabel + daysInfo + lagInfo;
  }

  if (sortBy === 'ipo' && ipoInfo) {
    cfg.title = 'IPOs Listed by Industry — ' + (IPO_PERIOD_LABELS[ipoInfo.period] || IPO_PERIOD_LABELS['3m']) +
      (ipoInfo.to ? ' (' + isoToDmy(ipoInfo.from) + ' to ' + isoToDmy(ipoInfo.to) + ')' : '');
    cfg.tip = 'Stocks with an NSE listing date in the period, per industry: IPOs plus any demerger or SME-migration listings; ' +
      'companies since delisted are not counted.' +
      (ipoInfo.bulkDays.length
        ? ' Left out as bulk admissions of existing companies, not IPOs: ' +
          ipoInfo.bulkDays.map(b => isoToDmy(b.date) + ' (' + (b.count - b.kept.length) + ' of ' + b.count + ' stocks)').join(', ') + '.' +
          (ipoInfo.bulkDays.some(b => b.kept.length)
            ? ' Counted anyway because they traded like IPOs on day one (turnover of Rs ' + IPO_BULK_KEEP_TURNOVER_CR + ' Cr or more): ' +
              ipoInfo.bulkDays.flatMap(b => b.kept).join(', ') + '.'
            : '')
        : '');
  }
  if (sortBy === 'ew_sma' && ewLens && ewLens.length) {
    cfg.title = 'Industries with the EW Chart Above ' + ewLens.join(' and ') + ' SMA';
  }
  return { title: cfg.title, tip: cfg.tip };
}

function renderMetricNote(sortBy, mfPeriod, mfData, rocLag, ipoInfo, ewLens) {
  const el = document.getElementById('indMetricNote');
  if (!el) return;
  const t = indMetricText(sortBy, mfPeriod, mfData, rocLag, ipoInfo, ewLens);
  el.textContent = t.title + ' — ' + t.tip;
}

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

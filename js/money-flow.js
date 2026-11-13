// ═══════════════════════════════════════════════════════════════════════════════
// MONEY FLOW — how much money (turnover) flows into each industry, and whether that flow is speeding up or fading.
//
// Two parts in this file:
//   1. The ENGINE (computeIndustryMoneyFlow, computeIndustryMoneyFlowRocMap, the lag helpers, mfPctChange,
//      computeAllPeriodsMoneyFlow). The Stock Scanner's F12 / F17 filters, its presets and the chart popup use it, so it is
//      unchanged from the Industry Analysis tab it came from.
//   2. The "Money Flow" TAB (renderMoneyFlow ...): one industry table and an all-periods table. It replaced the Industry Analysis tab
//      (RS-score heatmap, IPO and EW-SMA views, breakdown table), which was removed 2026-11-13.
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
// date - used for the Money Flow Rate of Change filter (F17) and the tab's ROC column.
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
// the Money Flow tab does it.
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

// ═════════════════════════════════════════════════════════════════
// ALL PERIODS (1W/1M/3M/6M/1Y side by side, per industry)
// ═════════════════════════════════════════════════════════════════
const MF_ALL_PERIODS = ['1w', '1m', '3m', '6m', '1y'];
const MF_ALL_PERIOD_LABELS = { '1w': '1W', '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y' };

// % change: (current - previous) / previous * 100, same convention everywhere
// (computeIndustryMoneyFlow's current/previous windows).
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

// ═════════════════════════════════════════════════════════════════
// THE MONEY FLOW TAB
// ═════════════════════════════════════════════════════════════════

// One row per industry that has at least minStocks stocks (and minMcap Cr of market cap): its money flow over `period`
// (turnover of the last N trading days, and of the N days before), the % change between them, that same % change as of `lag`
// ago, and the difference (the rate of change, in percentage points). `now` / `past` are computeIndustryMoneyFlow() results
// for the window now and `lag` ago. Industries are grouped from Store.latestBySymbol; the sector is the first stock's.
function mfBuildIndustries(minStocks, minMcap, now, past) {
  const industries = {};
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const ind = s.industry || 'Undefined-Diversified';
    if (!industries[ind]) industries[ind] = { stockCount: 0, totalMcap: 0, cur: 0, prev: 0, pastCur: 0, pastPrev: 0, sector: s.sector || '-' };
    const g = industries[ind];
    g.stockCount++;
    g.totalMcap += (s.marketCap || 0);
    g.cur += (now.current[key] || 0);
    g.prev += (now.previous[key] || 0);
    g.pastCur += (past.current[key] || 0);
    g.pastPrev += (past.previous[key] || 0);
  }
  let list = Object.entries(industries).map(([name, g]) => {
    const moneyFlowChg = mfPctChange(g.cur, g.prev);
    const moneyFlowChgPast = mfPctChange(g.pastCur, g.pastPrev);
    return { name, sector: g.sector, stockCount: g.stockCount, totalMcap: g.totalMcap,
             moneyFlow: g.cur, moneyFlowPrev: g.prev, moneyFlowChg, moneyFlowChgPast, moneyFlowRoc: moneyFlowChg - moneyFlowChgPast };
  });
  list = list.filter(i => i.stockCount >= minStocks);
  if (minMcap > 0) list = list.filter(i => i.totalMcap >= minMcap);
  return list;
}

let mfSort = { col: 'moneyFlowChg', dir: -1 };   // the industry table's order; starts on MF Chg%, highest first
let mfList = [];                                  // the rows the table shows now, in the order shown (also what Copy industries copies)
let mfAllSortCol = '6m';
let mfAllSortDir = -1;
let _mfAllPeriodsData = [];
let _mfAllPeriodTrack = null;                     // the period the all-periods table's sort column was last synced to

function mfTableCols(label, lagLabel) {
  return [
    { key: 'name', label: 'Industry', asc: true },
    { key: 'sector', label: 'Sector', asc: true },
    { key: 'stockCount', label: 'Stocks' },
    { key: 'totalMcap', label: 'Mkt Cap (Cr)' },
    { key: 'moneyFlow', label: `MF ${label} (Cr)` },
    { key: 'moneyFlowPrev', label: `Prev ${label} (Cr)` },
    { key: 'moneyFlowChg', label: 'MF Chg%' },
    { key: 'moneyFlowChgPast', label: `MF Chg% (${lagLabel} ago)` },
    { key: 'moneyFlowRoc', label: 'MF Rate of Change' },
  ];
}

function mfSortList(list, sort, cols) {
  const col = cols.find(c => c.key === sort.col) || cols[0];
  return [...list].sort((a, b) => {   // stable: ties keep the order they came in
    const va = a[col.key], vb = b[col.key];
    if (typeof va === 'string') return sort.dir * va.localeCompare(vb);
    return sort.dir * (va - vb);
  });
}

function renderMoneyFlow() {
  if (!Store.latestBySymbol || !Object.keys(Store.latestBySymbol).length) return;
  const minStocks = parseInt(document.getElementById('mfMinStocks').value) || 1;
  const minMcap = parseNum(document.getElementById('mfMinMcap').value) || 0;
  const period = document.getElementById('moneyFlowPeriod').value;
  mfRocSyncLagSelect('moneyFlowPeriod', 'mfRocLag');
  const lag = mfRocResolveLag(period, document.getElementById('mfRocLag').value);
  const label = MF_ALL_PERIOD_LABELS[period] || '6M', lagLabel = MF_ALL_PERIOD_LABELS[lag] || label;

  const now = computeIndustryMoneyFlow(period);
  const past = computeIndustryMoneyFlow(period, MF_PERIOD_DAYS[lag]);
  const list = mfBuildIndustries(minStocks, minMcap, now, past);

  const cols = mfTableCols(label, lagLabel);
  const sorted = mfSortList(list, mfSort, cols);
  mfList = sorted;

  // summary cards
  const totalStocks = list.reduce((s, i) => s + i.stockCount, 0);
  const totalMcap = list.reduce((s, i) => s + i.totalMcap, 0);
  const totalFlow = list.reduce((s, i) => s + i.moneyFlow, 0), totalPrev = list.reduce((s, i) => s + i.moneyFlowPrev, 0);
  const totalChg = mfPctChange(totalFlow, totalPrev);
  document.getElementById('mfCount').textContent = list.length;
  document.getElementById('mfStockCount').textContent = totalStocks.toLocaleString();
  document.getElementById('mfTotalMcap').textContent = fmtCr(totalMcap);
  document.getElementById('mfTotalFlow').textContent = fmtCr(totalFlow);
  document.getElementById('mfTotalFlowLabel').textContent = `Money Flow (${label}, Cr)`;
  const chgEl = document.getElementById('mfTotalChg');
  chgEl.textContent = `${totalChg >= 0 ? '+' : ''}${totalChg.toFixed(1)}% vs the ${label} before`;
  chgEl.style.color = totalChg >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('mfNote').textContent =
    `Money Flow = the turnover traded in the industry's stocks over the last ${now.currentDays} trading days (${label}); MF Chg% = how that compares with the ${now.prevDays} days before. ` +
    `Rate of Change = MF Chg% now minus the same reading ${lagLabel} ago, in percentage points: positive = the flow is picking up, negative = fading.`;

  // the industry table
  document.getElementById('mfHead').innerHTML = '<th>#</th>' + cols.map(c =>
    `<th onclick="mfSortBy('${c.key}')">${c.label}<span class="sort-arrow">${mfSort.col === c.key ? (mfSort.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('');
  document.getElementById('mfBody').innerHTML = sorted.map((ind, idx) => {
    const chgColor = ind.moneyFlowChg >= 0 ? 'var(--green)' : 'var(--red)';
    const rocColor = ind.moneyFlowRoc >= 0 ? 'var(--green)' : 'var(--red)';
    return `
    <tr class="mf-row" style="cursor:pointer" data-name="${escapeHtml(ind.name)}">
      <td>${idx + 1}</td>
      <td style="font-weight:600">${escapeHtml(ind.name)}</td>
      <td style="color:var(--text2)">${escapeHtml(ind.sector)}</td>
      <td>${ind.stockCount}</td>
      <td>${fmtCr(ind.totalMcap)}</td>
      <td>${fmtCr(ind.moneyFlow)}</td>
      <td style="color:var(--text2)">${fmtCr(ind.moneyFlowPrev)}</td>
      <td style="color:${chgColor};font-weight:600">${ind.moneyFlowChg >= 0 ? '+' : ''}${ind.moneyFlowChg.toFixed(1)}%</td>
      <td style="color:var(--text2)">${ind.moneyFlowChgPast >= 0 ? '+' : ''}${ind.moneyFlowChgPast.toFixed(1)}%</td>
      <td style="color:${rocColor};font-weight:600">${ind.moneyFlowRoc >= 0 ? '+' : ''}${ind.moneyFlowRoc.toFixed(1)}pp</td>
    </tr>`;
  }).join('');

  // the all-periods table (same Min Stocks / Min Market Cap); its sort follows the Period picker until a header is clicked
  const allOn = document.getElementById('mfAllPeriodsToggle').checked;
  document.getElementById('mfAllPeriodsSection').style.display = allOn ? '' : 'none';
  if (period !== _mfAllPeriodTrack) {
    _mfAllPeriodTrack = period;
    mfAllSortCol = period;
    mfAllSortDir = -1;
  }
  if (allOn) renderMoneyFlowAllPeriodsTable(computeAllPeriodsMoneyFlow(minStocks, minMcap));
}

// A header click: sort by that column (names A-Z, numbers high to low first), or reverse it when it is the one already used.
function mfSortBy(key) {
  const asc = key === 'name' || key === 'sector';
  mfSort = mfSort.col === key ? { col: key, dir: -mfSort.dir } : { col: key, dir: asc ? 1 : -1 };
  renderMoneyFlow();
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
    <tr class="mf-row" style="cursor:pointer" data-name="${escapeHtml(ind.name)}" data-list="all">
      <td style="font-weight:600">${escapeHtml(ind.name)}</td>
      <td style="color:var(--text2)">${escapeHtml(ind.sector)}</td>
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

// "Copy industries": the names the table lists (so Min Stocks / Min Market Cap are applied), in the order shown, as one
// comma-separated line - to paste into the Stock Scanner's Industry picker.
function copyMoneyFlowIndustries() {
  return copyNamesToClipboard(mfList.map(i => i.name), document.getElementById('mfCopyBtn'));
}

// A click on an industry row opens its chart popup; the popup's Up / Down walk the table's order.
(function wireMoneyFlow() {
  const panel = document.getElementById('panel-moneyflow');
  if (!panel || !panel.addEventListener) return;
  panel.addEventListener('click', e => {
    const row = e.target && e.target.closest ? e.target.closest('tr.mf-row') : null;
    if (!row || typeof openIndustryCharts !== 'function') return;
    openIndustryCharts(row.dataset.name, row.dataset.list === 'all' ? undefined : mfList.map(i => i.name));
  });
})();

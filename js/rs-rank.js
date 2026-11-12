// ═══════════════════════════════════════════════════════════════════════════════
// RELATIVE STRENGTH tab (top-level) — IBD-style RS ranks 99..1 for every stock, one page:
//   filters  ->  sector-wise summary  ->  industry-wise summary  ->  the stocks that pass.
//
// A stock's RS rank for a period (1M / 3M / 6M / 1Y) is its percentile position among all ranked stocks by price
// performance over that period: 99 = best performer, 1 = worst. Performance is computeDynPerformance() from screener.js
// over PERF_PERIOD_DAYS (21 / 63 / 126 / 250 trading days) - exactly the Performance filter (F15) in the Stock Scanner, so a
// stock's "3M perf" here is the number that filter uses. A stock without a full lookback of history is left unranked (not
// ranked on a shorter window), because a 3-month-old listing would otherwise be compared with 1-year movers.
// Ranks are always computed over the WHOLE universe: filters only hide rows, they never change a rank.
//
// The sector and industry tables summarise the stocks that PASS the filters: how many pass, out of how many ranked stocks the
// group has, their average RS / performance and the best one.
//
// This file is separate from relative-strength.js (that one is the Relative Strength tab inside the Stock Scanner filter
// popup). All names here start with rsr / RSR_. Loaded after screener.js (computeDynPerformance, PERF_PERIOD_DAYS).
// ═══════════════════════════════════════════════════════════════════════════════

const RSR_PERIODS = [
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' },
];
const RSR_PAGE_SIZE = 100;

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Rank an array of numbers 99 (highest) .. 1 (lowest). Non-finite values stay NaN and take no part in the ranking.
// Equal values share the same rank (their average position), so a flat group of stocks is never split arbitrarily.
// One ranked value alone gets 50.
function rsrRankValues(values) {
  const out = new Array(values.length).fill(NaN);
  const idx = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) idx.push(i);
  const n = idx.length;
  if (n === 0) return out;
  if (n === 1) { out[idx[0]] = 50; return out; }
  idx.sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgPos = (i + j) / 2;                           // average 0-based position of the tied run
    const rank = Math.round(1 + 98 * avgPos / (n - 1));
    for (let k = i; k <= j; k++) out[idx[k]] = rank;
    i = j + 1;
  }
  return out;
}

function rsrMean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN; }

// One row per stock: its performance and RS rank for every period. `stocks` = Store.latestBySymbol, `daily` = Store.dailyBySymbol.
function rsrBuildRows(stocks, daily) {
  const rows = [];
  for (const isin in stocks) {
    const s = stocks[isin];
    const days = daily[isin] || [];
    const perf = {};
    for (const p of RSR_PERIODS) {
      const v = computeDynPerformance(days, PERF_PERIOD_DAYS[p.key]);
      perf[p.key] = Number.isFinite(v) ? v : NaN;
    }
    rows.push({
      isin, symbol: s.symbol, companyName: s.companyName || '', sector: s.sector || 'Undefined-Diversified',
      industry: s.industry || 'Undefined-Diversified', close: s.close, turnover: s.turnover, marketCap: s.marketCap || 0,
      tradingDays: days.length, perf, rs: {},
    });
  }
  for (const p of RSR_PERIODS) {
    const ranks = rsrRankValues(rows.map(r => r.perf[p.key]));
    rows.forEach((r, i) => { r.rs[p.key] = ranks[i]; });
  }
  return rows;
}

// Which stock rows pass the filters. f = { period, minRs, maxRs, sector, industry, search, minTurnoverCr }. Blank / NaN numbers =
// no limit. A stock with no rank for the period never passes (it has no RS to compare).
function rsrFilterStocks(rows, f) {
  const k = f.period;
  const search = (f.search || '').trim().toUpperCase();
  const has = v => Number.isFinite(v);
  return rows.filter(r => {
    const rs = r.rs[k];
    if (!has(rs)) return false;
    if (has(f.minRs) && rs < f.minRs) return false;
    if (has(f.maxRs) && rs > f.maxRs) return false;
    if (f.sector && f.sector !== 'ALL' && r.sector !== f.sector) return false;
    if (f.industry && f.industry !== 'ALL' && r.industry !== f.industry) return false;
    if (search && !(r.symbol || '').toUpperCase().includes(search) && !(r.companyName || '').toUpperCase().includes(search)) return false;
    if (has(f.minTurnoverCr) && f.minTurnoverCr > 0 && !(r.turnover >= f.minTurnoverCr * 100)) return false;   // turnover is stored in lakhs
    return true;
  });
}

// Summarise the PASSING stocks by 'sector' or 'industry'. One entry per group with at least one passing stock:
// { name, sector (industries only: the sector most of its passing stocks belong to), passing, ranked (all ranked stocks of the group
// for this period, passing or not), pct (passing / ranked), avgRs, avgPerf, top (the passing stock with the highest RS, then perf) }.
function rsrSummarize(allRows, passing, kind, period) {
  const rankedBy = {};
  for (const r of allRows) if (Number.isFinite(r.rs[period])) rankedBy[r[kind]] = (rankedBy[r[kind]] || 0) + 1;
  const byName = new Map();
  for (const r of passing) {
    if (!byName.has(r[kind])) byName.set(r[kind], []);
    byName.get(r[kind]).push(r);
  }
  const out = [];
  for (const [name, list] of byName) {
    const g = { kind, name, sector: '', passing: list.length, ranked: rankedBy[name] || list.length };
    g.pct = g.passing / g.ranked * 100;
    g.avgRs = rsrMean(list.map(r => r.rs[period]));
    g.avgPerf = rsrMean(list.map(r => r.perf[period]));
    g.top = list.reduce((b, r) => (!b || r.rs[period] > b.rs[period] || (r.rs[period] === b.rs[period] && r.perf[period] > b.perf[period])) ? r : b, null);
    if (kind === 'industry') {
      const cnt = {};
      list.forEach(r => { cnt[r.sector] = (cnt[r.sector] || 0) + 1; });
      g.sector = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || a.localeCompare(b))[0] || '';
    }
    out.push(g);
  }
  return out;
}

// ── State ─────────────────────────────────────────────────────────────────────

let rsrCache = null;                            // { key, rows } - rebuilt only when the loaded data changes
const rsrSortState = { stocks: { col: 'rs', dir: -1 }, sectors: { col: 'passing', dir: -1 }, industries: { col: 'passing', dir: -1 } };
let rsrStockPage = 0;
let rsrStocksSpec = null;                       // the stocks table last rendered (for CSV export and the chart popup's Up / Down list)

function rsrRows() {
  const key = (Store.latestDate || '') + '|' + Object.keys(Store.latestBySymbol).length;
  if (!rsrCache || rsrCache.key !== key) {
    const rows = rsrBuildRows(Store.latestBySymbol, Store.dailyBySymbol);
    const byIsin = {};
    rows.forEach(r => { byIsin[r.isin] = r; });
    rsrCache = { key, rows, byIsin };
    rsrPopulateSelectors();
  }
  return rsrCache.rows;
}
function rsrInvalidate() { rsrCache = null; }

// A stock's RS rank (99..1) for a period ('1m' | '3m' | '6m' | '1y'), NaN when it has none. Used by the Stock Scanner's F45 filter
// (js/screener.js calls it guarded by typeof), so the scanner and this tab can never disagree.
function rsrRankOf(isin, period) {
  rsrRows();
  const r = rsrCache.byIsin[isin];
  return r && r.rs[period] !== undefined ? r.rs[period] : NaN;
}

function rsrEl(id) { return document.getElementById(id); }
function rsrNum(id) {
  const el = rsrEl(id);
  const t = el ? String(el.value).trim() : '';
  return t === '' ? NaN : Number(t);
}
function rsrPeriod() { const el = rsrEl('rsrPeriod'); return el && el.value ? el.value : '3m'; }
function rsrPeriodLabel(k) { const p = RSR_PERIODS.find(x => x.key === k); return p ? p.label : k; }

function rsrFilters() {
  return {
    period: rsrPeriod(), minRs: rsrNum('rsrMinRs'), maxRs: rsrNum('rsrMaxRs'),
    sector: rsrEl('rsrSector').value, industry: rsrEl('rsrIndustry').value,
    search: rsrEl('rsrSearch').value, minTurnoverCr: rsrNum('rsrMinTurnover'),
  };
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

// Colour for an RS rating: red (1) through amber to green (99).
function rsrColor(rs) { return `hsl(${Math.round((rs - 1) / 98 * 130)}, 72%, 52%)`; }
function rsrBadge(rs) {
  if (!Number.isFinite(rs)) return '<span class="neutral">-</span>';
  return `<span class="rsr-badge" style="color:${rsrColor(rs)};border-color:${rsrColor(rs)}">${Math.round(rs * 10) / 10}</span>`;
}
function rsrPerfCell(v) { return Number.isFinite(v) ? `<span class="${v >= 0 ? 'positive' : 'negative'}">${fmtPct(v)}</span>` : '<span class="neutral">-</span>'; }

function rsrSymbolLink(r) { return `<a href="#" class="stock-link" data-isin="${escapeHtml(r.isin)}" title="${escapeHtml(r.companyName)}">${escapeHtml(r.symbol)}</a>`; }
function rsrDrill(kind, name) { return `<a href="#" class="rsr-drill" data-kind="${kind}" data-name="${escapeHtml(name)}" title="Show only these stocks below">${escapeHtml(name)}</a>`; }

function rsrPopulateSelectors() {
  const rows = rsrCache ? rsrCache.rows : [];
  const secSel = rsrEl('rsrSector'), indSel = rsrEl('rsrIndustry');
  if (!secSel || !indSel) return;
  const keepSec = secSel.value, keepInd = indSel.value;
  const sectors = [...new Set(rows.map(r => r.sector))].sort();
  secSel.innerHTML = '<option value="ALL">All Sectors</option>' + sectors.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  secSel.value = sectors.includes(keepSec) ? keepSec : 'ALL';
  rsrPopulateIndustries();
  if ([...indSel.options].some(o => o.value === keepInd)) indSel.value = keepInd;
}
function rsrPopulateIndustries() {
  const rows = rsrCache ? rsrCache.rows : [];
  const sector = rsrEl('rsrSector').value, indSel = rsrEl('rsrIndustry');
  const inds = [...new Set(rows.filter(r => sector === 'ALL' || r.sector === sector).map(r => r.industry))].sort();
  indSel.innerHTML = '<option value="ALL">All Industries</option>' + inds.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

// ── Table specs: one definition drives the table, its sorting and the CSV ─────

function rsrStockSpec(rows, f) {
  const k = f.period;
  const cols = [
    { key: 'rs', label: `RS (${rsrPeriodLabel(k)})`, val: r => r.rs[k], html: r => rsrBadge(r.rs[k]) },
    { key: 'symbol', label: 'Symbol', val: r => r.symbol, html: r => rsrSymbolLink(r), str: true },
    { key: 'sector', label: 'Sector', val: r => r.sector, html: r => escapeHtml(r.sector), str: true },
    { key: 'industry', label: 'Industry', val: r => r.industry, str: true,
      html: r => `<a href="#" class="industry-link" data-industry="${escapeHtml(r.industry)}">${escapeHtml(r.industry)}</a>` },
    { key: 'close', label: 'Close', val: r => r.close, html: r => fmt2(r.close) },
    { key: 'perf', label: `${rsrPeriodLabel(k)} Perf %`, val: r => r.perf[k], html: r => rsrPerfCell(r.perf[k]), csv: r => r.perf[k] },
  ];
  for (const p of RSR_PERIODS) cols.push({ key: 'rs_' + p.key, label: `RS ${p.label}`, val: r => r.rs[p.key], html: r => rsrBadge(r.rs[p.key]) });
  cols.push(
    { key: 'turnover', label: 'Turnover (Cr)', val: r => r.turnover, html: r => fmtTurnoverCr(r.turnover), csv: r => r.turnover / 100 },
    { key: 'marketCap', label: 'Mkt Cap (Cr)', val: r => r.marketCap, html: r => fmtCr(r.marketCap) },
  );
  return { view: 'stocks', cols, rows, name: 'rs_stocks' };
}

function rsrGroupSpec(kind, groups, f) {
  const k = f.period, isInd = kind === 'industry';
  const cols = [
    { key: 'name', label: isInd ? 'Industry' : 'Sector', val: g => g.name, html: g => rsrDrill(kind, g.name), str: true },
  ];
  if (isInd) cols.push({ key: 'sector', label: 'Sector', val: g => g.sector, html: g => escapeHtml(g.sector), str: true });
  cols.push(
    { key: 'passing', label: 'Stocks Passing', val: g => g.passing, html: g => `<b>${g.passing}</b>` },
    { key: 'ranked', label: 'Ranked in Group', val: g => g.ranked, html: g => String(g.ranked) },
    { key: 'pct', label: '% Passing', val: g => g.pct, html: g => g.pct.toFixed(0) + '%' },
    { key: 'avgRs', label: `Avg RS (${rsrPeriodLabel(k)})`, val: g => g.avgRs, html: g => rsrBadge(g.avgRs) },
    { key: 'avgPerf', label: `Avg ${rsrPeriodLabel(k)} Perf %`, val: g => g.avgPerf, html: g => rsrPerfCell(g.avgPerf), csv: g => g.avgPerf },
    { key: 'top', label: 'Top Stock', val: g => g.top ? g.top.rs[k] : NaN,
      html: g => g.top ? `${rsrSymbolLink(g.top)} <span class="neutral">(${g.top.rs[k]})</span>` : '-', csv: g => g.top ? g.top.symbol : '' },
  );
  return { view: isInd ? 'industries' : 'sectors', cols, rows: groups, name: isInd ? 'rs_industries' : 'rs_sectors' };
}

function rsrSortRows(spec) {
  const st = rsrSortState[spec.view];
  const col = spec.cols.find(c => c.key === st.col) || spec.cols[0];
  const dir = st.dir;
  const rows = [...spec.rows];
  rows.sort((a, b) => {
    const va = col.val(a), vb = col.val(b);
    if (col.str) return dir * String(va).localeCompare(String(vb));
    const fa = Number.isFinite(va), fb = Number.isFinite(vb);
    if (!fa || !fb) return fa === fb ? 0 : (fa ? -1 : 1);                       // blanks always last
    return va === vb ? 0 : dir * (va - vb);
  });
  return rows;
}

// Draw one table into wrapId. page (stocks only) paginates; without it every row is shown (the table scrolls).
function rsrRenderTable(spec, wrapId, page) {
  const wrap = rsrEl(wrapId);
  const st = rsrSortState[spec.view];
  const sorted = rsrSortRows(spec);
  spec.sorted = sorted;
  const paged = page !== undefined;
  const start = paged ? page * RSR_PAGE_SIZE : 0;
  const shown = paged ? sorted.slice(start, start + RSR_PAGE_SIZE) : sorted;
  const head = spec.cols.map(c => `<th onclick="rsrSortBy('${spec.view}','${c.key}')">${escapeHtml(c.label)}<span class="sort-arrow">${st.col === c.key ? (st.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('');
  const body = shown.map(r => '<tr>' + spec.cols.map(c => `<td>${c.html(r)}</td>`).join('') + '</tr>').join('');
  const total = sorted.length;
  let pager = '';
  if (paged) {
    const pages = Math.max(1, Math.ceil(total / RSR_PAGE_SIZE));
    pager = `<div class="pagination">
      <button onclick="rsrGoPage(0)" ${page === 0 ? 'disabled' : ''}>First</button>
      <button onclick="rsrGoPage(${page - 1})" ${page === 0 ? 'disabled' : ''}>Prev</button>
      <span>Page ${page + 1} of ${pages}</span>
      <button onclick="rsrGoPage(${page + 1})" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>
      <button onclick="rsrGoPage(${pages - 1})" ${page >= pages - 1 ? 'disabled' : ''}>Last</button></div>`;
  }
  const count = !total ? 'No stocks match the filters' : paged ? `Showing ${start + 1}-${Math.min(start + shown.length, total)} of ${total}` : `${total} ${total === 1 ? 'row' : 'rows'}`;
  wrap.innerHTML = `<div class="rsr-count">${count}</div>
    <div class="table-wrap${paged ? '' : ' rsr-short'}"><table class="rsr-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${pager}`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

function rsrRender() {
  if (!Store.latestBySymbol || !Object.keys(Store.latestBySymbol).length) return;
  const rows = rsrRows(), f = rsrFilters(), k = f.period, label = rsrPeriodLabel(k);
  const ranked = rows.filter(r => Number.isFinite(r.rs[k])).length;

  // The sector and industry tables are never narrowed by the Sector / Industry pickers (they always list every group that has a
  // passing stock, so another one can always be picked from them); only the stocks list follows the pickers.
  const forGroups = rsrFilterStocks(rows, { ...f, sector: 'ALL', industry: 'ALL' });
  const passing = rsrFilterStocks(rows, f);

  rsrRenderTable(rsrGroupSpec('sector', rsrSummarize(rows, forGroups, 'sector', k), f), 'rsrSectorsWrap');
  rsrRenderTable(rsrGroupSpec('industry', rsrSummarize(rows, forGroups, 'industry', k), f), 'rsrIndustriesWrap');
  rsrStockPage = Math.min(rsrStockPage, Math.max(0, Math.ceil(passing.length / RSR_PAGE_SIZE) - 1));
  rsrStocksSpec = rsrStockSpec(passing, f);
  rsrRenderTable(rsrStocksSpec, 'rsrStocksWrap', rsrStockPage);

  const lo = Number.isFinite(f.minRs) ? f.minRs : 1, hi = Number.isFinite(f.maxRs) ? f.maxRs : 99;
  rsrEl('rsrSummary').innerHTML = `<b>${passing.length.toLocaleString()}</b> of ${ranked.toLocaleString()} ranked stocks pass (${label} RS ${lo}-${hi}).`
    + ` ${(rows.length - ranked).toLocaleString()} stocks have no ${label} rank (less than ${PERF_PERIOD_DAYS[k] + 1} trading days of history) and are not counted.`
    + ' Ranks are computed over all stocks; filters only hide rows.';
  rsrEl('rsrSectorHead').textContent = `Sector-wise (${forGroups.length.toLocaleString()} stocks)`;
  rsrEl('rsrIndustryHead').textContent = `Industry-wise (${forGroups.length.toLocaleString()} stocks)`;
  rsrEl('rsrStocksHead').textContent = `Stocks (${passing.length.toLocaleString()})`;
}

// ── Controls ──────────────────────────────────────────────────────────────────

function rsrSortBy(view, col) {
  const st = rsrSortState[view];
  if (st.col === col) st.dir *= -1; else { st.col = col; st.dir = (col === 'symbol' || col === 'name' || col === 'sector' || col === 'industry') ? 1 : -1; }
  rsrRender();
}
function rsrGoPage(p) { rsrStockPage = Math.max(0, p); rsrRender(); }
function rsrFilterChanged() { rsrStockPage = 0; rsrRender(); }
function rsrSectorChanged() { rsrPopulateIndustries(); rsrFilterChanged(); }
function rsrSetMinRs(n) { rsrEl('rsrMinRs').value = n === null ? '' : n; rsrEl('rsrMaxRs').value = ''; rsrFilterChanged(); }

function rsrReset() {
  for (const id of ['rsrMinRs', 'rsrMaxRs', 'rsrSearch', 'rsrMinTurnover']) rsrEl(id).value = '';
  rsrEl('rsrSector').value = 'ALL';
  rsrPopulateIndustries();
  rsrEl('rsrIndustry').value = 'ALL';
  rsrFilterChanged();
}

function rsrCsvCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '';
  return '"' + String(v).replace(/"/g, '""') + '"';
}
function rsrBuildCsv(spec) {
  const rows = spec.sorted || rsrSortRows(spec);
  const lines = [spec.cols.map(c => rsrCsvCell(c.label)).join(',')];
  for (const r of rows) lines.push(spec.cols.map(c => rsrCsvCell(c.csv ? c.csv(r) : c.val(r))).join(','));
  return lines.join('\n') + '\n';
}
// Exports the stocks table (every passing stock, in the order shown, not just the current page).
function rsrExportCsv() {
  if (!rsrStocksSpec || !rsrStocksSpec.rows.length) { alert('No stocks to export.'); return; }
  const blob = new Blob([rsrBuildCsv(rsrStocksSpec)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${rsrStocksSpec.name}_${rsrPeriod()}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Chart links and drill-downs: one delegated listener on the panel (tables are re-rendered often).
(function rsrWire() {
  const panel = document.getElementById('panel-rs');
  if (!panel || !panel.addEventListener) return;
  panel.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const stock = t.closest('.stock-link');
    if (stock) {
      e.preventDefault();
      // Up / Down in the chart popup walks the stocks list below when the click came from it, else just this stock
      const inList = !!t.closest('#rsrStocksWrap');
      if (typeof openStockChart === 'function') openStockChart(stock.dataset.isin, inList && rsrStocksSpec ? rsrStocksSpec.sorted : undefined);
      return;
    }
    const ind = t.closest('.industry-link');
    if (ind) { e.preventDefault(); if (typeof openIndustryCharts === 'function') openIndustryCharts(ind.dataset.industry); return; }
    const drill = t.closest('.rsr-drill');
    if (drill) {
      e.preventDefault();
      const name = drill.dataset.name;
      if (drill.dataset.kind === 'sector') {
        rsrEl('rsrSector').value = name; rsrPopulateIndustries(); rsrEl('rsrIndustry').value = 'ALL';
      } else {
        const r = rsrRows().find(x => x.industry === name);
        if (r) { rsrEl('rsrSector').value = r.sector; rsrPopulateIndustries(); }
        rsrEl('rsrIndustry').value = name;
      }
      rsrFilterChanged();
      const head = rsrEl('rsrStocksHead');
      if (head && head.scrollIntoView) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
})();

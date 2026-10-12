'use strict';
// js/industry.js's "IPOs Listed" Sort By: per-industry count of stocks whose NSE listing date is in the last
// 1M / 3M / 6M / 1Y, with bulk-admission days left out. The chart, table and heatmap are the Industry tab's
// existing ones; here the chart call is captured and the table is checked through its column list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js']);
const run = code => vm.runInContext(code, sb);
const { Store, isoMinusMonths, ipoWindow } = sb;
// results are built inside the vm sandbox, so their prototypes differ from the test's: compare as JSON
const same = (actual, expected, msg) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);

const stock = (symbol, industry, listingDate, extra = {}) => ({
  symbol, industry, sector: 'S', listingDate, marketCap: 100, turnover: 10, monthlyChangePct: 1,
  distFrom52H: 5, distFromSMA: 1, aboveSMA: true, ...extra,
});
function loadStore(stocks, firstDayTurnoverLakh = {}) {
  Store.dates = ['09-Oct-2026', '12-Oct-2026'];
  Store.dailyBySymbol = {};
  Store.latestBySymbol = {};
  stocks.forEach(s => {
    Store.latestBySymbol[s.symbol] = s;
    if (firstDayTurnoverLakh[s.symbol] !== undefined) {
      // the stock's first bar is its listing day, in the data's dd-Mon-YYYY date format
      const [y, m, d] = s.listingDate.split('-');
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(m, 10) - 1];
      Store.dailyBySymbol[s.symbol] = [{ date: `${d}-${mon}-${y}`, turnover: firstDayTurnoverLakh[s.symbol] }];
    }
  });
}
// the stocks of the current Store that the window counts, by symbol
const counted = w => Object.entries(Store.latestBySymbol).filter(([k, s]) => w.counts(s, k)).map(([k, s]) => s.symbol);

// ── isoMinusMonths ──────────────────────────────────────────────────────────
test('isoMinusMonths: whole calendar months back, clamping to the end of a shorter month', () => {
  assert.equal(isoMinusMonths('2026-10-12', 1), '2026-09-12');
  assert.equal(isoMinusMonths('2026-10-12', 3), '2026-07-12');
  assert.equal(isoMinusMonths('2026-10-12', 12), '2025-10-12');
  assert.equal(isoMinusMonths('2026-03-31', 1), '2026-02-28');
  assert.equal(isoMinusMonths('2024-03-31', 1), '2024-02-29');
  assert.equal(isoMinusMonths('2026-01-15', 3), '2025-10-15', 'crosses a year boundary');
  assert.equal(isoMinusMonths('2026-01-15', 12), '2025-01-15');
});

test('isoMinusMonths: unreadable input gives an empty string', () => {
  assert.equal(isoMinusMonths('', 3), '');
  assert.equal(isoMinusMonths('12-Oct-2026', 3), '');
});

// ── ipoWindow ───────────────────────────────────────────────────────────────
test('ipoWindow: counts listings after the date N months before the latest data date, up to and including it', () => {
  loadStore([
    stock('EXACT', 'X', '2026-07-12'),   // exactly 3 months back: out
    stock('NEXT', 'X', '2026-07-13'),    // in
    stock('TODAY', 'X', '2026-10-12'),   // the latest data date: in
    stock('FUTURE', 'X', '2026-10-13'),  // after the latest data date: out
    stock('OLD', 'X', '2020-01-01'),
    stock('NODATE', 'X', ''),
  ]);
  const w = ipoWindow('3m');
  assert.equal(w.from, '2026-07-12');
  assert.equal(w.to, '2026-10-12');
  same(counted(w), ['NEXT', 'TODAY']);
});

test('ipoWindow: a day with 20+ listings is a bulk admission and is left out, and reported', () => {
  const bulk = Array.from({ length: 20 }, (_, i) => stock('B' + i, 'Bulk', '2026-08-17'));
  const nearly = Array.from({ length: 19 }, (_, i) => stock('N' + i, 'Nearly', '2026-09-01'));
  loadStore([...bulk, ...nearly, stock('ONE', 'X', '2026-09-15')]);
  const w = ipoWindow('3m');
  assert.equal(counted(w).length, 20, '19 on a day still counts, 20 does not; plus the single listing');
  same(w.bulkDays, [{ date: '2026-08-17', count: 20, kept: [] }]);
});

test('ipoWindow: on a bulk day a stock that traded like an IPO (>= Rs 100 Cr on day one) still counts, and is named', () => {
  const quiet = Array.from({ length: 20 }, (_, i) => stock('Q' + i, 'Old', '2026-08-17'));
  // turnover is in lakhs: 158604 lakh = Rs 1,586 Cr; 9999 lakh = Rs 99.99 Cr (just under)
  loadStore([...quiet, stock('MOLBIO', 'Med', '2026-08-17'), stock('NEARLY', 'Med', '2026-08-17'), stock('SMALL', 'Med', '2026-08-17')],
    { MOLBIO: 158604.49, NEARLY: 9999, SMALL: 2.04, Q0: 5 });
  const w = ipoWindow('3m');
  same(counted(w), ['MOLBIO']);
  same(w.bulkDays, [{ date: '2026-08-17', count: 23, kept: ['MOLBIO'] }]);
});

test('ipoWindow: the Rs 100 Cr line is exact, and a missing listing-day bar counts as no turnover', () => {
  const quiet = Array.from({ length: 20 }, (_, i) => stock('Q' + i, 'Old', '2026-08-17'));
  loadStore([...quiet, stock('AT', 'X', '2026-08-17'), stock('NOBAR', 'X', '2026-08-17')], { AT: 10000 });
  same(counted(ipoWindow('3m')), ['AT']);
});

test('ipoWindow: a normal day needs no turnover to count', () => {
  loadStore([stock('TINY', 'X', '2026-10-01')], { TINY: 0.01 });
  same(counted(ipoWindow('3m')), ['TINY']);
});

test('ipoWindow: bulk days outside the window are not reported', () => {
  loadStore(Array.from({ length: 25 }, (_, i) => stock('B' + i, 'Bulk', '2026-04-20')));
  assert.equal(ipoWindow('3m').bulkDays.length, 0);
  same(ipoWindow('6m').bulkDays, [{ date: '2026-04-20', count: 25, kept: [] }]);
});

test('ipoWindow: with no data loaded nothing counts', () => {
  Store.dates = [];
  Store.latestBySymbol = { A: stock('A', 'X', '2026-10-01') };
  const w = ipoWindow('3m');
  assert.equal(w.to, '');
  assert.equal(w.counts(Store.latestBySymbol.A), false);
});

// ── Sort By: IPOs Listed ────────────────────────────────────────────────────
const dom = installFakeDom(sb, {
  industrySort: 'ipo', ipoPeriod: '3m', indMinStocks: '1', indMinMcap: '0',
  moneyFlowPeriod: '1m', mfRocPeriod: '1m', mfRocLag: '1m',
});
let charted = null;
run('renderMetricChart = (data, sortBy, mfPeriod, mfData, rocLag, ipoInfo) => { __charted = { names: data.map(d => d.name), counts: data.map(d => d.ipoCount), sortBy, ipoInfo }; }');
sb.__charted = null;

function render(period = '3m') {
  dom.el('industrySort').value = 'ipo';
  dom.el('ipoPeriod').value = period;
  dom.el('industrySort').selectedOptions = [{ textContent: 'IPOs Listed' }];
  run('renderIndustryAnalysis()');
  return { charted: sb.__charted, list: run('_chartData'), bd: run('_indBreakdown') };
}

const fixture = () => loadStore([
  stock('AL1', 'Alpha', '2026-09-20'), stock('AL2', 'Alpha', '2026-10-01'), stock('ALOLD', 'Alpha', '2019-05-05'),
  stock('BE1', 'Beta', '2026-10-05'),
  stock('GA1', 'Gamma', '2026-05-01'),
  stock('DE1', 'Delta', '2020-02-02'),
  ...Array.from({ length: 20 }, (_, i) => stock('BU' + i, 'Beta', '2026-08-17')),
]);

test('IPO sort: the chart gets only industries with a listing, most first, and the bulk day is not counted', () => {
  fixture();
  const { charted } = render('3m');
  same(charted.names, ['Alpha', 'Beta']);
  same(charted.counts, [2, 1]);
  assert.equal(charted.sortBy, 'ipo');
  assert.equal(charted.ipoInfo.period, '3m');
  same(charted.ipoInfo.bulkDays, [{ date: '2026-08-17', count: 20, kept: [] }]);
});

test('IPO sort: a real IPO on a bulk day shows under its industry', () => {
  loadStore([
    ...Array.from({ length: 20 }, (_, i) => stock('OLD' + i, 'Textiles', '2026-08-17')),
    stock('MOLBIO', 'Medical Equipment', '2026-08-17'), stock('QMSMEDI', 'Medical Equipment', '2026-09-18'),
  ], { MOLBIO: 158604.49 });
  const { charted, list } = render('3m');
  same(charted.names, ['Medical Equipment']);
  same(charted.counts, [2]);
  same(list.find(i => i.name === 'Medical Equipment').ipoSymbols, ['QMSMEDI', 'MOLBIO'], 'newest listing first');
  assert.equal(list.find(i => i.name === 'Textiles').ipoCount, 0);
});

test('IPO sort: a longer period picks up older listings', () => {
  fixture();
  const six = render('6m').charted;
  assert.equal(six.names[0], 'Alpha');
  same([...six.names].sort(), ['Alpha', 'Beta', 'Gamma'], 'Gamma (1-May) is only inside the 6-month window');
  same(render('1m').charted.counts, [2, 1], 'from 12-Sep: Alpha has 20-Sep and 1-Oct, Beta 5-Oct');
  same(render('1y').charted.names.length, 3, 'Alpha, Beta and Gamma; Delta listed in 2020');
});

test('IPO sort: each industry carries its symbols, newest listing first', () => {
  fixture();
  const { list } = render('3m');
  const alpha = list.find(i => i.name === 'Alpha');
  same(alpha.ipoSymbols, ['AL2', 'AL1']);
  assert.equal(alpha.ipoCount, 2);
  assert.equal(list.find(i => i.name === 'Delta').ipoCount, 0, 'industries without a listing stay in the list (table / heatmap)');
});

test('IPO sort: ties keep the stronger industry first', () => {
  loadStore([
    stock('W1', 'Weak', '2026-10-01', { aboveSMA: false, distFromSMA: -5, distFrom52H: 40, monthlyChangePct: -8 }),
    stock('S1', 'Strong', '2026-10-02', { aboveSMA: true, distFrom52H: 2, monthlyChangePct: 9 }),
  ]);
  same(render('3m').charted.names, ['Strong', 'Weak']);
});

test('IPO sort: nothing listed in the period gives an empty chart list, not an error', () => {
  loadStore([stock('OLD', 'Alpha', '2019-05-05')]);
  same(render('1m').charted.names, []);
});

test('IPO sort: the breakdown table gains IPO columns right after Stocks, labelled with the period', () => {
  fixture();
  const { bd } = render('3m');
  assert.equal(bd.sortBy, 'ipo');
  assert.equal(bd.ipoLabel, '3M');
  const cols = run("indBreakdownCols(_indBreakdown.mfLabel, _indBreakdown.isRoc, _indBreakdown.rocPeriodLabel, _indBreakdown.ipoLabel).map(c => c.key + ':' + c.label)");
  const at = cols.indexOf('stockCount:Stocks');
  assert.equal(cols[at + 1], 'ipoCount:IPOs (3M)');
  assert.equal(cols[at + 2], 'ipoSymbols:Listed');
});

test('IPO sort: the default table order is by IPO count, high to low', () => {
  fixture();
  render('3m');
  const def = run('indDefaultSort()');
  assert.equal(def.col, 'ipoCount');
  assert.equal(def.dir, -1);
});

test('other sorts are unaffected: no IPO columns, and the chart gets the full list', () => {
  fixture();
  dom.el('industrySort').value = 'stocks';
  dom.el('industrySort').selectedOptions = [{ textContent: 'Stock Count' }];
  run('renderIndustryAnalysis()');
  assert.equal(run('_indBreakdown.ipoLabel'), null);
  assert.equal(sb.__charted.sortBy, 'stocks');
  assert.equal(sb.__charted.names.length, 4, 'Alpha, Beta, Gamma, Delta - every industry');
  assert.equal(run('indBreakdownCols("1M", false, "3M", null).some(c => c.key === "ipoCount")'), false);
});

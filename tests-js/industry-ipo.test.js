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
// The bar chart is gone: what it used to chart (the industries with at least one listing, most first) is the top of the table's list.
// `charted` keeps that view of the last render; `note` is the line above the Industry Breakdown table.
function render(period = '3m') {
  dom.el('industrySort').value = 'ipo';
  dom.el('ipoPeriod').value = period;
  dom.el('industrySort').selectedOptions = [{ textContent: 'IPOs Listed' }];
  run('renderIndustryAnalysis()');
  const list = run('_chartData');
  const listed = list.filter(i => i.ipoCount > 0);
  return {
    charted: { names: listed.map(d => d.name), counts: listed.map(d => d.ipoCount), sortBy: run('_indBreakdown.sortBy') },
    list, bd: run('_indBreakdown'), note: dom.el('indMetricNote').textContent,
  };
}

const fixture = () => loadStore([
  stock('AL1', 'Alpha', '2026-09-20'), stock('AL2', 'Alpha', '2026-10-01'), stock('ALOLD', 'Alpha', '2019-05-05'),
  stock('BE1', 'Beta', '2026-10-05'),
  stock('GA1', 'Gamma', '2026-05-01'),
  stock('DE1', 'Delta', '2020-02-02'),
  ...Array.from({ length: 20 }, (_, i) => stock('BU' + i, 'Beta', '2026-08-17')),
]);

test('IPO sort: industries with a listing come first, most first, and the bulk day is not counted - the note above the table says so', () => {
  fixture();
  const { charted, list, note } = render('3m');
  same(charted.names, ['Alpha', 'Beta']);
  same(charted.counts, [2, 1]);
  assert.equal(charted.sortBy, 'ipo');
  same(list.slice(0, 2).map(i => i.name), ['Alpha', 'Beta'], 'the table is in that order too');
  assert.match(note, /^IPOs Listed by Industry — Last 3 Months/);
  assert.match(note, /Left out as bulk admissions of existing companies, not IPOs: 17-Aug-2026 \(20 of 20 stocks\)\./);
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

test('IPO sort: nothing listed in the period gives an empty list of listings, not an error', () => {
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

test('other sorts are unaffected: no IPO columns, every industry stays in the list', () => {
  fixture();
  dom.el('industrySort').value = 'stocks';
  dom.el('industrySort').selectedOptions = [{ textContent: 'Stock Count' }];
  run('renderIndustryAnalysis()');
  assert.equal(run('_indBreakdown.ipoLabel'), null);
  assert.equal(run('_indBreakdown.sortBy'), 'stocks');
  assert.equal(run('_chartData').length, 4, 'Alpha, Beta, Gamma, Delta - every industry');
  assert.match(dom.el('indMetricNote').textContent, /^Industry by Number of Stocks — /);
  assert.equal(run('indBreakdownCols("1M", false, "3M", null).some(c => c.key === "ipoCount")'), false);
});

// ── "Copy industries" on the Industry Breakdown table ───────────────────────────────────────────────────────────────────────────────

test('Copy industries (Industry Breakdown): the names the table lists, in the order shown, one comma-separated line', async () => {
  fixture();
  render('3m');
  let clip = null;
  sb.navigator = { clipboard: { writeText: t => { clip = t; return Promise.resolve(); } } };
  sb.setTimeout = () => {};
  dom.el('indBreakdownCopy').dataset = {};
  dom.el('indBreakdownCopy').textContent = 'Copy industries';
  assert.equal(await sb.copyBreakdownIndustries(), true);
  assert.equal(clip, run('_chartData').map(i => i.name).join(','));
  assert.equal(clip.split(',').length, 4, 'Alpha, Beta, Gamma, Delta');
  assert.equal(dom.el('indBreakdownCopy').textContent, 'Copied 4 ✓');
  // a manual column sort changes the order it copies in (it copies what the table shows)
  run("sortIndustryBreakdown('name')");
  await sb.copyBreakdownIndustries();
  assert.equal(clip, 'Alpha,Beta,Delta,Gamma');
  delete sb.navigator; delete sb.setTimeout;
});

test('Copy industries (Industry Breakdown): Min Stocks / Min Market Cap leave industries out of the copy, as they do the table', async () => {
  fixture();
  dom.el('indMinStocks').value = '2';                              // Alpha has 3 stocks and Beta 21; Gamma and Delta have 1 each
  render('3m');
  let clip = null;
  sb.navigator = { clipboard: { writeText: t => { clip = t; return Promise.resolve(); } } };
  sb.setTimeout = () => {};
  dom.el('indBreakdownCopy').dataset = {};
  await sb.copyBreakdownIndustries();
  assert.equal(clip, 'Alpha,Beta');
  dom.el('indMinStocks').value = '1';
  delete sb.navigator; delete sb.setTimeout;
});

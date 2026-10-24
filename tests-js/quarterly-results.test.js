'use strict';
// Quarterly Results filters (js/quarterly-results.js): F20 "QoQ Y Earnings > X%", F21 "QoQ Y Sales > X%", F22 / F23 the earnings /
// sales turnaround filters. The server computes the growth (tests/test_quarterly_growth.py); these tests cover the browser side:
// which stocks pass, the reason a stock fails, the hooks the scanner calls, and that the filters are wired into presets / Reset.
// The chart table has its own file: tests-js/quarterly-chart-table.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js']);
const { qrQuarterLabel } = sb;
// arrays built inside the vm sandbox belong to another realm, so strict deepEqual would reject them: copy to plain arrays
const qrFailReasons = (...a) => Array.from(sb.qrFailReasons(...a));

function rec(o) {
  return Object.assign({ q: '2024-12-31', b: 'C', cmp: 'ok', s: 130, sp: 100, e: 15, ep: 10, sg: 30, eg: 50, st: false, et: false }, o);
}
function withData(bySymbol) {
  sb.Store.quarterly = { bySymbol, latestQuarter: '2024-12-31' };
  sb.Store.quarterlyState = 'ready';
}
const E = min => ({ on: true, min }), S = min => ({ on: true, min }), OFF = { on: false, min: 0 }, T = { on: true };

test('both filters off: nothing is checked, even with no data loaded', () => {
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.deepEqual(qrFailReasons('AAA', OFF, OFF), []);
});

test('earnings: passes only when growth is strictly greater than the threshold', () => {
  withData({ aaa: rec({ eg: 50 }) });
  assert.deepEqual(qrFailReasons('AAA', E(20), OFF), []);
  assert.deepEqual(qrFailReasons('AAA', E(49.9), OFF), []);
  assert.equal(qrFailReasons('AAA', E(50), OFF).length, 1);   // equal is not "greater than"
  assert.match(qrFailReasons('AAA', E(60), OFF)[0], /^F20: Earnings Dec-2024 \+50\.0% YoY, not > 60%/);
});

test('sales: same rule, reported under F21, and a decline shows its minus sign', () => {
  withData({ aaa: rec({ sg: -4.2 }) });
  assert.deepEqual(qrFailReasons('AAA', OFF, S(-10)), []);
  assert.match(qrFailReasons('AAA', OFF, S(0))[0], /^F21: Sales Dec-2024 -4\.2% YoY, not > 0%/);
});

test('both filters on: the stock must pass both, and each failure is listed', () => {
  withData({ aaa: rec({ eg: 50, sg: 5 }) });
  assert.deepEqual(qrFailReasons('AAA', E(20), S(10)).map(r => r.slice(0, 3)), ['F21']);
  assert.deepEqual(qrFailReasons('AAA', E(80), S(10)).map(r => r.slice(0, 3)), ['F20', 'F21']);
});

test('a stock whose year-ago profit was a loss has no % growth and fails, saying so', () => {
  withData({ aaa: rec({ eg: null, e: 8, ep: -5 }), bbb: rec({ eg: null, e: -2, ep: -5 }) });
  assert.match(qrFailReasons('AAA', E(0), OFF)[0], /turnaround/);
  assert.match(qrFailReasons('BBB', E(0), OFF)[0], /zero or negative/);
  assert.deepEqual(qrFailReasons('AAA', OFF, S(10)), []);   // its sales are fine - only the earnings filter is affected
});

test('a stock that cannot be compared like for like fails with the reason', () => {
  withData({ a: rec({ cmp: 'no-prev', sg: null, eg: null }), b: rec({ cmp: 'basis', sg: null, eg: null }), c: rec({ cmp: 'blank', sg: null, eg: null }), d: rec({ cmp: 'scale', sg: null, eg: null }) });
  assert.match(qrFailReasons('D', E(0), S(0))[0], /mis-scaled/);
  assert.equal(qrFailReasons('D', E(0), S(0)).length, 2);   // both filters report it
  assert.match(qrFailReasons('A', E(0), OFF)[0], /No Dec-2024 result from the year before/);
  assert.match(qrFailReasons('B', E(0), OFF)[0], /standalone vs consolidated/);
  assert.match(qrFailReasons('C', E(0), OFF)[0], /numbers unavailable/);
});

test('a stock with no results at all fails; so does everything while the data is loading or missing', () => {
  withData({ aaa: rec({}) });
  assert.match(qrFailReasons('ZZZ', E(0), OFF)[0], /No quarterly results for this stock/);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'loading';
  assert.match(qrFailReasons('AAA', E(0), OFF)[0], /still loading/);
  sb.Store.quarterlyState = 'missing';
  assert.match(qrFailReasons('AAA', E(0), S(0))[0], /-FetchResults/);
});

test('earnings turnaround (F22): passes on a loss -> profit, and shows no percentage anywhere', () => {
  withData({ aaa: rec({ et: true, eg: null, e: 828, ep: -1217 }) });
  assert.deepEqual(qrFailReasons('AAA', OFF, OFF, T, OFF), []);
});

test('earnings turnaround (F22): says why a stock is not one', () => {
  withData({
    prof: rec({ e: 18540, ep: 17265 }),                  // profit both years: that is growth
    zero: rec({ e: 8, ep: 0 }),                          // a zero a year ago is not a loss
    loss: rec({ e: -2, ep: -5, eg: null }),              // still losing money
  });
  assert.match(qrFailReasons('PROF', OFF, OFF, T, OFF)[0], /^F22: Not an earnings turnaround - Dec-2024 profit was already positive a year ago \(17,265 cr\)/);
  assert.match(qrFailReasons('ZERO', OFF, OFF, T, OFF)[0], /profit a year ago was zero, not a loss/);
  assert.match(qrFailReasons('LOSS', OFF, OFF, T, OFF)[0], /still loss-making \(-2 cr vs -5 cr a year ago\)/);
});

test('sales turnaround (F23): none a year ago, some now', () => {
  withData({ aaa: rec({ st: true, sg: null, s: 103, sp: 0 }), bbb: rec({}), ccc: rec({ s: 0, sp: 0, sg: null }) });
  assert.deepEqual(qrFailReasons('AAA', OFF, OFF, OFF, T), []);
  assert.match(qrFailReasons('BBB', OFF, OFF, OFF, T)[0], /^F23: Not a sales turnaround - Dec-2024 sales were already positive a year ago \(100 cr\)/);
  assert.match(qrFailReasons('CCC', OFF, OFF, OFF, T)[0], /no sales this quarter either/);
});

test('turnaround stays apart from growth: a turnaround passes F22, fails F20 (no %), and the reasons point at each other', () => {
  withData({ aaa: rec({ et: true, eg: null, e: 8, ep: -5 }) });
  assert.deepEqual(qrFailReasons('AAA', OFF, OFF, T, OFF), []);
  const growth = qrFailReasons('AAA', E(0), OFF, OFF, OFF);
  assert.equal(growth.length, 1);
  assert.match(growth[0], /^F20: .*turnaround - no % growth; see the turnaround filter/);
  // both together: only the growth one fails, so the stock as a whole does not pass an AND of the two
  assert.deepEqual(qrFailReasons('AAA', E(0), OFF, T, OFF).map(r => r.slice(0, 3)), ['F20']);
});

test('turnaround filters report the same "cannot compare" reasons as growth, under their own codes', () => {
  withData({ a: rec({ cmp: 'no-prev', et: false, st: false }), b: rec({ cmp: 'basis' }), c: rec({ cmp: 'scale' }), d: rec({ cmp: 'blank' }) });
  assert.match(qrFailReasons('A', OFF, OFF, T, T)[0], /^F22: No Dec-2024 result from the year before/);
  assert.match(qrFailReasons('A', OFF, OFF, T, T)[1], /^F23: No Dec-2024 result from the year before/);
  assert.match(qrFailReasons('B', OFF, OFF, T, OFF)[0], /standalone vs consolidated/);
  assert.match(qrFailReasons('C', OFF, OFF, OFF, T)[0], /mis-scaled/);
  assert.match(qrFailReasons('D', OFF, OFF, T, OFF)[0], /numbers unavailable/);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(qrFailReasons('A', OFF, OFF, T, OFF)[0], /-FetchResults/);
});

test('lookup normalizes the symbol like the server does (M&M, BAJAJ-AUTO)', () => {
  withData({ m_m: rec({ eg: 30 }), bajaj_auto: rec({ eg: 30 }) });
  assert.deepEqual(qrFailReasons('M&M', E(20), OFF), []);
  assert.deepEqual(qrFailReasons('BAJAJ-AUTO', E(20), OFF), []);
});

test('qrQuarterLabel', () => {
  assert.equal(qrQuarterLabel('2024-12-31'), 'Dec-2024');
  assert.equal(qrQuarterLabel('2023-03-31'), 'Mar-2023');
  assert.equal(qrQuarterLabel(''), '-');
});

// ── the hooks js/screener.js calls (guarded by typeof, like the As of Date module's) ───────────────────────────────────

test('qrFilterState reads the filters; a blank or invalid threshold counts as 0', () => {
  const dom = installFakeDom(sb, { scrF20Val: '25', scrF21Val: 'abc' });
  assert.equal(sb.qrFilterState().any, false);
  dom.el('scrF20On').checked = true; dom.el('scrF22On').checked = true;
  const s = JSON.parse(JSON.stringify(sb.qrFilterState()));
  assert.deepEqual(s, { f20: { on: true, min: 25 }, f21: { on: false, min: 0 }, f22: { on: true }, f23: { on: false },
    f28: { on: false, min: 0 }, f29: { on: false, min: 0 },                 // f28 / f29 = EPS / Sales YoY% change, f32 / f33 = their turnarounds (tests-js/quarterly-qoq.test.js)
    f32: { on: false }, f33: { on: false },
    f40: { on: false }, any: true });                                       // f40 = only stocks with the newest quarter (tests-js/quarterly-latest.test.js)
});

test('qrApplyToStock records what the table columns need on the stock and returns the reasons it fails', () => {
  withData({ aaa: rec({ e: 8, ep: -5, eg: null, et: true }), bbb: rec({ q: '2024-09-30' }) });
  const dom = installFakeDom(sb, {});
  dom.el('scrF22On').checked = true;
  const a = { symbol: 'AAA' };
  assert.deepEqual(Array.from(sb.qrApplyToStock(a, sb.qrFilterState())), []);   // a turnaround passes F22
  assert.equal(a._qrQtr, '2024-12-31'); assert.equal(a._qrProfitNow, 8); assert.equal(a._qrProfitPrev, -5);
  assert.ok(Number.isNaN(a._qrEarn), 'no % growth from a loss: NaN, not null');
  assert.equal(a._qrSalesNow, 130); assert.equal(a._qrSalesPrev, 100); assert.equal(a._qrSales, 30);
  const b = { symbol: 'BBB' };
  assert.match(sb.qrApplyToStock(b, sb.qrFilterState())[0], /^F22: Not an earnings turnaround/);   // profit both years: not one
  assert.equal(b._qrQtr, '2024-09-30');
  const z = { symbol: 'ZZZ' };
  assert.match(sb.qrApplyToStock(z, sb.qrFilterState())[0], /No quarterly results for this stock/);
  assert.equal(z._qrQtr, ''); assert.ok(Number.isNaN(z._qrProfitNow));
});

test('qrActiveCount and qrUpdateBadge: the scanner adds the count to its own, the tab shows it', () => {
  const dom = installFakeDom(sb, {});
  assert.equal(sb.qrActiveCount(), 0);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 0); assert.equal(dom.el('scrTabQtrCount').style.display, 'none');
  dom.el('scrF21On').checked = true; dom.el('scrF23On').checked = true;
  assert.equal(sb.qrActiveCount(), 2);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 2); assert.equal(dom.el('scrTabQtrCount').style.display, 'inline-block');
});

test('qrColumns: nothing when no filter is on, else the quarter column plus one per filter, with the formats the table shows', () => {
  const dom = installFakeDom(sb, {});
  assert.deepEqual(Array.from(sb.qrColumns()), []);
  dom.el('scrF20On').checked = true; dom.el('scrF21On').checked = true; dom.el('scrF22On').checked = true; dom.el('scrF23On').checked = true;
  const cols = Array.from(sb.qrColumns());
  assert.deepEqual(cols.map(c => c.label), ['Result Qtr', 'Earnings YoY%', 'Sales YoY%', 'Profit Cr (yr ago → now)', 'Sales Cr (yr ago → now)']);
  assert.deepEqual(cols.map(c => c.key), ['_qrQtr', '_qrEarn', '_qrSales', '_qrProfitNow', '_qrSalesNow']);
  assert.equal(cols[0].fmt('2026-06-30'), 'Jun-2026');
  assert.equal(cols[1].fmt(12.34), '+12.3%'); assert.equal(cols[1].fmt(-4), '-4.0%'); assert.equal(cols[1].fmt(NaN), '-');
  assert.equal(cols[1].cls(5), 'positive'); assert.equal(cols[1].cls(-5), 'negative'); assert.equal(cols[1].cls(NaN), '');
  assert.equal(cols[3].fmt(828, { _qrProfitPrev: -1217 }), '-1,217 → 828');
  assert.equal(cols[4].fmt(103.0122, { _qrSalesPrev: 0 }), '0 → 103');
  assert.equal(cols[3].fmt(NaN, { _qrProfitPrev: 1 }), '-');
  // only the ticked ones
  dom.el('scrF20On').checked = false; dom.el('scrF21On').checked = false; dom.el('scrF23On').checked = false;
  assert.deepEqual(Array.from(sb.qrColumns()).map(c => c.label), ['Result Qtr', 'Profit Cr (yr ago → now)']);
});

test('qrReset puts the four filters back to their defaults', () => {
  const dom = installFakeDom(sb, {});
  for (const id of ['scrF20On', 'scrF21On', 'scrF22On', 'scrF23On']) dom.el(id).checked = true;
  dom.el('scrF20Val').value = '99'; dom.el('scrF21Val').value = '77';
  sb.qrReset();
  assert.deepEqual(['scrF20On', 'scrF21On', 'scrF22On', 'scrF23On'].map(id => dom.el(id).checked), [false, false, false, false]);
  assert.equal(dom.el('scrF20Val').value, '20'); assert.equal(dom.el('scrF21Val').value, '10');
});

test('when the numbers arrive late the scanner re-runs for ANY quarterly filter (turnarounds included)', async () => {
  const dom = installFakeDom(sb, {});
  sb.fetch = async () => ({ ok: true, json: async () => ({ bySymbol: {}, latestQuarter: null }) });
  sb.Store.dashboardVisible = true;
  let reruns = 0;
  sb.rerunScreenerRespectingMultiPreset = () => { reruns++; };
  await sb.loadQuarterlyResults();
  assert.equal(reruns, 0, 'no quarterly filter on: nothing to re-run');
  dom.el('scrF22On').checked = true;       // a turnaround filter only - the first version re-ran for F20 / F21 alone
  await sb.loadQuarterlyResults();
  assert.equal(reruns, 1);
  assert.equal(sb.Store.quarterlyState, 'ready');
  sb.fetch = async () => ({ ok: false, status: 404 });
  await sb.loadQuarterlyResults();
  assert.equal(sb.Store.quarterlyState, 'missing'); assert.equal(sb.Store.quarterly, null);   // no results file yet
});

test('the scanner (screener.js) knows the feature only through the hooks: no filter ids, fields or columns of its own', () => {
  const src = fs.readFileSync(path.join(path.dirname(__dirname), 'js/screener.js'), 'utf8');
  assert.ok(!/scrF2[0-3]/.test(src), 'screener.js must not read or write the quarterly controls');
  assert.ok(!/_qr[A-Z]/.test(src) && !/qrLookup|qrFailReasons|qrFmtCr|qrQuarterLabel/.test(src), 'nor their per-stock fields or helpers');
  for (const hook of ['qrFilterState', 'qrApplyToStock', 'qrActiveCount', 'qrColumns', 'qrReset', 'qrUpdateBadge']) {
    assert.match(src, new RegExp(`typeof ${hook} === 'function'|\\b${hook}\\(s, qr\\)`), `${hook} is called, guarded`);
  }
  assert.match(src, /if \(qr && qr\.any\) failReasons\.push\(\.\.\.qrApplyToStock\(s, qr\)\)/);   // applied only when a filter is on
});

// ── wiring: the filters are in presets, defaults, badges, Reset and the As of Date tab's tab list ──
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');

test('presets save and restore the two filters, and "no preset" turns them off', () => {
  const p = loadScripts(['js/utils.js', 'js/presets.js']);
  const ids = vm.runInContext('PRESET_FIELDS.map(f => f.id).join(",")', p).split(',');
  for (const id of ['scrF20On', 'scrF20Val', 'scrF21On', 'scrF21Val', 'scrF22On', 'scrF23On']) assert.ok(ids.includes(id), id);
  const def = JSON.parse(vm.runInContext('JSON.stringify(DEFAULT_FILTER_STATE)', p));
  assert.equal(def.scrF20On, false);
  assert.equal(def.scrF21On, false);
  assert.equal(def.scrF20Val, '20');
  assert.equal(def.scrF21Val, '10');
  assert.equal(def.scrF22On, false);
  assert.equal(def.scrF23On, false);
});

test('every control the preset list names exists in index.html (no typo can silently drop a filter)', () => {
  const html = read('index.html');
  for (const id of ['scrF20On', 'scrF20Val', 'scrF21On', 'scrF21Val', 'scrF22On', 'scrF23On', 'scrTabQuarterly', 'scrTabQtrCount', 'scrPaneQuarterly', 'scrQtrStatus']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const scripts = [...html.matchAll(/<script src="(js\/[^"?]+)/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('js/screener.js') < scripts.indexOf('js/quarterly-results.js'), 'quarterly-results.js loads after screener.js');
  assert.ok(scripts.indexOf('js/quarterly-results.js') < scripts.indexOf('js/nse-download.js'), 'and before the loader that calls it');
  assert.ok(scripts.includes('js/quarterly-chart-table.js'), 'the chart table module is loaded');
});

test('the As of Date tab hides the new pane/tab like the others', () => {
  const src = read('js/asof-scan.js');
  assert.match(src, /ASOF_OTHER_PANES = \[[^\]]*'scrPaneQuarterly'/);
  assert.match(src, /ASOF_OTHER_TABS = \[[^\]]*'scrTabQuarterly'/);
});

'use strict';
// The Stock Scanner popup's "As of Date" tab (js/asof-scan.js): a separate module that evaluates its own filters
// using only the bars up to a past trading day.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/asof-scan.js']);
sb.renderScreenerTable = () => {}; sb.updateToggleButton = () => {}; sb.closeScreenerFilters = () => {};
const dateOf = i => { const d = new Date(2025, 0, 1 + i); return d.getDate() + '-' + ['Jan','Feb','Mar'][d.getMonth()] + '-2025'; };
const N = 70;
const dates = Array.from({ length: N }, (_, i) => dateOf(i));
const mk = (symbol, closes, turn = 1000) => closes.map((c, i) => ({
  symbol, date: dates[i], open: c, high: c, low: c, close: c, prev: i ? closes[i - 1] : c, turnover: turn, companyName: symbol,
}));

function run(dateIdx, setup) {
  const dom = installFakeDom(sb, { asofDate: '2025-01-' + String(1 + dateIdx).padStart(2, '0') });
  dom.el('asofBVal').value = '2'; dom.el('asofHPeriod').value = '21'; dom.el('asofHVal').value = '0';
  dom.el('asofELen').value = '50'; dom.el('asofEMult').value = '3';
  setup(dom);
  sb.Store.dates = dates;
  sb.Store.sectorMap = {};
  sb.Store.dailyBySymbol = {
    UPTHENDOWN: mk('UPTHENDOWN', [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 139 - i)]),
    DOWN: mk('DOWN', Array.from({ length: N }, (_, i) => 200 - i)),
  };
  sb.asOfRun();
  return Array.from(vm.runInContext('_asofPassed', sb), s => s.symbol).sort();
}

test('price above 20 SMA is judged on the chosen past day, not today', () => {
  const on = dom => { dom.el('asofAOn').checked = true; dom.el('asofA20').checked = true; };
  assert.deepEqual(run(39, on), ['UPTHENDOWN']);   // day 39: UPTHENDOWN at its peak
  assert.deepEqual(run(69, on), []);               // today: both are below their 20 SMA
});

test('a stock is not scanned on a day it has no bar; later bars never leak into an earlier day', () => {
  const on = dom => { dom.el('asofIOn').checked = true; dom.el('asofI21').checked = true; };
  assert.deepEqual(run(30, on), ['UPTHENDOWN']);   // still rising on day 30
  assert.deepEqual(run(60, on), []);                                                    // nothing new highs
});

test('performance filter uses the chosen day as "today"', () => {
  const on = dom => { dom.el('asofHOn').checked = true; dom.el('asofHVal').value = '10'; };
  assert.deepEqual(run(39, on), ['UPTHENDOWN']);   // +~27% over the prior 21 bars as of day 39
  assert.deepEqual(run(69, on), []);
});

test('no filter ticked lists every stock that traded that day', () => {
  assert.deepEqual(run(10, () => {}), ['DOWN', 'UPTHENDOWN']);
});

test('price above 200 EMA: needs 200 bars before the day, then compares the close with the EMA', () => {
  const closes = [...Array.from({ length: 200 }, () => 100), ...Array.from({ length: 10 }, (_, i) => 101 + i)];
  const nn = closes.length;
  const dts = Array.from({ length: nn }, (_, i) => { const d = new Date(2025, 0, 1 + i); return d.getDate() + '-' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug'][d.getMonth()] + '-2025'; });
  const dom = installFakeDom(sb, { asofDate: '2025-07-29' });
  dom.el('asofAOn').checked = true; dom.el('asofAE200').checked = true; dom.el('asofA20').checked = false;
  dom.el('asofHPeriod').value = '21';
  sb.Store.dates = dts; sb.Store.sectorMap = {};
  const bars = closes.map((c, i) => ({ symbol: 'X', date: dts[i], open: c, high: c, low: c, close: c, prev: c, turnover: 1 }));
  sb.Store.dailyBySymbol = { X: bars, SHORT: bars.slice(-50) };
  sb.asOfRun();
  assert.deepEqual(Array.from(vm.runInContext('_asofPassed', sb), s => s.symbol), ['X']);   // SHORT has < 200 bars
});

test('Exclude Circuits uses the band in force ON the chosen date (carried forward between changes)', async () => {
  const dom = installFakeDom(sb, { asofDate: '2025-01-21' });          // day index 20
  dom.el('asofJOn').checked = true; dom.el('asofJ2').checked = true; dom.el('asofJ5').checked = true; dom.el('asofJ10').checked = true;
  dom.el('asofHPeriod').value = '21';
  sb.Store.dates = dates; sb.Store.sectorMap = {};
  sb.Store.dailyBySymbol = { UPTHENDOWN: mk('UPTHENDOWN', Array.from({ length: N }, () => 100)), DOWN: mk('DOWN', Array.from({ length: N }, () => 100)), NEWCO: mk('NEWCO', Array.from({ length: N }, () => 100)) };
  // UPTHENDOWN: 5% until 15-Jan, then 20% (not excluded). DOWN: 20% until 10-Jan, then 2% (excluded on the 21st). NEWCO: no history.
  vm.runInContext('_asofBandHistory = null', sb);
  sb.fetch = async () => ({ ok: true, json: async () => ({ bySymbol: {
    upthendown: [['2025-01-01', '5'], ['2025-01-16', '20']],
    down: [['2025-01-01', '20'], ['2025-01-11', '2']],
  } }) });
  await sb.asOfRun();
  assert.deepEqual(Array.from(vm.runInContext('_asofPassed', sb), s => s.symbol).sort(), ['NEWCO', 'UPTHENDOWN']);
  dom.el('asofDate').value = '2025-01-10';                              // DOWN still 20%, UPTHENDOWN still 5% (excluded)
  await sb.asOfRun();
  assert.deepEqual(Array.from(vm.runInContext('_asofPassed', sb), s => s.symbol).sort(), ['DOWN', 'NEWCO']);
});

test('% change between two dates on chosen O/H/L/C fields, capped at the scan date', () => {
  const dom = installFakeDom(sb, { asofDate: '2025-02-09' });                  // day index 39: UPTHENDOWN at 139
  dom.el('asofKOn').checked = true;
  dom.el('asofKFromDate').value = '2025-01-01'; dom.el('asofKToDate').value = '2025-03-01';   // To is after the scan date: capped
  dom.el('asofKFromField').value = 'close'; dom.el('asofKToField').value = 'close'; dom.el('asofKVal').value = '30';
  dom.el('asofHPeriod').value = '21';
  sb.Store.dates = dates; sb.Store.sectorMap = {};
  sb.Store.dailyBySymbol = {
    UPTHENDOWN: mk('UPTHENDOWN', [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 139 - i)]),
    DOWN: mk('DOWN', Array.from({ length: N }, (_, i) => 200 - i)),
  };
  sb.asOfRun();
  assert.deepEqual(Array.from(vm.runInContext('_asofPassed', sb), s => s.symbol), ['UPTHENDOWN']);  // 100 -> 139 = +39%
  dom.el('asofKVal').value = '40';
  sb.asOfRun();
  assert.deepEqual(Array.from(vm.runInContext('_asofPassed', sb), s => s.symbol), []);
});

// ─── each filter on its own ─────────────────────────────────────────────────────

// One stock, N bars; `bars` overrides let a test shape high/low/turnover. Scans as of the last day unless dateIso is given.
function scanOne(setup, mkBars, dateIso) {
  const n = 300;
  const dts = Array.from({ length: n }, (_, i) => { const d = new Date(2024, 0, 1 + i); return d.getDate() + '-' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + '-' + d.getFullYear(); });
  const last = new Date(2024, 0, n);
  const dom = installFakeDom(sb, { asofDate: dateIso || `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}` });
  dom.el('asofHPeriod').value = '21';
  setup(dom);
  sb.Store.dates = dts; sb.Store.sectorMap = {};
  sb.Store.dailyBySymbol = { X: mkBars(dts, n) };
  sb.asOfRun();
  return Array.from(vm.runInContext('_asofPassed', sb), s => s.symbol);
}
const bar = (dts, i, o) => ({ symbol: 'X', date: dts[i], open: 100, high: 100, low: 100, close: 100, prev: 100, turnover: 1000, companyName: 'X', ...o });

test('Day Change >= value uses the chosen day close vs previous close', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, i === n - 1 ? { close: 103, prev: 100 } : {}));
  const on = v => dom => { dom.el('asofBOn').checked = true; dom.el('asofBVal').value = v; };
  assert.deepEqual(scanOne(on('2'), mkBars), ['X']);
  assert.deepEqual(scanOne(on('3.5'), mkBars), []);
});

test('Turnover > value is in crore (value x 100 lakh)', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { turnover: 600 }));   // 6 Cr
  const on = v => dom => { dom.el('asofCOn').checked = true; dom.el('asofCVal').value = v; };
  assert.deepEqual(scanOne(on('5'), mkBars), ['X']);
  assert.deepEqual(scanOne(on('7'), mkBars), []);
});

test('Avg Turnover over N days needs N bars and compares the average', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { turnover: i >= n - 10 ? 1000 : 0 }));   // last 10 days 10 Cr, before 0
  const on = (len, v) => dom => { dom.el('asofDOn').checked = true; dom.el('asofDLen').value = len; dom.el('asofDVal').value = v; };
  assert.deepEqual(scanOne(on('10', '9'), mkBars), ['X']);
  assert.deepEqual(scanOne(on('20', '9'), mkBars), []);        // 20-day average is only 5 Cr
  assert.deepEqual(scanOne(on('500', '0'), mkBars), []);       // more bars than exist
});

test('Turnover Spike compares the day with the average of the N days BEFORE it', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { turnover: i === n - 1 ? 400 : 100 }));
  const on = m => dom => { dom.el('asofEOn').checked = true; dom.el('asofEMult').value = m; dom.el('asofELen').value = '50'; };
  assert.deepEqual(scanOne(on('3'), mkBars), ['X']);           // 4x the prior average
  assert.deepEqual(scanOne(on('5'), mkBars), []);
});

test('% from 52W High range uses up to the last 250 bars ending on the chosen day', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, i === 100 ? { high: 200 } : { high: 100 }));
  const on = (a, b) => dom => { dom.el('asofFOn').checked = true; dom.el('asofFMin').value = a; dom.el('asofFMax').value = b; };
  assert.deepEqual(scanOne(on('0', '10'), mkBars), []);        // 200 peak is 50% above the close of 100
  assert.deepEqual(scanOne(on('45', '55'), mkBars), ['X']);
  // the same stock as of a day BEFORE the peak: no peak yet, so it sits at its high
  assert.deepEqual(scanOne(on('0', '10'), mkBars, '2024-03-01'), ['X']);
});

test('ADR% over N days needs N bars', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { high: 105, low: 95 }));   // 10% range
  const on = (len, v) => dom => { dom.el('asofGOn').checked = true; dom.el('asofGLen').value = len; dom.el('asofGVal').value = v; };
  assert.deepEqual(scanOne(on('50', '9'), mkBars), ['X']);
  assert.deepEqual(scanOne(on('50', '11'), mkBars), []);
  assert.deepEqual(scanOne(on('999', '1'), mkBars), []);
});

test('Performance over the chosen period needs period+1 bars', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { close: 100 + i }));
  const on = (p, v) => dom => { dom.el('asofHOn').checked = true; dom.el('asofHPeriod').value = p; dom.el('asofHVal').value = v; };
  assert.deepEqual(scanOne(on('21', '5'), mkBars), ['X']);     // close 399 vs 378 21 bars earlier = +5.56%
  assert.deepEqual(scanOne(on('21', '6'), mkBars), []);
  assert.deepEqual(scanOne(on('250', '100'), mkBars), ['X']);  // 399 vs 149 = +167%
  assert.deepEqual(scanOne(on('21', '0'), mkBars, '2024-01-10'), []);   // only 10 bars of history that day
});

test('Making New High: every ticked window must be a strict new high; needs the full window of history', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { high: i === n - 1 ? 150 : 100 }));
  const on = (w21, w63, w252) => dom => {
    dom.el('asofIOn').checked = true;
    dom.el('asofI21').checked = w21; dom.el('asofI63').checked = w63; dom.el('asofI252').checked = w252;
  };
  assert.deepEqual(scanOne(on(true, true, true), mkBars), ['X']);
  const flatBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, {}));
  assert.deepEqual(scanOne(on(true, false, false), flatBars), []);                    // equal is not a new high
  assert.deepEqual(scanOne(on(false, false, true), mkBars, '2024-06-01'), []);        // < 252 bars of history that day
});

test('Price above 20 / 50 / 200 SMA: all ticked averages must be below the close; short history fails', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { close: 100 + i }));
  const on = (a20, a50, a200) => dom => {
    dom.el('asofAOn').checked = true; dom.el('asofA20').checked = a20; dom.el('asofA50').checked = a50; dom.el('asofA200').checked = a200;
  };
  assert.deepEqual(scanOne(on(true, true, true), mkBars), ['X']);
  assert.deepEqual(scanOne(on(false, false, true), mkBars, '2024-05-01'), []);        // day 122: no 200 bars yet
  const falling = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { close: 500 - i }));
  assert.deepEqual(scanOne(on(true, false, false), falling), []);
});

test('filters combine with AND', () => {
  const mkBars = (dts, n) => Array.from({ length: n }, (_, i) => bar(dts, i, { close: 100 + i, turnover: 600 }));
  const both = dom => { dom.el('asofAOn').checked = true; dom.el('asofCOn').checked = true; dom.el('asofCVal').value = '5'; };
  assert.deepEqual(scanOne(both, mkBars), ['X']);
  const failsOne = dom => { both(dom); dom.el('asofCVal').value = '7'; };
  assert.deepEqual(scanOne(failsOne, mkBars), []);
});

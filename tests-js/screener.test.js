'use strict';
// Phase 7: pure-computation unit tests for js/screener.js (the Stock Scanner/Screener
// tab's filter math), run with Node's built-in test runner - no bundler, no extra
// dependency, matching the project's own minimal-dependency ethos. This is a separate
// track from the Python test suite (tests/, run with pytest): different language,
// different runtime, see AGENT.md "Completed: Test Suite" Phase 7.
//
// Scope: only the functions that are genuinely pure (take plain values/arrays, return a
// value, touch neither `document` nor `Store`) - runScreener() itself and everything it
// renders are wired through Store/DOM/IndexedDB-backed presets and are lower priority for
// the same reason Phase 2's process_data() end-to-end tests were higher-value than testing
// nse_server.py's HTTP handler class: the computational core is where the real risk is.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const { computeDynSMA, computeDynEMA, computeDynSMAPartial, computeDynEMAPartial,
        computeDynADR, computeDynADRPartial, computeDynPerformance, computeDynPerformancePartial,
        scrIsoToTs, scrBarIdxOnOrBefore, computeDynDateChange, checkCoOccurrence, parseDate } =
  loadScripts(['js/utils.js', 'js/screener.js']);

function day(date, overrides = {}) {
  return { date, open: 100, high: 105, low: 95, close: 100, turnover: 10, ...overrides };
}

// ─── computeDynSMA / computeDynEMA ──────────────────────────────────────────────

test('computeDynSMA: not enough bars -> NaN', () => {
  assert.ok(Number.isNaN(computeDynSMA([day('01-Sep-2025')], 'close', 5)));
});

test('computeDynSMA: average of the last N values of the field', () => {
  const days = [10, 20, 30, 40, 50].map((c, i) => day(`0${i + 1}-Sep-2025`, { close: c }));
  assert.equal(computeDynSMA(days, 'close', 3), (30 + 40 + 50) / 3);
});

test('computeDynSMA: missing field values treated as 0', () => {
  const days = [day('01-Sep-2025', { close: undefined }), day('02-Sep-2025', { close: 10 })];
  assert.equal(computeDynSMA(days, 'close', 2), 5); // (0 + 10) / 2
});

test('computeDynEMA: not enough bars -> NaN', () => {
  assert.ok(Number.isNaN(computeDynEMA([day('01-Sep-2025')], 'close', 5)));
});

test('computeDynEMA: seeds with SMA of the first N, then applies the EMA formula', () => {
  const days = [10, 20, 30].map((c, i) => day(`0${i + 1}-Sep-2025`, { close: c }));
  // length=2 -> k=2/3. Seed = SMA(10,20)=15. Then day3 (30): ema = 30*(2/3) + 15*(1/3) = 25.
  assert.equal(computeDynEMA(days, 'close', 2), 25);
});

// ─── Partial variants (min 5 bars, use whatever's available) ───────────────────

test('computeDynSMAPartial: fewer than 5 bars -> NaN', () => {
  const days = [1, 2, 3, 4].map((c, i) => day(`0${i + 1}-Sep-2025`, { close: c }));
  assert.ok(Number.isNaN(computeDynSMAPartial(days, 'close', 20)));
});

test('computeDynSMAPartial: averages over whatever is available (>=5)', () => {
  const days = [1, 2, 3, 4, 5].map((c, i) => day(`0${i + 1}-Sep-2025`, { close: c }));
  assert.equal(computeDynSMAPartial(days, 'close', 20), 3); // avg(1..5), length 20 unreachable
});

test('computeDynEMAPartial: fewer than 5 bars -> NaN', () => {
  const days = [1, 2, 3].map((c, i) => day(`0${i + 1}-Sep-2025`, { close: c }));
  assert.ok(Number.isNaN(computeDynEMAPartial(days, 'close', 20)));
});

// ─── computeDynADR / computeDynADRPartial ───────────────────────────────────────

test('computeDynADR: average daily range % over the last N bars', () => {
  const days = [day('01-Sep-2025', { high: 110, low: 90, close: 100 }),  // 20%
                day('02-Sep-2025', { high: 105, low: 95, close: 100 })]; // 10%
  assert.equal(computeDynADR(days, 2), 15);
});

test('computeDynADRPartial: fewer than 5 bars -> NaN', () => {
  const days = [day('01-Sep-2025')];
  assert.ok(Number.isNaN(computeDynADRPartial(days, 20)));
});

// ─── computeDynPerformance / computeDynPerformancePartial ──────────────────────

test('computeDynPerformance: % change over exactly N trading days back', () => {
  const days = [100, 105, 110, 121].map((c, i) => day(`0${i + 1}-Sep-2025`, { close: c }));
  assert.equal(computeDynPerformance(days, 3), 21); // (121-100)/100*100
});

test('computeDynPerformance: not enough history -> NaN', () => {
  const days = [day('01-Sep-2025')];
  assert.ok(Number.isNaN(computeDynPerformance(days, 5)));
});

test('computeDynPerformance: zero/negative reference close -> NaN (never divide by zero)', () => {
  const days = [day('01-Sep-2025', { close: 0 }), day('02-Sep-2025', { close: 100 })];
  assert.ok(Number.isNaN(computeDynPerformance(days, 1)));
});

test('computeDynPerformancePartial: uses whatever lookback is available', () => {
  const days = [100, 150].map((c, i) => day(`0${i + 1}-Sep-2025`, { close: c }));
  assert.equal(computeDynPerformancePartial(days, 999), 50); // only 1 bar back is available
});

// ─── scrIsoToTs / scrBarIdxOnOrBefore ───────────────────────────────────────────

test('scrIsoToTs: converts YYYY-MM-DD to a local-midnight timestamp', () => {
  assert.equal(scrIsoToTs('2025-09-04'), new Date(2025, 8, 4).getTime());
});

test('scrIsoToTs: empty/missing input -> NaN', () => {
  assert.ok(Number.isNaN(scrIsoToTs('')));
  assert.ok(Number.isNaN(scrIsoToTs(null)));
});

test('scrBarIdxOnOrBefore: finds the last bar on/before ts', () => {
  const days = [day('01-Sep-2025'), day('03-Sep-2025'), day('05-Sep-2025')];
  const ts = parseDate('04-Sep-2025');
  assert.equal(scrBarIdxOnOrBefore(days, ts), 1); // 03-Sep is the last bar <= 04-Sep
});

test('scrBarIdxOnOrBefore: ts before every bar -> -1', () => {
  const days = [day('01-Sep-2025'), day('03-Sep-2025')];
  assert.equal(scrBarIdxOnOrBefore(days, parseDate('01-Aug-2025')), -1);
});

test('scrBarIdxOnOrBefore: ts after every bar -> last index', () => {
  const days = [day('01-Sep-2025'), day('03-Sep-2025')];
  assert.equal(scrBarIdxOnOrBefore(days, parseDate('01-Oct-2025')), 1);
});

// ─── computeDynDateChange ────────────────────────────────────────────────────────

test('computeDynDateChange: normal case computes % change between the two dates', () => {
  const days = [day('01-Sep-2025', { close: 100 }), day('10-Sep-2025', { close: 120 })];
  const from = parseDate('01-Sep-2025'), to = parseDate('10-Sep-2025');
  const res = computeDynDateChange(days, from, 'close', to, 'close', false);
  assert.equal(res.pct, 20);
});

test('computeDynDateChange: no From date selected', () => {
  const res = computeDynDateChange([day('01-Sep-2025')], NaN, 'close', parseDate('02-Sep-2025'), 'close', false);
  assert.ok(Number.isNaN(res.pct));
  assert.equal(res.reason, 'No From date selected');
});

test('computeDynDateChange: From date after To date', () => {
  const days = [day('01-Sep-2025')];
  const res = computeDynDateChange(days, parseDate('10-Sep-2025'), 'close', parseDate('01-Sep-2025'), 'close', false);
  assert.equal(res.reason, 'From date is after To date');
});

test('computeDynDateChange: From date before all data, allowPartial=false -> error', () => {
  const days = [day('05-Sep-2025', { close: 100 })];
  const res = computeDynDateChange(days, parseDate('01-Sep-2025'), 'close', parseDate('05-Sep-2025'), 'close', false);
  assert.equal(res.reason, 'No data on/before From date');
});

test('computeDynDateChange: From date before all data, allowPartial=true -> falls back to first bar', () => {
  const days = [day('05-Sep-2025', { close: 100 }), day('10-Sep-2025', { close: 110 })];
  const res = computeDynDateChange(days, parseDate('01-Sep-2025'), 'close', parseDate('10-Sep-2025'), 'close', true);
  assert.equal(res.pct, 10); // (110-100)/100*100, using day 1 (05-Sep) as the fallback "from"
});

test('computeDynDateChange: a non-trading From/To date uses the nearest earlier trading day', () => {
  const days = [day('01-Sep-2025', { close: 100 }), day('03-Sep-2025', { close: 100 }), day('08-Sep-2025', { close: 110 })];
  // 02-Sep and 07-Sep aren't trading days (weekend) - should resolve to 01-Sep and 03-Sep/08-Sep respectively.
  const res = computeDynDateChange(days, parseDate('02-Sep-2025'), 'close', parseDate('08-Sep-2025'), 'close', false);
  assert.equal(res.pct, 10);
});

test('computeDynDateChange: missing/zero price on the selected date', () => {
  const days = [day('01-Sep-2025', { close: 0 }), day('05-Sep-2025', { close: 100 })];
  const res = computeDynDateChange(days, parseDate('01-Sep-2025'), 'close', parseDate('05-Sep-2025'), 'close', false);
  assert.equal(res.reason, 'Missing price on selected date');
});

// ─── checkCoOccurrence ────────────────────────────────────────────────────────────

test('checkCoOccurrence: not enough history -> zero hits', () => {
  const days = [day('01-Sep-2025')];
  assert.equal(checkCoOccurrence(days, 3, 2, 20, 1, 10, false).hits, 0);
});

test('checkCoOccurrence: counts a day with both a big % move AND elevated turnover', () => {
  // 20 flat days to build a stable SMA-turnover baseline, then one day with a big jump
  // in both price (+5%) and turnover (3x the baseline).
  const days = [];
  for (let i = 0; i < 20; i++) days.push(day(`d${i}`, { close: 100, turnover: 10 }));
  days.push(day('spike', { close: 105, turnover: 30 })); // prevClose=100 -> +5%; turnover 30 = 3x SMA(10)

  const res = checkCoOccurrence(days, 3, 2, 20, 1, 5, false);
  assert.equal(res.hits, 1);
  // res.hitDates is an Array from the vm sandbox's own realm, not this file's - compare
  // element-wise rather than with deepEqual, which fails cross-realm array structural
  // checks even when the (primitive, so realm-agnostic) contents are identical.
  assert.equal(res.hitDates.length, 1);
  assert.equal(res.hitDates[0], 'spike');
});

test('checkCoOccurrence: big price move alone (turnover not elevated) does not count', () => {
  const days = [];
  for (let i = 0; i < 20; i++) days.push(day(`d${i}`, { close: 100, turnover: 10 }));
  days.push(day('spike', { close: 110, turnover: 10 })); // +10% move but turnover unchanged

  const res = checkCoOccurrence(days, 3, 2, 20, 1, 5, false);
  assert.equal(res.hits, 0);
});

test('checkCoOccurrence: elevated turnover alone (price move too small) does not count', () => {
  const days = [];
  for (let i = 0; i < 20; i++) days.push(day(`d${i}`, { close: 100, turnover: 10 }));
  days.push(day('spike', { close: 100.5, turnover: 30 })); // turnover 3x, but only +0.5% move

  const res = checkCoOccurrence(days, 3, 2, 20, 1, 5, false);
  assert.equal(res.hits, 0);
});

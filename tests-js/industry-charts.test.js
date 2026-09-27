'use strict';
// Tests for js/industry-charts.js's Industry Money Flow / Rate of Change chart series
// builders. These are the pure data-prep functions behind the "Industry Money Flow Chart"
// tab's two side-by-side lines (see icBuildMoneyFlowChart/icBuildMfRocChart); the chart
// objects themselves (LightweightCharts instances, DOM legends) aren't touched here.
//
// Same vm-sandbox approach as industry.test.js: Store is populated by hand before each
// call. industry-charts.js also has several top-level `document.getElementById('...').
// addEventListener(...)` calls (wiring its toggle checkboxes), which is why load.js's
// stub element needs a no-op addEventListener - see the comment there.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/industry-charts.js']);
const { icComputeIndustryMoneyFlowSeries, icComputeMoneyFlowRocSeries, Store } = sb;

function resetStore() {
  Store.dates = [];
  Store.dailyBySymbol = {};
}

// Field-by-field rather than assert.deepEqual(time, {year,month,day}): the sandbox's
// {year,month,day} object and a plain literal written here live in different vm realms,
// which trips deepStrictEqual's prototype-identity check even when every field matches
// (see the same caveat noted in industry.test.js).
function assertTime(time, year, month, day) {
  assert.equal(time.year, year);
  assert.equal(time.month, month);
  assert.equal(time.day, day);
}

// Turnover per day (1-indexed day1..day12), single stock: 10,20,30,...,120.
// ewToBusinessDay parses "D-Mon-YYYY" - the day/month/year don't need to be real calendar
// dates, just parseable, so a simple incrementing day-of-month is fine.
function buildTwelveDayFixture() {
  resetStore();
  const dates = Array.from({ length: 12 }, (_, i) => `${i + 1}-Jan-2025`);
  Store.dates = dates;
  Store.dailyBySymbol = { ISIN1: dates.map((d, i) => ({ date: d, turnover: (i + 1) * 10 })) };
  return [{ isin: 'ISIN1' }];
}

// ─── icComputeIndustryMoneyFlowSeries ────────────────────────────────────────────

test('icComputeIndustryMoneyFlowSeries: one point per day once a full previous window exists, hand-derived', () => {
  const stocks = buildTwelveDayFixture();
  const numDays = 3;
  const { data, dateByTime } = icComputeIndustryMoneyFlowSeries(stocks, numDays);

  // First full previous-window day is index 2*3-1=5 (0-indexed) -> day6; last is day12 -> 7 points.
  assert.equal(data.length, 7);

  // day6 (index5): cur = day4+5+6 = 40+50+60=150, prev = day1+2+3 = 10+20+30=60 -> (150-60)/60*100=150%
  assert.equal(data[0].value, 150);
  assertTime(data[0].time, 2025, 1, 6);

  // day12 (index11, last): cur = day10+11+12 = 100+110+120=330, prev = day7+8+9 = 70+80+90=240
  // -> (330-240)/240*100 = 37.5%
  assert.equal(data[6].value, 37.5);
  assertTime(data[6].time, 2025, 1, 12);

  assert.equal(dateByTime.get('2025-1-6'), '6-Jan-2025');
});

test('icComputeIndustryMoneyFlowSeries: fewer than 2*numDays trading days -> no points', () => {
  resetStore();
  const dates = Array.from({ length: 5 }, (_, i) => `${i + 1}-Jan-2025`);
  Store.dates = dates;
  Store.dailyBySymbol = { ISIN1: dates.map(d => ({ date: d, turnover: 10 })) };

  const { data } = icComputeIndustryMoneyFlowSeries([{ isin: 'ISIN1' }], 3); // needs 6 days, only 5 exist
  assert.equal(data.length, 0);
});

// ─── icComputeMoneyFlowRocSeries (Money Flow Rate of Change chart) ──────────────
// Rate of Change reading at day T = the money-flow line's own value at T minus its value
// exactly `numDays` trading days earlier - see js/industry-charts.js's comment above the
// function, and the matching Industry Analysis / Scanner F17 formula in industry.test.js.

test('icComputeMoneyFlowRocSeries: each point is the base line minus itself one window back, hand-derived', () => {
  const stocks = buildTwelveDayFixture();
  const numDays = 3;
  const { data: baseData } = icComputeIndustryMoneyFlowSeries(stocks, numDays);
  const { data: rocData, dateByTime } = icComputeMoneyFlowRocSeries(stocks, numDays);

  // Base line has 7 points (see above); RoC needs one more window back -> 7-3=4 points.
  assert.equal(rocData.length, 4);

  // Every RoC point[j] (0-indexed within rocData) is baseData[numDays+j] - baseData[j].
  rocData.forEach((p, j) => {
    const expected = baseData[numDays + j].value - baseData[j].value;
    assert.ok(Math.abs(p.value - expected) < 1e-9, `point ${j}: ${p.value} vs ${expected}`);
    assert.deepEqual(p.time, baseData[numDays + j].time);
  });

  // First RoC point lines up with day9 (index 2*3-1+3=8, 0-indexed -> day9): base day9 (60) minus
  // base day6 (150) = -90.
  assert.equal(rocData[0].value, -90);
  assertTime(rocData[0].time, 2025, 1, 9);
  assert.equal(dateByTime.get('2025-1-9'), '9-Jan-2025');

  // Last RoC point: day12 (37.5) minus day9's base value (60) = -22.5.
  assert.equal(rocData[3].value, -22.5);
});

test('icComputeMoneyFlowRocSeries: fewer than 3*numDays trading days -> no points (needs one more window than the base line)', () => {
  resetStore();
  // 8 days: enough for the base line (needs 2*3=6) to have 3 points, but not enough for any
  // RoC point (needs the base line to already have more than numDays=3 points).
  const dates = Array.from({ length: 8 }, (_, i) => `${i + 1}-Jan-2025`);
  Store.dates = dates;
  Store.dailyBySymbol = { ISIN1: dates.map(d => ({ date: d, turnover: 10 })) };
  const stocks = [{ isin: 'ISIN1' }];

  const { data: baseData } = icComputeIndustryMoneyFlowSeries(stocks, 3);
  assert.equal(baseData.length, 3); // base line does have points...
  const { data: rocData } = icComputeMoneyFlowRocSeries(stocks, 3);
  assert.equal(rocData.length, 0); // ...but not enough of them yet for a RoC reading
});

test('icComputeMoneyFlowRocSeries: aggregates turnover across multiple stocks in the industry', () => {
  resetStore();
  const dates = Array.from({ length: 12 }, (_, i) => `${i + 1}-Jan-2025`);
  Store.dates = dates;
  // Same combined per-day turnover as buildTwelveDayFixture (10,20,...,120), split across two stocks.
  Store.dailyBySymbol = {
    A: dates.map((d, i) => ({ date: d, turnover: (i + 1) * 10 * 0.4 })),
    B: dates.map((d, i) => ({ date: d, turnover: (i + 1) * 10 * 0.6 })),
  };
  const stocks = [{ isin: 'A' }, { isin: 'B' }];

  const { data: rocData } = icComputeMoneyFlowRocSeries(stocks, 3);
  assert.equal(rocData.length, 4);
  assert.equal(rocData[0].value, -90); // identical to the single-stock fixture's result
});

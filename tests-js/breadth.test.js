'use strict';
// js/breadth.js's "Stocks Making New Highs" maths (computeBreadthHistories): the share of stocks whose
// day's high is a new 1M (21 trading days) / 3M (63) / 1Y (252) / all-time high. Same JS track as the
// other tests-js files (Node's built-in test runner).
//
// computeBreadthHistories() reads Store.dates / Store.dailyBySymbol directly, so each test fills the
// sandbox's Store the way the real page's data load does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/breadth.js']);
const { computeBreadthHistories, Store } = sb;

const N = 300; // trading days of history in the fixtures (>= 252, so the 1Y / ATH rules can apply)
const dates = Array.from({ length: N }, (_, i) => 'D' + String(i).padStart(3, '0'));

// A stock whose daily high is highs[i] (aligned to the LAST highs.length dates); the other fields are
// derived so the above-SMA / move maths that share the loop have valid numbers to chew on.
function stock(symbol, highs) {
  const offset = N - highs.length;
  return highs.map((h, i) => ({
    date: dates[offset + i], open: h * 0.99, high: h, low: h * 0.98, close: h * 0.99, prev: h * 0.99, symbol,
  }));
}

function run(stocks) {
  Store.dates = dates;
  Store.dailyBySymbol = {};
  stocks.forEach(s => { Store.dailyBySymbol[s[0].symbol] = s; });
  return computeBreadthHistories(N);
}

const last = (hist) => hist[hist.length - 1];
const rising = (n, start = 100) => Array.from({ length: n }, (_, i) => start + i);
const flat = (n, v = 100) => Array.from({ length: n }, () => v);

test('a steadily rising stock is making a 1M, 3M, 1Y and all-time high every day', () => {
  const h = last(run([stock('UP', rising(N))]));
  assert.equal(h.high1mCloseCount, 1);
  assert.equal(h.high3mCloseCount, 1);
  assert.equal(h.high1yCloseCount, 1);
  assert.equal(h.highAthCloseCount, 1);
  assert.equal(h.high3mOHLC.close, 100);
});

test('a flat stock is never making new highs (ties do not count)', () => {
  const h = last(run([stock('FLAT', flat(N))]));
  assert.equal(h.high1mCloseCount, 0);
  assert.equal(h.high3mCloseCount, 0);
  assert.equal(h.high1yCloseCount, 0);
  assert.equal(h.highAthCloseCount, 0);
  // ...but it still counts in the denominator
  assert.equal(h.high1mOHLC.close, 0);
});

test('a stock below its earlier peak is not making a high', () => {
  const highs = [...rising(200), ...Array.from({ length: 100 }, () => 150)]; // peaks at 299, then 150
  const h = last(run([stock('FALL', highs)]));
  assert.equal(h.high1mCloseCount, 0);
  assert.equal(h.highAthCloseCount, 0);
});

test('window lengths: a spike above the last month but below the quarter peak is 1M-only', () => {
  // peak 300 at bar 200, a 150 plateau, then a one-day spike to 200 at bar 250
  const highs = Array.from({ length: N }, (_, i) => (i <= 200 ? 100 + i : 150));
  highs[250] = 200;
  const h = run([stock('SPIKE', highs)])[250];
  assert.equal(h.high1mCloseCount, 1, 'above the previous 20 bars (150)');
  assert.equal(h.high3mCloseCount, 0, 'the 300 peak is still inside the 63-day window');
  assert.equal(h.high1yCloseCount, 0);
  assert.equal(h.highAthCloseCount, 0);
});

test('percentages are a share of stocks with a full window of history', () => {
  // A rises for all 300 days; B is flat and only has the last 30 days of data (e.g. a recent listing).
  const h = last(run([stock('A', rising(N)), stock('B', flat(30))]));
  assert.equal(h.high1mCloseCount, 1);
  assert.equal(h.high1mOHLC.close, 50, '1M: A new high, B flat -> 1 of 2 stocks (B has >= 21 bars)');
  assert.equal(h.high3mOHLC.close, 100, '3M: B has < 63 bars, so only A is in the denominator');
  assert.equal(h.high1yOHLC.close, 100);
  assert.equal(h.highAthOHLC.close, 100);
});

test('all-time high needs a year of history, so early bars never read as new highs', () => {
  const hist = run([stock('UP', rising(N))]);
  assert.equal(hist[100].highAthCloseCount, 0);
  assert.equal(hist[100].highAthOHLC.close, 0);
  assert.equal(hist[251].highAthCloseCount, 1);
});

test('1M needs 21 bars: no reading before the window is full', () => {
  const hist = run([stock('UP', rising(N))]);
  assert.equal(hist[19].high1mCloseCount, 0);
  assert.equal(hist[20].high1mCloseCount, 1);
});

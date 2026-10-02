'use strict';
// js/breadth.js's SMA and big-move breadth (computeBreadthHistories): % of stocks above their 20 / 50 SMA and
// with a 4% day / 10% week / 20% month move. The new-highs maths is in breadth.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/breadth.js']);
const { computeBreadthHistories, Store } = sb;

const N = 300;
const dates = Array.from({ length: N }, (_, i) => 'D' + String(i).padStart(3, '0'));

// open = high = low = close unless a per-index override is given; prev is the previous bar's close.
// The stock covers the LAST closes.length dates.
function ohlcStock(symbol, closes, over = {}) {
  const offset = N - closes.length;
  return closes.map((c, i) => ({
    date: dates[offset + i], open: c, high: c, low: c, close: c, prev: i ? closes[i - 1] : c, symbol, ...(over[i] || {}),
  }));
}

function run(stocks, numDays = N) {
  Store.dates = dates;
  Store.dailyBySymbol = {};
  stocks.forEach(s => { Store.dailyBySymbol[s[0].symbol] = s; });
  return computeBreadthHistories(numDays);
}

const last = (hist) => hist[hist.length - 1];
const rising = (n, start = 100) => Array.from({ length: n }, (_, i) => start + i);
const falling = (n, start = 200) => Array.from({ length: n }, (_, i) => start - i);
const flat = (n, v = 100) => Array.from({ length: n }, () => v);
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test('above 20 SMA: a stock needs 20 bars before it counts', () => {
  const short = last(run([ohlcStock('S', rising(19))]));
  assert.equal(short.above20CloseCount, 0);
  assert.equal(short.above20OHLC.close, 0);
  const enough = last(run([ohlcStock('S', rising(20))]));
  assert.equal(enough.above20CloseCount, 1);
  assert.equal(enough.above20OHLC.close, 100);
});

test('above 20 SMA: strictly above the average of the last 20 closes (today included)', () => {
  assert.equal(last(run([ohlcStock('FLAT', flat(30))])).above20CloseCount, 0, 'equal to its own average is not above');
  assert.equal(last(run([ohlcStock('DOWN', falling(30))])).above20CloseCount, 0);
  assert.equal(last(run([ohlcStock('UP', rising(30))])).above20CloseCount, 1);
});

test('above 20 SMA: the percentage is a share of stocks with enough history', () => {
  const h = last(run([ohlcStock('UP', rising(30)), ohlcStock('DOWN', falling(30)), ohlcStock('NEW', rising(5))]));
  assert.equal(h.above20OHLC.close, 50, '1 of the 2 stocks with >= 20 bars; the 5-bar listing is excluded');
});

test('above 50 SMA: needs 50 bars', () => {
  assert.equal(last(run([ohlcStock('S', rising(49))])).above50CloseCount, 0);
  assert.equal(last(run([ohlcStock('S', rising(50))])).above50CloseCount, 1);
});

test('each OHLC field is tested against the SMA independently, giving a real wick', () => {
  // 29 flat bars at 100, then a day that opens and trades low, spikes, and closes above the average
  const closes = [...flat(29), 110];
  const h = last(run([ohlcStock('S', closes, { 29: { open: 90, high: 112, low: 88 } })]));
  // SMA20 on the last day = (19 * 100 + 110) / 20 = 100.5
  assert.deepEqual(
    { o: h.above20OHLC.open, h: h.above20OHLC.high, l: h.above20OHLC.low, c: h.above20OHLC.close },
    { o: 0, h: 100, l: 0, c: 100 });
});

test('4% day move counts in either direction, measured against the previous close', () => {
  const h = last(run([ohlcStock('UP', [100, 105]), ohlcStock('DOWN', [100, 95]), ohlcStock('SMALL', [100, 103])]));
  assert.equal(h.move4dCloseCount, 2);
  approx(h.move4dOHLC.close, 200 / 3);
});

test('4% day move: a move of exactly 4% counts (threshold is >=)', () => {
  assert.equal(last(run([ohlcStock('EDGE', [100, 104])])).move4dCloseCount, 1);
});

test('10% week move uses the close exactly 5 bars back', () => {
  // closes[1] = 100 is 5 bars before the last bar; the 4- and 6-bar-back closes are 111 (no move)
  assert.equal(last(run([ohlcStock('S', [111, 100, 111, 111, 111, 111, 111])])).move10wCloseCount, 1);
  assert.equal(last(run([ohlcStock('S', [111, 111, 100, 111, 111, 111, 111])])).move10wCloseCount, 0);
});

test('20% month move uses the close exactly 21 bars back, in either direction', () => {
  const up = flat(23, 125); up[1] = 100;      // index 1 is 21 bars before the last bar (index 22)
  assert.equal(last(run([ohlcStock('UP', up)])).move20mCloseCount, 1);
  const down = flat(23, 75); down[1] = 100;
  assert.equal(last(run([ohlcStock('DOWN', down)])).move20mCloseCount, 1);
  const off = flat(23, 125); off[2] = 100;    // 20 bars back: not the reference
  assert.equal(last(run([ohlcStock('OFF', off)])).move20mCloseCount, 0);
});

test('the requested window only trims the output; earlier bars still feed the averages', () => {
  const hist = run([ohlcStock('UP', rising(N))], 50);
  assert.equal(hist.length, 50);
  assert.equal(hist[0].date, dates[N - 50]);
  assert.equal(hist[0].above20CloseCount, 1, 'the SMA on the first output day uses bars from before the window');
  assert.equal(hist[0].above50CloseCount, 1);
});

test('every candle is validly ordered and every percentage is within 0-100 (randomised stocks)', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const stocks = [];
  for (let s = 0; s < 40; s++) {
    let price = 50 + rnd() * 500;
    const len = 60 + Math.floor(rnd() * (N - 60));
    const rows = [];
    for (let i = 0; i < len; i++) {
      const prev = price;
      const open = price * (1 + (rnd() - 0.5) * 0.06);
      price = price * (1 + (rnd() - 0.5) * 0.12);
      rows.push({ prev, open, close: price, high: Math.max(open, price) * (1 + rnd() * 0.03), low: Math.min(open, price) * (1 - rnd() * 0.03) });
    }
    const offset = N - len;
    stocks.push(rows.map((r, i) => ({ ...r, date: dates[offset + i], symbol: 'R' + s })));
  }
  const prefixes = ['above20', 'above50', 'move4d', 'move10w', 'move20m', 'high1m', 'high3m', 'high1y', 'highAth'];
  for (const h of run(stocks)) {
    for (const p of prefixes) {
      const b = h[p + 'OHLC'];
      assert.ok(b.low >= 0 && b.high <= 100, `${p} ${h.date} out of range`);
      assert.ok(b.low <= b.open && b.low <= b.close && b.high >= b.open && b.high >= b.close, `${p} ${h.date} mis-ordered`);
    }
  }
});

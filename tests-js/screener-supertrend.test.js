'use strict';
// The Stock Scanner's Technicals filter F46 "Supertrend": TradingView's ta.supertrend(factor, atrPeriod) on the daily candles, keeping a stock
// whose latest close is above the line (uptrend) or below it (downtrend). Covers the maths (supertrendSeries against a hand-computed series and
// an independent Pine-literal transcription, the direction flips, the ratcheting bands), computeSupertrend (short history, strict comparison),
// the filter through runScreener() (pass / fail / insufficient-data wording, stored values, blank inputs), presets, Reset, the badge counts and the markup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const screenerSrc = fs.readFileSync(path.join(root, 'js', 'screener.js'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/money-flow.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
const { supertrendSeries, computeSupertrend, weeklyBarsFromDaily, capturePresetState, applyPresetState } = sb;

const bar = (high, low, close) => ({ date: 'D', open: close, high, low, close, turnover: 10 });
// daily bars around a list of closes, each with a +/- half range
const around = (closes, half = 0.5) => closes.map((c, i) => ({ date: 'D' + i, open: c, high: c + half, low: c - half, close: c, turnover: 10 }));
const rising = (n, start = 100, step = 1) => Array.from({ length: n }, (_, i) => start + i * step);
const falling = (n, start = 200, step = 1) => Array.from({ length: n }, (_, i) => start - i * step);

// ─── the maths ─────────────────────────────────────────────────────────────────

// A short series worked out by hand with ATR length 2 and factor 1 (all values are exact in binary):
//   bar   H    L    C    TR    ATR(RMA 2)   hl2    upper  lower  final upper  final lower  direction   Supertrend
//    0   10    8    9    2     -            9      -      -      -            -            -           -
//    1   11    9   10.5  2     2   (seed)   10     12     8      12           8            down (first)  12
//    2   12   10   11.5  2     2            11     13     9      12 (13 > 12)  9           down (11.5 <= 12)  12
//    3  11.5   9    9.5  2.5   2.25         10.25  12.5   8      12           9            down          12
//    4   10    8    8.5  2     2.125        9      11.125 6.875  11.125 (falls) 9          down          11.125
//    5   12  9.5   11.5  3.5   2.8125       10.75  13.5625 7.9375 11.125       7.9375 (prior close 8.5 < 9 resets it)  UP (11.5 > 11.125)  7.9375
//    6   13   11   12.5  2     2.40625      12     14.40625 9.59375 14.40625 (prior close 11.5 > 11.125 resets it)  9.59375  up (12.5 >= 9.59375)  9.59375
//    7   12    7    7.5  5.5   3.953125     9.5    13.453125 5.546875 13.453125 9.59375 (ratchets, 5.5 < 9.59)   DOWN (7.5 < 9.59375)  13.453125
const HAND = [bar(10, 8, 9), bar(11, 9, 10.5), bar(12, 10, 11.5), bar(11.5, 9, 9.5), bar(10, 8, 8.5), bar(12, 9.5, 11.5), bar(13, 11, 12.5), bar(12, 7, 7.5)];
const HAND_ST = [null, 12, 12, 12, 11.125, 7.9375, 9.59375, 13.453125];
const HAND_DIR = [null, 'down', 'down', 'down', 'down', 'up', 'up', 'down'];

test('supertrendSeries matches a hand-computed series (ATR length 2, factor 1): values, ratcheting bands and both direction flips', () => {
  const out = supertrendSeries(HAND, 2, 1);
  assert.equal(out.length, HAND.length);
  assert.equal(out[0], null);                                   // no ATR yet on the first atrPeriod - 1 bars
  for (let i = 1; i < HAND.length; i++) {
    assert.equal(out[i].st, HAND_ST[i], `Supertrend on bar ${i}`);
    assert.equal(out[i].dir, HAND_DIR[i], `direction on bar ${i}`);
  }
});

test('the first bar with an ATR starts as a downtrend on the upper band (TradingView: na(atr[1]) -> direction 1), whatever the price does', () => {
  const out = supertrendSeries(around(rising(5)), 3, 2);
  assert.deepEqual(Array.from(out, o => o && o.dir).slice(0, 3), [null, null, 'down']);
  // true ranges 1, 1.5, 1.5 -> the seed ATR is their average 4/3; hl2 is 102, so the line is 102 + 2 * 4/3 on the upper band, above the close of 102
  assert.ok(Math.abs(out[2].st - (102 + 2 * 4 / 3)) < 1e-12);
});

// The same formula written the way the Pine source reads (na / nz, ta.rma, [1] history), as an independent oracle on a long, wandering series
function pineSupertrend(high, low, close, factor, len) {
  const n = close.length, nz = v => (v == null || Number.isNaN(v) ? 0 : v);
  const tr = close.map((c, i) => i === 0 ? high[0] - low[0] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  const atr = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i === len - 1) atr[i] = tr.slice(0, len).reduce((a, b) => a + b, 0) / len;          // ta.rma seeds with the sma
    else if (i >= len) atr[i] = (atr[i - 1] * (len - 1) + tr[i]) / len;
  }
  const upperB = Array(n).fill(null), lowerB = Array(n).fill(null), dirs = Array(n).fill(null), st = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const hl2 = (high[i] + low[i]) / 2;
    let up = hl2 + factor * atr[i], lo = hl2 - factor * atr[i];
    const pLo = nz(lowerB[i - 1]), pUp = nz(upperB[i - 1]);
    lo = (lo > pLo || close[i - 1] < pLo) ? lo : pLo;
    up = (up < pUp || close[i - 1] > pUp) ? up : pUp;
    lowerB[i] = lo; upperB[i] = up;
    if (atr[i - 1] == null || i === 0) dirs[i] = 1;
    else if (st[i - 1] === pUp) dirs[i] = close[i] > up ? -1 : 1;
    else dirs[i] = close[i] < lo ? 1 : -1;
    st[i] = dirs[i] === -1 ? lo : up;
  }
  return { st, dirs };
}

test('supertrendSeries equals an independent Pine-literal transcription on 600 pseudo-random bars, for several lengths and factors', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const closes = []; let p = 100;
  for (let i = 0; i < 600; i++) { p = Math.max(5, p * (1 + (rnd() - 0.48) * 0.06)); closes.push(p); }
  const days = closes.map((c, i) => { const h = c * (1 + rnd() * 0.02), l = c * (1 - rnd() * 0.02); return { date: 'D' + i, open: c, high: h, low: l, close: c, turnover: 1 }; });
  for (const [len, factor] of [[10, 3], [7, 2], [14, 1.5], [1, 3], [20, 4.5]]) {
    const mine = supertrendSeries(days, len, factor);
    const ref = pineSupertrend(days.map(d => d.high), days.map(d => d.low), days.map(d => d.close), factor, len);
    let flips = 0;
    for (let i = 0; i < days.length; i++) {
      if (ref.st[i] == null) { assert.equal(mine[i], null, `bar ${i} (${len}, ${factor})`); continue; }
      assert.ok(Math.abs(mine[i].st - ref.st[i]) < 1e-9, `Supertrend, bar ${i} (${len}, ${factor})`);
      assert.equal(mine[i].dir, ref.dirs[i] === -1 ? 'up' : 'down', `direction, bar ${i} (${len}, ${factor})`);
      if (i > 0 && mine[i - 1] && mine[i].dir !== mine[i - 1].dir) flips++;
    }
    assert.ok(flips >= 3, `the random walk flips the trend a few times (${len}, ${factor}): ${flips}`);
  }
});

test('in an uptrend the line is the lower band and only ever rises; in a downtrend it is the upper band and only ever falls', () => {
  const up = supertrendSeries(around([...falling(20, 100, 1), ...rising(60, 80, 1.5)]), 10, 3);
  let lastUp = null;
  for (let i = 1; i < up.length; i++) {
    if (!up[i]) continue;
    if (up[i].dir === 'up' && up[i - 1] && up[i - 1].dir === 'up') assert.ok(up[i].st >= up[i - 1].st, `uptrend line never falls (bar ${i})`);
    if (up[i].dir === 'down' && up[i - 1] && up[i - 1].dir === 'down') assert.ok(up[i].st <= up[i - 1].st, `downtrend line never rises (bar ${i})`);
    lastUp = up[i];
  }
  assert.equal(lastUp.dir, 'up');
});

test('a bigger factor keeps the line farther from the price and so flips later; a smaller ATR length reacts sooner', () => {
  const days = around([...rising(40, 100, 1), ...falling(30, 140, 2.5)]);
  const firstDown = (len, f) => supertrendSeries(days, len, f).findIndex((o, i) => i > 30 && o && o.dir === 'down');
  assert.ok(firstDown(10, 1) < firstDown(10, 3), 'factor 1 flips before factor 3');
  assert.ok(firstDown(10, 3) > 0, 'factor 3 does flip eventually');
});

// ─── computeSupertrend ─────────────────────────────────────────────────────────

test('computeSupertrend reads the latest bar: line, direction, close, distance in % and the strict above / below flags', () => {
  const m = computeSupertrend(HAND, 2, 1);
  assert.equal(m.valid, true);
  assert.equal(m.line, 13.453125);
  assert.equal(m.dir, 'down');
  assert.equal(m.close, 7.5);
  assert.ok(Math.abs(m.pct - (7.5 / 13.453125 - 1) * 100) < 1e-12 && m.pct < 0);
  assert.deepEqual([m.above, m.below], [false, true]);
  const up = computeSupertrend(HAND.slice(0, 7), 2, 1);        // the day before the crash: uptrend on the lower band
  assert.deepEqual([up.line, up.dir, up.above, up.below], [9.59375, 'up', true, false]);
});

test('flipAge counts the candles since the trend last flipped to its current direction: 0 = on the latest candle, NaN = it never has', () => {
  assert.equal(computeSupertrend(HAND, 2, 1).flipAge, 0);                  // flipped down on the last bar (bar 7)
  assert.equal(computeSupertrend(HAND.slice(0, 7), 2, 1).flipAge, 1);      // flipped up on bar 5, the latest is bar 6
  assert.equal(computeSupertrend(HAND.slice(0, 6), 2, 1).flipAge, 0);      // bar 5 itself: the flip up
  assert.ok(isNaN(computeSupertrend(HAND.slice(0, 5), 2, 1).flipAge));     // down since the first bar with an ATR - that start is not a flip
  assert.ok(isNaN(computeSupertrend(around(rising(5)), 10, 3).flipAge));   // not valid at all
});

test('the latest close equal to the line is neither above nor below it', () => {
  // a flat stock: ATR 0, both bands sit on the price, the line is the upper band (downtrend) and the close is exactly on it
  const m = computeSupertrend(Array.from({ length: 30 }, () => bar(100, 100, 100)), 10, 3);
  assert.equal(m.valid, true);
  assert.equal(m.line, 100);
  assert.deepEqual([m.above, m.below, m.pct], [false, false, 0]);
});

test('too little history is not valid: fewer than ATR length + 1 daily bars, an empty history, or a bad length / factor', () => {
  assert.equal(computeSupertrend(around(rising(10)), 10, 3).valid, false);                  // exactly 10 bars: the ATR only seeds
  assert.equal(computeSupertrend(around(rising(11)), 10, 3).valid, true);                   // 11 bars: the first real Supertrend
  assert.equal(computeSupertrend([], 10, 3).valid, false);
  assert.equal(computeSupertrend(null, 10, 3).valid, false);
  assert.equal(computeSupertrend(around(rising(50)), 0, 3).valid, false);
  assert.equal(computeSupertrend(around(rising(50)), 10, 0).valid, false);
  const bad = computeSupertrend(around(rising(5)), 10, 3);
  assert.ok(isNaN(bad.line) && isNaN(bad.pct) && !bad.above && !bad.below);
});

// ─── the Weekly timeframe ──────────────────────────────────────────────────────

// real trading dates (Mon-Fri from Monday 2024-01-01) on a list of bars; `skip` drops those trading-day numbers (holidays)
function dated(bars, skip = []) {
  const out = []; let day = 0, d = new Date(2024, 0, 1);
  for (const b of bars) {
    while (d.getDay() === 0 || d.getDay() === 6 || skip.includes(day)) { if (d.getDay() !== 0 && d.getDay() !== 6) day++; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); }
    out.push({ ...b, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); day++;
  }
  return out;
}

test('weekly candles: open = the first day\'s open, high / low = the extremes, close = the last day\'s close, dated on the first trading day; the last week is the week so far', () => {
  const days = dated([
    { open: 10, high: 12, low: 9, close: 11 }, { open: 11, high: 15, low: 10, close: 14 }, { open: 14, high: 14, low: 8, close: 9 }, { open: 9, high: 10, low: 7, close: 8 }, { open: 8, high: 9, low: 6, close: 7 },   // Mon 2024-01-01 .. Fri 2024-01-05
    { open: 7, high: 9, low: 6.5, close: 8 }, { open: 8, high: 11, low: 7.5, close: 10 },                                                                                                                                  // Mon 01-08, Tue 01-09: a week so far
  ]);
  const w = Array.from(weeklyBarsFromDaily(days), b => ({ ...b }));
  assert.deepEqual(w, [
    { date: '2024-01-01', open: 10, high: 15, low: 6, close: 7 },
    { date: '2024-01-08', open: 7, high: 11, low: 6.5, close: 10 },
  ]);
});

test('a holiday Monday leaves the week to start on Tuesday, and a week is never merged with the next one', () => {
  const days = dated(around(rising(12)), [0]);                    // trading day 0 (Mon 01-01) is a holiday: the first bar is Tue 01-02
  assert.equal(days[0].date, '2024-01-02');
  const w = weeklyBarsFromDaily(days);
  assert.deepEqual(Array.from(w, b => b.date), ['2024-01-02', '2024-01-08', '2024-01-15']);   // 4 days, 5 days, 3 days
  assert.equal(w[0].close, days[3].close);
  assert.equal(w[1].open, days[4].open);
});

test('computeSupertrend(..., "w") is the Supertrend of the weekly candles, and "d" (or nothing) is the daily one', () => {
  const days = dated(around([...falling(60, 200, 1), ...rising(100, 140, 0.8)]));
  const weekly = supertrendSeries(weeklyBarsFromDaily(days), 5, 2);
  const m = computeSupertrend(days, 5, 2, 'w');
  assert.equal(m.valid, true);
  assert.equal(m.line, weekly[weekly.length - 1].st);
  assert.equal(m.dir, weekly[weekly.length - 1].dir);
  const d = computeSupertrend(days, 5, 2, 'd');
  assert.equal(d.line, computeSupertrend(days, 5, 2).line);
  assert.equal(d.line, supertrendSeries(days, 5, 2)[days.length - 1].st);
  assert.notEqual(d.line, m.line);
});

test('the weekly Supertrend needs ATR length + 1 WEEKLY candles: 40 trading days (8 weeks) are enough for a daily length of 10, not a weekly one', () => {
  const days = dated(around(rising(40)));
  assert.equal(computeSupertrend(days, 10, 3, 'd').valid, true);
  assert.equal(computeSupertrend(days, 10, 3, 'w').valid, false);
  assert.equal(computeSupertrend(days, 7, 3, 'w').valid, true);        // 8 weekly candles = 7 + 1
  assert.equal(computeSupertrend(days, 8, 3, 'w').valid, false);
});

// a stock that fell for 30 weeks and then rallied for 8 days (+2 a day): the daily Supertrend has turned up long ago, the weekly one has not yet
const TURNING = dated(around([...falling(150, 300, 1), ...rising(8, 152, 2)]));

test('the same stock can be an uptrend on the Daily timeframe and still a downtrend on the Weekly one', () => {
  assert.equal(computeSupertrend(TURNING, 10, 3, 'd').dir, 'up');
  assert.equal(computeSupertrend(TURNING, 10, 3, 'w').dir, 'down');
});

// ─── through runScreener() ─────────────────────────────────────────────────────

function runWith(over, stocks, partial = false) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '',
  });
  dom.el('scrAllowPartial').checked = partial;
  for (const [id, v] of Object.entries(over)) {
    if (typeof v === 'boolean') dom.el(id).checked = v; else dom.el(id).value = String(v);
  }
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in stocks) {
    const days = stocks[k];
    latest[k] = { symbol: k, isin: k, turnover: 10, changePct: 0, industry: 'X', sector: 'Y', ...days[days.length - 1] };
    daily[k] = days;
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.runScreener();
  const passed = Array.from(vm.runInContext('screenerPassed', sb)), failed = Array.from(vm.runInContext('screenerFailed', sb));
  return { passed: passed.map(s => s.symbol).sort(), failed, byName: Object.fromEntries(passed.concat(failed).map(s => [s.symbol, s])) };
}

const F46 = (len, factor, pos = 'above', tf = 'd', flip = 0) => ({ scrF46On: true, scrF46Len: len, scrF46Factor: factor, scrF46Pos: pos, scrF46Tf: tf, scrF46Flip: flip });
const FIXTURE = {
  UP: around(rising(80)),                                                   // steady climb: uptrend
  DOWN: around(falling(80)),                                                // steady fall: downtrend
  CRASH: around([...rising(60), ...falling(20, 160, 6)]),                   // rallied, then broke down hard: flipped to a downtrend
  RECOVER: around([...falling(60, 200, 1), ...rising(20, 140, 6)]),         // fell, then rallied hard: flipped to an uptrend
  NEW: around(rising(8)),                                                   // 8 bars: no Supertrend(10)
};

test('the fixture stocks sit where the tests below assume', () => {
  const dir = k => computeSupertrend(FIXTURE[k], 10, 3).dir;
  assert.deepEqual(['UP', 'DOWN', 'CRASH', 'RECOVER'].map(dir), ['up', 'down', 'down', 'up']);
});

test('F46 "above" keeps the stocks trading above their Supertrend (uptrend) and fails the rest with the line in the reason', () => {
  const r = runWith(F46(10, 3, 'above'), FIXTURE);
  assert.deepEqual(r.passed, ['RECOVER', 'UP']);
  const reasons = Object.fromEntries(r.failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  assert.match(reasons.DOWN, /F46: Close \d+\.\d\d not above Supertrend\(10, 3\) \d+\.\d\d \(downtrend\)/);
  assert.match(reasons.CRASH, /F46: Close .* not above Supertrend\(10, 3\) .* \(downtrend\)/);
  assert.match(reasons.NEW, /F46: Insufficient data for Supertrend\(10, 3\)/);
});

test('F46 "below" keeps the stocks trading below their Supertrend (downtrend)', () => {
  const r = runWith(F46(10, 3, 'below'), FIXTURE);
  assert.deepEqual(r.passed, ['CRASH', 'DOWN']);
  assert.match(r.byName.UP._failReasons.join(' | '), /F46: Close \d+\.\d\d not below Supertrend\(10, 3\) \d+\.\d\d \(uptrend\)/);
  assert.match(r.byName.NEW._failReasons.join(' | '), /F46: Insufficient data for Supertrend\(10, 3\)/);   // too little history fails either way
});

test('the ATR length and the factor reach the maths: the reason names them and the stored line is that Supertrend', () => {
  const r = runWith(F46(7, 2.5, 'above'), FIXTURE);
  assert.match(r.byName.DOWN._failReasons.join(' | '), /Supertrend\(7, 2\.5\)/);
  const expected = computeSupertrend(FIXTURE.UP, 7, 2.5);
  assert.equal(r.byName.UP._f46Line, expected.line);
  assert.notEqual(expected.line, computeSupertrend(FIXTURE.UP, 10, 3).line);
});

test('a stock needs ATR length + 1 bars: 8 bars are judged with a length of 5 and rejected with a length of 10, and "Partial history" does not change that', () => {
  const NEWDOWN = { NEWDOWN: around(falling(8)) };
  assert.deepEqual(runWith(F46(5, 3, 'below'), NEWDOWN).passed, ['NEWDOWN']);
  const strict = runWith(F46(10, 3, 'below'), NEWDOWN);
  assert.deepEqual(strict.passed, []);
  assert.match(strict.byName.NEWDOWN._failReasons.join(' | '), /F46: Insufficient data for Supertrend\(10, 3\)/);
  assert.deepEqual(runWith(F46(10, 3, 'below'), NEWDOWN, true).passed, []);
});

test('F46 stores the line, the direction and the close-vs-line % on each stock for the result columns', () => {
  const r = runWith(F46(10, 3), FIXTURE);
  const m = computeSupertrend(FIXTURE.UP, 10, 3);
  assert.equal(r.byName.UP._f46Line, m.line);
  assert.equal(r.byName.UP._f46Dir, 'up');
  assert.equal(r.byName.UP._f46Pct, m.pct);
  assert.ok(r.byName.UP._f46Pct > 0 && r.byName.DOWN._f46Pct < 0);
  assert.equal(r.byName.DOWN._f46Dir, 'down');
  assert.ok(isNaN(r.byName.NEW._f46Line));
});

test('blank or invalid length / factor / position fall back to 10, 3 and "above"', () => {
  const r = runWith({ scrF46On: true, scrF46Len: '', scrF46Factor: 'abc', scrF46Pos: '' }, FIXTURE);
  assert.deepEqual(r.passed, ['RECOVER', 'UP']);
  assert.match(r.byName.DOWN._failReasons.join(' | '), /Supertrend\(10, 3\)/);
  assert.deepEqual(runWith({ scrF46On: true, scrF46Len: '10', scrF46Factor: '-2' }, FIXTURE).passed, ['RECOVER', 'UP']);   // a factor of 0 or less is not a factor
  assert.deepEqual(runWith({ scrF46On: true, scrF46Pos: 'sideways' }, FIXTURE).passed, ['RECOVER', 'UP']);
});

test('F46 on the Weekly timeframe judges the weekly candles: the reason says Weekly, the stored line is the weekly one, and short weekly history is rejected', () => {
  const stocks = { TURNING, FLAT: dated(around(Array(40).fill(100))), WUP: dated(around(rising(150))) };
  const daily = runWith(F46(10, 3, 'above', 'd'), stocks);
  assert.deepEqual(daily.passed, ['TURNING', 'WUP']);
  const weekly = runWith(F46(10, 3, 'above', 'w'), stocks);
  assert.deepEqual(weekly.passed, ['WUP']);                                         // TURNING is still a weekly downtrend
  assert.match(weekly.byName.TURNING._failReasons.join(' | '), /F46: Close \d+\.\d\d not above Weekly Supertrend\(10, 3\) \d+\.\d\d \(downtrend\)/);
  assert.match(weekly.byName.FLAT._failReasons.join(' | '), /F46: Insufficient data for Weekly Supertrend\(10, 3\)/);   // 8 weekly candles
  assert.equal(weekly.byName.TURNING._f46Line, computeSupertrend(TURNING, 10, 3, 'w').line);
  assert.equal(weekly.byName.WUP._f46Dir, 'up');
  assert.deepEqual(runWith(F46(10, 3, 'below', 'w'), stocks).passed, ['TURNING']);
  assert.deepEqual(runWith({ ...F46(10, 3, 'above'), scrF46Tf: 'monthly' }, stocks).passed, ['TURNING', 'WUP']);   // anything but "w" is Daily
});

// ─── "just flipped": the trend turned within the last N candles ────────────────

test('flipped within the last N candles keeps only the stocks that turned lately; N = 0 puts no limit on the age', () => {
  const ageUp = computeSupertrend(FIXTURE.RECOVER, 10, 3).flipAge, ageDown = computeSupertrend(FIXTURE.CRASH, 10, 3).flipAge;
  assert.ok(ageUp >= 1 && ageUp < 20 && ageDown >= 1 && ageDown < 20, `both turned inside their last 20 bars (${ageUp}, ${ageDown})`);
  assert.ok(computeSupertrend(FIXTURE.UP, 10, 3).flipAge > 20, 'UP turned up long ago (right after the first bars)');
  // above + N: RECOVER flipped up ageUp candles ago, so it is in from N = ageUp + 1 and out for N = ageUp
  assert.deepEqual(runWith(F46(10, 3, 'above', 'd', 0), FIXTURE).passed, ['RECOVER', 'UP']);
  assert.deepEqual(runWith(F46(10, 3, 'above', 'd', ageUp + 1), FIXTURE).passed, ['RECOVER']);
  assert.deepEqual(runWith(F46(10, 3, 'above', 'd', ageUp), FIXTURE).passed, []);
  // below + N: the same for the stock that broke down
  assert.deepEqual(runWith(F46(10, 3, 'below', 'd', ageDown + 1), FIXTURE).passed, ['CRASH']);
  assert.deepEqual(runWith(F46(10, 3, 'below', 'd', ageDown), FIXTURE).passed, []);
  assert.deepEqual(runWith(F46(10, 3, 'below', 'd', 0), FIXTURE).passed, ['CRASH', 'DOWN']);
});

test('the flip reason says how long ago the trend turned, or that it never has; the age is stored for the column', () => {
  const ageUp = computeSupertrend(FIXTURE.RECOVER, 10, 3).flipAge;
  const r = runWith(F46(10, 3, 'above', 'd', 1), FIXTURE);
  assert.deepEqual(r.passed, ageUp === 0 ? ['RECOVER'] : []);
  assert.match(r.byName.UP._failReasons.join(' | '), new RegExp(`F46: Supertrend\\(10, 3\\) flipped up ${computeSupertrend(FIXTURE.UP, 10, 3).flipAge} days ago, not within the last 1`));
  assert.equal(r.byName.UP._f46Age, computeSupertrend(FIXTURE.UP, 10, 3).flipAge);
  // a stock that has been down since the first bar with an ATR never flipped
  const never = runWith(F46(10, 3, 'below', 'd', 5), { DOWN: FIXTURE.DOWN });
  assert.deepEqual(never.passed, []);
  assert.match(never.byName.DOWN._failReasons.join(' | '), /F46: Supertrend\(10, 3\) has not flipped down in the history there is, not within the last 5/);
  assert.ok(isNaN(never.byName.DOWN._f46Age));
});

test('a flip on the very latest candle passes with N = 1; a flip one candle earlier needs N = 2 (singular "1 day ago" in the reason)', () => {
  const full = [...rising(30, 100, 1), ...falling(15, 129, 4)];            // a climb, then a sharp fall: the trend flips down on one particular bar
  const flipBar = supertrendSeries(around(full), 10, 3).findIndex((o, i, a) => o && a[i - 1] && a[i - 1].dir === 'up' && o.dir === 'down');
  assert.ok(flipBar > 30);
  const upTo = n => ({ S: around(full.slice(0, n)) });
  assert.deepEqual(runWith(F46(10, 3, 'below', 'd', 1), upTo(flipBar + 1)).passed, ['S']);           // the flip bar is the latest one
  const one = runWith(F46(10, 3, 'below', 'd', 1), upTo(flipBar + 2));                               // one bar later
  assert.deepEqual(one.passed, []);
  assert.match(one.byName.S._failReasons.join(' | '), /flipped down 1 day ago, not within the last 1/);
  assert.deepEqual(runWith(F46(10, 3, 'below', 'd', 2), upTo(flipBar + 2)).passed, ['S']);
});

test('on the Weekly timeframe the flip age counts weekly candles', () => {
  const days = dated(around([...falling(150, 300, 1), ...rising(60, 152, 3)]));                       // 30 weeks down, then 12 weeks up
  const m = computeSupertrend(days, 10, 3, 'w');
  assert.equal(m.dir, 'up');
  assert.ok(m.flipAge >= 1 && m.flipAge < 12, `flipped up within the 12 weekly candles of the rally (${m.flipAge})`);
  assert.deepEqual(runWith(F46(10, 3, 'above', 'w', m.flipAge + 1), { S: days }).passed, ['S']);
  const out = runWith(F46(10, 3, 'above', 'w', m.flipAge), { S: days });
  assert.deepEqual(out.passed, []);
  assert.match(out.byName.S._failReasons.join(' | '), new RegExp(`F46: Weekly Supertrend\\(10, 3\\) flipped up ${m.flipAge} weeks? ago`));
  assert.equal(out.byName.S._f46Age, m.flipAge);
  assert.ok(computeSupertrend(days, 10, 3, 'd').flipAge > m.flipAge * 3, 'the daily flip is older in candles than the weekly one');
});

test('blank, negative or invalid "flipped within" falls back to 0 (no limit)', () => {
  for (const flip of ['', 'abc', '-3']) assert.deepEqual(runWith(F46(10, 3, 'above', 'd', flip), FIXTURE).passed, ['RECOVER', 'UP'], `"${flip}"`);
});

test('F46 off: nothing is filtered and no F46 reason appears', () => {
  const off = runWith({}, FIXTURE);
  assert.deepEqual(off.passed, ['CRASH', 'DOWN', 'NEW', 'RECOVER', 'UP']);
  assert.ok(!off.failed.some(s => (s._failReasons || []).some(x => /F46/.test(x))));
  assert.ok(isNaN(off.byName.UP._f46Line) || off.byName.UP._f46Line === undefined);
});

test('F46 combines with another filter: both must pass', () => {
  // BIGUP and UP are both in an uptrend, but only BIGUP trades 100 lakh (F3 wants 0.5 Cr = 50 lakh); DOWN has the turnover but is in a downtrend
  const BIGUP = FIXTURE.UP.map(d => ({ ...d, turnover: 100 })), BIGDOWN = FIXTURE.DOWN.map(d => ({ ...d, turnover: 100 }));
  const stocks = { BIGUP, UP: FIXTURE.UP, BIGDOWN };
  assert.deepEqual(runWith(F46(10, 3), stocks).passed, ['BIGUP', 'UP']);
  const both = runWith({ ...F46(10, 3), scrF3On: true, scrF3Val: '0.5' }, stocks);
  assert.deepEqual(both.passed, ['BIGUP']);
  assert.ok(both.byName.UP._failReasons.some(x => /F3/.test(x)) && !both.byName.UP._failReasons.some(x => /F46/.test(x)), 'UP passes F46 and fails only F3');
  assert.ok(both.byName.BIGDOWN._failReasons.some(x => /F46/.test(x)) && !both.byName.BIGDOWN._failReasons.some(x => /F3/.test(x)), 'BIGDOWN passes F3 and fails only F46');
});

// ─── badge counts, presets, reset, markup ──────────────────────────────────────

test('F46 is counted as an active filter and in the Technicals tab badge', () => {
  assert.ok(/f42On, f45On, f46On\]\.filter\(Boolean\)/.test(screenerSrc), 'in the active-filter count');
  assert.ok(/'scrF42On','scrF45On','scrF46On'\]/.test(screenerSrc), 'in the Technicals badge list');
});

test('presets capture and restore F46 (on, length, factor, position); "— Select preset —" resets it', () => {
  const dom = installFakeDom(sb, {});
  const el = dom.el;
  el('scrF46On').checked = true; el('scrF46Len').value = '14'; el('scrF46Factor').value = '2.5'; el('scrF46Pos').value = 'below'; el('scrF46Tf').value = 'w'; el('scrF46Flip').value = '3';
  const state = capturePresetState();
  assert.deepEqual([state.scrF46On, state.scrF46Len, state.scrF46Factor, state.scrF46Pos, state.scrF46Tf, state.scrF46Flip], [true, '14', '2.5', 'below', 'w', '3']);
  el('scrF46On').checked = false; el('scrF46Len').value = '10'; el('scrF46Factor').value = '3'; el('scrF46Pos').value = 'above'; el('scrF46Tf').value = 'd'; el('scrF46Flip').value = '0';
  applyPresetState(state);
  assert.deepEqual([el('scrF46On').checked, el('scrF46Len').value, el('scrF46Factor').value, el('scrF46Pos').value, el('scrF46Tf').value, el('scrF46Flip').value], [true, '14', '2.5', 'below', 'w', '3']);
  applyPresetState(vm.runInContext('DEFAULT_FILTER_STATE', sb));
  assert.deepEqual([el('scrF46On').checked, el('scrF46Len').value, el('scrF46Factor').value, el('scrF46Pos').value, el('scrF46Tf').value, el('scrF46Flip').value], [false, '10', '3', 'above', 'd', '0']);
});

test('presets saved before F46 existed load fine and leave its controls alone', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF46On').checked = true; dom.el('scrF46Len').value = '9';
  applyPresetState({ scrF18On: true });
  assert.deepEqual([dom.el('scrF46On').checked, dom.el('scrF46Len').value], [true, '9']);
});

test('Reset puts F46 back to off, 10, 3, "above", Daily and no flip limit', () => {
  const dom = installFakeDom(sb, {});
  const el = dom.el;
  el('scrF46On').checked = true; el('scrF46Len').value = '5'; el('scrF46Factor').value = '1.2'; el('scrF46Pos').value = 'below'; el('scrF46Tf').value = 'w'; el('scrF46Flip').value = '4';
  sb.runScreener = () => {}; sb.updateFilterBadge = () => {};
  sb.resetScreener();
  assert.deepEqual([el('scrF46On').checked, el('scrF46Len').value, el('scrF46Factor').value, el('scrF46Pos').value, el('scrF46Tf').value, el('scrF46Flip').value], [false, '10', '3', 'above', 'd', '0']);
});

test('the As of Date tab keeps its own filter set: it has no Supertrend control and js/asof-scan.js does not touch scrF46', () => {
  const asof = fs.readFileSync(path.join(root, 'js', 'asof-scan.js'), 'utf8');
  assert.ok(!/scrF46|supertrend/i.test(asof));
  assert.ok(![...html.matchAll(/\bid="(asof[^"]*)"/g)].some(m => /supertrend/i.test(m[1])));
});

test('index.html: the F46 card sits in the Technicals tab below the F41 card, ATR length 10, factor 3, "above" by default', () => {
  const pane = html.slice(html.indexOf('id="scrPaneTechnicals"'));
  assert.ok(pane.indexOf('id="scrF41On"') < pane.indexOf('id="scrF46On"'), 'after the F41 card');
  assert.match(html, /id="scrF46Len" value="10"/);
  assert.match(html, /id="scrF46Factor" value="3"/);
  assert.match(html, /id="scrF46Flip" value="0" min="0"/);
  assert.match(html, /<select id="scrF46Tf"[^>]*>\s*<option value="d" selected>Daily<\/option>\s*<option value="w">Weekly<\/option>/);
  assert.match(html, /<select id="scrF46Pos"[^>]*>\s*<option value="above" selected>[^<]*<\/option>\s*<option value="below">/);
});

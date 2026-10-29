'use strict';
// The Stock Scanner (screener) "Consolidating" filter, F41: the biggest peak-to-trough decline (a high, then a lower low on a LATER bar)
// over the last N days must be between a min and a max % of the peak, with a spike tolerance (ignore the K most extreme highs / lows, to forgive a fake breakout or breakdown wick).
// Where the latest close sits (e.g. above the peak after a breakout) is the price-position choice's call alone. Covers the calculation (computeDynRange), the filter end to end through
// runScreener(), the Depth% / Spikes Ignored columns, and that it is saved in / restored from presets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
const { computeDynRange, scrDepthPosition, capturePresetState, applyPresetState } = sb;

// bars from [high, low, close] triples
const bars = (rows) => rows.map(([high, low, close], i) => ({ date: 'D' + i, high, low, close: close === undefined ? (high + low) / 2 : close, open: low, turnover: 10 }));
const calm = (n, high = 105, low = 100, close = 102) => Array.from({ length: n }, () => [high, low, close]);
const D5 = 5 / 105 * 100;   // the depth of a calm 105 / 100 box: a 5 point fall from a peak of 105
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ─── computeDynRange ────────────────────────────────────────────────────────────

test('depth is the fall from a high to a lower low on a later bar, as a % of that high', () => {
  const r = computeDynRange(bars(calm(30)), 30, 0, false);
  assert.equal(r.top, 105);
  assert.equal(r.bottom, 100);
  assert.ok(near(r.depthPct, D5));
  assert.equal(r.spikes, 0);
});

test('only the last N bars count: an old wide swing outside the window is ignored', () => {
  const days = bars([[200, 50, 100], ...calm(30)]);
  assert.ok(near(computeDynRange(days, 30, 0, false).depthPct, D5));
  assert.ok(near(computeDynRange(days, 31, 0, false).depthPct, 50), 'but a 31-day window reaches it: 200 down to the later 100 lows (the 50 is on the same bar)');
});

test('it uses intraday highs and lows, not closes', () => {
  const rows = calm(30);
  rows[10] = [112, 100, 102];
  assert.ok(near(computeDynRange(bars(rows), 30, 0, false).depthPct, 12 / 112 * 100));
});

test('the trough must come AFTER the peak: a low that precedes the high is not a decline', () => {
  const up = bars([...Array.from({ length: 15 }, () => [101, 100, 100]), ...Array.from({ length: 15 }, () => [110, 109, 110])]);
  assert.ok(near(computeDynRange(up, 30, 0, false).depthPct, 1 / 101 * 100), 'only the 1 point wiggle inside each leg counts, not the 10 point climb');
  const down = bars([...Array.from({ length: 15 }, () => [110, 109, 110]), ...Array.from({ length: 15 }, () => [101, 100, 100])]);
  assert.ok(near(computeDynRange(down, 30, 0, false).depthPct, 10 / 110 * 100), 'the same legs the other way round are a 10 point fall from 110');
});

test('a steady climb has no depth; a steady slide has the whole fall', () => {
  const climb = bars(Array.from({ length: 30 }, (_, i) => [101 + i, 100 + i, 100 + i]));
  assert.ok(near(computeDynRange(climb, 30, 0, false).depthPct, 0));
  const slide = bars(Array.from({ length: 30 }, (_, i) => [130 - i, 129 - i, 129 - i]));
  assert.ok(near(computeDynRange(slide, 30, 0, false).depthPct, (130 - 100) / 130 * 100));
});

test('the peak and trough on the same bar do not make a decline (their order inside the day is unknown)', () => {
  assert.ok(near(computeDynRange(bars([[110, 100, 105], ...calm(29, 101, 100, 100)]), 30, 0, false).depthPct, 10 / 110 * 100), 'the later 100 lows count against the 110 peak');
  assert.ok(near(computeDynRange(bars([...calm(29, 101, 100, 100), [110, 100, 105]]), 30, 0, false).depthPct, 1 / 101 * 100), 'but a wide bar on the last day has nothing after it');
});

test('strict mode needs a full window of history; partial mode needs 5 bars and uses what exists', () => {
  assert.equal(computeDynRange(bars(calm(29)), 30, 0, false).insufficient, true);
  assert.equal(computeDynRange(bars(calm(30)), 30, 0, false).insufficient, undefined);
  assert.equal(computeDynRange(bars(calm(4)), 30, 0, true).insufficient, true);
  const p = computeDynRange(bars(calm(5)), 30, 0, true);
  assert.ok(near(p.depthPct, D5));
});

test('a bar with a non-positive low cannot give a depth', () => {
  assert.equal(computeDynRange(bars([...calm(29), [105, 0, 102]]), 30, 0, false).insufficient, true);
});

// ─── the peak and trough of the deepest decline, and where the price sits against them ─────────────────

const rep = (n, row) => Array.from({ length: n }, () => row);
// a peak of 100, a trough of 80 after it (a 20% decline), then ten bars closing at `close`
const legs = (close) => bars([...rep(10, [100, 95, 98]), ...rep(10, [90, 80, 85]), ...rep(10, [close + 1, close - 1, close])]);

test('the decline reports its own peak and trough prices; NaN when nothing fell', () => {
  const r = computeDynRange(legs(90), 30, 0, false);
  assert.equal(r.peak, 100);
  assert.equal(r.trough, 80);
  assert.ok(near(r.depthPct, 20));
  const climb = computeDynRange(bars(Array.from({ length: 30 }, (_, i) => [101 + i, 100 + i, 100 + i])), 30, 0, false);
  assert.ok(isNaN(climb.peak) && isNaN(climb.trough));
});

test('the reported peak is the one the deepest fall started from, not the highest high', () => {
  const rows = [...rep(10, [100, 95, 98]), ...rep(10, [90, 80, 85]), ...rep(10, [130, 120, 125])];   // runs to 130 after the trough
  const r = computeDynRange(bars(rows), 30, 0, false);
  assert.equal(r.peak, 100);
  assert.equal(r.trough, 80);
});

test('price above the peak: 5% above a 100 peak with an 80 trough', () => {
  const p = scrDepthPosition(105, 100, 80);
  assert.equal(p.zone, 'above');
  assert.ok(near(p.edgePct, 5));
  assert.ok(near(p.posPct, 125), 'a quarter of the range beyond the peak');
});

test('price within the range: its place counts up from the trough', () => {
  const p = scrDepthPosition(90, 100, 80);
  assert.equal(p.zone, 'within');
  assert.ok(near(p.posPct, 50));
  assert.equal(p.edgePct, 0);
  assert.ok(near(scrDepthPosition(80, 100, 80).posPct, 0) && near(scrDepthPosition(100, 100, 80).posPct, 100));
});

test('price below the trough is still reported by the maths, and no decline gives no position', () => {
  const p = scrDepthPosition(76, 100, 80);
  assert.equal(p.zone, 'below');
  assert.ok(near(p.edgePct, -5));
  assert.equal(scrDepthPosition(90, NaN, NaN), null);
});

test('the latest close can never sit below the trough: a lower low would simply be a deeper decline', () => {
  const r = computeDynRange(legs(70), 30, 0, false);   // the last bars fall to 69
  assert.equal(r.trough, 69);
  assert.ok(near(r.depthPct, 31));
});

// ─── fake breakouts / breakdowns ────────────────────────────────────────────────

test('a one-day fake breakout wick inflates a strict depth, and K = 1 forgives it', () => {
  const rows = calm(30);
  rows[12] = [120, 100, 102];   // wick to 120, closed back inside
  const days = bars(rows);
  const strict = computeDynRange(days, 30, 0, false);
  assert.ok(near(strict.depthPct, 20 / 120 * 100), 'a fall from the 120 wick back to 100');
  const tolerant = computeDynRange(days, 30, 1, false);
  assert.ok(near(tolerant.depthPct, D5));
  assert.equal(tolerant.top, 105);
  assert.equal(tolerant.spikes, 1, 'one bar was set aside');
});

test('a one-day fake breakdown wick is forgiven the same way', () => {
  const rows = calm(30);
  rows[12] = [105, 90, 102];
  assert.ok(near(computeDynRange(bars(rows), 30, 0, false).depthPct, 15 / 105 * 100), 'strict: 105 down to the 90 wick');
  const tolerant = computeDynRange(bars(rows), 30, 1, false);
  assert.ok(near(tolerant.depthPct, D5));
  assert.equal(tolerant.bottom, 100);
  assert.equal(tolerant.spikes, 1);
});

test('two spikes need K = 2', () => {
  const rows = calm(30);
  rows[5] = [120, 100, 102];
  rows[20] = [118, 100, 102];
  const days = bars(rows);
  assert.ok(near(computeDynRange(days, 30, 1, false).depthPct, 18 / 118 * 100), 'K = 1 still sees the 118 (the 120 is capped to it)');
  assert.ok(near(computeDynRange(days, 30, 2, false).depthPct, D5));
});

test('a wick TODAY that closes back inside the box is a fake-out: the depth is the calm box with K = 1', () => {
  const rows = calm(29);
  rows.push([120, 100, 103]);   // today: spiked to 120, closed 103
  const r = computeDynRange(bars(rows), 30, 1, false);
  assert.ok(near(r.depthPct, D5));
});

test('a real breakout TODAY (closes above the box) leaves the box top and the depth alone', () => {
  const rows = calm(29);
  rows.push([120, 104, 118]);
  const r = computeDynRange(bars(rows), 30, 1, false);
  assert.equal(r.top, 105);
  assert.ok(near(r.depthPct, D5), 'the climb itself is no decline');
});

test('a real breakdown TODAY (closes below the box) leaves the box bottom alone', () => {
  const rows = calm(29);
  rows.push([101, 85, 88]);
  const r = computeDynRange(bars(rows), 30, 1, false);
  assert.equal(r.bottom, 100);
});

test('K is clamped so the box never inverts, even on a short window', () => {
  const r = computeDynRange(bars(calm(5)), 30, 50, true);
  assert.ok(r.top >= r.bottom);
  assert.ok(r.depthPct >= 0);
});

// ─── the filter through runScreener() ───────────────────────────────────────────

// `f41` = { len, max, min, spikes } to switch the filter on; `partial` = "allow partial history"
function runWith(f41, stocksByKey, partial = false) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '',
  });
  dom.el('scrAllowPartial').checked = partial;
  if (f41) {
    dom.el('scrF41On').checked = true;
    dom.el('scrF41Len').value = String(f41.len);
    dom.el('scrF41Max').value = String(f41.max);
    dom.el('scrF41Min').value = String(f41.min || 0);
    dom.el('scrF41Pos').value = f41.pos || '';
    dom.el('scrF41Spikes').value = String(f41.spikes || 0);
  }
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in stocksByKey) {
    const days = stocksByKey[k];
    const last = days[days.length - 1];
    latest[k] = { symbol: k, isin: k, turnover: 10, changePct: 0, industry: 'X', sector: 'Y', ...last };
    daily[k] = days;
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.runScreener();
  return {
    passed: Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort(),
    failed: Array.from(vm.runInContext('screenerFailed', sb)),
    all: Array.from(vm.runInContext('screenerPassed', sb)).concat(Array.from(vm.runInContext('screenerFailed', sb))),
  };
}

const wickRows = (at) => { const r = calm(30); r[at] = [120, 100, 102]; return r; };
const FIXTURE = {
  TIGHT: bars(calm(30)),                                            // 4.8% deep box
  WIDE: bars(calm(30, 130, 100, 115)),                              // 23% deep box
  WICKED: bars(wickRows(12)),                                       // 4.8% deep box with one fake-out wick (16.7% deep if the wick counts)
  TODAY_UP: bars([...calm(29), [120, 104, 118]]),                   // real breakout today
  TODAY_WICK: bars([...calm(29), [120, 100, 103]]),                 // wick today, closed back inside
};

test('F41 via runScreener, strict: only boxes within the max pass, a wick counts against a stock', () => {
  const r = runWith({ len: 30, max: 10, spikes: 0 }, FIXTURE);
  // TODAY_UP / TODAY_WICK: their wide bar is the last one, so nothing falls after it and K = 0 sees only the 4.8% inside the box
  assert.deepEqual(r.passed, ['TIGHT', 'TODAY_UP', 'TODAY_WICK']);
  const reasons = Object.fromEntries(r.failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  assert.match(reasons.WIDE, /F41: 30-day depth 23\.08% > 10%/);
  assert.match(reasons.WICKED, /F41: 30-day depth 16\.67% > 10%/);
});

test('F41 via runScreener, K = 1, price anywhere: fake-out wicks and a real breakout today all pass', () => {
  const r = runWith({ len: 30, max: 10, spikes: 1 }, FIXTURE);
  assert.deepEqual(r.passed, ['TIGHT', 'TODAY_UP', 'TODAY_WICK', 'WICKED']);
  const reasons = Object.fromEntries(r.failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  assert.match(reasons.WIDE, /F41: 30-day depth/);
});

test('F41 via runScreener, K = 1: choosing "within" is what drops a real breakout today', () => {
  const r = runWith({ len: 30, max: 10, spikes: 1, pos: 'within' }, FIXTURE);
  assert.ok(!r.passed.includes('TODAY_UP'));
  assert.ok(r.passed.includes('TODAY_WICK'));
  const reasons = Object.fromEntries(r.failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  assert.match(reasons.TODAY_UP, /F41: Price 118\.00 is above the peak \(100\.00-105\.00\), not within the peak-to-trough range/);
});

test('F41 via runScreener: a min depth drops stocks that are too flat, with the fail reason; 0 means no minimum', () => {
  const r = runWith({ len: 30, min: 10, max: 30, spikes: 0 }, FIXTURE);
  assert.deepEqual(r.passed, ['WICKED', 'WIDE']);   // 16.7% and 23.1% deep; the 4.8% boxes are too flat
  const reasons = Object.fromEntries(r.failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  assert.match(reasons.TIGHT, /F41: 30-day depth 4.76% < 10%/);
  assert.equal(runWith({ len: 30, min: 0, max: 30, spikes: 0 }, FIXTURE).passed.length, 5);
});

test('F41 via runScreener: a depth exactly on the min or the max passes', () => {
  assert.deepEqual(runWith({ len: 30, min: 5 / 105 * 100, max: 5 / 105 * 100 }, { TIGHT: FIXTURE.TIGHT }).passed, ['TIGHT']);
});

const POS_FIXTURE = { ABOVE: legs(105), UPPER: legs(95), MIDDLE: legs(90), LOWER: legs(85), FLAT: bars(calm(30)) };
const posRun = (pos) => runWith({ len: 30, max: 30, spikes: 0, pos }, POS_FIXTURE);

test('F41 price position via runScreener: each choice keeps only the stocks in that place', () => {
  assert.deepEqual(posRun('').passed, ['ABOVE', 'FLAT', 'LOWER', 'MIDDLE', 'UPPER']);
  assert.deepEqual(posRun('above').passed, ['ABOVE']);
  assert.deepEqual(posRun('within').passed, ['FLAT', 'LOWER', 'MIDDLE', 'UPPER']);
  assert.deepEqual(posRun('upper').passed, ['UPPER']);
  assert.deepEqual(posRun('middle').passed, ['FLAT', 'MIDDLE']);   // FLAT: a 105 / 100 box closing at 102 is 40% up
  assert.deepEqual(posRun('lower').passed, ['LOWER']);
});

test('F41 price position via runScreener: the values are stored and the fail reasons say where the price is', () => {
  const r = posRun('above');
  const by = Object.fromEntries(r.all.map(s => [s.symbol, s]));
  assert.equal(by.ABOVE._depthPeak, 100);
  assert.equal(by.ABOVE._depthTrough, 80);
  assert.equal(by.ABOVE._posZone, 'above');
  assert.ok(near(by.ABOVE._posEdge, 5));
  assert.equal(by.MIDDLE._posZone, 'within');
  assert.ok(near(by.MIDDLE._posPct, 50));
  assert.match(by.MIDDLE._failReasons.join(' | '), /F41: Price 90\.00 is within the range \(80\.00-100\.00\), not above the peak/);
});

test('F41 price position via runScreener: a stock that never fell cannot be placed, so it fails any position choice', () => {
  const climb = { CLIMB: bars(Array.from({ length: 30 }, (_, i) => [101 + i, 100 + i, 100 + i])) };
  assert.deepEqual(runWith({ len: 30, max: 30, pos: '' }, climb).passed, ['CLIMB']);
  const r = runWith({ len: 30, max: 30, pos: 'within' }, climb);
  assert.deepEqual(r.passed, []);
  assert.match(r.failed[0]._failReasons.join(' '), /F41: No peak-to-trough decline to place the price against/);
});

test('F41 via runScreener: the Depth% and Spikes Ignored values are stored on each stock', () => {
  const r = runWith({ len: 30, max: 10, spikes: 1 }, FIXTURE);
  const by = Object.fromEntries(r.all.map(s => [s.symbol, s]));
  assert.ok(near(by.TIGHT._depthPct, D5));
  assert.equal(by.TIGHT._rangeSpikes, 0);
  assert.ok(near(by.WICKED._depthPct, D5));
  assert.equal(by.WICKED._rangeSpikes, 1);
});

test('F41 via runScreener: a stock without enough history fails (strict) unless partial history is allowed', () => {
  const short = { SHORT: bars(calm(12)) };
  const strict = runWith({ len: 30, max: 10 }, short, false);
  assert.deepEqual(strict.passed, []);
  assert.match(strict.failed[0]._failReasons.join(' '), /F41: Insufficient data for a 30-day depth/);
  assert.deepEqual(runWith({ len: 30, max: 10 }, short, true).passed, ['SHORT']);
});

test('F41 off: the filter does nothing', () => {
  const r = runWith(null, FIXTURE);
  assert.equal(r.passed.length, Object.keys(FIXTURE).length);
  assert.ok(r.all.every(s => isNaN(s._depthPct)));
});

// ─── presets ────────────────────────────────────────────────────────────────────

test('presets: F41 on/off, days, min %, max %, spikes and price position are captured and restored; "— Select preset —" resets them', () => {
  const dom = installFakeDom(sb, {});
  const el = dom.el;
  el('scrF41On').checked = true; el('scrF41Len').value = '45'; el('scrF41Min').value = '3'; el('scrF41Max').value = '8'; el('scrF41Spikes').value = '2'; el('scrF41Pos').value = 'above';
  const state = capturePresetState();
  assert.deepEqual([state.scrF41On, state.scrF41Len, state.scrF41Min, state.scrF41Max, state.scrF41Spikes, state.scrF41Pos], [true, '45', '3', '8', '2', 'above']);
  el('scrF41On').checked = false; el('scrF41Len').value = '30'; el('scrF41Min').value = '0'; el('scrF41Max').value = '10'; el('scrF41Spikes').value = '0'; el('scrF41Pos').value = '';
  applyPresetState(state);
  assert.deepEqual([el('scrF41On').checked, el('scrF41Len').value, el('scrF41Min').value, el('scrF41Max').value, el('scrF41Spikes').value, el('scrF41Pos').value], [true, '45', '3', '8', '2', 'above']);
  applyPresetState(vm.runInContext('DEFAULT_FILTER_STATE', sb));
  assert.deepEqual([el('scrF41On').checked, el('scrF41Len').value, el('scrF41Min').value, el('scrF41Max').value, el('scrF41Spikes').value, el('scrF41Pos').value], [false, '30', '0', '10', '0', '']);
});

test('presets saved before F41 existed load fine and leave the F41 controls alone', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF41On').checked = true; dom.el('scrF41Len').value = '45';
  applyPresetState({ scrF18On: true });
  assert.equal(dom.el('scrF41On').checked, true);
  assert.equal(dom.el('scrF41Len').value, '45');
});

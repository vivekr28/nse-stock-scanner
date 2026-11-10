'use strict';
// The Stock Scanner's Technicals filter F42 "Fast MA > Slow MA" (keep a stock when today's fast moving average of the close is strictly
// above the slow one, both SMA or both EMA) and the 65 SMA tick on the "Price Above" filter (F10). Covers the calculation
// (computeMaCross), the filter end to end through runScreener() (pass / fail / not enough history / allow-partial, the failure wording and the
// Fast / Slow / gap values stored for the columns), the 65 SMA tick, presets (captured, restored, reset to defaults), the Reset button and the markup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const html = fs.readFileSync(path.join(path.dirname(__dirname), 'index.html'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
const { computeMaCross, computeDynSMA, computeDynEMA, capturePresetState, applyPresetState } = sb;

// daily bars from a list of closes
const series = closes => closes.map((c, i) => ({ date: 'D' + i, open: c, high: c, low: c, close: c, turnover: 10 }));
const rising = (n, start = 100, step = 1) => Array.from({ length: n }, (_, i) => start + i * step);
const falling = (n, start = 200, step = 1) => Array.from({ length: n }, (_, i) => start - i * step);

// ─── computeMaCross ─────────────────────────────────────────────────────────────

test('a rising stock has its fast SMA above its slow SMA, a falling one below', () => {
  const up = computeMaCross(series(rising(80)), 'sma', 20, 50, false);
  assert.equal(up.valid, true);
  assert.equal(up.ok, true);
  assert.ok(up.fast > up.slow);
  assert.equal(up.fast, computeDynSMA(series(rising(80)), 'close', 20));
  assert.equal(up.slow, computeDynSMA(series(rising(80)), 'close', 50));
  const down = computeMaCross(series(falling(80)), 'sma', 20, 50, false);
  assert.equal(down.valid, true);
  assert.equal(down.ok, false);
  assert.ok(down.fast < down.slow);
});

test('the comparison is strict: equal averages (a flat stock, or the same length twice) do not pass', () => {
  const flat = computeMaCross(series(Array(80).fill(100)), 'sma', 20, 50, false);
  assert.equal(flat.valid, true);
  assert.equal(flat.ok, false);
  assert.equal(flat.gapPct, 0);
  assert.equal(computeMaCross(series(rising(80)), 'sma', 20, 20, false).ok, false);
});

test('the gap is how far the fast average sits above (+) or below (-) the slow one, in %', () => {
  const m = computeMaCross(series(rising(80)), 'sma', 20, 50, false);
  assert.ok(Math.abs(m.gapPct - (m.fast / m.slow - 1) * 100) < 1e-12);
  assert.ok(m.gapPct > 0);
  assert.ok(computeMaCross(series(falling(80)), 'sma', 20, 50, false).gapPct < 0);
});

test('the type switches both averages between SMA and EMA', () => {
  const days = series([...rising(40, 100, 0.5), ...falling(40, 130, 1.5)]);
  const e = computeMaCross(days, 'ema', 10, 30, false);
  assert.equal(e.fast, computeDynEMA(days, 'close', 10));
  assert.equal(e.slow, computeDynEMA(days, 'close', 30));
  const s = computeMaCross(days, 'sma', 10, 30, false);
  assert.equal(s.fast, computeDynSMA(days, 'close', 10));
  assert.equal(s.slow, computeDynSMA(days, 'close', 30));
  assert.notEqual(e.fast, s.fast);
  assert.equal(computeMaCross(days, 'anything else', 10, 30, false).fast, s.fast);   // unknown type = SMA
});

test('too little history for the slow average is "not valid" and never passes; allow-partial uses the bars there are (at least 5)', () => {
  const short = series(rising(30));
  const strict = computeMaCross(short, 'sma', 20, 50, false);
  assert.equal(strict.valid, false);
  assert.equal(strict.ok, false);
  assert.ok(isNaN(strict.slow) && isNaN(strict.gapPct));
  const partial = computeMaCross(short, 'sma', 20, 50, true);
  assert.equal(partial.valid, true);                    // the slow one becomes the average of the 30 bars there are
  assert.equal(partial.ok, true);                       // a rising stock: the last 20 sit above the last 30
  assert.equal(computeMaCross(series(rising(4)), 'sma', 2, 3, true).valid, false);   // under 5 bars: nothing meaningful
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

const F42 = (fast, slow, type = 'sma') => ({ scrF42On: true, scrF42Fast: fast, scrF42Slow: slow, scrF42Type: type });
const FIXTURE = { UP: series(rising(80)), DOWN: series(falling(80)), FLAT: series(Array(80).fill(100)), NEW: series(rising(30)) };

test('F42 keeps only the stocks whose fast MA is above their slow MA', () => {
  const r = runWith(F42(20, 50), FIXTURE);
  assert.deepEqual(r.passed, ['UP']);
  const reasons = Object.fromEntries(r.failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  assert.match(reasons.DOWN, /F42: 20 SMA \d+\.\d\d not above 50 SMA \d+\.\d\d/);
  assert.match(reasons.FLAT, /F42: 20 SMA 100\.00 not above 50 SMA 100\.00/);        // equal is not "greater"
  assert.match(reasons.NEW, /F42: Insufficient data for 20 \/ 50 SMA/);              // 30 bars: no 50 SMA
});

test('F42 with EMA says EMA in the failure reason and uses EMA values', () => {
  const r = runWith(F42(20, 50, 'ema'), FIXTURE);
  assert.deepEqual(r.passed, ['UP']);
  assert.match(r.byName.DOWN._failReasons.join(' | '), /F42: 20 EMA .* not above 50 EMA/);
  assert.equal(r.byName.UP._f42Fast, computeDynEMA(FIXTURE.UP, 'close', 20));
  assert.equal(r.byName.UP._f42Slow, computeDynEMA(FIXTURE.UP, 'close', 50));
});

test('F42 stores Fast / Slow / gap % on each stock for the result columns', () => {
  const r = runWith(F42(20, 50), FIXTURE);
  const up = r.byName.UP;
  assert.equal(up._f42Fast, computeDynSMA(FIXTURE.UP, 'close', 20));
  assert.equal(up._f42Slow, computeDynSMA(FIXTURE.UP, 'close', 50));
  assert.ok(Math.abs(up._f42Gap - (up._f42Fast / up._f42Slow - 1) * 100) < 1e-12 && up._f42Gap > 0);
  assert.ok(r.byName.DOWN._f42Gap < 0);
  assert.ok(isNaN(r.byName.NEW._f42Slow));
});

test('F42 with "allow partial history" lets a short-history stock be judged on the bars it has', () => {
  assert.deepEqual(runWith(F42(20, 50), FIXTURE, true).passed, ['NEW', 'UP']);
});

test('F42 with the lengths the other way round (a 50 MA above a 20 MA) keeps the falling stock', () => {
  assert.deepEqual(runWith(F42(50, 20), FIXTURE).passed, ['DOWN']);
});

test('blank or invalid lengths fall back to 20 and 50', () => {
  assert.deepEqual(runWith({ scrF42On: true, scrF42Fast: '', scrF42Slow: 'abc' }, FIXTURE).passed, ['UP']);
});

test('F42 off: nothing is filtered and no F42 reason appears; it counts as an active filter when on', () => {
  const off = runWith({}, FIXTURE);
  assert.deepEqual(off.passed, ['DOWN', 'FLAT', 'NEW', 'UP']);
  assert.ok(!off.failed.some(s => (s._failReasons || []).some(x => /F42/.test(x))));
  const src = fs.readFileSync(path.join(path.dirname(__dirname), 'js', 'screener.js'), 'utf8');
  assert.ok(/f41On, f42On\]\.filter\(Boolean\)/.test(src), 'F42 is in the active-filter count');
  assert.ok(/'scrF19On','scrF42On'\]/.test(src), 'F42 is in the Technicals badge count');
});

test('F42 combines with another filter: both must pass', () => {
  // UPDIP is in an uptrend (20 MA above 50 MA) but today's close fell below its 20 SMA, so F10 drops it while F42 alone keeps it
  const stocks = { UP: FIXTURE.UP, UPDIP: series([...rising(79), 100]), DOWN: FIXTURE.DOWN };
  assert.deepEqual(runWith(F42(20, 50), stocks).passed, ['UP', 'UPDIP']);
  const both = runWith({ ...F42(20, 50), scrF10On: true, scrF10_20sma: true }, stocks);
  assert.deepEqual(both.passed, ['UP']);
  assert.match(both.byName.UPDIP._failReasons.join(' | '), /F10: Close not above 20SMA/);
  assert.ok(!both.byName.UPDIP._failReasons.some(x => /F42/.test(x)), 'UPDIP passes F42 and fails only F10');
});

// ─── the 65 SMA tick on Price Above (F10) ──────────────────────────────────────

const F10_65 = { scrF10On: true, scrF10_20sma: true, scrF10_65sma: true };
const ABOVE = series(rising(80));                                                              // above its 20 and its 65 SMA
const BELOW65 = series([...Array(60).fill(200), ...Array(19).fill(100), 120]);                 // above its 20 SMA (101), below its 65 SMA (~169.5)

test('Price Above 20 SMA alone passes a stock that is below its 65 SMA; ticking 65 SMA drops it', () => {
  const only20 = runWith({ scrF10On: true, scrF10_20sma: true }, { ABOVE, BELOW65 });
  assert.deepEqual(only20.passed, ['ABOVE', 'BELOW65']);
  const both = runWith(F10_65, { ABOVE, BELOW65 });
  assert.deepEqual(both.passed, ['ABOVE']);
  assert.match(both.byName.BELOW65._failReasons.join(' | '), /F10: Close not above 65SMA\(169\.\d\d\)/);
});

test('the 65 SMA is a plain SMA over 65 closes and shows in the MA Status list between 50 and 200', () => {
  const r = runWith({ scrF10On: true, scrF10_20sma: true, scrF10_50sma: true, scrF10_65sma: true, scrF10_200sma: true }, { ABOVE });
  const names = Array.from(r.byName.ABOVE._f10MAs, m => m.name);
  assert.deepEqual(names, ['20SMA', '50SMA', '65SMA', '200SMA']);
  const m65 = r.byName.ABOVE._f10MAs.find(m => m.name === '65SMA');
  assert.equal(m65.val, computeDynSMA(ABOVE, 'close', 65));
  assert.equal(m65.ok, true);
});

test('the 65 SMA needs 65 bars: a shorter history fails it as N/A, or is judged on its bars with allow-partial', () => {
  const NEW = series(rising(40));
  const strict = runWith(F10_65, { NEW });
  assert.deepEqual(strict.passed, []);
  assert.match(strict.byName.NEW._failReasons.join(' | '), /65SMA\(N\/A\)/);
  assert.deepEqual(runWith(F10_65, { NEW }, true).passed, ['NEW']);
});

// ─── presets, reset, markup ────────────────────────────────────────────────────

test('presets capture and restore F42 (on, type, fast, slow) and the 65 SMA tick; "— Select preset —" resets them', () => {
  const dom = installFakeDom(sb, {});
  const el = dom.el;
  el('scrF42On').checked = true; el('scrF42Type').value = 'ema'; el('scrF42Fast').value = '10'; el('scrF42Slow').value = '30';
  el('scrF10On').checked = true; el('scrF10_65sma').checked = true;
  const state = capturePresetState();
  assert.deepEqual([state.scrF42On, state.scrF42Type, state.scrF42Fast, state.scrF42Slow, state.scrF10_65sma], [true, 'ema', '10', '30', true]);
  el('scrF42On').checked = false; el('scrF42Type').value = 'sma'; el('scrF42Fast').value = '20'; el('scrF42Slow').value = '50'; el('scrF10_65sma').checked = false;
  applyPresetState(state);
  assert.deepEqual([el('scrF42On').checked, el('scrF42Type').value, el('scrF42Fast').value, el('scrF42Slow').value, el('scrF10_65sma').checked], [true, 'ema', '10', '30', true]);
  applyPresetState(vm.runInContext('DEFAULT_FILTER_STATE', sb));
  assert.deepEqual([el('scrF42On').checked, el('scrF42Type').value, el('scrF42Fast').value, el('scrF42Slow').value, el('scrF10_65sma').checked], [false, 'sma', '20', '50', false]);
});

test('presets saved before F42 and the 65 SMA tick existed load fine and leave those controls alone', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF42On').checked = true; dom.el('scrF42Fast').value = '9'; dom.el('scrF10_65sma').checked = true;
  applyPresetState({ scrF18On: true });
  assert.deepEqual([dom.el('scrF42On').checked, dom.el('scrF42Fast').value, dom.el('scrF10_65sma').checked], [true, '9', true]);
});

test('Reset puts F42 and the 65 SMA tick back to their defaults', () => {
  const dom = installFakeDom(sb, {});
  const el = dom.el;
  el('scrF42On').checked = true; el('scrF42Type').value = 'ema'; el('scrF42Fast').value = '5'; el('scrF42Slow').value = '9'; el('scrF10_65sma').checked = true;
  sb.runScreener = () => {}; sb.updateFilterBadge = () => {};
  sb.resetScreener();
  assert.deepEqual([el('scrF42On').checked, el('scrF42Type').value, el('scrF42Fast').value, el('scrF42Slow').value, el('scrF10_65sma').checked], [false, 'sma', '20', '50', false]);
});

test('index.html: the F42 row sits in the Technicals left column under Close/SMA, with SMA / EMA, fast 20 and slow 50 by default; 65 SMA is between 50 and 200', () => {
  const left = html.slice(html.indexOf('id="scrPaneTechnicals"'));
  assert.ok(left.indexOf('id="scrF8On"') < left.indexOf('id="scrF42On"') && left.indexOf('id="scrF42On"') < left.indexOf('id="scrF1On"'), 'under Close/SMA (F8), before the right column starts (F1)');
  assert.match(html, /<select id="scrF42Type"[^>]*>\s*<option value="sma" selected>SMA<\/option>\s*<option value="ema">EMA<\/option>/);
  assert.match(html, /id="scrF42Fast" value="20"/);
  assert.match(html, /id="scrF42Slow" value="50"/);
  const f10 = html.slice(html.indexOf('id="scrF10On"'), html.indexOf('id="scrF2On"'));
  const order = ['scrF10_20sma', 'scrF10_50sma', 'scrF10_65sma', 'scrF10_200sma', 'scrF10_200ema'].map(id => f10.indexOf(`id="${id}"`));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'ticks in order 20, 50, 65, 200 SMA, 200 EMA');
  assert.match(f10, /id="scrF10_65sma"> 65 SMA</);
});

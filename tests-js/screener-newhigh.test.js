'use strict';
// The Stock Scanner (screener) "Making New High" filter, F18: tick any of 1M / 3M / 52W and every ticked window must be a new
// high today. Covers the calculation (computeDynNewHigh), that its windows are the same as the Market Breadth tab's new-highs
// indicator, the filter end to end through runScreener(), the "New High In" column, and that it is saved in / restored from presets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
const { computeDynNewHigh, capturePresetState, applyPresetState } = sb;
const SCR_NEW_HIGH_DAYS = vm.runInContext('SCR_NEW_HIGH_DAYS', sb);

const bars = (highs) => highs.map((h, i) => ({ date: 'D' + i, high: h, close: h, open: h, low: h, turnover: 10 }));
const flat = (n, v = 100) => Array.from({ length: n }, () => v);
const rising = (n, start = 100) => Array.from({ length: n }, (_, i) => start + i);

// ─── computeDynNewHigh ──────────────────────────────────────────────────────────

test('a new high: today\'s high is strictly above every earlier high in the window', () => {
  const r = computeDynNewHigh(bars([...flat(20, 100), 101]), 21, false);
  assert.equal(r.ok, true);
  assert.equal(r.high, 101);
  assert.equal(r.priorHigh, 100);
});

test('equal to the previous high is NOT a new high (a flat stock never qualifies)', () => {
  assert.equal(computeDynNewHigh(bars(flat(30)), 21, false).ok, false);
  assert.equal(computeDynNewHigh(bars([...flat(20, 100), 100]), 21, false).ok, false);
});

test('below the earlier peak is not a new high', () => {
  assert.equal(computeDynNewHigh(bars([100, 150, ...flat(25, 110)]), 21, false).ok, false);
});

test('the window is the latest bar plus the previous (window - 1) bars', () => {
  const highs = [...flat(10, 100), 130, ...flat(20, 100), 120];     // peak is index 10; last bar is index 31
  const days = bars(highs);
  assert.equal(computeDynNewHigh(days, 21, false).ok, true,  '1M: the 130 peak is more than 20 bars back');
  assert.equal(computeDynNewHigh(days, 63, true).ok, false, '3M window still sees the 130 peak');
  assert.equal(computeDynNewHigh(bars([130, ...flat(19, 100), 120]), 21, false).ok, false);   // peak 20 bars back: inside
  assert.equal(computeDynNewHigh(bars([130, ...flat(20, 100), 120]), 21, false).ok, true);    // peak 21 bars back: outside
});

test('strict mode needs a full window of history; partial mode needs 6 bars', () => {
  assert.equal(computeDynNewHigh(bars([...flat(19, 100), 101]), 21, false).insufficient, true);
  assert.equal(computeDynNewHigh(bars([...flat(20, 100), 101]), 21, false).insufficient, undefined);
  assert.equal(computeDynNewHigh(bars([...flat(4, 100), 101]), 21, true).insufficient, true);
  const partial = computeDynNewHigh(bars([...flat(5, 100), 101]), 21, true);
  assert.equal(partial.ok, true);
  assert.equal(partial.priorHigh, 100);
});

test('it uses the intraday HIGH, not the close', () => {
  const days = bars(flat(25, 100));
  days[24] = { ...days[24], high: 103, close: 99 };
  assert.equal(computeDynNewHigh(days, 21, false).ok, true);
});

test('a new 52W high is always also a new 3M and 1M high (the windows nest), whatever the prices', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let t = 0; t < 200; t++) {
    let p = 100; const highs = [];
    for (let i = 0; i < 300; i++) { p *= 1 + (rnd() - 0.48) * 0.05; highs.push(p); }
    const d = bars(highs);
    const r = ['1m', '3m', '52w'].map(k => computeDynNewHigh(d, SCR_NEW_HIGH_DAYS[k], false).ok);
    if (r[2]) assert.ok(r[1] && r[0], '52W high but not 3M / 1M');
    if (r[1]) assert.ok(r[0], '3M high but not 1M');
  }
});

// ─── same windows as the Market Breadth tab ─────────────────────────────────────

test('the windows match the Market Breadth tab\'s 1M / 3M / 1Y new-highs windows', () => {
  const brd = vm.runInContext('BRD_HIGH_WINDOWS', sb);
  assert.deepEqual([SCR_NEW_HIGH_DAYS['1m'], SCR_NEW_HIGH_DAYS['3m'], SCR_NEW_HIGH_DAYS['52w']], [brd.high1m, brd.high3m, brd.high1y]);
});

test('the screener and the breadth tab agree on which stocks are making new highs', () => {
  const N = 300;
  const dates = Array.from({ length: N }, (_, i) => 'D' + String(i).padStart(3, '0'));
  const mk = (symbol, highs) => highs.map((h, i) => ({
    date: dates[N - highs.length + i], symbol, open: h, high: h, low: h, close: h, prev: h, turnover: 10,
  }));
  const stocks = {
    UP: mk('UP', rising(N)), FLAT: mk('FLAT', flat(N)), FALL: mk('FALL', rising(N).reverse()),
    PEAKED: mk('PEAKED', [...rising(200), ...flat(100, 150)]), NEW: mk('NEW', rising(40)),
  };
  sb.Store.dates = dates;
  sb.Store.dailyBySymbol = stocks;
  const hist = vm.runInContext('computeBreadthHistories', sb)(N);
  const last = hist[hist.length - 1];
  for (const [period, key] of [['1m', 'high1mCloseCount'], ['3m', 'high3mCloseCount'], ['52w', 'high1yCloseCount']]) {
    const found = Object.values(stocks).filter(d => {
      const r = computeDynNewHigh(d, SCR_NEW_HIGH_DAYS[period], false);
      return !r.insufficient && r.ok;
    }).length;
    assert.equal(found, last[key], `${period}: screener finds ${found}, breadth tab counts ${last[key]}`);
  }
});

// ─── the filter through runScreener() ───────────────────────────────────────────

// `periods` = which of '1m' / '3m' / '52w' are ticked; `partial` = "allow partial history"
function runWith(periods, stocksByKey, partial = false) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '',
  });
  dom.el('scrAllowPartial').checked = partial;
  if (periods) {
    dom.el('scrF18On').checked = true;
    for (const p of ['1m', '3m', '52w']) dom.el('scrF18_' + p).checked = periods.includes(p);
  }
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in stocksByKey) {
    const days = stocksByKey[k];
    const last = days[days.length - 1];
    latest[k] = { symbol: k, isin: k, close: last.close, turnover: 10, changePct: 0, industry: 'X', sector: 'Y', ...last };
    daily[k] = days;
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.runScreener();
  // plain arrays: deepEqual rejects the sandbox's
  return {
    passed: Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort(),
    failed: Array.from(vm.runInContext('screenerFailed', sb)),
    all: Array.from(vm.runInContext('screenerPassed', sb)).concat(Array.from(vm.runInContext('screenerFailed', sb))),
  };
}

// 300 bars each: UP makes every kind of new high; MID is a new 1M and 3M high but below its year's peak;
// SHORT is a new 1M high only (below the peak of the last 3 months); FLAT is never a new high.
const FIXTURE = {
  UP: bars(rising(300)),
  MID: bars([...flat(100, 200), ...flat(150, 100), ...rising(50, 100)].map((v, i) => (i >= 250 ? v + 8 : v))),
  SHORT: bars([...flat(250, 100), 140, ...flat(40, 105), ...rising(9, 106)]),
  FLAT: bars(flat(300)),
};

test('F18 via runScreener: one window ticked - only stocks making that new high pass, the rest fail with a reason', () => {
  const r = runWith(['3m'], { UP: FIXTURE.UP, FLAT: FIXTURE.FLAT, PEAKED: bars([...rising(70), ...flat(10, 120)]) });
  assert.deepEqual(r.passed, ['UP']);
  const reasons = Object.fromEntries(r.failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  assert.match(reasons.FLAT, /F18: High 100\.00 not above the prior 3M high 100\.00/);
  assert.match(reasons.PEAKED, /F18: .*prior 3M high/);
});

test('F18 via runScreener: each window on its own picks a different (nested) set of stocks', () => {
  const r1 = runWith(['1m'], FIXTURE).passed, r3 = runWith(['3m'], FIXTURE).passed, r52 = runWith(['52w'], FIXTURE).passed;
  assert.ok(r52.every(s => r3.includes(s)) && r3.every(s => r1.includes(s)), '52W subset of 3M subset of 1M');
  assert.deepEqual(r52, ['UP']);
  assert.ok(r1.length > r52.length);
});

test('F18 via runScreener: ticking several windows requires ALL of them to be new highs', () => {
  const only1 = runWith(['1m'], FIXTURE).passed;
  const both = runWith(['1m', '52w'], FIXTURE).passed;
  assert.deepEqual(both, ['UP']);                               // the stricter window decides
  assert.ok(only1.length > both.length);
  assert.deepEqual(runWith(['1m', '3m', '52w'], FIXTURE).passed, ['UP']);
  // a stock failing the longer window is reported with the reason for that window only
  const failed = Object.fromEntries(runWith(['1m', '52w'], FIXTURE).failed.map(s => [s.symbol, s._failReasons.join(' | ')]));
  const failing = Object.keys(failed).filter(k => k !== 'FLAT');
  assert.ok(failing.length > 0);
  for (const k of failing) { assert.match(failed[k], /52W high/); assert.doesNotMatch(failed[k], /1M high/); }
});

test('F18 via runScreener: the "New High In" column lists every window the stock is making a new high in', () => {
  const tags = Object.fromEntries(runWith(['1m'], FIXTURE).all.map(s => [s.symbol, s._newHighs]));
  assert.equal(tags.UP, '1M 3M 52W');
  assert.equal(tags.FLAT, '');
  assert.ok(tags.MID === '1M 3M' || tags.MID === '1M', `MID is a nested subset of the windows (got "${tags.MID}")`);
  // the tag does not depend on which windows are ticked
  const tagsAll = Object.fromEntries(runWith(['52w'], FIXTURE).all.map(s => [s.symbol, s._newHighs]));
  assert.deepEqual(tagsAll, tags);
});

test('F18 via runScreener: the prior-high column follows the longest ticked window', () => {
  // an old peak of 160 (99 bars back: outside the 3M window, inside the 52W one), a 110 plateau since, and a new 170 high today
  const OLDPEAK = bars([...flat(200, 100), 160, ...flat(98, 110), 170]);
  const prior = (periods) => runWith(periods, { OLDPEAK }).all[0]._priorHigh;
  assert.equal(prior(['1m']), 110);
  assert.equal(prior(['3m']), 110);
  assert.equal(prior(['52w']), 160);
  assert.equal(prior(['1m', '52w']), 160);        // longest ticked window
  assert.equal(prior(['1m', '3m']), 110);
  // and the stock passes every window, while the tag column says so
  assert.equal(runWith(['1m', '3m', '52w'], { OLDPEAK }).all[0]._newHighs, '1M 3M 52W');
});

test('F18 via runScreener: a stock without enough history fails (strict) unless partial history is allowed', () => {
  const stocks = { NEWLISTING: bars(rising(30)) };
  const strict = runWith(['3m'], stocks);
  assert.deepEqual(strict.passed, []);
  assert.match(strict.failed[0]._failReasons.join(' '), /Insufficient history for a 3M high \(need 63 days\)/);
  assert.deepEqual(runWith(['3m'], stocks, true).passed, ['NEWLISTING']);
});

test('F18 via runScreener: filter on with nothing ticked does not restrict anything', () => {
  assert.deepEqual(runWith([], { FLAT: FIXTURE.FLAT, UP: FIXTURE.UP }).passed, ['FLAT', 'UP']);
});

test('F18 off: the filter does nothing', () => {
  assert.deepEqual(runWith(null, { FLAT: FIXTURE.FLAT }).passed, ['FLAT']);
});

// ─── presets ────────────────────────────────────────────────────────────────────

function fakeControls() {
  const els = {
    scrF18On: { checked: false }, scrF18_1m: { checked: false }, scrF18_3m: { checked: true }, scrF18_52w: { checked: false },
    scrF17Period: { value: '3m' }, scrF17Lag: { value: '3m', options: [] },
  };
  sb.document.getElementById = id => els[id];
  return els;
}

test('presets: F18 on/off and the ticked windows are captured and restored; "— Select preset —" resets to 3M only', () => {
  const els = fakeControls();
  els.scrF18On.checked = true; els.scrF18_1m.checked = true; els.scrF18_3m.checked = false; els.scrF18_52w.checked = true;
  const state = capturePresetState();
  assert.deepEqual([state.scrF18On, state.scrF18_1m, state.scrF18_3m, state.scrF18_52w], [true, true, false, true]);

  els.scrF18On.checked = false; els.scrF18_1m.checked = false; els.scrF18_3m.checked = true; els.scrF18_52w.checked = false;
  applyPresetState(state);
  assert.deepEqual([els.scrF18On.checked, els.scrF18_1m.checked, els.scrF18_3m.checked, els.scrF18_52w.checked], [true, true, false, true]);

  applyPresetState(vm.runInContext('DEFAULT_FILTER_STATE', sb));
  assert.deepEqual([els.scrF18On.checked, els.scrF18_1m.checked, els.scrF18_3m.checked, els.scrF18_52w.checked], [false, false, true, false]);
});

test('presets: one saved by the first (dropdown) version of the filter still restores', () => {
  const els = fakeControls();
  applyPresetState({ scrF18On: true, scrF18Period: '52w' });
  assert.deepEqual([els.scrF18On.checked, els.scrF18_1m.checked, els.scrF18_3m.checked, els.scrF18_52w.checked], [true, false, false, true]);
  applyPresetState({ scrF18On: true, scrF18Period: '1m' });
  assert.deepEqual([els.scrF18_1m.checked, els.scrF18_3m.checked, els.scrF18_52w.checked], [true, false, false]);
});

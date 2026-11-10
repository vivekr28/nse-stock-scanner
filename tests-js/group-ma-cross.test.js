'use strict';
// Stock Scanner popup's "Sector & Industry" tab, F43 / F44 (js/group-trend.js): "Sector Fast MA > Slow MA" / "Industry Fast MA > Slow MA" - the
// equal-weight index of the stock's own sector / industry (icComputeIndustryIndex, the Market Overview / chart popup index) has today's fast
// moving average of its close strictly above its slow one (SMA or EMA, any two lengths - the Technicals tab's F42 applied to the group).
// Covers the filter end to end through runScreener() against an independent calculation, SMA vs EMA, the fail reasons, the column, the invalid /
// short-history cases, the badges, presets, Reset All, the popup's HTML and that screener.js holds none of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');

const sb = loadScripts(['js/utils.js', 'js/ew-index.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/industry-charts.js', 'js/group-trend.js', 'js/presets.js']);
const realUpdateFilterBadge = sb.updateFilterBadge;   // setup() below stubs it on the sandbox

const MON = ['Jan', 'Feb', 'Mar'];
const DATES = Array.from({ length: 60 }, (_, i) => `${String(1 + (i % 28)).padStart(2, '0')}-${MON[Math.floor(i / 28)]}-2026`);
const bars = closes => closes.map((c, i) => ({ date: DATES[i], open: c, high: c, low: c, close: c, turnover: 10 }));
const range = (from, step, n) => Array.from({ length: n }, (_, i) => from + step * i);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
// the reference maths, written out here independently of screener.js (EMA seeded with the SMA of the first `n` closes)
const refSma = (a, n) => mean(a.slice(-n));
const refEma = (a, n) => { const k = 2 / (n + 1); let e = mean(a.slice(0, n)); for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };
const ref = (a, type, f, s) => (type === 'ema' ? refEma : refSma)(a, f) / (type === 'ema' ? refEma : refSma)(a, s) - 1;

// One stock per group, so a group's index is that stock's own closes rescaled (the ratio of two averages is unchanged by the rescale).
// UP rises all 60 days, DOWN falls, DIP rises 55 days then falls 5, RALLY falls 55 days then ticks up, SPIKE is flat, jumps for 3 days 25 bars
// before the end, then sits at 101 and ticks to 102 for the last 5: its 5 SMA is above its 20 SMA, but the spike still drags the 20 EMA up.
const CLOSES = {
  UP: range(100, 1, 60),
  DOWN: range(200, -1, 60),
  DIP: [...range(100, 2, 55), 205, 200, 195, 190, 185],
  RALLY: [...range(300, -2, 55), 193, 195, 197, 199, 201],
  SPIKE: [...Array(35).fill(100), 160, 160, 160, ...Array(17).fill(101), ...Array(5).fill(102)],
};
const GROUPS = { UP: 'S1', DOWN: 'S2', DIP: 'S3', RALLY: 'S4', SPIKE: 'S5' };
const stock = (symbol, industry, sector) => ({ symbol, isin: symbol, close: 100, open: 100, high: 101, low: 99, prev: 100, turnover: 10, changePct: 0, industry, sector });
const expected = (type, f, s) => Object.keys(CLOSES).filter(g => CLOSES[g] && ref(CLOSES[g], type, f, s) > 0).sort();

function setup(opts = {}) {
  const dom = installFakeDom(sb, { scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m', scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '' });
  for (const f of ['37', '38']) {
    const o = opts['f' + f] || {};
    dom.el(`scrF${f}On`).checked = !!o.on;
    for (const len of [10, 20, 50, 65, 200]) dom.el(`scrF${f}Sma${len}`).checked = (o.lens || []).includes(len);
  }
  for (const f of ['43', '44']) {
    const o = opts['f' + f] || {};
    dom.el(`scrF${f}On`).checked = !!o.on;
    dom.el(`scrF${f}Type`).value = o.type || 'sma';
    dom.el(`scrF${f}Fast`).value = String(o.fast === undefined ? 20 : o.fast);
    dom.el(`scrF${f}Slow`).value = String(o.slow === undefined ? 50 : o.slow);
  }
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const g in CLOSES) {
    latest[g] = stock(g, g, GROUPS[g]);
    daily[g] = bars(CLOSES[g]);
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.Store.dates = DATES.slice();
  vm.runInContext('_gtCache = {}', sb);
  return dom;
}
function run(opts) {
  setup(opts);
  sb.runScreener();
  const passedRows = Object.fromEntries(Array.from(vm.runInContext('screenerPassed', sb), s => [s.symbol, s]));
  const failed = Object.fromEntries(Array.from(vm.runInContext('screenerFailed', sb), s => [s.symbol, Array.from(s._failReasons).join('|')]));
  return { passed: Object.keys(passedRows).sort(), failed, passedRows };
}

test('F44 (industry) keeps the stocks whose industry index has its fast SMA above its slow SMA - checked against an independent calculation', () => {
  for (const [f, s] of [[5, 20], [3, 10], [10, 50], [20, 50]]) {
    const r = run({ f44: { on: true, type: 'sma', fast: f, slow: s } });
    assert.deepEqual(r.passed, expected('sma', f, s), `${f} > ${s}`);
  }
  assert.deepEqual(run({ f44: { on: true, type: 'sma', fast: 5, slow: 20 } }).passed, ['DIP', 'SPIKE', 'UP']);   // and it is a real mix: DOWN and RALLY are out
});

test('F43 (sector) judges the sector index; the fail reason names the group, both averages and their values', () => {
  const r = run({ f43: { on: true, type: 'sma', fast: 5, slow: 20 } });
  assert.deepEqual(r.passed, ['DIP', 'SPIKE', 'UP']);
  assert.match(r.failed.DOWN, /^F43: Sector 'S2' EW index 5 SMA [\d.]+ not above 20 SMA [\d.]+$/);
  assert.match(r.failed.RALLY, /^F43: Sector 'S4' EW index 5 SMA [\d.]+ not above 20 SMA [\d.]+$/);
});

test('the fail reason carries the real averages of the index (the stock rescaled, so they scale from 100)', () => {
  const r = run({ f44: { on: true, type: 'sma', fast: 5, slow: 20 } });
  const c = CLOSES.DOWN, scale = 100 / c[0];
  const m = r.failed.DOWN.match(/5 SMA ([\d.]+) not above 20 SMA ([\d.]+)/);
  assert.ok(Math.abs(parseFloat(m[1]) - refSma(c, 5) * scale) < 0.01);
  assert.ok(Math.abs(parseFloat(m[2]) - refSma(c, 20) * scale) < 0.01);
});

test('SMA and EMA are different tests: SPIKE has its 5 SMA above its 20 SMA but its 5 EMA below its 20 EMA, so the Type switch changes the result', () => {
  assert.ok(ref(CLOSES.SPIKE, 'sma', 5, 20) > 0 && ref(CLOSES.SPIKE, 'ema', 5, 20) < 0);
  assert.ok(run({ f44: { on: true, type: 'sma', fast: 5, slow: 20 } }).passed.includes('SPIKE'));
  const e = run({ f44: { on: true, type: 'ema', fast: 5, slow: 20 } });
  assert.ok(!e.passed.includes('SPIKE'));
  assert.match(e.failed.SPIKE, /^F44: Industry 'SPIKE' EW index 5 EMA [\d.]+ not above 20 EMA [\d.]+$/);
  for (const [f, s] of [[5, 20], [3, 10], [10, 50]]) assert.deepEqual(run({ f44: { on: true, type: 'ema', fast: f, slow: s } }).passed, expected('ema', f, s), `EMA ${f} > ${s}`);
});

test('equal averages do not pass (strictly above): a flat index fails', () => {
  setup({ f44: { on: true, fast: 5, slow: 20 } });
  sb.Store.dailyBySymbol.UP = bars(Array(60).fill(100));
  vm.runInContext('_gtCache = {}', sb);
  sb.runScreener();
  const failed = Array.from(vm.runInContext('screenerFailed', sb)).find(s => s.symbol === 'UP');
  assert.match(Array.from(failed._failReasons).join('|'), /F44: Industry 'UP' EW index 5 SMA 100.00 not above 20 SMA 100.00/);
});

test('F43 and F44 together: a stock must pass both, and a stock failing both lists both', () => {
  const r = run({ f43: { on: true, fast: 5, slow: 20 }, f44: { on: true, type: 'ema', fast: 5, slow: 20 } });
  assert.deepEqual(r.passed, ['DIP', 'UP']);              // SPIKE passes the sector SMA test but fails the industry EMA test
  assert.match(r.failed.DOWN, /F43.*\|F44/);
  assert.match(r.failed.SPIKE, /^F44:/);
  assert.ok(!/F43/.test(r.failed.SPIKE));
});

test('it combines as AND with F37 / F38: a group must also close above the ticked SMA', () => {
  const r = run({ f44: { on: true, fast: 5, slow: 20 }, f38: { on: true, lens: [10] } });
  // 5 > 20 SMA: DIP, SPIKE, UP.  Above the 10 SMA: RALLY, SPIKE, UP.  Both: SPIKE, UP.
  assert.deepEqual(r.passed, ['SPIKE', 'UP']);
  assert.match(r.failed.DIP, /F38/);
  assert.ok(!/F44/.test(r.failed.DIP));
});

test('a group is judged on its equal-weight average, not on one member', () => {
  setup({ f44: { on: true, fast: 5, slow: 20 } });
  // a second UP stock that falls hard drags the group's average index down: the 5 SMA falls below the 20 SMA although UP's own stock is rising
  sb.Store.latestBySymbol.UP2 = stock('UP2', 'UP', 'S1');
  sb.Store.dailyBySymbol.UP2 = bars(range(300, -3, 60));
  vm.runInContext('_gtCache = {}', sb);
  sb.runScreener();
  const passed = Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol);
  assert.ok(!passed.includes('UP') && !passed.includes('UP2'));
});

test('a slow length longer than the index history fails the group, saying it has too little history', () => {
  const r = run({ f44: { on: true, fast: 20, slow: 200 } });
  assert.deepEqual(r.passed, []);
  for (const g of Object.keys(CLOSES)) assert.match(r.failed[g], /^F44: Industry '\w+' EW index has too little history for 20 \/ 200 SMA$/);
  assert.match(run({ f43: { on: true, type: 'ema', fast: 20, slow: 200 } }).failed.UP, /^F43: Sector 'S1' EW index has too little history for 20 \/ 200 EMA$/);
});

test('a stock whose group has no index fails with a clear reason', () => {
  setup({ f44: { on: true, fast: 5, slow: 20 } });
  sb.Store.latestBySymbol.NEW = stock('NEW', 'Fresh', 'S9');
  sb.Store.dailyBySymbol.NEW = [];
  vm.runInContext('_gtCache = {}', sb);
  sb.runScreener();
  const f = Array.from(vm.runInContext('screenerFailed', sb)).find(s => s.symbol === 'NEW');
  assert.match(Array.from(f._failReasons).join('|'), /F44: Industry 'Fresh' has no equal-weight index/);
});

test('blank, zero or invalid lengths fall back to 20 / 50 like the Technicals filter, and an unknown type is SMA', () => {
  const dom = setup({ f43: { on: true, fast: '', slow: 'abc' }, f44: { on: true, type: 'ema', fast: 0, slow: 7 } });
  const st = sb.gtFilterState();
  assert.deepEqual([st.maSec.type, st.maSec.fast, st.maSec.slow], ['sma', 20, 50]);
  assert.deepEqual([st.maInd.type, st.maInd.fast, st.maInd.slow], ['ema', 20, 7]);
  dom.el('scrF43Type').value = 'weird';
  assert.equal(sb.gtFilterState().maSec.type, 'sma');
});

test('both filters off: nothing is restricted and no column or field is recorded', () => {
  const r = run({});
  assert.deepEqual(r.passed, Object.keys(CLOSES).sort());
  for (const g in r.passedRows) assert.ok(!('_gtMaSec' in r.passedRows[g]) && !('_gtMaInd' in r.passedRows[g]));
  assert.deepEqual(Array.from(sb.gtColumns(), c => c.key), []);
  assert.equal(sb.gtFilterState().any, false);
});

test('the result column shows how far the fast MA sits above the slow one, in %, and is labelled with the lengths and type', () => {
  setup({ f44: { on: true, type: 'ema', fast: 3, slow: 10 }, f43: { on: true, fast: 5, slow: 20 } });
  const cols = Array.from(sb.gtColumns());
  assert.deepEqual(cols.map(c => c.label), ['Sector EW 5 vs 20 SMA', 'Ind EW 3 vs 10 EMA']);
  assert.deepEqual(cols.map(c => c.key), ['_gtMaSec', '_gtMaInd']);
  sb.runScreener();
  const up = Array.from(vm.runInContext('screenerPassed', sb)).find(s => s.symbol === 'UP');
  assert.ok(Math.abs(up._gtMaSec - ref(CLOSES.UP, 'sma', 5, 20) * 100) < 1e-6);
  assert.ok(Math.abs(up._gtMaInd - ref(CLOSES.UP, 'ema', 3, 10) * 100) < 1e-6);
  assert.equal(cols[0].fmt(up._gtMaSec), (up._gtMaSec > 0 ? '+' : '') + up._gtMaSec.toFixed(2) + '%');
  assert.equal(cols[0].fmt(NaN), '-');
  assert.equal(cols[0].cls(1), 'positive');
  assert.equal(cols[0].cls(-1), 'negative');
});

test('the badges: the tab count and the total include F43 / F44, once each', () => {
  const dom = setup({ f43: { on: true }, f44: { on: true }, f38: { on: true, lens: [50] } });
  dom.el('scrF9On').checked = true;                   // an existing Sector & Industry filter
  sb.updateApplyBtn = () => {};
  realUpdateFilterBadge();
  assert.equal(dom.el('scrTabIndCount').textContent, 4);
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 4);
  assert.equal(sb.gtActiveCount(), 3);
});

test('presets: the eight fields are captured and restored, and default to off at SMA 20 / 50', () => {
  const dom = setup({ f43: { on: true, type: 'ema', fast: 9, slow: 21 }, f44: { on: true, type: 'sma', fast: 10, slow: 30 } });
  const state = JSON.parse(JSON.stringify(sb.capturePresetState()));
  assert.deepEqual([state.scrF43On, state.scrF43Type, state.scrF43Fast, state.scrF43Slow], [true, 'ema', '9', '21']);
  assert.deepEqual([state.scrF44On, state.scrF44Type, state.scrF44Fast, state.scrF44Slow], [true, 'sma', '10', '30']);
  const defaults = JSON.parse(JSON.stringify(vm.runInContext('DEFAULT_FILTER_STATE', sb)));
  for (const f of ['43', '44']) assert.deepEqual([defaults[`scrF${f}On`], defaults[`scrF${f}Type`], defaults[`scrF${f}Fast`], defaults[`scrF${f}Slow`]], [false, 'sma', '20', '50']);
  sb.applyPresetState(defaults);
  assert.equal(dom.el('scrF43On').checked, false);
  assert.equal(dom.el('scrF43Type').value, 'sma');
  sb.applyPresetState(state);
  assert.deepEqual([dom.el('scrF43On').checked, dom.el('scrF43Type').value, dom.el('scrF43Fast').value, dom.el('scrF43Slow').value], [true, 'ema', '9', '21']);
  assert.deepEqual([dom.el('scrF44On').checked, dom.el('scrF44Type').value, dom.el('scrF44Fast').value, dom.el('scrF44Slow').value], [true, 'sma', '10', '30']);
});

test('Reset All in the scanner (resetScreener) puts both back to off at SMA 20 / 50', () => {
  const dom = setup({ f43: { on: true, type: 'ema', fast: 9, slow: 21 }, f44: { on: true, type: 'ema', fast: 3, slow: 7 } });
  sb.initF16Dates = () => {};
  sb.resetScreener();
  for (const f of ['43', '44']) assert.deepEqual([dom.el(`scrF${f}On`).checked, dom.el(`scrF${f}Type`).value, dom.el(`scrF${f}Fast`).value, dom.el(`scrF${f}Slow`).value], [false, 'sma', '20', '50']);
});

test('index.html: F43 | F44 are the next pair of rows after F37 | F38 on the Sector & Industry tab, shaped like the Technicals F42 row', () => {
  const pane = html.slice(html.indexOf('id="scrPaneIndustry"'), html.indexOf('id="scrPaneRelStrength"'));
  const ids = [...pane.matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);
  assert.deepEqual(ids.slice(2, 6), ['scrF37On', 'scrF38On', 'scrF43On', 'scrF44On']);
  for (const f of ['43', '44']) {
    for (const id of ['On', 'Type', 'Fast', 'Slow']) assert.ok(pane.includes(`id="scrF${f}${id}"`), `scrF${f}${id}`);
    assert.match(pane, new RegExp(`id="scrF${f}Fast" value="20" min="2" step="1"`));
    assert.match(pane, new RegExp(`id="scrF${f}Slow" value="50" min="2" step="1"`));
    assert.match(pane, new RegExp(`<select id="scrF${f}Type"[^>]*>\\s*<option value="sma" selected>SMA</option>\\s*<option value="ema">EMA</option>`));
  }
  assert.match(pane, /Sector Fast MA &gt; Slow MA:/);
  assert.match(pane, /Industry Fast MA &gt; Slow MA:/);
  const f42 = html.slice(html.indexOf('id="scrF42On"'), html.indexOf('id="scrF42Slow"'));
  assert.match(f42, /Fast MA &gt; Slow MA:/);   // the Technicals row it mirrors is still there
  assert.ok(html.indexOf('src="js/group-trend.js') > html.indexOf('src="js/screener.js'));
});

test('guard: screener.js holds none of the feature\'s ids or logic - the gt* hooks it already calls carry it', () => {
  const src = read('js/screener.js');
  for (const needle of ['scrF43', 'scrF44', 'GT_MA_FILTERS', '_gtMaSec', '_gtMaInd', 'maSec', 'maInd']) assert.ok(!src.includes(needle), needle);
});

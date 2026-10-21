'use strict';
// Stock Scanner popup's "Sector & Industry" tab, F37 / F38 (js/group-trend.js): "Sector above SMA" / "Industry above SMA" - the equal-weight
// index of the stock's own sector / industry (icComputeIndustryIndex, the Market Overview / chart popup index) closes above every ticked one of
// its 10 / 20 / 50 SMA. Covers the pure group map, both filters end to end through runScreener() (every ticked SMA must hold, fail reasons, the
// column), the tick / switch-on behaviour, the hooks, presets, the popup's HTML (two filters per row) and that screener.js holds none of it.
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
const css = read('css/styles.css');

const sb = loadScripts(['js/utils.js', 'js/ew-index.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/industry-charts.js', 'js/group-trend.js', 'js/presets.js']);
const realUpdateFilterBadge = sb.updateFilterBadge;   // setup() below stubs it on the sandbox

// 60 trading days, written the way the data files write them
const MON = ['Jan', 'Feb', 'Mar'];
const DATES = Array.from({ length: 60 }, (_, i) => `${String(1 + (i % 28)).padStart(2, '0')}-${MON[Math.floor(i / 28)]}-2026`);
const bars = closes => closes.map((c, i) => ({ date: DATES[i], open: c, high: c, low: c, close: c, turnover: 10 }));
const range = (from, step, n) => Array.from({ length: n }, (_, i) => from + step * i);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// One stock per group, so a group's index is that stock's own closes (rescaled): UP rises all 60 days (above every SMA), DOWN falls (below all),
// DIP rises 55 days then falls 5 (below its 10 SMA, above its 50 SMA), RALLY falls 55 days then ticks up (above its 10 SMA, below its 50 SMA).
const CLOSES = {
  UP: range(100, 1, 60),
  DOWN: range(200, -1, 60),
  DIP: [...range(100, 2, 55), 205, 200, 195, 190, 185],
  RALLY: [...range(300, -2, 55), 193, 195, 197, 199, 201],
};
const GROUPS = { UP: 'S1', DOWN: 'S2', DIP: 'S3', RALLY: 'S4' };
const stock = (symbol, industry, sector) => ({ symbol, isin: symbol, close: 100, open: 100, high: 101, low: 99, prev: 100, turnover: 10, changePct: 0, industry, sector });

function setup(opts = {}) {
  const dom = installFakeDom(sb, { scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m', scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '' });
  for (const f of ['37', '38']) {
    const o = opts['f' + f] || {};
    dom.el(`scrF${f}On`).checked = !!o.on;
    for (const len of [10, 20, 50]) dom.el(`scrF${f}Sma${len}`).checked = (o.lens || []).includes(len);
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
const ALL = Object.keys(CLOSES).sort();

test('the group map: the index close and its 10 / 20 / 50 SMA (index = the stock rescaled, so close / SMA matches the raw closes)', () => {
  setup();
  const m = sb.gtGroupMap('industry');
  for (const g of ['UP', 'DOWN', 'DIP', 'RALLY']) {
    const c = CLOSES[g];
    for (const len of [10, 20, 50]) {
      assert.ok(Math.abs(m[g].close / m[g].sma[len] - c[c.length - 1] / mean(c.slice(-len))) < 1e-9, `${g} ${len}`);
    }
  }
  assert.equal(Object.keys(sb.gtGroupMap('sector')).sort().join(), 'S1,S2,S3,S4');
});

test('an SMA longer than the index history is NaN, and the group fails it', () => {
  setup({ f38: { on: true, lens: [50] } });
  sb.Store.dates = DATES.slice(0, 30);
  vm.runInContext('_gtCache = {}', sb);
  assert.ok(isNaN(sb.gtGroupMap('industry').UP.sma[50]));
  sb.runScreener();
  assert.equal(vm.runInContext('screenerPassed', sb).length, 0);
});

test('F38 with one SMA ticked: the industry index must close above it', () => {
  assert.deepEqual(run({ f38: { on: true, lens: [10] } }).passed, ['RALLY', 'UP']);
  assert.deepEqual(run({ f38: { on: true, lens: [50] } }).passed, ['DIP', 'UP']);
});

test('F38 with several ticked: ALL of them must hold', () => {
  assert.deepEqual(run({ f38: { on: true, lens: [10, 50] } }).passed, ['UP']);
  assert.deepEqual(run({ f38: { on: true, lens: [10, 20, 50] } }).passed, ['UP']);
});

test('F37 judges the sector index, and the fail reason names the group and the SMAs it is under', () => {
  const r = run({ f37: { on: true, lens: [10, 50] } });
  assert.deepEqual(r.passed, ['UP']);
  assert.match(r.failed.DOWN, /^F37: Sector 'S2' EW index [\d.]+ not above 10 SMA [\d.]+, 50 SMA [\d.]+$/);
  assert.match(r.failed.DIP, /^F37: Sector 'S3' EW index [\d.]+ not above 10 SMA [\d.]+$/);
});

test('F37 and F38 together: a stock must pass both; a stock failing both lists both', () => {
  const r = run({ f37: { on: true, lens: [10] }, f38: { on: true, lens: [50] } });
  assert.deepEqual(r.passed, ['UP']);
  assert.match(r.failed.DOWN, /F37.*\|F38/);
  assert.match(r.failed.RALLY, /F38/);     // RALLY is above its 10 SMA but not its 50
  assert.ok(!/F37/.test(r.failed.RALLY));
});

test('a group with several stocks is judged on their equal-weight average, not on one member', () => {
  setup({ f38: { on: true, lens: [20] } });
  // a second UP stock that falls hard drags the group's average index below its 20 SMA, although UP's own stock is still rising
  sb.Store.latestBySymbol.UP2 = stock('UP2', 'UP', 'S1');
  sb.Store.dailyBySymbol.UP2 = bars(range(300, -3, 60));
  vm.runInContext('_gtCache = {}', sb);
  sb.runScreener();
  const passed = Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol);
  assert.ok(!passed.includes('UP') && !passed.includes('UP2'));
});

test('a stock whose group has no index fails with a clear reason', () => {
  setup({ f38: { on: true, lens: [10] } });
  sb.Store.latestBySymbol.NEW = stock('NEW', 'Fresh', 'S9');
  sb.Store.dailyBySymbol.NEW = [];
  vm.runInContext('_gtCache = {}', sb);
  sb.runScreener();
  const f = Array.from(vm.runInContext('screenerFailed', sb)).find(s => s.symbol === 'NEW');
  assert.match(Array.from(f._failReasons).join('|'), /F38: Industry 'Fresh' has no equal-weight index/);
});

test('off, or on with no SMA ticked: nothing is restricted and nothing recorded', () => {
  assert.deepEqual(run({ f38: { on: false, lens: [50] } }).passed, ALL);
  const r = run({ f38: { on: true, lens: [] } });
  assert.deepEqual(r.passed, ALL);
  assert.equal(r.passedRows.UP._gtInd, undefined);
});

test('the column: the index\'s % above / below the longest ticked SMA, only while the filter is on', () => {
  setup({ f37: { on: true, lens: [10, 50] }, f38: { on: true, lens: [20] } });
  assert.deepEqual(Array.from(sb.gtColumns(), c => c.label), ['Sector EW vs 50 SMA', 'Ind EW vs 20 SMA']);
  sb.runScreener();
  const up = vm.runInContext('screenerPassed', sb)[0];
  const c = CLOSES.UP;
  assert.ok(Math.abs(up._gtSec - (c[59] / mean(c.slice(-50)) - 1) * 100) < 1e-9);
  const col = sb.gtColumns()[0];
  assert.equal(col.fmt(3.14159), '+3.1%');
  assert.equal(col.fmt(-2), '-2.0%');
  assert.equal(col.fmt(NaN), '-');
  assert.equal(col.cls(1), 'positive');
  assert.equal(col.cls(-1), 'negative');
  setup();
  assert.deepEqual(Array.from(sb.gtColumns()), []);
});

test('hooks: gtFilterState / gtActiveCount read the controls (a filter counts only with an SMA ticked); Reset All clears them', () => {
  const dom = setup({ f37: { on: true, lens: [20, 50] }, f38: { on: true, lens: [] } });
  assert.deepEqual(JSON.parse(JSON.stringify(sb.gtFilterState())), { sec: { on: true, lens: [20, 50] }, ind: { on: false, lens: [] }, any: true });
  assert.equal(sb.gtActiveCount(), 1);
  sb.gtReset();
  assert.equal(dom.el('scrF37On').checked, false);
  assert.equal(dom.el('scrF37Sma20').checked, false);
  assert.equal(sb.gtActiveCount(), 0);
  assert.equal(sb.gtFilterState().any, false);
});

test('ticking an SMA switches the filter on, unticking the last one switches it off, switching it on with none ticked ticks the 20', () => {
  // js/group-trend.js alone, in a page whose elements record the listeners it registers
  const els = {};
  const el = id => els[id] || (els[id] = { id, checked: false, listeners: [], addEventListener(t, f) { this.listeners.push(f); } });
  const ctx = vm.createContext({ document: { getElementById: el }, Store: {} });
  vm.runInContext(read('js/group-trend.js'), ctx);
  const fire = e => e.listeners.forEach(f => f());
  const on = el('scrF38On');
  el('scrF38Sma50').checked = true; fire(el('scrF38Sma50'));
  assert.equal(on.checked, true);
  el('scrF38Sma50').checked = false; fire(el('scrF38Sma50'));
  assert.equal(on.checked, false);
  on.checked = true; fire(on);
  assert.equal(el('scrF38Sma20').checked, true);
  on.checked = false; fire(on);                       // switching off keeps what was ticked
  assert.equal(el('scrF38Sma20').checked, true);
  assert.equal(el('scrF37Sma20').checked, false);     // the other filter is untouched
});

test('the badges: the tab count and the total include F37 / F38', () => {
  const dom = setup({ f37: { on: true, lens: [10] }, f38: { on: true, lens: [50] } });
  dom.el('scrF9On').checked = true;                   // an existing Sector & Industry filter
  sb.updateApplyBtn = () => {};
  realUpdateFilterBadge();
  assert.equal(dom.el('scrTabIndCount').textContent, 3);
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 3);
});

test('presets: the eight fields are captured and restored, and default to off', () => {
  const dom = setup({ f37: { on: true, lens: [10, 50] }, f38: { on: true, lens: [20] } });
  const state = JSON.parse(JSON.stringify(sb.capturePresetState()));
  assert.deepEqual([state.scrF37On, state.scrF37Sma10, state.scrF37Sma20, state.scrF37Sma50], [true, true, false, true]);
  assert.deepEqual([state.scrF38On, state.scrF38Sma10, state.scrF38Sma20, state.scrF38Sma50], [true, false, true, false]);
  const defaults = JSON.parse(JSON.stringify(vm.runInContext('DEFAULT_FILTER_STATE', sb)));
  for (const k of ['scrF37On', 'scrF37Sma10', 'scrF37Sma20', 'scrF37Sma50', 'scrF38On', 'scrF38Sma10', 'scrF38Sma20', 'scrF38Sma50']) assert.equal(defaults[k], false, k);
  sb.applyPresetState(defaults);
  assert.equal(dom.el('scrF37On').checked, false);
  sb.applyPresetState(state);
  assert.equal(dom.el('scrF37Sma50').checked, true);
  assert.equal(dom.el('scrF38Sma20').checked, true);
  assert.equal(dom.el('scrF38Sma10').checked, false);
});

test('Reset All in the scanner (resetScreener) resets them too', () => {
  const dom = setup({ f37: { on: true, lens: [10] }, f38: { on: true, lens: [50] } });
  sb.initF16Dates = () => {};
  sb.resetScreener();
  assert.equal(dom.el('scrF37On').checked, false);
  assert.equal(dom.el('scrF38Sma50').checked, false);
});

test('index.html / styles.css: the rows sit on the Sector & Industry tab two to a row, each with its three SMA ticks', () => {
  const pane = html.slice(html.indexOf('id="scrPaneIndustry"'), html.indexOf('id="scrPaneRelStrength"'));
  const ids = [...pane.matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);
  assert.deepEqual(ids.slice(2, 4), ['scrF37On', 'scrF38On']);                    // the pair right under Sector | Industry
  for (const f of ['37', '38']) for (const len of [10, 20, 50]) assert.ok(pane.includes(`id="scrF${f}Sma${len}"`), `${f} ${len}`);
  assert.match(pane, /Sector index above:/);
  assert.match(pane, /Industry index above:/);
  assert.ok(html.indexOf('src="js/group-trend.js') > html.indexOf('src="js/screener.js'));
  // two columns: the pane's list is a grid of equal tracks that collapses to one on a narrow modal
  assert.match(css, /#scrPaneIndustry \.scr-filters-list \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(auto-fit, minmax\(\d+px, 1fr\)\)/);
});

test('guard: screener.js holds none of the feature\'s ids or logic - only typeof-guarded gt* hooks', () => {
  const src = read('js/screener.js');
  for (const needle of ['scrF37', 'scrF38', 'GT_FILTERS', '_gtInd', '_gtSec']) assert.ok(!src.includes(needle), needle);
  for (const name of ['gtFilterState', 'gtActiveCount', 'gtColumns', 'gtReset']) {
    assert.ok(src.includes(`typeof ${name} === 'function'`), `${name} must be typeof-guarded`);
  }
  for (const name of ['gtPrepare', 'gtApplyToStock']) {
    const lines = src.split(/\r?\n/).filter(l => l.includes(name + '('));
    assert.ok(lines.length > 0 && lines.every(l => /\bgt\b\s*&&/.test(l)), name);
  }
});

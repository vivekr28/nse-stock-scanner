'use strict';
// Stock Scanner popup's "Sector & Industry" tab, F37 / F38 (js/group-trend.js): "Sector above SMA" / "Industry above SMA" - the equal-weight
// index of the stock's own sector / industry (icComputeIndustryIndex, the Market Overview / chart popup index) closes above every ticked one of
// its 10 / 20 / 50 / 65 / 200 SMA. Covers the pure group map, both filters end to end through runScreener() (every ticked SMA must hold, fail reasons, the
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
    for (const len of [10, 20, 50, 65, 200]) dom.el(`scrF${f}Sma${len}`).checked = (o.lens || []).includes(len);
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
  const state = JSON.parse(JSON.stringify(sb.gtFilterState()));
  assert.deepEqual([state.sec, state.ind, state.any, state.chg.on], [{ on: true, lens: [20, 50] }, { on: false, lens: [] }, true, false]);
  assert.equal(sb.gtActiveCount(), 1);
  sb.gtReset();
  assert.equal(dom.el('scrF37On').checked, false);
  assert.equal(dom.el('scrF37Sma20').checked, false);
  assert.equal(sb.gtActiveCount(), 0);
  assert.equal(sb.gtFilterState().any, false);
});

// ── F39: Industry EW % Change ────────────────────────────────────────────────────

// An industry's index is its stock's own closes rescaled, so a % change of the index = the % change of the stock's own prices.
// (DATES[i] is a real day each; the index starts on the 2nd date, the 1st has no prior close.) UP rises 1 a day from 100.
const iso = i => { const m = MON.indexOf(DATES[i].slice(3, 6)) + 1; return `2026-${String(m).padStart(2, '0')}-${DATES[i].slice(0, 2)}`; };

function setupChg(o = {}) {
  const dom = setup();
  dom.el('scrF39On').checked = o.on !== false;
  dom.el('scrF39FromDate').value = o.from === undefined ? iso(10) : o.from;
  dom.el('scrF39ToDate').value = o.to === undefined ? iso(40) : o.to;
  dom.el('scrF39FromField').value = o.ff || 'close';
  dom.el('scrF39ToField').value = o.tf || 'close';
  dom.el('scrF39Val').value = o.val === undefined ? '0' : String(o.val);
  return dom;
}
function runChg(o) { setupChg(o); sb.runScreener(); return { passed: Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort(), failed: Object.fromEntries(Array.from(vm.runInContext('screenerFailed', sb), s => [s.symbol, Array.from(s._failReasons).join('|')])), rows: Object.fromEntries(Array.from(vm.runInContext('screenerPassed', sb), s => [s.symbol, s])) }; }

test('F39 pure: % change between two bars on chosen fields; a non-trading date uses the nearest earlier bar', () => {
  const day = d => new Date(2026, 0, d).getTime();
  const bars = [10, 11, 12, 13].map((d, i) => ({ ts: day(d), open: 100 + i, high: 110 + i, low: 90 + i, close: 100 + 10 * i }));
  assert.equal(sb.gtDateChange(bars, day(10), 'close', day(13), 'close').pct, 30);                 // 100 -> 130
  assert.equal(sb.gtDateChange(bars, day(10), 'low', day(13), 'high').pct, (113 - 90) / 90 * 100);  // chosen fields
  assert.equal(sb.gtDateChange(bars, day(10), 'close', Infinity, 'close').pct, 30);                 // blank To date = the latest bar
  assert.equal(sb.gtDateChange(bars, day(10), 'close', day(12) + 1, 'close').pct, 20);              // not a bar: the earlier one
  assert.equal(sb.gtDateChange(bars, day(1), 'close', day(11), 'close').pct, 10);                    // From before the index starts: its first bar
});

test('F39 pure: the reasons for no number', () => {
  const day = d => new Date(2026, 0, d).getTime();
  const bars = [{ ts: day(10), open: 1, high: 1, low: 1, close: 1 }, { ts: day(11), open: 2, high: 2, low: 2, close: 2 }];
  assert.match(sb.gtDateChange(bars, NaN, 'close', day(11), 'close').reason, /no From date/);
  assert.match(sb.gtDateChange(bars, day(11), 'close', day(10), 'close').reason, /after To date/);
  assert.match(sb.gtDateChange([], day(10), 'close', day(11), 'close').reason, /no index data/);
  assert.match(sb.gtDateChange(bars, day(3), 'close', day(5), 'close').reason, /no index data in the selected date range/);   // both dates before the index starts
  assert.match(sb.gtDateChange([{ ts: day(10), open: 0, high: 0, low: 0, close: 0 }], day(10), 'close', day(10), 'close').reason, /missing price/);
});

test('F39 end to end: industries whose EW index rose at least N% between the dates pass, others fail with the number in the reason', () => {
  // From bar 10 to bar 40 (the index is the stock rescaled, so its % change is the stock's own): UP 110 -> 140, DIP 120 -> 180, DOWN 190 -> 160, RALLY 280 -> 220
  const up = (140 - 110) / 110 * 100, dip = (180 - 120) / 120 * 100;
  let r = runChg({ val: 0 });
  assert.deepEqual(r.passed, ['DIP', 'UP']);
  assert.ok(Math.abs(r.rows.UP._gtChg - up) < 1e-9 && Math.abs(r.rows.DIP._gtChg - dip) < 1e-9);
  assert.match(r.failed.DOWN, /^F39: Industry 'DOWN' EW C→C change -15\.79% < 0%$/);
  assert.match(r.failed.RALLY, /^F39: Industry 'RALLY' EW C→C change -21\.43% < 0%$/);
  assert.deepEqual(runChg({ val: 30 }).passed, ['DIP']);                 // UP's 27.27% is under 30
  assert.deepEqual(runChg({ val: dip - 0.001 }).passed, ['DIP']);   // a hair under DIP's change passes (not the exact number: the index maths is floating point)
  assert.deepEqual(runChg({ val: 60 }).passed, []);
});

test('F39 end to end: the chosen fields and a blank To date (= the latest bar)', () => {
  // bars have o = h = l = c, so the field choice does not move the number here; a blank To date runs to bar 59: UP 110 -> 159
  const r = runChg({ to: '' });
  assert.ok(Math.abs(r.rows.UP._gtChg - (159 - 110) / 110 * 100) < 1e-9);
  assert.deepEqual(runChg({ ff: 'open', tf: 'high' }).passed, ['DIP', 'UP']);
});

test('F39 end to end: no From date, or From after To, fails every stock with the reason; a group with no index says so', () => {
  let r = runChg({ from: '' });
  assert.deepEqual(r.passed, []);
  assert.match(r.failed.UP, /^F39: Industry 'UP' EW no From date selected$/);
  r = runChg({ from: iso(40), to: iso(10) });
  assert.match(r.failed.UP, /EW From date is after To date$/);
  setupChg();
  sb.Store.latestBySymbol.NEW = stock('NEW', 'Fresh', 'S9');
  sb.Store.dailyBySymbol.NEW = [];
  vm.runInContext('_gtCache = {}', sb);
  sb.runScreener();
  const f = Array.from(vm.runInContext('screenerFailed', sb)).find(s => s.symbol === 'NEW');
  assert.match(Array.from(f._failReasons).join('|'), /F39: Industry 'Fresh' EW has no equal-weight index/);
});

test('F39 is off: nothing is restricted or recorded; it combines with F38 as AND', () => {
  const off = runChg({ on: false });
  assert.deepEqual(off.passed, ALL);
  assert.equal(off.rows.UP._gtChg, undefined);
  const dom = setupChg({ val: 0 });
  dom.el('scrF38On').checked = true; dom.el('scrF38Sma50').checked = true;     // above the 50 SMA: DIP and UP, then F39 >= 0: both
  sb.runScreener();
  assert.deepEqual(Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort(), ['DIP', 'UP']);
  dom.el('scrF39Val').value = '30';
  sb.runScreener();
  assert.deepEqual(Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort(), ['DIP']);
});

test('F39 column, count and reset', () => {
  const dom = setupChg({ ff: 'low', tf: 'high', val: 5 });
  assert.deepEqual(Array.from(sb.gtColumns(), c => c.label), ['Ind EW L→H %']);
  const col = sb.gtColumns()[0];
  assert.equal(col.fmt(3.456), '+3.46%'); assert.equal(col.fmt(-1), '-1.00%'); assert.equal(col.fmt(NaN), '-');
  assert.equal(col.cls(5), 'positive'); assert.equal(col.cls(4.9), 'negative');
  assert.equal(sb.gtActiveCount(), 1);
  assert.equal(sb.gtFilterState().any, true);
  sb.gtReset();
  assert.equal(dom.el('scrF39On').checked, false);
  assert.equal(dom.el('scrF39FromField').value, 'close');
  assert.equal(dom.el('scrF39Val').value, '0');
  assert.equal(sb.gtActiveCount(), 0);
});

test('F39 dates default to a month of trading days back -> the latest bar, limited to the loaded range', () => {
  const dom = setup();
  sb.gtInitDates();
  assert.equal(dom.el('scrF39ToDate').value, iso(59));
  assert.equal(dom.el('scrF39FromDate').value, iso(59 - 21));
  assert.equal(dom.el('scrF39FromDate').min, iso(0));
  assert.equal(dom.el('scrF39FromDate').max, iso(59));
});

test('F39 presets: six fields captured and restored, defaults off / close / close / 0', () => {
  const dom = setupChg({ ff: 'low', tf: 'open', val: 7, from: iso(12), to: iso(30) });
  const state = JSON.parse(JSON.stringify(sb.capturePresetState()));
  assert.deepEqual([state.scrF39On, state.scrF39FromDate, state.scrF39FromField, state.scrF39ToDate, state.scrF39ToField, state.scrF39Val],
    [true, iso(12), 'low', iso(30), 'open', '7']);
  const defaults = JSON.parse(JSON.stringify(vm.runInContext('DEFAULT_FILTER_STATE', sb)));
  assert.deepEqual([defaults.scrF39On, defaults.scrF39FromField, defaults.scrF39ToField, defaults.scrF39Val], [false, 'close', 'close', '0']);
  sb.applyPresetState(defaults);
  assert.equal(dom.el('scrF39On').checked, false);
  sb.applyPresetState(state);
  assert.equal(dom.el('scrF39ToField').value, 'open');
  assert.equal(dom.el('scrF39ToDate').value, iso(30));
});

test('F39 in index.html: the last row of the tab, with both dates and field selects; screener.js and ui.js hold none of its logic', () => {
  const pane = html.slice(html.indexOf('id="scrPaneIndustry"'), html.indexOf('id="scrPaneRelStrength"'));
  const ids = [...pane.matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);
  assert.equal(ids[ids.length - 1], 'scrF39On');
  for (const id of ['scrF39FromDate', 'scrF39FromField', 'scrF39ToDate', 'scrF39ToField', 'scrF39Val']) assert.ok(pane.includes(`id="${id}"`), id);
  assert.match(pane, /Industry EW % Change:/);
  const src = read('js/screener.js');
  for (const needle of ['scrF39', '_gtChg', 'gtDateChange']) assert.ok(!src.includes(needle), needle);
  assert.ok(read('js/ui.js').includes("typeof gtInitDates === 'function'"));
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

// ─── 65 and 200 SMA ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const LONG_DATES = Array.from({ length: 220 }, (_, i) => { const d = new Date(2025, 0, 1 + i); return `${String(d.getDate()).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}-${d.getFullYear()}`; });
function longRun(opts) {
  setup(opts);
  const longBars = closes => closes.map((c, i) => ({ date: LONG_DATES[i], open: c, high: c, low: c, close: c, turnover: 10 }));
  // UP rises all 220 days (above every SMA); LATE rises for 200 days then falls 8 (below its 10 SMA, still above its 65 and 200 SMA); DOWN falls all 220 days
  sb.Store.dailyBySymbol = { UP: longBars(range(100, 1, 220)), LATE: longBars([...range(100, 1, 200), ...range(299, -2, 8)]), DOWN: longBars(range(400, -1, 220)) };
  sb.Store.latestBySymbol = { UP: stock('UP', 'UP', 'S1'), LATE: stock('LATE', 'LATE', 'S3'), DOWN: stock('DOWN', 'DOWN', 'S2') };
  sb.Store.dates = LONG_DATES.slice();
  vm.runInContext('_gtCache = {}', sb);
  sb.runScreener();
  return { passed: Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort(),
           failed: Object.fromEntries(Array.from(vm.runInContext('screenerFailed', sb), s => [s.symbol, Array.from(s._failReasons).join('|')])) };
}

test('the group map also holds the 65 and 200 SMA: NaN until the index has that many closes', () => {
  setup({});
  const short = sb.gtGroupMap('industry').UP;                          // 60 closes
  assert.deepEqual(Object.keys(short.sma).map(Number), [10, 20, 50, 65, 200]);
  assert.ok(isNaN(short.sma[65]) && isNaN(short.sma[200]));
  longRun({});
  const long = sb.gtGroupMap('industry').UP;                           // 220 closes
  assert.ok(long.sma[65] > 0 && long.sma[200] > 0 && long.close > long.sma[200]);
});

test('F38 above the 65 / 200 SMA: every ticked one must hold, the 200 is a longer test than the 65', () => {
  assert.deepEqual(longRun({ f38: { on: true, lens: [65] } }).passed, ['LATE', 'UP']);
  assert.deepEqual(longRun({ f38: { on: true, lens: [200] } }).passed, ['LATE', 'UP']);
  assert.deepEqual(longRun({ f38: { on: true, lens: [10, 200] } }).passed, ['UP']);   // LATE is below its 10 SMA
  const r = longRun({ f38: { on: true, lens: [65, 200] } });
  assert.match(r.failed.DOWN, /^F38: Industry 'DOWN' EW index [\d.]+ not above 65 SMA [\d.]+, 200 SMA [\d.]+$/);
});

test('a 65 / 200 SMA with too little history fails the group, saying n/a', () => {
  setup({ f38: { on: true, lens: [200] } });
  sb.runScreener();
  const failed = Array.from(vm.runInContext('screenerFailed', sb), s => Array.from(s._failReasons).join('|'));
  assert.equal(vm.runInContext('screenerPassed', sb).length, 0);
  assert.ok(failed.every(r => /200 SMA \(n\/a\)/.test(r)));
});

test('the 65 and 200 SMA boxes exist for both filters and are saved in presets', () => {
  for (const f of ['37', '38']) for (const len of [65, 200]) assert.ok(html.includes(`id="scrF${f}Sma${len}"`), `scrF${f}Sma${len}`);
  const dom = setup({ f38: { on: true, lens: [65, 200] } });
  const state = sb.capturePresetState();
  assert.deepEqual([state.scrF38Sma65, state.scrF38Sma200, state.scrF37Sma65, state.scrF37Sma200], [true, true, false, false]);
  sb.applyPresetState(Object.assign({}, state, { scrF38Sma65: false, scrF38Sma200: false }));
  assert.equal(dom.el('scrF38Sma65').checked, false);
});

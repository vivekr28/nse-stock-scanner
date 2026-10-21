'use strict';
// Stock Scanner popup's "Sector & Industry" tab, F34 / F35 (js/group-breadth.js): "Industry breadth" and "Sector breadth" - the % of the
// stocks in the stock's own industry / sector that are above their 20 SMA, greater than N. Breadth is the figure the Industry Analysis and
// Sector Analysis tabs show (stocks aboveSMA / ALL the stocks of the group). Covers the pure map, both filters end to end through
// runScreener() (strictly greater, columns, fail reasons, the two together), the hooks, presets, the popup's HTML and badge, and that
// screener.js holds none of it.
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

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/group-breadth.js', 'js/presets.js']);
const realUpdateFilterBadge = sb.updateFilterBadge;   // runWith() below stubs it on the sandbox

// A stock: industry, sector, whether it is above its 20 SMA
const st = (industry, sector, above) => ({ industry, sector, above });
// Industries: A 3 of 4 above (75%), B 2 of 4 (exactly 50%), C 1 of 1 (100%), D 0 of 2 (0%). Sectors: S1 = A + C (4 of 5 = 80%), S2 = B + D (2 of 6 = 33.3%)
const UNIVERSE = {
  A1: st('A', 'S1', true), A2: st('A', 'S1', true), A3: st('A', 'S1', true), A4: st('A', 'S1', false),
  B1: st('B', 'S2', true), B2: st('B', 'S2', true), B3: st('B', 'S2', false), B4: st('B', 'S2', false),
  C1: st('C', 'S1', true),
  D1: st('D', 'S2', false), D2: st('D', 'S2', false),
};

function setup(opts = {}, universe = UNIVERSE) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '',
  });
  for (const f of ['34', '35']) {
    const o = opts['f' + f] || {};
    dom.el(`scrF${f}On`).checked = !!o.on;
    dom.el(`scrF${f}Val`).value = o.val === undefined ? '50' : String(o.val);
  }
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in universe) {
    const u = universe[k];
    latest[k] = { symbol: k, isin: k, close: 100, open: 100, high: 101, low: 99, prev: 100, turnover: 10, changePct: 0,
                  industry: u.industry, sector: u.sector, aboveSMA: u.above };
    daily[k] = [];
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  return dom;
}
function run(opts, universe) {
  setup(opts, universe);
  sb.runScreener();
  const passedRows = Object.fromEntries(Array.from(vm.runInContext('screenerPassed', sb), s => [s.symbol, s]));
  const failed = Object.fromEntries(Array.from(vm.runInContext('screenerFailed', sb), s => [s.symbol, Array.from(s._failReasons).join('|')]));
  return { passed: Object.keys(passedRows).sort(), failed, passedRows };
}
const ALL = Object.keys(UNIVERSE).sort();

test('the breadth map: stocks aboveSMA over ALL the stocks of the group, the way Industry / Sector Analysis count it', () => {
  setup();
  const ind = sb.gbBreadthMap('industry');
  assert.deepEqual(JSON.parse(JSON.stringify(ind)), {
    A: { above: 3, count: 4, pct: 75 }, B: { above: 2, count: 4, pct: 50 }, C: { above: 1, count: 1, pct: 100 }, D: { above: 0, count: 2, pct: 0 },
  });
  const sec = sb.gbBreadthMap('sector');
  assert.equal(sec.S1.pct, 80);
  assert.ok(Math.abs(sec.S2.pct - 100 / 3) < 1e-9);
});

test('a stock with no history (aboveSMA undefined / false) counts in the denominator, and a missing group is "Undefined-Diversified"', () => {
  setup({}, { X1: st('X', 'S', true), X2: { industry: 'X', sector: 'S', above: undefined }, N1: { industry: '', sector: undefined, above: true } });
  const ind = sb.gbBreadthMap('industry');
  assert.deepEqual(JSON.parse(JSON.stringify(ind.X)), { above: 1, count: 2, pct: 50 });
  assert.deepEqual(JSON.parse(JSON.stringify(ind['Undefined-Diversified'])), { above: 1, count: 1, pct: 100 });
  assert.equal(sb.gbBreadthMap('sector')['Undefined-Diversified'].count, 1);
});

test('F34: industry breadth is STRICTLY greater than the number - exactly 50% does not pass "> 50"', () => {
  const r = run({ f34: { on: true, val: 50 } });
  assert.deepEqual(r.passed, ['A1', 'A2', 'A3', 'A4', 'C1']);
  assert.match(r.failed.B1, /^F34: Industry 'B' breadth 50\.0% \(2 of 4 above 20 SMA\) not > 50%$/);
  assert.match(r.failed.D1, /^F34: Industry 'D' breadth 0\.0% \(0 of 2 above 20 SMA\) not > 50%$/);
  assert.deepEqual(run({ f34: { on: true, val: 49.9 } }).passed, ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1']);
  assert.deepEqual(run({ f34: { on: true, val: 75 } }).passed, ['C1']);       // A is exactly 75%
  assert.deepEqual(run({ f34: { on: true, val: 100 } }).passed, []);           // nothing is above 100
});

test('a stock passes or fails with its whole group: the weak stock of a strong industry passes, the strong stock of a weak one fails', () => {
  const r = run({ f34: { on: true, val: 60 } });
  assert.ok(r.passed.includes('A4'));      // A4 itself is below its SMA, but its industry is 75% above
  assert.ok(!r.passed.includes('B1'));     // B1 is above its SMA, its industry is 50%
});

test('F35: sector breadth, with its own column and fail reason', () => {
  const r = run({ f35: { on: true, val: 50 } });
  assert.deepEqual(r.passed, ['A1', 'A2', 'A3', 'A4', 'C1']);                  // S1 = 80%, S2 = 33.3%
  assert.match(r.failed.B1, /^F35: Sector 'S2' breadth 33\.3% \(2 of 6 above 20 SMA\) not > 50%$/);
  assert.equal(r.passedRows.A1._gbSec, 80);
});

test('F34 and F35 together: a stock must pass both', () => {
  const r = run({ f34: { on: true, val: 60 }, f35: { on: true, val: 75 } });
  assert.deepEqual(r.passed, ['A1', 'A2', 'A3', 'A4', 'C1']);                  // A 75 > 60 and S1 80 > 75;  C 100 and S1 80
  const r2 = run({ f34: { on: true, val: 60 }, f35: { on: true, val: 85 } });
  assert.deepEqual(r2.passed, []);
  assert.match(r2.failed.A1, /F35/);
  assert.ok(!/F34/.test(r2.failed.A1));
  // a stock failing both lists both
  assert.match(run({ f34: { on: true, val: 60 }, f35: { on: true, val: 85 } }).failed.D1, /F34.*\|F35/);
});

test('off: the controls are ignored and no breadth is recorded', () => {
  const r = run({ f34: { on: false, val: 99 }, f35: { on: false, val: 99 } });
  assert.deepEqual(r.passed, ALL);
  assert.equal(r.passedRows.A1._gbInd, undefined);
});

test('a blank number means 0 (everything with any breadth passes; a group at 0% does not)', () => {
  const r = run({ f34: { on: true, val: '' } });
  assert.ok(r.passed.includes('A1') && r.passed.includes('B1'));
  assert.ok(!r.passed.includes('D1'));       // 0% is not > 0
});

test('the columns appear only while a filter is on, with the group\'s breadth (and colour against the number)', () => {
  const dom = setup({ f34: { on: true, val: 60 } });
  assert.deepEqual(Array.from(sb.gbColumns(), c => c.label), ['Ind Breadth']);
  sb.runScreener();
  const col = sb.gbColumns()[0];
  assert.equal(col.fmt(75), '75.0%');
  assert.equal(col.fmt(NaN), '-');
  assert.equal(col.cls(75), 'positive');
  assert.equal(col.cls(40), 'negative');
  dom.el('scrF35On').checked = true;
  assert.deepEqual(Array.from(sb.gbColumns(), c => c.label), ['Ind Breadth', 'Sector Breadth']);
  dom.el('scrF34On').checked = false; dom.el('scrF35On').checked = false;
  assert.deepEqual(Array.from(sb.gbColumns()), []);
});

test('hooks: gbFilterState / gbActiveCount read the controls; Reset All restores the defaults', () => {
  const dom = setup({ f34: { on: true, val: 65 } });
  const s = sb.gbFilterState();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { ind: { on: true, val: 65 }, sec: { on: false, val: 50 }, any: true });
  assert.equal(sb.gbActiveCount(), 1);
  dom.el('scrF35On').checked = true;
  assert.equal(sb.gbActiveCount(), 2);
  sb.gbReset();
  assert.equal(dom.el('scrF34On').checked, false);
  assert.equal(dom.el('scrF34Val').value, '50');
  assert.equal(dom.el('scrF35On').checked, false);
  assert.equal(dom.el('scrF35Val').value, '50');
  assert.equal(sb.gbActiveCount(), 0);
});

test('Reset All in the scanner (resetScreener) resets them too', () => {
  const dom = setup({ f34: { on: true, val: 80 }, f35: { on: true, val: 70 } });
  sb.initF16Dates = () => {};
  sb.updateFilterBadge = () => {};
  sb.renderScreenerTable = () => {};
  sb.resetScreener();
  assert.equal(dom.el('scrF34On').checked, false);
  assert.equal(dom.el('scrF34Val').value, '50');
  assert.equal(dom.el('scrF35On').checked, false);
  assert.equal(dom.el('scrF35Val').value, '50');
});

test('the badges: the tab count and the total include F34 / F35', () => {
  const dom = setup({ f34: { on: true }, f35: { on: true } });
  dom.el('scrF9On').checked = true;                    // an existing Sector & Industry filter
  sb.updateApplyBtn = () => {};
  realUpdateFilterBadge();
  assert.equal(dom.el('scrTabIndCount').textContent, 3);
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 3);
  assert.equal(dom.el('scrTabTechCount').textContent, 0);
});

test('presets: the four fields are captured and restored, and default to off / 50', () => {
  const dom = setup({ f34: { on: true, val: 72 }, f35: { on: true, val: 41 } });
  const state = JSON.parse(JSON.stringify(sb.capturePresetState()));
  assert.deepEqual([state.scrF34On, state.scrF34Val, state.scrF35On, state.scrF35Val], [true, '72', true, '41']);
  const defaults = JSON.parse(JSON.stringify(vm.runInContext('DEFAULT_FILTER_STATE', sb)));
  assert.deepEqual([defaults.scrF34On, defaults.scrF34Val, defaults.scrF35On, defaults.scrF35Val], [false, '50', false, '50']);
  sb.applyPresetState(defaults);
  assert.equal(dom.el('scrF34On').checked, false);
  sb.applyPresetState(state);
  assert.equal(dom.el('scrF34Val').value, '72');
  assert.equal(dom.el('scrF35On').checked, true);
  // a preset saved before these existed does not mention them: applying it leaves them at what the defaults set
  sb.applyPresetState(defaults);
  sb.applyPresetState({ scrF1On: true });
  assert.equal(dom.el('scrF34On').checked, false);
});

test('index.html: both rows sit on the Sector & Industry tab (two filters per row), with the script loaded after screener.js', () => {
  const pane = html.slice(html.indexOf('id="scrPaneIndustry"'), html.indexOf('id="scrPaneRelStrength"'));
  const ids = [...pane.matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['scrF11On', 'scrF36On', 'scrF37On', 'scrF38On', 'scrF35On', 'scrF34On', 'scrF13On', 'scrF14On', 'scrF9On', 'scrF12On', 'scrF17On']);
  assert.match(pane, /Industry breadth \(% of stocks above 20 SMA\):/);
  assert.match(pane, /Sector breadth \(% of stocks above 20 SMA\):/);
  assert.ok(html.indexOf('src="js/group-breadth.js') > html.indexOf('src="js/screener.js'));
});

test('guard: screener.js holds none of the feature\'s ids or logic - only typeof-guarded gb* hooks', () => {
  const src = read('js/screener.js');
  for (const needle of ['scrF34', 'scrF35', 'GB_FILTERS', '_gbInd', '_gbSec']) assert.ok(!src.includes(needle), needle);
  // the entry hooks are each behind a typeof check; the two per-scan helpers are only reached inside the `gb` it produced
  for (const name of ['gbFilterState', 'gbActiveCount', 'gbColumns', 'gbReset']) {
    assert.ok(src.includes(`typeof ${name} === 'function'`), `${name} must be typeof-guarded`);
  }
  for (const name of ['gbPrepare', 'gbApplyToStock']) {
    const lines = src.split(/\r?\n/).filter(l => l.includes(name + '('));
    assert.ok(lines.length > 0 && lines.every(l => /\bgb\b\s*&&/.test(l)), name);
  }
});

'use strict';
// Reset All and the As of Date tab's own reset are the same thing: every filter on every tab (including this one) goes
// back to its default, the preset is deselected and the results are refreshed (the as-of results disappear).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const html = fs.readFileSync(path.join(path.dirname(__dirname), 'index.html'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js', 'js/asof-scan.js']);

function setup() {
  const dom = installFakeDom(sb, { scrF17Period: '3m', scrF17Lag: '3m' });
  sb.document.querySelectorAll = () => [];
  sb.Store.dates = ['01-Jan-2025', '02-Jan-2025'];
  const calls = [];
  sb.runScreener = () => calls.push('runScreener');
  return { dom, calls };
}

test('the As of Date tab\'s button is the same as Reset All (it calls resetScreener)', () => {
  const pane = html.slice(html.indexOf('id="scrPaneAsOf"'), html.indexOf('end screenerFiltersBody'));
  assert.match(pane, /onclick="resetScreener\(\)"[^>]*>Reset All</);
  assert.ok(!/onclick="asOfReset\(\)"/.test(pane), 'the tab must not have its own separate reset');
});

test('Reset All also resets the As of Date tab: controls, date, dates and the filter count', () => {
  const { dom } = setup();
  for (const id of ['asofAOn', 'asofBOn', 'asofJOn', 'asofKOn']) dom.el(id).checked = true;
  dom.el('asofBVal').value = '9'; dom.el('asofJ5').checked = false; dom.el('asofKFromDate').value = '2025-01-01'; dom.el('asofDate').value = '2025-01-02';
  sb.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 4);

  sb.resetScreener();

  for (const id of ['asofAOn', 'asofBOn', 'asofJOn', 'asofKOn']) assert.equal(dom.el(id).checked, false);
  assert.equal(dom.el('asofBVal').value, '2');
  assert.equal(dom.el('asofJ5').checked, true);
  assert.equal(dom.el('asofKFromDate').value, '');
  assert.equal(dom.el('scrActiveFilterBadge').style.display, 'none');
  assert.equal(dom.el('scrTabAsOfCount').style.display, 'none');
});

test('Reset All deselects the preset and re-runs the normal scan, so as-of results are replaced', () => {
  const { dom, calls } = setup();
  dom.el('scrPresetSelect').value = 'AsOf-02Apr2026';
  dom.el('asofAOn').checked = true;
  vm.runInContext("screenerPassed = ['as-of result']", sb);
  sb.resetScreener();
  assert.equal(dom.el('scrPresetSelect').value, '');
  assert.deepEqual(calls, ['runScreener']);       // the same refresh Reset All always did
});

test('the other tabs\' filters are reset as before (regression)', () => {
  const { dom } = setup();
  dom.el('scrF1On').checked = true; dom.el('scrF9On').checked = true; dom.el('scrF2Len').value = '99';
  sb.resetScreener();
  assert.equal(dom.el('scrF1On').checked, false);
  assert.equal(dom.el('scrF9On').checked, false);
  assert.equal(dom.el('scrF2Len').value, '50');
});

test('without the As of Date module loaded, Reset All behaves exactly as before (regression)', () => {
  const plain = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
  const dom = installFakeDom(plain, { scrF17Period: '3m', scrF17Lag: '3m' });
  plain.document.querySelectorAll = () => [];
  plain.Store.dates = ['01-Jan-2025'];
  let ran = 0; plain.runScreener = () => { ran++; };
  dom.el('scrF3On').checked = true;
  plain.resetScreener();
  assert.equal(dom.el('scrF3On').checked, false);
  assert.equal(ran, 1);
});

// ─── end to end, with the real runScreener ──────────────────────────────────────

const mkDates = n => Array.from({ length: n }, (_, i) => { const d = new Date(2025, 0, 1 + i); return d.getDate() + '-' + ['Jan', 'Feb', 'Mar'][d.getMonth()] + '-2025'; });

function realScanSetup() {
  const real = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js', 'js/asof-scan.js']);
  const dom = installFakeDom(real, { scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m', scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '', asofHPeriod: '21' });
  real.document.querySelectorAll = () => [];
  real.renderScreenerTable = () => {}; real.updateToggleButton = () => {}; real.closeScreenerFilters = () => {};
  const dates = mkDates(60);
  const bars = (sym, f) => dates.map((d, i) => ({ symbol: sym, isin: sym, date: d, open: f(i), high: f(i), low: f(i), close: f(i), prev: f(Math.max(0, i - 1)), turnover: 1000, companyName: sym }));
  const days = { UP: bars('UP', i => 100 + i), DOWN: bars('DOWN', i => 300 - i), FLAT: bars('FLAT', () => 100) };
  const latest = {};
  for (const k in days) { const last = days[k][59]; latest[k] = { ...last, industry: 'I', sector: 'S', changePct: 0, adr: 1, high52w: last.high, distFrom52H: 0, marketCap: 1, aboveSMA: true, monthlyChangePct: 0 }; }
  real.Store.dates = dates; real.Store.latestDate = dates[59]; real.Store.dailyBySymbol = days; real.Store.latestBySymbol = latest; real.Store.sectorMap = {};
  dom.el('scrAllowPartial').checked = false;
  return { real, dom };
}

test('end to end: an as-of scan narrows the results; Reset All brings back the full, unfiltered scan and drops the as-of card', async () => {
  const { real, dom } = realScanSetup();
  dom.el('asofDate').value = '2025-02-15';
  dom.el('asofAOn').checked = true; dom.el('asofA20').checked = true;      // price above 20 SMA that day: UP only
  await real.asOfRun();
  assert.deepEqual(Array.from(vm.runInContext('screenerPassed', real), s => s.symbol), ['UP']);
  assert.match(dom.el('screenerStats').innerHTML, /As of Date/);

  real.resetScreener();                                                    // the real runScreener runs here

  const symbols = Array.from(vm.runInContext('screenerPassed', real), s => s.symbol).sort();
  assert.deepEqual(symbols, ['DOWN', 'FLAT', 'UP']);                       // nothing filtered any more
  assert.ok(!/As of Date/.test(dom.el('screenerStats').innerHTML), 'the As of Date card should be gone');
  assert.equal(dom.el('asofAOn').checked, false);
  assert.equal(real.asOfActiveCount(), 0);
});

test('end to end: Reset All also clears a ticked Technicals filter alongside the As of Date one', async () => {
  const { real, dom } = realScanSetup();
  dom.el('asofDate').value = '2025-02-15'; dom.el('asofAOn').checked = true;
  dom.el('scrF10On').checked = true; dom.el('scrF10_20sma').checked = true;
  real.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 2);
  real.resetScreener();
  assert.equal(dom.el('scrF10On').checked, false);
  assert.equal(dom.el('asofAOn').checked, false);
  assert.equal(dom.el('scrActiveFilterBadge').style.display, 'none');
});

test('the date picker is refilled with its default after Reset All (the tab is usable again straight away)', () => {
  const { dom } = setup();
  dom.el('asofDate').value = '2025-01-02';
  sb.resetScreener();
  assert.notEqual(dom.el('asofDate').value, '');                           // asOfInitDate() put the default back
});

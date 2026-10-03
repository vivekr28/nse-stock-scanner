'use strict';
// The As of Date tab's hand-off to the main Stock Scanner window, its guard rails, and its tab / date-picker / reset
// controls (js/asof-scan.js). The per-filter maths is in asof-scan.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/asof-scan.js']);
let closed = 0, rendered = 0;
const stubUi = () => { closed = 0; rendered = 0; sb.closeScreenerFilters = () => { closed++; }; sb.renderScreenerTable = () => { rendered++; }; sb.updateToggleButton = () => {}; };

const dateOf = i => { const d = new Date(2025, 0, 1 + i); return d.getDate() + '-' + ['Jan', 'Feb', 'Mar'][d.getMonth()] + '-2025'; };
const N = 70;
const dates = Array.from({ length: N }, (_, i) => dateOf(i));
const flat = (symbol, turn = 1000, closes) => Array.from({ length: N }, (_, i) => {
  const c = closes ? closes[i] : 100;
  return { symbol, date: dates[i], open: c, high: c, low: c, close: c, prev: c, turnover: turn, companyName: symbol };
});
const passedSymbols = () => Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol);

function setup(values, stocks) {
  stubUi();
  const dom = installFakeDom(sb, { asofHPeriod: '21', ...values });
  sb.Store.dates = dates; sb.Store.sectorMap = {}; sb.Store.dailyBySymbol = stocks || {};
  return dom;
}

test('results land in the main window: the screener result lists, stats row, and the popup closes', () => {
  const dom = setup({ asofDate: '2025-01-21' }, { DOWN: flat('DOWN', 1000, Array.from({ length: N }, (_, i) => 200 - i)), UP: flat('UP', 1000, Array.from({ length: N }, (_, i) => 100 + i)) });
  sb.asOfRun();
  assert.deepEqual(passedSymbols().sort(), ['DOWN', 'UP']);
  assert.equal(vm.runInContext('screenerFailed', sb).length, 0);
  assert.equal(vm.runInContext('scrShowingFailed', sb), false);
  assert.equal(vm.runInContext('screenerResults', sb).length, 2);
  assert.equal(vm.runInContext('screenerPage', sb), 0);
  assert.equal(rendered, 1);
  assert.equal(closed, 1);
  const stats = dom.el('screenerStats').innerHTML;
  assert.match(stats, /As of Date/);
  assert.match(stats, /21-Jan-2025/);
  assert.match(stats, /Traded That Day/);
});

test('each result row has what the main results table, CSV and TV watchlist read', () => {
  setup({ asofDate: '2025-01-21' }, { A: flat('A') });
  sb.Store.sectorMap = { a: { sector: 'Sec', industry: 'Ind', marketCap: 7 } };
  sb.asOfRun();
  const row = vm.runInContext('screenerPassed', sb)[0];
  for (const k of ['isin', 'symbol', 'sector', 'industry', 'close', 'changePct', 'turnover', 'adr', 'high52w', 'distFrom52H', 'marketCap', 'bandPct']) {
    assert.ok(k in row, 'row is missing ' + k);
  }
  assert.equal(row.sector, 'Sec');
  assert.equal(row.industry, 'Ind');
  assert.equal(row.marketCap, 7);
});

test('a stock with no sector info gets the same "Undefined-Diversified" label the dashboard uses', () => {
  setup({ asofDate: '2025-01-21' }, { A: flat('A') });
  sb.asOfRun();
  const row = vm.runInContext('screenerPassed', sb)[0];
  assert.equal(row.sector, 'Undefined-Diversified');
  assert.equal(row.industry, 'Undefined-Diversified');
});

test('the TV watchlist button works on the As of Date result (grouped by industry, NSE: prefix)', () => {
  const dom = setup({ asofDate: '2025-01-21' }, { AAA: flat('AAA'), BBB: flat('BBB') });
  sb.Store.sectorMap = { aaa: { sector: 'S', industry: 'Ind1', marketCap: 1 }, bbb: { sector: 'S', industry: 'Ind1', marketCap: 1 } };
  sb.asOfRun();
  sb.exportTradingViewWatchlist();
  const text = dom.el('tvModalContent').textContent;
  assert.match(text, /###Ind1\(2\)/);
  assert.match(text, /NSE:AAA/);
  assert.match(text, /NSE:BBB/);
});

test('results are sorted by turnover, highest first', () => {
  setup({ asofDate: '2025-01-21' }, { LOW: flat('LOW', 10), HIGH: flat('HIGH', 9000), MID: flat('MID', 500) });
  sb.asOfRun();
  assert.deepEqual(passedSymbols(), ['HIGH', 'MID', 'LOW']);
});

test('a stock with no bar on the chosen day is not scanned', () => {
  setup({ asofDate: '2025-01-21' }, { GONE: flat('GONE').filter((_, i) => i !== 20), HERE: flat('HERE') });
  sb.asOfRun();
  assert.deepEqual(passedSymbols(), ['HERE']);
});

test('a non-trading date uses the nearest earlier trading day', () => {
  const dom = setup({ asofDate: '2025-01-21' }, { A: flat('A').filter((_, i) => i !== 20) });
  sb.Store.dates = dates.filter((_, i) => i !== 20);                    // 21-Jan is not a trading day
  sb.asOfRun();
  assert.match(dom.el('screenerStats').innerHTML, /20-Jan-2025/);
});

test('no date, or a date before the data starts: it says so and leaves the existing results alone', () => {
  const dom = setup({ asofDate: '' });
  vm.runInContext("screenerPassed = ['keep']", sb);
  sb.asOfRun();
  assert.match(dom.el('asofStatus').textContent, /Pick a date/);
  assert.deepEqual(Array.from(vm.runInContext('screenerPassed', sb)), ['keep']);
  dom.el('asofDate').value = '2020-01-01';
  sb.asOfRun();
  assert.match(dom.el('asofStatus').textContent, /Pick a date/);
  assert.equal(rendered, 0);
});

test('% Change ticked without a From date stops with a message and changes nothing', () => {
  const dom = setup({ asofDate: '2025-01-21' });
  dom.el('asofKOn').checked = true;
  vm.runInContext("screenerPassed = ['keep']", sb);
  sb.asOfRun();
  assert.match(dom.el('asofStatus').textContent, /From date/);
  assert.deepEqual(Array.from(vm.runInContext('screenerPassed', sb)), ['keep']);
});

test('Exclude Circuits: if the band history cannot be loaded it says so and changes nothing', async () => {
  const dom = setup({ asofDate: '2025-01-21' }, { A: flat('A') });
  dom.el('asofJOn').checked = true;
  vm.runInContext("_asofBandHistory = null; screenerPassed = ['keep']", sb);
  sb.fetch = async () => { throw new Error('offline'); };
  await sb.asOfRun();
  assert.match(dom.el('asofStatus').textContent, /price band history/);
  assert.deepEqual(Array.from(vm.runInContext('screenerPassed', sb)), ['keep']);
  sb.fetch = async () => ({ ok: false });
  await sb.asOfRun();
  assert.match(dom.el('asofStatus').textContent, /price band history/);
});

test('Exclude Circuits: the band history is fetched once, and only when the filter is ticked', async () => {
  let calls = 0;
  sb.fetch = async () => { calls++; return { ok: true, json: async () => ({ bySymbol: {} }) }; };
  vm.runInContext('_asofBandHistory = null', sb);
  const dom = setup({ asofDate: '2025-01-21' }, { A: flat('A') });
  await sb.asOfRun();
  assert.equal(calls, 0);
  dom.el('asofJOn').checked = true;
  await sb.asOfRun(); await sb.asOfRun();
  assert.equal(calls, 1);
});

test('Exclude Circuits: the table shows the band that applied on the chosen day', async () => {
  vm.runInContext('_asofBandHistory = null', sb);
  sb.fetch = async () => ({ ok: true, json: async () => ({ bySymbol: { a: [['2025-01-01', '5'], ['2025-01-30', '20']], b: [['2025-01-01', '20']] } }) });
  const dom = setup({ asofDate: '2025-01-21' }, { A: flat('A'), B: flat('B') });
  dom.el('asofJOn').checked = true; dom.el('asofJ5').checked = false;      // 5% not excluded here, so A stays and shows its band
  await sb.asOfRun();
  const byName = Object.fromEntries(Array.from(vm.runInContext('screenerPassed', sb), s => [s.symbol, s.bandPct]));
  assert.deepEqual(byName, { A: '5%', B: '20%' });
});

test('the scan only reads Store: nothing in it is changed', () => {
  const dom = setup({ asofDate: '2025-01-21' }, { A: flat('A', 1000, Array.from({ length: N }, (_, i) => 100 + i)) });
  dom.el('asofAOn').checked = true; dom.el('asofIOn').checked = true; dom.el('asofFOn').checked = true;
  sb.Store.sectorMap = { a: { sector: 'S', industry: 'I', marketCap: 5 } };
  sb.Store.latestBySymbol = { A: { symbol: 'A', close: 1 } };
  const before = JSON.stringify(sb.Store);
  sb.asOfRun();
  assert.equal(JSON.stringify(sb.Store), before);
});

test('tab show / hide: the new pane replaces the others and hides the Apply footer; leaving restores them', () => {
  const dom = setup({});
  const footer = { style: {} };
  sb.document.querySelector = sel => (sel.includes('scr-modal-footer') ? footer : null);
  ['scrPaneTechnicals', 'scrPaneIndustry', 'scrPaneMulti'].forEach(id => { dom.el(id).style.display = ''; });
  sb.asOfShowTab();
  ['scrPaneTechnicals', 'scrPaneIndustry', 'scrPaneMulti'].forEach(id => assert.equal(dom.el(id).style.display, 'none'));
  assert.equal(dom.el('scrPaneAsOf').style.display, '');
  assert.equal(footer.style.display, 'none');
  sb.asOfHideTab();
  assert.equal(dom.el('scrPaneAsOf').style.display, 'none');
  assert.equal(footer.style.display, '');
  sb.document.querySelector = () => null;
});

test('the date picker is limited to the loaded data and defaults to about a month back', () => {
  const dom = setup({});
  sb.asOfInitDate();
  assert.equal(dom.el('asofDate').min, '2025-01-01');
  assert.equal(dom.el('asofDate').max, '2025-03-11');
  assert.equal(dom.el('asofDate').value, '2025-02-18');       // 21 trading days before the last
});

test('Reset puts every As of Date control back to its default and clears the date', () => {
  const dom = setup({});
  for (const id of ['asofAOn', 'asofBOn', 'asofJOn', 'asofKOn']) dom.el(id).checked = true;
  dom.el('asofBVal').value = '9'; dom.el('asofKVal').value = '50'; dom.el('asofJ2').checked = false;
  dom.el('asofDate').value = '2025-01-05';
  sb.asOfReset();
  for (const id of ['asofAOn', 'asofBOn', 'asofJOn', 'asofKOn']) assert.equal(dom.el(id).checked, false);
  assert.equal(dom.el('asofBVal').value, '2');
  assert.equal(dom.el('asofKVal').value, '0');
  assert.equal(dom.el('asofJ2').checked, true);
  assert.equal(dom.el('asofDate').value, '2025-02-18');
});

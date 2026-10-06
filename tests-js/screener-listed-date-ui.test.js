'use strict';
// The Listed Date filter (F19) around the scanner: its "Listed On" results column, Reset All, the filter-count badge, that
// processData() carries each stock's listing date from the sector map, and that every place that reads the sector-mapping CSV
// (cache.js, file-loader.js, nse-download.js) keeps the date. The filter's own pass/fail logic is in screener-listed-date.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const ROOT = path.join(__dirname, '..');

// ─── the results table ──────────────────────────────────────────────────────────

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
const realUpdateFilterBadge = sb.updateFilterBadge;   // later tests stub the global; this one needs the real thing

function header({ on, date }) {
  const dom = installFakeDom(sb, { scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '' });
  dom.el('scrF19On').checked = on;
  dom.el('scrF19Date').value = date;
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const bar = { date: 'D0', symbol: 'NEWCO', open: 10, high: 10, low: 10, close: 10, prev: 10, turnover: 10 };
  sb.Store.latestBySymbol = { NEWCO: { ...bar, isin: 'NEWCO', changePct: 0, industry: 'X', sector: 'Y', listingDate: '2026-10-05' } };
  sb.Store.dailyBySymbol = { NEWCO: [bar] };
  sb.runScreener();
  return { head: dom.el('screenerHead').innerHTML, body: dom.el('screenerBody') ? dom.el('screenerBody').innerHTML : '' };
}

test('the "Listed On" column shows only while the filter is on with a date, and lists the stock\'s listing date', () => {
  const on = header({ on: true, date: '2026-10-01' });
  assert.match(on.head, /Listed On/);
  assert.match(on.body, /2026-10-05/);
  assert.doesNotMatch(header({ on: false, date: '2026-10-01' }).head, /Listed On/);
  assert.doesNotMatch(header({ on: true, date: '' }).head, /Listed On/);
});

// ─── Reset All / badge ──────────────────────────────────────────────────────────

test('Reset All switches the filter off and clears its date', () => {
  const dom = installFakeDom(sb, { scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m', scrF12Period: '6m' });
  sb.runScreener = () => {};
  sb.updateFilterBadge = () => {};
  sb.initF16Dates = () => {};
  dom.el('scrF19On').checked = true;
  dom.el('scrF19Date').value = '2026-10-01';
  sb.resetScreener();
  assert.equal(dom.el('scrF19On').checked, false);
  assert.equal(dom.el('scrF19Date').value, '');
});

test('the Technicals tab badge counts the Listed Date filter', () => {
  const dom = installFakeDom(sb, {});
  sb.updateApplyBtn = () => {};
  const badge = () => dom.el('scrTabTechCount').textContent;
  realUpdateFilterBadge();
  assert.equal(badge(), 0);
  dom.el('scrF19On').checked = true;
  realUpdateFilterBadge();
  assert.equal(badge(), 1);
  dom.el('scrF1On').checked = true;
  realUpdateFilterBadge();
  assert.equal(badge(), 2);
});

// ─── processData() ──────────────────────────────────────────────────────────────

test('processData: each stock gets its listing date from the sector map; one not in the map gets a blank', () => {
  const dp = loadScripts(['js/utils.js', 'js/data-processor.js']);
  dp.populateFilters = () => {};
  dp.showDashboard = () => {};
  const { Store } = dp;
  Object.assign(Store, { dailyBySymbol: {}, latestBySymbol: {}, bandBySymbol: {}, symbolToISIN: {}, staleStocks: [], excludedEtfs: [] });
  Store.loaded = { bhav: true, band: false, sector: true };
  Store.sectorMap = { aaa: { sector: 'Chemicals', industry: 'Dyes', marketCap: 0, listingDate: '2008-10-06' } };
  const row = (symbol, isin) => ({
    SYMBOL: symbol, SERIES: 'EQ', DATE1: '1-Jan-2025', OPEN_PRICE: 10, HIGH_PRICE: 11, LOW_PRICE: 9, CLOSE_PRICE: 10,
    LAST_PRICE: 10, PREV_CLOSE: 10, TTL_TRD_QNTY: 1000, TURNOVER_LACS: 100, NO_OF_TRADES: 10, ISIN: isin, COMPANY_NAME: '',
  });
  Store.bhavData = [row('AAA', 'INE000A01011'), row('BBB', 'INE000B01011')];
  dp.processData();
  assert.equal(Store.latestBySymbol.INE000A01011.listingDate, '2008-10-06');
  assert.equal(Store.latestBySymbol.INE000B01011.listingDate, '');
});

// ─── every sector-mapping reader keeps the date ─────────────────────────────────

test('every place that parses the sector-mapping CSV keeps the Listing Date (a loader that drops it would silently break the filter)', () => {
  const sites = { 'js/cache.js': 1, 'js/file-loader.js': 2, 'js/nse-download.js': 1 };
  for (const [file, expected] of Object.entries(sites)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const parsers = src.match(/Store\.sectorMap\[normalizeSymbol\(sym\)\] = \{/g) || [];
    const keepers = src.match(/listingDate: listingDateToIso\(r\['Listing Date'\]\)/g) || [];
    assert.equal(parsers.length, expected, `${file}: expected ${expected} sector-map parser(s)`);
    assert.equal(keepers.length, parsers.length, `${file}: every sector-map parser must carry listingDate`);
  }
});

'use strict';
// The Stock Scanner (screener) "Listed Date" filter, F19: pass stocks listed on or after the chosen date. Covers the listing-date
// conversion, the filter end to end through runScreener() (boundary day, unknown listing date, blank date, filter off), the
// "Listed On" column, that the sector-mapping loaders carry the date, and that it is saved in / restored from presets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
const { listingDateToIso, capturePresetState, applyPresetState } = sb;

test('listingDateToIso: NSE DD-MON-YYYY becomes an ISO date; ISO passes through; anything else is blank', () => {
  assert.equal(listingDateToIso('06-OCT-2008'), '2008-10-06');
  assert.equal(listingDateToIso('1-jan-1995'), '1995-01-01');
  assert.equal(listingDateToIso(' 31-Dec-2025 '), '2025-12-31');
  assert.equal(listingDateToIso('2026-09-01'), '2026-09-01');
  for (const bad of ['', undefined, null, '-', '31-XXX-2025', '06/10/2008']) assert.equal(listingDateToIso(bad), '');
});

function runWith(on, date, listed) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '',
  });
  dom.el('scrF19On').checked = on;
  dom.el('scrF19Date').value = date;
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in listed) {
    const bar = { date: 'D0', symbol: k, open: 10, high: 10, low: 10, close: 10, prev: 10, turnover: 10 };
    latest[k] = { ...bar, isin: k, changePct: 0, industry: 'X', sector: 'Y', listingDate: listed[k] };
    daily[k] = [bar];
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.runScreener();
  const passed = Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort();
  const failed = Object.fromEntries(Array.from(vm.runInContext('screenerFailed', sb), s => [s.symbol, Array.from(s._failReasons).join('|')]));
  return { passed, failed };
}

const LISTED = { OLD: '2008-10-06', ON: '2025-01-15', AFTER: '2025-06-30', UNKNOWN: '' };

test('F19: stocks listed on the date or later pass; earlier listings fail with a reason', () => {
  const r = runWith(true, '2025-01-15', LISTED);
  assert.deepEqual(r.passed, ['AFTER', 'ON']);              // the chosen day itself is included
  assert.match(r.failed.OLD, /F19: Listed 2008-10-06 before 2025-01-15/);
});

test('F19: a stock with no listing date on record fails rather than slipping through', () => {
  const r = runWith(true, '2025-01-15', LISTED);
  assert.match(r.failed.UNKNOWN, /F19: No listing date/);
});

test('F19: a date one day later drops the stock listed on the previous day', () => {
  assert.deepEqual(runWith(true, '2025-01-16', LISTED).passed, ['AFTER']);
  assert.deepEqual(runWith(true, '2025-01-14', LISTED).passed, ['AFTER', 'ON']);
});

test('F19: switched on with a blank date restricts nothing; switched off ignores the date', () => {
  assert.deepEqual(runWith(true, '', LISTED).passed, ['AFTER', 'OLD', 'ON', 'UNKNOWN']);
  assert.deepEqual(runWith(false, '2025-01-15', LISTED).passed, ['AFTER', 'OLD', 'ON', 'UNKNOWN']);
});

test('presets: F19 on/date are captured and restored; "— Select preset —" clears them; older presets leave it off', () => {
  const els = { scrF19On: { checked: true }, scrF19Date: { value: '2025-01-15' }, scrF17Period: { value: '3m' }, scrF17Lag: { value: '3m', options: [] } };
  sb.document.getElementById = id => els[id];
  const state = capturePresetState();
  assert.equal(state.scrF19On, true);
  assert.equal(state.scrF19Date, '2025-01-15');

  applyPresetState(vm.runInContext('DEFAULT_FILTER_STATE', sb));
  assert.deepEqual([els.scrF19On.checked, els.scrF19Date.value], [false, '']);
  applyPresetState(state);
  assert.deepEqual([els.scrF19On.checked, els.scrF19Date.value], [true, '2025-01-15']);
  applyPresetState(vm.runInContext('DEFAULT_FILTER_STATE', sb));
  applyPresetState({ scrF1On: true });                       // a preset saved before F19 existed
  assert.deepEqual([els.scrF19On.checked, els.scrF19Date.value], [false, '']);
});

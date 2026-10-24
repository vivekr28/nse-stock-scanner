'use strict';
// The Quarterly Results tab's "Stocks with <newest quarter> results" filter, F40 (js/quarterly-results.js). Off, every Quarterly Results filter
// judges a stock on its OWN latest declared quarter, whichever that is. On, only a stock that has declared the NEWEST quarter any company has
// declared (Store.quarterly.latestQuarter) can pass; a stock whose latest result is an older quarter is left out with a reason naming both.
// Covers the rule and its reasons, how it combines with the other filters, the hooks (state, count, columns, reset), the quarter name in the
// label, presets and the page wiring. The other filters' own tests are in quarterly-results.test.js and quarterly-qoq.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/presets.js']);
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');
const reasons = (...a) => Array.from(sb.qrLatestReasons(...a));

const LATEST = '2026-09-30';
const rec = o => Object.assign({ q: LATEST, b: 'C', cmp: 'ok', s: 130, sp: 100, e: 15, ep: 10, sg: 30, eg: 50, st: false, et: false }, o);
function withData(bySymbol, latestQuarter = LATEST) {
  sb.Store.quarterly = { bySymbol, latestQuarter };
  sb.Store.quarterlyState = 'ready';
}
const ON = { on: true }, OFF = { on: false };

// ── the rule ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a stock that has declared the newest quarter passes; one whose own latest result is an older quarter is left out, naming both quarters', () => {
  withData({ now: rec({}), old: rec({ q: '2026-06-30' }) });
  assert.deepEqual(reasons('NOW', ON), []);
  assert.deepEqual(reasons('OLD', ON), ['F40: No Sep-2026 result yet (its latest is Jun-2026)']);
});

test('off (or no state at all) checks nothing, even for an older-quarter stock or a stock with no results', () => {
  withData({ old: rec({ q: '2026-06-30' }) });
  assert.deepEqual(reasons('OLD', OFF), []);
  assert.deepEqual(reasons('OLD', undefined), []);
  assert.deepEqual(reasons('NOBODY', OFF), []);
});

test('no results for the stock, no results file, results still loading: each fails with the usual reason', () => {
  withData({ now: rec({}) });
  assert.deepEqual(reasons('NOBODY', ON), ['F40: No quarterly results for this stock']);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(reasons('NOW', ON)[0], /^F40: No quarterly results file/);
  sb.Store.quarterlyState = 'loading';
  assert.deepEqual(reasons('NOW', ON), ['F40: Quarterly results still loading']);
});

test('the newest quarter follows the data: when a later quarter arrives, a stock that was current is now behind', () => {
  withData({ a: rec({}) }, '2026-12-31');
  assert.deepEqual(reasons('A', ON), ['F40: No Dec-2026 result yet (its latest is Sep-2026)']);
});

// ── combined with the other filters ───────────────────────────────────────────────────────────────────────────────────────

test('with F40 on, an older-quarter stock that would pass F20 and F28 fails on F40 alone; with it off it passes on its own latest quarter', () => {
  withData({ old: rec({ q: '2026-06-30', eg: 80, yy: [90, 10, 40, 5] }), now: rec({ eg: 80, yy: [90, 10, 40, 5] }) });
  const dom = installFakeDom(sb, { scrF20Val: '20', scrF28Val: '0' });
  dom.el('scrF20On').checked = true; dom.el('scrF28On').checked = true;
  assert.equal(Array.from(sb.qrApplyToStock({ symbol: 'OLD' }, sb.qrFilterState())).length, 0);
  dom.el('scrF40On').checked = true;
  assert.deepEqual(Array.from(sb.qrApplyToStock({ symbol: 'OLD' }, sb.qrFilterState())), ['F40: No Sep-2026 result yet (its latest is Jun-2026)']);
  assert.deepEqual(Array.from(sb.qrApplyToStock({ symbol: 'NOW' }, sb.qrFilterState())), []);
});

// ── the hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('qrFilterState carries F40, and any is true when only it is on', () => {
  const dom = installFakeDom(sb, {});
  assert.equal(sb.qrFilterState().any, false);
  dom.el('scrF40On').checked = true;
  const s = JSON.parse(JSON.stringify(sb.qrFilterState()));
  assert.deepEqual(s.f40, { on: true });
  assert.equal(s.any, true);
});

test('the tab counts F40 in its badge and the active count; on its own it adds no column but the quarter used', () => {
  const dom = installFakeDom(sb, {});
  withData({ now: rec({}) });
  dom.el('scrF40On').checked = true;
  assert.equal(sb.qrActiveCount(), 1);
  dom.el('scrF21On').checked = true;
  assert.equal(sb.qrActiveCount(), 2);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 2);
  dom.el('scrF21On').checked = false;
  assert.deepEqual(Array.from(sb.qrColumns(), c => c.label), ['Result Qtr']);
});

test('qrReset switches F40 off', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF40On').checked = true;
  sb.qrReset();
  assert.equal(dom.el('scrF40On').checked, false);
});

// ── the quarter name in the label ─────────────────────────────────────────────────────────────────────────────────────────

test('the label names the newest quarter on file; blank until the data has loaded; the status update refreshes it', () => {
  const dom = installFakeDom(sb, {});
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'loading';
  sb.qrUpdateStatus();
  assert.equal(dom.el('scrF40Q').textContent, '');
  withData({ now: rec({}) }, '2026-12-31');
  sb.qrUpdateStatus();
  assert.equal(dom.el('scrF40Q').textContent, '(Dec-2026)');
  withData({ now: rec({}) });
  sb.qrUpdateLatestLabels();
  assert.equal(dom.el('scrF40Q').textContent, '(Sep-2026)');
});

// ── presets and the page ──────────────────────────────────────────────────────────────────────────────────────────────────

test('presets: the F40 switch is captured and restored, and "— Select preset —" resets it; the removed latest-quarter rows are gone', () => {
  const ids = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => f.id);
  const def = vm.runInContext('DEFAULT_FILTER_STATE', sb);
  assert.ok(ids.includes('scrF40On')); assert.equal(def.scrF40On, false);
  for (const n of [26, 27, 30, 31]) { assert.ok(!ids.includes(`scrF${n}On`) && !ids.includes(`scrF${n}Val`), `F${n} is no longer a preset field`); assert.ok(!(`scrF${n}On` in def)); }
});

test('index.html: the F40 row is at the top of the Quarterly Results pane, above both columns, with the quarter-name span; F26 / F27 / F30 / F31 are gone; the script version is bumped', () => {
  const html = read('index.html');
  const pane = html.indexOf('id="scrPaneQuarterly"'), multi = html.indexOf('id="scrPaneMulti"');
  const at = html.indexOf('id="scrF40On"');
  assert.ok(at > pane && at < multi && at < html.indexOf('<div class="scr-qtr-col">', pane));
  assert.match(html, /Stocks with <span id="scrF40Q"><\/span> results/);
  for (const n of [26, 27, 30, 31]) assert.ok(!html.includes(`id="scrF${n}On"`), `scrF${n}On is gone`);
  assert.match(html, /quarterly-results\.js\?v=1[2-9]/);
});

test('screener.js still holds none of the Quarterly Results filters (no F2x / F3x / F40 ids)', () => {
  assert.ok(!/scrF2[0-9]|scrF3[0-3]|scrF40/.test(read('js/screener.js')));
});

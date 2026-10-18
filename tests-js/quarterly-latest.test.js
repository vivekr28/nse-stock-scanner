'use strict';
// The Quarterly Results tab's two "latest quarter" filters (js/quarterly-results.js): F26 "Latest Quarter (<Q>) QoQ Y Earnings > X%" and
// F27 "... QoQ Y Sales > X%". They are F20 / F21 with one more condition: the stock must have declared the NEWEST quarter any company has
// declared (Store.quarterly.latestQuarter), so a stock whose own latest result is an older quarter is left out, where F20 / F21 would use
// that older quarter. Covers the pass/fail rule and its reasons, the hooks (state, count, columns, reset), the quarter name in the labels,
// presets, and the page wiring. The older filters' own tests are in quarterly-results.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/presets.js']);
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');
const reasons = (...a) => Array.from(sb.qrFailReasons(...a));

const LATEST = '2026-09-30';
const rec = o => Object.assign({ q: LATEST, b: 'C', cmp: 'ok', s: 130, sp: 100, e: 15, ep: 10, sg: 30, eg: 50, st: false, et: false }, o);
function withData(bySymbol, latestQuarter = LATEST) {
  sb.Store.quarterly = { bySymbol, latestQuarter };
  sb.Store.quarterlyState = 'ready';
}
const ON = (min) => ({ on: true, min }), OFF = { on: false, min: 0 }, NO = { on: false };

// ── the rule ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('F26: a stock that has declared the newest quarter passes when its earnings growth is strictly above the threshold', () => {
  withData({ now: rec({ eg: 50 }) });
  assert.deepEqual(reasons('NOW', OFF, OFF, NO, NO, ON(20), OFF), []);
  assert.deepEqual(reasons('NOW', OFF, OFF, NO, NO, ON(49.9), OFF), []);
  assert.match(reasons('NOW', OFF, OFF, NO, NO, ON(50), OFF)[0], /^F26: Earnings Sep-2026 \+50\.0% YoY, not > 50%$/);   // equal is not "greater than"
});

test('F26: a stock whose own latest result is an OLDER quarter is left out, with a reason naming both quarters', () => {
  withData({ old: rec({ q: '2026-06-30', eg: 80 }), now: rec({ eg: 80 }) });
  assert.deepEqual(reasons('OLD', OFF, OFF, NO, NO, ON(20), OFF), ['F26: No Sep-2026 result yet (its latest is Jun-2026)']);
  assert.deepEqual(reasons('NOW', OFF, OFF, NO, NO, ON(20), OFF), []);
});

test('F20 is unchanged: it still uses each stock\'s own latest quarter, so the same older stock passes F20 and fails F26', () => {
  withData({ old: rec({ q: '2026-06-30', eg: 80 }) });
  assert.deepEqual(reasons('OLD', ON(20), OFF, NO, NO, OFF, OFF), []);
  assert.equal(reasons('OLD', ON(20), OFF, NO, NO, ON(20), OFF).length, 1);   // F20 passes, F26 fails: one reason
  assert.match(reasons('OLD', ON(20), OFF, NO, NO, ON(20), OFF)[0], /^F26:/);
});

test('F27: the same rule for sales growth, reported under F27', () => {
  withData({ old: rec({ q: '2026-06-30', sg: 40 }), now: rec({ sg: 5 }), good: rec({ sg: 40 }) });
  assert.deepEqual(reasons('GOOD', OFF, OFF, NO, NO, OFF, ON(10)), []);
  assert.match(reasons('NOW', OFF, OFF, NO, NO, OFF, ON(10))[0], /^F27: Sales Sep-2026 \+5\.0% YoY, not > 10%$/);
  assert.deepEqual(reasons('OLD', OFF, OFF, NO, NO, OFF, ON(10)), ['F27: No Sep-2026 result yet (its latest is Jun-2026)']);
});

test('F26 / F27 together: both must pass, each failure is listed under its own code', () => {
  withData({ a: rec({ eg: 50, sg: 5 }), old: rec({ q: '2026-03-31', eg: 50, sg: 50 }) });
  assert.deepEqual(reasons('A', OFF, OFF, NO, NO, ON(20), ON(10)).map(r => r.slice(0, 3)), ['F27']);
  assert.deepEqual(reasons('OLD', OFF, OFF, NO, NO, ON(20), ON(10)).map(r => r.slice(0, 3)), ['F26', 'F27']);
});

test('F26: the usual "cannot compare" reasons still apply to a stock that did declare the latest quarter', () => {
  withData({ np: rec({ cmp: 'no-prev', eg: null }), loss: rec({ eg: null, e: 8, ep: -5, et: true }), basis: rec({ cmp: 'basis', eg: null }) });
  assert.match(reasons('NP', OFF, OFF, NO, NO, ON(20), OFF)[0], /^F26: No Sep-2026 result from the year before/);
  assert.match(reasons('LOSS', OFF, OFF, NO, NO, ON(20), OFF)[0], /^F26: .*turnaround - no % growth/);
  assert.match(reasons('BASIS', OFF, OFF, NO, NO, ON(20), OFF)[0], /^F26: .*different bases/);
});

test('F26 / F27: a stock with no results at all, or results not loaded yet, fails with the usual reasons; off = no check', () => {
  withData({ now: rec({}) });
  assert.match(reasons('NOBODY', OFF, OFF, NO, NO, ON(20), OFF)[0], /^F26: No quarterly results for this stock$/);
  assert.deepEqual(reasons('NOBODY', OFF, OFF, NO, NO, OFF, OFF), []);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(reasons('NOW', OFF, OFF, NO, NO, ON(20), OFF)[0], /^F26: No quarterly results file/);
  sb.Store.quarterlyState = 'loading';
  assert.match(reasons('NOW', OFF, OFF, NO, NO, OFF, ON(10))[0], /^F27: Quarterly results still loading/);
});

test('a stock compared on the other basis says so in the F26 reason too', () => {
  withData({ s: rec({ ab: 'S', eg: 5 }) });
  assert.equal(reasons('S', OFF, OFF, NO, NO, ON(20), OFF)[0], 'F26: Earnings Sep-2026 +5.0% YoY, not > 20% (compared on Standalone results)');
});

// ── the hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('qrFilterState carries F26 / F27; any is true when only they are on; qrApplyToStock applies them', () => {
  const dom = installFakeDom(sb, { scrF26Val: '25', scrF27Val: 'abc' });
  assert.equal(sb.qrFilterState().any, false);
  dom.el('scrF26On').checked = true;
  const s = JSON.parse(JSON.stringify(sb.qrFilterState()));
  assert.deepEqual(s.f26, { on: true, min: 25 });
  assert.deepEqual(s.f27, { on: false, min: 0 });                // a blank / invalid threshold counts as 0
  assert.equal(s.any, true);
  withData({ old: rec({ q: '2026-06-30', eg: 99 }), now: rec({ eg: 99 }) });
  assert.equal(Array.from(sb.qrApplyToStock({ symbol: 'OLD' }, sb.qrFilterState())).length, 1);
  assert.equal(Array.from(sb.qrApplyToStock({ symbol: 'NOW' }, sb.qrFilterState())).length, 0);
});

test('the tab counts F26 / F27 in its badge and the active count', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF26On').checked = true;
  assert.equal(sb.qrActiveCount(), 1);
  dom.el('scrF27On').checked = true; dom.el('scrF21On').checked = true;
  assert.equal(sb.qrActiveCount(), 3);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 3);
});

test('the table gets ONE earnings column and ONE sales column however many of F20/F26 and F21/F27 are on', () => {
  const dom = installFakeDom(sb, {});
  withData({ now: rec({}) });
  const labels = () => Array.from(sb.qrColumns(), c => c.label);
  dom.el('scrF26On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'Earnings YoY%']);
  dom.el('scrF20On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'Earnings YoY%']);               // not twice
  dom.el('scrF27On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'Earnings YoY%', 'Sales YoY%']);
  dom.el('scrF21On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'Earnings YoY%', 'Sales YoY%']);
});

test('qrReset puts F26 / F27 back to their defaults (20 and 10)', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF26On').checked = true; dom.el('scrF27On').checked = true;
  dom.el('scrF26Val').value = '99'; dom.el('scrF27Val').value = '77';
  sb.qrReset();
  assert.equal(dom.el('scrF26On').checked, false); assert.equal(dom.el('scrF27On').checked, false);
  assert.equal(dom.el('scrF26Val').value, '20'); assert.equal(dom.el('scrF27Val').value, '10');
});

// ── the quarter name in the labels ────────────────────────────────────────────────────────────────────────────────────────

test('the labels name the newest quarter on file; blank until the data has loaded; the status update refreshes them', () => {
  const dom = installFakeDom(sb, {});
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'loading';
  sb.qrUpdateStatus();
  assert.equal(dom.el('scrF26Q').textContent, ''); assert.equal(dom.el('scrF27Q').textContent, '');
  withData({ now: rec({}) }, '2026-12-31');
  sb.qrUpdateStatus();
  assert.equal(dom.el('scrF26Q').textContent, '(Dec-2026)'); assert.equal(dom.el('scrF27Q').textContent, '(Dec-2026)');
  withData({ now: rec({}) });
  sb.qrUpdateLatestLabels();
  assert.equal(dom.el('scrF26Q').textContent, '(Sep-2026)');
});

// ── presets and the page ──────────────────────────────────────────────────────────────────────────────────────────────────

test('presets: the four F26 / F27 controls are captured and restored, and "— Select preset —" resets them', () => {
  const ids = Array.from(vm_run('PRESET_FIELDS'), f => f.id);
  for (const id of ['scrF26On', 'scrF26Val', 'scrF27On', 'scrF27Val']) assert.ok(ids.includes(id), id);
  const def = vm_run('DEFAULT_FILTER_STATE');
  assert.equal(def.scrF26On, false); assert.equal(def.scrF27On, false);
  assert.equal(def.scrF26Val, '20'); assert.equal(def.scrF27Val, '10');
});
function vm_run(expr) { return require('node:vm').runInContext(expr, sb); }

test('index.html: the two rows are in the Quarterly Results pane, after F23, with the quarter-name spans; the script version is bumped', () => {
  const html = read('index.html');
  const pane = html.indexOf('id="scrPaneQuarterly"'), multi = html.indexOf('id="scrPaneMulti"');
  for (const id of ['scrF26On', 'scrF26Val', 'scrF26Q', 'scrF27On', 'scrF27Val', 'scrF27Q']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > pane && at < multi, `${id} is in the Quarterly Results pane`);
  }
  assert.ok(html.indexOf('id="scrF26On"') > html.indexOf('id="scrF21On"'));      // after the plain growth filters, in the same column
  assert.match(html, /Latest Quarter <span id="scrF26Q"><\/span> QoQ Y Earnings:/);
  assert.match(html, /Latest Quarter <span id="scrF27Q"><\/span> QoQ Y Sales:/);
  assert.match(html, /quarterly-results\.js\?v=1\d/);
});

test('screener.js still holds none of the Quarterly Results filters (no F26 / F27 ids)', () => {
  assert.ok(!/scrF2[0-9]|scrF27/.test(read('js/screener.js')));
});

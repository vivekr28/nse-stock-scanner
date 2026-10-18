'use strict';
// The Quarterly Results tab's sequential filters (js/quarterly-results.js): F28 "QoQ Earnings > X%" and F29 "QoQ Sales > X%" compare the
// stock's latest declared quarter with the quarter BEFORE it (F20 / F21 compare with the same quarter a year earlier); F30 / F31 are the same
// two tests restricted to stocks that have declared the NEWEST quarter any company has declared (like F26 / F27 are to F20 / F21), with the
// quarter name in the label. Covers the pass/fail rules and reasons, the hooks (state, count, columns, reset), presets and the page.
// The server's `qe` / `qs` fields are in tests/test_quarterly_qoq.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/presets.js']);
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');
const reasons = (...a) => Array.from(sb.qrQoqReasons(...a));

const LATEST = '2026-09-30';
const rec = o => Object.assign({ q: LATEST, b: 'C', cmp: 'ok', s: 130, sp: 100, e: 15, ep: 10, sg: 30, eg: 50, st: false, et: false, qe: 25, qs: 8 }, o);
function withData(bySymbol, latestQuarter = LATEST) {
  sb.Store.quarterly = { bySymbol, latestQuarter };
  sb.Store.quarterlyState = 'ready';
}
const ON = min => ({ on: true, min }), OFF = { on: false, min: 0 };

// ── F28 / F29: against the previous quarter ───────────────────────────────────────────────────────────────────────────────

test('F28: passes only when profit growth on the previous quarter is strictly above the threshold', () => {
  withData({ a: rec({ qe: 25 }) });
  assert.deepEqual(reasons('A', ON(0), OFF, OFF, OFF), []);
  assert.deepEqual(reasons('A', ON(24.9), OFF, OFF, OFF), []);
  assert.equal(reasons('A', ON(25), OFF, OFF, OFF)[0], 'F28: Earnings Sep-2026 +25.0% vs the previous quarter, not > 25%');       // equal is not "greater than"
});

test('F29: the same rule for sales, reported under F29', () => {
  withData({ a: rec({ qs: 8 }), down: rec({ qs: -3.25 }) });
  assert.deepEqual(reasons('A', OFF, ON(5), OFF, OFF), []);
  assert.equal(reasons('A', OFF, ON(10), OFF, OFF)[0], 'F29: Sales Sep-2026 +8.0% vs the previous quarter, not > 10%');
  assert.equal(reasons('DOWN', OFF, ON(0), OFF, OFF)[0], 'F29: Sales Sep-2026 -3.3% vs the previous quarter, not > 0%');       // a fall shows its sign
});

test('a missing previous quarter, a zero / loss-making one, or one with no sales has no % and fails with its own reason', () => {
  withData({ none: rec({ qe: null, qs: null }), absent: rec({ qe: undefined, qs: undefined }) });
  assert.match(reasons('NONE', ON(0), OFF, OFF, OFF)[0], /^F28: No Sep-2026 earnings growth vs the previous quarter \(the previous quarter is missing, zero or a loss\)$/);
  assert.match(reasons('NONE', OFF, ON(0), OFF, OFF)[0], /^F29: No Sep-2026 sales growth vs the previous quarter \(the previous quarter is missing or had no sales\)$/);
  assert.match(reasons('ABSENT', ON(0), ON(0), OFF, OFF).join('|'), /F28: No Sep-2026 earnings growth.*\|F29: No Sep-2026 sales growth/);
});

test('they do not need a year-ago quarter (a new listing can pass), and each filter is independent of the other', () => {
  withData({ newco: rec({ cmp: 'no-prev', sp: null, ep: null, eg: null, sg: null, qe: 40, qs: -2 }) });
  assert.deepEqual(reasons('NEWCO', ON(0), OFF, OFF, OFF), []);
  assert.equal(reasons('NEWCO', ON(0), ON(0), OFF, OFF).length, 1);          // earnings pass, sales fall: only F29 fails
  assert.match(reasons('NEWCO', ON(0), ON(0), OFF, OFF)[0], /^F29:/);
});

// ── F30 / F31: only the newest quarter on file ────────────────────────────────────────────────────────────────────────────

test('F30 / F31: a stock that has declared the newest quarter passes on the same rule; an older-quarter stock is left out with both quarters named', () => {
  withData({ now: rec({ qe: 25, qs: 8 }), old: rec({ q: '2026-06-30', qe: 90, qs: 90 }) });
  assert.deepEqual(reasons('NOW', OFF, OFF, ON(20), ON(5)), []);
  assert.equal(reasons('NOW', OFF, OFF, ON(30), OFF)[0], 'F30: Earnings Sep-2026 +25.0% vs the previous quarter, not > 30%');
  assert.deepEqual(reasons('OLD', OFF, OFF, ON(0), ON(0)), ['F30: No Sep-2026 result yet (its latest is Jun-2026)', 'F31: No Sep-2026 result yet (its latest is Jun-2026)']);
});

test('F28 / F29 are unchanged by it: the same older stock passes them and fails F30 / F31', () => {
  withData({ old: rec({ q: '2026-06-30', qe: 90, qs: 90 }) });
  assert.deepEqual(reasons('OLD', ON(0), ON(0), OFF, OFF), []);
  assert.equal(reasons('OLD', ON(0), ON(0), ON(0), OFF).length, 1);
  assert.match(reasons('OLD', ON(0), ON(0), ON(0), OFF)[0], /^F30:/);
});

test('states: nothing on = nothing checked; no results for the stock, no file, still loading all fail with the usual reasons', () => {
  withData({ a: rec({}) });
  assert.deepEqual(reasons('A', OFF, OFF, OFF, OFF), []);
  assert.deepEqual(reasons('A', undefined, undefined, undefined, undefined), []);
  assert.match(reasons('NOBODY', ON(0), OFF, OFF, OFF)[0], /^F28: No quarterly results for this stock$/);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(reasons('A', OFF, ON(0), OFF, OFF)[0], /^F29: No quarterly results file/);
  sb.Store.quarterlyState = 'loading';
  assert.match(reasons('A', OFF, OFF, ON(0), OFF)[0], /^F30: Quarterly results still loading$/);
});

// ── the hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('qrFilterState carries F28-F31 (blank or invalid threshold = 0); any is true when only they are on', () => {
  const dom = installFakeDom(sb, { scrF28Val: '5', scrF29Val: 'abc', scrF30Val: '10', scrF31Val: '' });
  assert.equal(sb.qrFilterState().any, false);
  dom.el('scrF31On').checked = true;
  const s = JSON.parse(JSON.stringify(sb.qrFilterState()));
  assert.deepEqual([s.f28, s.f29, s.f30, s.f31], [{ on: false, min: 5 }, { on: false, min: 0 }, { on: false, min: 10 }, { on: true, min: 0 }]);
  assert.equal(s.any, true);
});

test('qrApplyToStock records the two figures on the stock and combines the reasons with the YoY filters', () => {
  withData({ a: rec({ qe: 12, qs: 3 }) });
  const dom = installFakeDom(sb, { scrF20Val: '20', scrF28Val: '20', scrF29Val: '0' });
  dom.el('scrF20On').checked = true; dom.el('scrF28On').checked = true; dom.el('scrF29On').checked = true;
  const stock = { symbol: 'A' };
  const r = Array.from(sb.qrApplyToStock(stock, sb.qrFilterState()));
  assert.deepEqual(r.map(x => x.slice(0, 3)), ['F28']);                      // F20 passes (+50% YoY), F29 passes (+3% > 0), F28 fails (+12% is not > 20)
  assert.equal(stock._qrQoqE, 12); assert.equal(stock._qrQoqS, 3);
  const none = { symbol: 'NOBODY' };
  sb.qrApplyToStock(none, sb.qrFilterState());
  assert.ok(Number.isNaN(none._qrQoqE) && Number.isNaN(none._qrQoqS));
});

test('the tab counts them in its badge; one QoQ Earnings and one QoQ Sales column however many of the two are on', () => {
  const dom = installFakeDom(sb, {});
  withData({ a: rec({}) });
  const labels = () => Array.from(sb.qrColumns(), c => c.label);
  dom.el('scrF28On').checked = true;
  assert.equal(sb.qrActiveCount(), 1);
  assert.deepEqual(labels(), ['Result Qtr', 'QoQ Earnings%']);
  dom.el('scrF30On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'QoQ Earnings%']);                // not twice
  dom.el('scrF31On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'QoQ Earnings%', 'QoQ Sales%']);
  dom.el('scrF29On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'QoQ Earnings%', 'QoQ Sales%']);
  assert.equal(sb.qrActiveCount(), 4);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 4);
  const col = Array.from(sb.qrColumns()).find(c => c.key === '_qrQoqE');
  assert.equal(col.fmt(12.34), '+12.3%'); assert.equal(col.fmt(-4), '-4.0%'); assert.equal(col.fmt(NaN), '-');
});

test('the quarter name in the F30 / F31 labels follows the newest quarter on file, and is blank until the data loads', () => {
  const dom = installFakeDom(sb, {});
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'loading';
  sb.qrUpdateStatus();
  assert.equal(dom.el('scrF30Q').textContent, ''); assert.equal(dom.el('scrF31Q').textContent, '');
  withData({ a: rec({}) }, '2026-12-31');
  sb.qrUpdateStatus();
  assert.equal(dom.el('scrF30Q').textContent, '(Dec-2026)'); assert.equal(dom.el('scrF31Q').textContent, '(Dec-2026)');
});

test('qrReset puts all four back to off and 0', () => {
  const dom = installFakeDom(sb, {});
  for (const n of [28, 29, 30, 31]) { dom.el(`scrF${n}On`).checked = true; dom.el(`scrF${n}Val`).value = '99'; }
  sb.qrReset();
  for (const n of [28, 29, 30, 31]) { assert.equal(dom.el(`scrF${n}On`).checked, false); assert.equal(dom.el(`scrF${n}Val`).value, '0'); }
});

// ── presets and the page ──────────────────────────────────────────────────────────────────────────────────────────────────

test('presets: the eight F28-F31 controls are captured and restored, and "— Select preset —" resets them to off and 0', () => {
  const ids = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => f.id);
  const def = vm.runInContext('DEFAULT_FILTER_STATE', sb);
  for (const n of [28, 29, 30, 31]) {
    assert.ok(ids.includes(`scrF${n}On`) && ids.includes(`scrF${n}Val`), `F${n}`);
    assert.equal(def[`scrF${n}On`], false); assert.equal(def[`scrF${n}Val`], '0');
  }
});

test('index.html: the four rows are in the Quarterly Results pane after F27, with the labels the user asked for and the quarter-name spans', () => {
  const html = read('index.html');
  const pane = html.indexOf('id="scrPaneQuarterly"'), multi = html.indexOf('id="scrPaneMulti"');
  for (const id of ['scrF28On', 'scrF28Val', 'scrF29On', 'scrF29Val', 'scrF30On', 'scrF30Val', 'scrF30Q', 'scrF31On', 'scrF31Val', 'scrF31Q']) {
    const at = html.indexOf(`id="${id}"`); assert.ok(at > pane && at < multi, `${id} is in the Quarterly Results pane`);
  }
  assert.ok(html.indexOf('id="scrF28On"') > html.indexOf('id="scrF27On"'));
  assert.match(html, />QoQ Earnings:<\/span>/); assert.match(html, />QoQ Sales:<\/span>/);
  assert.match(html, /Latest Quarter <span id="scrF30Q"><\/span> QoQ Earnings:/); assert.match(html, /Latest Quarter <span id="scrF31Q"><\/span> QoQ Sales:/);
  assert.match(html, /quarterly-results\.js\?v=1\d/);
});

test('screener.js still holds none of the Quarterly Results filters (no F28-F33 ids)', () => {
  assert.ok(!/scrF2[0-9]|scrF3[0-3]/.test(read('js/screener.js')));
});


// ── F32 / F33: the sequential turnarounds (a loss a quarter ago, a profit now / no sales a quarter ago, some now) ──────────

const turnReasons = (...a) => Array.from(sb.qrQoqTurnaroundReasons(...a));
const NO = { on: false }, YES = { on: true };
// qp = [previous profit, previous sales, profit now, sales now] in Rs crore
const trec = o => rec(Object.assign({ qp: [-5, 100, 10, 120], qet: true, qst: false }, o));

test('F32: a loss in the previous quarter and a profit now passes; the reasons say why a stock is not one', () => {
  withData({ turn: trec({}), pos: trec({ qp: [8, 100, 10, 120], qet: false }), zero: trec({ qp: [0, 100, 10, 120], qet: false }), still: trec({ qp: [-5, 100, -2, 120], qet: false }) });
  assert.deepEqual(turnReasons('TURN', YES, NO), []);
  assert.equal(turnReasons('POS', YES, NO)[0], 'F32: Not an earnings turnaround - Sep-2026 profit was already positive in the previous quarter (8 cr)');
  assert.equal(turnReasons('ZERO', YES, NO)[0], 'F32: Not an earnings turnaround - profit in the previous quarter was zero, not a loss');
  assert.equal(turnReasons('STILL', YES, NO)[0], 'F32: Not an earnings turnaround - still loss-making (-2 cr vs -5 cr the quarter before)');
});

test('F33: no sales in the previous quarter and some now passes; otherwise it says so', () => {
  withData({ turn: trec({ qp: [3, 0, 5, 50], qet: false, qst: true }), pos: trec({ qp: [3, 80, 5, 50], qet: false, qst: false }), none: trec({ qp: [3, 0, 5, 0], qet: false, qst: false }) });
  assert.deepEqual(turnReasons('TURN', NO, YES), []);
  assert.equal(turnReasons('POS', NO, YES)[0], 'F33: Not a sales turnaround - Sep-2026 sales were already positive in the previous quarter (80 cr)');
  assert.equal(turnReasons('NONE', NO, YES)[0], 'F33: Not a sales turnaround - no sales this quarter either');
});

test('F32 / F33 together: each failure is listed under its own code; nothing on = nothing checked', () => {
  withData({ a: trec({ qp: [8, 100, 10, 120], qet: false, qst: false }), b: trec({ qp: [-5, 0, 10, 50], qet: true, qst: true }) });
  assert.deepEqual(turnReasons('A', YES, YES).map(r => r.slice(0, 3)), ['F32', 'F33']);
  assert.deepEqual(turnReasons('B', YES, YES), []);
  assert.deepEqual(turnReasons('A', NO, NO), []);
  assert.deepEqual(turnReasons('A', undefined, undefined), []);
});

test('F32 / F33: no previous quarter on file, none on a shared basis, no results, no file, still loading', () => {
  withData({ noq: rec({}), basis: rec({ qp: null, qet: false, qst: false }), ok: trec({}) });   // `noq` has no qp field at all: the previous quarter is not on file
  assert.equal(turnReasons('NOQ', YES, NO)[0], 'F32: No quarter before Sep-2026 on file to compare with');
  assert.equal(turnReasons('BASIS', NO, YES)[0], 'F33: Sep-2026 and the previous quarter are on different bases (standalone vs consolidated)');
  assert.match(turnReasons('NOBODY', YES, NO)[0], /^F32: No quarterly results for this stock$/);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(turnReasons('OK', YES, NO)[0], /^F32: No quarterly results file/);
  sb.Store.quarterlyState = 'loading';
  assert.match(turnReasons('OK', NO, YES)[0], /^F33: Quarterly results still loading$/);
});

test("they judge the stock's own latest quarter and need no year-ago quarter (a new listing can be a turnaround)", () => {
  withData({ newco: trec({ cmp: 'no-prev', sp: null, ep: null, eg: null, sg: null }), old: trec({ q: '2026-06-30' }) });
  assert.deepEqual(turnReasons('NEWCO', YES, NO), []);
  assert.deepEqual(turnReasons('OLD', YES, NO), []);                       // an older-quarter stock passes too: there is no latest-quarter version of these two
});

test('qrFilterState carries F32 / F33; qrApplyToStock records the amounts and combines every reason list', () => {
  withData({ a: trec({ qp: [8, 100, 10, 120], qet: false, qe: 25 }) });
  const dom = installFakeDom(sb, { scrF28Val: '0' });
  dom.el('scrF32On').checked = true; dom.el('scrF28On').checked = true;
  const s = JSON.parse(JSON.stringify(sb.qrFilterState()));
  assert.deepEqual([s.f32, s.f33], [{ on: true }, { on: false }]);
  assert.equal(s.any, true);
  const stock = { symbol: 'A' };
  const r = Array.from(sb.qrApplyToStock(stock, sb.qrFilterState()));
  assert.deepEqual(r.map(x => x.slice(0, 3)), ['F32']);                    // QoQ Earnings (+25% > 0) passes; the turnaround fails
  assert.deepEqual([stock._qrQPrevE, stock._qrQPrevS, stock._qrQNowE, stock._qrQNowS], [8, 100, 10, 120]);
  const none = { symbol: 'NOBODY' };
  sb.qrApplyToStock(none, sb.qrFilterState());
  assert.ok(Number.isNaN(none._qrQPrevE) && Number.isNaN(none._qrQNowS));
});

test('the tab counts them; each turnaround filter adds an amounts column "prev qtr -> now"; Reset All and presets cover them', () => {
  const dom = installFakeDom(sb, {});
  withData({ a: trec({}) });
  dom.el('scrF32On').checked = true;
  assert.equal(sb.qrActiveCount(), 1);
  dom.el('scrF33On').checked = true;
  assert.equal(sb.qrActiveCount(), 2);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 2);
  const cols = Array.from(sb.qrColumns());
  assert.deepEqual(cols.map(c => c.label), ['Result Qtr', 'Profit Cr (prev qtr → now)', 'Sales Cr (prev qtr → now)']);
  assert.equal(cols[1].fmt(10, { _qrQPrevE: -5 }), '-5 → 10'); assert.equal(cols[1].fmt(NaN, {}), '-');
  assert.equal(cols[2].fmt(120, { _qrQPrevS: 0 }), '0 → 120');
  sb.qrReset();
  assert.equal(dom.el('scrF32On').checked, false); assert.equal(dom.el('scrF33On').checked, false);
  const ids = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => f.id), def = vm.runInContext('DEFAULT_FILTER_STATE', sb);
  assert.ok(ids.includes('scrF32On') && ids.includes('scrF33On'));
  assert.equal(def.scrF32On, false); assert.equal(def.scrF33On, false);
});

test('index.html: the two turnaround rows are at the bottom of the right column, worded as asked', () => {
  const html = read('index.html');
  const pane = html.indexOf('id="scrPaneQuarterly"'), multi = html.indexOf('id="scrPaneMulti"');
  for (const id of ['scrF32On', 'scrF33On']) { const at = html.indexOf(`id="${id}"`); assert.ok(at > pane && at < multi, id); }
  assert.ok(html.indexOf('id="scrF32On"') > html.indexOf('id="scrF31On"') && html.indexOf('id="scrF33On"') > html.indexOf('id="scrF32On"'));
  assert.match(html, />QoQ Earnings turnaround:<\/span>/); assert.match(html, />QoQ Sales turnaround:<\/span>/);
  assert.match(html, /loss a quarter ago, profit now/); assert.match(html, /no sales a quarter ago, sales now/);
});

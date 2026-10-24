'use strict';
// The Quarterly Results tab's "against the previous quarter" filters (js/quarterly-results.js). They compare YoY % with YoY %: each quarter's
// % is its change on the same quarter a year earlier (the %Chg the chart table shows), and the stock's latest declared quarter is set against
// the quarter before it.
//   F28 "EPS YoY% change" / F29 "Sales YoY% change"  latest quarter's YoY % minus the previous quarter's, in percentage points, strictly > X
//       (Antelopus: Jun-26 EPS +384%, Mar-26 +3% -> +381 pts; sales +159% and +65% -> +94 pts)
//   F32 "EPS turnaround" / F33 "Sales turnaround"    the YoY % was NEGATIVE a quarter ago and is POSITIVE now (Dec-25 -33%, Mar-26 +3%)
// Covers the pass/fail rules and reasons, the hooks (state, count, columns, reset), presets and the page. The server's `yy` field is in
// tests/test_quarterly_qoq.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/presets.js']);
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');
const change = (...a) => Array.from(sb.qrYoyChangeReasons(...a));
const turn = (...a) => Array.from(sb.qrYoyTurnaroundReasons(...a));

const LATEST = '2026-06-30';
// yy = [EPS YoY % now, EPS YoY % a quarter ago, sales YoY % now, sales YoY % a quarter ago]: Antelopus
const rec = o => Object.assign({ q: LATEST, b: 'S', cmp: 'ok', s: 131, sp: 50.6, e: 54.32, ep: 11.22, sg: 159, eg: 384, st: false, et: false, yy: [384, 3, 159, 65] }, o);
function withData(bySymbol, latestQuarter = LATEST) {
  sb.Store.quarterly = { bySymbol, latestQuarter };
  sb.Store.quarterlyState = 'ready';
}
const ON = min => ({ on: true, min }), OFF = { on: false, min: 0 };
const YES = { on: true }, NO = { on: false };

// ── F28 / F29: the change in YoY % ────────────────────────────────────────────────────────────────────────────────────────

test('F28: the latest YoY % minus the previous quarter\'s, in points, must be strictly above the threshold (Antelopus 384 - 3 = 381)', () => {
  withData({ antelopus: rec({}) });
  assert.deepEqual(change('ANTELOPUS', ON(0), OFF), []);
  assert.deepEqual(change('ANTELOPUS', ON(380.9), OFF), []);
  assert.equal(change('ANTELOPUS', ON(381), OFF)[0], 'F28: EPS YoY went from +3.0% (Mar-2026) to +384.0% (Jun-2026): +381.0 pts, not > 381 pts');   // equal is not "greater than"
});

test('F29: the same rule for sales, reported under F29 (159 - 65 = 94)', () => {
  withData({ antelopus: rec({}) });
  assert.deepEqual(change('ANTELOPUS', OFF, ON(93.9)), []);
  assert.equal(change('ANTELOPUS', OFF, ON(94))[0], 'F29: Sales YoY went from +65.0% (Mar-2026) to +159.0% (Jun-2026): +94.0 pts, not > 94 pts');
});

test('a slowdown is a negative change and fails a 0 threshold, with its sign shown; a fall in YoY % from a higher one is not growth', () => {
  withData({ slow: rec({ yy: [10, 40, -5, 12] }) });
  assert.equal(change('SLOW', ON(0), OFF)[0], 'F28: EPS YoY went from +40.0% (Mar-2026) to +10.0% (Jun-2026): -30.0 pts, not > 0 pts');
  assert.equal(change('SLOW', OFF, ON(0))[0], 'F29: Sales YoY went from +12.0% (Mar-2026) to -5.0% (Jun-2026): -17.0 pts, not > 0 pts');
});

test('each filter is independent of the other, and both are listed under their own code when both fail', () => {
  withData({ a: rec({ yy: [50, 10, 5, 20] }) });
  assert.deepEqual(change('A', ON(0), ON(0)).map(r => r.slice(0, 3)), ['F29']);        // EPS +40 pts passes, sales -15 pts fails
  assert.deepEqual(change('A', ON(100), ON(0)).map(r => r.slice(0, 3)), ['F28', 'F29']);
});

test('the points are rounded to two places so a float sum cannot flip a result at the threshold', () => {
  withData({ a: rec({ yy: [10.3, 10.1, 0, 0] }) });
  assert.equal(change('A', ON(0.2), OFF).length, 1);                                    // 10.3 - 10.1 is 0.2 (not 0.20000000000000107): equal, so not above
  assert.deepEqual(change('A', ON(0.19), OFF), []);
});

test('a quarter with no YoY % (no result, or a loss / zero year-ago base) cannot be compared: it fails saying which quarter', () => {
  withData({ lossnow: rec({ yy: [null, 3, 159, 65] }), lossprev: rec({ yy: [384, null, 159, 65] }), nosales: rec({ yy: [384, 3, null, null] }) });
  assert.match(change('LOSSNOW', ON(0), OFF)[0], /^F28: No EPS YoY % for Jun-2026 \(/);
  assert.match(change('LOSSPREV', ON(0), OFF)[0], /^F28: No EPS YoY % for Mar-2026 \(/);
  assert.match(change('NOSALES', OFF, ON(0))[0], /^F29: No Sales YoY % for Jun-2026 \(/);
  assert.deepEqual(change('NOSALES', ON(0), OFF), []);                                  // its EPS are fine: only the sales filter is affected
});

test('a record from an older server with no yy field fails with a reason rather than throwing', () => {
  withData({ legacy: rec({ yy: undefined }) });
  assert.equal(change('LEGACY', ON(0), OFF)[0], 'F28: No Mar-2026 result on file to compare Jun-2026 with');
});

test('every stock is judged on its own latest quarter: an older-quarter stock passes here (F40 is what restricts to the newest)', () => {
  withData({ old: rec({ q: '2026-03-31', yy: [100, 10, 40, 5] }) });
  assert.deepEqual(change('OLD', ON(0), ON(0)), []);
  assert.equal(change('OLD', ON(95), OFF)[0], 'F28: EPS YoY went from +10.0% (Dec-2025) to +100.0% (Mar-2026): +90.0 pts, not > 95 pts');   // the quarters named are that stock's own
});

test('states: nothing on = nothing checked; no results for the stock, no file, still loading all fail with the usual reasons', () => {
  withData({ a: rec({}) });
  assert.deepEqual(change('A', OFF, OFF), []);
  assert.deepEqual(change('A', undefined, undefined), []);
  assert.match(change('NOBODY', ON(0), OFF)[0], /^F28: No quarterly results for this stock$/);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(change('A', OFF, ON(0))[0], /^F29: No quarterly results file/);
  sb.Store.quarterlyState = 'loading';
  assert.match(change('A', ON(0), OFF)[0], /^F28: Quarterly results still loading$/);
});

// ── F32 / F33: the turnarounds (YoY % negative a quarter ago, positive now) ───────────────────────────────────────────────

test('F32: Antelopus Mar-26 turnaround (Dec-25 -33%, Mar-26 +3%) passes; the reasons say why a stock is not one', () => {
  withData({
    turn: rec({ q: '2026-03-31', yy: [3, -33, 65, 11] }),
    already: rec({ yy: [384, 3, 159, 65] }),
    still: rec({ yy: [-10, -40, 5, 5] }),
    zero: rec({ yy: [5, 0, 5, 5] }),
    dropped: rec({ yy: [-2, 12, 5, 5] }),
  });
  assert.deepEqual(turn('TURN', YES, NO), []);
  assert.equal(turn('ALREADY', YES, NO)[0], 'F32: Not an EPS turnaround - YoY was already +3.0% in Mar-2026');
  assert.equal(turn('STILL', YES, NO)[0], 'F32: Not an EPS turnaround - YoY is still -10.0% in Jun-2026 (-40.0% in Mar-2026)');
  assert.equal(turn('ZERO', YES, NO)[0], 'F32: Not an EPS turnaround - YoY was already +0.0% in Mar-2026');                              // zero is not negative
  assert.equal(turn('DROPPED', YES, NO)[0], 'F32: Not an EPS turnaround - YoY was already +12.0% in Mar-2026');                          // positive to negative is the opposite
});

test('F33: the same turnaround on the sales YoY %', () => {
  withData({ turn: rec({ yy: [10, 10, 4, -20] }), pos: rec({ yy: [10, 10, 4, 6] }), still: rec({ yy: [10, 10, -1, -20] }), exact: rec({ yy: [10, 10, 0.01, -0.01] }) });
  assert.deepEqual(turn('TURN', NO, YES), []);
  assert.deepEqual(turn('EXACT', NO, YES), []);                                                // any negative then any positive
  assert.equal(turn('POS', NO, YES)[0], 'F33: Not a Sales turnaround - YoY was already +6.0% in Mar-2026');
  assert.equal(turn('STILL', NO, YES)[0], 'F33: Not a Sales turnaround - YoY is still -1.0% in Jun-2026 (-20.0% in Mar-2026)');
});

test('F32 / F33 together: each failure is listed under its own code; nothing on = nothing checked', () => {
  withData({ a: rec({ yy: [10, 5, 4, -20] }), b: rec({ yy: [10, -5, 4, -20] }) });
  assert.deepEqual(turn('A', YES, YES).map(r => r.slice(0, 3)), ['F32']);
  assert.deepEqual(turn('B', YES, YES), []);
  assert.deepEqual(turn('A', NO, NO), []);
  assert.deepEqual(turn('A', undefined, undefined), []);
});

test('F32 / F33: no YoY % in a quarter (a loss year-ago base counts), no results, no file, still loading', () => {
  withData({ loss: rec({ yy: [10, null, 4, null] }), ok: rec({}) });
  assert.match(turn('LOSS', YES, NO)[0], /^F32: No EPS YoY % for Mar-2026 \(/);
  assert.match(turn('LOSS', NO, YES)[0], /^F33: No Sales YoY % for Mar-2026 \(/);
  assert.match(turn('NOBODY', YES, NO)[0], /^F32: No quarterly results for this stock$/);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(turn('OK', YES, NO)[0], /^F32: No quarterly results file/);
  sb.Store.quarterlyState = 'loading';
  assert.match(turn('OK', NO, YES)[0], /^F33: Quarterly results still loading$/);
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('qrPrevQuarter steps one quarter back across a year end; qrFmtPct signs its percentages', () => {
  const label = iso => sb.qrQuarterLabel(sb.qrPrevQuarter(iso));
  assert.equal(label('2026-06-30'), 'Mar-2026'); assert.equal(label('2026-03-31'), 'Dec-2025'); assert.equal(label('2026-12-31'), 'Sep-2026');
  assert.equal(sb.qrPrevQuarter(''), ''); assert.equal(sb.qrPrevQuarter(undefined), '');
  assert.equal(sb.qrFmtPct(384), '+384.0%'); assert.equal(sb.qrFmtPct(-33), '-33.0%'); assert.equal(sb.qrFmtPct(0), '+0.0%');
});

// ── the hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('qrFilterState carries F28 / F29 / F32 / F33 (blank or invalid threshold = 0); any is true when only they are on', () => {
  const dom = installFakeDom(sb, { scrF28Val: '5', scrF29Val: 'abc' });
  assert.equal(sb.qrFilterState().any, false);
  dom.el('scrF29On').checked = true;
  const s = JSON.parse(JSON.stringify(sb.qrFilterState()));
  assert.deepEqual([s.f28, s.f29, s.f32, s.f33], [{ on: false, min: 5 }, { on: true, min: 0 }, { on: false }, { on: false }]);
  assert.equal(s.any, true);
  dom.el('scrF29On').checked = false; dom.el('scrF33On').checked = true;
  assert.equal(sb.qrFilterState().any, true);
});

test('qrApplyToStock records the two YoY %s and their change on the stock and combines the reasons with the other filters', () => {
  withData({ a: rec({ yy: [50, 30, 12, 4] }) });
  const dom = installFakeDom(sb, { scrF20Val: '20', scrF28Val: '30', scrF29Val: '0' });
  dom.el('scrF20On').checked = true; dom.el('scrF28On').checked = true; dom.el('scrF29On').checked = true;
  const stock = { symbol: 'A' };
  const r = Array.from(sb.qrApplyToStock(stock, sb.qrFilterState()));
  assert.deepEqual(r.map(x => x.slice(0, 3)), ['F28']);                         // F20 passes (+384%), F29 passes (+8 pts > 0), F28 fails (+20 pts is not > 30)
  assert.deepEqual([stock._qrYyNowE, stock._qrYyPrevE, stock._qrAccE], [50, 30, 20]);
  assert.deepEqual([stock._qrYyNowS, stock._qrYyPrevS, stock._qrAccS], [12, 4, 8]);
  const none = { symbol: 'NOBODY' };
  sb.qrApplyToStock(none, sb.qrFilterState());
  assert.ok([none._qrYyNowE, none._qrYyPrevE, none._qrAccE, none._qrAccS].every(Number.isNaN));
  withData({ loss: rec({ yy: [50, null, 12, 4] }) });
  const l = { symbol: 'LOSS' };
  sb.qrApplyToStock(l, sb.qrFilterState());
  assert.equal(l._qrYyNowE, 50); assert.ok(Number.isNaN(l._qrYyPrevE) && Number.isNaN(l._qrAccE));       // no change without both
});

test('the tab counts them in its badge; one EPS pair column and one Sales pair column however many of the filters on that figure are on', () => {
  const dom = installFakeDom(sb, {});
  withData({ a: rec({}) });
  const labels = () => Array.from(sb.qrColumns(), c => c.label);
  dom.el('scrF28On').checked = true;
  assert.equal(sb.qrActiveCount(), 1);
  assert.deepEqual(labels(), ['Result Qtr', 'EPS YoY% (prev qtr → now)', 'EPS YoY% change']);
  dom.el('scrF32On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'EPS YoY% (prev qtr → now)', 'EPS YoY% change']);       // not twice
  dom.el('scrF33On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'EPS YoY% (prev qtr → now)', 'EPS YoY% change', 'Sales YoY% (prev qtr → now)']);
  dom.el('scrF29On').checked = true;
  assert.deepEqual(labels(), ['Result Qtr', 'EPS YoY% (prev qtr → now)', 'EPS YoY% change', 'Sales YoY% (prev qtr → now)', 'Sales YoY% change']);
  assert.equal(sb.qrActiveCount(), 4);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 4);
});

test('the YoY columns format their cells: "+3.0% → +384.0%", the change in points, "-" when a figure is missing, sorting by the latest quarter', () => {
  const dom = installFakeDom(sb, {});
  withData({ a: rec({}) });
  dom.el('scrF28On').checked = true; dom.el('scrF29On').checked = true;
  const cols = Array.from(sb.qrColumns());
  const pair = cols.find(c => c.label === 'EPS YoY% (prev qtr → now)'), pts = cols.find(c => c.label === 'EPS YoY% change');
  assert.equal(pair.key, '_qrYyNowE');
  assert.equal(pair.fmt(384, { _qrYyPrevE: 3 }), '+3.0% → +384.0%'); assert.equal(pair.fmt(-5, { _qrYyPrevE: -33 }), '-33.0% → -5.0%');
  assert.equal(pair.fmt(NaN, { _qrYyPrevE: 3 }), '-'); assert.equal(pair.fmt(3, { _qrYyPrevE: NaN }), '-');
  assert.equal(pts.fmt(381), '+381.0 pts'); assert.equal(pts.fmt(-17.25), '-17.3 pts'); assert.equal(pts.fmt(NaN), '-');
  assert.equal(pair.cls(384), 'positive'); assert.equal(pair.cls(-5), 'negative'); assert.equal(pair.cls(NaN), '');
});

test('qrReset puts F28 / F29 back to off and 0 and switches F32 / F33 off', () => {
  const dom = installFakeDom(sb, {});
  for (const n of [28, 29]) { dom.el(`scrF${n}On`).checked = true; dom.el(`scrF${n}Val`).value = '99'; }
  for (const n of [32, 33]) dom.el(`scrF${n}On`).checked = true;
  sb.qrReset();
  for (const n of [28, 29]) { assert.equal(dom.el(`scrF${n}On`).checked, false); assert.equal(dom.el(`scrF${n}Val`).value, '0'); }
  for (const n of [32, 33]) assert.equal(dom.el(`scrF${n}On`).checked, false);
});

// ── presets and the page ──────────────────────────────────────────────────────────────────────────────────────────────────

test('presets: the F28 / F29 controls and the F32 / F33 switches are captured and restored, and "— Select preset —" resets them to off and 0', () => {
  const ids = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => f.id);
  const def = vm.runInContext('DEFAULT_FILTER_STATE', sb);
  for (const n of [28, 29]) {
    assert.ok(ids.includes(`scrF${n}On`) && ids.includes(`scrF${n}Val`), `F${n}`);
    assert.equal(def[`scrF${n}On`], false); assert.equal(def[`scrF${n}Val`], '0');
  }
  for (const n of [32, 33]) { assert.ok(ids.includes(`scrF${n}On`), `F${n}`); assert.equal(def[`scrF${n}On`], false); }
});

test('index.html: the four rows are in the right column, worded for YoY %, with the threshold in points', () => {
  const html = read('index.html');
  const pane = html.indexOf('id="scrPaneQuarterly"'), multi = html.indexOf('id="scrPaneMulti"');
  const col = html.indexOf('Against the previous quarter', pane);
  for (const id of ['scrF28On', 'scrF28Val', 'scrF29On', 'scrF29Val', 'scrF32On', 'scrF33On']) {
    const at = html.indexOf(`id="${id}"`); assert.ok(at > col && at < multi, `${id} is in the previous-quarter column`);
  }
  assert.match(html, />EPS YoY% change:<\/span>/); assert.match(html, />Sales YoY% change:<\/span>/);
  assert.match(html, />EPS turnaround:<\/span>/); assert.match(html, />Sales turnaround:<\/span>/);
  assert.match(html, /YoY % negative a quarter ago, positive now/);
  assert.match(html.slice(html.indexOf('id="scrF28Val"'), html.indexOf('id="scrF28Val"') + 200), /pts/);
  assert.ok(!/QoQ Earnings|QoQ Sales/.test(html.slice(col, multi)), 'the old sequential wording is gone');
});

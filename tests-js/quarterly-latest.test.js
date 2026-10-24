'use strict';
// The Quarterly Results tab's "Results for quarter" picker, F40 (js/quarterly-results.js). Blank, every Quarterly Results filter judges each stock on
// its OWN last reported quarter. With a quarter picked (the newest on file or one of the 7 before it), every filter judges each stock on THAT
// quarter - its record for it is the stock's top-level record when that is its latest, else one of the server's `qq` records - and a stock with no
// result for it fails. Covers the quarter maths, the record choice, the rule and its reasons, how it reaches every other filter, the hooks (state,
// count, columns, reset), the picker's options, presets and the page wiring. The other filters' own tests are in quarterly-results.test.js and
// quarterly-qoq.test.js; the server's `qq` field is in tests/test_quarterly_qoq.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/presets.js']);
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');
const reasons = (...a) => Array.from(sb.qrQuarterReasons(...a));

const LATEST = '2026-09-30', JUN = '2026-06-30', MAR = '2026-03-31';
const OFF = { on: false, quarter: '' }, PICK = quarter => ({ on: true, quarter });
// a stock whose latest quarter is Sep-26 and which also carries Jun-26 and Mar-26 (qq); each has its own numbers so the one judged is visible
const rec = o => Object.assign({
  q: LATEST, b: 'C', cmp: 'ok', s: 130, sp: 100, e: 15, ep: 10, sg: 30, eg: 50, yy: [90, 10, 40, 5],
  qq: { [JUN]: { q: JUN, cmp: 'ok', s: 110, sp: 100, e: 12, ep: 10, sg: 10, eg: 20, yy: [20, 30, 10, 12] }, [MAR]: { q: MAR, cmp: 'ok', s: 100, sp: 90, e: 9, ep: 10, sg: 11, eg: -10, yy: [-10, 5, 11, 3] } },
}, o);
function withData(bySymbol, latestQuarter = LATEST) {
  sb.Store.quarterly = { bySymbol, latestQuarter };
  sb.Store.quarterlyState = 'ready';
}
const ON = min => ({ on: true, min });
const qrFail = (sym, f20, f21, quarter) => Array.from(sb.qrFailReasons(sym, f20, f21, { on: false }, { on: false }, quarter));

// ── the quarter maths ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('qrQuarterEnd steps whole quarters, across year ends and in both directions, and lands on the real last day', () => {
  assert.equal(sb.qrQuarterEnd('2026-09-30', 0), '2026-09-30');
  assert.equal(sb.qrQuarterEnd('2026-09-30', -1), '2026-06-30');
  assert.equal(sb.qrQuarterEnd('2026-03-31', -1), '2025-12-31');
  assert.equal(sb.qrQuarterEnd('2026-12-31', 1), '2027-03-31');
  assert.equal(sb.qrQuarterEnd('2026-09-30', -7), '2024-12-31');
  assert.equal(sb.qrQuarterEnd('2026-12-31', -3), '2026-03-31');
  assert.equal(sb.qrQuarterEnd('2025-12-15', -3), '2025-03-31');             // any date in a quarter's last month will do
  assert.equal(sb.qrQuarterEnd('', -1), ''); assert.equal(sb.qrQuarterEnd(undefined, 1), '');
});

// ── which record is judged ────────────────────────────────────────────────────────────────────────────────────────────────

test('qrQuarterRec: no quarter picked, or the stock\'s own latest picked, gives the stock\'s record; an earlier one gives its qq record; none gives undefined', () => {
  const r = rec({});
  assert.equal(sb.qrQuarterRec(r, ''), r);
  assert.equal(sb.qrQuarterRec(r, undefined), r);
  assert.equal(sb.qrQuarterRec(r, LATEST), r);
  assert.equal(sb.qrQuarterRec(r, JUN).s, 110);
  assert.equal(sb.qrQuarterRec(r, '2025-12-31'), undefined);                   // not on file for this stock
  assert.equal(sb.qrQuarterRec(rec({ qq: undefined }), JUN), undefined);       // a record with no earlier quarters
  assert.equal(sb.qrQuarterRec(undefined, JUN), undefined);                    // no stock record at all
});

// ── F40 itself ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a stock with a result for the picked quarter passes: the newest, an earlier one, or its own latest when that is the picked one', () => {
  withData({ a: rec({}) });
  assert.deepEqual(reasons('A', PICK(LATEST)), []);
  assert.deepEqual(reasons('A', PICK(JUN)), []);
  assert.deepEqual(reasons('A', PICK(MAR)), []);
});

test('a stock with none for it is left out, naming both quarters: one that has not declared the newest yet, or has a gap', () => {
  withData({ behind: rec({ q: JUN, qq: { [MAR]: { q: MAR, cmp: 'ok' } } }), gap: rec({}) });
  assert.deepEqual(reasons('BEHIND', PICK(LATEST)), ['F40: No Sep-2026 result on file (its latest is Jun-2026)']);
  assert.deepEqual(reasons('GAP', PICK('2025-12-31')), ['F40: No Dec-2025 result on file (its latest is Sep-2026)']);
});

test('nothing picked (or no state at all) checks nothing, even for a stock with no results', () => {
  withData({ a: rec({}) });
  assert.deepEqual(reasons('A', OFF), []);
  assert.deepEqual(reasons('NOBODY', OFF), []);
  assert.deepEqual(reasons('A', undefined), []);
});

test('no results for the stock, no results file, results still loading: each fails with the usual reason', () => {
  withData({ a: rec({}) });
  assert.deepEqual(reasons('NOBODY', PICK(JUN)), ['F40: No quarterly results for this stock']);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'missing';
  assert.match(reasons('A', PICK(JUN))[0], /^F40: No quarterly results file/);
  sb.Store.quarterlyState = 'loading';
  assert.deepEqual(reasons('A', PICK(JUN)), ['F40: Quarterly results still loading']);
});

// ── it reaches every other filter ─────────────────────────────────────────────────────────────────────────────────────────

test('the year-ago filters judge the picked quarter, not the latest: Sep-26 passes F20 > 40 (+50%), Jun-26 (+20%) does not', () => {
  withData({ a: rec({}) });
  assert.deepEqual(qrFail('A', ON(40), { on: false }, ''), []);
  assert.deepEqual(qrFail('A', ON(40), { on: false }, LATEST), []);
  assert.equal(qrFail('A', ON(40), { on: false }, JUN)[0], 'F20: Earnings Jun-2026 +20.0% YoY, not > 40%');
  assert.deepEqual(qrFail('A', ON(15), ON(5), JUN), []);                        // +20% and +10% both pass the lower bars
});

test('the usual "cannot compare" reasons apply to the picked quarter\'s own record (Mar-26 had a loss year-ago: eg is missing there)', () => {
  withData({ a: rec({ qq: { [MAR]: { q: MAR, cmp: 'no-prev', s: 100, e: 9 } } }) });
  assert.match(qrFail('A', ON(0), { on: false }, MAR)[0], /^F20: No Mar-2026 result from the year before/);
});

test('a stock with no result for the picked quarter fails each filter that is on with the same reason, under that filter\'s own code', () => {
  withData({ a: rec({}) });
  assert.deepEqual(qrFail('A', ON(0), ON(0), '2025-12-31'), ['F20: No Dec-2025 result on file (its latest is Sep-2026)', 'F21: No Dec-2025 result on file (its latest is Sep-2026)']);
});

test('F28 / F29 / F32 / F33 use the picked quarter and the quarter before IT: Jun-26 was +20% after Mar-26 +30% EPS YoY', () => {
  withData({ a: rec({}) });
  const change = (f28, f29, q) => Array.from(sb.qrYoyChangeReasons('A', f28, f29, q));
  assert.deepEqual(change(ON(0), ON(0), ''), []);                               // latest: +90% after +10%
  assert.equal(change(ON(0), { on: false }, JUN)[0], 'F28: EPS YoY went from +30.0% (Mar-2026) to +20.0% (Jun-2026): -10.0 pts, not > 0 pts');
  assert.equal(change({ on: false }, ON(0), JUN)[0], 'F29: Sales YoY went from +12.0% (Mar-2026) to +10.0% (Jun-2026): -2.0 pts, not > 0 pts');
  const turn = (f32, f33, q) => Array.from(sb.qrYoyTurnaroundReasons('A', f32, f33, q));
  assert.equal(turn({ on: true }, { on: false }, MAR)[0], 'F32: Not an EPS turnaround - YoY was already +5.0% in Dec-2025');   // Mar-26: -10% after +5% is the other way round
});

test('a turnaround in the picked quarter is found: previous quarter YoY negative, picked quarter YoY positive', () => {
  withData({ a: rec({ qq: { [JUN]: { q: JUN, cmp: 'ok', yy: [8, -4, 3, -2] } } }) });
  assert.deepEqual(Array.from(sb.qrYoyTurnaroundReasons('A', { on: true }, { on: true }, JUN)), []);
  assert.equal(Array.from(sb.qrYoyTurnaroundReasons('A', { on: true }, { on: true }, ''))[0], 'F32: Not an EPS turnaround - YoY was already +10.0% in Jun-2026');   // the latest: +90% after +10%
});

test('a stock with no result for the picked quarter fails F28 and F32 as well', () => {
  withData({ a: rec({}) });
  assert.deepEqual(Array.from(sb.qrYoyChangeReasons('A', ON(0), { on: false }, '2025-12-31')), ['F28: No Dec-2025 result on file (its latest is Sep-2026)']);
  assert.deepEqual(Array.from(sb.qrYoyTurnaroundReasons('A', { on: false }, { on: true }, '2025-12-31')), ['F33: No Dec-2025 result on file (its latest is Sep-2026)']);
});

// ── the hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('qrFilterState carries the picked quarter as f40 = { on, quarter }; any is true when only it is picked', () => {
  const dom = installFakeDom(sb, {});
  assert.deepEqual(JSON.parse(JSON.stringify(sb.qrFilterState().f40)), { on: false, quarter: '' });
  assert.equal(sb.qrFilterState().any, false);
  dom.el('scrF40Quarter').value = JUN;
  const s = JSON.parse(JSON.stringify(sb.qrFilterState()));
  assert.deepEqual(s.f40, { on: true, quarter: JUN });
  assert.equal(s.any, true);
});

test('qrApplyToStock judges and records the picked quarter: the table\'s figures and Result Qtr are that quarter\'s; a stock without it has none', () => {
  withData({ a: rec({}), old: rec({ q: JUN, qq: {} }) });
  const dom = installFakeDom(sb, { scrF20Val: '15', scrF28Val: '0' });
  dom.el('scrF20On').checked = true; dom.el('scrF28On').checked = true;
  const latest = { symbol: 'A' };
  assert.deepEqual(Array.from(sb.qrApplyToStock(latest, sb.qrFilterState())), []);
  assert.equal(latest._qrQtr, LATEST); assert.equal(latest._qrEarn, 50); assert.deepEqual([latest._qrYyNowE, latest._qrYyPrevE, latest._qrAccE], [90, 10, 80]);
  dom.el('scrF40Quarter').value = JUN;
  const picked = { symbol: 'A' };
  assert.deepEqual(Array.from(sb.qrApplyToStock(picked, sb.qrFilterState())).map(r => r.slice(0, 3)), ['F28']);   // +20 after +30 is not growth
  assert.equal(picked._qrQtr, JUN); assert.equal(picked._qrEarn, 20); assert.deepEqual([picked._qrYyNowE, picked._qrYyPrevE, picked._qrAccE], [20, 30, -10]);
  dom.el('scrF40Quarter').value = LATEST;
  const behind = { symbol: 'OLD' };
  const r = Array.from(sb.qrApplyToStock(behind, sb.qrFilterState()));
  assert.equal(r.length, 3);                                                     // F40 plus F20 and F28, each naming the missing quarter
  assert.ok(r.every(x => /No Sep-2026 result on file \(its latest is Jun-2026\)$/.test(x)));
  assert.equal(behind._qrQtr, ''); assert.ok(Number.isNaN(behind._qrEarn));
});

test('the tab counts the picker in its badge and the active count; on its own it adds no column but the quarter used', () => {
  const dom = installFakeDom(sb, {});
  withData({ a: rec({}) });
  assert.equal(sb.qrActiveCount(), 0);
  dom.el('scrF40Quarter').value = JUN;
  assert.equal(sb.qrActiveCount(), 1);
  dom.el('scrF21On').checked = true;
  assert.equal(sb.qrActiveCount(), 2);
  sb.qrUpdateBadge();
  assert.equal(dom.el('scrTabQtrCount').textContent, 2);
  dom.el('scrF21On').checked = false;
  assert.deepEqual(Array.from(sb.qrColumns(), c => c.label), ['Result Qtr']);
});

test('qrReset puts the picker back to blank', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF40Quarter').value = JUN;
  sb.qrReset();
  assert.equal(dom.el('scrF40Quarter').value, '');
});

// ── the picker's options ──────────────────────────────────────────────────────────────────────────────────────────────────

test('the options are "each stock\'s latest" and the newest quarter on file with the 7 before it, newest first; blank until the data loads', () => {
  const dom = installFakeDom(sb, {});
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'loading';
  sb.qrUpdateStatus();
  assert.equal(dom.el('scrF40Quarter').innerHTML, '<option value="">Each stock\'s latest quarter</option>');
  withData({ a: rec({}) });
  sb.qrUpdateStatus();
  const html = dom.el('scrF40Quarter').innerHTML;
  const values = [...html.matchAll(/value="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(values, ['', '2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30', '2025-03-31', '2024-12-31']);
  assert.match(html, /<option value="2026-09-30">Sep-2026<\/option>/); assert.match(html, /<option value="2024-12-31">Dec-2024<\/option>/);
});

test('rebuilding the options keeps a picked quarter that is still on the list, and drops one that is not (a later quarter moved the window)', () => {
  const dom = installFakeDom(sb, {});
  withData({ a: rec({}) });
  dom.el('scrF40Quarter').value = JUN;
  sb.qrUpdateQuarterOptions();
  assert.equal(dom.el('scrF40Quarter').value, JUN);
  withData({ a: rec({}) }, '2027-09-30');                                        // the window is now Sep-2027 back to Dec-2025: Jun-2026 is still in it
  sb.qrUpdateQuarterOptions();
  assert.equal(dom.el('scrF40Quarter').value, JUN);
  withData({ a: rec({}) }, '2028-12-31');                                        // ... and now it is not
  sb.qrUpdateQuarterOptions();
  assert.equal(dom.el('scrF40Quarter').value, '');
});

// ── presets and the page ──────────────────────────────────────────────────────────────────────────────────────────────────

test('presets: the picker is captured and restored as a select, and "— Select preset —" resets it; the removed latest-quarter rows are gone', () => {
  const fields = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => ({ id: f.id, type: f.type }));
  const def = vm.runInContext('DEFAULT_FILTER_STATE', sb);
  assert.deepEqual(fields.find(f => f.id === 'scrF40Quarter'), { id: 'scrF40Quarter', type: 'select' });
  assert.equal(def.scrF40Quarter, '');
  assert.ok(!fields.some(f => f.id === 'scrF40On') && !('scrF40On' in def), 'the old F40 switch is gone');
  for (const n of [26, 27, 30, 31]) { assert.ok(!fields.some(f => f.id === `scrF${n}On` || f.id === `scrF${n}Val`), `F${n} is no longer a preset field`); assert.ok(!(`scrF${n}On` in def)); }
});

test('index.html: the picker is at the top of the Quarterly Results pane, above both columns, with a blank first choice; F26 / F27 / F30 / F31 and the old switch are gone; the script version is bumped', () => {
  const html = read('index.html');
  const pane = html.indexOf('id="scrPaneQuarterly"'), multi = html.indexOf('id="scrPaneMulti"');
  const at = html.indexOf('id="scrF40Quarter"');
  assert.ok(at > pane && at < multi && at < html.indexOf('<div class="scr-qtr-col">', pane));
  assert.match(html, /<select id="scrF40Quarter">\s*<option value="">Each stock's latest quarter<\/option>/);
  assert.match(html, />Results for quarter:<\/span>/);
  for (const id of ['scrF26On', 'scrF27On', 'scrF30On', 'scrF31On', 'scrF40On']) assert.ok(!html.includes(`id="${id}"`), `${id} is gone`);
  assert.match(html, /quarterly-results\.js\?v=1[3-9]/);
});

test('screener.js still holds none of the Quarterly Results filters (no F2x / F3x / F40 ids)', () => {
  assert.ok(!/scrF2[0-9]|scrF3[0-3]|scrF40/.test(read('js/screener.js')));
});

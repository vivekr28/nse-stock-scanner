'use strict';
// Stock Scanner popup's "Relative Strength" tab (js/relative-strength.js): the % Change filter (F16) moved here from Technicals, and
// the new F24 "Close Above" - did the stock CLOSE above the Open/High/Low/Close of a chosen date on any of the next n trading days?
// Covers the pure check (window, strictness, non-trading dates, short data, partial history), F24 end to end through runScreener()
// with its column and fail reasons, the hooks, presets, and that F16 really moved (HTML, badge counts, tab switching) while its
// logic stayed in screener.js.
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

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/relative-strength.js', 'js/presets.js']);
const ts = iso => sb.scrIsoToTs(iso);
const realUpdateFilterBadge = sb.updateFilterBadge;   // runWith() below stubs it on the sandbox

// Mon 05-Oct-2026 .. Fri 16-Oct-2026 (10 trading days). The reference bar (Mon 05-Oct) has O 100 / H 110 / L 95 / C 105.
const DATES = ['05-Oct-2026', '06-Oct-2026', '07-Oct-2026', '08-Oct-2026', '09-Oct-2026', '12-Oct-2026', '13-Oct-2026', '14-Oct-2026', '15-Oct-2026', '16-Oct-2026'];
function series(closes) {
  return closes.map((c, i) => i === 0
    ? { date: DATES[0], open: 100, high: 110, low: 95, close: 105 }
    : { date: DATES[i], open: c, high: c + 1, low: c - 1, close: c });
}
const check = (closes, field = 'high', n = 5, from = '2026-10-05', partial = false) => sb.rsCloseAbove(series(closes), ts(from), field, n, partial);

// ── the pure check ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('passes when any close in the next n days is above the chosen field of the date, and says which day was first', () => {
  const r = check([105, 108, 109, 111, 112, 90]);          // closes 108 109 111 112 90 after the reference; High is 110
  assert.equal(r.ok, true);
  assert.equal(r.level, 110);
  assert.equal(r.hitDate, '08-Oct-2026');                  // 111 is the first close above 110
  assert.equal(r.refDate, '05-Oct-2026');
  assert.equal(r.best, 112);
});

test('strictly above: a close equal to the level does not count', () => {
  assert.equal(check([105, 110, 110, 110, 110, 110]).ok, false);
  assert.equal(check([105, 110, 110, 110, 110, 111]).ok, true);
});

test('the window is exactly n days after the date: a hit on day n+1 is too late, the date itself is not one of the n days', () => {
  const closes = [105, 100, 100, 100, 111, 100];           // the only close above 110 is the 4th day after the date
  assert.equal(check(closes, 'high', 3).ok, false);
  assert.equal(check(closes, 'high', 4).ok, true);
  assert.equal(check(closes, 'high', 10).ok, true);
  // the reference bar's own close (105) is above its Low (95) but must not count: nothing after it closes above 95? it does here, so build one that does not
  assert.equal(check([105, 90, 90, 90, 90, 90], 'low', 5).ok, false);
});

test('each of Open / High / Low / Close picks its own level', () => {
  const closes = [105, 97, 101, 104, 90, 90];              // after the date: 97 101 104 90 90
  assert.equal(check(closes, 'low').level, 95);   assert.equal(check(closes, 'low').ok, true);     // 97 > 95
  assert.equal(check(closes, 'open').level, 100); assert.equal(check(closes, 'open').ok, true);    // 101 > 100
  assert.equal(check(closes, 'close').level, 105); assert.equal(check(closes, 'close').ok, false); // 104 is not above 105
  assert.equal(check(closes, 'high').level, 110); assert.equal(check(closes, 'high').ok, false);
});

test('a date that is not a trading day uses the nearest earlier trading day (the same rule as the % Change filter)', () => {
  const r = check([105, 108, 109, 111, 112, 90], 'high', 5, '2026-10-10');   // Saturday 10-Oct: the Friday 09-Oct bar is the reference
  assert.equal(r.refDate, '09-Oct-2026');
});

test('fewer than n days of data after the date: it checks what exists and says how many there were', () => {
  const r = sb.rsCloseAbove(series([105, 108, 109]), ts('2026-10-05'), 'high', 5, false);
  assert.equal(r.ok, false);
  assert.equal(r.daysChecked, 2);
  assert.equal(r.requested, 5);
});

test('the date is the last bar: there are no days after it to look at', () => {
  const r = check([105, 108, 109], 'high', 5, '2026-10-07');
  assert.equal(r.ok, false);
  assert.match(r.reason, /No trading days after 07-Oct-2026/);
});

test('a stock with no bar on or before the date fails; "allow partial" uses its first bar instead', () => {
  const bars = series([105, 108, 109, 111, 112, 90]).slice(2);            // starts 07-Oct
  assert.match(sb.rsCloseAbove(bars, ts('2026-10-05'), 'high', 5, false).reason, /No data on\/before the date/);
  const r = sb.rsCloseAbove(bars, ts('2026-10-05'), 'high', 5, true);
  assert.equal(r.refDate, '07-Oct-2026');
});

test('bad input fails with a reason instead of passing: no date, n below 1, no data, no price on the date', () => {
  assert.match(sb.rsCloseAbove(series([105, 108]), NaN, 'high', 5, false).reason, /No date selected/);
  assert.match(check([105, 108], 'high', 0).reason, /at least 1/);
  assert.match(sb.rsCloseAbove([], ts('2026-10-05'), 'high', 5, false).reason, /No data/);
  const bars = series([105, 108]); bars[0].high = 0;
  assert.match(sb.rsCloseAbove(bars, ts('2026-10-05'), 'high', 5, false).reason, /Missing price/);
});

// ── F24 end to end through runScreener ─────────────────────────────────────────────────────────────────────────────────

function runWith(opts, stocks) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '',
  });
  dom.el('scrF24On').checked = opts.on !== false;
  dom.el('scrF24Field').value = opts.field || 'high';
  dom.el('scrF24Date').value = opts.date === undefined ? '2026-10-05' : opts.date;
  dom.el('scrF24Days').value = String(opts.days === undefined ? 5 : opts.days);
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in stocks) {
    const days = series(stocks[k]);
    const last = days[days.length - 1];
    latest[k] = { ...last, symbol: k, isin: k, prev: last.close, turnover: 10, changePct: 0, industry: 'X', sector: 'Y' };
    daily[k] = days;
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.runScreener();
  const passed = Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort();
  const failedList = Array.from(vm.runInContext('screenerFailed', sb));
  const failed = Object.fromEntries(failedList.map(s => [s.symbol, Array.from(s._failReasons).join('|')]));
  const passedRows = Object.fromEntries(Array.from(vm.runInContext('screenerPassed', sb), s => [s.symbol, s]));
  return { passed, failed, passedRows };
}

const STOCKS = {
  BREAKOUT: [105, 108, 109, 111, 112, 90],     // closes above 110 on 08-Oct
  LATE: [105, 100, 100, 100, 100, 100, 111],   // above only on day 6
  FLAT: [105, 100, 100, 100, 100, 100],
};

test('F24 through the scanner: breakout passes with its level and first day; the others fail with the reason', () => {
  const r = runWith({}, STOCKS);
  assert.deepEqual(r.passed, ['BREAKOUT']);
  assert.equal(r.passedRows.BREAKOUT._rsLevel, 110);
  assert.equal(r.passedRows.BREAKOUT._rsHit, '08-Oct-2026');
  assert.match(r.failed.FLAT, /^F24: No close above High 110\.00 of 05-Oct-2026 in the next 5 days - best close 100\.00$/);
  assert.match(r.failed.LATE, /in the next 5 days/);
});

test('F24: a longer window rescues the late breakout; another field changes the level', () => {
  assert.deepEqual(runWith({ days: 6 }, STOCKS).passed, ['BREAKOUT', 'LATE']);
  assert.deepEqual(runWith({ field: 'low', days: 5 }, STOCKS).passed, ['BREAKOUT', 'FLAT', 'LATE']);   // 100 > Low 95
});

test('F24 off: the controls are ignored; a blank date fails every stock with the reason', () => {
  assert.deepEqual(runWith({ on: false }, STOCKS).passed, ['BREAKOUT', 'FLAT', 'LATE']);
  const r = runWith({ date: '' }, STOCKS);
  assert.deepEqual(r.passed, []);
  assert.match(r.failed.FLAT, /F24: No date selected/);
});

test('F24: the columns appear only while it is on', () => {
  runWith({}, STOCKS);
  const on = Array.from(sb.rsColumns(), c => c.label);
  assert.deepEqual(on, ['High 05/10 (level)', 'First Close Above']);
  runWith({ on: false }, STOCKS);
  assert.deepEqual(Array.from(sb.rsColumns()), []);
});

// ── hooks, badges, reset, dates ────────────────────────────────────────────────────────────────────────────────────────

test('the tab counts F16 (% Change) and F24, and the scanner badge adds them; Technicals no longer counts F16', () => {
  const dom = installFakeDom(sb, {});
  dom.el('scrF16On').checked = true;
  assert.equal(sb.rsActiveCount(), 1);
  dom.el('scrF24On').checked = true;
  assert.equal(sb.rsActiveCount(), 2);
  sb.rsUpdateBadge();
  assert.equal(dom.el('scrTabRsCount').textContent, 2);
  assert.equal(dom.el('scrTabRsCount').style.display, 'inline-block');
  dom.el('scrF16On').checked = false; dom.el('scrF24On').checked = false;
  sb.rsUpdateBadge();
  assert.equal(dom.el('scrTabRsCount').style.display, 'none');

  dom.el('scrF16On').checked = true;
  dom.el('scrActiveFilterBadge');
  sb.updateApplyBtn = () => {};
  realUpdateFilterBadge();
  assert.equal(dom.el('scrTabTechCount').textContent, 0, 'F16 is not a Technicals filter any more');
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 1, 'but still counts in the total');
  assert.equal(dom.el('scrTabRsCount').textContent, 1);
});

test('rsInitDates fills the F24 date 10 bars before the latest and limits the picker to the loaded range; Reset All restores the defaults', () => {
  const dom = installFakeDom(sb, {});
  sb.Store.dates = ['01-Sep-2026', ...Array.from({ length: 20 }, (_, i) => `${String(i + 2).padStart(2, '0')}-Oct-2026`)];   // 21 dates, last 21-Oct
  sb.rsInitDates();
  assert.equal(dom.el('scrF24Date').min, '2026-09-01');
  assert.equal(dom.el('scrF24Date').max, '2026-10-21');
  assert.equal(dom.el('scrF24Date').value, '2026-10-11');
  dom.el('scrF24On').checked = true; dom.el('scrF24Field').value = 'low'; dom.el('scrF24Days').value = '9'; dom.el('scrF24Date').value = '2026-09-02';
  sb.rsReset();
  assert.equal(dom.el('scrF24On').checked, false);
  assert.equal(dom.el('scrF24Field').value, 'high');
  assert.equal(dom.el('scrF24Days').value, '5');
  assert.equal(dom.el('scrF24Date').value, '2026-10-11');
});

test('presets: the four F24 controls are captured and restored; "— Select preset —" resets them (date untouched, like F16)', () => {
  const ids = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => f.id);
  const DEFAULTS = vm.runInContext('DEFAULT_FILTER_STATE', sb);
  for (const id of ['scrF24On', 'scrF24Field', 'scrF24Date', 'scrF24Days']) assert.ok(ids.includes(id), id);
  assert.equal(DEFAULTS.scrF24On, false);
  assert.equal(DEFAULTS.scrF24Field, 'high');
  assert.equal(DEFAULTS.scrF24Days, '5');
  assert.equal('scrF24Date' in DEFAULTS, false);
});

// ── F16 moved: the page, tab switching and the guards that keep the logic out of the scanner ──────────────────────────────

test('index.html: F16 is in the Relative Strength pane (with F24), no longer in Technicals; ids unchanged so saved presets still load', () => {
  const pane = id => { const i = html.indexOf(`id="${id}"`); return i; };
  const rsStart = pane('scrPaneRelStrength'), qtrStart = pane('scrPaneQuarterly'), techStart = pane('scrPaneTechnicals'), indStart = pane('scrPaneIndustry');
  for (const id of ['scrF16On', 'scrF16FromDate', 'scrF16FromField', 'scrF16ToDate', 'scrF16ToField', 'scrF16Val', 'scrF24On', 'scrF24Field', 'scrF24Date', 'scrF24Days']) {
    const at = pane(id);
    assert.ok(at > rsStart && at < qtrStart, `${id} is in the Relative Strength pane`);
  }
  assert.ok(!(pane('scrF16On') > techStart && pane('scrF16On') < indStart), 'F16 is not in the Technicals pane');
  assert.ok(html.includes("onclick=\"switchFilterTab('relstrength')\""));
  assert.ok(html.indexOf('id="scrTabRelStrength"') > html.indexOf('id="scrTabTechnicals"') && html.indexOf('id="scrTabRelStrength"') < html.indexOf('id="scrTabIndustry"'));
  assert.ok(html.includes('js/relative-strength.js'));
});

test('switchFilterTab shows only the Relative Strength pane for its tab, and the other tabs hide it', () => {
  const dom = installFakeDom(sb, {});
  sb.updateApplyBtn = () => {};
  sb.switchFilterTab('relstrength');
  assert.equal(dom.el('scrPaneRelStrength').style.display, '');
  for (const p of ['scrPaneTechnicals', 'scrPaneIndustry', 'scrPaneQuarterly', 'scrPaneMulti']) assert.equal(dom.el(p).style.display, 'none', p);
  sb.switchFilterTab('technicals');
  assert.equal(dom.el('scrPaneRelStrength').style.display, 'none');
});

test('the As of Date tab hides the new pane and tab when it opens', () => {
  const src = read('js/asof-scan.js');
  assert.ok(/ASOF_OTHER_PANES = \[[^\]]*'scrPaneRelStrength'/.test(src));
  assert.ok(/ASOF_OTHER_TABS = \[[^\]]*'scrTabRelStrength'/.test(src));
});

test('screener.js holds none of F24: no controls, fields, columns or check; F16 stays there', () => {
  const scr = read('js/screener.js');
  assert.ok(!/scrF24|rsCloseAbove|_rsLevel|_rsHit|RS_FIELD_LABEL/.test(scr), 'F24 lives in js/relative-strength.js');
  assert.ok(/computeDynDateChange/.test(scr) && /scrF16On/.test(scr), "F16's logic did not move");
  assert.ok(!/'scrF16On'\s*,\s*'scrF18On'/.test(scr) && !/scrF15On','scrF16On/.test(scr), 'F16 is not in the Technicals badge list');
  // rsApplyToStock is only reached when rsFilterState() returned a state, so it needs no guard of its own
  for (const hook of ['rsFilterState', 'rsColumns', 'rsReset', 'rsActiveCount', 'rsUpdateBadge']) {
    assert.ok(new RegExp(`typeof ${hook} === 'function'`).test(scr), `${hook} is guarded by typeof`);
  }
});

test('script order: relative-strength.js loads after screener.js (it uses its date helpers) and before ui.js', () => {
  const i = n => html.indexOf(`<script src="js/${n}.js`);
  assert.ok(i('screener') < i('relative-strength') && i('relative-strength') < i('ui'));
});

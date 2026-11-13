'use strict';
// The Stock Scanner's Technicals filter F45 "RS Rating": keep a stock when its RS rating (99 = best price performer ... 1 = worst, over
// 1M / 3M / 6M / 1Y, the same ranks as the Relative Strength tab, js/rs-rank.js) is strictly above a number. Covers the filter end to
// end through runScreener() (strict comparison, period choice, no-rating stocks, fail wording, the value kept for the column, off = no
// effect), that the scanner and the tab use the same ranks, presets, and the markup (right below Listed Date).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const read = f => fs.readFileSync(path.join(path.dirname(__dirname), f), 'utf8');
const html = read('index.html');
const sb = loadScripts(['js/utils.js', 'js/money-flow.js', 'js/breadth.js', 'js/screener.js', 'js/rs-rank.js', 'js/presets.js']);

// 10 stocks with 80 bars each: flat at 100 and a last close of 100, 110, ... 190 -> the same performance in every period, so
// P9 (+90%) is rank 99 and P0 (0%) rank 1. NEW has 30 bars: enough for a 1M rating, not for a 3M one.
const flatThen = last => Array.from({ length: 80 }, (_, i) => ({ date: 'D' + i, open: 100, high: 100, low: 100, close: i === 79 ? last : 100, turnover: 10 }));
const FIXTURE = {};
for (let i = 0; i < 10; i++) FIXTURE['P' + i] = flatThen(100 + i * 10);
FIXTURE.NEW = Array.from({ length: 30 }, (_, i) => ({ date: 'N' + i, open: 100, high: 100, low: 100, close: 100 + i, turnover: 10 }));

function runWith(over, stocks = FIXTURE) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '',
  });
  dom.el('scrAllowPartial').checked = false;
  for (const [id, v] of Object.entries(over)) {
    if (typeof v === 'boolean') dom.el(id).checked = v; else dom.el(id).value = String(v);
  }
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in stocks) {
    const days = stocks[k];
    latest[k] = { symbol: k, isin: k, turnover: 10, changePct: 0, industry: 'X', sector: 'Y', ...days[days.length - 1] };
    daily[k] = days;
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.Store.latestDate = 'test-' + Math.random();          // a new data load: the RS ranks are rebuilt
  sb.runScreener();
  const passed = Array.from(vm.runInContext('screenerPassed', sb)), failed = Array.from(vm.runInContext('screenerFailed', sb));
  return { passed: passed.map(s => s.symbol).sort(), failed, byName: Object.fromEntries(passed.concat(failed).map(s => [s.symbol, s])) };
}
const F45 = (period, val) => ({ scrF45On: true, scrF45Period: period, scrF45Val: val });

test('keeps only the stocks whose RS rating is above the number; the comparison is strict', () => {
  const r = runWith(F45('3m', 80));
  const rating = k => r.byName[k]._f45Rs;
  assert.equal(rating('P9'), 99);
  assert.equal(rating('P0'), 1);
  assert.deepEqual(r.passed, ['P8', 'P9']);                                  // 88 and 99; 77 does not pass
  assert.equal(rating('P8'), 88);
  assert.deepEqual(runWith(F45('3m', 88)).passed, ['P9']);                   // 88 is not above 88
  assert.deepEqual(runWith(F45('3m', 87)).passed, ['P8', 'P9']);
  assert.deepEqual(runWith(F45('3m', 99)).passed, []);                       // nothing is above 99
});

test('a stock without a full period of history has no rating and is rejected, with the reason', () => {
  const r = runWith(F45('3m', 0));
  assert.ok(!r.passed.includes('NEW'));
  assert.ok(isNaN(r.byName.NEW._f45Rs));
  assert.match(r.byName.NEW._failReasons.join(' | '), /F45: No 3M RS rating \(needs 64 trading days of history\)/);
  assert.equal(r.passed.length, 10);                                         // every rated stock (P0 is rank 1, above 0) passes; only NEW is out
});

test('stocks failing the number say which rating they have', () => {
  const r = runWith(F45('3m', 80));
  assert.match(r.byName.P3._failReasons.join(' | '), /F45: 3M RS 34 not above 80/);
});

test('the period picks the ranking: 1M, 3M, 6M and 1Y use their own lookbacks, and the scanner agrees with the tab', () => {
  for (const [period, needs] of [['1m', 22], ['3m', 64], ['6m', 127], ['1y', 251]]) {
    const r = runWith(F45(period, 50));
    for (const k of Object.keys(FIXTURE)) {
      const expected = sb.rsrRankOf(k, period);                              // the Relative Strength tab's rank
      assert.ok(Object.is(r.byName[k]._f45Rs, expected), `${k} ${period}`);
      assert.equal(r.passed.includes(k), expected > 50, `${k} ${period} pass`);
    }
    if (needs > 80) assert.deepEqual(r.passed, []);                          // 80 bars: no 6M / 1Y ratings at all
  }
  assert.ok(runWith(F45('1m', 0)).byName.NEW._f45Rs > 0);                    // NEW has 30 bars: it IS rated over 1M
});

test('a blank or invalid rating means 0 (every rated stock passes); an unknown period falls back to 3M', () => {
  assert.equal(runWith(F45('3m', '')).passed.length, 10);
  assert.equal(runWith(F45('3m', 'abc')).passed.length, 10);
  assert.deepEqual(runWith(F45('bogus', 80)).passed, ['P8', 'P9']);
});

test('F45 off: nothing is filtered and no F45 reason appears', () => {
  const r = runWith({});
  assert.equal(r.passed.length, 11);
  assert.ok(!r.failed.some(s => (s._failReasons || []).some(x => /F45/.test(x))));
});

test('F45 combines with another filter: both must pass', () => {
  const r = runWith({ ...F45('3m', 50), scrF3On: true, scrF3Val: '5' });      // Day Chg > 5%: nobody has one (changePct 0)
  assert.deepEqual(r.passed, []);
});

test('without js/rs-rank.js the filter says so instead of silently passing everything', () => {
  const bare = loadScripts(['js/utils.js', 'js/money-flow.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
  const dom = installFakeDom(bare, { scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m', scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '', scrF45Period: '3m', scrF45Val: '80' });
  dom.el('scrF45On').checked = true;
  bare.renderScreenerTable = () => {}; bare.updateToggleButton = () => {}; bare.updateFilterBadge = () => {};
  bare.Store.latestBySymbol = { A: { symbol: 'A', isin: 'A', turnover: 10, changePct: 0, industry: 'X', sector: 'Y', close: 100 } };
  bare.Store.dailyBySymbol = { A: flatThen(100) };
  bare.runScreener();
  assert.equal(vm.runInContext('screenerPassed', bare).length, 0);
  assert.match(vm.runInContext('screenerFailed', bare)[0]._failReasons.join(), /RS ranks unavailable/);
});

// ─── presets, reset, badge, markup ──────────────────────────────────────────────

test('F45 is saved in presets, has a default for old presets, is reset by Reset All, and counts in the Technicals badge', () => {
  const ids = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => f.id);
  for (const id of ['scrF45On', 'scrF45Period', 'scrF45Val']) assert.ok(ids.includes(id), id);
  const scr = read('js/screener.js'), pre = read('js/presets.js');
  assert.match(pre, /scrF45On: false, scrF45Period: '3m', scrF45Val: '80'/);
  assert.match(scr, /getElementById\('scrF45On'\)\.checked = false;[\s\S]{0,200}scrF45Period'\)\.value = '3m';[\s\S]{0,120}scrF45Val'\)\.value = '80'/);
  assert.match(scr, /'scrF19On','scrF42On','scrF45On'\]/);
  assert.match(scr, /f42On, f45On\]\.filter\(Boolean\)/);
});

test('the F45 row sits in the Technicals tab right below Listed Date, with a period drop-down and a rating box', () => {
  const at = s => html.indexOf(s);
  assert.ok(at('id="scrF19Date"') > 0 && at('id="scrF19Date"') < at('id="scrF45On"'));
  assert.ok(at('id="scrF45Val"') < at('id="scrPaneRelStrength"'), 'inside the Technicals pane');
  assert.ok(at('id="scrF45On"') - at('id="scrF19Date"') < 600, 'directly after the F19 row');
  assert.match(html, /<select id="scrF45Period"[^>]*>\s*<option value="1m">1M<\/option>\s*<option value="3m" selected>3M<\/option>\s*<option value="6m">6M<\/option>\s*<option value="1y">1Y<\/option>\s*<\/select>/);
  assert.match(html, /<input type="number" id="scrF45Val" value="80"/);
});

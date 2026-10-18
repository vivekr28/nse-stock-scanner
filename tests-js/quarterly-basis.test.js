'use strict';
// The standalone-vs-consolidated fallback, browser side. When a quarter and its year-ago quarter were filed on different bases
// the server compares them on a basis both hold and says which ('S' / 'C', field `ab`; chart rows carry three extra items).
// The chart table marks those %Chg cells (S) / (C) with a hover, the scanner says so in its fail reasons and shows it beside the
// result quarter. The server's side is tests/test_quarterly_basis.py. Hand-built data, as in the other quarterly tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/quarterly-chart-table.js']);
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');

const rec = o => Object.assign({ q: '2026-09-30', b: 'C', cmp: 'ok', s: 160.9, sp: 74.7, e: 58.8, ep: 28.4, sg: 115.4, eg: 107.06, st: false, et: false }, o);
function withData(bySymbol) {
  sb.Store.quarterly = { bySymbol, latestQuarter: '2026-09-30' };
  sb.Store.quarterlyState = 'ready';
}
// SGFIN as the server builds it: the last quarter was compared on Standalone
const SGFIN_H = [
  ['2026-03-31', 105.4, null, 7.45, null, 'no-prev', 0],
  ['2026-06-30', 136.1, null, 8.21, null, 'no-prev', 0],
  ['2026-09-30', 160.9, 115.4, 8.93, 76.57, 'ok', 0, 'S', 160.9, 74.7],
];
// the body rows' cells as raw HTML: [quarter, EPS, %Chg, Sales, %Chg]
const cells = html => [...html.matchAll(/<tr><th>([^<]*)<\/th><td[^>]*>(.*?)<\/td><td([^>]*)>(.*?)<\/td><td[^>]*>(.*?)<\/td><td([^>]*)>(.*?)<\/td><\/tr>/g)]
  .map(m => ({ q: m[1], eps: m[2], epsPct: m[4], epsPctAttrs: m[3], sales: m[5], salesPct: m[7], salesPctAttrs: m[6] }));

test('chart table: a quarter compared on the other basis shows its change marked (S), the stock\'s own sales and EPS unchanged', () => {
  withData({ sgfin: rec({ ab: 'S', h: SGFIN_H }) });
  const html = sb.qctTableHtml({ symbol: 'SGFIN', bandPct: '20%' });
  const top = cells(html)[0];
  assert.equal(top.q, 'Sep-26');
  assert.equal(top.eps, '8.93');                                   // the quarter's own EPS and sales
  assert.equal(top.sales, '160.9');
  assert.match(top.epsPct, /^\+77%<span class="ic-qtr-basis">\(S\)<\/span>$/);
  assert.match(top.salesPct, /^\+115%<span class="ic-qtr-basis">\(S\)<\/span>$/);
});

test('chart table: the hover explains the basis and gives the sales it was computed from', () => {
  withData({ sgfin: rec({ ab: 'S', h: SGFIN_H }) });
  const top = cells(sb.qctTableHtml({ symbol: 'SGFIN' }))[0];
  assert.match(top.salesPctAttrs, /title="The year-ago quarter was filed on a different basis, so this change is computed on Standalone results: sales 160\.9 Cr vs 74\.7 Cr a year ago\. The sales shown are the quarter&#39;s own figure\."/);
  assert.match(top.epsPctAttrs, /computed on Standalone results\./);
});

test('chart table: Consolidated is named when that was the basis; quarters on one basis carry no marker', () => {
  withData({ x: rec({ ab: 'C', h: [['2026-09-30', 180, 50, 1.8, 50, 'ok', 0, 'C', 180, 120]] }), sgfin: rec({ ab: 'S', h: SGFIN_H }) });
  assert.match(cells(sb.qctTableHtml({ symbol: 'X' }))[0].salesPctAttrs, /computed on Consolidated results/);
  assert.match(cells(sb.qctTableHtml({ symbol: 'X' }))[0].salesPct, /\(C\)/);
  const rows = cells(sb.qctTableHtml({ symbol: 'SGFIN' }));
  assert.ok(rows.slice(1).every(r => !/ic-qtr-basis/.test(r.salesPct + r.epsPct)), 'earlier quarters are unmarked');
});

test('chart table: a quarter that still cannot be compared stays a dash with no marker', () => {
  withData({ x: rec({ cmp: 'basis', h: [['2026-09-30', 160.9, null, 8.93, null, 'basis', 0]] }) });
  const top = cells(sb.qctTableHtml({ symbol: 'X' }))[0];
  assert.match(top.salesPct, /^-$/);
  assert.ok(!/ic-qtr-basis/.test(top.salesPct));
});

test('scanner: the reasons for a stock compared on the other basis say so; others are unchanged', () => {
  withData({ sgfin: rec({ ab: 'S', eg: 10, sg: 5 }), plain: rec({ eg: 10, sg: 5 }) });
  const F = (sym) => Array.from(sb.qrFailReasons(sym, { on: true, min: 20 }, { on: true, min: 10 }, { on: false }, { on: false }));
  assert.deepEqual(F('SGFIN'), [
    'F20: Earnings Sep-2026 +10.0% YoY, not > 20% (compared on Standalone results)',
    'F21: Sales Sep-2026 +5.0% YoY, not > 10% (compared on Standalone results)']);
  assert.deepEqual(F('PLAIN'), ['F20: Earnings Sep-2026 +10.0% YoY, not > 20%', 'F21: Sales Sep-2026 +5.0% YoY, not > 10%']);
  withData({ sgfin: rec({ ab: 'S', eg: 50, sg: 50 }) });
  assert.deepEqual(F('SGFIN'), []);                                  // passes: no reasons, no suffix
});

test('scanner: a stock whose comparison is still impossible keeps the old "different bases" reason', () => {
  withData({ x: rec({ cmp: 'basis', sg: null, eg: null }) });
  const r = Array.from(sb.qrFailReasons('X', { on: true, min: 20 }, { on: false }, { on: false }, { on: false }));
  assert.match(r[0], /^F20: Sep-2026 and last year's quarter are on different bases \(standalone vs consolidated\)$/);
});

test('scanner: the Result Qtr column shows (S) / (C) for a stock compared on the other basis', () => {
  const dom = installFakeDom(sb, { scrF20Val: '20', scrF21Val: '10' });
  dom.el('scrF20On').checked = true;
  withData({ sgfin: rec({ ab: 'S' }), plain: rec({}) });
  const state = sb.qrFilterState();
  const s1 = { symbol: 'SGFIN' }, s2 = { symbol: 'PLAIN' };
  sb.qrApplyToStock(s1, state); sb.qrApplyToStock(s2, state);
  assert.equal(s1._qrBasis, 'S');
  assert.equal(s2._qrBasis, '');
  const col = Array.from(sb.qrColumns()).find(c => c.key === '_qrQtr');
  assert.equal(col.fmt(s1._qrQtr, s1), 'Sep-2026 (S)');
  assert.equal(col.fmt(s2._qrQtr, s2), 'Sep-2026');
});

test('wiring: the stylesheet has the marker style and index.html loads the new versions', () => {
  assert.match(read('css/styles.css'), /\.ic-qtr-basis\s*\{/);
  const html = read('index.html');
  assert.ok(/styles\.css\?v=15/.test(html) && /quarterly-results\.js\?v=9/.test(html) && /quarterly-chart-table\.js\?v=2/.test(html));
});

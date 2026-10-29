'use strict';
// The chart table shows the % change of EPS, (new - old) / |old| (a rise is always +), where the year-ago EPS was a loss (the server sends it as
// rec.hx for display), instead of "n/a" or the word "Turnaround": only numbers and % change, no markers, no extra wording. A zero year-ago EPS
// cannot be divided, so it still reads n/a. Real case: DEEPINDS Mar-26 (EPS -2.24 against -32.68). The server's side is tests/test_quarterly_lossbase.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/quarterly-chart-table.js']);
const rec = o => Object.assign({ q: '2026-06-30', b: 'C', cmp: 'ok', s: 130, sp: 100, e: 15, ep: 10, sg: 30, eg: 50, st: false, et: false }, o);
function withData(bySymbol) {
  sb.Store.quarterly = { bySymbol, latestQuarter: '2026-06-30' };
  sb.Store.quarterlyState = 'ready';
}
// h entry (oldest first): [quarter-end, sales Rs cr, sales growth %, EPS, EPS growth %, cmp, EPS turnaround 1/0]
const H = (q, sales, sg, eps, epsg, cmp = 'ok', epst = 0) => [q, sales, sg, eps, epsg, cmp, epst];
// the EPS %Chg cell of each body row, as { text, cls, title }, newest first
const epsCells = html => [...html.matchAll(/<tr><th>([^<]*)<\/th><td[^>]*>(.*?)<\/td><td class="([^"]*)"([^>]*)>(.*?)<\/td>/g)]
  .map(m => ({ q: m[1], text: m[5], cls: m[3], attrs: m[4] }));

test('a loss that narrows is a positive number: -2.24 against -32.68 is +93%', () => {
  withData({ deepinds: rec({ h: [H('2025-03-31', 167.2, 39.75, -32.68, -670.33), H('2026-03-31', 248.7, 48.72, -2.24, null)], hx: { 1: { e: 93.15 } } }) });
  const [mar26] = epsCells(sb.qctTableHtml({ symbol: 'DEEPINDS', bandPct: '20%' }));
  assert.equal(mar26.q, 'Mar-26');
  assert.equal(mar26.text, '+93%');
  assert.equal(mar26.cls, 'positive');
  assert.equal(mar26.attrs.trim(), '');                              // no hover, no marker: just the number
});

test('a loss that widens, one that goes to a profit, and one that goes to zero: each is just its number', () => {
  withData({ a: rec({ h: [H('2025-03-31', 100, 5, -5, null), H('2025-06-30', 100, 5, -5, null), H('2025-09-30', 100, 5, -5, null),
                          H('2026-03-31', 100, 5, -10, null), H('2026-06-30', 100, 5, 10, null, 'ok', 1), H('2026-09-30', 100, 5, 0, null)],
                    hx: { 3: { e: -100 }, 4: { e: 300 }, 5: { e: 100 } } }) });
  const rows = epsCells(sb.qctTableHtml({ symbol: 'A', bandPct: '20%' }));
  assert.deepEqual(rows.map(r => [r.q, r.text]), [['Sep-26', '+100%'], ['Jun-26', '+300%'], ['Mar-26', '-100%'], ['Sep-25', 'n/a'], ['Jun-25', 'n/a'], ['Mar-25', 'n/a']]);
  assert.equal(rows[2].cls, 'negative');                              // the loss grew (EPS fell): red
  assert.equal(rows[1].cls, 'positive');                              // loss to profit: green
});

test('the word "Turnaround" is not shown, with or without the number', () => {
  withData({ a: rec({ h: [H('2025-12-31', 100, 5, -3, null), H('2026-03-31', 100, 5, -3, null), H('2026-06-30', 100, 5, 4, null, 'ok', 1)], hx: { 2: { e: 233.33 } } }),
             b: rec({ h: [H('2025-12-31', 100, 5, 4, null, 'ok', 1)] }) });                          // an older server: no hx
  assert.ok(!/turnaround/i.test(sb.qctTableHtml({ symbol: 'A' })));
  assert.ok(!/turnaround/i.test(sb.qctTableHtml({ symbol: 'B' })));
  assert.equal(epsCells(sb.qctTableHtml({ symbol: 'A' }))[0].text, '+233%');
  assert.equal(epsCells(sb.qctTableHtml({ symbol: 'B' }))[0].text, 'n/a');
});

test('a zero year-ago EPS cannot be divided: it stays n/a, and the hover says why', () => {
  withData({ a: rec({ h: [H('2025-12-31', 100, 5, 4, null)] }) });
  const [row] = epsCells(sb.qctTableHtml({ symbol: 'A' }));
  assert.equal(row.text, 'n/a');
  assert.match(row.attrs, /No % change: the same quarter a year ago had zero EPS/);
});

test('a positive base is unchanged, and the number goes to the right quarter (the index is oldest first)', () => {
  withData({ a: rec({ h: [H('2025-09-30', 100, 5, 4, 25), H('2025-12-31', 100, 5, -4, null), H('2026-03-31', 100, 5, -2, null), H('2026-06-30', 100, 5, 6, 50)], hx: { 2: { e: 50 } } }) });
  assert.deepEqual(epsCells(sb.qctTableHtml({ symbol: 'A' })).map(r => [r.q, r.text]), [['Jun-26', '+50%'], ['Mar-26', '+50%'], ['Dec-25', 'n/a'], ['Sep-25', '+25%']]);
});

test('a quarter with no EPS reported still shows a dash, whatever the server sent', () => {
  withData({ a: rec({ h: [H('2026-03-31', 100, 5, null, null)], hx: { 0: { e: -10 } } }) });
  assert.equal(epsCells(sb.qctTableHtml({ symbol: 'A' }))[0].text, '-');
});

// the sales %Chg cell of each body row, newest first
const salesCells = html => [...html.matchAll(/<tr><th>([^<]*)<\/th><td[^>]*>.*?<\/td><td[^>]*>.*?<\/td><td[^>]*>.*?<\/td><td class="([^"]*)"([^>]*)>(.*?)<\/td>/g)]
  .map(m => ({ q: m[1], text: m[4], cls: m[2] }));

test('year-ago negative sales show the same (new - old) / |old| number: a rise is +, a fall is -', () => {
  withData({ a: rec({ h: [H('2025-03-31', -2.2, null, 5, 10), H('2026-03-31', 18.2, null, 5, 10)], hx: { 1: { s: 927.27 } } }),
             b: rec({ h: [H('2025-03-31', -2.2, null, 5, 10), H('2026-03-31', -3.4, null, 5, 10)], hx: { 1: { s: -54.55 } } }) });
  assert.deepEqual(salesCells(sb.qctTableHtml({ symbol: 'A' }))[0], { q: 'Mar-26', text: '+927%', cls: 'positive' });
  assert.deepEqual(salesCells(sb.qctTableHtml({ symbol: 'B' }))[0], { q: 'Mar-26', text: '-55%', cls: 'negative' });
});

test('a rise from a ZERO year-ago figure has no % but reads green n/a; a fall to a loss reads red n/a', () => {
  withData({ a: rec({ h: [H('2025-03-31', 100, 5, 0, null), H('2026-03-31', 100, 5, 5, null)], hx: { 1: { ez: 1, sz: 1 } } }),
             b: rec({ h: [H('2025-03-31', 100, 5, 0, null), H('2026-03-31', 100, 5, -5, null)], hx: { 1: { ez: -1 } } }) });
  assert.deepEqual(epsCells(sb.qctTableHtml({ symbol: 'A' }))[0], { q: 'Mar-26', text: 'n/a', cls: 'positive', attrs: ' title="No % change: the same quarter a year ago had zero EPS"' });
  assert.equal(epsCells(sb.qctTableHtml({ symbol: 'B' }))[0].cls, 'negative');
});

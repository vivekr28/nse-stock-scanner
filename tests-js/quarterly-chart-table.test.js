'use strict';
// js/quarterly-chart-table.js: the table over the single-stock chart (last 10 quarters, newest first: EPS, sales and their
// change vs a year earlier, then the price band) and its placement in the bottom-right corner of the CANDLE pane.
// The numbers come from js/quarterly-results.js (loaded alongside, as in index.html); the server's side is
// tests/test_quarterly_growth.py. The table logic is pure apart from reading Store, so it is tested here on hand-built data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/quarterly-results.js', 'js/quarterly-chart-table.js']);
const read = rel => fs.readFileSync(path.join(path.dirname(__dirname), rel), 'utf8');

function rec(o) {
  return Object.assign({ q: '2024-12-31', b: 'C', cmp: 'ok', s: 130, sp: 100, e: 15, ep: 10, sg: 30, eg: 50, st: false, et: false }, o);
}
function withData(bySymbol) {
  sb.Store.quarterly = { bySymbol, latestQuarter: '2024-12-31' };
  sb.Store.quarterlyState = 'ready';
}

// ── the single-stock chart's table: the last 10 quarters (newest first) with EPS, sales and their change vs a year ago ──
// h entry (oldest first): [quarter-end, sales Rs cr, sales growth %, EPS, EPS growth %, cmp, EPS turnaround 1/0]
const H = (q, sales, sg, eps, epsg, cmp = 'ok', epst = 0) => [q, sales, sg, eps, epsg, cmp, epst];
// Bharti Airtel exactly as the server builds it (oldest first) - the user's reference table
const BHARTI_H = [
  H('2024-03-31', 37599.1, 4.42, 3.61, -31.89), H('2024-06-30', 38506.4, 2.85, 7.21, 153.87), H('2024-09-30', 41473.3, 11.96, 6.21, 163.14),
  H('2024-12-31', 45129.3, 19.08, 25.54, 498.13), H('2025-03-31', 47876.2, 27.33, 19.02, 426.87), H('2025-06-30', 49462.6, 28.45, 10.26, 42.3),
  H('2025-09-30', 52145.4, 25.73, 11.66, 87.76), H('2025-12-31', 53981.6, 19.62, 11.44, -55.21), H('2026-03-31', 55383.2, 15.68, 12.53, -34.12),
  H('2026-06-30', 58539.1, 18.35, 13.38, 30.41),
];
// the body rows of the table as arrays of cell texts: [quarter, EPS, %Chg, Sales, %Chg]
const bodyRows = html => [...html.matchAll(/<tr><th>([^<]*)<\/th><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><\/tr>/g)]
  .map(m => m.slice(1, 6).map(s => s.replace(/<[^>]*>/g, '')));

test('chart table: header Quarterly | EPS | %Chg | Sales (Cr) | %Chg, then one row per quarter, LATEST AT THE TOP', () => {
  withData({ aaa: rec({ h: BHARTI_H }) });
  const html = sb.qctTableHtml({ symbol: 'AAA', bandPct: '20%' });
  assert.match(html, /<tr><th>Quarterly<\/th><th>EPS<\/th><th>%Chg<\/th><th>Sales \(Cr\)<\/th><th>%Chg<\/th><\/tr>/);
  assert.deepEqual(bodyRows(html).map(r => r[0]), ['Jun-26', 'Mar-26', 'Dec-25', 'Sep-25', 'Jun-25', 'Mar-25', 'Dec-24', 'Sep-24', 'Jun-24', 'Mar-24']);
});

test('chart table: reproduces the reference table for Bharti Airtel (EPS, %Chg, Sales (Cr), %Chg)', () => {
  withData({ aaa: rec({ h: BHARTI_H }) });
  assert.deepEqual(bodyRows(sb.qctTableHtml({ symbol: 'AAA', bandPct: 'No Band%' })), [
    ['Jun-26', '13.38', '+30%', '58,539.1', '+18%'],
    ['Mar-26', '12.53', '-34%', '55,383.2', '+16%'],
    ['Dec-25', '11.44', '-55%', '53,981.6', '+20%'],
    ['Sep-25', '11.66', '+88%', '52,145.4', '+26%'],   // the reference shows 11.72 / +89%: that source adjusts this quarter's EPS; we show it as filed
    ['Jun-25', '10.26', '+42%', '49,462.6', '+28%'],
    ['Mar-25', '19.02', '+427%', '47,876.2', '+27%'],
    ['Dec-24', '25.54', '+498%', '45,129.3', '+19%'],
    ['Sep-24', '6.21', '+163%', '41,473.3', '+12%'],
    ['Jun-24', '7.21', '+154%', '38,506.4', '+3%'],
    ['Mar-24', '3.61', '-32%', '37,599.1', '+4%'],
  ]);
});

test('chart table: changes are whole percents coloured by sign; sales use one decimal and Indian grouping', () => {
  withData({ aaa: rec({ h: [H('2026-03-31', 240167.83, -0.4, 12.5, 0.2), H('2026-06-30', 1234.56, 12.5, -2.5, -150.4)] }) });
  const html = sb.qctTableHtml({ symbol: 'AAA', bandPct: '5%' });
  assert.deepEqual(bodyRows(html), [['Jun-26', '-2.50', '-150%', '1,234.6', '+13%'], ['Mar-26', '12.50', '0%', '2,40,167.8', '0%']]);   // 12.5 rounds up; -0.4 and +0.2 round to 0
  const jun = /<tr><th>Jun-26<\/th>.*?<\/tr>/.exec(html)[0];
  assert.match(jun, /<td class="negative"[^>]*>-150%<\/td>/);
  assert.match(jun, /<td class="positive"[^>]*>\+13%<\/td>/);
});

test('chart table: an EPS turnaround is labelled; a change from a zero or loss base reads n/a', () => {
  withData({ aaa: rec({ h: [H('2025-09-30', 100, 5, 4, null, 'ok', 0), H('2025-12-31', 100, 5, 4, null, 'ok', 1)] }) });
  const rows = bodyRows(sb.qctTableHtml({ symbol: 'AAA', bandPct: '20%' }));
  assert.deepEqual(rows.map(r => r[2]), ['Turnaround', 'n/a']);   // newest first: Dec-25 is the turnaround
});

test('chart table: a quarter that cannot be compared shows its figures with a dash and the reason on hover', () => {
  withData({ aaa: rec({ h: [H('2025-03-31', 100, null, 3, null, 'no-prev'), H('2025-06-30', 110, null, 3.3, null, 'basis'), H('2025-09-30', null, null, 3.5, 9, 'scale')] }) });
  const html = sb.qctTableHtml({ symbol: 'AAA', bandPct: '20%' });
  assert.deepEqual(bodyRows(html), [['Sep-25', '3.50', '+9%', '-', '-'], ['Jun-25', '3.30', '-', '110.0', '-'], ['Mar-25', '3.00', '-', '100.0', '-']]);
  assert.match(html, /title="Standalone vs consolidated differs/);
  assert.match(html, /title="No result for the same quarter a year earlier to compare with"/);
  assert.match(html, /title="A figure looks mis-scaled in the company&#39;s filing - not compared"/);   // (the apostrophe is HTML-escaped)
});

test('chart table: quarters with no result on file are left out; no EPS in a filing shows a dash', () => {
  withData({ aaa: rec({ h: [H('2025-03-31', null, null, null, null, 'none'), H('2025-06-30', 100, 5, null, null, 'ok'), H('2025-09-30', 110, 10, 2, 5, 'ok')] }) });
  const rows = bodyRows(sb.qctTableHtml({ symbol: 'AAA', bandPct: '20%' }));
  assert.deepEqual(rows, [['Sep-25', '2.00', '+5%', '110.0', '+10%'], ['Jun-25', '-', '-', '100.0', '+5%']]);
});

test('chart table: EPS is as filed, so a quarter pair straddling a split/bonus is starred with the reason', () => {
  withData({ aaa: rec({ h: BHARTI_H }) });
  sb.Store.adjustedCorpActions = [
    { isin: 'INE000A01010', symbol: 'AAA', exDate: '28-Oct-2024', kind: 'split-bonus', detail: 'Bonus 1:1', factor: 0.5 },
    { isin: 'INE000A01010', symbol: 'AAA', exDate: '01-Jan-2025', kind: 'rights', detail: 'Rights 1:10', factor: 0.9 },   // not a split/bonus
    { isin: 'INE999Z01010', symbol: 'OTHER', exDate: '28-Oct-2025', kind: 'split-bonus', detail: 'Bonus 1:1', factor: 0.5 },   // another stock
  ];
  const html = sb.qctTableHtml({ symbol: 'AAA', isin: 'INE000A01010', bandPct: '20%' });
  const starred = [...html.matchAll(/<tr><th>([^<]*)<\/th>(?:(?!<\/tr>).)*?ic-qtr-mark(?:(?!<\/tr>).)*?<\/tr>/g)].map(m => m[1]);
  // the ex-date (28-Oct-2024) lies between the year-ago quarter's end and this result's filing for exactly these quarters
  // (Sep-25 is one: Reliance-style, the year-ago Sep-24 result came out in mid-October, BEFORE the ex-date)
  assert.deepEqual(starred, ['Sep-25', 'Jun-25', 'Mar-25', 'Dec-24', 'Sep-24']);
  assert.match(html, /title="EPS is as filed and not adjusted for the Bonus 1:1 \(ex-date 28-Oct-2024\), so this change may not be like for like"/);
  sb.Store.adjustedCorpActions = [];
  assert.ok(!sb.qctTableHtml({ symbol: 'AAA', bandPct: '20%' }).includes('ic-qtr-mark'));
  delete sb.Store.adjustedCorpActions;
  assert.ok(!sb.qctTableHtml({ symbol: 'AAA', bandPct: '20%' }).includes('ic-qtr-mark'));   // no corporate-action data at all: no stars, no error
});

test('chart table: the price band is always shown, even without results ("No Band%" reads "No Band")', () => {
  withData({ aaa: rec({ h: BHARTI_H }) });
  assert.match(sb.qctTableHtml({ symbol: 'NOPE', bandPct: 'No Band%' }), /No quarterly results for this stock.*Band<\/th><td colspan="4" class="ic-qtr-band">No Band</s);
  assert.match(sb.qctTableHtml({ symbol: 'AAA', bandPct: 'No Band%' }), /ic-qtr-band">No Band</);
  assert.match(sb.qctTableHtml({ symbol: 'AAA', bandPct: '' }), /ic-qtr-band">-</);
  assert.match(sb.qctTableHtml({ symbol: 'AAA' }), /ic-qtr-band">-</);
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'loading';
  assert.match(sb.qctTableHtml({ symbol: 'AAA', bandPct: '10%' }), /Loading quarterly results.*ic-qtr-band">10%</s);
  sb.Store.quarterlyState = 'missing';
  assert.match(sb.qctTableHtml({ symbol: 'AAA', bandPct: '10%' }), /-FetchResults.*ic-qtr-band">10%</s);
});

test('chart table: qrQuarterShort', () => {
  assert.equal(sb.qrQuarterShort('2024-12-31'), 'Dec-24');
  assert.equal(sb.qrQuarterShort('2023-03-31'), 'Mar-23');
  assert.equal(sb.qrQuarterShort(''), '-');
});

test('chart table: qctBandLabel', () => {
  assert.equal(sb.qctBandLabel('20%'), '20%');
  assert.equal(sb.qctBandLabel('No Band%'), 'No Band');
  assert.equal(sb.qctBandLabel('No Band'), 'No Band');
  assert.equal(sb.qctBandLabel(undefined), '-');
});

test('chart table: values are HTML-escaped', () => {
  withData({ aaa: rec({ h: BHARTI_H }) });
  assert.ok(!sb.qctTableHtml({ symbol: 'AAA', bandPct: '<img src=x onerror=alert(1)>' }).includes('<img'));
});

// ── placement: bottom-right corner of the CANDLE pane (not the volume pane) ─────────────────────────────────────────
// qctFooterOffsets is pure (rects in, CSS offsets out); the rects below were measured on the live chart in the browser.
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const offsets = (...a) => JSON.parse(JSON.stringify(sb.qctFooterOffsets(...a)));

test('table placement: bottom-right of the candle pane, left of the price scale, above the volume pane (tall window)', () => {
  // wrap 19,121 - 584,987 | candle pane 19,121 - 583,818 | price scale column starts at x=519 | volume pane 819-959, time axis 959-987
  const o = offsets(rect(19, 121, 584, 987), rect(19, 121, 583, 818), rect(519, 121, 583, 818));
  assert.deepEqual(o, { right: 73, bottom: 175, maxHeight: 685 });
  // bottom = distance from the wrap's bottom to the candle pane's bottom (+6): the table's lower edge is at 818-6 = 812, i.e. above the volume pane (819)
  assert.equal(987 - o.bottom, 812);
  assert.ok(812 < 819, 'the table ends above the volume pane');
});

test('table placement follows the chart when the window gets shorter', () => {
  // the same chart in a short window: candle pane 129-418, volume pane 419-477, wrap bottom 505 (measured)
  const o = offsets(rect(19, 129, 866, 505), rect(19, 129, 865, 418), rect(801, 129, 865, 418));
  assert.deepEqual(o, { right: 73, bottom: 93, maxHeight: 277 });
});

test('table placement: never taller than the candle pane, and a sensible fallback without a price scale', () => {
  assert.equal(offsets(rect(0, 0, 500, 300), rect(0, 0, 500, 40), rect(450, 0, 500, 40)).maxHeight, 60);   // a tiny pane: floor of 60px (it scrolls)
  const noScale = offsets(rect(0, 0, 500, 300), rect(0, 0, 480, 200), null);
  assert.equal(noScale.right, 500 - 480 + 8);                                                              // measured from the pane's own right edge
  assert.deepEqual(offsets(rect(0, 0, 500, 300), rect(0, 0, 480, 200), rect(480, 0, 480, 200)).right, 28);  // a zero-width scale counts as none
  assert.ok(offsets(rect(0, 0, 500, 300), rect(0, 0, 520, 320), rect(500, 0, 520, 320)).right >= 0);       // never negative
});


// ── the hooks the chart popup calls, and the popup's side of the contract ─────────────────────────────────────────────

test('hooks: qctShow shows / hides the box; qctRender builds the table for a stock; qctRefresh rebuilds it for the same stock', () => {
  const dom = installFakeDom(sb, {});
  withData({ aaa: rec({ h: BHARTI_H }) });
  sb.qctShow(true);  assert.equal(dom.el('icSingleFooter').style.display, '');
  sb.qctShow(false); assert.equal(dom.el('icSingleFooter').style.display, 'none');
  sb.qctRender({ symbol: 'AAA', bandPct: '20%' });
  assert.match(dom.el('icSingleFooter').innerHTML, /<tr><th>Jun-26<\/th>/);
  // the results arrive after the chart was opened: the same stock is rebuilt from the new data
  sb.Store.quarterly = null; sb.Store.quarterlyState = 'loading';
  sb.qctRender({ symbol: 'AAA', bandPct: '20%' });
  assert.match(dom.el('icSingleFooter').innerHTML, /Loading quarterly results/);
  withData({ aaa: rec({ h: BHARTI_H }) });
  sb.qctRefresh();
  assert.match(dom.el('icSingleFooter').innerHTML, /<tr><th>Jun-26<\/th>/);
  sb.qctRender(null);
  assert.equal(dom.el('icSingleFooter').innerHTML, '');
  assert.doesNotThrow(() => sb.qctRelease());    // nothing armed: releasing is harmless
  sb.requestAnimationFrame = () => 0; sb.setTimeout = () => 0;   // browser timers (the vm sandbox has none)
  assert.doesNotThrow(() => sb.qctWatch(null));  // no container (no chart): nothing to watch, no error
});

test('hooks: with no chart on the page the table is left at its CSS default corner (placement does not throw)', () => {
  const dom = installFakeDom(sb, {});
  dom.el('icSingleFooter').style.display = '';
  assert.doesNotThrow(() => sb.qctPosition());
  assert.equal(dom.el('icSingleFooter').style.right, undefined);
});

test('the chart popup reaches the table only through guarded hooks, and holds none of its logic', () => {
  const ic = read('js/industry-charts.js');
  const single = ic.slice(ic.indexOf('function icRenderSingleStock'), ic.indexOf('function closeIndustryCharts'));
  assert.match(single, /typeof qctRender === 'function'\) qctRender\(stock\)/);      // for every stock shown (Prev/Next too)
  assert.match(single, /typeof qctWatch === 'function'\) qctWatch\(container\)/);    // once its chart exists
  assert.match(ic, /function closeIndustryCharts\(\)[^]*typeof qctRelease === 'function'\) qctRelease\(\)/);
  assert.match(ic, /typeof qctShow === 'function'\) qctShow\(icMode === 'single'\)/);   // single-stock mode only: hidden in the grid / industry tabs
  // nothing of the table's own machinery is left in the popup's file (it has two UNRELATED resize observers for the money-flow
  // charts, which is why ResizeObserver is only forbidden inside the single-stock code)
  assert.ok(!/icSingleFooter|SingleFooter\(|tv-lightweight-charts|icFooter/.test(ic), 'no table logic in industry-charts.js');
  assert.ok(!/ResizeObserver/.test(single), 'the single-stock chart code does not watch sizes itself');
});

test('the table module does not reach into the popup or the scanner (only the DOM ids it is documented to use)', () => {
  const src = read('js/quarterly-chart-table.js');
  assert.ok(!/\bicMode\b|\bicSingleList\b|\bicSingleIndex\b|screenerResults|screenerPassed|runScreener/.test(src));
  for (const id of ['icSingleFooter', 'icIndustryChartWrap', 'icIndustryChartContainer']) assert.ok(src.includes(id), id);
});

test('markup and load order: the box sits under the chart inside its wrap, and the table module loads after the data module', () => {
  const html = read('index.html');
  assert.match(html, /id="icIndustryChartContainer"[^>]*><\/div>\s*(<!--[^]*?-->\s*)?<div id="icSingleFooter"/);
  const scripts = [...html.matchAll(/<script src="(js\/[^"?]+)/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('js/quarterly-results.js') < scripts.indexOf('js/quarterly-chart-table.js'), 'needs the data module first');
  assert.ok(scripts.indexOf('js/quarterly-chart-table.js') < scripts.indexOf('js/nse-download.js'));
});

test('single-stock chart: the table is OVERLAID in the bottom-right corner of the chart pane, clear of the price scale and time axis', () => {
  const css = fs.readFileSync(path.join(path.dirname(__dirname), 'css/styles.css'), 'utf8');
  const rule = /\.ic-single-footer\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.ic-single-footer rule exists');
  assert.match(rule[1], /position:\s*absolute/);                              // over the chart, not a strip that shrinks it
  const right = Number(/right:\s*(\d+)px/.exec(rule[1])[1]), bottom = Number(/bottom:\s*(\d+)px/.exec(rule[1])[1]);
  assert.ok(right >= 64, `right offset ${right}px must clear the 64px price scale`);      // measured on the real chart: price scale 64px
  assert.ok(bottom >= 28, `bottom offset ${bottom}px must clear the 28px time axis`);     // measured on the real chart: time axis 28px
  assert.match(css, /\.ic-industry-chart-wrap\s*\{[^}]*position:\s*relative/);        // the overlay is positioned against the chart pane
  assert.match(/\.ic-qtr-table\s*\{([^}]*)\}/.exec(css)[1], /background:\s*rgba\(/); // semi-transparent: candles and volume show through
});


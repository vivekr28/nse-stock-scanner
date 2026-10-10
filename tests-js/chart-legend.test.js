'use strict';
// The on-chart legend of the Stock Charts popup (js/industry-charts.js): TradingView-style
//   SYMBOL   O H L C   +0.62 (+2.32%)   MF
// drawn at the top-left of the chart itself - the ticker only (no company name), and the cell / modal headers no
// longer repeat it. Covers the pure text builders, the wiring in icCreateChart (overlay created inside the chart
// container, follows the crosshair, falls back to the latest bar) and the header changes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');
const { makeFakeChart } = require('./fakechart');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/chart-tools.js', 'js/industry-charts.js']);

// The numbers from the TradingView screenshot this feature copies: K.M. Sugar Mills, O27.29 H27.90 L27.01 C27.31,
// previous close 26.69 -> +0.62 (+2.32%).
const KMSUGAR = { symbol: 'KMSUGAR' };
const BAR = { open: 27.29, high: 27.90, low: 27.01, close: 27.31 };

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// --- pure builders ---------------------------------------------------------------------------------

test('icLegendStock keeps only the ticker of a stock record (the company name is deliberately dropped)', () => {
  assert.deepEqual({ ...sb.icLegendStock({ symbol: 'KMSUGAR', companyName: 'K.M. SUGAR MILLS LTD', close: 1 }) }, KMSUGAR);
  assert.deepEqual({ ...sb.icLegendStock({ companyName: 'NO TICKER' }) }, { symbol: '' });
  assert.equal(sb.icLegendStock(null), null);
});

test('title: the bold ticker and nothing else - no company name, timeframe or exchange', () => {
  const html = sb.icLegendTitle({ symbol: 'KMSUGAR', name: 'K.M. SUGAR MILLS LTD' });
  assert.match(html, /<b>KMSUGAR<\/b>/);
  assert.equal(text(html), 'KMSUGAR');
});

test('title: nothing without a stock or without a ticker', () => {
  assert.equal(sb.icLegendTitle(null), '');
  assert.equal(sb.icLegendTitle({ symbol: '', name: 'x' }), '');
});

test('title escapes the ticker (M&M, S&SPOWER)', () => {
  assert.match(sb.icLegendTitle({ symbol: 'M&M' }), /<b>M&amp;M<\/b>/);
  assert.match(sb.icLegendTitle({ symbol: '<X>' }), /&lt;X&gt;/);
});

test('legend matches the TradingView line: ticker, O H L C and +0.62 (+2.32%)', () => {
  const html = sb.icLegendHtml(KMSUGAR, BAR, 26.69, 413.5);
  assert.equal(text(html), 'KMSUGAR O 27.29 H 27.90 L 27.01 C 27.31 +0.62 (+2.32%) MF ' + text(sb.fmtTurnoverCr(413.5)));
  assert.match(html, /<span class="positive">\+0\.62 \(\+2\.32%\)<\/span>/);
});

test('a down day shows the sign on both numbers and is coloured negative', () => {
  const html = sb.icLegendHtml(null, { open: 100, high: 101, low: 97, close: 98.5 }, 100, 0);
  assert.match(html, /<span class="negative">-1\.50 \(-1\.50%\)<\/span>/);
  assert.doesNotMatch(html, /ic-legend-title/);                       // no stock -> figures only
});

test('an unchanged close is +0.00 (+0.00%)', () => {
  assert.match(sb.icLegendHtml(null, BAR, 27.31, 0), /\+0\.00 \(\+0\.00%\)/);
});

test('the first bar has no previous close: change shows "-" and carries no colour', () => {
  for (const prev of [null, 0, undefined]) {
    const html = sb.icLegendHtml(null, BAR, prev, 0);
    assert.match(html, /<span class="">-<\/span>/, `prev=${prev}`);
  }
});

// --- wiring in icCreateChart ---------------------------------------------------------------------

function fakeLibrary() {
  const fake = makeFakeChart();
  const series = () => Object.assign(fake.makeSeries(0), {
    priceScale: () => ({ applyOptions() {} }), applyOptions() {}, setData() {},
  });
  Object.assign(fake.chart, {
    addSeries: () => series(),
    panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }],
    applyOptions() {}, remove() {},
  });
  return {
    fake,
    lib: {
      createChart: () => fake.chart,
      CrosshairMode: { Normal: 0 },
      CandlestickSeries: {}, HistogramSeries: {}, LineSeries: {},
      createSeriesMarkers: () => ({ setMarkers() {} }),
    },
  };
}

function build(stock) {
  const dom = installFakeDom(sb);
  const { lib, fake } = fakeLibrary();
  sb.LightweightCharts = lib;
  sb.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sb.document.documentElement = {};
  const children = [];
  const container = dom.el('chartHost');
  container.appendChild = el => { children.push(el); };
  const inst = sb.icCreateChart(container, 'vol', stock);
  const t = (d, c) => ({ time: { year: 2026, month: 10, day: d }, open: c - 1, high: c + 1, low: c - 2, close: c });
  inst.candleData = [t(7, 100), t(8, 110), t(9, 105)];
  inst.volumeData = inst.candleData.map((b, i) => ({ time: b.time, value: 100 * (i + 1) }));
  const legend = children.find(c => c.className === 'ic-legend');
  return { inst, fake, legend, children, container };
}

test('icCreateChart puts the legend INSIDE the chart container, not in a header', () => {
  const { legend, inst, container } = build(KMSUGAR);
  assert.ok(legend, 'no .ic-legend overlay was added to the chart container');
  assert.equal(inst.legendEl, legend);
  assert.equal(container.style.position, 'relative');                // so the overlay can sit top-left
});

test('it shows the latest bar (ticker, OHLC, change) until the crosshair moves', () => {
  const { inst, legend } = build(KMSUGAR);
  inst.updateLegend();
  assert.match(text(legend.innerHTML), /^KMSUGAR O 104\.00 H 106\.00 L 103\.00 C 105\.00 -5\.00 \(-4\.55%\)/);
  assert.match(legend.innerHTML, /class="negative"/);
});

test('hovering a candle shows that candle; leaving the chart goes back to the latest', () => {
  const { inst, fake, legend } = build(KMSUGAR);
  inst.updateLegend();
  fake.handlers.move.forEach(fn => fn({ time: inst.candleData[1].time }));    // 8-Oct: 100 -> 110
  assert.match(text(legend.innerHTML), /O 109\.00 H 111\.00 L 108\.00 C 110\.00 \+10\.00 \(\+10\.00%\)/);
  fake.handlers.move.forEach(fn => fn({ time: inst.candleData[0].time }));    // first bar: no previous close
  assert.match(text(legend.innerHTML), /C 100\.00 -/);
  fake.handlers.move.forEach(fn => fn({}));                                   // pointer left the chart
  assert.match(text(legend.innerHTML), /C 105\.00 -5\.00 \(-4\.55%\)/);
});

test('without a stock (the industry index chart) the legend is figures only', () => {
  const { inst, legend } = build(null);
  inst.updateLegend();
  assert.doesNotMatch(legend.innerHTML, /ic-legend-title/);
  assert.match(text(legend.innerHTML), /^O 104\.00/);
});

test('an empty chart clears the legend', () => {
  const { inst, legend } = build(KMSUGAR);
  inst.candleData = [];
  inst.updateLegend();
  assert.equal(legend.innerHTML, '');
});

// --- the headers no longer repeat the ticker -------------------------------------------------------------

const root = path.dirname(__dirname);
const src = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('the grid cell header holds only the checkbox (and market cap) - no ticker text, no OHLC text', () => {
  const js = src('js/industry-charts.js');
  const cell = js.slice(js.indexOf('<div class="ic-cell-header">'), js.indexOf('<div class="ic-cell-chart"'));
  assert.ok(cell.length > 100, 'cell header template not found');
  assert.match(cell, /<label class="ic-cell-select"><input type="checkbox" class="ic-select-cb"[^>]*><\/label>/);
  assert.doesNotMatch(cell, /s\.symbol/);
  assert.doesNotMatch(cell, /ic-cell-ohlc|icOhlc/);
  assert.match(cell, /ic-cell-mcap/);
});

test('the single-stock modal title is the industry only; the ticker is on the chart', () => {
  const js = src('js/industry-charts.js');
  const fn = js.slice(js.indexOf('function icRenderSingleStock()'), js.indexOf('function closeIndustryCharts()'));
  assert.match(fn, /titleEl\.textContent = stock\.industry \|\| 'Undefined-Diversified';/);
  assert.doesNotMatch(fn, /stock\.symbol/);
  assert.doesNotMatch(fn, /titleEl\.onclick = \(\)/);                 // the title no longer names the stock, so no click-to-select
  assert.match(fn, /icLegendStock\(stock\)/);                         // ... the chart's own legend does
  assert.doesNotMatch(src('index.html'), /icSingleOhlc/);
});

test('the ticker is shown on the chart in every layout, dense grids included', () => {
  const css = src('css/styles.css');
  assert.doesNotMatch(css, /\.ic-legend-title\s*\{[^}]*display:\s*none/);
  assert.match(src('js/industry-charts.js'), /icCreateChart\(container, 'icVolume' \+ i, icLegendStock\(s\)\)/);
});

'use strict';
// js/breadth.js's brdRefreshTools(): the one-shot Measure / Trend Line tools on the Market Breadth chart. Each
// breadth metric draws on a different series (candles, a line, or the first overlay line), and drawings are anchored
// to a metric's values, so the tools are rebuilt - dropping the drawings - when the metric changes, but kept across
// a plain data refresh of the same metric. The chart and series are fakes (fakechart.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { makeFakeChart } = require('./fakechart');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/breadth.js', 'js/chart-tools.js']);
const run = code => vm.runInContext(code, sb);
const dom = installFakeDom(sb); // persistent elements, so the new-highs dropdown's value sticks

function setupChart() {
  const fake = makeFakeChart();
  sb.__fake = fake;
  sb.__candle = fake.makeSeries(0);
  sb.__line = fake.makeSeries(0);
  sb.__multi = ['a', 'b', 'c', 'd'].map(() => fake.makeSeries(0));
  run('brdChart = __fake.chart; brdCandleSeries = __candle; brdLineSeries = __line; brdMultiSeries = __multi; brdTools = null; _brdToolsSeries = null; _brdToolsKey = null');
  return fake;
}
const showTab = (tab, high) => {
  run(`_brdActiveTab = '${tab}'`);
  if (high) dom.el('brdHighSelect').value = high;
};

test('breadth tools: the % Above 20 / 50 SMA tabs draw on the line series, in percentage points', () => {
  setupChart();
  showTab('above20');
  run('brdRefreshTools()');
  assert.equal(run('_brdToolsSeries === __line'), true);
  assert.equal(run('brdTools.entries[0].unit'), 'pp');
});

test('breadth tools: a candle metric draws on the candle series', () => {
  setupChart();
  showTab('move4d');
  run('brdRefreshTools()');
  assert.equal(run('_brdToolsSeries === __candle'), true);
});

test('breadth tools: the "All (overlay)" new-highs view draws on the first overlay line', () => {
  setupChart();
  showTab('newhighs', 'highAll');
  run('brdRefreshTools()');
  assert.equal(run('_brdToolsSeries === __multi[0]'), true);
});

test('breadth tools: re-rendering the same metric keeps the tools (and so any drawings)', () => {
  setupChart();
  showTab('above20');
  run('brdRefreshTools()');
  const first = run('brdTools');
  run('brdRefreshTools()');
  assert.equal(run('brdTools'), first);
});

test('breadth tools: switching metric rebuilds them and drops the drawings - even between two metrics on the same line series', () => {
  const fake = setupChart();
  showTab('above20');
  run('brdRefreshTools()');
  const first = run('brdTools');
  first.arm('trend'); fake.click(100, 500); fake.click(300, 300);
  assert.equal(first.drawings.length, 1);

  showTab('above50'); // same series (the line), different metric
  run('brdRefreshTools()');
  const second = run('brdTools');
  assert.notEqual(second, first);
  assert.equal(second.drawings.length, 0);
  assert.equal(first.drawings.length, 0, 'the old tools were destroyed');
  assert.equal(fake.handlers.click.length, 1, 'only the new tools listen to the chart');
});

test('breadth tools: the old series loses its drawing layer when the metric changes series', () => {
  setupChart();
  showTab('above20');
  run('brdRefreshTools()');
  assert.ok(sb.__line.primitive);
  showTab('move4d');
  run('brdRefreshTools()');
  assert.equal(sb.__line.primitive, null);
  assert.ok(sb.__candle.primitive);
});

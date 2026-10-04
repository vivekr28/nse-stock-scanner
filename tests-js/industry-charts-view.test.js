'use strict';
// js/industry-charts.js's Stock Charts popup behaviour that is not data maths: the grid layouts and page sizes,
// the 6M / 1Y / 2Y visible range, the date-based crosshair sync between the grid's charts, and the shared
// Measure / Trend Line toolbar that drives every chart on screen. The chart objects are fakes (fakechart.js);
// these tests cover the wiring and the rules, not canvas drawing.
//
// The file's top-level `let` state (icLayout, icRange, icSyncCrosshair, icChartInstances...) is not a property of
// the vm sandbox, so tests read / write it through run().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { makeFakeChart } = require('./fakechart');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/chart-tools.js', 'js/industry-charts.js']);
const run = code => vm.runInContext(code, sb);

// A grid chart instance as icRenderPage builds one: a fake chart plus the bars / legend the sync reads and drives.
// `days` are day-of-month numbers in Jan 2025; each bar closes at 100 + day.
function makeInst(days) {
  const fake = makeFakeChart();
  const candleSeries = fake.makeSeries(0);
  const inst = {
    chart: fake.chart, candleSeries, fake,
    candleData: days.map(d => ({ time: { year: 2025, month: 1, day: d }, open: 100, high: 110, low: 90, close: 100 + d })),
    legendCalls: [],
  };
  inst.updateLegend = index => inst.legendCalls.push(index);
  return inst;
}

function useInstances(insts) {
  sb.__insts = insts;
  run('icChartInstances = __insts');
}

// ── Layouts ─────────────────────────────────────────────────────────────────

test('layouts: every IC_LAYOUTS entry is rows x cols charts per page, and the picker offers each of them', () => {
  const layouts = run('Object.keys(IC_LAYOUTS).map(k => [k, IC_LAYOUTS[k].rows, IC_LAYOUTS[k].cols])');
  const bySize = Object.fromEntries(layouts.map(([k, r, c]) => [k, r * c]));
  assert.deepEqual(bySize, { '1x1': 1, '2x2': 4, '3x3': 9, '3x4': 12, '4x4': 16 });
  // "3x4" is 3 rows of 4 columns (a wide grid), not 4 rows of 3
  assert.equal(run('IC_LAYOUTS["3x4"].rows'), 3);
  assert.equal(run('IC_LAYOUTS["3x4"].cols'), 4);
});

test('icPageSize / icTotalPages follow the layout: 86 stocks is 22 / 10 / 8 / 6 pages and 86 in 1x1', () => {
  run('icStocks = new Array(86).fill(0)');
  const pagesFor = layout => { run(`icLayout = '${layout}'`); return [run('icPageSize()'), run('icTotalPages()')]; };
  assert.deepEqual(pagesFor('2x2'), [4, 22]);
  assert.deepEqual(pagesFor('3x3'), [9, 10]);
  assert.deepEqual(pagesFor('3x4'), [12, 8]);
  assert.deepEqual(pagesFor('4x4'), [16, 6]);
  assert.deepEqual(pagesFor('1x1'), [1, 86]);
  run("icLayout = '2x2'");
});

test('icTotalPages: an empty list still has one (empty) page', () => {
  run('icStocks = []');
  assert.equal(run('icTotalPages()'), 1);
});

// ── Visible range (6M / 1Y / 2Y) ────────────────────────────────────────────

test('IC_RANGE_CANDLES: 6M / 1Y / 2Y are about 126 / 252 / 504 trading days', () => {
  assert.equal(run('IC_RANGE_CANDLES["6m"]'), 126);
  assert.equal(run('IC_RANGE_CANDLES["1y"]'), 252);
  assert.equal(run('IC_RANGE_CANDLES["2y"]'), 504);
  assert.equal(run('icRange'), '6m', 'defaults to 6 months');
});

test('icApplyVisibleRange: shows the last N bars plus the right margin when there is more history than N', () => {
  const inst = makeInst(Array.from({ length: 300 }, (_, i) => i + 1));
  sb.__inst = inst;
  run('icApplyVisibleRange(__inst, 126)');
  const r = inst.fake.calls.visibleRange;
  assert.equal(r.from, 300 - 126);
  assert.equal(r.to, 300 - 1 + run('IC_RIGHT_OFFSET'));
  assert.equal(inst.fake.calls.fit, 0);
});

test('icApplyVisibleRange: a stock with no more bars than the range just fits whole', () => {
  const inst = makeInst(Array.from({ length: 100 }, (_, i) => i + 1));
  sb.__inst = inst;
  run('icApplyVisibleRange(__inst, 126)');
  assert.equal(inst.fake.calls.visibleRange, null);
  assert.equal(inst.fake.calls.fit, 1);
});

test('icSetRange: moves every grid chart to the new window and remembers the choice', () => {
  const a = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
  const b = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
  useInstances([a, b]);
  run("icMode = 'industry'");
  run("icSetRange('1y')");
  assert.equal(run('icRange'), '1y');
  assert.equal(a.fake.calls.visibleRange.from, 600 - 252);
  assert.equal(b.fake.calls.visibleRange.from, 600 - 252);
  run("icSetRange('2y')");
  assert.equal(a.fake.calls.visibleRange.from, 600 - 504);
  run("icSetRange('6m')");
  assert.equal(b.fake.calls.visibleRange.from, 600 - 126);
});

test('icSetRange: an unknown range is ignored', () => {
  const a = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
  useInstances([a]);
  run("icSetRange('6m')");
  a.fake.calls.visibleRange = null;
  run("icSetRange('5y')");
  assert.equal(run('icRange'), '6m');
  assert.equal(a.fake.calls.visibleRange, null);
});

test('icSetRange: in single-stock mode it moves the one big chart, not the (empty) grid', () => {
  const big = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
  sb.__big = big;
  run('icIndustryChartInst = __big');
  useInstances([]);
  run("icMode = 'single'");
  run("icSetRange('1y')");
  assert.equal(big.fake.calls.visibleRange.from, 600 - 252);
  run("icSetRange('6m'); icMode = 'industry'; icIndustryChartInst = null");
});

test('icSetRange: the Industry Chart tab\'s own chart keeps its window (industry mode never touches icIndustryChartInst)', () => {
  const big = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
  sb.__big = big;
  run('icIndustryChartInst = __big');
  useInstances([]);
  run("icMode = 'industry'");
  run("icSetRange('2y')");
  assert.equal(big.fake.calls.visibleRange, null);
  run("icSetRange('6m'); icIndustryChartInst = null");
});

// ── Crosshair sync (by date) ────────────────────────────────────────────────

function wireSync(insts, on = true) {
  useInstances(insts);
  run(`icSyncCrosshair = ${on}`);
  run('icWireStockCrosshairSync()');
}
const day = d => ({ year: 2025, month: 1, day: d });

test('crosshair sync: hovering a chart moves the others to the same date, at that chart\'s own close, and updates their legends', () => {
  const a = makeInst([1, 2, 3]), b = makeInst([1, 2, 3]), c = makeInst([2, 3, 4]);
  wireSync([a, b, c]);
  a.fake.handlers.move[0]({ time: day(2) });

  assert.equal(b.fake.calls.crosshair.length, 1);
  assert.equal(b.fake.calls.crosshair[0].price, 102);
  assert.equal(b.fake.calls.crosshair[0].time.day, 2);
  assert.equal(b.fake.calls.crosshair[0].series, b.candleSeries);
  assert.deepEqual(b.legendCalls, [1]); // index of 2-Jan in b's bars
  assert.equal(c.fake.calls.crosshair[0].price, 102);
  assert.deepEqual(c.legendCalls, [0]); // index of 2-Jan in c's bars - a different position, same date
  assert.equal(a.fake.calls.crosshair.length, 0, 'the hovered chart is left to the library');
  assert.deepEqual(a.legendCalls, []);
});

test('crosshair sync: a chart with no bar on that date has its crosshair cleared, not snapped to a neighbour', () => {
  const a = makeInst([1, 2, 3]), newlyListed = makeInst([3, 4]);
  wireSync([a, newlyListed]);
  a.fake.handlers.move[0]({ time: day(1) });
  assert.equal(newlyListed.fake.calls.crosshair.length, 0);
  assert.equal(newlyListed.fake.calls.cleared, 1);
  assert.deepEqual(newlyListed.legendCalls, [null]);
});

test('crosshair sync: leaving a chart (no time) clears the others', () => {
  const a = makeInst([1, 2]), b = makeInst([1, 2]);
  wireSync([a, b]);
  a.fake.handlers.move[0]({});
  assert.equal(b.fake.calls.cleared, 1);
  assert.deepEqual(b.legendCalls, [null]);
});

test('crosshair sync: does nothing while the Sync Crosshair checkbox is off', () => {
  const a = makeInst([1, 2]), b = makeInst([1, 2]);
  wireSync([a, b], false);
  a.fake.handlers.move[0]({ time: day(1) });
  assert.equal(b.fake.calls.crosshair.length, 0);
  assert.equal(b.fake.calls.cleared, 0);
  assert.deepEqual(b.legendCalls, []);
  // ...and picks up the checkbox being ticked later, without re-wiring
  run('icSyncCrosshair = true');
  a.fake.handlers.move[0]({ time: day(1) });
  assert.equal(b.fake.calls.crosshair.length, 1);
});

test('crosshair sync: the moves it causes do not echo back (every chart is moved once per hover)', () => {
  const a = makeInst([1, 2]), b = makeInst([1, 2]), c = makeInst([1, 2]);
  // like the real library, setCrosshairPosition fires the chart's own crosshair-move event
  [b, c].forEach(t => {
    const orig = t.chart.setCrosshairPosition;
    t.chart.setCrosshairPosition = (p, time, s) => { orig(p, time, s); t.fake.handlers.move.forEach(fn => fn({ time })); };
  });
  wireSync([a, b, c]);
  a.fake.handlers.move[0]({ time: day(1) });
  assert.equal(b.fake.calls.crosshair.length, 1);
  assert.equal(c.fake.calls.crosshair.length, 1);
  assert.equal(a.fake.calls.crosshair.length, 0);
});

test('crosshair sync: a single chart (nothing to sync with) subscribes to nothing', () => {
  const a = makeInst([1, 2]);
  wireSync([a]);
  assert.equal(a.fake.handlers.move.length, 0);
});

// ── Shared Measure / Trend Line toolbar ─────────────────────────────────────

// A real ChartTools per fake chart, registered the way icCreateChart does (icAttachTools).
function makeToolChart() {
  const fake = makeFakeChart();
  const series = fake.makeSeries(0);
  sb.__fake = fake; sb.__series = series;
  const tools = run('icAttachTools(__fake.chart, [{ series: __series }], { style: {} })');
  return { fake, tools };
}
const toolSet = () => run('icToolSet');
function resetTools() { toolSet().slice().forEach(t => run('icDropTools')(t)); }

test('tool buttons: Measure / Trend Line arm every chart on screen at once; clicking the armed button again cancels', () => {
  resetTools();
  const c1 = makeToolChart(), c2 = makeToolChart(), c3 = makeToolChart();
  run("icToolAction('trend')");
  assert.deepEqual([c1, c2, c3].map(c => c.tools.armed), ['trend', 'trend', 'trend']);
  run("icToolAction('trend')");
  assert.deepEqual([c1, c2, c3].map(c => c.tools.armed), [null, null, null]);
  run("icToolAction('measure')");
  assert.deepEqual([c1, c2, c3].map(c => c.tools.armed), ['measure', 'measure', 'measure']);
  resetTools();
});

test('tool buttons: the first click on a chart picks it - the other charts disarm - and one drawing finishes the tool', () => {
  resetTools();
  const c1 = makeToolChart(), c2 = makeToolChart();
  run("icToolAction('trend')");
  c2.fake.click(100, 500);
  assert.equal(c1.tools.armed, null, 'the chart not picked disarms');
  assert.equal(c2.tools.armed, 'trend');
  c2.fake.click(300, 300);
  assert.equal(c2.tools.drawings.length, 1);
  assert.equal(c1.tools.drawings.length, 0);
  assert.equal(c2.tools.armed, null, 'one-shot: disarmed after the drawing');
  assert.equal(run('icToolsBusy()'), false);
  resetTools();
});

test('tool buttons: Delete removes the selected drawing wherever it is; Clear removes every chart\'s drawings', () => {
  resetTools();
  const c1 = makeToolChart(), c2 = makeToolChart();
  [c1, c2].forEach(c => { c.tools.arm('trend'); c.fake.click(100, 500); c.fake.click(300, 300); });
  assert.equal(c1.tools.drawings.length + c2.tools.drawings.length, 2);

  c2.fake.click(200, 400); // select the one on c2 (on the line)
  assert.ok(c2.tools.selected);
  run("icToolAction('delete')");
  assert.equal(c2.tools.drawings.length, 0);
  assert.equal(c1.tools.drawings.length, 1, 'the other chart\'s drawing is untouched');

  run("icToolAction('clear')");
  assert.equal(c1.tools.drawings.length, 0);
  resetTools();
});

test('tool buttons: selecting a drawing on one chart deselects the one selected on another', () => {
  resetTools();
  const c1 = makeToolChart(), c2 = makeToolChart();
  [c1, c2].forEach(c => { c.tools.arm('trend'); c.fake.click(100, 500); c.fake.click(300, 300); });
  c1.fake.click(200, 400);
  assert.ok(c1.tools.selected);
  c2.fake.click(200, 400);
  assert.ok(c2.tools.selected);
  assert.equal(c1.tools.selected, null);
  resetTools();
});

test('icToolsBusy: true while a tool is armed, mid-drawing or a drawing is selected (Esc then cancels instead of closing the popup)', () => {
  resetTools();
  const c = makeToolChart();
  assert.equal(run('icToolsBusy()'), false);
  c.tools.arm('measure');
  assert.equal(run('icToolsBusy()'), true);
  c.fake.click(100, 500);
  assert.equal(run('icToolsBusy()'), true);
  c.fake.click(300, 300);
  assert.equal(run('icToolsBusy()'), false);
  c.fake.click(200, 400); // inside the measure box
  assert.ok(c.tools.selected);
  assert.equal(run('icToolsBusy()'), true);
  resetTools();
});

test('icDropTools: a disposed chart leaves the tool set and stops reacting', () => {
  resetTools();
  const c1 = makeToolChart(), c2 = makeToolChart();
  assert.equal(toolSet().length, 2);
  run('icDropTools')(c1.tools);
  assert.equal(toolSet().length, 1);
  assert.equal(c1.fake.handlers.click.length, 0, 'its chart subscriptions are gone');
  run("icToolAction('trend')");
  assert.equal(c1.tools.armed, null, 'a dropped chart is no longer armed by the buttons');
  assert.equal(c2.tools.armed, 'trend');
  resetTools();
  assert.equal(toolSet().length, 0);
});

test('icDropTools: ignores a chart that never had tools', () => {
  assert.doesNotThrow(() => run('icDropTools')(null));
  assert.doesNotThrow(() => run('icDropTools')(undefined));
});

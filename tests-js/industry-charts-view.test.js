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

// ── Manual zoom becomes the range (6M / 1Y / 2Y deselected) ──────────────────

// A grid chart wired as icRenderPage does, with a fake container whose DOM events the test can fire.
function makeWatched(bars = 600) {
  const inst = makeInst(Array.from({ length: bars }, (_, i) => i + 1));
  const listeners = {};
  const container = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  sb.__inst = inst; sb.__container = container;
  run('icWatchManualRange(__inst, __container)');
  return { inst, listeners };
}
if (!sb.addEventListener) { sb.addEventListener = () => {}; sb.removeEventListener = () => {}; } // window === the sandbox
sb.setTimeout = () => 0; sb.clearTimeout = () => {}; // the wheel gesture's end timer never fires here
const resetRange = () => run("icRange = '6m'; icCustomCandles = 0; icRightOffset = IC_RIGHT_OFFSET");

test('manual zoom: a range change during a user gesture becomes the custom range for the next charts', () => {
  resetRange();
  const { inst, listeners } = makeWatched();
  run("icApplyVisibleRange(__inst, 126)"); // programmatic, no gesture
  assert.equal(run('icRange'), '6m');
  listeners.wheel();
  inst.fake.setRange({ from: 400, to: 599 + 10 }); // zoomed in to 209 wide
  assert.equal(run('icRange'), 'custom');
  assert.equal(run('icCustomCandles'), 209 - 10 + 1);
  assert.equal(run('icVisibleCandles()'), 200);
  // a chart built afterwards shows the same number of bars
  const next = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
  sb.__next = next;
  run('icApplyVisibleRange(__next, icVisibleCandles())');
  assert.equal(next.fake.calls.visibleRange.from, 600 - 200);
  resetRange();
});

test('manual zoom: range events with no user gesture (our own apply, a resize) are not a custom range', () => {
  resetRange();
  const { inst } = makeWatched();
  inst.fake.setRange({ from: 100, to: 400 });
  assert.equal(run('icRange'), '6m');
  assert.equal(run('icVisibleCandles()'), 126);
});

test('manual zoom: panning (same width) keeps the chosen button but the last bar placement is remembered', () => {
  resetRange();
  const { inst, listeners } = makeWatched();
  inst.fake.setRange({ from: 474, to: 609 });
  listeners.pointerdown();
  inst.fake.setRange({ from: 400, to: 535 }); // dragged back in time: last bar (index 599) is 64 bars left of the right edge
  assert.equal(run('icRange'), '6m');
  assert.equal(run('icRightOffset'), 535 - 599);
  // the next chart is placed the same way, with the same width
  const next = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
  sb.__next = next;
  run('icApplyVisibleRange(__next, icVisibleCandles(), icRightOffset)');
  assert.deepEqual({ ...next.fake.calls.visibleRange }, { from: 400, to: 535 });
  resetRange();
});

test('manual zoom: a zoom also remembers where the last bar sits; the range buttons put it back to the default', () => {
  resetRange();
  const { inst, listeners } = makeWatched();
  inst.fake.setRange({ from: 474, to: 609 });
  listeners.wheel();
  inst.fake.setRange({ from: 300, to: 560 });
  assert.equal(run('icRightOffset'), 560 - 599);
  run("icMode = 'industry'; icChartInstances = []");
  run("icSetRange('1y')");
  assert.equal(run('icRightOffset'), run('IC_RIGHT_OFFSET'));
  resetRange();
});

test('manual zoom: the 6M / 1Y / 2Y buttons are all deselected while custom, and clicking one takes over again', () => {
  resetRange();
  const btns = ['6m', '1y', '2y'].map(r => ({ dataset: { range: r }, active: r === '6m', classList: { toggle(c, on) { this.owner.active = on; }, owner: null } }));
  btns.forEach(b => { b.classList.owner = b; });
  const realQsa = sb.document.querySelectorAll;
  sb.document.querySelectorAll = () => btns;
  const { inst, listeners } = makeWatched();
  inst.fake.setRange({ from: 474, to: 609 });
  listeners.wheel();
  inst.fake.setRange({ from: 300, to: 609 });
  assert.deepEqual(btns.map(b => b.active), [false, false, false]);
  run("icMode = 'industry'; icChartInstances = []");
  run("icSetRange('1y')");
  assert.equal(run('icRange'), '1y');
  assert.deepEqual(btns.map(b => b.active), [false, true, false]);
  resetRange();
  sb.document.querySelectorAll = realQsa;
});

test('manual zoom: the custom width never drops below a few bars', () => {
  resetRange();
  const { inst, listeners } = makeWatched();
  inst.fake.setRange({ from: 0, to: 100 });
  listeners.wheel();
  inst.fake.setRange({ from: 599, to: 600 });
  assert.equal(run('icCustomCandles'), run('IC_MIN_CUSTOM_CANDLES'));
  resetRange();
});

// ── X / R keys select / deselect the stock being looked at ───────────────────

function withGridCheckbox(isin, fn) {
  const cb = { checked: false };
  const cell = { dataset: { isin }, querySelector: () => cb };
  const realQsa = sb.document.querySelectorAll;
  sb.document.querySelectorAll = sel => (sel === '#icGrid .ic-cell' ? [cell] : []);
  try { fn(cb); } finally { sb.document.querySelectorAll = realQsa; }
}
const key = (k, extra = {}) => { sb.__e = { key: k, target: { tagName: 'DIV' }, ...extra }; return run('icHandleSelectKey(__e)'); };
const picked = () => Array.from(run('Array.from(selectedStocks)'));
const gridOf = (n, size = '2x2') => run(`selectedStocks.clear(); icMode = 'industry'; icActiveTab = 'stocks'; icLayout = '${size}'; icPage = 0; icActiveCell = 0; icStocks = Array.from({ length: ${n} }, (_, i) => ({ isin: 'S' + i }))`);

test('X / R keys: in the grid they act on the active chart - the first one until another is clicked', () => {
  gridOf(10);
  withGridCheckbox('S0', cb => {
    assert.equal(key('x'), true);
    assert.deepEqual(picked(), ['S0']);
    assert.equal(cb.checked, true);
    key('X'); // pressing it again keeps it selected, it does not toggle
    assert.deepEqual(picked(), ['S0']);
    assert.equal(key('r'), true);
    assert.deepEqual(picked(), []);
    assert.equal(cb.checked, false);
    key('r');
    assert.deepEqual(picked(), []);
  });
  run('icActiveCell = 2'); // a click on the third chart
  key('x');
  assert.deepEqual(picked(), ['S2']);
  run('icPage = 1'); // second page: positions 4..7
  key('x');
  assert.deepEqual(picked(), ['S2', 'S6']);
});

test('X / R keys: paging or changing layout makes the first chart active again', () => {
  gridOf(10);
  run('var __realRender = icRenderPage, __realVis = icUpdateControlVisibility; icRenderPage = () => {}; icUpdateControlVisibility = () => {}'); // no DOM to render into here
  run('icActiveCell = 3; icNextPage()');
  assert.equal(run('icActiveCell'), 0);
  run('icActiveCell = 3; icPrevPage()');
  assert.equal(run('icActiveCell'), 0);
  run('icActiveCell = 3; icSetLayout("3x3")');
  assert.equal(run('icActiveCell'), 0);
  run("icSetLayout('2x2'); icRenderPage = __realRender; icUpdateControlVisibility = __realVis");
});

test('X / R keys: in 1x1 the single chart is always the active one, whatever was active before', () => {
  gridOf(5, '1x1');
  run('icActiveCell = 3; icPage = 2');
  key('x');
  assert.deepEqual(picked(), ['S2']);
  run("icLayout = '2x2'");
});

test('X / R keys: nothing happens in a text field or with Ctrl held, or on a page with no such chart', () => {
  gridOf(10);
  assert.equal(key('x', { target: { tagName: 'INPUT' } }), false);
  assert.equal(key('r', { ctrlKey: true }), false);
  assert.equal(key('a'), false);
  run('icPage = 5'); // past the end: no stock there
  assert.equal(key('x'), false);
  assert.deepEqual(picked(), []);
});

test('X / R keys: in single-stock mode they act on the stock shown, wherever the mouse is', () => {
  run("selectedStocks.clear(); icMode = 'single'; icSingleList = [{ isin: 'A', symbol: 'A' }, { isin: 'B', symbol: 'B' }]; icSingleIndex = 1");
  assert.equal(key('x'), true);
  assert.deepEqual(picked(), ['B']);
  key('r');
  assert.deepEqual(picked(), []);
  run("icMode = 'industry'; icSingleList = []; icSingleIndex = -1");
});

// ── Active chart in the grid: rendering, clicking, selection sync ─────────────

// A minimal DOM for icRenderPage: a grid that collects the cells it is given.
function fakeGrid() {
  const cells = [];
  const grid = { style: {}, classList: { toggle() {}, add() {}, remove() {} }, appendChild: c => cells.push(c), set innerHTML(_) { cells.length = 0; } };
  const realGet = sb.document.getElementById, realCreate = sb.document.createElement;
  const fakeEl = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, addEventListener() {} });
  sb.document.getElementById = id => (id === 'icGrid' ? grid : fakeEl());
  sb.document.createElement = () => {
    const classes = new Set();
    return { dataset: {}, classList: { add: c => classes.add(c), contains: c => classes.has(c) }, set innerHTML(_) {}, className: '' };
  };
  return { cells, restore() { sb.document.getElementById = realGet; sb.document.createElement = realCreate; } };
}
const withGrid = fn => {
  const g = fakeGrid();
  sb.Store.dailyBySymbol = {}; // no price history: cells are built, no charts
  try { fn(g.cells); } finally { g.restore(); }
};
const activeCells = cells => cells.map((c, i) => (c.classList.contains('ic-cell-active') ? i : -1)).filter(i => i >= 0);

test('icRenderPage: the active chart gets the highlight class, and every cell knows its position and stock', () => {
  gridOf(10);
  withGrid(cells => {
    run('icActiveCell = 2; icRenderPage()');
    assert.equal(cells.length, 4);
    assert.deepEqual(activeCells(cells), [2]);
    assert.deepEqual(cells.map(c => Number(c.dataset.idx)), [0, 1, 2, 3]);
    assert.deepEqual(cells.map(c => c.dataset.isin), ['S0', 'S1', 'S2', 'S3']);
  });
});

test('icRenderPage: the first chart is highlighted by default', () => {
  gridOf(10);
  withGrid(cells => {
    run('icRenderPage()');
    assert.deepEqual(activeCells(cells), [0]);
  });
});

test('icRenderPage: a last page with fewer charts than the active position falls back to the first chart', () => {
  gridOf(6); // 2x2: the second page holds only S4 and S5
  withGrid(cells => {
    run('icPage = 1; icActiveCell = 3; icRenderPage()');
    assert.equal(run('icActiveCell'), 0);
    assert.deepEqual(activeCells(cells), [0]);
    assert.equal(cells[3].dataset.isin, undefined, 'the empty filler cell has no stock');
  });
});

test('icRenderPage: 1x1 shows no highlight (the one chart is always the active one)', () => {
  gridOf(5, '1x1');
  withGrid(cells => {
    run('icPage = 3; icRenderPage()');
    assert.equal(cells.length, 1);
    assert.deepEqual(activeCells(cells), []);
    assert.equal(cells[0].dataset.isin, 'S3');
  });
  run("icLayout = '2x2'");
});

test('icRenderPage: re-rendering the same page (e.g. ADR / Avg MF toggled) keeps the active chart', () => {
  gridOf(10);
  withGrid(cells => {
    run('icActiveCell = 1; icRefreshCurrentView()');
    assert.equal(run('icActiveCell'), 1);
    assert.deepEqual(activeCells(cells), [1]);
  });
});

// A chart cell as the grid builds it; the first one starts highlighted.
function fakeCell(idx, isin) {
  const classes = new Set(idx === 0 ? ['ic-cell-active'] : []);
  return { dataset: { idx: String(idx), isin }, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) } };
}
// A click whose target is inside `cell` (e.target.closest('.ic-cell') finds it), or outside every cell when null.
function clickOn(cells, cell) {
  const realQsa = sb.document.querySelectorAll;
  sb.document.querySelectorAll = sel => (sel === '#icGrid .ic-cell' ? cells : []);
  try { sb.__ev = { target: { closest: sel => (sel === '.ic-cell' ? cell : null) } }; run('icOnGridPointerDown(__ev)'); }
  finally { sb.document.querySelectorAll = realQsa; }
}

test('clicking a chart makes it the active one: the highlight moves and X / R then act on it', () => {
  gridOf(10);
  const cells = [0, 1, 2, 3].map(i => fakeCell(i, 'S' + i));
  clickOn(cells, cells[3]);
  assert.equal(run('icActiveCell'), 3);
  assert.deepEqual(activeCells(cells), [3]);
  key('x');
  assert.deepEqual(picked(), ['S3']);
  clickOn(cells, cells[1]);
  assert.deepEqual(activeCells(cells), [1]);
  key('x');
  assert.deepEqual(picked().sort(), ['S1', 'S3']);
});

test('clicking outside any chart, or on an empty filler cell, leaves the active chart alone', () => {
  gridOf(10);
  run('icActiveCell = 2');
  const cells = [0, 1, 2, 3].map(i => fakeCell(i, 'S' + i));
  clickOn(cells, null);
  assert.equal(run('icActiveCell'), 2);
  clickOn(cells, { dataset: { idx: '3' } }); // empty cell: no stock
  assert.equal(run('icActiveCell'), 2);
});

test('clicking a chart in 1x1 does not add a highlight', () => {
  gridOf(5, '1x1');
  const cells = [fakeCell(0, 'S0')];
  cells[0].classList.toggle('ic-cell-active', false);
  clickOn(cells, cells[0]);
  assert.deepEqual(activeCells(cells), []);
  run("icLayout = '2x2'");
});

test('icSetStockSelected: keeps the count label and the single-stock checkbox in step', () => {
  run("selectedStocks.clear(); icMode = 'single'; icSingleList = [{ isin: 'A' }, { isin: 'B' }]; icSingleIndex = 0");
  const badge = { textContent: '' }, singleCb = { checked: false };
  const realGet = sb.document.getElementById;
  sb.document.getElementById = id => (id === 'icSelectedBadge' ? badge : id === 'icSingleSelectCb' ? singleCb : { style: {}, classList: { toggle() {} } });
  try {
    key('x');
    assert.equal(badge.textContent, '1 stock selected');
    assert.equal(singleCb.checked, true);
    run("icSetStockSelected('B', true)"); // another stock: the shown stock's checkbox is untouched
    assert.equal(badge.textContent, '2 stocks selected');
    assert.equal(singleCb.checked, true);
    key('r');
    assert.equal(badge.textContent, '1 stock selected');
    assert.equal(singleCb.checked, false);
  } finally { sb.document.getElementById = realGet; }
  run("selectedStocks.clear(); icMode = 'industry'; icSingleList = []; icSingleIndex = -1");
});

test('icSetStockSelected: an empty ISIN is ignored', () => {
  run('selectedStocks.clear()');
  run("icSetStockSelected('', true); icSetStockSelected(null, true)");
  assert.deepEqual(picked(), []);
});

test('X / R keys: only in the Stock Charts tab - the Industry Chart and Money Flow tabs ignore them', () => {
  gridOf(10);
  ['industry', 'moneyflow'].forEach(tab => {
    run(`icActiveTab = '${tab}'`);
    assert.equal(key('x'), false);
  });
  run("icActiveTab = 'stocks'");
  assert.deepEqual(picked(), []);
});

// ── Right-bar placement is remembered along with the range ──────────────────

test('placement: it starts at the default gap; a scrolled-back or wider-gap chart keeps the same width', () => {
  resetRange();
  assert.equal(run('icRightOffset'), run('IC_RIGHT_OFFSET'));
  const at = offset => {
    const inst = makeInst(Array.from({ length: 600 }, (_, i) => i + 1));
    sb.__inst = inst;
    run(`icApplyVisibleRange(__inst, 126, ${offset})`);
    return inst.fake.calls.visibleRange;
  };
  const def = at(10), back = at(-50), ahead = at(30);
  assert.equal(def.to - def.from, back.to - back.from);
  assert.equal(def.to - def.from, ahead.to - ahead.from);
  assert.equal(back.to, 600 - 1 - 50);
  assert.equal(ahead.to, 600 - 1 + 30);
});

test('placement: a zoom with the right edge untouched keeps the default placement', () => {
  resetRange();
  const { inst, listeners } = makeWatched();
  inst.fake.setRange({ from: 474, to: 609 });
  listeners.wheel();
  inst.fake.setRange({ from: 400, to: 609 }); // wider, same right edge
  assert.equal(run('icRightOffset'), 10);
  assert.equal(run('icRange'), 'custom');
  resetRange();
});

test('placement: a chart opened after a manual zoom + pan gets the remembered width and placement', () => {
  resetRange();
  const { inst, listeners } = makeWatched();
  inst.fake.setRange({ from: 474, to: 609 });
  listeners.wheel();
  inst.fake.setRange({ from: 300, to: 540 });
  const next = makeInst(Array.from({ length: 700 }, (_, i) => i + 1));
  sb.__next = next;
  run('icApplyVisibleRange(__next, icVisibleCandles(), icRightOffset)');
  const r = next.fake.calls.visibleRange;
  assert.equal(r.to, 700 - 1 + (540 - 599));
  assert.equal(r.to - r.from, 540 - 300);
  resetRange();
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

'use strict';
// js/chart-tools.js's ChartTools: the one-shot Measure / Trend Line drawing tools. The Lightweight Charts
// chart and series are replaced by tiny fakes with a trivial coordinate system (x = logical bar * 10,
// y = 1000 - price), so these tests cover the interaction logic - arming, one-shot behaviour, pane rules,
// selecting / deleting - not canvas drawing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/chart-tools.js']);
const ChartTools = vm.runInContext('ChartTools', sb); // class declarations are not properties of the sandbox

function setup() {
  const keyHandlers = [];
  sb.document.addEventListener = (type, fn) => { if (type === 'keydown') keyHandlers.push(fn); };

  const handlers = { click: null, move: null };
  const chart = {
    subscribeClick: (fn) => { handlers.click = fn; },
    subscribeCrosshairMove: (fn) => { handlers.move = fn; },
    timeScale: () => ({ logicalToCoordinate: (l) => l * 10 }),
  };
  const makeSeries = (paneIndex) => {
    const s = {
      getPane: () => ({ paneIndex: () => paneIndex }),
      coordinateToPrice: (y) => 1000 - y,
      priceToCoordinate: (p) => 1000 - p,
      attachPrimitive(p) { s.primitive = p; p.attached({ chart, series: s, requestUpdate: () => {} }); },
    };
    return s;
  };
  const makeButton = () => {
    const b = { disabled: false, active: false, listeners: {}, classList: { toggle: (_, on) => { b.active = !!on; } },
      addEventListener: (t, fn) => { b.listeners[t] = fn; } };
    return b;
  };
  const buttons = { measure: makeButton(), trend: makeButton(), clear: makeButton(), remove: makeButton() };
  const price = makeSeries(0), indicator = makeSeries(1);
  const tools = new ChartTools(chart, [{ series: price }, { series: indicator, unit: 'pts' }], { style: {} }, buttons);

  // a click at screen (x, price-pane y) in the given pane
  const click = (x, y, paneIndex = 0) => handlers.click({ point: { x, y }, logical: x / 10, paneIndex });
  const hover = (x, y, paneIndex = 0) => handlers.move({ point: { x, y }, logical: x / 10, paneIndex });
  const key = (k, target = {}) => keyHandlers.forEach(fn => fn({ key: k, target, preventDefault() {} }));
  return { tools, buttons, click, hover, key, price, indicator };
}

// a trend line from (100, y500 = price 500) to (300, y300 = price 700)
function drawTrend(t) {
  t.tools.arm('trend'); t.click(100, 500); t.click(300, 300);
}

test('a drawing needs a click on a tool button first: clicks do nothing unarmed', () => {
  const t = setup();
  t.click(100, 500); t.click(300, 300);
  assert.equal(t.tools.drawings.length, 0);
});

test('trend line: arm, click twice, draws once and disarms (one-shot)', () => {
  const t = setup();
  t.tools.arm('trend');
  assert.equal(t.buttons.trend.active, true);
  t.click(100, 500);
  assert.equal(t.tools.drawings.length, 0, 'first click only places the start');
  t.click(300, 300);
  assert.equal(t.tools.drawings.length, 1);
  assert.equal(t.tools.drawings[0].kind, 'trend');
  assert.equal(t.tools.armed, null);
  assert.equal(t.buttons.trend.active, false);
  t.click(50, 500); t.click(60, 400);
  assert.equal(t.tools.drawings.length, 1, 'a further pair of clicks draws nothing until re-armed');
});

test('drawings are stored as (bar, price) points', () => {
  const t = setup();
  drawTrend(t);
  const d = t.tools.drawings[0];
  assert.deepEqual([d.a.l, d.a.p, d.b.l, d.b.p], [10, 500, 30, 700]);
});

test('clicking the armed button again cancels it, as does Escape', () => {
  const t = setup();
  t.tools.arm('measure');
  t.click(100, 500);
  t.tools.arm('measure'); // second press cancels
  assert.equal(t.tools.armed, null);
  assert.equal(t.tools.pending, null);
  t.tools.arm('trend');
  t.click(100, 500);
  t.key('Escape');
  assert.equal(t.tools.armed, null);
  assert.equal(t.tools.pending, null);
  assert.equal(t.tools.drawings.length, 0);
});

test('both points must be in the same pane; the end click in another pane is ignored', () => {
  const t = setup();
  t.tools.arm('trend');
  t.click(100, 500, 0);
  t.click(300, 120, 1); // indicator pane: wrong pane for this drawing
  assert.equal(t.tools.drawings.length, 0);
  assert.ok(t.tools.pending, 'still waiting for the end point');
  t.click(300, 300, 0);
  assert.equal(t.tools.drawings.length, 1);
});

test('a drawing can be made in the indicator pane and belongs to that pane', () => {
  const t = setup();
  t.tools.arm('trend');
  t.click(100, 20, 1); t.click(200, 10, 1);
  assert.equal(t.tools.drawings.length, 1);
  assert.equal(t.tools.drawings[0].entry, t.tools.entries[1]);
});

test('only one measurement per pane: a new one replaces the old; trend lines accumulate', () => {
  const t = setup();
  t.tools.arm('measure'); t.click(100, 500); t.click(200, 400);
  t.tools.arm('measure'); t.click(120, 520); t.click(220, 420);
  assert.equal(t.tools.drawings.filter(d => d.kind === 'measure').length, 1);
  drawTrend(t); drawTrend(t);
  assert.equal(t.tools.drawings.filter(d => d.kind === 'trend').length, 2);
  // a measurement in the other pane does not replace the first pane's
  t.tools.arm('measure'); t.click(100, 20, 1); t.click(200, 10, 1);
  assert.equal(t.tools.drawings.filter(d => d.kind === 'measure').length, 2);
});

test('hovering with a start point set previews the end point', () => {
  const t = setup();
  t.tools.arm('trend');
  t.hover(150, 450); // nothing pending yet: ignored
  assert.equal(t.tools.preview, null);
  t.click(100, 500);
  t.hover(250, 350);
  assert.deepEqual([t.tools.preview.l, t.tools.preview.p], [25, 650]);
});

test('click near a trend line selects it; click on empty space deselects', () => {
  const t = setup();
  drawTrend(t);
  t.click(200, 404); // the line passes through (200, 400)
  assert.equal(t.tools.selected, t.tools.drawings[0]);
  assert.equal(t.buttons.remove.disabled, false);
  t.click(200, 440); // 40px away
  assert.equal(t.tools.selected, null);
  assert.equal(t.buttons.remove.disabled, true);
});

test('click inside a measure box selects it', () => {
  const t = setup();
  t.tools.arm('measure'); t.click(100, 500); t.click(300, 300);
  t.click(200, 400);
  assert.equal(t.tools.selected, t.tools.drawings[0]);
  t.click(500, 400);
  assert.equal(t.tools.selected, null);
});

test('a click in a different pane does not select a drawing from another pane', () => {
  const t = setup();
  drawTrend(t);
  t.click(200, 400, 1);
  assert.equal(t.tools.selected, null);
});

test('Delete button and Delete / Backspace keys remove only the selected drawing', () => {
  const t = setup();
  drawTrend(t);
  t.tools.arm('trend'); t.click(100, 700); t.click(300, 600); // a second line, far from the first
  assert.equal(t.tools.drawings.length, 2);

  t.click(200, 404);
  t.buttons.remove.listeners.click();
  assert.equal(t.tools.drawings.length, 1);
  assert.equal(t.tools.selected, null);

  t.click(200, 650); // select the second line
  assert.ok(t.tools.selected);
  t.key('Delete');
  assert.equal(t.tools.drawings.length, 0);

  drawTrend(t); t.click(200, 404);
  t.key('Backspace');
  assert.equal(t.tools.drawings.length, 0);
});

test('the Delete key is ignored while typing in a form control', () => {
  const t = setup();
  drawTrend(t); t.click(200, 404);
  t.key('Delete', { tagName: 'INPUT' });
  assert.equal(t.tools.drawings.length, 1);
  t.key('Delete', { tagName: 'SELECT' });
  assert.equal(t.tools.drawings.length, 1);
});

test('arming a tool deselects the current selection', () => {
  const t = setup();
  drawTrend(t); t.click(200, 404);
  assert.ok(t.tools.selected);
  t.tools.arm('measure');
  assert.equal(t.tools.selected, null);
});

test('clear() removes everything; clear(paneIndex) only that pane', () => {
  const t = setup();
  drawTrend(t);
  t.tools.arm('trend'); t.click(100, 20, 1); t.click(200, 10, 1);
  assert.equal(t.tools.drawings.length, 2);
  t.tools.clear(1);
  assert.equal(t.tools.drawings.length, 1);
  assert.equal(t.tools.drawings[0].entry, t.tools.entries[0]);
  t.buttons.clear.listeners.click();
  assert.equal(t.tools.drawings.length, 0);
});

test('clearing a pane also drops a selection that was in it', () => {
  const t = setup();
  drawTrend(t); t.click(200, 404);
  t.tools.clear(0);
  assert.equal(t.tools.selected, null);
});

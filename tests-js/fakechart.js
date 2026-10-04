'use strict';
// A minimal stand-in for a Lightweight Charts chart + series, for tests of the code that wires up chart
// behaviour (crosshair sync, drawing tools, visible range) rather than canvas drawing. It records what the code
// under test asked of it and lets a test fire the chart's click / crosshair-move events by hand.
// Trivial coordinate system, same as chart-tools.test.js: x = logical bar * 10, y = 1000 - price.
function makeFakeChart() {
  const handlers = { click: [], move: [] };
  const calls = { crosshair: [], cleared: 0, visibleRange: null, fit: 0 };
  const drop = (list, fn) => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  const chart = {
    subscribeClick: fn => handlers.click.push(fn),
    subscribeCrosshairMove: fn => handlers.move.push(fn),
    unsubscribeClick: fn => drop(handlers.click, fn),
    unsubscribeCrosshairMove: fn => drop(handlers.move, fn),
    setCrosshairPosition: (price, time, series) => calls.crosshair.push({ price, time, series }),
    clearCrosshairPosition: () => { calls.cleared++; },
    timeScale: () => ({
      logicalToCoordinate: l => l * 10,
      setVisibleLogicalRange: r => { calls.visibleRange = r; },
      fitContent: () => { calls.fit++; },
    }),
  };
  const makeSeries = (paneIndex = 0) => {
    const s = {
      primitive: null,
      getPane: () => ({ paneIndex: () => paneIndex }),
      coordinateToPrice: y => 1000 - y,
      priceToCoordinate: p => 1000 - p,
      attachPrimitive(p) { s.primitive = p; p.attached({ chart, series: s, requestUpdate: () => {} }); },
      detachPrimitive(p) { if (s.primitive === p) s.primitive = null; },
    };
    return s;
  };
  // A click / hover at screen (x, y) in a pane, as the library would report it.
  const click = (x, y, paneIndex = 0) => handlers.click.slice().forEach(fn => fn({ point: { x, y }, logical: x / 10, paneIndex }));
  const hover = (x, y, paneIndex = 0) => handlers.move.slice().forEach(fn => fn({ point: { x, y }, logical: x / 10, paneIndex }));
  return { chart, handlers, calls, makeSeries, click, hover };
}

module.exports = { makeFakeChart };

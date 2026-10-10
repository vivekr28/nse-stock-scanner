'use strict';
// js/industry-charts.js, the chart popup, driven through the listeners and render functions the page actually
// uses (not just the helpers): the keyboard / click handlers registered on `document`, the checkbox `change`
// listeners, closeIndustryCharts(), and what icRenderPage() / icRenderSingleStock() write into the header.
// Unlike load.js's sandbox, this one keeps one element per id and records every addEventListener, so a test can
// fire the same event the browser would.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.dirname(__dirname);
const SCRIPTS = ['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/chart-tools.js', 'js/industry-charts.js'];

function loadPopup() {
  const els = {};
  const docListeners = {};
  const make = (id) => {
    const listeners = {};
    const classes = new Set();
    const el = {
      id, listeners, value: '', checked: false, innerHTML: '', textContent: '', style: {}, dataset: {}, children: [],
      className: '', title: '', disabled: false, attrs: {},
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
      },
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener() {},
      appendChild(c) { el.children.push(c); },
      setAttribute: (k, v) => { el.attrs[k] = v; },
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }), getContext: () => null,
    };
    return el;
  };
  const document = {
    getElementById: id => els[id] || (els[id] = make(id)),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => make('created'),
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener() {},
    documentElement: {},
  };
  const sandbox = { console, document, window: null, Store: { dailyBySymbol: {}, latestBySymbol: {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  const run = code => vm.runInContext(code, sandbox);
  const el = id => document.getElementById(id);
  // Fire a document-level event at every handler registered for it, as the browser would.
  const fire = (type, evt) => (docListeners[type] || []).slice().forEach(fn => fn(evt));
  const key = (k) => {
    const evt = { key: k, target: { tagName: 'BODY' }, prevented: 0, preventDefault() { evt.prevented++; } };
    fire('keydown', evt);
    return evt;
  };
  return { sandbox, run, el, fire, key, docListeners };
}

const modalOpen = p => p.el('industryChartsModal').classList.contains('active');

// A popup as it is when open: modal active, Indicators menu hidden (as in index.html).
function openPopup() {
  const p = loadPopup();
  p.el('industryChartsModal').classList.add('active');
  p.el('icIndicatorsMenu').style.display = 'none';
  p.run("icMode = 'industry'; icActiveTab = 'stocks'");
  return p;
}

// --- Indicators dropdown: the real listeners ---------------------------------------------------------

test('Escape with the Indicators menu open closes only the menu; the next Escape closes the popup', () => {
  const p = openPopup();
  p.sandbox.icSetIndicatorsOpen(true);
  const first = p.key('Escape');
  assert.equal(p.el('icIndicatorsMenu').style.display, 'none');
  assert.equal(modalOpen(p), true, 'the popup must stay open');
  assert.ok(first.prevented >= 1);
  p.key('Escape');
  assert.equal(modalOpen(p), false, 'a second Escape closes the popup');
});

test('Escape with the menu closed closes the popup straight away', () => {
  const p = openPopup();
  p.key('Escape');
  assert.equal(modalOpen(p), false);
});

test('a click elsewhere on the page closes the open menu; a click inside it does not', () => {
  const p = openPopup();
  p.sandbox.icSetIndicatorsOpen(true);
  p.fire('click', { target: { closest: sel => (sel === '#icIndicatorsDd' ? {} : null) } });
  assert.equal(p.el('icIndicatorsMenu').style.display, '');
  p.fire('click', { target: { closest: () => null } });
  assert.equal(p.el('icIndicatorsMenu').style.display, 'none');
});

test('closing the popup also closes the menu, so it is not open next time', () => {
  const p = openPopup();
  p.sandbox.icSetIndicatorsOpen(true);
  p.sandbox.closeIndustryCharts();
  assert.equal(p.el('icIndicatorsMenu').style.display, 'none');
  assert.equal(p.el('icIndicatorsBtn').attrs['aria-expanded'], 'false');
});

test('every indicator checkbox (10/20/50 SMA, Purple Dots) updates the badge on change', () => {
  const p = openPopup();
  for (const id of ['icSMA10', 'icSMA20', 'icSMA50', 'icShowMFDots']) {
    assert.ok((p.el(id).listeners.change || []).length >= 1, `${id} has no change listener`);
  }
  const fireChange = id => p.el(id).listeners.change.forEach(fn => fn({}));
  for (const id of ['icSMA10', 'icSMA20', 'icSMA50', 'icShowMFDots']) p.el(id).checked = false;
  fireChange('icSMA10');
  assert.equal(p.el('icIndicatorsCount').textContent, '');
  p.el('icSMA10').checked = true;  fireChange('icSMA10');
  assert.equal(p.el('icIndicatorsCount').textContent, '1');
  p.el('icShowMFDots').checked = true;  fireChange('icShowMFDots');
  assert.equal(p.el('icIndicatorsCount').textContent, '2');
  p.el('icSMA50').checked = true;  fireChange('icSMA50');
  assert.equal(p.el('icIndicatorsCount').textContent, '3');
});

test('ticking an SMA redraws the SMA lines on every chart; Purple Dots redraws the dots', () => {
  const p = openPopup();
  const smaCalls = [], dotCalls = [];
  p.sandbox.icUpdateInstanceSMA = inst => smaCalls.push(inst);
  p.sandbox.icUpdateInstanceMFDots = inst => dotCalls.push(inst);
  p.sandbox.__insts = [{ n: 1 }, { n: 2 }];
  p.run('icChartInstances = __insts');
  p.el('icSMA50').listeners.change.forEach(fn => fn({}));
  assert.equal(smaCalls.length, 2, 'both charts should be asked to redraw their SMAs');
  assert.equal(dotCalls.length, 0);
  p.el('icShowMFDots').listeners.change.forEach(fn => fn({}));
  assert.equal(dotCalls.length, 2, 'both charts should be asked to redraw their purple dots');
});

// --- headers: what the render functions write ---------------------------------------------------------

// computeDynADR / computeDynSMA come from screener.js, which the popup uses for the ADR / Avg MF line.
function withStats(p) {
  p.sandbox.computeDynADR = () => 4.77;
  p.sandbox.computeDynSMA = () => 26780;                  // turnover units as stored: fmtTurnoverCr(26780) = 267.8 Cr
  p.el('icShowADR').checked = true;
  p.el('icShowAvgMF').checked = true;
}

test('grid cell header: checkbox, then ADR / Avg MF, then market cap - on ONE line, no symbol', () => {
  const p = openPopup();
  withStats(p);
  p.sandbox.__stock = { isin: 'INE0000001', symbol: 'KMSUGAR', companyName: 'K M SUGAR MILLS LTD', marketCap: 1100 };
  p.run("icStocks = [__stock]; icPage = 0; icActiveCell = 0; icLayout = '2x2'");
  p.sandbox.icRenderPage();
  const cell = p.el('icGrid').children[0];
  assert.ok(cell, 'no cell was rendered');
  const html = cell.innerHTML;
  const iCheckbox = html.indexOf('ic-select-cb');
  const iStats = html.indexOf('ADR 4.77%');
  const iMcap = html.indexOf('ic-cell-mcap');
  assert.ok(iCheckbox >= 0 && iStats > iCheckbox && iMcap > iStats, `order: checkbox ${iCheckbox}, stats ${iStats}, mcap ${iMcap}`);
  assert.match(html, /ADR 4\.77% · MF 267\.8 Cr/);
  assert.doesNotMatch(html, /KMSUGAR/);                                   // the ticker is on the chart, not here
  assert.doesNotMatch(html, /<div class="ic-cell-line2"/);              // no second line under the checkbox row
});

test('grid cell header: with both stats off there is no stats element at all', () => {
  const p = openPopup();
  withStats(p);
  p.el('icShowADR').checked = false;
  p.el('icShowAvgMF').checked = false;
  p.sandbox.__stock = { isin: 'INE0000002', symbol: 'AAA', marketCap: 50 };
  p.run("icStocks = [__stock]; icPage = 0; icActiveCell = 0; icLayout = '2x2'");
  p.sandbox.icRenderPage();
  const html = p.el('icGrid').children[0].innerHTML;
  assert.doesNotMatch(html, /ic-cell-stats/);
  assert.match(html, /ic-cell-mcap/);
});

test('single-stock view: title is the industry only, ADR / Avg MF text is set for the same line, nav state is right', () => {
  const p = openPopup();
  withStats(p);
  const stock = { isin: 'INE0000003', symbol: 'KMSUGAR', industry: 'Sugar', companyName: 'K M SUGAR MILLS LTD' };
  p.sandbox.__list = [stock];
  p.run("icMode = 'single'; icSingleList = __list; icSingleIndex = 0");
  p.sandbox.icRenderSingleStock();
  assert.equal(p.el('icTitle').textContent, 'Sugar');
  assert.equal(p.el('icTitle').onclick, null, 'the title no longer names the stock, so it is not click-to-select');
  assert.equal(p.el('icSingleStats').textContent, 'ADR 4.77% · MF 267.8 Cr');
  assert.match(p.el('icSinglePageInfo').textContent, /^1 of 1 stocks$/);
  assert.equal(p.el('icSinglePrevBtn').disabled, true);
  assert.equal(p.el('icSingleNextBtn').disabled, true);
});

test('single-stock view: an industry-less stock falls back to Undefined-Diversified', () => {
  const p = openPopup();
  withStats(p);
  p.sandbox.__list = [{ isin: 'INE0000004', symbol: 'ZZZ' }];
  p.run("icMode = 'single'; icSingleList = __list; icSingleIndex = 0");
  p.sandbox.icRenderSingleStock();
  assert.equal(p.el('icTitle').textContent, 'Undefined-Diversified');
});

test('single-stock navigation: the < and > buttons are disabled only at the ends', () => {
  const p = openPopup();
  withStats(p);
  p.sandbox.__list = [1, 2, 3].map(n => ({ isin: 'INE000000' + n, symbol: 'S' + n, industry: 'Sugar' }));
  p.run("icMode = 'single'; icSingleList = __list; icSingleIndex = 1");
  p.sandbox.icRenderSingleStock();
  assert.deepEqual([p.el('icSinglePrevBtn').disabled, p.el('icSingleNextBtn').disabled], [false, false]);
  p.sandbox.icNextStock();
  assert.deepEqual([p.el('icSinglePrevBtn').disabled, p.el('icSingleNextBtn').disabled], [false, true]);
  assert.equal(p.el('icSinglePageInfo').textContent, '3 of 3 stocks');
  p.sandbox.icPrevStock();
  p.sandbox.icPrevStock();
  assert.deepEqual([p.el('icSinglePrevBtn').disabled, p.el('icSingleNextBtn').disabled], [true, false]);
});

test('grid navigation: < > are disabled on the first / last page', () => {
  const p = openPopup();
  withStats(p);
  p.sandbox.__stocks = Array.from({ length: 9 }, (_, i) => ({ isin: 'INE00000' + i, symbol: 'S' + i, marketCap: i }));
  p.run("icStocks = __stocks; icPage = 0; icActiveCell = 0; icLayout = '2x2'");   // 9 stocks / 4 per page = 3 pages
  p.sandbox.icRenderPage();
  assert.deepEqual([p.el('icPrevBtn').disabled, p.el('icNextBtn').disabled], [true, false]);
  p.sandbox.icNextPage();
  assert.deepEqual([p.el('icPrevBtn').disabled, p.el('icNextBtn').disabled], [false, false]);
  p.sandbox.icNextPage();
  assert.deepEqual([p.el('icPrevBtn').disabled, p.el('icNextBtn').disabled], [false, true]);
  assert.equal(p.el('icPageInfo').textContent, 'Page 3 of 3 (9 stocks)');
});

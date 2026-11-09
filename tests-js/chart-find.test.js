'use strict';
// The chart popup's type-to-jump stock search (js/industry-charts.js + index.html): typing a symbol / name on the single-stock chart or the Stock
// Charts tab opens a box of the best matches among all stocks; Enter / a click brings the stock up (in the grid when it is one of the industry's,
// otherwise in the single-stock view). Top-level `let` state is read / written through run().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const html = fs.readFileSync(path.join(path.dirname(__dirname), 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(path.dirname(__dirname), 'css', 'styles.css'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/chart-tools.js', 'js/industry-charts.js']);
const run = code => vm.runInContext(code, sb);

// Stocks: [isin, symbol, company name, market cap, has bars]
const STOCKS = [
  ['I1', 'RELIANCE', 'RELIANCE INDUSTRIES LTD', 2000, true],
  ['I2', 'RPOWER', 'RELIANCE POWER LTD', 50, true],
  ['I3', 'RELINFRA', 'RELIANCE INFRASTRUCTURE LTD', 40, true],
  ['I4', 'TCS', 'TATA CONSULTANCY SERVICES LTD', 1500, true],
  ['I5', 'INFY', 'INFOSYS LTD', 1200, true],
  ['I6', 'NIFTYBEES', 'NIPPON INDIA ETF RELIANCE LINKED', 10, true],
  ['I7', 'RELNOBARS', 'RELIANCE NO BARS LTD', 999, false],
  ['I8', 'M&M', 'MAHINDRA & MAHINDRA LTD', 800, true],
  ['I9', 'RELAXO', 'RELAXO FOOTWEARS LTD', 30, true],
];

function page({ mode = 'industry', tab = 'stocks' } = {}) {
  const dom = installFakeDom(sb);
  dom.el('industryChartsModal').classList.contains = c => c === 'active';
  dom.el('icFind').style.display = 'none';
  sb.Store.latestBySymbol = {};
  sb.Store.dailyBySymbol = {};
  for (const [isin, symbol, companyName, marketCap, bars] of STOCKS) {
    sb.Store.latestBySymbol[isin] = { isin, symbol, companyName, marketCap };
    sb.Store.dailyBySymbol[isin] = bars ? [{ date: '01-Jan-2026' }] : [];
  }
  run(`icMode = '${mode}'; icActiveTab = '${tab}'`);
  return dom;
}

const symbols = list => Array.from(list).map(s => s.symbol);
const keyEvent = (key, extra = {}) => ({ key, target: { tagName: 'BODY' }, stopped: 0, prevented: 0, stopPropagation() { this.stopped++; }, preventDefault() { this.prevented++; }, ...extra });

// --- matching -------------------------------------------------------------------------------------------

test('matches: exact symbol, then symbol prefix, then name prefix, then a word of the name, then contains; bigger company first within a rank', () => {
  page();
  assert.deepEqual(symbols(sb.icFindStocks('rel')), ['RELIANCE', 'RELINFRA', 'RELAXO', 'RPOWER', 'NIFTYBEES']);
  // RELIANCE / RELINFRA / RELAXO: symbol prefix (cap order 2000, 40, 30); RPOWER: a name word "RELIANCE POWER"; NIFTYBEES: name word "... RELIANCE LINKED"
  assert.deepEqual(symbols(sb.icFindStocks('tcs')), ['TCS']);
  assert.deepEqual(symbols(sb.icFindStocks('TATA')), ['TCS']);                 // name prefix, any case
  assert.deepEqual(symbols(sb.icFindStocks('consultancy')), ['TCS']);          // a word inside the name
  assert.deepEqual(symbols(sb.icFindStocks('fosys')), ['INFY']);               // anywhere in the name
  assert.deepEqual(symbols(sb.icFindStocks('m&m')), ['M&M']);                  // symbols with punctuation
});

test('matches: only stocks with a chart, nothing for an empty box, at most 8', () => {
  page();
  assert.ok(!symbols(sb.icFindStocks('relnobars')).includes('RELNOBARS'));      // no daily bars: nothing to show
  assert.equal(sb.icFindStocks('').length, 0);
  assert.equal(sb.icFindStocks('   ').length, 0);
  for (let i = 0; i < 20; i++) { sb.Store.latestBySymbol['Z' + i] = { isin: 'Z' + i, symbol: 'ZZ' + i, companyName: 'ZED', marketCap: i }; sb.Store.dailyBySymbol['Z' + i] = [{}]; }
  assert.equal(sb.icFindStocks('zz').length, 8);
  assert.equal(sb.icFindStocks('zz', 3).length, 3);
});

// --- starting a search by typing --------------------------------------------------------------------------

test('typing a letter or digit on the Stock Charts tab opens the box with that character, focused, and matches already listed', () => {
  const dom = page({ mode: 'industry', tab: 'stocks' });
  let focused = 0;
  dom.el('icFindInput').focus = () => { focused++; };
  const e = keyEvent('r');
  assert.equal(sb.icFindStartKey(e), true);
  assert.equal(sb.icFindIsOpen(), true);
  assert.equal(dom.el('icFindInput').value, 'r');
  assert.equal(focused, 1);
  assert.deepEqual(symbols(run('icFindMatches')).slice(0, 2), ['RELIANCE', 'RPOWER']);   // both start with R: the bigger company first
  assert.match(dom.el('icFindList').innerHTML, /<b>RELIANCE<\/b><span>RELIANCE INDUSTRIES LTD<\/span>/);
  assert.match(dom.el('icFindList').innerHTML, /ic-find-row active/);
  sb.icFindSetOpen(false);
  assert.equal(sb.icFindIsOpen(), false);
});

test('a letter that used to be a shortcut (X, R) starts the search too, and so does a digit', () => {
  const dom = page();
  dom.el('icFindInput').focus = () => {};
  assert.equal(sb.icFindStartKey(keyEvent('x')), true);
  sb.icFindSetOpen(false);
  assert.equal(sb.icFindStartKey(keyEvent('5')), true);
  sb.icFindSetOpen(false);
});

test('it also starts on the single-stock chart, but not on the Industry Chart / Money Flow tabs or with the popup closed', () => {
  const dom = page({ mode: 'single' });
  dom.el('icFindInput').focus = () => {};
  assert.equal(sb.icFindStartKey(keyEvent('t')), true);
  sb.icFindSetOpen(false);
  for (const tab of ['industry', 'moneyflow']) {
    run(`icMode = 'industry'; icActiveTab = '${tab}'`);
    assert.equal(sb.icFindStartKey(keyEvent('t')), false, tab);
  }
  run("icMode = 'industry'; icActiveTab = 'stocks'");
  dom.el('industryChartsModal').classList.contains = () => false;
  assert.equal(sb.icFindStartKey(keyEvent('t')), false);
});

test('it ignores keys that are not typing: Ctrl / Alt / Meta combos, arrows, space, punctuation, and typing in a text field', () => {
  const dom = page();
  dom.el('icFindInput').focus = () => {};
  for (const e of [keyEvent('a', { ctrlKey: true }), keyEvent('a', { altKey: true }), keyEvent('a', { metaKey: true }),
    keyEvent('ArrowDown'), keyEvent('Escape'), keyEvent(' '), keyEvent('/'), keyEvent('Enter'),
    keyEvent('a', { target: { tagName: 'INPUT' } }), keyEvent('a', { target: { tagName: 'SELECT' } }), keyEvent('a', { target: { isContentEditable: true } })]) {
    assert.equal(sb.icFindStartKey(e), false, e.key);
  }
  assert.equal(sb.icFindIsOpen(), false);
});

// --- keys inside the box ---------------------------------------------------------------------------------

test('Up / Down move the highlight and wrap; none of the keys reach the popup (stopPropagation)', () => {
  const dom = page();
  dom.el('icFindInput').focus = () => {};
  sb.icFindStartKey(keyEvent('r'));
  const n = run('icFindMatches.length');
  assert.ok(n >= 3);
  const down = keyEvent('ArrowDown');
  sb.icFindOnKey(down);
  assert.equal(run('icFindPos'), 1);
  assert.equal(down.stopped, 1);
  assert.equal(down.prevented, 1);
  sb.icFindOnKey(keyEvent('ArrowUp'));
  sb.icFindOnKey(keyEvent('ArrowUp'));
  assert.equal(run('icFindPos'), n - 1);                       // wrapped to the last match
  sb.icFindOnKey(keyEvent('ArrowDown'));
  assert.equal(run('icFindPos'), 0);
  const other = keyEvent('b');
  sb.icFindOnKey(other);
  assert.equal(other.stopped, 1);                              // typing a letter stays in the box
  assert.equal(other.prevented, 0);
  sb.icFindSetOpen(false);
});

test('Enter opens the highlighted stock and closes the box; Escape closes it without opening anything', () => {
  const dom = page();
  dom.el('icFindInput').focus = () => {};
  const jumped = [];
  const real = sb.icJumpToStock;
  sb.icJumpToStock = isin => jumped.push(isin);
  try {
    sb.icFindStartKey(keyEvent('r'));
    sb.icFindOnKey(keyEvent('ArrowDown'));                     // RPOWER (the second R match by market cap)
    sb.icFindOnKey(keyEvent('Enter'));
    assert.deepEqual(jumped, ['I2']);
    assert.equal(sb.icFindIsOpen(), false);
    assert.equal(dom.el('icFindInput').value, '');
    sb.icFindStartKey(keyEvent('t'));
    const esc = keyEvent('Escape');
    sb.icFindOnKey(esc);
    assert.equal(sb.icFindIsOpen(), false);
    assert.equal(esc.stopped, 1);
    assert.deepEqual(jumped, ['I2']);
    sb.icFindStartKey(keyEvent('q'));                          // matches nothing: Enter does nothing
    assert.match(dom.el('icFindList').innerHTML, /No stock matches/);
    sb.icFindOnKey(keyEvent('Enter'));
    assert.deepEqual(jumped, ['I2']);
    sb.icFindSetOpen(false);
  } finally { sb.icJumpToStock = real; }
});

test('clicking a row opens that stock (the row is wired to icFindPick)', () => {
  const dom = page();
  dom.el('icFindInput').focus = () => {};
  sb.icFindStartKey(keyEvent('t'));
  assert.match(dom.el('icFindList').innerHTML, /onmousedown="event\.preventDefault\(\); icFindPick\('I4'\)"/);
  sb.icFindSetOpen(false);
});

// --- where it goes -----------------------------------------------------------------------------------------

function jumpSetup(layout, n) {
  page({ mode: 'industry', tab: 'stocks' });
  run(`icLayout = '${layout}'; icPage = 0; icActiveCell = 0; icStocks = Array.from({ length: ${n} }, (_, i) => ({ isin: 'S' + i }))`);
  const calls = [];
  const real = [sb.icRenderPage, sb.openStockChart];
  sb.icRenderPage = () => calls.push('page');
  sb.openStockChart = isin => calls.push('single:' + isin);
  return { calls, restore: () => { [sb.icRenderPage, sb.openStockChart] = real; run("icLayout = '2x2'"); } };
}

test('a stock of the industry on show is brought up in the grid: its page, and the active chart on it', () => {
  const t = jumpSetup('2x2', 10);
  try {
    sb.icJumpToStock('S6');                                     // 7th stock: page 2 (index 1), 3rd cell
    assert.equal(run('icPage'), 1);
    assert.equal(run('icActiveCell'), 2);
    run("icLayout = '1x1'");
    sb.icJumpToStock('S7');                                     // 1x1: one stock a page
    assert.equal(run('icPage'), 7);
    assert.equal(run('icActiveCell'), 0);
    run("icLayout = '3x3'");
    sb.icJumpToStock('S9');
    assert.equal(run('icPage'), 1);
    assert.equal(run('icActiveCell'), 0);
    assert.deepEqual(t.calls, ['page', 'page', 'page']);
  } finally { t.restore(); }
});

test('any other stock - or any stock on the single-stock chart - opens in the single-stock view', () => {
  const t = jumpSetup('2x2', 10);
  try {
    sb.icJumpToStock('NOTHERE');                                // not in this industry
    run("icMode = 'single'");
    sb.icJumpToStock('S3');                                     // single view: always the single view
    assert.deepEqual(t.calls, ['single:NOTHERE', 'single:S3']);
  } finally { t.restore(); }
});

// --- page wiring ------------------------------------------------------------------------------------------

test('Alt+X / Alt+R select and deselect; plain X / R no longer do (they type into the search instead)', () => {
  page();
  sb.__e = { key: 'x', code: 'KeyX', altKey: false, target: { tagName: 'BODY' } };
  assert.equal(run('icHandleSelectKey(__e)'), false);
  sb.__e = { key: 'r', code: 'KeyR', altKey: false, target: { tagName: 'BODY' } };
  assert.equal(run('icHandleSelectKey(__e)'), false);
  run("selectedStocks.clear(); icMode = 'single'; icSingleList = [{ isin: 'I1', symbol: 'RELIANCE' }]; icSingleIndex = 0");
  sb.__e = { key: '≈', code: 'KeyX', altKey: true, target: { tagName: 'BODY' } };   // Option + X on a Mac types a symbol: the physical key counts
  assert.equal(run('icHandleSelectKey(__e)'), true);
  assert.deepEqual(Array.from(run('Array.from(selectedStocks)')), ['I1']);
  sb.__e = { key: 'r', code: 'KeyR', altKey: true, target: { tagName: 'BODY' } };
  assert.equal(run('icHandleSelectKey(__e)'), true);
  assert.deepEqual(Array.from(run('Array.from(selectedStocks)')), []);
  run("icMode = 'industry'; icSingleList = []; icSingleIndex = -1");
});

test('index.html has the box (hidden), its input and its list inside the popup, and the CSS pins it', () => {
  const modal = html.slice(html.indexOf('id="industryChartsModal"'));
  assert.match(modal, /<div class="ic-find" id="icFind" style="display:none;">/);
  assert.match(modal, /<input type="text" id="icFindInput" class="ic-find-input"[^>]*autocomplete="off"/);
  assert.match(modal, /<div class="ic-find-list" id="icFindList"><\/div>/);
  assert.ok(modal.indexOf('id="icFind"') < modal.indexOf('class="modal-header"'), 'the box sits above the header');
  for (const id of ['icFind', 'icFindInput', 'icFindList']) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  assert.match(css, /\.ic-find \{ position: fixed;/);
  assert.match(css, /\.ic-find-row\.active/);
});

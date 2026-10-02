'use strict';
// js/scanner.js's runScanner(): the Stocks tab - the scan-type filters (UC/LC hit, near 52-week high/low, above/below/near the
// 20 SMA, top turnover / ADR) and the sector / industry / minimum-turnover / symbol-search filters, and the stats row.
// The page is replaced by a fake DOM (see fakedom.js); renderScannerTable() (table drawing) is stubbed out, and the
// result list is read back from scannerResults.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/scanner.js']);
sb.renderScannerTable = () => {};

function stock(symbol, o = {}) {
  return {
    symbol, sector: 'Tech', industry: 'Software', turnover: 1000, adr: 3, hitUC: false, hitLC: false,
    distFrom52H: 40, distFrom52L: 40, aboveSMA: false, distFromSMA: 10, changePct: 0, ...o,
  };
}

// Runs the scanner over `stocks` with the given control values; returns the symbols in result order.
function scan(stocks, controls = {}) {
  const dom = installFakeDom(sb, { scanType: 'all', filterSector: 'ALL', filterIndustry: 'ALL', minTurnover: '', searchSymbol: '', ...controls });
  sb.Store.latestBySymbol = {};
  stocks.forEach((s, i) => { sb.Store.latestBySymbol['K' + i] = s; });
  sb.runScanner();
  scan.dom = dom;
  return Array.from(vm.runInContext('scannerResults', sb), s => s.symbol);   // copied into this realm for deepEqual
}

test('UC hit / LC hit: only stocks that closed at the upper / lower circuit', () => {
  const stocks = [stock('UC', { hitUC: true }), stock('LC', { hitLC: true }), stock('NEITHER')];
  assert.deepEqual(scan(stocks, { scanType: 'uc_hit' }), ['UC']);
  assert.deepEqual(scan(stocks, { scanType: 'lc_hit' }), ['LC']);
});

test('near 52-week high: 0-5% below it, nearest first, boundaries inclusive, negatives excluded', () => {
  const stocks = [stock('A', { distFrom52H: 5 }), stock('B', { distFrom52H: 0 }), stock('C', { distFrom52H: 5.01 }),
                  stock('D', { distFrom52H: -0.5 }), stock('E', { distFrom52H: 2.5 })];
  assert.deepEqual(scan(stocks, { scanType: 'near_52w_high' }), ['B', 'E', 'A']);
});

test('near 52-week low: 0-5% above it, nearest first, boundaries inclusive', () => {
  const stocks = [stock('A', { distFrom52L: 5 }), stock('B', { distFrom52L: 0 }), stock('C', { distFrom52L: 5.01 }),
                  stock('D', { distFrom52L: -1 }), stock('E', { distFrom52L: 1 })];
  assert.deepEqual(scan(stocks, { scanType: 'near_52w_low' }), ['B', 'E', 'A']);
});

test('above / below 20 SMA use the boolean flag strictly', () => {
  const stocks = [stock('UP', { aboveSMA: true }), stock('DOWN', { aboveSMA: false }), stock('UNKNOWN', { aboveSMA: undefined })];
  assert.deepEqual(scan(stocks, { scanType: 'above_20sma' }), ['UP']);
  assert.deepEqual(scan(stocks, { scanType: 'below_20sma' }), ['DOWN']);
});

test('near 20 SMA: within +-2%, closest first; stocks with no SMA (NaN) are excluded', () => {
  const stocks = [stock('A', { distFromSMA: 2 }), stock('B', { distFromSMA: -1 }), stock('C', { distFromSMA: 2.01 }),
                  stock('D', { distFromSMA: NaN }), stock('E', { distFromSMA: 0.2 }), stock('F', { distFromSMA: -2 })];
  assert.deepEqual(scan(stocks, { scanType: 'near_20sma' }), ['E', 'B', 'A', 'F']);
});

test('high turnover / high ADR: top 50 only, largest first', () => {
  const stocks = Array.from({ length: 60 }, (_, i) => stock('S' + i, { turnover: 100 + i, adr: 1 + i / 10 }));
  const byTurnover = scan(stocks, { scanType: 'high_turnover' });
  assert.equal(byTurnover.length, 50);
  assert.equal(byTurnover[0], 'S59');
  assert.equal(byTurnover[49], 'S10');
  const byAdr = scan(stocks, { scanType: 'high_adr' });
  assert.equal(byAdr.length, 50);
  assert.equal(byAdr[0], 'S59');
});

test('default scan: every stock, most turnover first', () => {
  const stocks = [stock('LOW', { turnover: 10 }), stock('HIGH', { turnover: 900 }), stock('MID', { turnover: 100 })];
  assert.deepEqual(scan(stocks), ['HIGH', 'MID', 'LOW']);
});

test('sector and industry filters narrow the list (and combine)', () => {
  const stocks = [stock('A', { sector: 'Tech', industry: 'Software' }), stock('B', { sector: 'Tech', industry: 'Hardware' }),
                  stock('C', { sector: 'Bank', industry: 'Software' })];
  assert.deepEqual(scan(stocks, { filterSector: 'Tech' }).sort(), ['A', 'B']);
  assert.deepEqual(scan(stocks, { filterIndustry: 'Software' }).sort(), ['A', 'C']);
  assert.deepEqual(scan(stocks, { filterSector: 'Tech', filterIndustry: 'Software' }), ['A']);
});

test('minimum turnover is entered in crores and compared with lakhs (x100)', () => {
  const stocks = [stock('SMALL', { turnover: 499 }), stock('EDGE', { turnover: 500 }), stock('BIG', { turnover: 5000 })];
  assert.deepEqual(scan(stocks, { minTurnover: '5' }).sort(), ['BIG', 'EDGE']);
  assert.deepEqual(scan(stocks, { minTurnover: '' }).length, 3);
});

test('symbol search is a case-insensitive substring match', () => {
  const stocks = [stock('RELIANCE'), stock('RELINFRA'), stock('TCS')];
  assert.deepEqual(scan(stocks, { searchSymbol: ' reli ' }).sort(), ['RELIANCE', 'RELINFRA']);
  assert.deepEqual(scan(stocks, { searchSymbol: 'tcs' }), ['TCS']);
});

test('stats row: counts, advancing / declining, above-SMA and average change', () => {
  const stocks = [stock('A', { changePct: 2, aboveSMA: true }), stock('B', { changePct: -1 }), stock('C', { changePct: 0 }),
                  stock('D', { changePct: 5, aboveSMA: true })];
  scan(stocks);
  const html = scan.dom.el('scannerStats').innerHTML.replace(/<[^>]+>/g, '|');
  const cell = (label) => html.split('|').filter(Boolean)[html.split('|').filter(Boolean).indexOf(label) + 1];
  assert.equal(cell('Results'), '4');
  assert.equal(cell('Advancing'), '2');
  assert.equal(cell('Declining'), '1');
  assert.equal(cell('Above 20 SMA'), '2');
  assert.equal(cell('Avg Change %'), '1.50%');   // (2 - 1 + 0 + 5) / 4
});

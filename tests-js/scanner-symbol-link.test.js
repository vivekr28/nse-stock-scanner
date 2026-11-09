'use strict';
// js/scanner.js's renderScannerTable(): on the Stocks tab the Symbol cell is a link that opens the chart popup (class "stock-link", the stock's
// ISIN in data-isin, as in the Stock Scanner table); the other cells are drawn as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/scanner.js']);
const run = code => vm.runInContext(code, sb);

test('Stocks tab: the Symbol cell links to the chart (stock-link + data-isin), escaped; other cells stay plain', () => {
  const dom = installFakeDom(sb);
  sb.__rows = [
    { isin: 'INE002A01018', symbol: 'RELIANCE', series: 'EQ', sector: 'Energy', industry: 'Refineries', close: 1500, changePct: 1.5 },
    { isin: 'INE\"X', symbol: 'M&M', series: 'EQ', close: 10, changePct: -1 },
  ];
  run('scannerResults = __rows; scannerPage = 0');
  sb.renderScannerTable();
  const body = dom.el('scannerBody').innerHTML;
  assert.match(body, /<td class=""><a href="#" class="stock-link" data-isin="INE002A01018">RELIANCE<\/a><\/td>/);
  assert.match(body, /data-isin="INE&quot;X">M&amp;M<\/a>/);                       // a symbol or ISIN cannot break out of the markup
  assert.match(body, /<td class="">EQ<\/td>/);                                      // the Series cell is still plain text
  assert.match(body, /<td class="positive">\+?1\.5/);                              // and the change % keeps its colour class
  assert.equal(body.split('stock-link').length - 1, 2);                           // one link per row, no more
});

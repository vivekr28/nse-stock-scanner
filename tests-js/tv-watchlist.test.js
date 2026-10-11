'use strict';
// The TradingView watchlist exports (Stock Scanner results, and the chart popup's selected stocks) join everything with
// commas, and TradingView splits the pasted text on commas - so a comma inside an industry name must not reach the text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/industry-charts.js']);
const stock = (symbol, industry) => ({ symbol, isin: symbol, industry });

// `let screenerPassed` is not a property of the sandbox global, so set it from inside the sandbox
const setPassed = list => { sb.__list = list; vm.runInContext('screenerPassed = __list', sb); };

function sections(text) {
  // "###Header(n),NSE:A,NSE:B,###Header2(n),..." -> every comma-separated piece must be a header or an NSE: symbol
  return text.split(',');
}

test('Stock Scanner export: commas inside an industry name become a space; every piece is a header or an NSE: symbol', () => {
  const dom = installFakeDom(sb, {});
  setPassed([stock('AAA', 'Compressors, Pumps & Diesel Engines'), stock('BBB', 'Compressors, Pumps & Diesel Engines'), stock('CCC', 'Gems, Jewellery And Watches'), stock('DDD', 'Banks')]);
  sb.exportTradingViewWatchlist();
  const text = dom.el('tvModalContent').textContent;
  assert.match(text, /###Compressors Pumps & Diesel Engines\(2\)/);
  assert.match(text, /###Gems Jewellery And Watches\(1\)/);
  assert.match(text, /###Banks\(1\)/);
  for (const piece of sections(text)) assert.ok(piece.startsWith('###') || piece.startsWith('NSE:'), `stray piece: ${piece}`);
  assert.equal(sections(text).filter(p => p.startsWith('NSE:')).length, 4);
});

test('chart popup "selected stocks" export: same', () => {
  const dom = installFakeDom(sb, {});
  sb.Store.latestBySymbol = { A: stock('AAA', 'Furniture, Home Furnishing'), B: stock('BBB', 'Banks') };
  vm.runInContext("selectedStocks = new Set(['A', 'B'])", sb);
  sb.copySelectedStocksWatchlist();
  const text = dom.el('tvModalContent').textContent;
  assert.match(text, /###Furniture Home Furnishing\(1\)/);
  for (const piece of sections(text)) assert.ok(piece.startsWith('###') || piece.startsWith('NSE:'), `stray piece: ${piece}`);
});

test('industry names without a comma are unchanged', () => {
  const dom = installFakeDom(sb, {});
  setPassed([stock('AAA', 'Undefined-Diversified')]);
  sb.exportTradingViewWatchlist();
  assert.equal(dom.el('tvModalContent').textContent, '###Undefined-Diversified(1),NSE:AAA');
});

test('"flat" mode: every passed stock once, no headers', () => {
  const dom = installFakeDom(sb, {});
  setPassed([stock('AAA', 'Banks'), stock('BBB', 'Gems, Jewellery And Watches'), stock('CCC', 'Banks')]);
  sb.exportTradingViewWatchlist('flat');
  assert.equal(dom.el('tvModalContent').textContent, 'NSE:AAA,NSE:BBB,NSE:CCC');
  assert.equal(dom.el('tvModalFooter').textContent, '3 stocks');
});

test('"sector" mode: grouped by sector, biggest group first, commas in names removed', () => {
  const dom = installFakeDom(sb, {});
  const withSector = (symbol, sector) => ({ symbol, isin: symbol, industry: 'Banks', sector });
  setPassed([withSector('AAA', 'Financial Services'), withSector('BBB', 'Oil, Gas & Consumable Fuels'), withSector('CCC', 'Financial Services'), withSector('DDD', undefined)]);
  sb.exportTradingViewWatchlist('sector');
  const text = dom.el('tvModalContent').textContent;
  assert.equal(text, '###Financial Services(2),NSE:AAA,NSE:CCC,###Oil Gas & Consumable Fuels(1),NSE:BBB,###Undefined-Diversified(1),NSE:DDD');
  assert.equal(dom.el('tvModalFooter').textContent, '4 stocks across 3 sectors');
});

test('no mode (and "industry") still groups by industry', () => {
  const dom = installFakeDom(sb, {});
  setPassed([stock('AAA', 'Banks')]);
  sb.exportTradingViewWatchlist();
  assert.equal(dom.el('tvModalContent').textContent, '###Banks(1),NSE:AAA');
  assert.equal(dom.el('tvModalFooter').textContent, '1 stocks across 1 industries');
});

// Every industry name in the project's real sector mapping (the git-tracked copy in reference-data/, so it runs in CI too)
// exports cleanly - guards against a future name with a comma, or any other separator TradingView would split on.
const fs = require('node:fs');
const path = require('node:path');
const MAPPING = path.join(path.dirname(__dirname), 'reference-data', 'Sector-Stock-Mapping.csv');

test('every real industry name exports as one header (no stray pieces)', { skip: !fs.existsSync(MAPPING) && 'reference-data/Sector-Stock-Mapping.csv not present' }, () => {
  const lines = fs.readFileSync(MAPPING, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  // the file is quoted CSV: take the "Basic Industry" column with a small quote-aware split
  const split = line => { const out = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const col = header.indexOf('Basic Industry');
  assert.ok(col >= 0, 'Basic Industry column not found');
  const industries = [...new Set(lines.slice(1).map(l => split(l)[col]).filter(Boolean))];
  assert.ok(industries.length > 50, 'expected many industries');
  assert.ok(industries.some(i => i.includes(',')), 'expected at least one industry with a comma (the case this guards)');

  const dom = installFakeDom(sb, {});
  setPassed(industries.map((ind, i) => stock('S' + i, ind)));
  sb.exportTradingViewWatchlist();
  const pieces = sections(dom.el('tvModalContent').textContent);
  const headers = pieces.filter(p => p.startsWith('###'));
  assert.equal(headers.length, industries.length, 'one header per industry');
  for (const p of pieces) assert.ok(p.startsWith('###') || p.startsWith('NSE:'), `stray piece: ${p}`);
});

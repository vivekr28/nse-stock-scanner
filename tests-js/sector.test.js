'use strict';
// js/sector.js's renderSectorAnalysis(): the Sector Analysis tab's grouping and arithmetic (stocks per sector, average
// change %, breadth = share above the 20 SMA, turnover, top gainer / loser) and its sort options, on a hand-worked fixture.
// The page is replaced by a fake DOM (fakedom.js); the table rows are read back from what the code wrote.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/sector.js']);

// Sector S1: A(+2, above, 100), B(-1, below, 50), C(+4, above, 30)  -> 3 stocks, avg +1.6667, breadth 66.67%, top C / bottom B
// Sector S2: D(-3, below, 70), E(+1, above, 10)                     -> 2 stocks, avg -1.00,   breadth 50%,    top E / bottom D
const FIXTURE = [
  { symbol: 'A', sector: 'S1', changePct: 2, aboveSMA: true, turnover: 100 },
  { symbol: 'B', sector: 'S1', changePct: -1, aboveSMA: false, turnover: 50 },
  { symbol: 'C', sector: 'S1', changePct: 4, aboveSMA: true, turnover: 30 },
  { symbol: 'D', sector: 'S2', changePct: -3, aboveSMA: false, turnover: 70 },
  { symbol: 'E', sector: 'S2', changePct: 1, aboveSMA: true, turnover: 10 },
];

function render(stocks, sort = 'avg_change') {
  const dom = installFakeDom(sb, { sectorSort: sort });
  sb.Store.latestBySymbol = {};
  stocks.forEach((s, i) => { sb.Store.latestBySymbol['K' + i] = { ...s }; });
  sb.renderSectorAnalysis();
  const rows = [...dom.el('sectorBody').innerHTML.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()));
  return rows;
}

test('groups stocks by sector and computes count, average change, breadth and top gainer / loser', () => {
  const rows = render(FIXTURE);
  const s1 = rows.find(r => r[0] === 'S1'), s2 = rows.find(r => r[0] === 'S2');
  assert.deepEqual(s1.slice(0, 3), ['S1', '3', '1.67%']);
  assert.match(s1[3], /67%/);                 // 2 of 3 above the SMA
  assert.match(s1[5], /^C \(/);               // top gainer
  assert.match(s1[6], /^B \(/);               // top loser
  assert.deepEqual(s2.slice(0, 3), ['S2', '2', '-1.00%']);
  assert.match(s2[3], /50%/);
  assert.match(s2[5], /^E \(/);
  assert.match(s2[6], /^D \(/);
});

test('sort options order the sectors', () => {
  assert.deepEqual(render(FIXTURE, 'avg_change').map(r => r[0]), ['S1', 'S2']);   // +1.67 before -1.00
  assert.deepEqual(render(FIXTURE, 'breadth').map(r => r[0]), ['S1', 'S2']);      // 66.7% before 50%
  assert.deepEqual(render(FIXTURE, 'stocks').map(r => r[0]), ['S1', 'S2']);       // 3 before 2
  // turnover: S1 = 180, S2 = 80; flip the fixture so the order differs from the stock-count order
  const flipped = FIXTURE.map(s => (s.sector === 'S2' ? { ...s, turnover: s.turnover * 10 } : s));
  assert.deepEqual(render(flipped, 'turnover').map(r => r[0]), ['S2', 'S1']);     // 800 before 180
});

test('a stock with no sector is grouped under "Unknown"', () => {
  const rows = render([{ symbol: 'X', changePct: 1, aboveSMA: true, turnover: 1 }]);
  assert.equal(rows[0][0], 'Unknown');
});

test('every stock lands in exactly one sector', () => {
  const total = render(FIXTURE).reduce((n, r) => n + Number(r[1]), 0);
  assert.equal(total, FIXTURE.length);
});

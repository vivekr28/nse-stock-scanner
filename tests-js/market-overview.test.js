'use strict';
// js/market-overview.js's moParseCsv(): parses NSE_Indices_Combined.csv (written by
// Download-NSE-Bhavcopy.ps1) into { indexName: [bars] } for the Market Overview chart.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/market-overview.js']);
// Objects built inside the vm sandbox have that realm's Object.prototype, which strict deepEqual rejects,
// so results are copied into this realm first.
const moParseCsv = (text) => JSON.parse(JSON.stringify(sb.moParseCsv(text)));

const HEADER = '"INDEX_NAME","DATE1","OPEN","HIGH","LOW","CLOSE","CHANGE_PCT","VOLUME","TURNOVER_CR","PE","PB","DIV_YIELD"';
const row = (name, date, o, h, l, c) => `"${name}","${date}","${o}","${h}","${l}","${c}","0.5","","","","",""`;

test('parses OHLC rows grouped by index name, in file order', () => {
  const csv = [HEADER,
    row('Nifty 50', '01-Oct-2026', '100', '110', '95', '105'),
    row('Nifty Bank', '01-Oct-2026', '200', '210', '190', '205'),
    row('Nifty 50', '02-Oct-2026', '105', '112', '101', '111'),
  ].join('\n');
  const out = moParseCsv(csv);
  assert.deepEqual(Object.keys(out), ['Nifty 50', 'Nifty Bank']);
  assert.equal(out['Nifty 50'].length, 2);
  assert.deepEqual(out['Nifty 50'][0], { date: '01-Oct-2026', open: 100, high: 110, low: 95, close: 105 });
  assert.equal(out['Nifty 50'][1].close, 111);
});

test('a leading UTF-8 BOM (PowerShell writes one) does not break the header or first row', () => {
  const csv = '﻿' + [HEADER, row('Nifty 50', '01-Oct-2026', '1', '2', '0.5', '1.5')].join('\r\n');
  const out = moParseCsv(csv);
  assert.equal(out['Nifty 50'].length, 1);
  assert.equal(out['Nifty 50'][0].close, 1.5);
});

test('days with no open/high/low (close-only indexes) become a flat bar at the close', () => {
  const csv = [HEADER, row('Nifty Some Index', '01-Oct-2024', '', '', '', '54704.61')].join('\n');
  const bar = moParseCsv(csv)['Nifty Some Index'][0];
  assert.deepEqual(bar, { date: '01-Oct-2024', open: 54704.61, high: 54704.61, low: 54704.61, close: 54704.61 });
});

test('rows without a usable close are skipped', () => {
  const csv = [HEADER,
    row('Nifty 50', '01-Oct-2026', '1', '2', '0.5', ''),
    row('Nifty 50', '02-Oct-2026', '1', '2', '0.5', '-'),
    row('Nifty 50', '03-Oct-2026', '1', '2', '0.5', '1.5'),
  ].join('\n');
  const out = moParseCsv(csv);
  assert.equal(out['Nifty 50'].length, 1);
  assert.equal(out['Nifty 50'][0].date, '03-Oct-2026');
});

test('blank lines and a header-only file are handled', () => {
  assert.deepEqual(moParseCsv(HEADER + '\n'), {});
  assert.deepEqual(moParseCsv(''), {});
  const out = moParseCsv([HEADER, '', row('Nifty 50', '01-Oct-2026', '1', '2', '0.5', '1.5'), ''].join('\n'));
  assert.equal(out['Nifty 50'].length, 1);
});

// ── Industries as equal-weight indices in the same dropdown ──
const sbInd = loadScripts(['js/ew-index.js', 'js/market-overview.js', 'js/industry-charts.js']);
const stock = (isin, industry) => ({ isin, industry });
const day = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c, turnover: 10 });

test('industry list skips the catch-all bucket and one-stock industries', () => {
  sbInd.Store.latestBySymbol = {
    A: stock('A', 'Steel'), B: stock('B', 'Steel'), C: stock('C', 'Solo'),
    D: stock('D', 'Undefined-Diversified'), E: stock('E', 'Undefined-Diversified'), F: stock('F', undefined),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(sbInd.moIndustryCounts())), { Steel: 2 });
});

test('industry bars are the equal-weight index of its stocks and are cached per data load', () => {
  const S = sbInd.Store;
  S.latestBySymbol = { A: stock('A', 'Steel'), B: stock('B', 'Steel'), C: stock('C', 'Other') };
  S.dates = ['01-Oct-2026', '02-Oct-2026'];
  S.dailyBySymbol = {
    A: [day('01-Oct-2026', 100, 100, 100, 100), day('02-Oct-2026', 110, 110, 110, 110)], // +10%
    B: [day('01-Oct-2026', 100, 100, 100, 100), day('02-Oct-2026', 90, 90, 90, 90)],     // -10%
    C: [day('01-Oct-2026', 50, 50, 50, 50), day('02-Oct-2026', 500, 500, 500, 500)],      // not in Steel
  };
  const r = sbInd.moIndustryBars('Steel');
  assert.equal(r.count, 2);
  assert.equal(r.bars.length, 1);
  assert.ok(Math.abs(r.bars[0].close - 100) < 1e-9); // +10% and -10% average to flat
  assert.equal(r.lastDate, '02-Oct-2026');
  assert.equal(sbInd.moIndustryBars('Steel'), r);    // same data -> cached object
  S.dates = ['01-Oct-2026'];
  assert.notEqual(sbInd.moIndustryBars('Steel'), r); // data reloaded -> recomputed
});

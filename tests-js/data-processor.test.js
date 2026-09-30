'use strict';
// Tests for js/data-processor.js's processData()/processBandData() - the client-side CSV
// parsing pipeline (the browser-side counterpart to src/nse_server.py's process_data(),
// which already has extensive fixture coverage in tests/test_process_data.py). This file
// had zero coverage before - see AGENT.md's "Completed: Test Suite" phase list.
//
// processData() ends by calling populateFilters()/showDashboard() (js/ui.js, DOM-heavy and
// not loaded here), so those two are stubbed as no-ops directly on the sandbox rather than
// loading ui.js - see load.js's own comment on why document.getElementById needs a fake
// element (industry-charts.js's toggles), which ui.js would pile more of the same onto for
// no benefit here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/utils.js', 'js/data-processor.js']);
const { processData, processBandData, Store } = sb;
sb.populateFilters = () => {};
sb.showDashboard = () => {};

function resetStore() {
  Store.bhavData = [];
  Store.bandData = [];
  Store.sectorMap = {};
  Store.dates = [];
  Store.latestDate = null;
  Store.dailyBySymbol = {};
  Store.latestBySymbol = {};
  Store.bandBySymbol = {};
  Store.symbolToISIN = {};
  Store.staleStocks = [];
  Store.excludedEtfs = [];
  Store.loaded = { bhav: true, band: false, sector: true };
}

// Old-format column names (findCol's first candidate for each), matching the pre-CM-UDiFF
// shape - simplest to construct by hand and still exercises the real column-resolution path.
function bhavRow({ symbol, series = 'EQ', date, open, high, low, close, last, prev, vol = 1000,
                    turnover = 100, trades = 10, isin, companyName = '' }) {
  return {
    SYMBOL: symbol, SERIES: series, DATE1: date,
    OPEN_PRICE: open, HIGH_PRICE: high, LOW_PRICE: low, CLOSE_PRICE: close,
    LAST_PRICE: last ?? close, PREV_CLOSE: prev,
    TTL_TRD_QNTY: vol, TURNOVER_LACS: turnover, NO_OF_TRADES: trades,
    ISIN: isin || symbol, COMPANY_NAME: companyName,
  };
}

function bandRow({ symbol, series = 'EQ', upper, lower, bandPct, date }) {
  return { Symbol: symbol, Series: series, Upper_Band: upper, Lower_Band: lower, 'Price Band': bandPct, Date: date };
}

// ─── processData: grouping / filtering ──────────────────────────────────────────

test('processData: groups by ISIN, keeps only EQ/BE series, drops rows with no/zero close', () => {
  resetStore();
  Store.bhavData = [
    bhavRow({ symbol: 'AAA', series: 'EQ', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INAAA' }),
    bhavRow({ symbol: 'BBB', series: 'ST', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INBBB' }), // non EQ/BE -> dropped
    bhavRow({ symbol: 'CCC', series: 'EQ', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 0, prev: 10, isin: 'INCCC' }),  // close<=0 -> dropped
    bhavRow({ symbol: 'DDD', series: 'BE', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INDDD' }),
  ];
  processData();

  assert.deepEqual(Object.keys(Store.dailyBySymbol).sort(), ['INAAA', 'INDDD']);
  assert.equal(Store.dailyBySymbol.INAAA.length, 1);
  // symbolToISIN is keyed by normalizeSymbol() (lowercased) - js/utils.js
  assert.equal(Store.symbolToISIN.aaa, 'INAAA');
  assert.equal(Store.symbolToISIN.bbb, undefined); // dropped row never reaches the map
});

test('processData: computed indicators, hand-derived over a 25-day single-stock fixture', () => {
  resetStore();
  const isin = 'INTEST01';
  const days = Array.from({ length: 25 }, (_, i) => {
    const close = 100 + i; // 100,101,...,124 - strictly increasing
    return bhavRow({
      symbol: 'TEST', date: `${i + 1}-Jan-2025`,
      open: close - 1, high: close + 2, low: close - 3, close,
      prev: i === 0 ? close : 100 + i - 1, isin,
    });
  });
  Store.bhavData = days;
  processData();

  assert.equal(Store.dates.length, 25);
  assert.equal(Store.latestDate, '25-Jan-2025');
  const latest = Store.latestBySymbol[isin];
  assert.ok(latest, 'latest-day stock should be present');

  // sma20 = average of the last 20 closes (105..124)
  const expectedSma20 = Array.from({ length: 20 }, (_, i) => 105 + i).reduce((s, v) => s + v, 0) / 20;
  assert.ok(Math.abs(latest.sma20 - expectedSma20) < 1e-9);
  assert.equal(latest.aboveSMA, latest.close > latest.sma20); // close=124 > sma20 (114.5) -> true
  assert.equal(latest.aboveSMA, true);

  // 52W high/low over all 25 days: high = close+2 (max at last day) = 126, low = close-3 (min at first day) = 97
  assert.equal(latest.high52w, 126);
  assert.equal(latest.low52w, 97);

  // changePct: close=124 vs prev=123 -> (124-123)/123*100
  assert.ok(Math.abs(latest.changePct - (1 / 123 * 100)) < 1e-9);

  // distFrom52H = (126-124)/126*100, distFrom52L = (124-97)/97*100
  assert.ok(Math.abs(latest.distFrom52H - ((126 - 124) / 126 * 100)) < 1e-9);
  assert.ok(Math.abs(latest.distFrom52L - ((124 - 97) / 97 * 100)) < 1e-9);

  // monthlyChangePct: 25 days >= 22, so reference = days[25-22] = index 3 (0-based) -> close=103
  assert.ok(Math.abs(latest.monthlyChangePct - ((124 - 103) / 103 * 100)) < 1e-9);
});

test('processData: fewer than 20 days -> sma20/distFromSMA are NaN and aboveSMA is false', () => {
  resetStore();
  const isin = 'INSHORT';
  Store.bhavData = Array.from({ length: 5 }, (_, i) => bhavRow({
    symbol: 'SHORT', date: `${i + 1}-Jan-2025`,
    open: 10, high: 11, low: 9, close: 10 + i, prev: 10 + Math.max(i - 1, 0), isin,
  }));
  processData();

  const latest = Store.latestBySymbol[isin];
  assert.ok(Number.isNaN(latest.sma20));
  assert.ok(Number.isNaN(latest.distFromSMA));
  assert.equal(latest.aboveSMA, false); // !isNaN(sma20) is false, so this stays false regardless of price
});

test('processData: fewer than 22 days -> monthlyChangePct falls back to change since the first day', () => {
  resetStore();
  const isin = 'INSHORT2';
  Store.bhavData = Array.from({ length: 10 }, (_, i) => bhavRow({
    symbol: 'SHORT2', date: `${i + 1}-Jan-2025`,
    open: 10, high: 11, low: 9, close: 100 + i * 2, prev: 100 + Math.max(i - 1, 0) * 2, isin,
  }));
  processData();

  const latest = Store.latestBySymbol[isin];
  // first day close=100, latest (10th day) close=118 -> (118-100)/100*100 = 18%
  assert.equal(latest.monthlyChangePct, 18);
});

test('processData: a stock whose last trade predates the global latest date is "stale" - tracked and excluded', () => {
  resetStore();
  Store.bhavData = [
    bhavRow({ symbol: 'FRESH', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INEFRESH' }),
    bhavRow({ symbol: 'FRESH', date: '2-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INEFRESH' }),
    bhavRow({ symbol: 'STALE', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INSTALE' }),
    // STALE has no row on 2-Jan-2025, so its last trade date (1-Jan) != Store.latestDate (2-Jan)
  ];
  processData();

  assert.equal(Store.latestDate, '2-Jan-2025');
  assert.ok(Store.latestBySymbol.INEFRESH);
  assert.equal(Store.latestBySymbol.INSTALE, undefined);
  assert.equal(Store.staleStocks.length, 1);
  assert.equal(Store.staleStocks[0].symbol, 'STALE');
  assert.equal(Store.staleStocks[0].lastTradeDate, '1-Jan-2025');
});

test('processData: sector/industry/marketCap come from Store.sectorMap by normalized symbol, falling back to Undefined-Diversified', () => {
  resetStore();
  Store.sectorMap = {
    known: { sector: 'IT', industry: 'Software Services', marketCap: 500 },
    dashsym: { sector: '-', industry: '-', marketCap: 0 }, // explicit '-' placeholders -> still falls back
  };
  Store.bhavData = [
    bhavRow({ symbol: 'Known', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INKNOWN' }),
    bhavRow({ symbol: 'Unmapped', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INUNMAPPED' }),
    bhavRow({ symbol: 'Dash-Sym', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INDASH' }),
  ];
  processData();

  assert.equal(Store.latestBySymbol.INKNOWN.sector, 'IT');
  assert.equal(Store.latestBySymbol.INKNOWN.industry, 'Software Services');
  assert.equal(Store.latestBySymbol.INKNOWN.marketCap, 500);

  assert.equal(Store.latestBySymbol.INUNMAPPED.sector, 'Undefined-Diversified');
  assert.equal(Store.latestBySymbol.INUNMAPPED.industry, 'Undefined-Diversified');
  assert.equal(Store.latestBySymbol.INUNMAPPED.marketCap, 0);

  assert.equal(Store.latestBySymbol.INDASH.sector, 'Undefined-Diversified'); // '-' placeholder also falls back
});

// ─── processBandData ─────────────────────────────────────────────────────────────

test('processBandData: only the latest band date is applied (non-ISO dd-Mon-yyyy dates, correctly parsed not string-sorted)', () => {
  resetStore();
  Store.loaded.band = true;
  Store.bhavData = [
    bhavRow({ symbol: 'AAA', date: '1-Jan-2025', open: 100, high: 110, low: 95, close: 105, prev: 100, isin: 'INAAA' }),
  ];
  // "31-Dec-2024" sorts AFTER "1-Jan-2025" lexicographically (string compare: '3'>'1'), which
  // is exactly the case that broke the old plain Array.sort() on raw date strings - this
  // fixture would have picked the wrong (older) row under that bug.
  Store.bandData = [
    bandRow({ symbol: 'AAA', upper: 90, lower: 80, bandPct: '10', date: '31-Dec-2024' }),     // older - ignored
    bandRow({ symbol: 'AAA', upper: 115.5, lower: 94.5, bandPct: '10', date: '1-Jan-2025' }), // latest - applied
  ];
  processData();

  const latest = Store.latestBySymbol.INAAA;
  assert.equal(latest.upperBand, 115.5);
  assert.equal(latest.lowerBand, 94.5);
  // high=110 vs upper*0.999=115.38... -> not a UC hit
  assert.equal(latest.hitUC, false);
  // low=95 vs lower*1.001=94.5945 -> 95 > 94.5945, not a LC hit either
  assert.equal(latest.hitLC, false);
});

test('processBandData: a stale row appearing AFTER a newer one in the array does not overwrite it (per-symbol, out-of-order rows)', () => {
  // Reproduces the real bug found live: NSE_PriceBand_Combined.csv's rows aren't guaranteed
  // to be in chronological order for every symbol (a bulk restore/recovery of NSE_DATA can
  // merge per-day files out of order - see Download-NSE-Bhavcopy.ps1's price-band merge
  // comment). Two symbols, each with their genuinely-latest row placed BEFORE an older,
  // stale row for the same symbol later in the array - the old "last row wins" behavior
  // would have picked the stale one for both.
  resetStore();
  Store.loaded.band = true;
  Store.bhavData = [
    bhavRow({ symbol: 'AAA', date: '25-Sep-2026', open: 100, high: 105, low: 95, close: 100, prev: 100, isin: 'INAAA' }),
    bhavRow({ symbol: 'BBB', date: '25-Sep-2026', open: 50, high: 52, low: 48, close: 50, prev: 50, isin: 'INBBB' }),
  ];
  Store.bandData = [
    bandRow({ symbol: 'AAA', upper: 105, lower: 95, bandPct: '5', date: '25-Sep-2026' }),   // AAA's real latest
    bandRow({ symbol: 'BBB', upper: 60, lower: 40, bandPct: '20', date: '25-Sep-2026' }),   // BBB's real latest
    bandRow({ symbol: 'AAA', upper: 120, lower: 80, bandPct: '20', date: '1-Sep-2026' }),   // stale AAA, appears later
    bandRow({ symbol: 'BBB', upper: 55, lower: 45, bandPct: '10', date: '1-Sep-2026' }),    // stale BBB, appears later
  ];
  processData();

  assert.equal(Store.latestBySymbol.INAAA.bandPct, '5');
  assert.equal(Store.latestBySymbol.INAAA.upperBand, 105);
  assert.equal(Store.latestBySymbol.INBBB.bandPct, '20');
  assert.equal(Store.latestBySymbol.INBBB.upperBand, 60);
});

test('processBandData: hitUC/hitLC trip at the 0.1% tolerance boundary', () => {
  resetStore();
  Store.loaded.band = true;
  Store.bhavData = [
    bhavRow({ symbol: 'AAA', date: '1-Jan-2025', open: 100, high: 100, low: 100, close: 100, prev: 100, isin: 'INAAA' }),
  ];
  // upper=100 -> UC threshold = 99.9; high=100 >= 99.9 -> hit. lower=100 -> LC threshold = 100.1; low=100 <= 100.1 -> hit.
  Store.bandData = [bandRow({ symbol: 'AAA', upper: 100, lower: 100, bandPct: '0', date: '1-Jan-2025' })];
  processData();

  const latest = Store.latestBySymbol.INAAA;
  assert.equal(latest.hitUC, true);
  assert.equal(latest.hitLC, true);
});

test('processBandData: band rows for a symbol not present in the bhavcopy are skipped, not crashed on', () => {
  resetStore();
  Store.loaded.band = true;
  Store.bhavData = [
    bhavRow({ symbol: 'AAA', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INAAA' }),
  ];
  Store.bandData = [
    bandRow({ symbol: 'GHOST', upper: 20, lower: 18, bandPct: '10', date: '1-Jan-2025' }), // not in bhavcopy
    bandRow({ symbol: 'AAA', upper: 11, lower: 9, bandPct: '10', date: '1-Jan-2025' }),
  ];
  processData(); // must not throw

  assert.equal(Store.bandBySymbol.GHOST, undefined);
  assert.equal(Store.latestBySymbol.INAAA.upperBand, 11);
});

test('processBandData: bandPct is stored as the raw trimmed cell text, with no "%" appended', () => {
  // Documents a known, currently-live divergence from the server-side equivalent
  // (src/nse_server.py unconditionally appends '%' - see AGENT.md's "bandPct display bug"
  // note). This test pins the CLIENT side's actual current behavior so a future edit to
  // either side has to touch this test deliberately instead of silently drifting further.
  resetStore();
  Store.loaded.band = true;
  Store.bhavData = [
    bhavRow({ symbol: 'AAA', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INAAA' }),
    bhavRow({ symbol: 'BBB', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INBBB' }),
  ];
  Store.bandData = [
    bandRow({ symbol: 'AAA', upper: 11, lower: 9, bandPct: '20', date: '1-Jan-2025' }),
    bandRow({ symbol: 'BBB', upper: 11, lower: 9, bandPct: 'No Band', date: '1-Jan-2025' }),
  ];
  processData();

  assert.equal(Store.latestBySymbol.INAAA.bandPct, '20');       // not '20%'
  assert.equal(Store.latestBySymbol.INBBB.bandPct, 'No Band');  // not 'No Band%'
});

// ─── ETF / fund filtering (ISIN starting INF is not a stock) ────────────────────────────────

test('isFundIsin: INF (mutual fund / ETF) vs INE (company share)', () => {
  assert.equal(sb.isFundIsin('INF204K01XI3'), true);
  assert.equal(sb.isFundIsin('inf204k01xi3'), true);
  assert.equal(sb.isFundIsin('INE002A01018'), false);
  assert.equal(sb.isFundIsin(''), false);
  assert.equal(sb.isFundIsin(undefined), false);
});

test('processData: ETF rows (INF ISIN) are left out of the stock data and listed in Store.excludedEtfs', () => {
  resetStore();
  Store.bhavData = [
    bhavRow({ symbol: 'STOCKCO', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INE1STK01011' }),
    bhavRow({ symbol: 'GOLDETF', date: '1-Jan-2025', open: 50, high: 51, low: 49, close: 50, prev: 50, isin: 'INF1ETF01011',
             companyName: 'Some Gold ETF', turnover: 7 }),
    bhavRow({ symbol: 'GOLDETF', date: '2-Jan-2025', open: 52, high: 53, low: 51, close: 52, prev: 50, isin: 'INF1ETF01011',
             companyName: 'Some Gold ETF', turnover: 9 }),
    bhavRow({ symbol: 'STOCKCO', date: '2-Jan-2025', open: 10, high: 12, low: 9, close: 11, prev: 10, isin: 'INE1STK01011' }),
  ];
  processData();

  // JSON round-trip: Store lives in the vm sandbox (another realm), so strict deepEqual would reject its arrays/objects
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(Object.keys(Store.latestBySymbol), ['INE1STK01011']);
  assert.deepEqual(Object.keys(Store.dailyBySymbol), ['INE1STK01011']);
  assert.equal(Store.symbolToISIN[sb.normalizeSymbol('GOLDETF')], undefined);
  assert.deepEqual(plain(Store.excludedEtfs), [{
    symbol: 'GOLDETF', name: 'Some Gold ETF', isin: 'INF1ETF01011', series: 'EQ',
    lastTradeDate: '2-Jan-2025', close: 52, turnover: 9,      // the newest of its two rows; no internal sort key leaked
  }]);
});

test('processData: a fund that trades after every stock does not move the latest date or make stocks stale', () => {
  resetStore();
  Store.bhavData = [
    bhavRow({ symbol: 'STOCKCO', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INE1STK01011' }),
    bhavRow({ symbol: 'NIFTYETF', date: '3-Jan-2025', open: 20, high: 21, low: 19, close: 20, prev: 20, isin: 'INF2ETF01011' }),
  ];
  processData();

  assert.equal(Store.latestDate, '1-Jan-2025');
  assert.equal(Store.staleStocks.length, 0);
  assert.ok(Store.latestBySymbol.INE1STK01011);
  assert.equal(Store.excludedEtfs[0].lastTradeDate, '3-Jan-2025');
});

test('processData: no ETFs gives an empty Store.excludedEtfs', () => {
  resetStore();
  Store.bhavData = [
    bhavRow({ symbol: 'STOCKCO', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INE1STK01011' }),
  ];
  processData();
  assert.equal(Store.excludedEtfs.length, 0);
});

test('processBandData: a price-band row for an ETF is ignored', () => {
  resetStore();
  Store.loaded.band = true;
  Store.bhavData = [
    bhavRow({ symbol: 'STOCKCO', date: '1-Jan-2025', open: 10, high: 11, low: 9, close: 10, prev: 10, isin: 'INE1STK01011' }),
    bhavRow({ symbol: 'GOLDETF', date: '1-Jan-2025', open: 50, high: 51, low: 49, close: 50, prev: 50, isin: 'INF1ETF01011' }),
  ];
  Store.bandData = [
    bandRow({ symbol: 'STOCKCO', upper: 11, lower: 9, bandPct: '20', date: '1-Jan-2025' }),
    bandRow({ symbol: 'GOLDETF', upper: 60, lower: 40, bandPct: '20', date: '1-Jan-2025' }),
  ];
  processData();

  assert.deepEqual(Object.keys(Store.bandBySymbol), ['INE1STK01011']);
});

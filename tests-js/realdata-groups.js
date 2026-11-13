'use strict';
// Helper for tests/test_processing_realdata_smoke.py (not a test itself): feeds the REAL processed data
// (NSE_DATA/processed_data.json) to the dashboard's own Money Flow code (js/money-flow.js: the industry grouping and the money-flow
// engine behind the Money Flow tab and the Stock Scanner's F12 / F17 filters) and prints what the tab would show, as JSON, so Python
// can recompute the same numbers independently from the daily prices and compare.
//
//   node tests-js/realdata-groups.js <path to processed_data.json>
const fs = require('fs');
const vm = require('vm');
const { loadScripts } = require('./load');

const processed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sb = loadScripts(['js/utils.js', 'js/money-flow.js']);

// the stored daily rows are columnar ([date, open, ..., turnover, ...] + dailyCols); the dashboard works on row objects
const cols = processed.dailyCols;
const iDate = cols.indexOf('date'), iTurn = cols.indexOf('turnover');
const daily = {};
for (const key in processed.dailyBySymbol) daily[key] = processed.dailyBySymbol[key].map(r => ({ date: r[iDate], turnover: r[iTurn] }));

sb.Store.latestBySymbol = processed.latestBySymbol;
sb.Store.dailyBySymbol = daily;
sb.Store.dates = processed.dates;

const out = { industries: {}, moneyFlow: {} };
try {
  const days = vm.runInContext('MF_PERIOD_DAYS', sb);
  // every industry (Min Stocks 1, no market-cap floor): how many stocks, their market cap and sector
  const now0 = sb.computeIndustryMoneyFlow('6m');
  for (const r of sb.mfBuildIndustries(1, 0, now0, now0)) out.industries[r.name] = { sector: r.sector, stockCount: r.stockCount, totalMcap: r.totalMcap };
  // the money flow itself, for three (window, lag) pairs the tab / filters offer
  for (const [period, lag] of [['6m', '1m'], ['1m', '1w'], ['3m', '3m']]) {
    const now = sb.computeIndustryMoneyFlow(period), past = sb.computeIndustryMoneyFlow(period, days[lag]);
    const rows = {};
    for (const r of sb.mfBuildIndustries(1, 0, now, past)) {
      rows[r.name] = { cur: r.moneyFlow, prev: r.moneyFlowPrev, chg: r.moneyFlowChg, pastChg: r.moneyFlowChgPast, roc: r.moneyFlowRoc };
    }
    out.moneyFlow[`${period}_${lag}`] = { periodDays: days[period], lagDays: days[lag], rows };
  }
} catch (e) {
  out.industries = { error: String(e && e.stack || e) };
}

process.stdout.write(JSON.stringify(out));

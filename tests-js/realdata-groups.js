'use strict';
// Helper for tests/test_processing_realdata_smoke.py (not a test itself): feeds the REAL processed data
// (NSE_DATA/processed_data.json) to the dashboard's own sector and industry aggregation code (js/sector.js,
// js/industry.js) and prints what those tabs would show, as JSON, so Python can recompute the same numbers
// independently and compare.
//
//   node tests-js/realdata-groups.js <path to processed_data.json>
const fs = require('fs');
const vm = require('vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const processed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/sector.js']);
const dom = installFakeDom(sb, {
  sectorSort: 'avg_change', industrySort: 'rs_score', indMinStocks: '1', indMinMcap: '0',
  moneyFlowPeriod: '1m', mfRocPeriod: '1m', mfRocLag: '1m',
});
// charts / big tables are drawn to canvases and are not what is being checked
sb.renderMetricChart = () => {};
sb.renderIndustryBreakdownTable = () => {};
sb.renderMoneyFlowAllPeriodsTable = () => {};

sb.Store.latestBySymbol = processed.latestBySymbol;
sb.Store.dailyBySymbol = {};      // money flow (needs price history) is not part of the grouping being checked
sb.Store.dates = processed.dates;

sb.renderSectorAnalysis();
const rows = [...dom.el('sectorBody').innerHTML.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m =>
  [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()));
const sectors = {};
for (const r of rows) sectors[r[0]] = { stocks: Number(r[1]), avgChange: r[2], breadth: r[3] };

let industries = {};
try {
  sb.renderIndustryAnalysis();
  for (const i of vm.runInContext('_chartData', sb)) {
    industries[i.name] = {
      sector: i.sector, stockCount: i.stockCount, avgMonthlyChange: i.avgMonthlyChange, breadth: i.breadth,
      above: i.above, below: i.below, totalMcap: i.totalMcap, totalTurnover: i.totalTurnover, avgDist52H: i.avgDist52H,
    };
  }
} catch (e) {
  industries = { error: String(e && e.stack || e) };
}

process.stdout.write(JSON.stringify({ sectors, industries }));

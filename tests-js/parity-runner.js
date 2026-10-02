'use strict';
// Helper for tests/test_indicator_parity.py (not a test itself): runs the SAME bhavcopy rows through the dashboard's
// browser-side processing (js/data-processor.js processData) and prints the resulting indicators as JSON, so the Python
// test can compare them with the server's process_data() output.
//
//   node tests-js/parity-runner.js <rows.json>      rows.json = array of bhavcopy row objects (the CSV columns)
const fs = require('fs');
const { loadScripts } = require('./load');

const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sb = loadScripts(['js/utils.js', 'js/data-processor.js']);
sb.populateFilters = () => {};
sb.showDashboard = () => {};

const S = sb.Store;
Object.assign(S, {
  bhavData: rows, bandData: [], sectorMap: {}, dates: [], latestDate: null, dailyBySymbol: {}, latestBySymbol: {},
  bandBySymbol: {}, symbolToISIN: {}, staleStocks: [], excludedEtfs: [], loaded: { bhav: true, band: false, sector: true },
});
sb.processData();

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);   // NaN -> null
const FIELDS = ['sma20', 'high52w', 'low52w', 'adr', 'changePct', 'monthlyChangePct', 'distFrom52H', 'distFrom52L', 'distFromSMA'];
const stocks = {};
for (const k in S.latestBySymbol) {
  const s = S.latestBySymbol[k];
  stocks[s.symbol] = { close: s.close, aboveSMA: s.aboveSMA, tradingDays: s.tradingDays, sector: s.sector, industry: s.industry };
  for (const f of FIELDS) stocks[s.symbol][f] = num(s[f]);
}
process.stdout.write(JSON.stringify({
  stocks, dates: S.dates, latestDate: S.latestDate, stale: S.staleStocks.map(s => s.symbol).sort(),
}));

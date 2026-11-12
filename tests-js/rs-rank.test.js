'use strict';
// Top-level "Relative Strength" tab (js/rs-rank.js): RS ranks 99..1 by 1M / 3M / 6M / 1Y performance, and the sector / industry roll-ups.
// Covers the ranking (extremes, ties, blanks, single value), the per-stock rows (perf == the Performance filter's number, unranked when
// history is short), group ratings, the stock filters, CSV, and that the tab is wired into index.html / ui.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');

const root = path.dirname(__dirname);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/screener.js', 'js/rs-rank.js']);
// top-level const bindings are not properties of the sandbox object, so read them through the context
const RSR_PERIODS = vm.runInContext('RSR_PERIODS', sb), PERF_PERIOD_DAYS = vm.runInContext('PERF_PERIOD_DAYS', sb);

// A stock whose close goes from `start` to `end` over `n` bars (flat then a final move is enough: only first / last / lookback bars matter).
function bars(n, refClose, lastClose) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ date: 'd' + i, open: 1, high: 1, low: 1, close: i === n - 1 ? lastClose : refClose });
  return out;
}

// ── ranking ───────────────────────────────────────────────────────────────────

test('highest value gets 99, lowest gets 1, order is preserved', () => {
  const r = sb.rsrRankValues([5, -3, 40, 12, 0]);
  assert.equal(r[2], 99);
  assert.equal(r[1], 1);
  assert.deepEqual([...r].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]), [1, 4, 0, 3, 2]);
});

test('ranks span 1..99 evenly over many values and never repeat out of order', () => {
  const vals = Array.from({ length: 1000 }, (_, i) => i * 0.37 - 100);
  const r = sb.rsrRankValues(vals);
  assert.equal(Math.min(...r), 1);
  assert.equal(Math.max(...r), 99);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] >= r[i - 1]);
});

test('equal values share one rank; blanks (NaN / Infinity) stay NaN and are left out', () => {
  const r = sb.rsrRankValues([10, 10, 10, NaN, 20, Infinity, 0]);
  assert.equal(r[0], r[1]);
  assert.equal(r[1], r[2]);
  assert.ok(Number.isNaN(r[3]));
  assert.ok(Number.isNaN(r[5]));
  assert.equal(r[4], 99);
  assert.equal(r[6], 1);
});

test('a single ranked value gets 50, none gives all NaN', () => {
  assert.deepEqual([...sb.rsrRankValues([7, NaN])].map(v => (Number.isNaN(v) ? 'n' : v)), [50, 'n']);
  assert.ok(sb.rsrRankValues([NaN, NaN]).every(Number.isNaN));
  assert.equal(sb.rsrRankValues([]).length, 0);
});

// ── per-stock rows ────────────────────────────────────────────────────────────

function universe() {
  // 300 bars each: 1M ref is 21 bars back, 3M 63, 6M 126, 1Y 250. Constant ref close, so every period sees the same %.
  const stocks = {}, daily = {};
  const defs = [
    { isin: 'A', symbol: 'AAA', sector: 'Tech', industry: 'Software', last: 150, n: 300 },
    { isin: 'B', symbol: 'BBB', sector: 'Tech', industry: 'Software', last: 120, n: 300 },
    { isin: 'C', symbol: 'CCC', sector: 'Tech', industry: 'Hardware', last: 100, n: 300 },
    { isin: 'D', symbol: 'DDD', sector: 'Bank', industry: 'Private', last: 80, n: 300 },
    { isin: 'E', symbol: 'EEE', sector: 'Bank', industry: 'Private', last: 60, n: 300 },
    { isin: 'F', symbol: 'FFF', sector: 'Bank', industry: 'Public', last: 40, n: 300 },
    { isin: 'N', symbol: 'NEW', sector: 'Bank', industry: 'Public', last: 500, n: 30 },   // 30 bars: has 1M history only
  ];
  for (const d of defs) {
    stocks[d.isin] = { symbol: d.symbol, companyName: d.symbol + ' Ltd', sector: d.sector, industry: d.industry, close: d.last, turnover: 1000, marketCap: 5000 };
    daily[d.isin] = bars(d.n, 100, d.last);
  }
  return { stocks, daily };
}

test('perf is the Performance filter number and is ranked 99..1 for every period', () => {
  const { stocks, daily } = universe();
  const rows = sb.rsrBuildRows(stocks, daily);
  const a = rows.find(r => r.isin === 'A');
  for (const p of RSR_PERIODS) assert.equal(a.perf[p.key], sb.computeDynPerformance(daily.A, PERF_PERIOD_DAYS[p.key]));
  assert.equal(a.perf['3m'], 50);
  assert.equal(a.rs['3m'], 99);                                           // best of the six
  assert.equal(rows.find(r => r.isin === 'F').rs['3m'], 1);                // worst
});

test('a stock without a full lookback is unranked for that period only', () => {
  const rows = sb.rsrBuildRows(universe().stocks, universe().daily);
  const n = rows.find(r => r.isin === 'N');
  assert.ok(Number.isFinite(n.rs['1m']));                                 // 30 bars >= 22 needed for 1M
  assert.ok(Number.isNaN(n.rs['3m']));                                    // needs 64
  assert.ok(Number.isNaN(n.rs['1y']));
  assert.equal(n.rs['1m'], 99);                                           // its +400% is the best 1M move
  // and it takes no part in the others' ranking: A (best of the 6 ranked) is still 99 in 3M
  assert.equal(rows.find(r => r.isin === 'A').rs['3m'], 99);
});

// ── sector / industry summary of the passing stocks ──────────────────────────

test('summary counts the PASSING stocks per group, out of the ranked stocks in each group, with avg RS / perf and the top stock', () => {
  const rows = sb.rsrBuildRows(universe().stocks, universe().daily);
  const f = { period: '3m', sector: 'ALL', industry: 'ALL' };
  const passing = sb.rsrFilterStocks(rows, { ...f, minRs: 70 });             // AAA 99, BBB 80 (CCC is 60)
  const inds = sb.rsrSummarize(rows, passing, 'industry', '3m');
  assert.equal(inds.length, 1);                                              // only Software has passing stocks
  const sw = inds[0];
  assert.equal(sw.name, 'Software');
  assert.equal(sw.sector, 'Tech');
  assert.equal(sw.passing, 2);
  assert.equal(sw.ranked, 2);
  assert.equal(sw.pct, 100);
  assert.equal(sw.top.symbol, 'AAA');
  assert.ok(Math.abs(sw.avgPerf - 35) < 1e-9);                               // mean of +50 and +20
  const secs = sb.rsrSummarize(rows, passing, 'sector', '3m');
  assert.equal(secs.length, 1);
  assert.equal(secs[0].name, 'Tech');
  assert.equal(secs[0].passing, 2);
  assert.equal(secs[0].ranked, 3);                                           // Tech has AAA, BBB, CCC ranked
  assert.ok(Math.abs(secs[0].pct - 200 / 3) < 1e-9);
});

test('summary with no RS limit lists every group that has a ranked stock; unranked stocks are not counted in "ranked"', () => {
  const rows = sb.rsrBuildRows(universe().stocks, universe().daily);
  const passing = sb.rsrFilterStocks(rows, { period: '3m', sector: 'ALL', industry: 'ALL' });
  const inds = sb.rsrSummarize(rows, passing, 'industry', '3m');
  assert.equal(inds.map(g => g.name).sort().join(), 'Hardware,Private,Public,Software');
  const pub = inds.find(g => g.name === 'Public');
  assert.equal(pub.passing, 1);                                              // F; NEW has no 3M rank
  assert.equal(pub.ranked, 1);
  assert.equal(pub.top.symbol, 'FFF');
});

// ── filters ───────────────────────────────────────────────────────────────────

test('stock filters: RS range, sector, industry, search, turnover; unranked never pass', () => {
  const rows = sb.rsrBuildRows(universe().stocks, universe().daily);
  const base = { period: '3m', sector: 'ALL', industry: 'ALL' };
  const syms = f => sb.rsrFilterStocks(rows, { ...base, ...f }).map(r => r.symbol).sort().join();
  assert.equal(syms({}), 'AAA,BBB,CCC,DDD,EEE,FFF');                      // NEW has no 3M rank
  assert.equal(syms({ minRs: 90 }), 'AAA');
  assert.equal(syms({ maxRs: 10 }), 'FFF');
  assert.equal(syms({ minRs: 40, maxRs: 70 }), 'CCC,DDD');
  assert.equal(syms({ sector: 'Bank' }), 'DDD,EEE,FFF');
  assert.equal(syms({ industry: 'Software' }), 'AAA,BBB');
  assert.equal(syms({ search: 'dd' }), 'DDD');
  assert.equal(syms({ search: 'ccc ltd' }), 'CCC');                       // company name too
  assert.equal(syms({ minTurnoverCr: 11 }), '');                          // turnover 1000 lakh = 10 Cr
  assert.equal(syms({ minTurnoverCr: 10 }), 'AAA,BBB,CCC,DDD,EEE,FFF');
});

// ── CSV ───────────────────────────────────────────────────────────────────────

test('CSV has the table columns, escapes quotes and leaves blanks empty', () => {
  const rows = sb.rsrBuildRows(universe().stocks, universe().daily);
  rows[0].companyName = 'x';
  const f = { period: '3m' };
  const spec = sb.rsrStockSpec(rows.filter(r => r.symbol === 'AAA'), f);
  spec.sorted = spec.rows;
  const lines = sb.rsrBuildCsv(spec).trim().split('\n');
  assert.ok(lines[0].startsWith('"RS (3M)","Symbol"'));
  assert.ok(lines[1].startsWith('99,"AAA","Tech","Software"'));
  assert.equal(sb.rsrCsvCell('a"b'), '"a""b"');
  assert.equal(sb.rsrCsvCell(NaN), '');
});

// ── wiring ────────────────────────────────────────────────────────────────────

test('the tab, its single page and the lazy render are wired in; the old sub-tabs and group-RS filters are gone', () => {
  const html = read('index.html'), ui = read('js/ui.js');
  assert.match(html, /<div class="tab" data-tab="rs">Relative Strength<\/div>/);
  assert.match(html, /<div id="panel-rs" class="panel">/);
  assert.match(html, /<script src="js\/rs-rank\.js\?v=\d+"><\/script>/);
  assert.ok(html.indexOf('<script src="js/screener.js') < html.indexOf('<script src="js/rs-rank.js'));    // it uses computeDynPerformance / PERF_PERIOD_DAYS
  for (const id of ['rsrPeriod', 'rsrMinRs', 'rsrMaxRs', 'rsrSector', 'rsrIndustry', 'rsrSummary', 'rsrSectorsWrap', 'rsrIndustriesWrap', 'rsrStocksWrap']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  // page order: sector-wise, then industry-wise, then stocks
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('rsrSectorsWrap') < at('rsrIndustriesWrap') && at('rsrIndustriesWrap') < at('rsrStocksWrap'));
  for (const gone of ['rsrTab-', 'rsrPane-', 'rsrSectorRsMin', 'rsrIndustryRsMin', 'rsrMinStocks']) assert.ok(!html.includes(gone), gone);
  assert.match(ui, /dataset\.tab === 'rs'[\s\S]{0,80}rsrRender/);
});

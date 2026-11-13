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
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/screener.js', 'js/rs-rank.js']);
// top-level const bindings are not properties of the sandbox object, so read them through the context
const RSR_PERIODS = vm.runInContext('RSR_PERIODS', sb), PERF_PERIOD_DAYS = vm.runInContext('PERF_PERIOD_DAYS', sb);

// A stock whose close goes from `start` to `end` over `n` bars (flat then a final move is enough: only first / last / lookback bars matter).
function bars(n, refClose, lastClose) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ date: 'd' + i, open: 1, high: 1, low: 1, close: i === n - 1 ? lastClose : refClose, turnover: 1000 });
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
    stocks[d.isin] = { symbol: d.symbol, companyName: d.symbol + ' Ltd', sector: d.sector, industry: d.industry, close: d.last, marketCap: { A: 9000, B: 7000, C: 5000, D: 3000, E: 1000, F: 500, N: 0 }[d.isin] };
    daily[d.isin] = bars(d.n, 100, d.last);
  }
  return { stocks, daily };
}

test('perf is the Performance filter number and is ranked 99..1 for every period', () => {
  const { stocks, daily } = universe();
  const rows = sb.rsrBuildRows(stocks, daily);
  const a = rows.find(r => r.isin === 'A');
  for (const p of RSR_PERIODS.filter(x => x.kind === 'perf')) assert.equal(a.perf[p.key], sb.computeDynPerformance(daily.A, PERF_PERIOD_DAYS[p.key]));
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
  assert.equal(syms({ minAvgTurnoverCr: 11 }), '');                       // 1000 lakh a day = 10 Cr on average
  assert.equal(syms({ minAvgTurnoverCr: 10 }), 'AAA,BBB,CCC,DDD,EEE,FFF');
  assert.equal(syms({ minMcapCr: 3000 }), 'AAA,BBB,CCC,DDD');            // market caps 9000 / 7000 / 5000 / 3000 / 1000 / 500
  assert.equal(syms({ minMcapCr: 3001 }), 'AAA,BBB,CCC');                 // at least, so 3000 passes 3000 and not 3001
  assert.equal(syms({ minMcapCr: 20000 }), '');
  assert.equal(syms({ minMcapCr: 5000, minAvgTurnoverCr: 10, minRs: 40 }), 'AAA,BBB,CCC');   // together they all apply
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
  for (const id of ['rsrPeriod', 'rsrChips', 'rsrSector', 'rsrIndustry', 'rsrSummary', 'rsrSectorsWrap', 'rsrIndustriesWrap', 'rsrStocksWrap']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  // page order: sector-wise, then industry-wise, then stocks
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('rsrSectorsWrap') < at('rsrIndustriesWrap') && at('rsrIndustriesWrap') < at('rsrStocksWrap'));
  for (const gone of ['rsrTab-', 'rsrPane-', 'rsrSectorRsMin', 'rsrIndustryRsMin', 'rsrMinStocks']) assert.ok(!html.includes(gone), gone);
  assert.match(ui, /dataset\.tab === 'rs'[\s\S]{0,80}rsrRender/);
});

// ── ranking by distance from the period high (1M High / 3M High / 6M High / 1Y High) ──────────────────────────────────

test('the period list has the four performance periods then the four High ones, with the same lookbacks', () => {
  assert.deepEqual(Array.from(RSR_PERIODS, p => p.key), ['1m', '3m', '6m', '1y', 'h1m', 'h3m', 'h6m', 'h1y']);
  assert.deepEqual(Array.from(RSR_PERIODS, p => p.label), ['1M', '3M', '6M', '1Y', '1M High', '3M High', '6M High', '1Y High']);
  assert.deepEqual(Array.from(RSR_PERIODS, p => p.days), [21, 63, 126, 250, 21, 63, 126, 250]);
  assert.deepEqual(Array.from(RSR_PERIODS, p => p.kind), ['perf', 'perf', 'perf', 'perf', 'high', 'high', 'high', 'high']);
});

const hbars = (n, fn) => Array.from({ length: n }, (_, i) => fn(i, n));   // fn -> { high, close }

test('rsrDistFromHigh: % below the highest HIGH of the last n bars; the window includes the latest bar; 0 at the high', () => {
  // a 100 high on bar 3, highs 50 elsewhere, last close 90
  const d = hbars(10, (i, n) => ({ high: i === 3 ? 100 : 50, close: i === n - 1 ? 90 : 50 }));
  assert.ok(Math.abs(sb.rsrDistFromHigh(d, 10) - -10) < 1e-9);
  assert.equal(sb.rsrDistFromHigh(d, 5), (90 / 50 - 1) * 100);               // the 100 high (bar 3) is outside the last 5 bars
  const atHigh = hbars(10, (i, n) => ({ high: 100, close: i === n - 1 ? 100 : 60 }));
  assert.equal(sb.rsrDistFromHigh(atHigh, 10), 0);
  const newHigh = hbars(10, (i, n) => ({ high: i === n - 1 ? 120 : 100, close: i === n - 1 ? 120 : 100 }));
  assert.equal(sb.rsrDistFromHigh(newHigh, 10), 0);                           // the latest bar's own high counts: a new high reads 0
});

test('rsrDistFromHigh: uses the HIGH, not the close; needs a full window; bad data is NaN', () => {
  const d = hbars(6, (i) => ({ high: i === 0 ? 200 : 100, close: 100 }));     // a 200 intraday high with a 100 close
  assert.equal(sb.rsrDistFromHigh(d, 6), -50);
  assert.ok(Number.isNaN(sb.rsrDistFromHigh(d, 7)));                          // only 6 bars
  assert.ok(Number.isNaN(sb.rsrDistFromHigh([], 5)));
  assert.ok(Number.isNaN(sb.rsrDistFromHigh(undefined, 5)));
  assert.ok(Number.isNaN(sb.rsrDistFromHigh(hbars(5, () => ({ high: 0, close: 0 })), 5)));
});

test('rsrNeedBars: a performance period needs one more bar than its length, a High period exactly its length', () => {
  assert.equal(sb.rsrNeedBars('3m'), 64);
  assert.equal(sb.rsrNeedBars('h3m'), 63);
  assert.equal(sb.rsrNeedBars('h1y'), 250);
  assert.equal(sb.rsrNeedBars('nope'), 0);
});

// 6 stocks, 300 bars, high 100 throughout and a last close of 100 / 95 / 90 / 80 / 70 / 60; plus one with only 40 bars
function highUniverse() {
  const stocks = {}, daily = {};
  [100, 95, 90, 80, 70, 60].forEach((last, i) => {
    const isin = 'H' + i;
    stocks[isin] = { symbol: 'HHH' + i, companyName: 'H' + i, sector: 'S', industry: 'I' + (i % 2), close: last, turnover: 1000, marketCap: 1 };
    daily[isin] = hbars(300, (j, n) => ({ date: 'd' + j, open: 100, high: 100, low: 50, close: j === n - 1 ? last : 100 }));
  });
  stocks.SHORT = { symbol: 'SHORT', companyName: 'SHORT', sector: 'S', industry: 'I0', close: 100, turnover: 1000, marketCap: 1 };
  daily.SHORT = hbars(40, j => ({ date: 's' + j, open: 100, high: 100, low: 50, close: 100 }));
  return { stocks, daily };
}

test('High periods are ranked 99 (at / nearest the high) to 1 (furthest below); the value is the % below the high', () => {
  const { stocks, daily } = highUniverse();
  delete stocks.SHORT; delete daily.SHORT;                                      // (the 40-bar stock is ranked for 1M High and would tie with H0 there)
  const rows = sb.rsrBuildRows(stocks, daily);
  const by = Object.fromEntries(rows.map(r => [r.isin, r]));
  for (const k of ['h1m', 'h3m', 'h6m', 'h1y']) {
    assert.equal(by.H0.perf[k], 0, k);
    assert.ok(Math.abs(by.H2.perf[k] - -10) < 1e-9, k);
    assert.equal(by.H0.rs[k], 99, k);
    assert.equal(by.H5.rs[k], 1, k);
    const order = ['H0', 'H1', 'H2', 'H3', 'H4', 'H5'].map(i => by[i].rs[k]);
    for (let i = 1; i < order.length; i++) assert.ok(order[i] < order[i - 1], k + ' strictly falling');
  }
});

test('a stock with too few bars has no rank for a High period it cannot fill, but is ranked for a shorter one', () => {
  const { stocks, daily } = highUniverse();
  const short = sb.rsrBuildRows(stocks, daily).find(r => r.isin === 'SHORT');   // 40 bars
  assert.ok(Number.isFinite(short.rs.h1m));                                     // 21 bars needed
  assert.ok(Number.isNaN(short.rs.h3m));                                        // 63 needed
  assert.ok(Number.isNaN(short.rs.h1y));
});

test('stocks sitting exactly at their high tie and share the top rank', () => {
  const stocks = {}, daily = {};
  ['A', 'B', 'C', 'D'].forEach((n, i) => {
    stocks[n] = { symbol: n, sector: 'S', industry: 'I', close: 1, turnover: 1, marketCap: 1 };
    daily[n] = hbars(80, (j, len) => ({ date: 'd' + j, high: 100, low: 1, close: j === len - 1 ? (i < 2 ? 100 : 50) : 100 }));
  });
  const rows = sb.rsrBuildRows(stocks, daily);
  const rs = Object.fromEntries(rows.map(r => [r.isin, r.rs.h3m]));
  assert.equal(rs.A, rs.B);
  assert.equal(rs.C, rs.D);
  assert.ok(rs.A > rs.C);
  assert.equal(rs.A, 83);                                                       // average position of the top two of four: round(1 + 98 * 2.5 / 3)
  assert.equal(rs.C, 17);                                                       // and of the bottom two: round(1 + 98 * 0.5 / 3)
});

test('the filters, summaries and column labels work with a High period', () => {
  const { stocks, daily } = highUniverse();
  const rows = sb.rsrBuildRows(stocks, daily);
  const f = { period: 'h3m', minRs: 70, sector: 'ALL', industry: 'ALL' };
  const passing = sb.rsrFilterStocks(rows, f);
  assert.deepEqual(Array.from(passing, r => r.isin).sort(), ['H0', 'H1']);       // ranks 99 / 79 of the 6 ranked (SHORT is unranked), H2 is 60
  const groups = sb.rsrSummarize(rows, passing, 'industry', 'h3m');
  assert.equal(groups.length, 2);
  assert.ok(groups.every(g => g.avgPerf <= 0));                                  // a % below the high is never positive
  const cols = Array.from(sb.rsrStockSpec(passing, f).cols, c => c.label);
  assert.ok(cols.includes('RS (3M High)'));
  assert.ok(cols.includes('% from 3M High'));
  assert.ok(cols.includes('RS 1Y High') && cols.includes('RS 3M'));              // every ranking shows up as a column
  assert.ok(Array.from(sb.rsrGroupSpec('sector', groups, f).cols, c => c.label).includes('Avg % from 3M High'));
  assert.equal(sb.rsrPerfLabel('3m'), '3M Perf %');
  assert.equal(sb.rsrPerfLabel('h6m'), '% from 6M High');
});

test('the rank lookup used by the Stock Scanner (rsrRankOf) answers for the High periods too', () => {
  installFakeDom(sb, {});
  const { stocks, daily } = highUniverse();
  sb.Store.latestBySymbol = stocks; sb.Store.dailyBySymbol = daily; sb.Store.latestDate = 'hi-' + Math.random();
  assert.equal(sb.rsrRankOf('H0', 'h3m'), 99);
  assert.equal(sb.rsrRankOf('H5', 'h3m'), 1);
});

test('the Rank By drop-down offers the four High options after the four performance ones', () => {
  const html = read('index.html');
  const start = html.indexOf('<select id="rsrPeriod"');
  const sel = html.slice(start, html.indexOf('</select>', start));
  const values = [...sel.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(values, ['1m', '3m', '6m', '1y', 'h1m', 'h3m', 'h6m', 'h1y']);
  assert.match(sel, /<option value="3m" selected>/);                            // 3M performance is still the default
  assert.match(sel, /1 Month high[\s\S]*3 Month high[\s\S]*6 Month high[\s\S]*1 Year high/);
});

test('RS Rating is four quick buttons (90+, 80+, 70+, Any), Any first selected; the old min / max boxes are gone', () => {
  const html = read('index.html');
  const panel = html.slice(html.indexOf('<div id="panel-rs"'), html.indexOf('<!-- Money Flow Panel'));
  const buttons = [...panel.matchAll(/<button type="button" class="btn btn-secondary rsr-chip( active)?" data-min="(\d*)" onclick="rsrSetMinRs\((\w+)\)">([^<]+)<\/button>/g)];
  assert.deepEqual(buttons.map(m => m[4]), ['90+', '80+', '70+', 'Any']);
  assert.deepEqual(buttons.map(m => m[3]), ['90', '80', '70', 'null']);
  assert.deepEqual(buttons.map(m => !!m[1]), [false, false, false, true]);          // Any starts highlighted
  assert.ok(!panel.includes('id="rsrMinRs"') && !panel.includes('id="rsrMaxRs"'));
  assert.ok(!/Quick/.test(panel));                                                   // no separate "Quick" heading: the group is labelled RS Rating
  assert.match(panel, /<label[^>]*>RS Rating<\/label>\s*<span class="rsr-chips" id="rsrChips">/);
});

test('the quick buttons drive the filter: 90 / 80 / 70 set a minimum RS, Any clears it, Reset goes back to Any; there is no maximum', () => {
  const dom = installFakeDom(sb, { rsrPeriod: '3m', rsrSector: 'ALL', rsrIndustry: 'ALL', rsrSearch: '' });
  sb.Store.latestBySymbol = universe().stocks; sb.Store.dailyBySymbol = universe().daily; sb.Store.latestDate = 'chips-' + Math.random();
  sb.rsrFilterChanged = () => {};                                                     // (drawing the page is not what is tested here)
  assert.ok(Number.isNaN(sb.rsrFilters().minRs));                                     // starts on Any
  sb.rsrSetMinRs(90);  assert.equal(sb.rsrFilters().minRs, 90);
  sb.rsrSetMinRs(80);  assert.equal(sb.rsrFilters().minRs, 80);
  sb.rsrSetMinRs(70);  assert.equal(sb.rsrFilters().minRs, 70);
  assert.ok(Number.isNaN(sb.rsrFilters().maxRs));
  sb.rsrSetMinRs(null); assert.ok(Number.isNaN(sb.rsrFilters().minRs));
  sb.rsrSetMinRs(80);
  sb.rsrFilterChanged = () => {};
  sb.rsrReset();
  assert.ok(Number.isNaN(sb.rsrFilters().minRs));
  assert.ok(dom);
});

test('the quick buttons keep the stocks at or above the number (80+ keeps 80 and 99, not 79), on the whole RS scale', () => {
  const rows = sb.rsrBuildRows(universe().stocks, universe().daily);              // 3M ranks 99 / 79 / 60 / 40 / 20 / 1
  const keep = min => Array.from(sb.rsrFilterStocks(rows, { period: '3m', sector: 'ALL', industry: 'ALL', minRs: min }), r => r.symbol).sort().join();
  assert.equal(keep(90), 'AAA');
  assert.equal(keep(80), 'AAA');                                                     // BBB is 79
  assert.equal(keep(70), 'AAA,BBB');
  assert.equal(keep(NaN), 'AAA,BBB,CCC,DDD,EEE,FFF');
  rows.find(r => r.symbol === 'BBB').rs['3m'] = 80;                                  // exactly on the line
  assert.equal(keep(80), 'AAA,BBB');                                                 // "80+" includes 80
  assert.equal(keep(81), 'AAA');
});


// ── liquidity filters: average turnover over 50 trading days, and market cap ──────────────────────────────────────────

test('rsrAvgTurnover: the average of the last n bars only; NaN with fewer than n bars; a missing turnover counts as 0', () => {
  const d = Array.from({ length: 60 }, (_, i) => ({ turnover: i < 10 ? 100000 : 100 }));   // a huge spike in the first 10 bars, outside the last 50
  assert.equal(sb.rsrAvgTurnover(d, 50), 100);
  assert.ok(Number.isNaN(sb.rsrAvgTurnover(d.slice(0, 49), 50)));
  assert.ok(Number.isNaN(sb.rsrAvgTurnover(undefined, 50)));
  assert.equal(sb.rsrAvgTurnover([{ turnover: 10 }, {}, { turnover: 20 }], 3), 10);
});

test('the turnover filter uses the 50-day average, not the latest day: a stock with one huge day but a quiet 50 days is hidden', () => {
  const stocks = { Q: { symbol: 'Q', sector: 'S', industry: 'I', close: 1, marketCap: 1 }, B: { symbol: 'B', sector: 'S', industry: 'I', close: 1, marketCap: 1 } };
  const daily = {
    Q: Array.from({ length: 80 }, (_, i) => ({ date: 'd' + i, high: 1, low: 1, close: 1 + (i === 79 ? 1 : 0), turnover: i === 79 ? 1e6 : 100 })),   // quiet, then one 10,000 Cr day
    B: Array.from({ length: 80 }, (_, i) => ({ date: 'd' + i, high: 1, low: 1, close: 1, turnover: 5000 })),                                      // steady 50 Cr a day
  };
  const rows = sb.rsrBuildRows(stocks, daily);
  const by = Object.fromEntries(rows.map(r => [r.isin, r]));
  assert.ok(Math.abs(by.Q.avgTurnover - (49 * 100 + 1e6) / 50) < 1e-9);
  assert.equal(by.B.avgTurnover, 5000);
  const pass = min => Array.from(sb.rsrFilterStocks(rows, { period: '1m', minAvgTurnoverCr: min }), r => r.isin).sort().join();
  assert.equal(pass(10), 'B,Q');          // Q averages (49 * 100 + 1,000,000) / 50 = 20,098 lakh = 201 Cr: its one huge day does lift the average ...
  assert.equal(pass(250), '');            // ... but not above 250 Cr, and B is steady at 50 Cr
  assert.equal(pass(60), 'Q');            // only Q clears 60 Cr on average; B's steady 50 Cr does not
});

test('a stock with fewer than 50 trading days has no average turnover and is hidden while the filter is set, but not otherwise', () => {
  const { stocks, daily } = highUniverse();           // SHORT has 40 bars (and no turnover data in this fixture)
  const rows = sb.rsrBuildRows(stocks, daily);
  const short = rows.find(r => r.isin === 'SHORT');
  assert.ok(Number.isNaN(short.avgTurnover));
  const f = { period: 'h1m', sector: 'ALL', industry: 'ALL' };
  assert.ok(Array.from(sb.rsrFilterStocks(rows, f), r => r.isin).includes('SHORT'));
  assert.ok(!Array.from(sb.rsrFilterStocks(rows, { ...f, minAvgTurnoverCr: 1 }), r => r.isin).includes('SHORT'));
  assert.ok(Array.from(sb.rsrFilterStocks(rows, { ...f, minAvgTurnoverCr: 0 }), r => r.isin).includes('SHORT'));   // 0 / blank = no limit
});

test('the market cap filter hides stocks below it and stocks with no market cap on record, only while it is set', () => {
  const rows = sb.rsrBuildRows(universe().stocks, universe().daily);
  const base = { period: '1m', sector: 'ALL', industry: 'ALL' };
  const syms = f => Array.from(sb.rsrFilterStocks(rows, { ...base, ...f }), r => r.symbol).sort().join();
  assert.ok(syms({}).includes('NEW'));                                   // NEW (market cap 0) is ranked for 1M and shown with no filter
  assert.ok(!syms({ minMcapCr: 1 }).includes('NEW'));
  assert.equal(syms({ minMcapCr: 6000 }), 'AAA,BBB');
});

test('the markup has the two liquidity filters (Min Market Cap, Min Avg Turnover 50D) and the old single-day Min Turnover is gone', () => {
  const html = read('index.html');
  const panel = html.slice(html.indexOf('<div id="panel-rs"'), html.indexOf('<!-- Money Flow Panel'));
  assert.ok(panel.includes('id="rsrMinMcap"') && panel.includes('id="rsrMinAvgTurnover"'));
  assert.match(panel, /Min Market Cap \(Cr\)/);
  assert.match(panel, /Min Avg Turnover 50D \(Cr\)/);
  assert.ok(!panel.includes('rsrMinTurnover') && !/>Min Turnover \(Cr\)</.test(panel));
  const js = read('js/rs-rank.js');
  assert.match(js, /minMcapCr: rsrNum\('rsrMinMcap'\)/);
  assert.ok(!/minTurnoverCr|rsrMinTurnover/.test(js));
});

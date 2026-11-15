'use strict';
// RS rating on the stock chart's crosshair legend (js/rs-rank.js rsrHistory* + js/industry-charts.js icRs* / icLegendHtml):
//   SYMBOL  O H L C  change  MF   RS 3M 87   Ind 2/10
// RS = the 99..1 rank among all stocks on that candle's date; Ind = position among the stock's industry peers that date (rank / peers rated).
// The history must agree with the Relative Strength tab on the latest bar, never look ahead, leave short-history bars blank, and the legend's
// drop-down must hold the same period list as the tab's Rank By.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');
const { makeFakeChart } = require('./fakechart');

const root = path.dirname(__dirname);
const src = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/screener.js', 'js/rs-rank.js', 'js/money-flow.js', 'js/chart-helpers.js', 'js/chart-tools.js', 'js/industry-charts.js']);
const RSR_PERIODS = vm.runInContext('RSR_PERIODS', sb);
const arr = a => Array.from(a);
const text = html => html.replace(/<\/?b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();   // <b> tags vanish so "2/10" reads as written

// deterministic pseudo-random walk, so every run sees the same market
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function walk(rand, n, startDay = 0) {
  const out = []; let c = 100 + rand() * 50;
  for (let i = 0; i < n; i++) {
    c *= 1 + (rand() - 0.48) * 0.04;
    const hi = c * (1 + rand() * 0.02);
    out.push({ date: 'D' + String(startDay + i).padStart(4, '0'), open: c, high: hi, low: c * 0.98, close: c, turnover: 100 });
  }
  return out;
}
function market(count, bars, industries = ['Alpha', 'Beta', 'Gamma']) {
  const rand = rng(7), stocks = {}, daily = {};
  for (let k = 0; k < count; k++) {
    const isin = 'S' + k;
    stocks[isin] = { isin, symbol: isin, sector: 'X', industry: industries[k % industries.length], close: 1 };
    daily[isin] = walk(rand, bars);
    stocks[isin].close = daily[isin][bars - 1].close;
  }
  return { stocks, daily };
}

// --- the per-bar values equal the tab's numbers on any prefix of the history -------------------------------------

test('rsrBarValues: perf is computeDynPerformance and high is rsrDistFromHigh on the history up to each bar', () => {
  const days = walk(rng(3), 300);
  for (const p of RSR_PERIODS) {
    const v = sb.rsrBarValues(days, p);
    for (const i of [0, 5, p.days - 2, p.days - 1, p.days, p.days + 1, 150, 299]) {
      if (i < 0 || i >= days.length) continue;
      const prefix = days.slice(0, i + 1);
      const want = p.kind === 'high' ? sb.rsrDistFromHigh(prefix, p.days) : sb.computeDynPerformance(prefix, p.days);
      if (Number.isNaN(want)) assert.ok(Number.isNaN(v[i]), `${p.key} bar ${i}`);
      else assert.equal(v[i], want, `${p.key} bar ${i}`);
    }
  }
});

test('rsrBarValues: a performance period needs n + 1 bars, a high period needs n', () => {
  const days = walk(rng(4), 100);
  const perf = sb.rsrBarValues(days, RSR_PERIODS.find(p => p.key === '1m'));    // 21
  assert.ok(Number.isNaN(perf[20]) && Number.isFinite(perf[21]));
  const high = sb.rsrBarValues(days, RSR_PERIODS.find(p => p.key === 'h1m'));
  assert.ok(Number.isNaN(high[19]) && Number.isFinite(high[20]));
  assert.ok([...high].every(v => Number.isNaN(v) || v <= 0));                    // never above its own high
});

// --- history == the Relative Strength tab on the latest bar --------------------------------------------------------

test('on the latest bar every period gives the same RS as the Relative Strength tab', () => {
  const { stocks, daily } = market(40, 300);
  const rows = sb.rsrBuildRows(stocks, daily);
  for (const p of RSR_PERIODS) {
    const h = sb.rsrHistoryBuild(stocks, daily, p.key);
    for (const r of rows) {
      const got = h.get(r.isin).rs[299];
      if (Number.isNaN(r.rs[p.key])) assert.equal(got, 0, `${r.isin} ${p.key}`);
      else assert.equal(got, r.rs[p.key], `${r.isin} ${p.key}`);
    }
  }
});

test('RS on an earlier candle ranks the market AS OF THAT DAY (later data changes nothing)', () => {
  const { stocks, daily } = market(30, 300);
  const full = sb.rsrHistoryBuild(stocks, daily, '3m');
  const cut = {};
  for (const k in daily) cut[k] = daily[k].slice(0, 200);                         // the market as it stood on bar 199
  const asOf = sb.rsrHistoryBuild(stocks, cut, '3m');
  for (const k in daily) {
    assert.equal(full.get(k).rs[199], asOf.get(k).rs[199], k);
    assert.equal(full.get(k).rank[199], asOf.get(k).rank[199], k);
  }
});

// --- history length ------------------------------------------------------------------------------------------

test('bars without a full lookback have no rating (0) - 1Y needs 251 bars, 1M needs 22', () => {
  const { stocks, daily } = market(10, 300);
  const y = sb.rsrHistoryBuild(stocks, daily, '1y').get('S0');
  assert.ok(y.rs.slice(0, 250).every(v => v === 0) && y.rs[250] > 0);
  assert.ok(y.rank.slice(0, 250).every(v => v === 0) && y.count.slice(0, 250).every(v => v === 0));
  const m = sb.rsrHistoryBuild(stocks, daily, '1m').get('S0');
  assert.ok(m.rs.slice(0, 21).every(v => v === 0) && m.rs[21] > 0);
});

// --- industry position ---------------------------------------------------------------------------------------

// Three industries over 30 bars; closes chosen so the 1M perf order on the last bar is known.
function fixed(closeByIsin, industryByIsin, n = 30) {
  const stocks = {}, daily = {};
  for (const isin in closeByIsin) {
    stocks[isin] = { isin, symbol: isin, industry: industryByIsin[isin] };
    daily[isin] = Array.from({ length: n }, (_, i) => ({ date: 'D' + String(i).padStart(3, '0'), open: 1, high: 1, low: 1, close: i === n - 1 ? closeByIsin[isin] : 100, turnover: 1 }));
  }
  return { stocks, daily };
}

test('Ind = position among the peers of the same industry that day, out of how many were rated', () => {
  const { stocks, daily } = fixed(
    { A: 150, B: 130, C: 110, D: 120, E: 90 },                                   // 1M perf +50 +30 +10 +20 -10
    { A: 'Soft', B: 'Soft', C: 'Soft', D: 'Bank', E: 'Bank' });
  const h = sb.rsrHistoryBuild(stocks, daily, '1m');
  const last = k => [h.get(k).rank[29], h.get(k).count[29]];
  assert.deepEqual(last('A'), [1, 3]);
  assert.deepEqual(last('B'), [2, 3]);
  assert.deepEqual(last('C'), [3, 3]);
  assert.deepEqual(last('D'), [1, 2]);
  assert.deepEqual(last('E'), [2, 2]);
  assert.equal(h.get('A').rs[29], 99);                                            // overall rank is across all five
  assert.equal(h.get('E').rs[29], 1);
});

test('equal performers in an industry share the better position', () => {
  const { stocks, daily } = fixed({ A: 150, B: 120, C: 120, D: 110 }, { A: 'I', B: 'I', C: 'I', D: 'I' });
  const h = sb.rsrHistoryBuild(stocks, daily, '1m');
  assert.deepEqual(['A', 'B', 'C', 'D'].map(k => h.get(k).rank[29]), [1, 2, 2, 4]);
  assert.ok(['A', 'B', 'C', 'D'].every(k => h.get(k).count[29] === 4));
});

test('peers are only the stocks rated that day: a later listing is not counted before it can be rated', () => {
  const { stocks, daily } = fixed({ A: 150, B: 130, C: 110 }, { A: 'I', B: 'I', C: 'I' }, 40);
  daily.C = daily.C.slice(20);                                                     // C's first bar is D020: rated from D041 on, i.e. not at all here
  const h = sb.rsrHistoryBuild(stocks, daily, '1m');
  assert.equal(h.get('C').rs[19], 0);                                              // C has only 20 bars: never rated
  assert.deepEqual([h.get('A').rank[39], h.get('A').count[39]], [1, 2]);          // so A and B are the only two peers on the last day
  assert.deepEqual([h.get('B').rank[39], h.get('B').count[39]], [2, 2]);
});

test('a stock with no bar on a date is not ranked on that date', () => {
  const { stocks, daily } = fixed({ A: 150, B: 130, C: 110 }, { A: 'I', B: 'I', C: 'I' }, 40);
  daily.B.splice(39, 1);                                                           // B did not trade on the last date
  const h = sb.rsrHistoryBuild(stocks, daily, '1m');
  assert.deepEqual([h.get('A').rank[39], h.get('A').count[39]], [1, 2]);
  assert.deepEqual([h.get('C').rank[39], h.get('C').count[39]], [2, 2]);
});

test('an unknown period gives nothing, and rsrHistory builds once per data set and period', () => {
  assert.equal(sb.rsrHistoryBuild({}, {}, 'nope').size, 0);
  sb.Store.latestDate = '2026-01-01';
  const { stocks, daily } = market(6, 80);
  sb.Store.latestBySymbol = stocks; sb.Store.dailyBySymbol = daily;
  const a = sb.rsrHistory('1m');
  assert.equal(sb.rsrHistory('1m'), a);                                            // cached
  assert.notEqual(sb.rsrHistory('3m'), a);
  sb.Store.latestDate = '2026-01-02';
  assert.notEqual(sb.rsrHistory('1m'), a);                                         // new data -> rebuilt
});

// --- legend text -----------------------------------------------------------------------------------------------

const BAR = { open: 27.29, high: 27.90, low: 27.01, close: 27.31 };

test('the legend ends with RS and Ind, e.g. "RS 3M 87  Ind 2/10"', () => {
  const html = sb.icLegendHtml({ symbol: 'X' }, BAR, 26.69, 0, { label: '3M', rs: 87, rank: 2, count: 10 });
  assert.match(text(html), /MF .* RS 3M 87 Ind 2\/10$/);
  assert.match(html, /<b[^>]*>87<\/b>/);
});

test('a bar with no rating shows "-" for both; without RS info nothing is added (industry index chart)', () => {
  const none = sb.icRsInfo({ rs: new Int16Array(3), rank: new Int16Array(3), count: new Int16Array(3) }, 1, '1Y');
  assert.match(text(sb.icLegendHtml(null, BAR, 26.69, 0, none)), /RS 1Y - Ind -$/);
  assert.doesNotMatch(sb.icLegendHtml(null, BAR, 26.69, 0), /RS |Ind /);
  assert.doesNotMatch(sb.icLegendHtml(null, BAR, 26.69, 0, null), /RS |Ind /);
});

test('icRsInfo reads the series at a daily index', () => {
  const s = { rs: Int16Array.of(0, 40, 99), rank: Int16Array.of(0, 5, 1), count: Int16Array.of(0, 12, 3) };
  const i = sb.icRsInfo(s, 2, '3M');
  assert.deepEqual([i.label, i.rs, i.rank, i.count], ['3M', 99, 1, 3]);
  assert.ok(Number.isNaN(sb.icRsInfo(s, 0, '3M').rs));
});

test('icLegendStock carries the ISIN (the RS lookup key) only when the stock has one', () => {
  assert.equal(sb.icLegendStock({ symbol: 'A', isin: 'INE1' }).isin, 'INE1');
  assert.ok(!('isin' in sb.icLegendStock({ symbol: 'A' })));
});

// --- bars -> daily index (weekly candles read RS at the week's last day) ---------------------------------------------------

test('icBuildBarsFromDays records each bar\'s index in the daily series', () => {
  const days = [{ date: '09-Nov-2026', open: 1, high: 1, low: 1, close: 1 }, { date: '10-Nov-2026', open: 1, high: 1, low: 1, close: 1 }];
  assert.deepEqual(arr(sb.icBuildBarsFromDays(days).dayIdx), [0, 1]);
});

test('weekly candles map to the LAST daily bar of their week', () => {
  const dates = ['02-Nov-2026', '03-Nov-2026', '04-Nov-2026', '05-Nov-2026', '06-Nov-2026', '09-Nov-2026', '10-Nov-2026'];
  const days = dates.map(d => ({ date: d, open: 1, high: 1, low: 1, close: 1, turnover: 1 }));
  sb.document.getElementById = () => ({ checked: false, value: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {} });
  const w = sb.icWeeklyFromDaily(sb.icBuildBarsFromDays(days));
  assert.deepEqual(arr(w.dayIdx), [4, 6]);                                          // Fri 6 Nov, and the week so far (Tue 10 Nov)
  assert.ok(!('dayIdx' in sb.icWeeklyFromDaily({ candleData: [], volumeData: [] })));
});

// --- wiring in the chart ---------------------------------------------------------------------------------------------------

function fakeLibrary() {
  const fake = makeFakeChart();
  const series = () => Object.assign(fake.makeSeries(0), { priceScale: () => ({ applyOptions() {} }), applyOptions() {}, setData() {} });
  Object.assign(fake.chart, { addSeries: () => series(), panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }], applyOptions() {}, remove() {} });
  return { fake, lib: { createChart: () => fake.chart, CrosshairMode: { Normal: 0 }, CandlestickSeries: {}, HistogramSeries: {}, LineSeries: {}, createSeriesMarkers: () => ({ setMarkers() {} }) } };
}
function build(stock) {
  const dom = installFakeDom(sb);
  const { lib, fake } = fakeLibrary();
  sb.LightweightCharts = lib;
  sb.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sb.document.documentElement = {};
  const children = [];
  const container = dom.el('chartHost');
  container.appendChild = el => { children.push(el); };
  const inst = sb.icCreateChart(container, 'vol', stock);
  const t = (d, c) => ({ time: { year: 2026, month: 10, day: d }, open: c - 1, high: c + 1, low: c - 2, close: c });
  inst.candleData = [t(7, 100), t(8, 110), t(9, 105)];
  inst.volumeData = inst.candleData.map((b, i) => ({ time: b.time, value: 100 * (i + 1) }));
  return { inst, fake, dom, legend: children.find(c => c.className === 'ic-legend') };
}
const SERIES = { rs: Int16Array.of(60, 75, 90), rank: Int16Array.of(5, 3, 1), count: Int16Array.of(10, 10, 9) };

test('the legend follows the crosshair: each candle shows ITS OWN RS and industry position', () => {
  const { inst, fake, legend } = build({ symbol: 'X', isin: 'I1' });
  sb.rsrHistory = () => new Map([['I1', SERIES]]);
  sb.icAttachRs(inst, { isin: 'I1' }, null);
  inst.updateLegend();
  assert.match(text(legend.innerHTML), /RS 3M 90 Ind 1\/9$/);                       // latest bar by default
  fake.handlers.move.forEach(fn => fn({ time: inst.candleData[0].time }));
  assert.match(text(legend.innerHTML), /RS 3M 60 Ind 5\/10$/);
  fake.handlers.move.forEach(fn => fn({ time: inst.candleData[1].time }));
  assert.match(text(legend.innerHTML), /RS 3M 75 Ind 3\/10$/);
});

test('weekly bars read RS through dayIdx (their last day), not their own position', () => {
  const { inst, legend } = build({ symbol: 'X', isin: 'I1' });
  sb.rsrHistory = () => new Map([['I1', SERIES]]);
  inst.candleData.length = 2;                                                         // two weekly bars...
  inst.volumeData.length = 2;
  sb.icAttachRs(inst, { isin: 'I1' }, [1, 2]);                                        // ...ending on daily bars 1 and 2
  inst.updateLegend(0);
  assert.match(text(legend.innerHTML), /RS 3M 75 Ind 3\/10$/);
});

test('the drop-down re-reads the RS of the charts on screen, keeps the candles, and a chart without a stock shows no RS', () => {
  const { inst, legend } = build({ symbol: 'X', isin: 'I1' });
  sb.rsrHistory = key => new Map([['I1', key === '1y' ? { rs: Int16Array.of(0, 0, 33), rank: Int16Array.of(0, 0, 7), count: Int16Array.of(0, 0, 8) } : SERIES]]);
  sb.icAttachRs(inst, { isin: 'I1' }, null);
  sb.__inst = inst;
  vm.runInContext('icMode = "single"; icIndustryChartInst = __inst; icChartInstances = [];', sb);   // the one chart on screen
  sb.icSetRsPeriod('1y');
  assert.match(text(legend.innerHTML), /RS 1Y 33 Ind 7\/8$/);
  sb.icSetRsPeriod('h3m');
  assert.match(text(legend.innerHTML), /RS 3M High/);
  const bare = build(null);
  bare.inst.updateLegend();
  assert.doesNotMatch(bare.legend.innerHTML, /RS |Ind /);
  sb.icSetRsPeriod('3m');
});

// --- markup ---------------------------------------------------------------------------------------------------------------

test('the header drop-down offers exactly the Relative Strength tab\'s Rank By options, and it is wired', () => {
  const html = src('index.html');
  const opts = id => [...html.slice(html.indexOf(`id="${id}"`)).split('</select>')[0].matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(opts('icRsPeriod'), opts('rsrPeriod'));
  assert.equal(opts('icRsPeriod').length, 8);
  assert.match(html, /id="icRsPeriod" onchange="icSetRsPeriod\(this\.value\)"/);
  assert.match(src('js/industry-charts.js'), /rsWrap\.style\.display = icMode === 'single' \|\| icActiveTab === 'stocks'/);
});

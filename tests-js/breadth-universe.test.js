'use strict';
// js/breadth-universe.js: the Market Breadth tab's Universe selector (all stocks / one sector / one industry), the "vs all stocks" line and
// the 5-day smoothing. It reuses breadth.js's own computeBreadthHistories (with its optional stock filter), so the numbers must be the same ones
// the market-wide chart shows: the industries of a market add up to the market-wide count on every day. The chart and series are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { makeFakeChart } = require('./fakechart');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/breadth.js', 'js/breadth-universe.js', 'js/chart-tools.js']);
const run = code => vm.runInContext(code, sb);
const dom = installFakeDom(sb);
// the fake <select> has no real option list: derive .options from the markup bruReset writes, so "keep the selection" can be tested
Object.defineProperty(dom.el('brdUniverse'), 'options', { get() { return [...this.innerHTML.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] })); } });

const N = 60;
const dates = Array.from({ length: N }, (_, i) => 'D' + String(i).padStart(3, '0'));
// A stock oscillating around 100 with its own period, so it is above / below its 20 SMA on different days than the others
function stock(isin, period, phase = 0) {
  return dates.map((date, i) => {
    const c = 100 + 10 * Math.sin(((i + phase) / period) * 2 * Math.PI) + i * 0.05;
    return { date, open: c * 0.995, high: c * 1.01, low: c * 0.99, close: c, prev: c * 0.99, symbol: isin };
  });
}
// 12 stocks: PHARMA sector (industries DRUGS 11-stock-ish group below), BANKS sector ...
//   DRUGS (pharma)  : 10 stocks  -> in the main list (10+)
//   LABS  (pharma)  : 2 stocks   -> small (noisy)
//   LENDERS (banks) : 3 stocks   -> small; one with no sector / industry -> "Undefined-Diversified"
function setupData() {
  const meta = {}, daily = {};
  const add = (isin, sector, industry, period, phase) => { daily[isin] = stock(isin, period, phase); meta[isin] = { isin, sector, industry }; };
  for (let i = 0; i < 10; i++) add('DR' + i, 'Pharma', 'Drugs', 9 + i, i * 3);
  for (let i = 0; i < 2; i++) add('LB' + i, 'Pharma', 'Labs', 14 + i, i * 5);
  for (let i = 0; i < 3; i++) add('LN' + i, 'Banks', 'Lenders', 11 + 2 * i, i * 4);
  add('UN0', '', '', 17, 2);
  sb.Store.dates = dates;
  sb.Store.dailyBySymbol = daily;
  sb.Store.latestBySymbol = meta;
}
function reset() {
  setupData();
  dom.el('brdUniverse').value = 'all';
  dom.el('brdCompare').checked = false; dom.el('brdCompare').disabled = false;
  dom.el('brdSmooth').checked = false;
  const all = sb.computeBreadthHistories(N);
  sb.bruReset(all, N);
  return all;
}
// (arrays that come out of the sandbox are of another realm: copy them into this one before deepEqual)
const closes = (hist, prefix = 'above20') => Array.from(hist, d => d[prefix + 'OHLC'].close);
const counts = (hist, key = 'above20CloseCount') => Array.from(hist, d => d[key]);
const vals = data => Array.from(data, p => p.value);

test('universe groups: sectors, industries of 10+ stocks, and the small ones last - each with its stock count', () => {
  reset();
  const g = sb.bruGroups();
  assert.deepEqual(JSON.parse(JSON.stringify(g.sectors)), [{ name: 'Banks', count: 3 }, { name: 'Pharma', count: 12 }, { name: 'Undefined-Diversified', count: 1 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(g.industries)), [{ name: 'Drugs', count: 10 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(g.small)), [{ name: 'Labs', count: 2 }, { name: 'Lenders', count: 3 }, { name: 'Undefined-Diversified', count: 1 }]);
});

test('universe dropdown: All stocks first, then Sectors, Industries (10+), Industries under 10 (jumpy)', () => {
  reset();
  const html = dom.el('brdUniverse').innerHTML;
  assert.match(html, /^<option value="all">All stocks<\/option>/);
  const order = [...html.matchAll(/<optgroup label="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['Sectors', 'Industries (10+ stocks)', 'Industries under 10 stocks (jumpy)']);
  assert.match(html, /<option value="sec:Pharma">Pharma \(12\)<\/option>/);
  assert.match(html, /<option value="ind:Drugs">Drugs \(10\)<\/option>/);
  assert.match(html, /<option value="ind:Labs">Labs \(2\)<\/option>/);
});

test('universe dropdown: the selection survives a data refresh when it still exists, and falls back to All when it does not', () => {
  const all = reset();
  dom.el('brdUniverse').value = 'ind:Drugs';
  sb.bruReset(all, N);
  assert.equal(dom.el('brdUniverse').value, 'ind:Drugs');
  dom.el('brdUniverse').value = 'ind:Gone';
  sb.bruReset(all, N);
  assert.equal(dom.el('brdUniverse').value, 'all');
});

test('a sector / industry history is breadth.js\'s own calculation over just those stocks', () => {
  reset();
  dom.el('brdUniverse').value = 'sec:Banks';
  const h = sb.bruCurrent();
  const direct = sb.computeBreadthHistories(N, isin => isin.startsWith('LN'));
  assert.deepEqual(JSON.parse(JSON.stringify(h)), JSON.parse(JSON.stringify(direct)));
  // 3 stocks: every percentage is a multiple of 100/3 (or 0 before the 20-day window fills)
  for (const c of closes(h)) assert.ok(Math.abs(c * 3 / 100 - Math.round(c * 3 / 100)) < 1e-9, String(c));
});

test('the industries add up to the market-wide count on every day (nothing is lost or counted twice)', () => {
  const all = reset();
  const sum = new Array(N).fill(0);
  for (const g of sb.bruGroups().industries.concat(sb.bruGroups().small)) {
    dom.el('brdUniverse').value = 'ind:' + g.name;
    counts(sb.bruCurrent()).forEach((c, i) => { sum[i] += c; });
  }
  assert.deepEqual(sum, counts(all));
  const sumSec = new Array(N).fill(0);
  for (const g of sb.bruGroups().sectors) {
    dom.el('brdUniverse').value = 'sec:' + g.name;
    counts(sb.bruCurrent()).forEach((c, i) => { sumSec[i] += c; });
  }
  assert.deepEqual(sumSec, counts(all));
});

test('a stock with no sector / industry is in "Undefined-Diversified"', () => {
  reset();
  dom.el('brdUniverse').value = 'ind:Undefined-Diversified';
  assert.equal(sb.bruCount('ind:Undefined-Diversified'), 1);
  const h = sb.bruCurrent();
  assert.deepEqual(counts(h), counts(sb.computeBreadthHistories(N, isin => isin === 'UN0')));
});

test('a universe is computed once and cached; new data clears the cache', () => {
  const all = reset();
  dom.el('brdUniverse').value = 'ind:Drugs';
  const first = sb.bruHistoryOf('ind:Drugs');
  assert.equal(sb.bruHistoryOf('ind:Drugs'), first);
  sb.bruReset(all, N);
  assert.notEqual(sb.bruHistoryOf('ind:Drugs'), first);
});

test('all stocks: the plotted history is the market-wide one itself (no copy, no smoothing)', () => {
  const all = reset();
  assert.equal(sb.bruCurrent(), all);
  assert.equal(sb.bruCompare(), null);
  assert.equal(sb.bruTitleSuffix(), '');
  assert.equal(sb.bruNote(), '');
});

test('smoothing: the closing % is a trailing 5-day mean; counts, open / high / low stay as they were; the source is not modified', () => {
  const all = reset();
  dom.el('brdSmooth').checked = true;
  const before = JSON.stringify(all);
  const sm = sb.bruCurrent();
  const raw = closes(all);
  const out = closes(sm);
  for (let i = 0; i < N; i++) {
    const from = Math.max(0, i - 4);
    const mean = raw.slice(from, i + 1).reduce((a, b) => a + b, 0) / (i + 1 - from);
    assert.ok(Math.abs(out[i] - mean) < 1e-9, 'day ' + i);
  }
  assert.deepEqual(counts(sm), counts(all));
  assert.deepEqual(Array.from(sm, d => d.above20OHLC.open), Array.from(all, d => d.above20OHLC.open));
  assert.equal(JSON.stringify(all), before);
  // every metric is smoothed, not just the 20 SMA
  for (const p of ['above50', 'move4d', 'move10w', 'move20m', 'high1m', 'high3m', 'high1y', 'highAth']) {
    assert.ok(Math.abs(sm[N - 1][p + 'OHLC'].close - closes(all, p).slice(-5).reduce((a, b) => a + b, 0) / 5) < 1e-9, p);
  }
});

test('"vs all stocks": the market-wide line is offered for a sub-universe only, and only when ticked', () => {
  const all = reset();
  assert.equal(sb.bruCompare(), null);                         // all stocks selected
  dom.el('brdUniverse').value = 'sec:Pharma';
  sb.bruSyncControls(false);
  assert.equal(dom.el('brdCompare').disabled, false);
  assert.equal(sb.bruCompare(), null);                         // not ticked
  dom.el('brdCompare').checked = true;
  assert.equal(sb.bruCompare(), all);
  dom.el('brdSmooth').checked = true;
  assert.deepEqual(closes(sb.bruCompare()), closes(sb.bruSmoothHistory(all)));   // smoothed the same way as the universe's own line
  sb.bruSyncControls(true);                                    // an overlay chart: the box is disabled and ignored
  assert.equal(dom.el('brdCompare').disabled, true);
  assert.equal(sb.bruCompare(), null);
  dom.el('brdUniverse').value = 'all';
  sb.bruSyncControls(false);
  assert.equal(dom.el('brdCompare').disabled, true);
});

test('title suffix and note say what is shown; a small industry is flagged as jumpy', () => {
  reset();
  dom.el('brdUniverse').value = 'sec:Pharma';
  assert.equal(sb.bruTitleSuffix(), ' - Pharma');
  assert.equal(sb.bruNote(), 'Universe: Pharma (sector, 12 stocks)');
  dom.el('brdUniverse').value = 'ind:Drugs';
  assert.equal(sb.bruNote(), 'Universe: Drugs (industry, 10 stocks)');
  dom.el('brdUniverse').value = 'ind:Lenders';
  assert.match(sb.bruNote(), /Lenders \(industry, 3 stocks\) - a small group, so the line is jumpy: one stock moves it by 33 points/);
  dom.el('brdUniverse').value = 'ind:Undefined-Diversified';
  assert.match(sb.bruNote(), /1 stock\) - a small group/);
});

test('the tag changes with the universe and the smoothing, so the drawing tools reset on either', () => {
  reset();
  const tags = new Set();
  for (const u of ['all', 'sec:Pharma', 'ind:Drugs']) for (const s of [false, true]) {
    dom.el('brdUniverse').value = u; dom.el('brdSmooth').checked = s;
    tags.add(sb.bruTag());
  }
  assert.equal(tags.size, 6);
});

// ── the chart wiring in breadth.js ─────────────────────────────────────────
function fakeSeries(fake) {
  const s = fake.makeSeries(0);
  s.data = []; s.options = {};
  s.setData = d => { s.data = d; };
  s.applyOptions = o => Object.assign(s.options, o);
  return s;
}
function setupChart() {
  const fake = makeFakeChart();
  sb.__fake = fake;
  sb.__candle = fakeSeries(fake); sb.__line = fakeSeries(fake); sb.__count = fakeSeries(fake); sb.__compare = fakeSeries(fake);
  sb.__multi = [0, 1, 2, 3].map(() => fakeSeries(fake));
  run('brdChart = __fake.chart; brdCandleSeries = __candle; brdLineSeries = __line; brdCountSeries = __count; brdCompareSeries = __compare; brdMultiSeries = __multi; brdTools = null; _brdToolsSeries = null; _brdToolsKey = null');
  // dates "D007" -> a distinct BusinessDay
  run("ewToBusinessDay = d => ({ year: 2000, month: 1, day: Number(d.slice(1)) + 1 }); ewFitWithRightPad = () => {}; requestAnimationFrame = fn => fn();");
  return fake;
}
function render(all, tab = 'above20') {
  run(`_brdHistory = null; _brdActiveTab = '${tab}'`);
  sb._brdTmp = all;
  run('_brdHistory = _brdTmp');
  run('brdRenderActiveTab()');
}

test('chart: all stocks plots the market-wide closes and the title is unchanged; no comparison line', () => {
  const all = reset();
  setupChart();
  render(all);
  assert.deepEqual(vals(sb.__line.data), closes(all));
  assert.equal(sb.__compare.data.length, 0);
  assert.equal(dom.el('brdChartTitle').textContent, '% Stocks Above 20 SMA');
  assert.equal(dom.el('brdUniverseNote').textContent, 'Universe: all NSE stocks');
});

test('chart: an industry plots its own closes and counts, titled and noted with its name', () => {
  const all = reset();
  setupChart();
  dom.el('brdUniverse').value = 'ind:Drugs';
  render(all);
  const h = sb.computeBreadthHistories(N, isin => isin.startsWith('DR'));
  assert.deepEqual(vals(sb.__line.data), closes(h));
  assert.deepEqual(vals(sb.__count.data), counts(h));
  assert.equal(dom.el('brdChartTitle').textContent, '% Stocks Above 20 SMA - Drugs');
  assert.match(dom.el('brdUniverseNote').textContent, /^Universe: Drugs \(industry, 10 stocks\)$/);
});

test('chart: "vs all stocks" draws the market-wide line behind the industry\'s', () => {
  const all = reset();
  setupChart();
  dom.el('brdUniverse').value = 'sec:Pharma';
  dom.el('brdCompare').checked = true;
  render(all);
  assert.deepEqual(vals(sb.__compare.data), closes(all));
  assert.match(dom.el('brdUniverseNote').textContent, /dashed line: all NSE stocks/);
  assert.equal(sb.__compare.data.length, sb.__line.data.length);
});

test('chart: the overlay views ignore the comparison and clear its line', () => {
  const all = reset();
  setupChart();
  dom.el('brdUniverse').value = 'sec:Pharma';
  dom.el('brdCompare').checked = true;
  render(all, 'above20');
  assert.ok(sb.__compare.data.length > 0);
  dom.el('brdSma20').checked = true; dom.el('brdSma50').checked = true;
  render(all, 'aboveSma');
  assert.equal(sb.__compare.data.length, 0);
  assert.equal(dom.el('brdCompare').disabled, true);
  const h = sb.computeBreadthHistories(N, isin => isin.startsWith('DR') || isin.startsWith('LB'));
  assert.deepEqual(vals(sb.__multi[0].data), closes(h, 'above20'));     // the overlay is the sector's, too
  assert.deepEqual(vals(sb.__multi[1].data), closes(h, 'above50'));
  dom.el('brdSma50').checked = false;
});

test('chart: other breadth tabs follow the universe too', () => {
  const all = reset();
  setupChart();
  dom.el('brdUniverse').value = 'ind:Lenders';
  render(all, 'move4d');
  const h = sb.computeBreadthHistories(N, isin => isin.startsWith('LN'));
  assert.deepEqual(vals(sb.__line.data), closes(h, 'move4d'));
  assert.equal(dom.el('brdChartTitle').textContent, '% Stocks with 4%+ Move (Day) - Lenders');
});

test('chart: smoothing plots the smoothed line', () => {
  const all = reset();
  setupChart();
  dom.el('brdSmooth').checked = true;
  render(all);
  assert.deepEqual(vals(sb.__line.data), closes(sb.bruSmoothHistory(all)));
});

test('chart: changing the universe or the smoothing rebuilds the drawing tools; a plain refresh keeps them', () => {
  const all = reset();
  setupChart();
  render(all);
  const first = run('brdTools');
  render(all);
  assert.equal(run('brdTools'), first);
  dom.el('brdUniverse').value = 'sec:Banks';
  render(all);
  const second = run('brdTools');
  assert.notEqual(second, first);
  dom.el('brdSmooth').checked = true;
  render(all);
  assert.notEqual(run('brdTools'), second);
  dom.el('brdUniverse').value = 'all'; dom.el('brdSmooth').checked = false;
});

test('brdUniverseChanged refreshes the title and the chart', () => {
  const all = reset();
  setupChart();
  render(all);
  dom.el('brdUniverse').value = 'ind:Labs';
  sb.brdUniverseChanged();
  assert.equal(dom.el('brdChartTitle').textContent, '% Stocks Above 20 SMA - Labs');
  assert.equal(sb.__line.data.length, N);
  dom.el('brdUniverse').value = 'all';
});

test('without breadth-universe.js, breadth.js still works: market-wide chart, plain title', () => {
  const lone = loadScripts(['js/breadth.js']);
  const d2 = installFakeDom(lone);
  const rl = code => vm.runInContext(code, lone);
  lone.Store.dates = dates;
  lone.Store.dailyBySymbol = { A: stock('A', 12) };
  lone.Store.latestBySymbol = { A: { isin: 'A' } };
  const fake = makeFakeChart();
  lone.__fake = fake;
  const mk = () => { const s = fakeSeries(fake); return s; };
  lone.__s = [mk(), mk(), mk(), mk(), [0, 1, 2, 3].map(mk)];
  rl('brdChart = __fake.chart; brdCandleSeries = __s[0]; brdLineSeries = __s[1]; brdCountSeries = __s[2]; brdCompareSeries = __s[3]; brdMultiSeries = __s[4]');
  rl("ewToBusinessDay = d => ({ year: 2000, month: 1, day: Number(d.slice(1)) + 1 }); ewFitWithRightPad = () => {}; requestAnimationFrame = fn => fn();");
  rl("_brdHistory = computeBreadthHistories(60); _brdActiveTab = 'above20'");
  // chart-tools is not loaded here: stub the tool box
  rl('ChartTools = function () { this.destroy = () => {}; }');
  rl('brdRenderActiveTab()');
  assert.equal(d2.el('brdChartTitle').textContent, '% Stocks Above 20 SMA');
  assert.equal(d2.el('brdUniverseNote').textContent, 'Universe: all NSE stocks');
  assert.equal(lone.__s[1].data.length, 60);
});

test('guard: breadth.js holds none of the universe feature\'s ids or classification logic (it only calls the bru* hooks, typeof-guarded)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'breadth.js'), 'utf8');
  for (const needle of ["'brdUniverse'", "'brdCompare'", "'brdSmooth'", '.industry', '.sector', 'Undefined-Diversified']) assert.ok(!src.includes(needle), needle);
  const calls = [...src.matchAll(/\b(bru[A-Z]\w*)\(/g)].map(m => m[1]);
  assert.ok(calls.length > 0);
  for (const name of new Set(calls)) assert.ok(src.includes(`typeof ${name} === 'function'`), `${name} must be typeof-guarded`);
});

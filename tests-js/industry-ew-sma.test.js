'use strict';
// Industry Analysis tab, Sort By -> "EW Chart Above SMA" (js/industry.js): lists the industries whose equal-weight index closes above the ticked
// 20 / 50 SMA (default 20, both ticked = both must hold), furthest above the longer SMA first, with an "EW vs N SMA" column per ticked SMA. The
// index and its SMAs come from js/group-trend.js's gtGroupMap (the Stock Scanner's F38 reads the same).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/ew-index.js', 'js/industry.js', 'js/industry-charts.js', 'js/group-trend.js']);
const run = code => vm.runInContext(code, sb);

const MON = ['Jan', 'Feb', 'Mar'];
const DATES = Array.from({ length: 60 }, (_, i) => `${String(1 + (i % 28)).padStart(2, '0')}-${MON[Math.floor(i / 28)]}-2026`);
const bars = closes => closes.map((c, i) => ({ date: DATES[i], open: c, high: c, low: c, close: c, turnover: 10 }));
const range = (from, step, n) => Array.from({ length: n }, (_, i) => from + step * i);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
// UP: above both SMAs. DOWN: below both. DIP: rose 55 days then fell 5 (above its 50 SMA, below its 20). RALLY: fell 55 days then ticked up (below both).
const CLOSES = {
  UP: range(100, 1, 60),
  DOWN: range(200, -1, 60),
  DIP: [...range(100, 2, 55), 205, 200, 195, 190, 185],
  RALLY: [...range(300, -2, 55), 193, 195, 197, 199, 201],
};

const dom = installFakeDom(sb, { industrySort: 'ew_sma', indMinStocks: '1', indMinMcap: '0', moneyFlowPeriod: '1m', mfRocPeriod: '1m', mfRocLag: '1m', ipoPeriod: '3m' });
function render({ s20 = true, s50 = false } = {}) {
  dom.el('industrySort').value = 'ew_sma';
  dom.el('industrySort').selectedOptions = [{ textContent: 'EW Chart Above SMA' }];
  dom.el('ewSma20').checked = s20;
  dom.el('ewSma50').checked = s50;
  const latest = {}, daily = {};
  for (const g in CLOSES) {
    latest[g] = { symbol: g, isin: g, industry: g, sector: 'S', listingDate: '', marketCap: 100, turnover: 10, monthlyChangePct: 1, distFrom52H: 5, distFromSMA: 1, aboveSMA: true };
    daily[g] = bars(CLOSES[g]);
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.Store.dates = DATES.slice();
  run('_gtCache = {}');
  sb.renderIndustryAnalysis();
  return Array.from(run('_chartData'), i => i.name);
}

test('default: only the 20 SMA is ticked and the industries above it are listed, furthest above first', () => {
  const names = render();
  assert.deepEqual(names, ['UP']);            // DIP, RALLY and DOWN are all below their 20 SMA
  assert.equal(dom.el('ewSmaGroup').style.display, '');
});

test('50 SMA only', () => {
  assert.deepEqual(render({ s20: false, s50: true }).sort(), ['DIP', 'UP']);
});

test('both ticked: the industry must be above both', () => {
  assert.deepEqual(render({ s20: true, s50: true }), ['UP']);
});

test('the order is by distance above the longest ticked SMA, and the figures match the raw closes', () => {
  const names = render({ s20: false, s50: true });
  const c = CLOSES.UP, d = CLOSES.DIP;
  const upDist = (c[59] / mean(c.slice(-50)) - 1) * 100, dipDist = (d[59] / mean(d.slice(-50)) - 1) * 100;
  const list = run('_chartData');
  assert.ok(Math.abs(list[0].ewDist50 - (upDist > dipDist ? upDist : dipDist)) < 1e-9);
  assert.equal(names[0], upDist > dipDist ? 'UP' : 'DIP');
});

test('nothing ticked falls back to the 20 SMA (and ticks it)', () => {
  const names = render({ s20: false, s50: false });
  assert.deepEqual(names, ['UP']);
  assert.equal(dom.el('ewSma20').checked, true);
});

test('the table gets an "EW vs N SMA" column per ticked SMA, after Breadth, and the note names the SMAs', () => {
  render({ s20: true, s50: true });
  const cols = Array.from(sb.indBreakdownCols('1M', false, '3M', null, [20, 50]), c => c.label);
  assert.equal(cols[6], 'Breadth');
  assert.deepEqual(cols.slice(7, 9), ['EW vs 20 SMA', 'EW vs 50 SMA']);
  assert.match(dom.el('indMetricNote').textContent, /^Industries with the EW Chart Above 20 and 50 SMA — /);
  assert.match(dom.el('industryBody').innerHTML, /color:var\(--green\);font-weight:600">\+\d/);
  render({ s20: true, s50: false });
  assert.match(dom.el('indMetricNote').textContent, /^Industries with the EW Chart Above 20 SMA — /);
  assert.equal(sb.indBreakdownCols('1M', false, '3M', null).some(c => c.key.startsWith('ewDist')), false);
});

test('the default table sort is the longest ticked SMA column, so the order reads as sorted; other views are untouched', () => {
  render({ s20: true, s50: true });
  assert.equal(run('indDefaultSort()').col, 'ewDist50');
  render({ s20: true, s50: false });
  assert.equal(run('indDefaultSort()').col, 'ewDist20');
  dom.el('industrySort').value = 'stocks';
  dom.el('industrySort').selectedOptions = [{ textContent: 'Stock Count' }];
  sb.renderIndustryAnalysis();
  assert.equal(dom.el('ewSmaGroup').style.display, 'none');
  assert.equal(run('_chartData').length, Object.keys(CLOSES).length);   // no EW filtering outside this view
  assert.equal(run('indDefaultSort()').col, 'stockCount');
});

test('index.html: the option sits last in Sort By and the two ticks (20 checked, 50 not) are in their own hidden group', () => {
  const sel = html.slice(html.indexOf('id="industrySort"')).split('</select>')[0];
  const options = [...sel.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert.equal(options[options.length - 1], 'ew_sma');
  assert.match(html, /id="ewSmaGroup" style="display:none;"/);
  assert.match(html, /id="ewSma20" checked/);
  assert.doesNotMatch(html, /id="ewSma50" checked/);
});

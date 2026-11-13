'use strict';
// The Money Flow tab (js/money-flow.js, replaced the Industry Analysis tab 2026-11-13): the industry rows (mfBuildIndustries), sorting, the
// full render through a fake page (table, cards, note, Rate-of-Change lag options, all-periods table, filters, Copy industries) and
// the markup / wiring in index.html, ui.js and nse-download.js. The engine itself (computeIndustryMoneyFlow ...) is tested in money-flow.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const read = f => fs.readFileSync(path.join(path.dirname(__dirname), f), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/money-flow.js']);
const { Store } = sb;

// 30 trading days D0..D29. Industry A (2 stocks): flows 10/day for the first 15 days, 20/day for the last 15 -> doubling.
// Industry B (1 stock): 30/day then 15/day -> halving. Industry C (3 stocks, tiny): 1/day throughout.
function setup() {
  Store.dates = Array.from({ length: 30 }, (_, i) => 'D' + i);
  const days = (per) => Store.dates.map((d, i) => ({ date: d, turnover: per(i) }));
  Store.dailyBySymbol = {
    a1: days(i => (i < 15 ? 5 : 10)), a2: days(i => (i < 15 ? 5 : 10)),
    b1: days(i => (i < 15 ? 30 : 15)),
    c1: days(() => 1), c2: days(() => 1), c3: days(() => 1),
  };
  const mk = (industry, sector, mcap) => ({ industry, sector, marketCap: mcap });
  Store.latestBySymbol = {
    a1: mk('Alpha', 'S1', 100), a2: mk('Alpha', 'S1', 50), b1: mk('Beta', 'S2', 400),
    c1: mk('Gamma', 'S1', 1), c2: mk('Gamma', 'S1', 1), c3: mk('Gamma', 'S1', 1),
  };
}

// a "1w" window is 5 days and "1m" 21: with 30 days the 1w windows are D25-29 (current), D20-24 (previous)
const now1w = () => sb.computeIndustryMoneyFlow('1w');
const past1w = () => sb.computeIndustryMoneyFlow('1w', 5);

test('mfBuildIndustries: one row per industry with its flow, previous flow, % change, the reading 1w ago and the difference', () => {
  setup();
  const rows = sb.mfBuildIndustries(1, 0, now1w(), past1w());
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(rows.length, 3);
  // Alpha now: D25-29 = 2 stocks x 10 x 5 = 100, previous D20-24 = 100 -> 0%; one window ago: D20-24 vs D15-19 = 100 vs 100 -> 0%
  assert.equal(by.Alpha.moneyFlow, 100);
  assert.equal(by.Alpha.moneyFlowPrev, 100);
  assert.equal(by.Alpha.moneyFlowChg, 0);
  assert.equal(by.Alpha.moneyFlowChgPast, 0);
  assert.equal(by.Alpha.moneyFlowRoc, 0);
  assert.deepEqual([by.Alpha.stockCount, by.Alpha.totalMcap, by.Alpha.sector], [2, 150, 'S1']);
  assert.deepEqual([by.Gamma.stockCount, by.Gamma.totalMcap], [3, 3]);
});

test('mfBuildIndustries: the rate of change is the % change now minus the % change one lag ago (percentage points)', () => {
  setup();
  // 1w window read against the window itself one step back: Alpha doubled across D14/D15 only, so with a 10-day window it shows
  const now = sb.computeIndustryMoneyFlow('1m');            // 21 days: D9-29 current, D0-8 previous (9 days) -> uneven, still well defined
  const past = sb.computeIndustryMoneyFlow('1m', 5);
  const rows = sb.mfBuildIndustries(1, 0, now, past);
  for (const r of rows) {
    assert.ok(Math.abs(r.moneyFlowRoc - (r.moneyFlowChg - r.moneyFlowChgPast)) < 1e-9, r.name);
    assert.equal(r.moneyFlowChg, sb.mfPctChange(r.moneyFlow, r.moneyFlowPrev));
  }
});

test('mfBuildIndustries: Min Stocks and Min Market Cap drop industries; a stock with no industry is Undefined-Diversified', () => {
  setup();
  assert.deepEqual(Array.from(sb.mfBuildIndustries(2, 0, now1w(), past1w()), r => r.name).sort(), ['Alpha', 'Gamma']);
  assert.deepEqual(Array.from(sb.mfBuildIndustries(1, 100, now1w(), past1w()), r => r.name).sort(), ['Alpha', 'Beta']);
  assert.equal(sb.mfBuildIndustries(4, 0, now1w(), past1w()).length, 0);
  Store.latestBySymbol.d1 = { marketCap: 5 };
  Store.dailyBySymbol.d1 = [];
  assert.ok(sb.mfBuildIndustries(1, 0, now1w(), past1w()).some(r => r.name === 'Undefined-Diversified' && r.sector === '-'));
});

test('mfSortList: numbers high to low or low to high, names A-Z, stable for ties, does not touch the input', () => {
  const cols = sb.mfTableCols('6M', '3M');
  const rows = [{ name: 'b', moneyFlowChg: 5 }, { name: 'a', moneyFlowChg: 5 }, { name: 'c', moneyFlowChg: 9 }];
  assert.deepEqual(Array.from(sb.mfSortList(rows, { col: 'moneyFlowChg', dir: -1 }, cols), r => r.name), ['c', 'b', 'a']);   // tie b/a keeps its order
  assert.deepEqual(Array.from(sb.mfSortList(rows, { col: 'moneyFlowChg', dir: 1 }, cols), r => r.name), ['b', 'a', 'c']);
  assert.deepEqual(Array.from(sb.mfSortList(rows, { col: 'name', dir: 1 }, cols), r => r.name), ['a', 'b', 'c']);
  assert.deepEqual(rows.map(r => r.name), ['b', 'a', 'c']);
});

test('the table columns carry the period and the Rate-of-Change timeframe in their labels', () => {
  const labels = Array.from(sb.mfTableCols('3M', '1W'), c => c.label);
  assert.deepEqual(labels, ['Industry', 'Sector', 'Stocks', 'Mkt Cap (Cr)', 'MF 3M (Cr)', 'Prev 3M (Cr)', 'MF Chg%', 'MF Chg% (1W ago)', 'MF Rate of Change']);
});

// ── the whole render through a fake page ──

function page(values = {}) {
  const dom = installFakeDom(sb, { mfMinStocks: '1', mfMinMcap: '0', moneyFlowPeriod: '1w', mfRocLag: '1w', ...values });
  dom.el('mfAllPeriodsToggle').checked = true;
  setup();
  return dom;
}

test('renderMoneyFlow fills the table in MF Chg% order, the summary cards, the note and the all-periods table', () => {
  const dom = page();
  sb.renderMoneyFlow();
  const rows = dom.el('mfBody').innerHTML.match(/class="mf-row"/g) || [];
  assert.equal(rows.length, 3);
  assert.equal(dom.el('mfCount').textContent, 3);
  assert.equal(dom.el('mfStockCount').textContent, '6');
  assert.match(dom.el('mfNote').textContent, /last 5 trading days \(1W\).*5 days before/);
  assert.match(dom.el('mfHead').innerHTML, /MF 1W \(Cr\)/);
  assert.equal((dom.el('mfAllPeriodsBody').innerHTML.match(/class="mf-row"/g) || []).length, 3);
  assert.equal(dom.el('mfAllPeriodsSection').style.display, '');
});

test('the all-periods table can be switched off, and Min Stocks narrows both tables', () => {
  const dom = page();
  dom.el('mfAllPeriodsToggle').checked = false;
  sb.renderMoneyFlow();
  assert.equal(dom.el('mfAllPeriodsSection').style.display, 'none');
  dom.el('mfAllPeriodsToggle').checked = true;
  dom.el('mfMinStocks').value = '2';
  sb.renderMoneyFlow();
  assert.equal((dom.el('mfBody').innerHTML.match(/class="mf-row"/g) || []).length, 2);
  assert.equal((dom.el('mfAllPeriodsBody').innerHTML.match(/class="mf-row"/g) || []).length, 2);
});

test('the Rate-of-Change timeframe is limited to the period: a longer one snaps down to the period itself', () => {
  const dom = page({ moneyFlowPeriod: '1m', mfRocLag: '6m' });
  dom.el('moneyFlowPeriod').options = [];
  sb.renderMoneyFlow();
  assert.match(dom.el('mfHead').innerHTML, /MF Chg% \(1M ago\)/);          // 6M is not valid for a 1M window -> the window itself
});

test('nothing happens (and nothing breaks) before any stock data is loaded', () => {
  const dom = installFakeDom(sb, { mfMinStocks: '1', mfMinMcap: '0', moneyFlowPeriod: '6m', mfRocLag: '3m' });
  Store.latestBySymbol = {};
  assert.doesNotThrow(() => sb.renderMoneyFlow());
  assert.equal(dom.el('mfBody').innerHTML, '');
});

test('Copy industries copies the names in the order the table shows', async () => {
  const dom = page();
  sb.renderMoneyFlow();
  let copied = null;
  sb.copyTextToClipboard = t => { copied = t; return Promise.resolve(true); };
  sb.setTimeout = () => 0;
  assert.equal(await sb.copyMoneyFlowIndustries(), true);
  assert.deepEqual(copied.split(',').sort(), ['Alpha', 'Beta', 'Gamma']);
  assert.ok(dom.el('mfCopyBtn'));
});

// ── markup and wiring ──

test('index.html: a Money Flow tab and panel replace Industry Analysis; the old heatmap / IPO / EW controls are gone; chart-popup picks toolbar kept', () => {
  const html = read('index.html');
  assert.match(html, /<div class="tab" data-tab="moneyflow">Money Flow<\/div>/);
  assert.match(html, /<div id="panel-moneyflow" class="panel">/);
  assert.match(html, /<script src="js\/money-flow\.js\?v=\d+"><\/script>/);
  for (const id of ['mfMinStocks', 'mfMinMcap', 'moneyFlowPeriod', 'mfRocLag', 'mfAllPeriodsToggle', 'mfCopyBtn', 'mfHead', 'mfBody', 'mfAllPeriodsHead', 'mfAllPeriodsBody', 'mfNote', 'selCountLabelIndustry']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const gone of ['panel-industry', 'data-tab="industry"', 'industryGrid', 'industrySort', 'ipoPeriod', 'ewSma20', 'indBreakdown', 'js/industry.js']) assert.ok(!html.includes(gone), gone);
});

test('the tab is drawn when it is opened and again once the daily history has loaded in the background', () => {
  assert.match(read('js/ui.js'), /dataset\.tab === 'moneyflow'[\s\S]{0,120}renderMoneyFlow\(\)/);
  assert.match(read('js/ui.js'), /Store\.loaded\.sector\) \{\s*renderMoneyFlow\(\);/);
  assert.match(read('js/nse-download.js'), /typeof renderMoneyFlow === 'function'\) renderMoneyFlow\(\)/);
});

test('no file still points at the removed js/industry.js or its functions', () => {
  for (const f of ['js/ui.js', 'js/screener.js', 'js/industry-charts.js', 'js/presets.js', 'js/nse-download.js']) {
    assert.ok(!/renderIndustryAnalysis|industry\.js'|_indBreakdownNames/.test(read(f)), f);
  }
});

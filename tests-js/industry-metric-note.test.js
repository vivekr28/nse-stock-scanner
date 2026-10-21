'use strict';
// Industry Analysis: the horizontal bar chart is gone. What its title / tip said about the Sort By metric is now one line above the
// Industry Breakdown table (js/industry.js indMetricText / renderMetricNote), and the table + heatmap are what show the industries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScripts } = require('./load');

const root = path.dirname(__dirname);
const sb = loadScripts(['js/utils.js', 'js/industry.js']);
const text = (...a) => sb.indMetricText(...a);

test('every Sort By option has a title and a tip for the note', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const options = [...html.slice(html.indexOf('id="industrySort"')).split('</select>')[0].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert.ok(options.length >= 9, options.join(','));
  for (const o of options) {
    const t = text(o, '1m', { currentDays: 21, prevDays: 21 }, '1m', null);
    assert.ok(t.title && t.tip, o + ' has a title and a tip');
  }
});

test('the RS note explains the score; an unknown metric falls back to it', () => {
  assert.equal(text('rs_score', '6m', null, '3m', null).title, 'Industry Relative Strength');
  assert.match(text('rs_score', '6m', null, '3m', null).tip, /breadth \(40%\).*52-week high/);
  assert.equal(text('nonsense', '6m', null, '3m', null).title, 'Industry Relative Strength');
});

test('money flow notes carry the period, the trading days compared and (rate of change) the timeframe it is read against', () => {
  const mf = text('money_flow', '1m', { currentDays: 21, prevDays: 21 }, '1m', null);
  assert.equal(mf.title, 'Money Flow Change — Last 1 Month (21 vs 21 trading days)');
  const roc = text('money_flow_roc', '6m', { currentDays: 126, prevDays: 120 }, '3m', null);
  assert.equal(roc.title, 'Money Flow Rate of Change — Last 6 Months (126 vs 120 trading days), vs 3M ago');
});

test('the IPO note names the dates, the bulk days left out and the real IPOs kept anyway', () => {
  const info = {
    period: '3m', from: '2026-07-20', to: '2026-10-20',
    bulkDays: [{ date: '2026-08-17', count: 136, kept: ['MOLBIO', 'DHOOTTRANS'] }],
  };
  const t = text('ipo', '1m', null, '1m', info);
  assert.equal(t.title, 'IPOs Listed by Industry — Last 3 Months (20-Jul-2026 to 20-Oct-2026)');
  assert.match(t.tip, /17-Aug-2026 \(134 of 136 stocks\)/);
  assert.match(t.tip, /Counted anyway because they traded like IPOs on day one \(turnover of Rs 100 Cr or more\): MOLBIO, DHOOTTRANS\./);
  assert.doesNotMatch(t.tip, /Only industries with at least one listing are charted/, 'there is no chart any more');
});

test('the bar chart is gone: no canvas, no section, no drawing / hover code - and the table, heatmap and note are still there', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'js/industry.js'), 'utf8');
  assert.doesNotMatch(html, /rsChart|industryChartTitle|industryChartTip/);
  assert.doesNotMatch(js, /renderMetricChart|rsChart|_chartBars|indChartTooltip|getContext\('2d'\)/);
  for (const id of ['indMetricNote', 'industryTable', 'industryGrid', 'mfAllPeriodsSection']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.equal(typeof sb.renderIndustryBreakdownTable, 'function');
  assert.equal(typeof sb.renderMetricNote, 'function');
});

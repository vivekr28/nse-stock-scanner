'use strict';
// Data Quality > Price Adjustments Applied: the "Correct N major differences from TradingView" button (js/data-quality.js,
// server side in src/nse_server.py plan_verification_corrections / run_tv_apply): the confirmation text, the button's
// visibility and label, and that the page is wired to the three endpoints.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadScripts } = require('./load');
const vm = require('node:vm');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/data-quality.js']);

const PLAN = {
  stocks: [
    { symbol: 'CCAVENUE', corrections: [
      { exDate: '26-Jun-2025', factor: 0.913062, kind: 'adjustments-differ' },
      { exDate: '19-Oct-2026', factor: 10, kind: 'tv-extra-adjustment' }] },
    { symbol: 'LEMERITE', corrections: [{ exDate: '29-May-2026', factor: 5, kind: 'tv-no-adjustment' }] },
  ],
  skipped: [{ symbol: 'XYZ', reason: 'no single-date cause was found' }],
};

test('the confirmation lists every stock, each dated factor with what it means, and what is left out', () => {
  const t = sb.dqTvFixSummary(PLAN);
  assert.match(t, /^Correct 2 stocks from TradingView\?/);
  assert.match(t, /CCAVENUE: ×0\.91306 before 26-Jun-2025 \(our adjustment differs\); ×10 before 19-Oct-2026 \(TradingView adjusts, we have no event\)/);
  assert.match(t, /LEMERITE: ×5 before 29-May-2026 \(TradingView doesn't adjust - undoes ours\)/);
  assert.match(t, /Not corrected \(1\): XYZ — no single-date cause was found/);
  assert.match(t, /Verify again afterwards to confirm\.$/);
});

test('one stock reads in the singular and no "Not corrected" part appears without skips', () => {
  const t = sb.dqTvFixSummary({ stocks: [PLAN.stocks[1]], skipped: [] });
  assert.match(t, /^Correct 1 stock from TradingView\?/);
  assert.doesNotMatch(t, /Not corrected/);
});

test('the button shows only while a stock is graded major, and says how many', () => {
  const dom = installFakeDom(sb, {});
  dom.el('dqAdjustedTable').querySelector = () => ({ innerHTML: '' });   // the table's head / body
  const isin = 'INE1';
  sb.Store.adjustedCorpActions = [{ isin, symbol: 'AAA', exDate: '10-Jan-2026', kind: 'split-bonus', detail: 'x', factor: 0.5 }];
  const verify = status => {
    sb.__last = { verifiedAt: 'now', complete: true, calendar: {}, stocks: { [isin]: { status, events: [['10-Jan-2026', 0.5]], causes: [], note: '' } } };
    vm.runInContext('_dqVerify.last = __last', sb);   // top-level let: reachable only from inside the sandbox
  };
  verify('major');
  sb.dqRenderAdjusted();
  assert.equal(dom.el('dqTvFixRow').style.display, 'flex');
  assert.equal(dom.el('dqTvFixBtn').textContent, 'Correct 1 major difference from TradingView');
  verify('match');
  sb.dqRenderAdjusted();
  assert.equal(dom.el('dqTvFixRow').style.display, 'none');
});

test('wiring: the button and status are in the Price Adjustments Applied section; the three endpoints are the ones the server has', () => {
  const html = read('index.html'), js = read('js/data-quality.js'), server = read('src/nse_server.py');
  const body = html.slice(html.indexOf('id="dqAdjustedBody"'), html.indexOf('id="dqNoSectorBody"') > 0 ? html.length : undefined);
  assert.ok(body.indexOf('id="dqTvFixBtn"') > body.indexOf('id="dqTvVerifyBtn"'));
  assert.match(html, /onclick="dqRunTvFix\(\)"/);
  for (const ep of ['/api/tv-apply/preview', '/api/tv-apply/start', '/api/tv-apply/status']) {
    assert.ok(js.includes(ep), ep + ' is called by the page');
    assert.ok(server.includes(`'${ep}'`), ep + ' is served');
  }
  assert.match(js, /'X-Requested-With': 'nse-dashboard'/);
});

test('it is only offered on the Price Adjustments Applied tab - the Full Price Verification section has no such button', () => {
  const html = read('index.html');
  const full = html.slice(html.indexOf('id="dqFullBtn"') - 600, html.indexOf('id="dqFullBtn"') + 3000);
  assert.ok(!full.includes('dqTvFix'));
});

'use strict';
// Reset All and the As of Date tab's own reset are the same thing: every filter on every tab (including this one) goes
// back to its default, the preset is deselected and the results are refreshed (the as-of results disappear).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const html = fs.readFileSync(path.join(path.dirname(__dirname), 'index.html'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js', 'js/asof-scan.js']);

function setup() {
  const dom = installFakeDom(sb, { scrF17Period: '3m', scrF17Lag: '3m' });
  sb.document.querySelectorAll = () => [];
  sb.Store.dates = ['01-Jan-2025', '02-Jan-2025'];
  const calls = [];
  sb.runScreener = () => calls.push('runScreener');
  return { dom, calls };
}

test('the As of Date tab\'s button is the same as Reset All (it calls resetScreener)', () => {
  const pane = html.slice(html.indexOf('id="scrPaneAsOf"'), html.indexOf('end screenerFiltersBody'));
  assert.match(pane, /onclick="resetScreener\(\)"[^>]*>Reset All</);
  assert.ok(!/onclick="asOfReset\(\)"/.test(pane), 'the tab must not have its own separate reset');
});

test('Reset All also resets the As of Date tab: controls, date, dates and the filter count', () => {
  const { dom } = setup();
  for (const id of ['asofAOn', 'asofBOn', 'asofJOn', 'asofKOn']) dom.el(id).checked = true;
  dom.el('asofBVal').value = '9'; dom.el('asofJ5').checked = false; dom.el('asofKFromDate').value = '2025-01-01'; dom.el('asofDate').value = '2025-01-02';
  sb.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 4);

  sb.resetScreener();

  for (const id of ['asofAOn', 'asofBOn', 'asofJOn', 'asofKOn']) assert.equal(dom.el(id).checked, false);
  assert.equal(dom.el('asofBVal').value, '2');
  assert.equal(dom.el('asofJ5').checked, true);
  assert.equal(dom.el('asofKFromDate').value, '');
  assert.equal(dom.el('scrActiveFilterBadge').style.display, 'none');
  assert.equal(dom.el('scrTabAsOfCount').style.display, 'none');
});

test('Reset All deselects the preset and re-runs the normal scan, so as-of results are replaced', () => {
  const { dom, calls } = setup();
  dom.el('scrPresetSelect').value = 'AsOf-02Apr2026';
  dom.el('asofAOn').checked = true;
  vm.runInContext("screenerPassed = ['as-of result']", sb);
  sb.resetScreener();
  assert.equal(dom.el('scrPresetSelect').value, '');
  assert.deepEqual(calls, ['runScreener']);       // the same refresh Reset All always did
});

test('the other tabs\' filters are reset as before (regression)', () => {
  const { dom } = setup();
  dom.el('scrF1On').checked = true; dom.el('scrF9On').checked = true; dom.el('scrF2Len').value = '99';
  sb.resetScreener();
  assert.equal(dom.el('scrF1On').checked, false);
  assert.equal(dom.el('scrF9On').checked, false);
  assert.equal(dom.el('scrF2Len').value, '50');
});

test('without the As of Date module loaded, Reset All behaves exactly as before (regression)', () => {
  const plain = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js']);
  const dom = installFakeDom(plain, { scrF17Period: '3m', scrF17Lag: '3m' });
  plain.document.querySelectorAll = () => [];
  plain.Store.dates = ['01-Jan-2025'];
  let ran = 0; plain.runScreener = () => { ran++; };
  dom.el('scrF3On').checked = true;
  plain.resetScreener();
  assert.equal(dom.el('scrF3On').checked, false);
  assert.equal(ran, 1);
});

'use strict';
// The count of switched-on As of Date filters is shown on the tab and added to the main Filters button's badge,
// next to the other tabs' counts (js/screener.js updateFilterBadge() + js/asof-scan.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const BASE = ['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js'];
const sb = loadScripts([...BASE, 'js/asof-scan.js']);

function fresh() {
  const dom = installFakeDom(sb, {});
  sb.document.querySelectorAll = () => [];
  return dom;
}

test('asOfActiveCount counts the switched-on As of Date filters', () => {
  const dom = fresh();
  assert.equal(sb.asOfActiveCount(), 0);
  dom.el('asofAOn').checked = true; dom.el('asofKOn').checked = true; dom.el('asofJOn').checked = true;
  assert.equal(sb.asOfActiveCount(), 3);
  // sub-options (e.g. which SMAs) are not filters
  dom.el('asofA50').checked = true; dom.el('asofJ5').checked = true;
  assert.equal(sb.asOfActiveCount(), 3);
});

test('the tab badge shows the count, and is hidden at zero', () => {
  const dom = fresh();
  sb.asOfUpdateBadge();
  assert.equal(dom.el('scrTabAsOfCount').style.display, 'none');
  dom.el('asofBOn').checked = true; dom.el('asofCOn').checked = true;
  sb.asOfUpdateBadge();
  assert.equal(dom.el('scrTabAsOfCount').textContent, 2);
  assert.equal(dom.el('scrTabAsOfCount').style.display, 'inline-block');
});

test('the main Filters button badge adds the As of Date count to the other tabs\' counts', () => {
  const dom = fresh();
  dom.el('scrF1On').checked = true;       // Technicals
  dom.el('scrF9On').checked = true;       // Sector & Industry
  dom.el('asofAOn').checked = true; dom.el('asofIOn').checked = true;
  sb.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 4);
  assert.equal(dom.el('scrActiveFilterBadge').style.display, '');
  assert.equal(dom.el('scrTabTechCount').textContent, 1);       // the other tabs' own counts are unchanged
  assert.equal(dom.el('scrTabIndCount').textContent, 1);
  assert.equal(dom.el('scrTabAsOfCount').textContent, 2);
});

test('only As of Date filters on: the main badge shows them; none on anywhere: it is hidden', () => {
  const dom = fresh();
  dom.el('asofKOn').checked = true;
  sb.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 1);
  assert.equal(dom.el('scrActiveFilterBadge').style.display, '');
  dom.el('asofKOn').checked = false;
  sb.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').style.display, 'none');
});

test('Reset on the tab clears the count on both badges', () => {
  const dom = fresh();
  sb.Store.dates = ['01-Jan-2025', '02-Jan-2025'];
  dom.el('asofAOn').checked = true; dom.el('asofBOn').checked = true;
  sb.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 2);
  sb.asOfReset();
  assert.equal(dom.el('scrActiveFilterBadge').style.display, 'none');
  assert.equal(dom.el('scrTabAsOfCount').style.display, 'none');
});

test('loading a preset with As of Date filters on shows the count (loadPreset ends in updateFilterBadge)', () => {
  const dom = fresh();
  sb.applyPresetState({ asofAOn: true, asofCOn: true, asofDate: '2026-04-02' });
  sb.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 2);
});

test('without the As of Date module loaded, the main badge is exactly what it was (regression)', () => {
  const plain = loadScripts(BASE);
  const dom = installFakeDom(plain, {});
  plain.document.querySelectorAll = () => [];
  dom.el('scrF1On').checked = true; dom.el('scrF2On').checked = true; dom.el('scrF9On').checked = true;
  plain.updateFilterBadge();
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 3);
  assert.equal(dom.el('scrTabTechCount').textContent, 2);
  assert.equal(dom.el('scrTabIndCount').textContent, 1);
});

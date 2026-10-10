'use strict';
// The chart popup's header controls (index.html + js/industry-charts.js):
//   - the 10 / 20 / 50 SMA and Purple Dots checkboxes sit in an "Indicators" dropdown (open / close / count badge /
//     Escape / click away)
//   - ADR / Avg MF are on the same line as the name (single-stock title) / the checkbox (grid cell), not below it
//   - the page buttons are just < and > (with a tooltip and aria-label), no "Prev" / "Next" text
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/chart-tools.js', 'js/industry-charts.js']);

// A fresh fake page for each test: menu hidden (as in index.html), SMA 20 ticked, Purple Dots off unless asked.
function page({ checked = ['icSMA20'] } = {}) {
  const dom = installFakeDom(sb);
  const menu = dom.el('icIndicatorsMenu');
  menu.style.display = 'none';
  const btn = dom.el('icIndicatorsBtn');
  const attrs = {};
  btn.setAttribute = (k, v) => { attrs[k] = v; };
  for (const id of ['icSMA10', 'icSMA20', 'icSMA50', 'icShowMFDots']) dom.el(id).checked = checked.includes(id);
  return { dom, menu, btn, attrs, count: dom.el('icIndicatorsCount') };
}

const clickInside = { target: { closest: sel => (sel === '#icIndicatorsDd' ? {} : null) } };
const clickOutside = { target: { closest: () => null } };

// --- the dropdown ---------------------------------------------------------------------------------------

test('the button toggles the menu and keeps aria-expanded in step', () => {
  const { menu, attrs } = page();
  let stopped = 0;
  sb.icToggleIndicators({ stopPropagation: () => { stopped++; } });
  assert.equal(menu.style.display, '');
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(sb.icIndicatorsOpen(), true);
  sb.icToggleIndicators({ stopPropagation: () => { stopped++; } });
  assert.equal(menu.style.display, 'none');
  assert.equal(attrs['aria-expanded'], 'false');
  assert.equal(stopped, 2);                                  // the click must not reach the click-away handler
});

test('clicking inside the open menu keeps it open; clicking anywhere else closes it', () => {
  const { menu } = page();
  sb.icSetIndicatorsOpen(true);
  sb.icOnDocumentClickIndicators(clickInside);               // ticking a checkbox
  assert.equal(menu.style.display, '');
  sb.icOnDocumentClickIndicators(clickOutside);
  assert.equal(menu.style.display, 'none');
});

test('a click elsewhere with the menu already closed does nothing (and does not throw)', () => {
  const { menu } = page();
  assert.doesNotThrow(() => sb.icOnDocumentClickIndicators(clickOutside));
  assert.doesNotThrow(() => sb.icOnDocumentClickIndicators({}));
  assert.equal(menu.style.display, 'none');
});

test('Escape closes an open menu first (and reports it, so the popup stays open); closed -> not handled', () => {
  const { menu } = page();
  assert.equal(sb.icDismissIndicatorsMenu(), false);         // nothing open: Escape goes on to close the popup
  sb.icSetIndicatorsOpen(true);
  assert.equal(sb.icDismissIndicatorsMenu(), true);
  assert.equal(menu.style.display, 'none');
  assert.equal(sb.icDismissIndicatorsMenu(), false);
});

test('the badge counts the ticked indicators and is empty when none are', () => {
  const p = page({ checked: ['icSMA20'] });
  sb.icUpdateIndicatorsCount();
  assert.equal(p.count.textContent, '1');
  p.dom.el('icSMA10').checked = true;
  p.dom.el('icSMA50').checked = true;
  sb.icUpdateIndicatorsCount();
  assert.equal(p.count.textContent, '3');
  p.dom.el('icShowMFDots').checked = true;                    // Purple Dots counts as an indicator too
  sb.icUpdateIndicatorsCount();
  assert.equal(p.count.textContent, '4');
  for (const id of ['icSMA10', 'icSMA20', 'icSMA50', 'icShowMFDots']) p.dom.el(id).checked = false;
  sb.icUpdateIndicatorsCount();
  assert.equal(p.count.textContent, '');
});

// --- index.html -----------------------------------------------------------------------------------------

// The Indicators dropdown block: from its wrapper to the next header control (% Change).
const dropdown = html.slice(html.indexOf('id="icIndicatorsDd"'), html.indexOf('id="icPctMode"'));

test('SMAs and Purple Dots live inside the Indicators menu, keep their ids and defaults', () => {
  const menu = dropdown.slice(dropdown.indexOf('id="icIndicatorsMenu"'));
  assert.ok(menu.length > 100, 'menu not found');
  assert.match(menu, /<input type="checkbox" id="icSMA10"> 10 SMA/);
  assert.match(menu, /<input type="checkbox" id="icSMA20" checked> 20 SMA/);        // 20 SMA on by default
  assert.match(menu, /<input type="checkbox" id="icSMA50"> 50 SMA/);
  assert.match(menu, /<input type="checkbox" id="icShowMFDots" checked> Purple Dots/); // Purple Dots on by default
  assert.match(menu, /title="Purple dot below the candle's low/);                    // its explanation survived the move
  assert.match(dropdown, /id="icIndicatorsMenu" style="display:none;"/);              // closed until the button is clicked
  // each of them appears exactly once - not also left in the header row
  for (const id of ['icSMA10', 'icSMA20', 'icSMA50', 'icShowMFDots']) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
});

test('the dropdown button is wired and labelled "Indicators"', () => {
  assert.match(html, /<button type="button" class="btn btn-secondary ic-dd-btn" id="icIndicatorsBtn" onclick="icToggleIndicators\(event\)"[^>]*>Indicators /);
  assert.match(html, /id="icIndicatorsCount"/);
});

test('the other header toggles stay in the header (% Change, ADR, Avg MF)', () => {
  for (const id of ['icPctMode', 'icShowADR', 'icShowAvgMF']) {
    assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(!dropdown.includes(`id="${id}"`), `${id} should not be in the dropdown`);
  }
});

// --- ADR / Avg MF on the name line ------------------------------------------------------------------------

test('single-stock title: ADR / Avg MF are a span on the same line, right after the industry name', () => {
  const line = html.slice(html.indexOf('<div class="ic-title-line1">'), html.indexOf('<div class="ic-header-controls">'));
  assert.ok(line.indexOf('id="icTitle"') > 0 && line.indexOf('id="icSingleStats"') > line.indexOf('id="icTitle"'),
    'icSingleStats must come after icTitle inside the same line');
  assert.match(line, /<span id="icSingleStats" class="ic-cell-line2"/);
  // ... and the old second-line block is gone
  assert.doesNotMatch(html, /<div id="icSingleStats"/);
});

test('grid cell: ADR / Avg MF share the checkbox line (between the checkbox and the market cap), no second line', () => {
  const js = fs.readFileSync(path.join(root, 'js', 'industry-charts.js'), 'utf8');
  const cell = js.slice(js.indexOf('<div class="ic-cell-header">'), js.indexOf('<div class="ic-cell-chart"'));
  const line1 = cell.slice(cell.indexOf('<div class="ic-cell-line1">'));
  const iCb = line1.indexOf('ic-cell-select'), iStats = line1.indexOf('ic-cell-stats'), iMcap = line1.indexOf('ic-cell-mcap');
  assert.ok(iCb >= 0 && iStats > iCb && iMcap > iStats, `order checkbox ${iCb} < stats ${iStats} < mcap ${iMcap}`);
  assert.doesNotMatch(cell, /<div class="ic-cell-line2">/);
  assert.match(cell, /\$\{statsLine\}/);
});

test('the page buttons are just < and > - no Prev / Next text - with a tooltip and aria-label', () => {
  const wanted = [
    ['icPrevBtn', '&lt;', 'Previous page'], ['icNextBtn', '&gt;', 'Next page'],
    ['icSinglePrevBtn', '&lt;', 'Previous stock'], ['icSingleNextBtn', '&gt;', 'Next stock'],
  ];
  for (const [id, glyph, label] of wanted) {
    const m = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([^<]*)</button>`));
    assert.ok(m, `${id} not found`);
    assert.equal(m[1], glyph, `${id} text`);
    assert.match(m[0], new RegExp(`aria-label="${label}"`));
    assert.match(m[0], new RegExp(`title="${label} \\((Up|Down) arrow\\)"`));
  }
  assert.doesNotMatch(html, />\s*&lt; Prev\s*</);
  assert.doesNotMatch(html, />\s*Next &gt;\s*</);
});

test('the buttons still call the same handlers and are disabled at the ends (ids unchanged)', () => {
  assert.match(html, /id="icPrevBtn" onclick="icPrevPage\(\)"/);
  assert.match(html, /id="icNextBtn" onclick="icNextPage\(\)"/);
  assert.match(html, /id="icSinglePrevBtn" onclick="icPrevStock\(\)"/);
  assert.match(html, /id="icSingleNextBtn" onclick="icNextStock\(\)"/);
  const js = fs.readFileSync(path.join(root, 'js', 'industry-charts.js'), 'utf8');
  assert.match(js, /getElementById\('icPrevBtn'\)\.disabled = icPage === 0/);
  assert.match(js, /getElementById\('icSingleNextBtn'\)\.disabled = icSingleIndex >= icTotalSingle\(\) - 1/);
});

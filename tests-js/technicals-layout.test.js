'use strict';
// Stock Scanner popup, Technicals tab layout: two columns of filters, with the Day Chg / Turnover co-occurrence card (F4)
// below them spanning both, as a single row. The grid is plain CSS, so these tests read index.html and css/styles.css: the card must be a direct
// child of the grid (not inside either column) and come after both, and the stylesheet must make it span every column.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.dirname(__dirname);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

// the direct children of the Technicals pane's .scr-filters-list, as [{ cls, html }] in order
function gridChildren() {
  const paneAt = html.indexOf('id="scrPaneTechnicals"');
  const listAt = html.indexOf('<div class="scr-filters-list">', paneAt);
  let depth = 0, i = listAt;
  const kids = [];
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = listAt;
  let m, kidStart = -1, kidCls = '';
  while ((m = re.exec(html))) {
    if (m[0] === '</div>') {
      depth--;
      if (depth === 1) kids.push({ cls: kidCls, html: html.slice(kidStart, m.index + 6) });
      if (depth === 0) break;
    } else {
      depth++;
      if (depth === 2) { kidStart = m.index; kidCls = (m[0].match(/class="([^"]*)"/) || [, ''])[1]; }
    }
  }
  return kids;
}

test('the Technicals grid holds two columns and then the F4 card, as a direct child of the grid', () => {
  const kids = gridChildren();
  assert.deepEqual(kids.map(k => k.cls), ['scr-tech-col', 'scr-tech-col', 'scr-filter-pair']);
  const [left, right, pair] = kids;
  for (const id of ['scrF4On', 'scrF4Val', 'scrF4Mult', 'scrF4SmaLen', 'scrF4MinTimes', 'scrF4Lookback']) {
    assert.ok(pair.html.includes(`id="${id}"`), `${id} is in the F4 card`);
    assert.ok(!left.html.includes(`id="${id}"`) && !right.html.includes(`id="${id}"`), `${id} is not in a column`);
  }
});

test('the F4 card is one row: every control (incl. the "at least N times in the last M days" part) is in the same filter row, with no sub row', () => {
  const pair = gridChildren()[2].html;
  assert.equal((pair.match(/class="scr-filter-row[ "]/g) || []).length, 1, 'one filter row');
  assert.ok(!/scr-sub/.test(pair), 'no second (sub) row');
  const row = pair.slice(pair.indexOf('class="scr-filter-row'));
  for (const id of ['scrF4On', 'scrF4Val', 'scrF4Mult', 'scrF4SmaLen', 'scrF4MinTimes', 'scrF4Lookback']) assert.ok(row.includes(`id="${id}"`), id);
  assert.ok(/time\(s\) in last/.test(row) && /trading days/.test(row));
});

test('the two columns hold the other Technicals filters, five each (F15 and F16 now live on Relative Strength)', () => {
  const [left, right] = gridChildren();
  const ids = h => [...h.html.matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);
  assert.deepEqual(ids(left), ['scrF10On', 'scrF2On', 'scrF5On', 'scrF18On', 'scrF8On']);
  assert.deepEqual(ids(right), ['scrF1On', 'scrF3On', 'scrF6On', 'scrF7On', 'scrF19On']);
});

test('the stylesheet makes the F4 card span every column of the Technicals grid', () => {
  assert.ok(/#scrPaneTechnicals\s+\.scr-filter-pair\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(css));
  assert.ok(/#scrPaneTechnicals\s+\.scr-filters-list\s*\{[^}]*display:\s*grid/.test(css), 'the pane is still a grid');
});

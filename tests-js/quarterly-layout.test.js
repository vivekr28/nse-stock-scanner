'use strict';
// Stock Scanner popup, Quarterly Results tab layout: two columns under a status line - the filters that compare with the same quarter a
// year earlier on the left, the ones that compare with the previous quarter on the right, each column under a small heading. The grid is
// plain CSS, so these tests read index.html and css/styles.css.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.dirname(__dirname);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

// the direct <div> children of the Quarterly Results pane's .scr-filters-list, as [{ cls, html }] in order
function gridChildren() {
  const paneAt = html.indexOf('id="scrPaneQuarterly"');
  const listAt = html.indexOf('<div class="scr-filters-list">', paneAt);
  let depth = 0;
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
  return { kids, listAt };
}
const ids = h => [...h.html.matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);

test('the pane is a status line over two columns', () => {
  const { kids, listAt } = gridChildren();
  assert.deepEqual(kids.map(k => k.cls), ['scr-filter-row scr-qtr-latest', 'scr-qtr-col', 'scr-qtr-col']);   // F40's full-width row, then the two columns
  const statusAt = html.indexOf('id="scrQtrStatus"', listAt), latestAt = html.indexOf('id="scrF40On"', listAt);
  assert.ok(statusAt > listAt && statusAt < latestAt && latestAt < html.indexOf('<div class="scr-qtr-col">', listAt), 'the status line and F40 come first, outside the columns');
});

test('left: filters against the same quarter a year earlier; right: against the previous quarter - each with a heading', () => {
  const [left, right] = gridChildren().kids.slice(1);   // [0] is the full-width F40 row
  assert.match(left.html, /<div class="scr-col-head">Against the same quarter a year earlier<\/div>/);
  assert.match(right.html, /<div class="scr-col-head">Against the previous quarter/);
  assert.deepEqual(ids(left), ['scrF20On', 'scrF21On', 'scrF22On', 'scrF23On']);   // growth, then the turnarounds
  assert.deepEqual(ids(right), ['scrF28On', 'scrF29On', 'scrF32On', 'scrF33On']);   // YoY% change, then the turnarounds
});

test('every control of every filter is inside its own column (nothing was lost in the move)', () => {
  const [left, right] = gridChildren().kids.slice(1);   // [0] is the full-width F40 row
  for (const id of ['scrF20Val', 'scrF21Val']) assert.ok(left.html.includes(`id="${id}"`), id);
  for (const id of ['scrF28Val', 'scrF29Val']) assert.ok(right.html.includes(`id="${id}"`), id);
  const all = [...html.slice(html.indexOf('id="scrPaneQuarterly"'), html.indexOf('id="scrPaneMulti"')).matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);
  assert.equal(all.length, 9);
});

test('the stylesheet makes the pane a two-column grid with the status line spanning both, like the Technicals tab', () => {
  assert.ok(/#scrPaneQuarterly\s+\.scr-filters-list\s*\{[^}]*display:\s*grid[^}]*repeat\(auto-fit,\s*minmax\(600px/.test(css));
  assert.ok(/#scrPaneQuarterly\s+#scrQtrStatus,\s*#scrPaneQuarterly\s+\.scr-qtr-latest\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(css));
  assert.ok(/\.scr-qtr-col\s*\{[^}]*flex-direction:\s*column/.test(css));
  assert.ok(/\.scr-col-head\s*\{/.test(css));
});

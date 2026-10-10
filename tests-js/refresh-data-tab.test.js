'use strict';
// js/data-quality.js, "Refresh Data" tab: the wording that tells the user whether a Reprocess is needed after the
// sector mapping was rebuilt, the mapping summary block, and the hand-off to pages/reprocess.html that brings the
// dashboard back to this tab. Pure functions only - the polling/fetch code is covered by driving the real page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/utils.js', 'js/data-quality.js']);

test('a rebuild that changed nothing says reprocessing is optional', () => {
  const info = sb.dqSectorReprocessInfo({ added: 0, changed: 0, removed: 0 }, false);
  assert.equal(info.action, false);
  assert.match(info.text, /no classification changes/);
  assert.match(info.text, /optional/);
});

test('a rebuild with changes asks for a reprocess and counts what changed', () => {
  const info = sb.dqSectorReprocessInfo({ added: 1, changed: 12, removed: 0 }, false);
  assert.equal(info.action, true);
  assert.match(info.text, /1 stock newly classified, 12 changed sector\/industry/);
  assert.match(info.text, /Reprocess Data/);
  assert.doesNotMatch(info.text, /lost their classification/);
});

test('a stopped rebuild is described as partly updated; removals are reported', () => {
  const info = sb.dqSectorReprocessInfo({ added: 5, changed: 0, removed: 2 }, true);
  assert.match(info.text, /^Sector mapping partly updated: 5 stocks newly classified, 2 lost their classification\./);
});

test('without a run result (page reloaded / server restarted) it still says the file is newer than the data', () => {
  const info = sb.dqSectorReprocessInfo(null, false);
  assert.equal(info.action, true);
  assert.match(info.text, /newer than the processed data/);
});

test('summary block shows counts, the advice and its colour', () => {
  const due = sb.dqSectorSummaryHtml({
    exists: true, stocks: 2400, classified: 2380, unclassified: 20, updatedAt: 1760000000,
    advice: { level: 'due', text: 'A refresh is due: 3 newly listed stocks are not in the mapping yet.' } });
  assert.match(due, /<b>2400<\/b> stocks in the mapping/);
  assert.match(due, /2380 classified/);
  assert.match(due, /20 without a classification/);
  assert.match(due, /color:var\(--orange\)[^>]*>A refresh is due/);

  const ok = sb.dqSectorSummaryHtml({ exists: true, stocks: 10, classified: 10, unclassified: 0,
    advice: { level: 'ok', text: 'Up to date - last rebuilt today.' } });
  assert.match(ok, /color:var\(--green\)/);
  assert.doesNotMatch(ok, /without a classification/);
});

test('summary escapes advice text and handles a missing mapping file', () => {
  const html = sb.dqSectorSummaryHtml({ exists: false, advice: { level: 'due', text: '<b>no file</b>' } });
  assert.match(html, /&lt;b&gt;no file&lt;\/b&gt;/);
  assert.equal(sb.dqSectorSummaryHtml(null), '');
});

test('Refresh / Reprocess leave a note so the dashboard returns to the Refresh Data tab', () => {
  const stored = {};
  sb.sessionStorage = { setItem: (k, v) => { stored[k] = v; } };
  sb.location = { href: '' };
  sb.dqGoReprocess(true);
  assert.deepEqual(stored, { nseReopenTab: 'dataquality', nseReopenDqTab: 'dqRefresh' });
  assert.equal(sb.location.href, 'pages/reprocess.html?refresh=1');
  sb.dqGoReprocess(false);
  assert.equal(sb.location.href, 'pages/reprocess.html');
});

'use strict';
// The pages around the Refresh Data tab, checked as shipped: index.html (header buttons gone, the tab and every element
// id the tab's script touches present), ui.js's return-to-tab hand-off, and pages/reprocess.html's behaviour when the
// server refuses to start (e.g. the sector mapping is being rebuilt).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const ROOT = path.dirname(__dirname);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- index.html --------------------------------------------------------------------------------------

test('the header no longer carries Refresh Data / Reprocess Data; Data Files stays', () => {
  const html = read('index.html');
  const header = html.slice(html.indexOf('<div class="header">'), html.indexOf('<!-- Loading progress'));
  assert.doesNotMatch(header, /reprocess\.html/);
  assert.doesNotMatch(header, />Refresh Data</);
  assert.doesNotMatch(header, />Reprocess Data</);
  assert.match(header, /openDataFiles\(\)/);
});

test('Data Quality has a Refresh Data sub-tab wired to its body', () => {
  const html = read('index.html');
  assert.match(html, /<button class="dq-tab" data-tab="dqRefresh" onclick="dqSwitchTab\('dqRefresh'\)">Refresh Data/);
  assert.match(html, /<div class="card dq-section-body" id="dqRefreshBody" style="display:none;">/);
  // dqSwitchTab() toggles `<tab id>Body`, so the pair must line up for every sub-tab
  const tabs = [...html.matchAll(/class="dq-tab[^"]*" data-tab="(\w+)"/g)].map(m => m[1]);
  for (const id of tabs) assert.ok(html.includes(`id="${id}Body"`), `${id}Body missing`);
});

test('the tab holds both buttons wired to dqGoReprocess, and the sector controls', () => {
  const html = read('index.html');
  assert.match(html, /id="dqRefreshBtn"[^>]*onclick="dqGoReprocess\(true\)"/);
  assert.match(html, /id="dqReprocessBtn"[^>]*onclick="dqGoReprocess\(false\)"/);
  assert.match(html, /id="dqSectorBtn"[^>]*onclick="dqRunSectorMapping\(\)"/);
  assert.match(html, /id="dqSectorStopBtn"[^>]*onclick="dqStopSectorMapping\(\)"/);
  assert.match(html, /id="dqSectorReprocess"[\s\S]*?onclick="dqGoReprocess\(false\)"/);
});

test('every element id the Refresh Data script touches exists in index.html', () => {
  const html = read('index.html');
  const js = read('js/data-quality.js');
  const section = js.slice(js.indexOf('REFRESH DATA  —'));
  assert.ok(section.length > 500, 'section not found');
  const ids = new Set([
    ...[...section.matchAll(/getElementById\('(dq\w+|dqRefresh\w+)'\)/g)].map(m => m[1]),
    ...[...section.matchAll(/set\('(dq\w+)'/g)].map(m => m[1]),
  ]);
  assert.ok(ids.size >= 12, `only found ${ids.size} ids`);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
});

// --- ui.js: coming back to the tab ---------------------------------------------------------------------

function reopenPage(items) {
  const sb = loadScripts(['js/ui.js']);
  const store = { ...items };
  const clicked = [], switched = [];
  sb.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  sb.document.querySelector = (sel) => ({ click: () => clicked.push(sel) });
  sb.dqSwitchTab = (id) => switched.push(id);
  return { sb, store, clicked, switched };
}

test('Refresh Data round trip: reopens Data Quality and its Refresh Data sub-tab, then forgets the note', () => {
  const { sb, store, clicked, switched } = reopenPage({ nseReopenTab: 'dataquality', nseReopenDqTab: 'dqRefresh' });
  sb.reopenSavedTab();
  assert.deepEqual(clicked, ['.tab[data-tab="dataquality"]']);
  assert.deepEqual(switched, ['dqRefresh']);
  assert.deepEqual(store, {});
});

test('the TradingView correction reload still reopens the corporate-actions sub-tab', () => {
  const { sb, store, switched } = reopenPage({ nseReopenTab: 'dataquality', nseReopenDqCorp: '1' });
  sb.reopenSavedTab();
  assert.deepEqual(switched, ['dqCorpAction']);
  assert.deepEqual(store, {});
});

test('nothing saved: nothing is clicked or switched', () => {
  const { sb, clicked, switched } = reopenPage({});
  sb.reopenSavedTab();
  assert.deepEqual([clicked, switched], [[], []]);
});

test('a sub-tab note without a main-tab note is ignored (and left alone)', () => {
  const { sb, store, switched } = reopenPage({ nseReopenDqTab: 'dqRefresh' });
  sb.reopenSavedTab();
  assert.deepEqual(switched, []);
  assert.deepEqual(store, { nseReopenDqTab: 'dqRefresh' });
});

test('blocked sessionStorage is not an error', () => {
  const { sb } = reopenPage({});
  sb.sessionStorage = { getItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => sb.reopenSavedTab());
});

// --- pages/reprocess.html ---------------------------------------------------------------------------------

// Runs the page's inline script against a fake DOM. `answers` maps a URL to {body} (fetch result); `search` is
// location.search. Timers never fire, so only the work done synchronously after the start request is observed.
async function runReprocessPage({ search = '', answers }) {
  const html = read('pages/reprocess.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const calls = [];
  const sandbox = {
    console, document: {}, location: { search, href: '' }, URLSearchParams, Date,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (url) => {
      calls.push(url);
      const a = answers(url);
      if (a instanceof Error) throw a;
      return { ok: true, status: 200, json: async () => a };
    },
  };
  const dom = installFakeDom(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  return { calls, el: dom.el };
}

test('reprocess page: a refused start shows the server\'s reason and does not poll a stale status', async () => {
  const { calls, el } = await runReprocessPage({
    answers: () => ({ ok: false, error: 'The sector mapping is being rebuilt - reprocess when it finishes.' }) });
  assert.deepEqual(calls, ['/api/reprocess/start']);
  assert.equal(el('titleEl').textContent, 'Reprocessing Failed');
  assert.match(el('errorBox').textContent, /sector mapping is being rebuilt/);
  assert.equal(el('errorBox').style.display, '');
  assert.equal(el('retryBtn').style.display, '');
});

test('reprocess page: Refresh mode asks for the download and is titled accordingly', async () => {
  const { calls, el } = await runReprocessPage({
    search: '?refresh=1', answers: () => ({ ok: false, error: 'busy' }) });
  assert.deepEqual(calls, ['/api/reprocess/start?download=1']);
  assert.equal(el('titleEl').textContent, 'Refresh Failed');
});

test('reprocess page: an accepted start goes on to poll the status', async () => {
  const { calls, el } = await runReprocessPage({
    answers: (url) => (url === '/api/reprocess/start' ? { ok: true, started: true }
                                                      : { status: 'running', step: 'Reading bhavcopy...' }) });
  assert.deepEqual(calls, ['/api/reprocess/start', '/api/reprocess/status']);
  assert.equal(el('stepEl').textContent, 'Reading bhavcopy...');
});

test('reprocess page: an unreachable server at request time still falls through to polling', async () => {
  const { calls } = await runReprocessPage({
    answers: (url) => (url === '/api/reprocess/start' ? new Error('ECONNRESET') : { status: 'running', step: 'x' }) });
  assert.deepEqual(calls, ['/api/reprocess/start', '/api/reprocess/status']);
});

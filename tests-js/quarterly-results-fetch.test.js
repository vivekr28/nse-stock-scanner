'use strict';
// The "Fetch quarterly results" button on Data Quality -> Refresh Data (js/quarterly-results-fetch.js): how the results-file
// summary and the last-run lines read, that the button starts / stops the server run with the same-origin header, that the
// progress display follows the server's state, that the other refresh buttons are locked while it runs, that finishing
// reloads the scanner's numbers, and that data-quality.js / index.html are wired to it. The server side is in
// tests/test_quarterly_results_fetch.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function setup(responses) {
  const sb = loadScripts(['js/utils.js', 'js/quarterly-results-fetch.js']);
  const dom = installFakeDom(sb);
  const calls = [];
  const queue = Array.isArray(responses) ? responses.slice() : [];
  sb.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, status: 200, json: async () => next };
  };
  sb.setTimeout = fn => { fn(); return 0; };       // the 700 ms poll gap
  sb.reloaded = 0;
  sb.loadQuarterlyResults = () => { sb.reloaded++; };
  return { sb, dom, calls };
}
const FILE = { exists: true, rows: 29571, stocks: 2400, newestQuarter: '30-Sep-2026', updatedAt: 1760000000 };

test('summary: file facts, or a first-run note when there is no file yet', () => {
  const { sb } = setup([{}]);
  assert.match(sb.qrfSummaryHtml(FILE), /29,571<\/b> result rows for 2,400 stocks · newest quarter ended 30-Sep-2026 · file updated/);
  assert.match(sb.qrfSummaryHtml({ exists: false }), /No results file yet.*20 minutes/);
  assert.match(sb.qrfSummaryHtml(null), /No results file yet/);
});

test('last-run lines: the script summary, then each warning; nothing after an error or before any run', () => {
  const { sb } = setup([{}]);
  const html = sb.qrfResultHtml({ status: 'done', stopped: false, result: { summary: 'Quarterly results: 5 rows', warnings: ['list <b>x</b> failed'] } });
  assert.match(html, /Last fetch: Quarterly results: 5 rows/);
  assert.match(html, /Warning: list &lt;b&gt;x&lt;\/b&gt; failed/);           // escaped
  assert.match(sb.qrfResultHtml({ status: 'done', stopped: true, result: { summary: 's', warnings: [] } }), /Last fetch \(stopped\)/);
  assert.equal(sb.qrfResultHtml({ status: 'error', result: { summary: 's' } }), '');
  assert.equal(sb.qrfResultHtml({ status: 'idle', result: null }), '');
});

test('running locks the three buttons and shows Stop + progress; idle undoes it', () => {
  const { sb, dom } = setup([{}]);
  sb.qrfSetRunning(true);
  for (const id of ['qrfBtn', 'dqRefreshBtn', 'dqReprocessBtn']) assert.equal(dom.el(id).disabled, true, id);
  assert.equal(dom.el('qrfStopBtn').style.display, '');
  assert.equal(dom.el('qrfProgress').style.display, '');
  sb.qrfSetRunning(true, true);
  assert.equal(dom.el('qrfStopBtn').textContent, 'Stopping…');
  assert.equal(dom.el('qrfStopBtn').disabled, true);
  sb.qrfSetRunning(false);
  for (const id of ['qrfBtn', 'dqRefreshBtn', 'dqReprocessBtn']) assert.equal(dom.el(id).disabled, false, id);
  assert.equal(dom.el('qrfStopBtn').style.display, 'none');
  assert.equal(dom.el('qrfProgress').style.display, 'none');
});

test('page load while idle: just shows the file summary', async () => {
  const { sb, dom, calls } = setup([{ status: 'idle', file: FILE, result: null }]);
  await sb.qrfLoadStatus();
  assert.equal(calls[0].url, '/api/quarterly-results/status');
  assert.match(dom.el('qrfSummary').innerHTML, /newest quarter ended 30-Sep-2026/);
  assert.equal(dom.el('qrfBtn').disabled, false);
});

test('Start posts with the same-origin header, follows the progress, then refreshes the summary and the scanner numbers', async () => {
  const running = { status: 'running', step: 'Reading result filings', current: 250, total: 1000, startedAt: Date.now() / 1000 - 75, log: ['Results: 250 / 1000 filings processed...'] };
  const done = { status: 'done', stopped: false, file: FILE, result: { summary: 'Quarterly results: 29571 rows', warnings: [] } };
  const { sb, dom, calls } = setup([{ ok: true, started: true }, running, done, done]);
  await sb.qrfStart();
  assert.equal(calls[0].url, '/api/quarterly-results/start');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['X-Requested-With'], 'nse-dashboard');
  assert.equal(dom.el('qrfFill').style.width, '25%');
  assert.match(dom.el('qrfDetail').textContent, /^1m 1[5-6]s elapsed · Results: 250/);
  assert.equal(dom.el('qrfStatus').textContent, 'Quarterly results updated.');
  assert.equal(dom.el('qrfStatus').style.color, 'var(--green)');
  assert.match(dom.el('qrfResult').innerHTML, /Last fetch: Quarterly results: 29571 rows/);
  assert.equal(sb.reloaded, 1, 'the scanner / chart table reload the new numbers');
  assert.equal(dom.el('qrfBtn').disabled, false);
});

test('a fetch that is already running when the page loads is picked up again', async () => {
  const running = { status: 'running', step: 'Reading result filings', current: 10, total: 100, startedAt: Date.now() / 1000, log: [] };
  const done = { status: 'done', stopped: true, file: FILE, result: { summary: 's', warnings: [] } };
  const { sb, dom } = setup([running, done, done]);
  await sb.qrfLoadStatus();
  assert.equal(dom.el('qrfStatus').textContent, 'Stopped - results read so far are saved.');
  assert.equal(dom.el('qrfBtn').disabled, false);
});

test('the server refusing (409 busy / 403) shows its message and unlocks the buttons', async () => {
  const { sb, dom } = setup([{ ok: false, error: 'A data refresh/reprocess is running - try again when it finishes.' }]);
  sb.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'A data refresh/reprocess is running - try again when it finishes.' }) });
  await sb.qrfStart();
  assert.match(dom.el('qrfStatus').textContent, /refresh\/reprocess is running/);
  assert.equal(dom.el('qrfStatus').style.color, 'var(--red)');
  assert.equal(dom.el('qrfBtn').disabled, false);
  assert.equal(sb.reloaded, 0);
});

test('an old server without the route says to restart it', async () => {
  const { sb, dom } = setup([{}]);
  sb.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error('not json'); } });
  await sb.qrfStart();
  assert.match(dom.el('qrfStatus').textContent, /HTTP 404.*restart/i);
});

test('a failed run shows the error and does not reload the scanner numbers', async () => {
  const failed = { status: 'error', error: 'The download failed: boom', file: FILE, result: null };
  const { sb, dom } = setup([{ ok: true }, failed, failed]);
  await sb.qrfStart();
  assert.equal(dom.el('qrfStatus').textContent, 'The download failed: boom');
  assert.equal(dom.el('qrfStatus').style.color, 'var(--red)');
  assert.equal(sb.reloaded, 0);
});

test('Stop posts with the header and shows Stopping', async () => {
  const { sb, dom, calls } = setup([{ ok: true, stopping: true }]);
  await sb.qrfStop();
  assert.equal(calls[0].url, '/api/quarterly-results/stop');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['X-Requested-With'], 'nse-dashboard');
  assert.equal(dom.el('qrfStatus').textContent, 'Stopping…');
});

test('wiring: the section, script tag and tab hook exist, and data-quality.js holds none of the logic', () => {
  const html = read('index.html'), dq = read('js/data-quality.js');
  for (const id of ['qrfSummary', 'qrfBtn', 'qrfStopBtn', 'qrfStatus', 'qrfProgress', 'qrfFill', 'qrfDetail', 'qrfResult']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('onclick="qrfStart()"') && html.includes('onclick="qrfStop()"'));
  assert.ok(html.indexOf('id="qrfBtn"') > html.indexOf('id="dqRefreshBody"'), 'inside the Refresh Data tab');
  assert.ok(html.includes('js/quarterly-results-fetch.js'));
  assert.ok(/typeof qrfLoadStatus === 'function'\) qrfLoadStatus\(\)/.test(dq), 'guarded hook when the tab renders');
  assert.ok(!/quarterly-results\/|qrf[A-Z]\w*\(/.test(dq.replace(/typeof qrfLoadStatus === 'function'\) qrfLoadStatus\(\)/, '')), 'no fetch logic in data-quality.js');
});

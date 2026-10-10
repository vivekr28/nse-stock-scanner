'use strict';
// js/data-quality.js, Data Quality -> "Refresh Data" tab: what the rendering / polling / start-stop code does to the
// page. The page is a fake DOM (fakedom.js) and fetch() is a stub that plays back server answers, so this covers the
// wiring the pure-function tests (refresh-data-tab.test.js) don't: disabled buttons while a rebuild runs, the
// progress text, the reprocess box and badge, the Quick pre-tick, and the start / stop / refusal paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

function page() {
  const sb = loadScripts(['js/utils.js', 'js/data-quality.js']);
  const dom = installFakeDom(sb);
  sb.setTimeout = (fn) => { fn(); return 0; };      // no real waiting between polls
  sb.sessionStorage = { setItem() {}, getItem: () => null, removeItem() {} };
  sb.location = { href: '' };
  return { sb, dom, el: dom.el };
}

// fetch stub: handler(url, opts) -> {status?, body}; every call is recorded.
function stubFetch(sb, handler) {
  const calls = [];
  sb.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const r = handler(url, opts, calls.length) || {};
    const status = r.status || 200;
    return { ok: status < 400, status, json: async () => (r.body === undefined ? {} : r.body) };
  };
  return calls;
}

const mapping = (over = {}) => ({
  exists: true, stocks: 2592, classified: 2586, unclassified: 6, missing: 0, expired: 0, ageDays: 3,
  updatedAt: 1760000000, processedAt: 1760000500, reprocessNeeded: false, suggest: null,
  advice: { level: 'ok', text: 'Up to date - last rebuilt 3 days ago.' }, ...over,
});
const idle = (over = {}) => ({ status: 'idle', stopped: false, error: null, result: null, log: [], mapping: mapping(), ...over });
const running = (over = {}) => ({ status: 'running', step: 'Walking Screener\'s industry pages', phase: 'walk', current: 4,
  total: 12, quick: false, stopping: false, startedAt: Date.now() / 1000 - 5, log: ['walked 4/12'], mapping: null, ...over });

// --- rendering after a rebuild -------------------------------------------------------------------

test('after a rebuild with changes: amber reprocess box with the counts, the changed stocks and the badge', () => {
  const { sb, el } = page();
  sb.dqRenderSectorStatus(idle({
    result: { added: 2, changed: 3, removed: 0, changedSymbols: ['AAA: Dyes → Specialty', 'B<B: x → y'] },
    mapping: mapping({ reprocessNeeded: true }),
  }));
  assert.equal(el('dqSectorReprocess').style.display, '');
  assert.equal(el('dqSectorReprocess').style.borderColor, 'var(--orange)');
  assert.match(el('dqSectorReprocessText').textContent, /2 stocks newly classified, 3 changed sector\/industry/);
  assert.equal(el('dqRefreshBadge').textContent, '⚠');
  const res = el('dqSectorResult').innerHTML;
  assert.match(res, /2 newly classified/);
  assert.match(res, /AAA: Dyes → Specialty/);
  assert.match(res, /B&lt;B/);                               // symbols are escaped
});

test('a rebuild that changed nothing: the box is shown but not amber', () => {
  const { sb, el } = page();
  sb.dqRenderSectorStatus(idle({ result: { added: 0, changed: 0, removed: 0, changedSymbols: [] },
                                 mapping: mapping({ reprocessNeeded: true }) }));
  assert.equal(el('dqSectorReprocess').style.display, '');
  assert.equal(el('dqSectorReprocess').style.borderColor, 'var(--border)');
  assert.match(el('dqSectorReprocessText').textContent, /optional/);
});

test('mapping not newer than the processed data: no box, no badge', () => {
  const { sb, el } = page();
  el('dqRefreshBadge').textContent = '⚠';
  el('dqSectorReprocess').style.display = '';
  sb.dqRenderSectorStatus(idle());
  assert.equal(el('dqSectorReprocess').style.display, 'none');
  assert.equal(el('dqRefreshBadge').textContent, '');
});

test('a stopped rebuild is labelled in the result line', () => {
  const { sb, el } = page();
  sb.dqRenderSectorStatus(idle({ stopped: true, result: { added: 0, changed: 1, removed: 0, changedSymbols: ['A: x → y'] },
                                 mapping: mapping({ reprocessNeeded: true }) }));
  assert.match(el('dqSectorResult').innerHTML, /Last rebuild \(stopped\)/);
  assert.match(el('dqSectorReprocessText').textContent, /partly updated/);
});

test('the Quick box is pre-ticked from the first status only, never over the user\'s choice', () => {
  const { sb, el } = page();
  sb.dqRenderSectorStatus(idle({ mapping: mapping({ suggest: 'quick' }) }));
  assert.equal(el('dqSectorQuick').checked, true);
  el('dqSectorQuick').checked = false;                       // the user unticks it
  sb.dqRenderSectorStatus(idle({ mapping: mapping({ suggest: 'quick' }) }));
  assert.equal(el('dqSectorQuick').checked, false);

  const other = page();
  other.sb.dqRenderSectorStatus(idle({ mapping: mapping({ suggest: 'full' }) }));
  assert.equal(other.el('dqSectorQuick').checked, false);
});

test('a failed run shows the server\'s error next to the button', () => {
  const { sb, el } = page();
  sb.dqRenderSectorStatus(idle({ status: 'error', error: 'The sector-mapping rebuild failed: boom' }));
  assert.match(el('dqSectorStatus').textContent, /rebuild failed: boom/);
  assert.equal(el('dqSectorStatus').style.color, 'var(--red)');
});

// --- running state --------------------------------------------------------------------------------

test('while a rebuild runs the refresh / reprocess / quick controls are locked and Stop is offered', () => {
  const { sb, el } = page();
  sb.dqSectorSetRunning(true, false);
  for (const id of ['dqSectorBtn', 'dqSectorQuick', 'dqRefreshBtn', 'dqReprocessBtn']) assert.equal(el(id).disabled, true, id);
  assert.equal(el('dqSectorStopBtn').style.display, '');
  assert.equal(el('dqSectorStopBtn').disabled, false);
  assert.equal(el('dqSectorProgress').style.display, '');
  assert.match(el('dqRefreshHint').textContent, /Unavailable/);

  sb.dqSectorSetRunning(true, true);                         // Stop pressed
  assert.equal(el('dqSectorStopBtn').disabled, true);
  assert.equal(el('dqSectorStopBtn').textContent, 'Stopping…');

  sb.dqSectorSetRunning(false);
  for (const id of ['dqSectorBtn', 'dqSectorQuick', 'dqRefreshBtn', 'dqReprocessBtn']) assert.equal(el(id).disabled, false, id);
  assert.equal(el('dqSectorStopBtn').style.display, 'none');
  assert.equal(el('dqSectorProgress').style.display, 'none');
  assert.equal(el('dqRefreshHint').textContent, '');
});

test('polling shows walk then company progress, then the finished state with the reprocess box', async () => {
  const { sb, el } = page();
  const shown = [];
  const orig = sb.dqSectorSetStatus;
  sb.dqSectorSetStatus = (t, k) => { shown.push(t); orig(t, k); };
  const script = [
    running(),                                                                          // walking 4/12
    running({ phase: 'company', step: 'Fetching company pages', current: 3, total: 6, log: ['3/6'] }),
    idle({ status: 'done' }),                                                           // the run ended ...
  ];
  let n = 0;
  stubFetch(sb, () => ({ body: n < script.length ? script[n++] : idle({
    status: 'done', result: { added: 1, changed: 2, removed: 0, changedSymbols: ['A: x → y'] },
    mapping: mapping({ reprocessNeeded: true }) }) }));
  await sb.dqPollSectorMapping();

  assert.ok(shown.includes('Walking Screener\'s industry pages (4/12)'), shown.join(' | '));
  assert.ok(shown.includes('Fetching company pages (3/6)'), shown.join(' | '));
  assert.equal(shown[shown.length - 1], 'Sector mapping refreshed.');
  assert.equal(el('dqSectorStatus').style.color, 'var(--green)');
  assert.equal(el('dqSectorFill').style.width, '50%');                                   // last running poll: 3 of 6
  assert.match(el('dqSectorDetail').textContent, /elapsed/);
  assert.equal(el('dqSectorReprocess').style.display, '');                               // the post-run render
  assert.equal(el('dqSectorBtn').disabled, false);
});

test('a stopped run reports that what was fetched is saved', async () => {
  const { sb, el } = page();
  const script = [running(), idle({ status: 'done', stopped: true })];
  let n = 0;
  stubFetch(sb, () => ({ body: n < script.length ? script[n++] : idle({ status: 'done', stopped: true,
    result: { added: 0, changed: 0, removed: 0, changedSymbols: [] } }) }));
  await sb.dqPollSectorMapping();
  assert.match(el('dqSectorStatus').textContent, /Stopped - what was fetched so far is saved/);
});

test('polling ends with the server\'s error when the run failed', async () => {
  const { sb, el } = page();
  const script = [running(), idle({ status: 'error', error: 'boom' })];
  let n = 0;
  stubFetch(sb, () => ({ body: n < script.length ? script[n++] : idle({ status: 'error', error: 'boom' }) }));
  await sb.dqPollSectorMapping();
  assert.equal(el('dqSectorStatus').textContent, 'boom');
  assert.equal(el('dqSectorStatus').style.color, 'var(--red)');
});

test('only one poll loop at a time', async () => {
  const { sb } = page();
  let n = 0;
  const calls = stubFetch(sb, () => ({ body: n++ < 2 ? running() : idle({ status: 'done' }) }));
  await Promise.all([sb.dqPollSectorMapping(), sb.dqPollSectorMapping()]);
  assert.ok(calls.length >= 3 && calls.length <= 4, `${calls.length} status fetches`);   // not doubled
});

// --- start / stop / page load -----------------------------------------------------------------------

test('start posts with the same-origin header, ?quick=1 only when ticked, then polls', async () => {
  const { sb, el } = page();
  const calls = stubFetch(sb, (url) => (url.startsWith('/api/sector-mapping/start') ? { body: { ok: true } }
                                                                                    : { body: idle({ status: 'done' }) }));
  el('dqSectorQuick').checked = true;
  await sb.dqRunSectorMapping();
  const start = calls.find(c => c.url.startsWith('/api/sector-mapping/start'));
  assert.equal(start.url, '/api/sector-mapping/start?quick=1');
  assert.equal(start.opts.method, 'POST');
  assert.equal(start.opts.headers['X-Requested-With'], 'nse-dashboard');

  el('dqSectorQuick').checked = false;
  const calls2 = stubFetch(sb, (url) => (url.startsWith('/api/sector-mapping/start') ? { body: { ok: true } }
                                                                                     : { body: idle({ status: 'done' }) }));
  await sb.dqRunSectorMapping();
  assert.equal(calls2.find(c => c.url.startsWith('/api/sector-mapping/start')).url, '/api/sector-mapping/start');
});

test('a refused start (409) shows the reason and unlocks the buttons', async () => {
  const { sb, el } = page();
  stubFetch(sb, () => ({ status: 409, body: { ok: false, error: 'A data refresh/reprocess is running - try again when it finishes.' } }));
  await sb.dqRunSectorMapping();
  assert.match(el('dqSectorStatus').textContent, /refresh\/reprocess is running/);
  assert.equal(el('dqSectorStatus').style.color, 'var(--red)');
  assert.equal(el('dqSectorBtn').disabled, false);
  assert.equal(el('dqRefreshBtn').disabled, false);
});

test('Stop posts to the stop endpoint and shows Stopping', async () => {
  const { sb, el } = page();
  const calls = stubFetch(sb, () => ({ body: { ok: true, stopping: true } }));
  await sb.dqStopSectorMapping();
  assert.equal(calls[0].url, '/api/sector-mapping/stop');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['X-Requested-With'], 'nse-dashboard');
  assert.equal(el('dqSectorStopBtn').textContent, 'Stopping…');
});

test('loading the tab while a rebuild is already running resumes the progress display', async () => {
  const { sb, el } = page();
  let polled = 0;
  sb.dqPollSectorMapping = () => { polled++; };
  stubFetch(sb, () => ({ body: running() }));
  await sb.dqLoadSectorStatus();
  assert.equal(polled, 1);
  assert.equal(el('dqSectorBtn').disabled, true);
});

test('loading the tab when idle renders the summary and starts no poll; no server = silent', async () => {
  const { sb, el } = page();
  let polled = 0;
  sb.dqPollSectorMapping = () => { polled++; };
  stubFetch(sb, () => ({ body: idle({ mapping: mapping({ advice: { level: 'due', text: 'A refresh is due: 13 newly listed stocks are not in the mapping yet.' } }) }) }));
  await sb.dqLoadSectorStatus();
  assert.equal(polled, 0);
  assert.match(el('dqSectorSummary').innerHTML, /13 newly listed stocks/);

  sb.fetch = async () => { throw new Error('offline'); };
  await sb.dqLoadSectorStatus();                              // must not throw
  stubFetch(sb, () => ({ status: 404, body: {} }));
  await sb.dqLoadSectorStatus();                              // old server without the endpoint: also silent
});

test('the tab is part of the Data Quality sub-tab switcher', () => {
  const { sb } = page();
  const shown = {};
  sb.document.querySelectorAll = (sel) => (sel.includes('.dq-section-body')
    ? ['dqNoSectorBody', 'dqRefreshBody'].map(id => ({ id, style: { set display(v) { shown[id] = v; } } }))
    : []);
  sb.dqSwitchTab('dqRefresh');
  assert.equal(shown.dqRefreshBody, '');
  assert.equal(shown.dqNoSectorBody, 'none');
  assert.equal(typeof vm.runInContext('typeof dqGoReprocess', sb), 'string');
});

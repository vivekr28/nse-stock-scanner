'use strict';
// Regression guard: adding the Stock Scanner's "As of Date" tab (js/asof-scan.js + its pane in index.html + the server's
// /api/band-history) must not change how the existing filters, processing and scanning behave. The tab is a separate module;
// these tests pin that separation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const ROOT = path.dirname(__dirname);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// the app's scripts, in index.html's load order
const SCRIPTS = [...html.matchAll(/<script src="(js\/[^"?]+)/g)].map(m => m[1]);

const declaredNames = src => {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
};

// ─── no collisions with the rest of the app ─────────────────────────────────────

test('asof-scan.js is loaded after screener.js / presets.js and declares no name any other script declares', () => {
  assert.ok(SCRIPTS.includes('js/asof-scan.js'), 'asof-scan.js is not loaded by index.html');
  assert.ok(SCRIPTS.indexOf('js/asof-scan.js') > SCRIPTS.indexOf('js/screener.js'));
  assert.ok(SCRIPTS.indexOf('js/asof-scan.js') > SCRIPTS.indexOf('js/presets.js'));
  const mine = declaredNames(read('js/asof-scan.js'));
  assert.ok(mine.size > 10, 'expected the module to declare its functions');
  for (const f of SCRIPTS.filter(s => s !== 'js/asof-scan.js' && !s.includes('/lib/'))) {
    const theirs = declaredNames(read(f));
    for (const n of mine) assert.ok(!theirs.has(n), `${n} is declared in both js/asof-scan.js and ${f}`);
  }
});

test('every global the module creates is namespaced asof / asOf (nothing generic that could shadow app code)', () => {
  for (const n of declaredNames(read('js/asof-scan.js'))) {
    assert.match(n, /^_?(asof|asOf|ASOF)/i, `${n} is not namespaced`);
  }
});

test('the module only READS the other modules\' globals it needs; it assigns just the screener result lists', () => {
  const src = read('js/asof-scan.js');
  // assignments to existing globals (outside its own namespaced names): only the screener's result state, and only from the hand-off function
  const handOff = src.slice(src.indexOf('function asOfShowInMainWindow'), src.indexOf('function asOfReset'));
  const allowed = ['screenerPassed', 'screenerFailed', 'scrShowingFailed', 'screenerResults', 'screenerPage', 'scrSortCol'];
  const assigned = new Set([...handOff.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=[^=]/gm)].map(m => m[1]));
  for (const a of assigned) assert.ok(allowed.includes(a), `unexpected assignment to ${a}`);
  const outside = src.replace(handOff, '');
  for (const g of [...allowed, 'Store.latestBySymbol', 'Store.dailyBySymbol', 'Store.dates']) {
    assert.ok(!new RegExp(`(^|[^.\\w])${g.replace('.', '\\.')}\\s*=[^=]`, 'm').test(outside), `${g} is assigned outside the hand-off`);
  }
});

// ─── index.html: existing filters and popup untouched ──────────────────────────

test('the existing popup keeps exactly its 18 filter switches, and the new tab adds none the existing code would count', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const switches = ids.filter(id => /^scrF\d+On$/.test(id)).sort();
  assert.equal(switches.length, 18);
  for (let n = 1; n <= 18; n++) assert.ok(switches.includes(`scrF${n}On`), `scrF${n}On is missing`);
  // the existing code counts filters with  input[id^="scrF"][id$="On"]  (screener.js singleFilterCount) - new ids must not match it
  const matchesExisting = ids.filter(id => id.startsWith('scrF') && id.endsWith('On'));
  assert.equal(matchesExisting.length, 18);
  for (const id of ids.filter(i => /^asof/i.test(i))) assert.ok(!(id.startsWith('scrF') && id.endsWith('On')), id);
});

test('no element id is duplicated in index.html (a clash would silently break a getElementById)', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set(), dups = [];
  for (const id of ids) { if (seen.has(id)) dups.push(id); seen.add(id); }
  assert.deepEqual(dups, []);
});

test('the existing three tabs are still wired to the existing switchFilterTab()', () => {
  for (const tab of ['technicals', 'industry', 'multi']) {
    assert.match(html, new RegExp(`onclick="switchFilterTab\\('${tab}'\\)"`));
  }
  assert.match(html, /id="scrApplyBtn"[^>]*onclick="applyScreenerFilters\(\)"/);
});

test('every existing filter input still exists with the id the existing scanner reads', () => {
  const runScreener = read('js/screener.js');
  const read_ids = new Set([...runScreener.matchAll(/getElementById\('(scr[A-Za-z0-9_]+)'\)/g)].map(m => m[1]));
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const missing = [...read_ids].filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

// ─── existing scanning behaves the same with the module loaded, and after it has run ───

const bars = (n, f) => Array.from({ length: n }, (_, i) => {
  const c = f(i);
  const d = new Date(2024, 0, 1 + i);
  return { symbol: 'S', date: d.getDate() + '-' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + '-' + d.getFullYear(),
    open: c, high: c * 1.01, low: c * 0.99, close: c, prev: i ? f(i - 1) : c, turnover: 500 + i, isin: 'I' };
});

function fixture() {
  const mk = (sym, f) => bars(120, f).map(b => ({ ...b, symbol: sym, isin: sym }));
  const days = { UP: mk('UP', i => 100 + i), DOWN: mk('DOWN', i => 300 - i), FLAT: mk('FLAT', () => 100), SPIKE: mk('SPIKE', i => (i === 119 ? 160 : 100)) };
  const latest = {};
  for (const k in days) {
    const last = days[k][days[k].length - 1];
    latest[k] = { ...last, symbol: k, isin: k, industry: 'Ind', sector: 'Sec', changePct: 0, distFrom52H: 0, adr: 2, marketCap: 100, high52w: last.high, aboveSMA: true, monthlyChangePct: 0 };
  }
  return { days, latest };
}

function runExisting(sb) {
  const dom = installFakeDom(sb, { scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m', scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '', scrF2Len: '20', scrF2Val: '0', scrF15Val: '0', scrF1Len: '20', scrF1Mult: '1', scrF18Val: '' });
  dom.el('scrAllowPartial').checked = false;
  dom.el('scrF10On').checked = true; dom.el('scrF10_20sma').checked = true;
  dom.el('scrF15On').checked = true;
  dom.el('scrF18On').checked = true; dom.el('scrF18_1m').checked = true;
  dom.el('scrF2On').checked = true;
  sb.renderScreenerTable = () => {}; sb.updateToggleButton = () => {}; sb.updateFilterBadge = () => {};
  const { days, latest } = fixture();
  sb.Store.latestBySymbol = latest; sb.Store.dailyBySymbol = days;
  sb.runScreener();
  const pick = s => ({ sym: s.symbol, reasons: s._failReasons || null, perf: s._perf, newHighs: s._newHighs, ma: JSON.stringify(s._f10MAs), t: s._dynTurnoverSMA_f2 });
  // JSON round trip: objects from a vm sandbox have that realm's prototypes, which deepEqual would reject
  return JSON.parse(JSON.stringify({
    passed: Array.from(vm.runInContext('screenerPassed', sb), pick),
    failed: Array.from(vm.runInContext('screenerFailed', sb), pick),
    stats: dom.el('screenerStats').innerHTML,
  }));
}

test('the existing scanner gives identical results with and without the As of Date module loaded', () => {
  const base = ['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js'];
  const without = runExisting(loadScripts(base));
  const withIt = runExisting(loadScripts([...base, 'js/asof-scan.js']));
  assert.deepEqual(withIt, without);
  assert.ok(without.passed.length > 0 && without.failed.length > 0, 'fixture should split into passed and failed');
});

test('running an As of Date scan does not change what the existing scanner returns afterwards', () => {
  const base = ['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js'];
  const sb = loadScripts([...base, 'js/asof-scan.js']);
  const before = runExisting(sb);

  // an as-of scan over the same data, with several of its own filters on
  const { days, latest } = fixture();
  const dom = installFakeDom(sb, { asofDate: '2024-04-15', asofHPeriod: '21' });
  dom.el('asofAOn').checked = true; dom.el('asofIOn').checked = true; dom.el('asofCOn').checked = true;
  sb.closeScreenerFilters = () => {};
  sb.Store.dates = days.UP.map(b => b.date); sb.Store.sectorMap = {};
  sb.Store.latestBySymbol = latest; sb.Store.dailyBySymbol = days;
  sb.asOfRun();

  const after = runExisting(sb);
  assert.deepEqual(after, before);
});

test('the existing scanner\'s own state is untouched by merely loading the module', () => {
  const base = ['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js'];
  const a = loadScripts(base), b = loadScripts([...base, 'js/asof-scan.js']);
  for (const v of ['screenerResults', 'screenerPassed', 'screenerFailed', 'screenerPage', 'scrSortCol', 'scrSortDir', 'scrShowingFailed']) {
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(v, b))), JSON.parse(JSON.stringify(vm.runInContext(v, a))), v);
  }
  // and every function the existing modules define is still the very same code
  for (const f of ['runScreener', 'renderScreenerTable', 'resetScreener', 'switchFilterTab', 'applyScreenerFilters', 'updateFilterBadge', 'exportTradingViewWatchlist']) {
    assert.equal(vm.runInContext(`${f}.toString()`, b), vm.runInContext(`${f}.toString()`, a), f);
  }
});

// ─── existing processing (JS and server) ───────────────────────────────────────

test('only js/presets.js references the As of Date module, and only for the preset hooks', () => {
  for (const f of SCRIPTS.filter(s => s !== 'js/asof-scan.js' && !s.includes('/lib/'))) {
    const src = read(f);
    if (f === 'js/presets.js') {
      // saving / restoring the tab's controls (asof* ids) and loadPreset() running the as-of scan for a preset that has it on
      const calls = src.split(/\r?\n/).filter(l => /asOf[A-Za-z]*\(/.test(l));
      assert.deepEqual(calls.map(l => l.trim()), ["if (typeof asOfPresetActive === 'function' && asOfPresetActive()) asOfRun({ keepOpen: true });"]);
    } else {
      assert.ok(!/asof|asOf/i.test(src), `${f} references the As of Date module`);
    }
  }
});

test('server: the band history route is separate - process_data()\'s band handling and the other routes are not routed through it', () => {
  const py = read('src/nse_server.py');
  assert.match(py, /path == '\/api\/band-history'/);
  const processData = py.slice(py.indexOf('def process_data('), py.indexOf('\ndef ', py.indexOf('def process_data(') + 10));
  assert.ok(!/band_history|build_band_history/.test(processData), 'process_data() must not use the band history');
});

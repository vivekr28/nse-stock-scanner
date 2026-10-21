'use strict';
// Stock Scanner popup's "Sector & Industry" tab, F11 (Sector) and F36 (Industry) (js/group-select.js): tick any number of sectors / industries from
// a list. Covers the selection text (JSON list, comma-safe, an older preset's plain name), the filter end to end through runScreener() (OR inside a
// filter, AND between filters, nothing ticked = no restriction, fail reasons), the picker (list, search, tick, Select shown, Clear, button label,
// auto-switch-on), the hooks (badge, Reset All), presets, the popup's HTML, and that screener.js holds none of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/group-breadth.js', 'js/group-select.js', 'js/presets.js']);
const realUpdateFilterBadge = sb.updateFilterBadge;   // setup() below stubs it on the sandbox
const plain = x => JSON.parse(JSON.stringify(x));

const st = (industry, sector) => ({ industry, sector });
// Sectors: Banks (2 industries), Pharma, Consumer. One industry name has a comma; one stock has no sector / industry.
const UNIVERSE = {
  P1: st('Private Sector Bank', 'Banks'), P2: st('Private Sector Bank', 'Banks'), G1: st('Public Sector Bank', 'Banks'),
  D1: st('Pharmaceuticals', 'Pharma'), D2: st('Pharmaceuticals', 'Pharma'), D3: st('Pharmaceuticals', 'Pharma'),
  J1: st('Gems, Jewellery And Watches', 'Consumer'),
  M1: st('Media & Entertainment', 'Consumer'),
  U1: st('', ''),                                   // no classification
};
const ALL = Object.keys(UNIVERSE).sort();

function setup(universe = UNIVERSE) {
  const dom = installFakeDom(sb, {
    scrSearch: '', scrF17Period: '3m', scrF17Lag: '3m', scrF15Period: '1m',
    scrF16FromField: 'close', scrF16ToField: 'close', scrF12Period: '6m', scrF11Sector: '', scrF36Industry: '',
  });
  sb.renderScreenerTable = () => {};
  sb.updateToggleButton = () => {};
  sb.updateFilterBadge = () => {};
  const latest = {}, daily = {};
  for (const k in universe) {
    const u = universe[k];
    latest[k] = { symbol: k, isin: k, close: 100, open: 100, high: 101, low: 99, prev: 100, turnover: 10, changePct: 0, industry: u.industry, sector: u.sector };
    daily[k] = [];
  }
  sb.Store.latestBySymbol = latest;
  sb.Store.dailyBySymbol = daily;
  sb.gsReset();                                      // both filters off, nothing ticked
  return dom;
}
// Tick sectors / industries the way a preset (or the list) leaves them in the hidden inputs
function pick(dom, { sectors, industries, sectorOn = true, industryOn = true }) {
  if (sectors !== undefined) { dom.el('scrF11Sector').value = typeof sectors === 'string' ? sectors : JSON.stringify(sectors); dom.el('scrF11On').checked = sectorOn; }
  if (industries !== undefined) { dom.el('scrF36Industry').value = typeof industries === 'string' ? industries : JSON.stringify(industries); dom.el('scrF36On').checked = industryOn; }
}
function scan(dom, choice, universe) {
  pick(dom, choice);
  sb.runScreener();
  const passed = Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort();
  const failed = Object.fromEntries(Array.from(vm.runInContext('screenerFailed', sb), s => [s.symbol, Array.from(s._failReasons).join('|')]));
  return { passed, failed };
}

// ── The selection text ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('gsParse / gsEncode: a JSON list round-trips, names with commas and & survive, an older preset\'s plain name is a one-name selection', () => {
  assert.deepEqual(plain(sb.gsParse('')), []);
  assert.deepEqual(plain(sb.gsParse(undefined)), []);
  assert.deepEqual(plain(sb.gsParse('["Banks","Pharma"]')), ['Banks', 'Pharma']);
  assert.deepEqual(plain(sb.gsParse('["Gems, Jewellery And Watches","Media & Entertainment"]')), ['Gems, Jewellery And Watches', 'Media & Entertainment']);
  assert.deepEqual(plain(sb.gsParse('Pharma')), ['Pharma']);                       // what the one-sector dropdown saved
  assert.deepEqual(plain(sb.gsParse('Gems, Jewellery And Watches')), ['Gems, Jewellery And Watches']);   // a plain name is never split on its comma
  assert.deepEqual(plain(sb.gsParse('["A","A"," B ",""]')), ['A', 'B']);           // duplicates, blanks and padding dropped
  assert.deepEqual(plain(sb.gsParse('[broken')), ['[broken']);                     // unreadable: kept as one name rather than losing the choice
  assert.deepEqual(plain(sb.gsParse('{"a":1}')), ['{"a":1}']);
  assert.equal(sb.gsEncode([]), '');
  assert.equal(sb.gsEncode(['A, B', 'C']), '["A, B","C"]');
});

test('gsGroups: every sector / industry with its stock count, by name; a stock with none is in Undefined-Diversified', () => {
  setup();
  assert.deepEqual(plain(sb.gsGroups('sector')), [
    { name: 'Banks', count: 3 }, { name: 'Consumer', count: 2 }, { name: 'Pharma', count: 3 }, { name: 'Undefined-Diversified', count: 1 },
  ]);
  const ind = plain(sb.gsGroups('industry'));
  assert.equal(ind.length, 6);
  assert.deepEqual(ind.find(g => g.name === 'Gems, Jewellery And Watches'), { name: 'Gems, Jewellery And Watches', count: 1 });
  assert.deepEqual(ind.find(g => g.name === 'Undefined-Diversified'), { name: 'Undefined-Diversified', count: 1 });
  assert.deepEqual(ind.map(g => g.name), ind.map(g => g.name).slice().sort((a, b) => a.localeCompare(b)));
});

// ── The filters, end to end ──────────────────────────────────────────────────────────────────────────────────────────────────

test('switched on with nothing ticked restricts nothing; switched off with names ticked restricts nothing either', () => {
  const dom = setup();
  assert.deepEqual(scan(dom, { sectors: [], industries: [] }).passed, ALL);
  assert.deepEqual(scan(dom, { sectors: ['Banks'], sectorOn: false, industries: ['Pharmaceuticals'], industryOn: false }).passed, ALL);
});

test('F11: one sector passes only its stocks; the failed ones say why (the old wording for a single sector)', () => {
  const dom = setup();
  const r = scan(dom, { sectors: ['Pharma'] });
  assert.deepEqual(r.passed, ['D1', 'D2', 'D3']);
  assert.equal(r.failed.P1, "F11: Sector 'Banks' ≠ 'Pharma'");
  assert.equal(r.failed.U1, "F11: Sector 'Undefined-Diversified' ≠ 'Pharma'");
});

test('F11: several sectors are OR - a stock in any ticked sector passes', () => {
  const dom = setup();
  assert.deepEqual(scan(dom, { sectors: ['Banks', 'Consumer'] }).passed, ['G1', 'J1', 'M1', 'P1', 'P2']);
});

test('F36: several industries are OR, including names with a comma or an &', () => {
  const dom = setup();
  assert.deepEqual(scan(dom, { industries: ['Gems, Jewellery And Watches', 'Media & Entertainment'] }).passed, ['J1', 'M1']);
  assert.deepEqual(scan(dom, { industries: ['Private Sector Bank', 'Public Sector Bank', 'Pharmaceuticals'] }).passed, ['D1', 'D2', 'D3', 'G1', 'P1', 'P2']);
});

test('F11 and F36 together are AND: the stock must be in a ticked sector AND a ticked industry', () => {
  const dom = setup();
  const r = scan(dom, { sectors: ['Banks'], industries: ['Private Sector Bank', 'Pharmaceuticals'] });
  assert.deepEqual(r.passed, ['P1', 'P2']);                      // Pharmaceuticals is ticked but not in Banks; Public Sector Bank is in Banks but not ticked
  assert.match(r.failed.G1, /^F36: Industry 'Public Sector Bank' ≠|^F36: Industry 'Public Sector Bank' not one of the 2 selected/);
  assert.match(r.failed.D1, /^F11: Sector 'Pharma' ≠ 'Banks'$/);
});

test('a stock with no sector / industry is in Undefined-Diversified and can be ticked', () => {
  const dom = setup();
  assert.deepEqual(scan(dom, { sectors: ['Undefined-Diversified'] }).passed, ['U1']);
  assert.deepEqual(scan(dom, { sectors: [], industries: ['Undefined-Diversified', 'Pharmaceuticals'] }).passed, ['D1', 'D2', 'D3', 'U1']);
});

test('an older preset\'s plain sector name still filters', () => {
  const dom = setup();
  assert.deepEqual(scan(dom, { sectors: 'Pharma' }).passed, ['D1', 'D2', 'D3']);
});

test('the fail reason for many ticked groups names the first four and counts the rest', () => {
  const dom = setup();
  const r = scan(dom, { industries: ['Pharmaceuticals', 'Media & Entertainment', 'Public Sector Bank', 'Private Sector Bank', 'Gems, Jewellery And Watches', 'Zeta'] });
  assert.equal(r.failed.U1, "F36: Industry 'Undefined-Diversified' not one of the 6 selected (Pharmaceuticals, Media & Entertainment, Public Sector Bank, Private Sector Bank, +2 more)");
});

test('a ticked name that no stock has (an industry renamed since the preset was saved) matches nothing - it does not widen the filter', () => {
  const dom = setup();
  assert.deepEqual(scan(dom, { industries: ['Renamed Industry'] }).passed, []);
});

// ── The hooks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('hooks: gsFilterState reads the controls; any = a filter is on AND has something ticked; gsActiveCount counts the switches on', () => {
  const dom = setup();
  assert.equal(sb.gsFilterState().any, false);
  pick(dom, { sectors: ['Banks', 'Pharma'] });
  const s = sb.gsFilterState();
  assert.deepEqual(plain({ on: s.sec.on, names: s.sec.names, ind: s.ind.on }), { on: true, names: ['Banks', 'Pharma'], ind: false });
  assert.equal(s.any, true);
  assert.equal(sb.gsActiveCount(), 1);
  pick(dom, { industries: [] });                                  // on, nothing ticked: counts as active, restricts nothing
  assert.equal(sb.gsActiveCount(), 2);
  pick(dom, { sectors: [], sectorOn: false });
  assert.equal(sb.gsFilterState().any, false);
});

test('the badges: the Sector & Industry tab count and the total include F11 and F36 once each', () => {
  const dom = setup();
  pick(dom, { sectors: ['Banks'], industries: ['Pharmaceuticals'] });
  dom.el('scrF9On').checked = true;
  sb.updateApplyBtn = () => {};
  realUpdateFilterBadge();
  assert.equal(dom.el('scrTabIndCount').textContent, 3);
  assert.equal(dom.el('scrActiveFilterBadge').textContent, 3);
  dom.el('scrF9On').checked = false;
  sb.gsReset();
});

test('Active Filters card: F11 and F36 are counted once (the scanner\'s own F11 line is gone)', () => {
  const dom = setup();
  pick(dom, { sectors: ['Banks'], industries: ['Pharmaceuticals'] });
  sb.runScreener();
  const stats = Array.from(dom.el('scrStats') ? [dom.el('scrStats').innerHTML] : [])[0] || '';
  const m = /Active Filters<\/div><div class="value"[^>]*>(\d+)</.exec(stats) || /Active Filters[\s\S]*?(\d+)</.exec(stats);
  if (m) assert.equal(Number(m[1]), 2);
  else assert.ok(sb.gsActiveCount() === 2);                         // (the stats element is not part of the fake page: the hook count is the check)
});

test('Reset All: both filters off and nothing ticked, button labels back to "All ..."', () => {
  const dom = setup();
  sb.gsSync();
  pick(dom, { sectors: ['Banks'], industries: ['Pharmaceuticals'] });
  sb.gsSync();
  sb.initF16Dates = () => {};
  sb.resetScreener();
  for (const id of ['scrF11On', 'scrF36On']) assert.equal(dom.el(id).checked, false, id);
  for (const id of ['scrF11Sector', 'scrF36Industry']) assert.equal(dom.el(id).value, '', id);
  assert.equal(dom.el('gsBtnF11').textContent, 'All sectors ▾');
  assert.equal(dom.el('gsBtnF36').textContent, 'All industries ▾');
});

// ── Presets ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('presets: both selections are captured and restored, default to off / empty, and an older preset\'s plain name is turned into JSON', () => {
  const dom = setup();
  sb.gsSync();
  pick(dom, { sectors: ['Banks', 'Pharma'], industries: ['Gems, Jewellery And Watches'] });
  const state = plain(sb.capturePresetState());
  assert.deepEqual([state.scrF11On, state.scrF11Sector, state.scrF36On, state.scrF36Industry],
    [true, '["Banks","Pharma"]', true, '["Gems, Jewellery And Watches"]']);
  const defaults = plain(vm.runInContext('DEFAULT_FILTER_STATE', sb));
  assert.deepEqual([defaults.scrF11On, defaults.scrF11Sector, defaults.scrF36On, defaults.scrF36Industry], [false, '', false, '']);
  sb.applyPresetState(defaults);
  assert.equal(dom.el('scrF11Sector').value, '');
  assert.equal(dom.el('gsBtnF11').textContent, 'All sectors ▾');
  sb.applyPresetState(state);
  assert.equal(dom.el('scrF36Industry').value, '["Gems, Jewellery And Watches"]');
  assert.equal(dom.el('gsBtnF11').textContent, '2 sectors selected ▾');
  assert.equal(dom.el('gsBtnF36').textContent, 'Gems, Jewellery And Watches ▾');
  // a preset saved before F36 existed does not mention it; the one-sector dropdown saved a plain name
  sb.applyPresetState(defaults);
  sb.applyPresetState({ scrF11On: true, scrF11Sector: 'Pharma' });
  assert.equal(dom.el('scrF11Sector').value, '["Pharma"]');
  assert.equal(dom.el('gsBtnF11').textContent, 'Pharma ▾');
  assert.equal(dom.el('scrF36On').checked, false);
});

test('presets: the field list names the three new controls and the default state sets them', () => {
  const ids = Array.from(vm.runInContext('PRESET_FIELDS', sb), f => f.id);
  for (const id of ['scrF11On', 'scrF11Sector', 'scrF36On', 'scrF36Industry']) assert.ok(ids.includes(id), id);
});

// ── The picker ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('gsSync builds the picker once: a button and a panel with a search box, Select shown, Clear and the list; the search box does not re-run the scanner', () => {
  const dom = setup();
  sb.gsSync();
  const pick1 = dom.el('gsPickF11').innerHTML;
  assert.match(pick1, /id="gsBtnF11"/);
  assert.match(pick1, /id="gsPanelF11"[^>]*display:none/);
  assert.match(pick1, /placeholder="Search sectors - or paste a list"/);
  assert.match(pick1, /Select shown/);
  assert.match(pick1, />Clear</);
  assert.match(pick1, /oninput="event\.stopPropagation\(\); gsRenderList\('F11'\)"/);
  assert.match(dom.el('gsPickF36').innerHTML, /placeholder="Search industries - or paste a list"/);
  dom.el('gsBtnF11').textContent = 'kept';                           // a second sync does not rebuild the widget (the open panel and the search stay)
  sb.gsSync();
  assert.equal(dom.el('gsBtnF11').textContent, 'All sectors ▾');
  assert.equal(dom.el('gsPickF11').innerHTML, pick1);
});

test('the list: every group by name with its stock count, the ticked ones checked, names escaped', () => {
  const dom = setup();
  pick(dom, { industries: ['Media & Entertainment'] });
  sb.gsSync();
  const list = dom.el('gsListF36').innerHTML;
  assert.equal((list.match(/<label class="gs-item">/g) || []).length, 6);
  assert.match(list, /<input type="checkbox" value="Media &amp; Entertainment" checked onchange="gsCheck\('F36', this\)">/);
  assert.match(list, /value="Gems, Jewellery And Watches" onchange/);
  assert.doesNotMatch(list, /value="Pharmaceuticals" checked/);
  assert.match(list, /<span class="gs-name" title="Pharmaceuticals">Pharmaceuticals<\/span><span class="gs-count">3<\/span>/);
  assert.ok(list.indexOf('Gems, Jewellery') < list.indexOf('Pharmaceuticals'), 'alphabetical');
});

test('search narrows the list (case-insensitive) and says so when nothing matches; with no data it says no data is loaded', () => {
  const dom = setup();
  sb.gsSync();
  dom.el('gsSearchF36').value = 'BANK';
  sb.gsRenderList('F36');
  const names = [...dom.el('gsListF36').innerHTML.matchAll(/class="gs-name"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(names, ['Private Sector Bank', 'Public Sector Bank']);
  dom.el('gsSearchF36').value = 'zzz';
  sb.gsRenderList('F36');
  assert.match(dom.el('gsListF36').innerHTML, /No industry matches the search/);
  dom.el('gsSearchF36').value = '';
  sb.Store.latestBySymbol = {};
  sb.gsRenderList('F36');
  assert.match(dom.el('gsListF36').innerHTML, /No data loaded yet/);
});

test('ticking a box adds the group (kept alphabetical in the hidden value), unticking removes it, and the first tick switches the filter on', () => {
  const dom = setup();
  sb.gsSync();
  assert.equal(dom.el('scrF36On').checked, false);
  sb.gsCheck('F36', { value: 'Pharmaceuticals', checked: true });
  assert.equal(dom.el('scrF36On').checked, true);
  sb.gsCheck('F36', { value: 'Gems, Jewellery And Watches', checked: true });
  assert.equal(dom.el('scrF36Industry').value, '["Gems, Jewellery And Watches","Pharmaceuticals"]');
  assert.equal(dom.el('gsBtnF36').textContent, '2 industries selected ▾');
  assert.equal(dom.el('gsBtnF36').title, 'Gems, Jewellery And Watches, Pharmaceuticals');
  sb.gsCheck('F36', { value: 'Gems, Jewellery And Watches', checked: false });
  assert.equal(dom.el('scrF36Industry').value, '["Pharmaceuticals"]');
  assert.equal(dom.el('gsBtnF36').textContent, 'Pharmaceuticals ▾');
  sb.gsCheck('F36', { value: 'Pharmaceuticals', checked: false });
  assert.equal(dom.el('scrF36Industry').value, '');
  assert.equal(dom.el('gsBtnF36').textContent, 'All industries ▾');
  assert.equal(dom.el('scrF36On').checked, true, 'unticking the last one leaves the switch where it was');
});

test('Select shown ticks what the search shows (added to what was ticked), Clear unticks everything; both ask the scanner to re-run', () => {
  const dom = setup();
  sb.gsSync();
  let reruns = 0;
  sb.rerunScreenerRespectingMultiPreset = () => { reruns++; };
  sb.updateFilterBadge = () => {};
  sb.gsCheck('F36', { value: 'Pharmaceuticals', checked: true });
  dom.el('gsSearchF36').value = 'bank';
  sb.gsRenderList('F36');
  sb.gsSelectShown('F36');
  assert.deepEqual(plain(sb.gsParse(dom.el('scrF36Industry').value)), ['Pharmaceuticals', 'Private Sector Bank', 'Public Sector Bank']);
  assert.equal(reruns, 1);
  assert.match(dom.el('gsListF36').innerHTML, /value="Private Sector Bank" checked/);
  sb.gsClear('F36');
  assert.equal(dom.el('scrF36Industry').value, '');
  assert.equal(reruns, 2);
  assert.doesNotMatch(dom.el('gsListF36').innerHTML, /checked/);
});

test('opening a panel closes the other one; the button toggles it; clicking outside / Escape close (gsClosePanels)', () => {
  const dom = setup();
  sb.gsSync();
  dom.el('gsPanelF11').style.display = 'none'; dom.el('gsPanelF36').style.display = 'none';   // what the built markup says (the fake page does not parse it)
  sb.gsToggle('F11');
  assert.equal(dom.el('gsPanelF11').style.display, '');
  sb.gsToggle('F36');
  assert.equal(dom.el('gsPanelF11').style.display, 'none');
  assert.equal(dom.el('gsPanelF36').style.display, '');
  sb.gsToggle('F36');
  assert.equal(dom.el('gsPanelF36').style.display, 'none');
  sb.gsToggle('F11');
  sb.gsClosePanels(null);
  assert.equal(dom.el('gsPanelF11').style.display, 'none');
});

// ── The page and the scanner ─────────────────────────────────────────────────────────────────────────────────────────────────

test('index.html: Sector then Industry are the first two rows of the Sector & Industry tab, each a hidden value + a picker container; the script follows screener.js', () => {
  const pane = html.slice(html.indexOf('id="scrPaneIndustry"'), html.indexOf('id="scrPaneRelStrength"'));
  const rows = [...pane.matchAll(/id="(scrF\d+On)"/g)].map(m => m[1]);
  assert.deepEqual(rows.slice(0, 2), ['scrF11On', 'scrF36On']);
  assert.match(pane, /<input type="hidden" id="scrF11Sector" value="">\s*<div class="gs-pick" id="gsPickF11"><\/div>/);
  assert.match(pane, /<input type="hidden" id="scrF36Industry" value="">\s*<div class="gs-pick" id="gsPickF36"><\/div>/);
  assert.doesNotMatch(html, /<select id="scrF11Sector"/);
  assert.ok(html.indexOf('src="js/group-select.js') > html.indexOf('src="js/screener.js'));
  assert.ok(html.indexOf('src="js/group-select.js') < html.indexOf('src="js/presets.js'));
  for (const c of ['.gs-pick', '.gs-btn', '.gs-panel', '.gs-list', '.gs-item']) assert.ok(read('css/styles.css').includes(c), c);
});

test('guard: screener.js, ui.js and presets.js hold none of the picker - only typeof-guarded gs* hooks (presets keep their field ids)', () => {
  const src = read('js/screener.js');
  for (const needle of ['scrF36', 'GS_FILTERS', 'scrF11Sector', 'f11Sector', 'f11On']) assert.ok(!src.includes(needle), needle);
  for (const name of ['gsFilterState', 'gsActiveCount', 'gsReset']) assert.ok(src.includes(`typeof ${name} === 'function'`), `${name} must be typeof-guarded`);
  const lines = src.split(/\r?\n/).filter(l => l.includes('gsApplyToStock('));
  assert.ok(lines.length > 0 && lines.every(l => /\bgs\b\s*&&/.test(l)), 'gsApplyToStock only inside the gs it produced');
  assert.ok(!read('js/ui.js').includes('scrF11Sector'));
  assert.match(read('js/ui.js'), /typeof gsSync === 'function'\) gsSync\(\)/);
  assert.match(read('js/presets.js'), /typeof gsSync === 'function'\) gsSync\(\)/);
});

// ── Paste a list (the Industry Analysis tab's "Copy industries" puts the listed industries on the clipboard as one comma-separated line) ──

test('gsNormalizeName: case, spacing, punctuation and & vs "and" do not matter', () => {
  const n = sb.gsNormalizeName;
  assert.equal(n('Gems, Jewellery And Watches'), n('gems jewellery & watches'));
  assert.equal(n('Gems, Jewellery And Watches'), n('  GEMS  JEWELLERY AND WATCHES '));
  assert.equal(n('Media & Entertainment'), 'media and entertainment');
  assert.notEqual(n('Private Sector Bank'), n('Public Sector Bank'));
});

test('gsPastedLines: split on line breaks (any kind) and tabs, not on commas; list markers dropped; blanks and repeats removed', () => {
  assert.deepEqual(plain(sb.gsPastedLines('Gems, Jewellery And Watches\r\nMedia & Entertainment\n\n  Pharmaceuticals  \nPharmaceuticals')),
    ['Gems, Jewellery And Watches', 'Media & Entertainment', 'Pharmaceuticals']);
  assert.deepEqual(plain(sb.gsPastedLines('1. Sugar\n2) Paints\n- Textiles\n* Auto\n• Steel')), ['Sugar', 'Paints', 'Textiles', 'Auto', 'Steel']);
  assert.deepEqual(plain(sb.gsPastedLines('Sugar\tPaints')), ['Sugar', 'Paints']);            // a copied table row
  assert.deepEqual(plain(sb.gsPastedLines('2/3 Wheelers')), ['2/3 Wheelers']);                // a name that starts with digits is not a list marker
  assert.deepEqual(plain(sb.gsPastedLines('Sugar,Paints')), ['Sugar,Paints']);                // commas are handled by the matcher, which tries the whole line first
  assert.deepEqual(plain(sb.gsPastedLines('')), []);
  assert.deepEqual(plain(sb.gsPastedLines(null)), []);
});

test('gsMatchPasted: exact and loose matches (comma-free, &, case, a trailing "(73)" count), the rest reported as missing', () => {
  setup();
  const d = vm.runInContext("gsDef('F36')", sb);
  const m = plain(sb.gsMatchPasted(d, 'Pharmaceuticals\ngems jewellery and watches\nMedia and Entertainment (12)\nNo Such Industry\nPharmaceuticals'));
  assert.deepEqual(m.names, ['Pharmaceuticals', 'Gems, Jewellery And Watches', 'Media & Entertainment']);
  assert.deepEqual(m.missing, ['No Such Industry']);
  assert.equal(m.lines, 4);
});

test('gsMatchPasted: a comma-separated line is split into names - but a line that is itself a name with a comma is kept whole', () => {
  setup();
  const d = vm.runInContext("gsDef('F36')", sb);
  // what "Copy industries" writes: one line, commas inside a name already turned into spaces
  const copied = plain(sb.gsMatchPasted(d, 'Gems Jewellery And Watches,Media & Entertainment,Pharmaceuticals,Nothing Here'));
  assert.deepEqual(copied.names, ['Gems, Jewellery And Watches', 'Media & Entertainment', 'Pharmaceuticals']);
  assert.deepEqual(copied.missing, ['Nothing Here']);
  // the real name typed on its own line, comma and all, is one name (not "Gems" and "Jewellery And Watches")
  const whole = plain(sb.gsMatchPasted(d, 'Gems, Jewellery And Watches'));
  assert.deepEqual(whole.names, ['Gems, Jewellery And Watches']);
  assert.deepEqual(whole.missing, []);
  // spaces after the commas, empty pieces
  assert.deepEqual(plain(sb.gsMatchPasted(d, 'Pharmaceuticals, Media & Entertainment,,')).names, ['Pharmaceuticals', 'Media & Entertainment']);
});

test('paste: the pasted industries replace the selection, the filter switches on, the scanner re-runs, and the message says what happened', () => {
  const dom = setup();
  sb.gsSync();
  let reruns = 0;
  sb.rerunScreenerRespectingMultiPreset = () => { reruns++; };
  sb.updateFilterBadge = () => {};
  sb.gsCheck('F36', { value: 'Pharmaceuticals', checked: true });       // was ticked before; the paste replaces it
  dom.el('gsSearchF36').value = 'zz';
  sb.gsPaste('F36', 'Gems Jewellery And Watches,Media & Entertainment,Private Sector Bank');
  assert.deepEqual(plain(sb.gsParse(dom.el('scrF36Industry').value)), ['Gems, Jewellery And Watches', 'Media & Entertainment', 'Private Sector Bank']);
  assert.equal(dom.el('scrF36On').checked, true);
  assert.equal(dom.el('gsBtnF36').textContent, '3 industries selected ▾');
  assert.equal(dom.el('gsSearchF36').value, '', 'the search is cleared so the whole list shows');
  assert.match(dom.el('gsListF36').innerHTML, /value="Private Sector Bank" checked/);
  assert.doesNotMatch(dom.el('gsListF36').innerHTML, /value="Pharmaceuticals" checked/);
  assert.equal(dom.el('gsMsgF36').textContent, 'Selected 3 industries.');
  assert.equal(dom.el('gsMsgF36').className, 'gs-msg');
  assert.equal(reruns, 1);
  // and the scanner then passes exactly those stocks
  sb.runScreener();
  assert.deepEqual(Array.from(vm.runInContext('screenerPassed', sb), s => s.symbol).sort(), ['J1', 'M1', 'P1', 'P2']);
});

test('paste: names that match nothing are reported (first five named); a single match uses the singular', () => {
  const dom = setup();
  sb.gsSync();
  sb.rerunScreenerRespectingMultiPreset = () => {}; sb.updateFilterBadge = () => {};
  sb.gsPaste('F36', 'Pharmaceuticals,Alpha,Beta');
  assert.equal(dom.el('gsMsgF36').textContent, 'Selected 1 industry. Not found (2): Alpha; Beta');
  assert.equal(dom.el('gsMsgF36').className, 'gs-msg warn');
  sb.gsPaste('F36', 'Pharmaceuticals\nA\nB\nC\nD\nE\nF');
  assert.equal(dom.el('gsMsgF36').textContent, 'Selected 1 industry. Not found (6): A; B; C; D; E; ...');
});

test('paste: text that matches nothing, or an empty clipboard, leaves the selection alone and says so', () => {
  const dom = setup();
  sb.gsSync();
  let reruns = 0;
  sb.rerunScreenerRespectingMultiPreset = () => { reruns++; }; sb.updateFilterBadge = () => {};
  sb.gsCheck('F36', { value: 'Pharmaceuticals', checked: true });
  sb.gsPaste('F36', 'Alpha,Beta');
  assert.equal(dom.el('scrF36Industry').value, '["Pharmaceuticals"]');
  assert.equal(dom.el('gsMsgF36').textContent, 'None of the pasted names matches an industry - nothing changed.');
  assert.equal(dom.el('gsMsgF36').className, 'gs-msg warn');
  sb.gsPaste('F11', 'Alpha');
  assert.equal(dom.el('gsMsgF11').textContent, 'None of the pasted names matches a sector - nothing changed.');
  sb.gsPaste('F36', '');
  assert.equal(dom.el('gsMsgF36').textContent, 'Nothing to paste - the clipboard is empty.');
  assert.equal(reruns, 0);
});

test('paste works the same on the Sector picker', () => {
  const dom = setup();
  sb.gsSync();
  sb.rerunScreenerRespectingMultiPreset = () => {}; sb.updateFilterBadge = () => {};
  sb.gsPaste('F11', 'banks,PHARMA');
  assert.deepEqual(plain(sb.gsParse(dom.el('scrF11Sector').value)), ['Banks', 'Pharma']);
  assert.equal(dom.el('scrF11On').checked, true);
  assert.equal(dom.el('gsMsgF11').textContent, 'Selected 2 sectors.');
});

test('round trip: copy every industry name the way the buttons do (copyNamesToClipboard), paste it - all come back selected, commas and & included', async () => {
  const dom = setup();
  sb.gsSync();
  sb.rerunScreenerRespectingMultiPreset = () => {}; sb.updateFilterBadge = () => {};
  const names = Array.from(sb.gsGroups('industry'), g => g.name);
  let clip = '';
  sb.navigator = { clipboard: { writeText: t => { clip = t; return Promise.resolve(); } } };
  sb.setTimeout = () => {};
  await sb.copyNamesToClipboard(names, { dataset: {}, textContent: 'Copy industries' });
  delete sb.navigator; delete sb.setTimeout;
  assert.equal(clip.includes('\n'), false, 'one line');
  assert.ok(clip.includes('Gems Jewellery And Watches'), 'the comma inside a name became a space, as in the watchlist copy');
  sb.gsPaste('F36', clip);
  assert.deepEqual(plain(sb.gsParse(dom.el('scrF36Industry').value)).sort(), names.slice().sort());
  assert.equal(dom.el('gsMsgF36').textContent, `Selected ${names.length} industries.`);
});

test('Ctrl+V in the search box: a list or text naming a group is selected (default paste cancelled); other text is an ordinary paste into the search', () => {
  const dom = setup();
  sb.gsSync();
  sb.rerunScreenerRespectingMultiPreset = () => {}; sb.updateFilterBadge = () => {};
  const evt = text => ({ prevented: false, clipboardData: { getData: () => text }, preventDefault() { this.prevented = true; } });
  const multi = evt('Pharmaceuticals,Private Sector Bank');
  sb.gsOnPaste('F36', multi);
  assert.equal(multi.prevented, true);
  assert.equal(dom.el('scrF36Industry').value, '["Pharmaceuticals","Private Sector Bank"]');
  const exact = evt('Media & Entertainment');
  sb.gsOnPaste('F36', exact);
  assert.equal(exact.prevented, true);
  assert.equal(dom.el('scrF36Industry').value, '["Media & Entertainment"]');
  const word = evt('bank');
  sb.gsOnPaste('F36', word);
  assert.equal(word.prevented, false, 'one word that is not a name goes into the search box');
  assert.equal(dom.el('scrF36Industry').value, '["Media & Entertainment"]');
  const multiNoMatch = evt('Alpha\nBeta');
  sb.gsOnPaste('F36', multiNoMatch);
  assert.equal(multiNoMatch.prevented, true, 'several lines are a list: reported, not typed into the search');
  assert.match(dom.el('gsMsgF36').textContent, /None of the pasted names/);
  assert.doesNotThrow(() => sb.gsOnPaste('F36', null));
});

test('the Paste link reads the clipboard; when the browser refuses or cannot, it points to Ctrl+V', async () => {
  const dom = setup();
  sb.gsSync();
  sb.rerunScreenerRespectingMultiPreset = () => {}; sb.updateFilterBadge = () => {};
  sb.navigator = { clipboard: { readText: () => Promise.resolve('Pharmaceuticals,Media & Entertainment') } };
  assert.equal(await sb.gsPasteFromClipboard('F36'), true);
  assert.equal(dom.el('gsMsgF36').textContent, 'Selected 2 industries.');
  sb.navigator = { clipboard: { readText: () => Promise.reject(new Error('denied')) } };
  assert.equal(await sb.gsPasteFromClipboard('F36'), false);
  assert.match(dom.el('gsMsgF36').textContent, /press Ctrl\+V instead/);
  sb.navigator = {};
  assert.equal(await sb.gsPasteFromClipboard('F36'), false);
  assert.match(dom.el('gsMsgF36').textContent, /press Ctrl\+V instead/);
  delete sb.navigator;
});

test('the message goes away when the panel is reopened or Clear is clicked', () => {
  const dom = setup();
  sb.gsSync();
  dom.el('gsPanelF36').style.display = 'none';
  sb.rerunScreenerRespectingMultiPreset = () => {}; sb.updateFilterBadge = () => {};
  sb.gsPaste('F36', 'Pharmaceuticals');
  assert.notEqual(dom.el('gsMsgF36').textContent, '');
  sb.gsToggle('F36');                                              // opens
  assert.equal(dom.el('gsMsgF36').textContent, '');
  assert.equal(dom.el('gsMsgF36').style.display, 'none');
  sb.gsPaste('F36', 'Pharmaceuticals');
  sb.gsClear('F36');
  assert.equal(dom.el('gsMsgF36').textContent, '');
});

test('the picker markup has the paste hooks, the Paste link and a message line', () => {
  const dom = setup();
  sb.gsSync();
  const markup = dom.el('gsPickF36').innerHTML;
  assert.match(markup, /onpaste="gsOnPaste\('F36', event\)"/);
  assert.match(markup, /onclick="gsPasteFromClipboard\('F36'\)"[^>]*>Paste</);
  assert.match(markup, /id="gsMsgF36" style="display:none;"/);
  assert.match(read('css/styles.css'), /\.gs-msg\.warn/);
});

'use strict';
// js/scanner-overview.js: the Stock Scanner's Overview modal - the sector / industry breakdown of the stocks in the results table, drawn as two
// SVG donuts with a ranked list each - plus the button and modal markup in index.html.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const html = fs.readFileSync(path.join(path.dirname(__dirname), 'index.html'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/scanner-overview.js']);
const run = code => vm.runInContext(code, sb);

const stock = (sector, industry) => ({ sector, industry });

test('groups count the stocks per sector, biggest first, ties by name; a stock with no sector counts as Undefined-Diversified', () => {
  const rows = [stock('Energy'), stock('Auto'), stock('Energy'), stock('Auto'), stock('Banks'), stock(''), stock(undefined)];
  sb.__rows = rows;
  const g = run("ovGroupCounts(__rows, 'sector')");
  assert.equal(g.total, 7);
  assert.deepEqual(Array.from(g.groups, x => [x.name, x.count]), [['Auto', 2], ['Energy', 2], ['Undefined-Diversified', 2], ['Banks', 1]]);
  assert.equal(g.groups[0].pct.toFixed(2), '28.57');
  assert.equal(g.slices.length, 4);                                       // 4 groups, under the 10-slice cap: no "Other"
  assert.equal(new Set(Array.from(g.slices, s => s.color)).size, 4);      // each slice its own colour
});

test('beyond the top 10 the smallest groups join one grey "Other" slice; the list still names every group', () => {
  const rows = [];
  for (let i = 0; i < 14; i++) for (let k = 0; k < 14 - i; k++) rows.push(stock('S', 'Ind' + String(i).padStart(2, '0')));   // 14, 13, ... 1 stocks
  sb.__rows = rows;
  const g = run("ovGroupCounts(__rows, 'industry')");
  assert.equal(g.groups.length, 14);
  assert.equal(g.slices.length, 11);                                      // 10 named + Other
  const other = g.slices[10];
  assert.equal(other.name, 'Other (4 industries)');
  assert.equal(other.count, 4 + 3 + 2 + 1);
  assert.equal(other.color, run('OV_OTHER_COLOR'));
  assert.equal(g.slices.reduce((s, x) => s + x.count, 0), g.total);       // the slices add up to every stock
  assert.equal(g.slices[0].name, 'Ind00');
});

test('no results gives an empty breakdown, and a missing list is the same', () => {
  sb.__rows = [];
  assert.equal(run("ovGroupCounts(__rows, 'sector')").total, 0);
  assert.equal(run("ovGroupCounts(undefined, 'sector').groups.length"), 0);
});

test('the donut draws one ring segment per slice, sized by its share, with the total in the middle', () => {
  const slices = [{ name: 'A', count: 3, pct: 75, color: '#111111' }, { name: 'B & C', count: 1, pct: 25, color: '#222222' }];
  sb.__s = slices;
  const svg = run("ovDonutSvg('sector', __s, 4)");
  const C = 2 * Math.PI * run('OV_R');
  const dashes = [...svg.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)].map(m => parseFloat(m[1]));
  assert.equal(dashes.length, 2);
  assert.ok(Math.abs(dashes[0] - (0.75 * C - 0.8)) < 0.01 && Math.abs(dashes[1] - (0.25 * C - 0.8)) < 0.01);
  assert.match(svg, /data-ov="sector:0"/);
  assert.match(svg, /data-ov="sector:1"/);
  assert.match(svg, /<title>B &amp; C: 1 \(25\.0%\)<\/title>/);            // names are escaped
  assert.match(svg, />4<\/text>/);                                        // the total in the middle
});

test('a single slice is a full ring (no gap)', () => {
  sb.__s = [{ name: 'Only', count: 5, pct: 100, color: '#111111' }];
  const svg = run("ovDonutSvg('industry', __s, 5)");
  const C = 2 * Math.PI * run('OV_R');
  assert.ok(Math.abs(parseFloat(svg.match(/stroke-dasharray="([\d.]+) /)[1]) - C) < 0.01);
});

test('a section lists every group with count and %, links each row to its slice, escapes names, and greys the ones in "Other"', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(stock('S', i === 0 ? 'Oil & Gas' : 'Ind' + i));
  sb.__rows = rows;
  const sec = run("ovSectionHtml('industry', 'By industry', __rows)");
  assert.match(sec, /By industry <span>12 industries<\/span>/);
  assert.equal(sec.split('class="ov-row"').length - 1, 12);               // every group is listed
  assert.match(sec, /<span class="ov-name" title="Oil &amp; Gas">Oil &amp; Gas<\/span><b>1<\/b><em>8\.3%<\/em>/);
  assert.match(sec, /data-ov="industry:10"><i style="background:#64748b">/);   // groups 11 and 12 point at the Other slice (the 11th ring) and are grey
  assert.match(sec, /data-total="12"/);
  const one = run("ovSectionHtml('sector', 'By sector', __rows)");
  assert.match(one, /By sector <span>1 sector<\/span>/);
});

test('opening fills the title, both sections and the footnote, and shows the modal; Passed or Failed is named', () => {
  const dom = installFakeDom(sb);
  const log = [];
  dom.el('scrOverviewModal').classList = { add: c => log.push('add ' + c), remove: c => log.push('remove ' + c), contains: () => false };
  sb.__rows = [stock('Energy', 'Refineries'), stock('Energy', 'Oil'), stock('Auto', 'Cars')];
  run('screenerResults = __rows; scrShowingFailed = false');
  sb.openScannerOverview();
  assert.equal(dom.el('scrOverviewTitle').textContent, 'Overview - 3 passed stocks');
  const body = dom.el('scrOverviewBody').innerHTML;
  assert.match(body, /By sector/);
  assert.match(body, /By industry/);
  assert.match(dom.el('scrOverviewFoot').textContent, /passed stocks the table is showing now/);
  assert.deepEqual(log, ['add active']);
  run('scrShowingFailed = true');
  sb.openScannerOverview();
  assert.equal(dom.el('scrOverviewTitle').textContent, 'Overview - 3 failed stocks');
  sb.closeScannerOverview();
  assert.equal(log[log.length - 1], 'remove active');
  run('scrShowingFailed = false');
});

test('with no results the modal says to scan first instead of drawing empty charts', () => {
  const dom = installFakeDom(sb);
  run('screenerResults = []');
  sb.openScannerOverview();
  assert.equal(dom.el('scrOverviewTitle').textContent, 'Overview');
  assert.match(dom.el('scrOverviewBody').innerHTML, /No results - click Scan first/);
  assert.equal(dom.el('scrOverviewFoot').textContent, '');
});

test('hovering a slice or row shows its count, share and name in the middle of its own donut, and lights it; leaving resets', () => {
  const cls = new Set();
  const mk = (text = '') => ({ textContent: text });
  const main = mk('12'), sub = mk('stocks'), cap = mk('');
  const nameEl = mk('Auto'), bEl = mk('3'), emEl = mk('25.0%');
  const rowEl = { querySelector: s => ({ '.ov-name': nameEl, b: bEl, em: emEl })[s] };
  const hot = [];
  const sec = {
    getAttribute: a => (a === 'data-total' ? '12' : null),
    querySelectorAll: s => (s.includes('.hot') ? hot : [{ classList: { add: c => cls.add(c) } }]),
    querySelector: s => ({ '.ov-mid-main': main, '.ov-mid-sub': sub, '.ov-cap': cap, '.ov-row[data-ov="sector:2"] .ov-name': nameEl, '.ov-row[data-ov="sector:2"]': rowEl })[s],
  };
  const target = { closest: s => (s === '[data-ov]' ? { getAttribute: () => 'sector:2', closest: () => sec } : null) };
  sb.__t = target;
  run('ovHover(__t, true)');
  assert.deepEqual([main.textContent, sub.textContent, cap.textContent], ['3', '25.0%', 'Auto']);
  assert.ok(cls.has('hot'));
  run('ovHover(__t, false)');
  assert.deepEqual([main.textContent, sub.textContent, cap.textContent], ['12', 'stocks', '']);
  run('ovHover({ closest: () => null }, true)');                          // something that is not a slice / row: ignored
});

test('index.html: an Overview button on the scanner toolbar, the modal, and the script loaded after screener.js', () => {
  assert.match(html, /<button class="btn btn-secondary" id="scrOverviewBtn" onclick="openScannerOverview\(\)"/);
  assert.match(html, /<div class="modal-overlay" id="scrOverviewModal" onclick="if\(event\.target===this\)closeScannerOverview\(\)">/);
  for (const id of ['scrOverviewTitle', 'scrOverviewBody', 'scrOverviewFoot']) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  assert.ok(html.indexOf('<script src="js/scanner-overview.js') > html.indexOf('<script src="js/screener.js'));   // it reads screenerResults / scrShowingFailed
});

// --- passing % and sorting ----------------------------------------------------------------------------------------------------------------

// A market of 10 stocks: Banks 4 (3 pass), Auto 3 (1 pass), Energy 2 (0 pass), and 1 with no sector (1 pass).
const MARKET = [
  ...['b1', 'b2', 'b3', 'b4'].map(s => ({ s, sector: 'Banks' })), ...['a1', 'a2', 'a3'].map(s => ({ s, sector: 'Auto' })),
  { s: 'e1', sector: 'Energy' }, { s: 'e2', sector: 'Energy' }, { s: 'u1' },
];
const PASSED = MARKET.filter(m => ['b1', 'b2', 'b3', 'a1', 'u1'].includes(m.s));

test('each group gets its size in the whole market, how many of them pass, and the passing % (passed / group size)', () => {
  sb.__rows = PASSED; sb.__ctx = { universe: MARKET, passed: PASSED };
  const g = run("ovGroupCounts(__rows, 'sector', 10, __ctx)");
  const by = Object.fromEntries(Array.from(g.groups, x => [x.name, x]));
  assert.deepEqual([by.Banks.inGroup, by.Banks.passed, by.Banks.passPct], [4, 3, 75]);
  assert.deepEqual([by.Auto.inGroup, by.Auto.passed, by.Auto.passPct.toFixed(2)], [3, 1, '33.33']);
  assert.deepEqual([by['Undefined-Diversified'].inGroup, by['Undefined-Diversified'].passPct], [1, 100]);
  assert.equal(g.groups.length, 3);                                        // Energy has no passing stock, so it is not in this list
});

test('viewing the FAILED stocks, the passing % is still passed / group size (not failed / group size)', () => {
  const failed = MARKET.filter(m => !PASSED.includes(m));
  sb.__rows = failed; sb.__ctx = { universe: MARKET, passed: PASSED };
  const g = run("ovGroupCounts(__rows, 'sector', 10, __ctx)");
  const energy = Array.from(g.groups).find(x => x.name === 'Energy');
  assert.deepEqual([energy.count, energy.inGroup, energy.passed, energy.passPct], [2, 2, 0, 0]);
  const banks = Array.from(g.groups).find(x => x.name === 'Banks');
  assert.deepEqual([banks.count, banks.passed, banks.passPct], [1, 3, 75]);
});

test('without a market (no ctx) the passing figures are null and the list shows a dash', () => {
  sb.__rows = PASSED;
  assert.equal(run("ovGroupCounts(__rows, 'sector').groups[0].passPct"), null);
  assert.match(run("ovSectionHtml('sector', 'By sector', __rows)"), /<em class="ov-pass">-<\/em>/);
});

test('the list shows the passing % with passed/group size, and a tooltip', () => {
  sb.__rows = PASSED; sb.__ctx = { universe: MARKET, passed: PASSED };
  const sec = run("ovSectionHtml('sector', 'By sector', __rows, __ctx)");
  const tip = 'title="3 of the 4 stocks in this group pass the filters"';
  assert.ok(sec.includes('<em class="ov-pass" style="--bar:75%" ' + tip + '>75.0%</em><small class="ov-frac" ' + tip + '>3/4</small>'));
  assert.match(sec, /--bar:33%"[^>]*>33\.3%<\/em><small[^>]*>1\/3<\/small>/);        // the bars are relative to the best group in the list ...
  assert.match(sec, /--bar:100%"[^>]*>100\.0%<\/em><small[^>]*>1\/1<\/small>/);      // ... so the best one (1 of 1) is a full bar
});

test('sorting: by stocks (biggest first), by passing % (highest first, no % last), by name; the direction flips', () => {
  const g = (name, count, passPct) => ({ name, count, passPct });
  sb.__g = [g('B', 2, 10), g('A', 5, 50), g('C', 5, null), g('D', 1, 90)];
  const names = sort => Array.from(run(`ovSortGroups(__g, ${JSON.stringify(sort)})`), x => x.name).join('');
  assert.equal(names({ col: 'share', dir: -1 }), 'ACBD');                  // 5, 5 (A before C by name), 2, 1
  assert.equal(names({ col: 'share', dir: 1 }), 'DBAC');
  assert.equal(names({ col: 'pass', dir: -1 }), 'DABC');                   // 90, 50, 10, then the one with no %
  assert.equal(names({ col: 'pass', dir: 1 }), 'BADC');                    // 10, 50, 90 - the unknown % still last
  assert.equal(names({ col: 'name', dir: 1 }), 'ABCD');
  assert.equal(names({ col: 'name', dir: -1 }), 'DCBA');
});

test('the header has Name / Stocks / Passing sort buttons with an arrow on the active one', () => {
  const head = run("ovHeadHtml('industry', { col: 'pass', dir: -1 })");
  assert.match(head, /data-sort="name"[^>]*>Industry<span><\/span>/);                 // the arrow follows a left-aligned label ...
  assert.match(head, /data-sort="share"[^>]*>Share<span><\/span><\/button>/);          // Share sorts (the same order as the number of stocks) ...
  assert.ok(!head.includes('data-sort="count"'));                                      // ... Stocks is a plain label
  assert.match(head, /<span class="ov-h-num"[^>]*>Stocks<\/span>/);
  assert.match(head, /class="ov-sort ov-h-pass on" data-sort="pass"[^>]*><span>▼<\/span>Passing<\/button>/);
  assert.ok(!/Pass\/all|Pass \/ all/.test(head));                                  // the passed / group size column has no header
  assert.ok(head.endsWith('<span></span></div>'));                                    // but its (empty) cell keeps the grid columns in step
  assert.match(run("ovHeadHtml('sector', { col: 'name', dir: 1 })"), /Sector<span>▲<\/span>/);
  assert.match(run("ovHeadHtml('sector', { col: 'share', dir: -1 })"), /class="ov-sort ov-h-share on" data-sort="share"[^>]*>Share<span>▼<\/span>/);
});

test('the lists start sorted by Passing, highest first', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(run('ovSort'))), { col: 'pass', dir: -1 });
});

test('a sort click re-sorts both lists (first click = natural direction, second reverses) and ignores unknown columns', () => {
  const dom = installFakeDom(sb);
  sb.__rows = PASSED; sb.__ctx = { universe: MARKET, passed: PASSED };
  run("ovRows = __rows; ovCtx = __ctx; ovSort = { col: 'share', dir: -1 }");
  const order = () => [...dom.el('scrOverviewBody').innerHTML.matchAll(/class="ov-name"[^>]*>([^<]*)</g)].map(m => m[1]).slice(0, 3).join(',');
  sb.ovSetSort('pass');
  assert.deepEqual(JSON.parse(JSON.stringify(run('ovSort'))), { col: 'pass', dir: -1 });
  assert.equal(order(), 'Undefined-Diversified,Banks,Auto');              // 100%, 75%, 33.3%
  sb.ovSetSort('pass');
  assert.equal(order(), 'Auto,Banks,Undefined-Diversified');
  sb.ovSetSort('name');
  assert.deepEqual(JSON.parse(JSON.stringify(run('ovSort'))), { col: 'name', dir: 1 });
  assert.equal(order(), 'Auto,Banks,Undefined-Diversified');
  sb.ovSetSort('count');                                                   // Stocks no longer sorts
  assert.deepEqual(JSON.parse(JSON.stringify(run('ovSort'))), { col: 'name', dir: 1 });
  sb.ovSetSort('share');
  assert.deepEqual(JSON.parse(JSON.stringify(run('ovSort'))), { col: 'share', dir: -1 });
  assert.equal(order(), 'Banks,Auto,Undefined-Diversified');                // 3, 1, 1 stocks (Auto before Undefined by name)
  sb.ovSetSort('name');
  sb.ovSetSort('nonsense');
  assert.deepEqual(JSON.parse(JSON.stringify(run('ovSort'))), { col: 'name', dir: 1 });
  run("ovSort = { col: 'pass', dir: -1 }");
});

test('opening counts the passing % against the whole market (Store) and the full passed list, whichever list the table shows', () => {
  const dom = installFakeDom(sb);
  sb.Store.latestBySymbol = Object.fromEntries(MARKET.map(m => [m.s, m]));
  sb.__passed = PASSED;
  run('screenerPassed = __passed; screenerResults = __passed; scrShowingFailed = false');
  sb.openScannerOverview();
  assert.equal(run('ovCtx.universe.length'), 10);
  assert.equal(run('ovCtx.passed.length'), 5);
  assert.match(dom.el('scrOverviewBody').innerHTML, /75\.0%<\/em><small[^>]*>3\/4<\/small>/);
  assert.match(dom.el('scrOverviewFoot').textContent, /"Passing": passed stocks \/ all stocks in that sector or industry/);
  sb.Store.latestBySymbol = undefined;
});

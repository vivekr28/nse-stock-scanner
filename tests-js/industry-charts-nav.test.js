'use strict';
// js/industry-charts.js: opened from the Industry Analysis list, the popup loops through that list of industries - Up / Down on the Industry
// Chart and Money Flow tabs (Shift + Up / Down on any tab), or the < > buttons - on the tab that is showing, wrapping round at the ends.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { installFakeDom } = require('./fakedom');

const root = path.dirname(__dirname);
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// js/industry-charts.js in a page that keeps the keydown listeners it registers, so the real handler can be driven
const keydown = [];
const sb = { console, Store: { latestBySymbol: {}, dailyBySymbol: {}, dates: [] } };
sb.window = sb;
sb.document = { addEventListener: (t, f) => { if (t === 'keydown') keydown.push(f); }, removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
vm.createContext(sb);
// the file wires some elements at load time (getElementById(...).addEventListener), so the first load uses a page of stand-ins
installFakeDom(sb, {});
for (const f of ['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/chart-tools.js', 'js/industry-charts.js']) vm.runInContext(read(f), sb, { filename: f });
const dom = installFakeDom(sb, {});
const run = code => vm.runInContext(code, sb);

// the modal's class list is real, so the keydown handler sees it open / closed
const modalClasses = new Set();
dom.el('industryChartsModal').classList = { add: c => modalClasses.add(c), remove: c => modalClasses.delete(c), contains: c => modalClasses.has(c), toggle() {} };

// the tab content is built by chart code that is not under test: record which tab was asked for, and the disposals
let tabs = [], disposed = 0;
sb.icSwitchTab = tab => { tabs.push(tab); run(`icActiveTab = '${tab}'`); sb.icUpdateControlVisibility(); };
for (const n of ['icDisposeCharts', 'icDisposeIndustryChart', 'icDisposeMoneyFlowChart', 'icDisposeMfRocChart']) sb[n] = () => { disposed++; };

const LIST = ['Alpha', 'Beta', 'Gamma'];
const key = (k, extra = {}) => { const e = { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: {}, prevented: false, preventDefault() { this.prevented = true; }, ...extra }; keydown.forEach(f => f(e)); return e; };
const open = (name, list = LIST, tab) => { tabs = []; sb.openIndustryCharts(name, list, tab); };
const current = () => run('icIndustry');

test('opened with a list: the popup knows its place in it, and the < > bar shows "n of N industries"', () => {
  open('Beta');
  assert.equal(run('icIndIndex'), 1);
  assert.equal(dom.el('icIndNavWrap').style.display, '');
  assert.equal(dom.el('icIndNavInfo').textContent, '2 of 3 industries');
  assert.deepEqual(tabs, ['stocks']);                 // it still opens on the Stock Charts tab
});

test('opened without a list (the Stock Scanner industry link), or from a one-industry list: no stepping and the bar is hidden', () => {
  sb.openIndustryCharts('Beta');
  assert.equal(dom.el('icIndNavWrap').style.display, 'none');
  open('Beta', ['Beta']);
  assert.equal(run('icIndList.length'), 0);
  assert.equal(dom.el('icIndNavWrap').style.display, 'none');
  open('Nowhere', LIST);                              // a name that is not in the list: nothing to step through
  assert.equal(run('icIndList.length'), 0);
});

test('Down / Up on the Industry Chart tab go to the next / previous industry and stay on that tab', () => {
  open('Alpha', LIST, 'industry');
  disposed = 0;
  let e = key('ArrowDown');
  assert.equal(e.prevented, true);
  assert.equal(current(), 'Beta');
  assert.deepEqual(tabs, ['industry', 'industry']);   // re-opened on the same tab
  assert.ok(disposed >= 4, 'the previous industry\'s charts are released first');
  key('ArrowDown');
  assert.equal(current(), 'Gamma');
  key('ArrowUp');
  assert.equal(current(), 'Beta');
  assert.equal(dom.el('icIndNavInfo').textContent, '2 of 3 industries');
});

test('it loops: Down on the last industry goes to the first, Up on the first goes to the last', () => {
  open('Gamma', LIST, 'industry');
  key('ArrowDown');
  assert.equal(current(), 'Alpha');
  key('ArrowUp');
  assert.equal(current(), 'Gamma');
});

test('the Money Flow tab steps the same way', () => {
  open('Alpha', LIST, 'moneyflow');
  key('ArrowDown');
  assert.equal(current(), 'Beta');
  assert.equal(tabs[tabs.length - 1], 'moneyflow');
});

test('on the Stock Charts tab plain Up / Down still page through the stocks; Shift + Up / Down step industries', () => {
  open('Alpha');
  sb.icStocks = [];
  let paged = 0;
  sb.icNextPage = () => { paged++; };
  key('ArrowDown');
  assert.equal(paged, 1);
  assert.equal(current(), 'Alpha');
  key('ArrowDown', { shiftKey: true });
  assert.equal(paged, 1);
  assert.equal(current(), 'Beta');
  assert.equal(tabs[tabs.length - 1], 'stocks');
});

test('the < > buttons call icStepIndustry, and without a list nothing happens (Industry Chart tab: arrows do nothing as before)', () => {
  open('Alpha', LIST, 'industry');
  sb.icStepIndustry(1);
  assert.equal(current(), 'Beta');
  sb.icStepIndustry(-1); sb.icStepIndustry(-1);
  assert.equal(current(), 'Gamma');
  sb.openIndustryCharts('Alpha');                     // no list
  run("icActiveTab = 'industry'");
  const e = key('ArrowDown');
  assert.equal(e.prevented, false);
  assert.equal(current(), 'Alpha');
});

test('closing the popup forgets the list; a closed popup ignores the keys', () => {
  open('Alpha', LIST, 'industry');
  sb.closeIndustryCharts();
  assert.equal(run('icIndList.length'), 0);
  key('ArrowDown');
  assert.equal(current(), 'Alpha');
});

test('single-stock mode is untouched by a stale list', () => {
  open('Alpha', LIST, 'industry');
  run("icMode = 'single'");
  sb.icUpdateControlVisibility();
  assert.equal(dom.el('icIndNavWrap').style.display, 'none');
  sb.icStepIndustry(1);
  assert.equal(current(), 'Alpha');
  run("icMode = 'industry'");
});

test('wiring: Industry Analysis passes the table\'s order (_indBreakdownNames) from its table rows and heatmap cards; index.html has the bar', () => {
  const ind = read('js/industry.js');
  assert.equal((ind.match(/openIndustryCharts\('\$\{ind\.name\.replace\(\/'\/g, "\\\\'"\)\}', _indBreakdownNames\)/g) || []).length, 2);
  const html = read('index.html');
  assert.match(html, /id="icIndNavWrap"/);
  assert.match(html, /onclick="icStepIndustry\(-1\)"/);
  assert.match(html, /onclick="icStepIndustry\(1\)"/);
});

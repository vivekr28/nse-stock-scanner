'use strict';
// The Checklist tab (js/checklist.js): the rules list is drawn from CHECKLIST_RULES into #checklistRoot
// (numbered, two columns, verdict at the end) and the tab / panel / script are wired in index.html.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(path.dirname(__dirname), f), 'utf8');

// A tiny element tree: enough for checklistRender (createElement / appendChild / textContent / className).
function node(tag) {
  const n = { tag, className: '', _text: '', children: [] };
  n.appendChild = c => { n.children.push(c); return c; };
  Object.defineProperty(n, 'textContent', {
    get: () => n._text + n.children.map(c => c.textContent).join(''),
    set: v => { n._text = v; if (v === '') n.children = []; },
  });
  return n;
}
function render() {
  const root = node('div');
  const document = { getElementById: id => (id === 'checklistRoot' ? root : null), createElement: node };
  const sb = { document };
  vm.createContext(sb);
  vm.runInContext(read('js/checklist.js') + '\n;this.RULES = CHECKLIST_RULES;', sb);
  return { root, rules: sb.RULES };
}
const all = (n, cls, out = []) => { if ((n.className || '').split(' ').includes(cls)) out.push(n); n.children.forEach(c => all(c, cls, out)); return out; };

test('every rule is drawn once, numbered in order, with its text', () => {
  const { root, rules } = render();
  assert.equal(rules.length, 7);
  const items = all(root, 'cl-item');
  assert.equal(items.length, rules.length);
  const titles = all(root, 'cl-rule-title').map(n => n.textContent);
  rules.forEach((r, i) => assert.equal(titles[i], (i + 1) + ' · ' + r.title));
  assert.match(titles[2], /Liquidity/);
  assert.match(root.textContent, /₹25 crore/);
});

test('rules split over two columns (4 + 3) and the verdict closes the right-hand one', () => {
  const { root } = render();
  const cols = all(root, 'cl-col');
  assert.equal(cols.length, 2);
  assert.equal(all(cols[0], 'cl-item').length, 4);
  assert.equal(all(cols[1], 'cl-item').length, 3);
  assert.equal(all(cols[1], 'cl-verdict').length, 1);
  assert.match(all(cols[1], 'cl-verdict')[0].textContent, /No exceptions on quality/);
});

test('tab button, panel, root and script tag are in index.html', () => {
  const html = read('index.html');
  assert.match(html, /<div class="tab" data-tab="checklist">Checklist<\/div>/);
  assert.match(html, /<div id="panel-checklist" class="panel">/);
  assert.match(html, /id="checklistRoot"/);
  assert.match(html, /<script src="js\/checklist\.js\?v=\d+"><\/script>/);
});

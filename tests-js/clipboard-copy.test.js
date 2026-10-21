'use strict';
// js/utils.js: copyTextToClipboard / copyNamesToClipboard - what the "Copy industries" buttons on the Industry Analysis tab use.
// The names go out as ONE comma-separated line, the way the scanner's TradingView watchlist copy writes its industry headers (a comma
// inside a name becomes a space there too), and the button says "Copied 12 ✓" for a moment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/utils.js']);

function fakeButton(label = 'Copy industries') { return { dataset: {}, textContent: label }; }
function withClipboard(write) {
  const timers = [];
  sb.navigator = { clipboard: { writeText: write } };
  sb.setTimeout = (fn, ms) => { timers.push({ fn, ms }); };
  return timers;
}
function cleanup() { delete sb.navigator; delete sb.setTimeout; }

test('copyTextToClipboard: uses navigator.clipboard and resolves true / false', async () => {
  let got = null;
  sb.navigator = { clipboard: { writeText: t => { got = t; return Promise.resolve(); } } };
  assert.equal(await sb.copyTextToClipboard('hello'), true);
  assert.equal(got, 'hello');
  sb.navigator = { clipboard: { writeText: () => Promise.reject(new Error('blocked')) } };
  assert.equal(await sb.copyTextToClipboard('hello'), false);
  cleanup();
});

test('copyTextToClipboard: without navigator.clipboard it falls back to a hidden textarea and execCommand("copy")', async () => {
  const calls = [];
  const ta = { style: {}, select() { calls.push('select'); } };
  sb.document.createElement = tag => { calls.push('create:' + tag); return ta; };
  sb.document.body = { appendChild: () => calls.push('append'), removeChild: () => calls.push('remove') };
  sb.document.execCommand = cmd => { calls.push('exec:' + cmd); return true; };
  assert.equal(await sb.copyTextToClipboard('abc'), true);
  assert.equal(ta.value, 'abc');
  assert.deepEqual(calls, ['create:textarea', 'append', 'select', 'exec:copy', 'remove']);
  sb.document.execCommand = () => false;
  assert.equal(await sb.copyTextToClipboard('abc'), false);
  sb.document.execCommand = () => { throw new Error('nope'); };
  assert.equal(await sb.copyTextToClipboard('abc'), false);
});

test('copyNamesToClipboard: one comma-separated line, a comma inside a name becomes a space (as the watchlist copy does), in the order given', async () => {
  let clip = null;
  const timers = withClipboard(t => { clip = t; return Promise.resolve(); });
  const ok = await sb.copyNamesToClipboard(['Private Sector Bank', 'Gems, Jewellery And Watches', 'Media & Entertainment', 'Residential,Commercial Projects'], fakeButton());
  assert.equal(ok, true);
  assert.equal(clip, 'Private Sector Bank,Gems Jewellery And Watches,Media & Entertainment,Residential Commercial Projects');
  assert.equal(timers.length, 1);
  cleanup();
});

test('copyNamesToClipboard: the button says "Copied N ✓" and goes back to its own label', async () => {
  const timers = withClipboard(() => Promise.resolve());
  const btn = fakeButton();
  await sb.copyNamesToClipboard(['A', 'B', 'C'], btn);
  assert.equal(btn.textContent, 'Copied 3 ✓');
  assert.equal(timers[0].ms, 1500);
  timers[0].fn();
  assert.equal(btn.textContent, 'Copy industries');
  await sb.copyNamesToClipboard(['A'], btn);                       // a second copy remembers the ORIGINAL label, not "Copied 3 ✓"
  timers[1].fn();
  assert.equal(btn.textContent, 'Copy industries');
  cleanup();
});

test('copyNamesToClipboard: a refused copy says "Copy failed"; an empty list says "Nothing to copy" and does not touch the clipboard', async () => {
  let writes = 0;
  const timers = withClipboard(() => { writes++; return Promise.reject(new Error('denied')); });
  const btn = fakeButton();
  assert.equal(await sb.copyNamesToClipboard(['A'], btn), false);
  assert.equal(btn.textContent, 'Copy failed');
  timers[0].fn();
  assert.equal(btn.textContent, 'Copy industries');
  writes = 0;
  assert.equal(await sb.copyNamesToClipboard([], btn), false);
  assert.equal(btn.textContent, 'Nothing to copy');
  assert.equal(writes, 0);
  assert.equal(await sb.copyNamesToClipboard(['A'], null).catch(() => 'threw'), false, 'no button: still fine');
  cleanup();
});

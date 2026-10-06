'use strict';
// The As of Date tab's controls (asof* ids, incl. its dates) are saved in / restored from scanner presets like the other
// tabs', and loading a preset that has As of Date filters on runs the as-of scan instead of the normal one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');
const { installFakeDom } = require('./fakedom');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/breadth.js', 'js/screener.js', 'js/presets.js', 'js/asof-scan.js']);
const html = fs.readFileSync(path.join(path.dirname(__dirname), 'index.html'), 'utf8');
const htmlAsofIds = [...html.matchAll(/\bid="(asof[A-Za-z0-9]+)"/g)].map(m => m[1]).filter(id => !['asofDateNote', 'asofStatus'].includes(id));
const fields = vm.runInContext('PRESET_FIELDS', sb);
const defaults = vm.runInContext('DEFAULT_FILTER_STATE', sb);

test('every As of Date input in the page is a preset field with a default, and nothing else is', () => {
  const presetAsof = Array.from(fields, f => f.id).filter(id => id.startsWith('asof')).sort();
  assert.deepEqual(presetAsof, [...htmlAsofIds].sort());
  for (const id of htmlAsofIds) assert.ok(id in defaults, `${id} has no default`);
  assert.deepEqual(Object.keys(defaults).filter(k => k.startsWith('asof')).sort(), [...htmlAsofIds].sort());
});

test('field types match the controls (checkbox / number / select / date)', () => {
  const type = id => fields.find(f => f.id === id).type;
  assert.equal(type('asofAOn'), 'checkbox');
  assert.equal(type('asofBVal'), 'number');
  assert.equal(type('asofHPeriod'), 'select');
  assert.equal(type('asofDate'), 'date');
  assert.equal(type('asofKFromDate'), 'date');
});

test('capture then apply round-trips the As of Date tab, including its dates', () => {
  const dom = installFakeDom(sb, {});
  for (const f of fields) { if (f.type === 'checkbox') dom.el(f.id).checked = false; }
  dom.el('asofDate').value = '2026-04-02'; dom.el('asofAOn').checked = true; dom.el('asofAE200').checked = true;
  dom.el('asofBVal').value = '4.5'; dom.el('asofHPeriod').value = '63'; dom.el('asofKFromDate').value = '2026-01-01'; dom.el('asofJOn').checked = true; dom.el('asofJ5').checked = false;
  const saved = JSON.parse(JSON.stringify(sb.capturePresetState()));
  assert.equal(saved.asofDate, '2026-04-02');
  assert.equal(saved.asofAOn, true);
  assert.equal(saved.asofJ5, false);

  // change everything, then restore from the saved state
  const dom2 = installFakeDom(sb, {});
  sb.applyPresetState(JSON.parse(JSON.stringify(defaults)));
  assert.equal(dom2.el('asofDate').value, '');
  assert.equal(dom2.el('asofAOn').checked, false);
  sb.applyPresetState(saved);
  assert.equal(dom2.el('asofDate').value, '2026-04-02');
  assert.equal(dom2.el('asofAOn').checked, true);
  assert.equal(dom2.el('asofAE200').checked, true);
  assert.equal(dom2.el('asofBVal').value, '4.5');
  assert.equal(dom2.el('asofHPeriod').value, '63');
  assert.equal(dom2.el('asofKFromDate').value, '2026-01-01');
  assert.equal(dom2.el('asofJ5').checked, false);
});

test('an older preset (no As of Date keys) leaves the tab alone when applied alone, and switches it off after the defaults', () => {
  const dom = installFakeDom(sb, {});
  dom.el('asofAOn').checked = true; dom.el('asofDate').value = '2026-04-02';
  sb.applyPresetState({ scrF1On: true });                       // a preset applied on its own does not mention asof*
  assert.equal(dom.el('asofAOn').checked, true);
  // what loadPreset does: defaults first, then the preset
  sb.applyPresetState(JSON.parse(JSON.stringify(defaults)));
  sb.applyPresetState({ scrF1On: true });
  assert.equal(dom.el('asofAOn').checked, false);
  assert.equal(dom.el('asofDate').value, '');
});

test('the existing filters\' preset state is unaffected: same scrF fields captured and restored as before', () => {
  const scrFields = Array.from(fields, f => f.id).filter(id => id.startsWith('scr'));
  assert.equal(scrFields.length, 66);                          // the existing controls (matches the 66 keys in a saved preset): 64 plus the Listed Date filter's two
  assert.ok(scrFields.includes('scrF18_52w') && scrFields.includes('scrF16ToDate') && scrFields.includes('scrAllowPartial'));
});

// ─── loading a preset ───────────────────────────────────────────────────────────

function loadWith(state) {
  const dom = installFakeDom(sb, {});
  vm.runInContext('_presets = {}', sb);
  sb.__p = JSON.parse(JSON.stringify(state));
  vm.runInContext("_presets['P'] = __p", sb);
  dom.el('scrPresetSelect').value = 'P';
  const calls = [];
  sb.runScreener = () => calls.push('screener');
  sb.asOfRun = opts => calls.push(opts && opts.keepOpen ? 'asof:keepOpen' : 'asof');
  sb.updateFilterBadge = () => {};
  sb.loadPreset();
  return calls;
}

test('loading a preset with an As of Date filter on runs the as-of scan and keeps the popup open', () => {
  assert.deepEqual(loadWith({ asofDate: '2026-04-02', asofAOn: true }), ['asof:keepOpen']);
});

test('loading a preset with no As of Date filter on runs the normal scan, as before', () => {
  assert.deepEqual(loadWith({ scrF1On: true }), ['screener']);
  assert.deepEqual(loadWith({ asofDate: '2026-04-02' }), ['screener']);   // a date alone is not an as-of scan
});

test('asOfPresetActive: true when any of the As of Date switches is on', () => {
  const dom = installFakeDom(sb, {});
  assert.equal(sb.asOfPresetActive(), false);
  dom.el('asofKOn').checked = true;
  assert.equal(sb.asOfPresetActive(), true);
});

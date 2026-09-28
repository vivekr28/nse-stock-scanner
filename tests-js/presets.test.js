'use strict';
// Tests for js/presets.js's handling of the F17 (Industry Money Flow Rate of Change)
// filter's ROC timeframe, `scrF17Lag`: capturing it into a preset, restoring it, and the
// fallback for presets saved before that field existed. Same vm-sandbox approach as the
// other tests-js files; document.getElementById is replaced with plain-object stand-ins
// for just the F17 controls (applyPresetState/capturePresetState only touch .value/.checked).
//
// js/presets.js ends with an async initPresets() IIFE that runs at load; in the sandbox its
// fetch/IndexedDB calls fail inside their own try/catch and it falls through to an empty
// preset list, so it's harmless here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/presets.js']);
const { applyPresetState, capturePresetState } = sb;

function fakeF17Controls() {
  const els = {
    scrF17On: { checked: false },
    scrF17Period: { value: '3m' },
    scrF17Lag: {
      value: '3m',
      options: ['1w', '1m', '3m', '6m', '1y'].map(v => ({ value: v, disabled: false, hidden: false })),
    },
    scrF17Val: { value: '0' },
  };
  sb.document.getElementById = id => els[id];
  return els;
}

test('capturePresetState: includes the F17 ROC timeframe', () => {
  const els = fakeF17Controls();
  els.scrF17Period.value = '6m';
  els.scrF17Lag.value = '1m';
  const state = capturePresetState();
  assert.equal(state.scrF17Period, '6m');
  assert.equal(state.scrF17Lag, '1m');
});

test('applyPresetState: restores the saved ROC timeframe', () => {
  const els = fakeF17Controls();
  applyPresetState({ scrF17On: true, scrF17Period: '6m', scrF17Lag: '1w', scrF17Val: '20' });
  assert.equal(els.scrF17On.checked, true);
  assert.equal(els.scrF17Period.value, '6m');
  assert.equal(els.scrF17Lag.value, '1w');
  assert.equal(els.scrF17Val.value, '20');
});

test('applyPresetState: a preset saved before the ROC timeframe existed falls back to lag = window', () => {
  const els = fakeF17Controls();
  // Old presets have no scrF17Lag key; they compared against exactly one window ago.
  applyPresetState({ scrF17On: true, scrF17Period: '6m', scrF17Val: '0' });
  assert.equal(els.scrF17Lag.value, '6m');
  applyPresetState({ scrF17On: true, scrF17Period: '1y', scrF17Val: '0' });
  assert.equal(els.scrF17Lag.value, '1y');
});

test('applyPresetState: a saved timeframe longer than the window snaps down to the window', () => {
  const els = fakeF17Controls();
  applyPresetState({ scrF17Period: '3m', scrF17Lag: '6m' });
  assert.equal(els.scrF17Lag.value, '3m');
});

test('applyPresetState: syncs which timeframe options are enabled for the restored window', () => {
  const els = fakeF17Controls();
  applyPresetState({ scrF17Period: '3m', scrF17Lag: '1m' });
  assert.deepEqual(els.scrF17Lag.options.filter(o => o.disabled).map(o => o.value), ['6m', '1y']);
  assert.equal(els.scrF17Lag.value, '1m');
});

test('applyPresetState: a preset that does not mention F17 leaves the controls alone', () => {
  const els = fakeF17Controls();
  els.scrF17Period.value = '6m';
  els.scrF17Lag.value = '1m';
  applyPresetState({ scrF1On: true });
  assert.equal(els.scrF17Period.value, '6m');
  assert.equal(els.scrF17Lag.value, '1m');
});

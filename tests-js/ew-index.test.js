'use strict';
// Shared chart helpers in js/ew-index.js that the EW Index, Market Breadth and Market Overview charts all use.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/ew-index.js']);
const { ewFitWithRightPad, ewToBusinessDay, ewComputeSMA } = sb;

test('ewFitWithRightPad: sets the 10-bar right offset BEFORE fitting (fitContent fits to last bar + rightOffset)', () => {
  const calls = [];
  const chart = { timeScale: () => ({
    applyOptions: (o) => calls.push(['applyOptions', JSON.parse(JSON.stringify(o))]),
    fitContent: () => calls.push(['fitContent']),
  }) };
  ewFitWithRightPad(chart);
  assert.deepEqual(calls, [['applyOptions', { rightOffset: 10 }], ['fitContent']]);
});

test('ewToBusinessDay: "12-Sep-2025" -> {year, month, day}', () => {
  const d = ewToBusinessDay('12-Sep-2025');
  assert.deepEqual([d.year, d.month, d.day], [2025, 9, 12]);
  assert.equal(ewToBusinessDay('01-Jan-2024').month, 1);
  assert.equal(ewToBusinessDay('31-Dec-2024').month, 12);
});

test('ewToBusinessDay: malformed input -> null', () => {
  assert.equal(ewToBusinessDay(''), null);
  assert.equal(ewToBusinessDay(undefined), null);
  assert.equal(ewToBusinessDay('2025-09-12'), null);
  assert.equal(ewToBusinessDay('12-Foo-2025'), null);
});

test('ewComputeSMA: one value per full window, rolling average', () => {
  assert.deepEqual(Array.from(ewComputeSMA([1, 2, 3, 4, 5], 3)), [2, 3, 4]);
  assert.deepEqual(Array.from(ewComputeSMA([1, 2], 3)), [], 'fewer bars than the window -> nothing');
});

'use strict';
// js/dq-pipeline.js dqPipelineState(): the pure rules behind the Data Quality "where am I / what next" panel.
// `now` is injected so the date rules are deterministic. Dates in the data are 'YYYY-MM-DD'; the server stamps checks and
// runs as 'YYYY-MM-DD HH:mm'.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/dq-pipeline.js']);
const TUE_3PM = new Date(2026, 10, 10, 15, 0);      // Tuesday 10-Nov-2026, 15:00 - Monday's file is the newest expected
const TUE_8PM = new Date(2026, 10, 10, 20, 0);      // after the evening cut-off: today's file is expected too
const SUN = new Date(2026, 10, 8, 12, 0);           // Sunday: Friday's file is the newest expected

// Everything done: data current, nothing listed, all verified, a recent clean full run.
const base = () => ({
  latestDate: '2026-11-09', unadjusted: [], adjustedStocks: 5,
  verify: { pending: 0, major: 0, minor: 0, match: 5, inconclusive: 0, lastVerifiedAt: '2026-11-10 14:00' },
  full: { finishedAt: '2026-11-10 12:00', complete: true, dataDate: '2026-11-09', match: 100, minor: 0, major: 0 },
  fullRunning: false, lastCorrectionAt: null,
});
const run = (over, now = TUE_3PM) => sb.dqPipelineState({ ...base(), ...over }, now);
const status = (st, id) => st.steps.find(s => s.id === id).status;

test('everything current: up to date, nothing to do, no next step', () => {
  const st = run({});
  assert.deepEqual(Array.from(st.steps, s => s.status), ['done', 'done', 'done', 'done']);
  assert.equal(st.next, null);
  assert.equal(st.upToDate, true);
});

test('step 1: data older than the newest expected day -> Refresh is next', () => {
  const st = run({ latestDate: '2026-11-06' });
  assert.equal(status(st, 'refresh'), 'todo');
  assert.equal(st.next.id, 'refresh');
  assert.match(st.steps[0].detail, /Data ends 06-Nov-2026/);
});

test('step 1: before 19:00 today the previous weekday is expected, after 19:00 today is', () => {
  assert.equal(status(run({ latestDate: '2026-11-09' }, TUE_3PM), 'refresh'), 'done');
  assert.equal(status(run({ latestDate: '2026-11-09' }, TUE_8PM), 'refresh'), 'todo');
  assert.equal(status(run({ latestDate: '2026-11-10' }, TUE_8PM), 'refresh'), 'done');
});

test('step 1: on a weekend the Friday file is the newest expected', () => {
  assert.equal(status(run({ latestDate: '2026-11-06' }, SUN), 'refresh'), 'done');
});

test('step 1: a weekend special session in the data never counts as behind', () => {
  assert.equal(status(run({ latestDate: '2026-11-08' }, new Date(2026, 10, 9, 10, 0)), 'refresh'), 'done');
});

test('step 1: no data at all asks for a refresh', () => {
  assert.equal(status(run({ latestDate: null }), 'refresh'), 'todo');
});

test('step 2: a listed event never checked on TradingView -> Adjust is next, naming the stock', () => {
  const st = run({ unadjusted: [{ symbol: 'NEWCO', exDate: '2026-11-09', status: null, checkedAt: null }] });
  assert.equal(status(st, 'adjust'), 'todo');
  assert.equal(st.next.id, 'adjust');
  assert.match(st.steps[1].detail, /1 new corporate action not yet checked on TradingView \(NEWCO\)/);
});

test('step 2: events TradingView was asked about recently and does not adjust are not a to-do', () => {
  const st = run({ unadjusted: [{ symbol: 'A', exDate: 'x', status: 'tv-unadjusted', checkedAt: '2026-11-10 14:17' }] });
  assert.equal(status(st, 'adjust'), 'done');
  assert.match(st.steps[1].detail, /checked recently.*does not adjust it.*re-check from 17-Nov-2026/);
});

test('step 2: a "no adjustment" answer older than 7 days is asked again (TradingView may have caught up)', () => {
  const st = run({ unadjusted: [{ symbol: 'A', exDate: 'x', status: 'tv-unadjusted', checkedAt: '2026-10-10 14:17' }] });
  assert.equal(status(st, 'adjust'), 'todo');
  assert.match(st.steps[1].detail, /more than 7 days ago/);
});

test('step 2: inconclusive checks follow the same re-check rule', () => {
  assert.equal(status(run({ unadjusted: [{ symbol: 'A', exDate: 'x', status: 'inconclusive', checkedAt: '2026-11-09 10:00' }] }), 'adjust'), 'done');
  assert.equal(status(run({ unadjusted: [{ symbol: 'A', exDate: 'x', status: 'inconclusive', checkedAt: '2026-10-01 10:00' }] }), 'adjust'), 'todo');
});

test('step 3: stocks awaiting verification -> Verify is next (when step 2 is clear)', () => {
  const st = run({ verify: { pending: 3, major: 0, minor: 0, match: 2, inconclusive: 0 } });
  assert.equal(status(st, 'verify'), 'todo');
  assert.equal(st.next.id, 'verify');
  assert.match(st.steps[2].detail, /3 price-adjusted stocks not verified yet. Click Verify against TradingView/);
});

test('step 3 waits for step 2 when both have work, so Adjust comes first', () => {
  const st = run({
    unadjusted: [{ symbol: 'NEWCO', exDate: 'x', status: null, checkedAt: null }],
    verify: { pending: 3, major: 0, minor: 0, match: 2, inconclusive: 0 },
  });
  assert.equal(status(st, 'adjust'), 'todo');
  assert.equal(status(st, 'verify'), 'later');
  assert.equal(st.next.id, 'adjust');
});

test('step 3: a major difference after verifying needs attention', () => {
  const st = run({ verify: { pending: 0, major: 2, minor: 0, match: 3, inconclusive: 0 } });
  assert.equal(status(st, 'verify'), 'attention');
  assert.equal(st.next.id, 'verify');
  assert.match(st.steps[2].detail, /2 stocks differ materially/);
});

test('step 3: minor differences alone do not need action', () => {
  const st = run({ verify: { pending: 0, major: 0, minor: 8, match: 276, inconclusive: 0 }, adjustedStocks: 284 });
  assert.equal(status(st, 'verify'), 'done');
  assert.match(st.steps[2].detail, /All 284 price-adjusted stocks verified: 276 match, 8 minor/);
});

test('step 3: no price-adjusted stocks means nothing to verify', () => {
  assert.equal(status(run({ adjustedStocks: 0, verify: { pending: 0, major: 0, minor: 0, match: 0, inconclusive: 0 } }), 'verify'), 'done');
});

test('step 4 is optional and never blocks: a never-run audit is suggested but nothing is "next"', () => {
  const st = run({ full: null });
  assert.equal(status(st, 'audit'), 'optional');
  assert.equal(st.next, null);
  assert.equal(st.upToDate, true);
});

test('step 4: a full run older than a week is suggested again', () => {
  const st = run({ full: { finishedAt: '2026-10-21 18:58', complete: true, dataDate: '2026-10-21', match: 90, minor: 1, major: 0 } });
  assert.equal(status(st, 'audit'), 'optional');
  assert.match(st.steps[3].detail, /19 days ago/);
});

test('step 4: a recent clean full run is done', () => {
  assert.equal(status(run({}), 'audit'), 'done');
});

test('step 4: a stopped run asks to resume', () => {
  const st = run({ full: { finishedAt: null, complete: false, dataDate: '2026-11-09', match: 10, minor: 0, major: 0 } });
  assert.equal(status(st, 'audit'), 'optional');
  assert.match(st.steps[3].detail, /Resume/);
});

test('step 4: major rows in the full table that predate the corrections are explained as an old snapshot, not an alarm', () => {
  const st = run({
    full: { finishedAt: '2026-11-10 15:21', complete: true, dataDate: '2026-11-09', match: 2517, minor: 43, major: 3 },
    lastCorrectionAt: '2026-11-10 15:27',
  });
  assert.equal(status(st, 'audit'), 'optional');
  assert.match(st.steps[3].detail, /older than the corrections you applied/);
  assert.equal(st.next, null);
});

test('step 4: major differences found after the last correction need attention', () => {
  const st = run({
    full: { finishedAt: '2026-11-10 15:21', complete: true, dataDate: '2026-11-09', match: 2517, minor: 43, major: 3 },
    lastCorrectionAt: '2026-11-10 09:00',
  });
  assert.equal(status(st, 'audit'), 'attention');
  assert.equal(st.next.id, 'audit');
});

test('step 4 while running says so', () => {
  assert.match(run({ fullRunning: true }).steps[3].detail, /running now/);
});

test('the next step is always the first one in order that needs doing', () => {
  const st = run({
    latestDate: '2026-11-06',
    unadjusted: [{ symbol: 'NEWCO', exDate: 'x', status: null, checkedAt: null }],
    verify: { pending: 1, major: 0, minor: 0, match: 4, inconclusive: 0 },
  });
  assert.equal(st.next.id, 'refresh');
  assert.deepEqual(Array.from(st.steps, s => s.status), ['todo', 'todo', 'later', 'done']);
});

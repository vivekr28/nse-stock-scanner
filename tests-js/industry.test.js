'use strict';
// Phase 8: tests for js/industry.js's RS scoring and money-flow computation, plus the
// shared computeRSScores() in js/utils.js (the same function screener.js's F9 filter also
// calls - see AGENT.md's "RS-score formula de-duplicated" note - so this also guards that
// other call site). Same JS track as Phase 7 (Node's built-in test runner).
//
// Unlike screener.js's target functions, computeIndustryMoneyFlow/computeAllPeriodsMoneyFlow
// read Store directly rather than taking it as a parameter - the vm sandbox's `Store` is a
// plain mutable object (see load.js), so tests populate `Store.dates`/`Store.dailyBySymbol`/
// `Store.latestBySymbol` before calling them, the same way the real page's data load does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadScripts } = require('./load');

const sb = loadScripts(['js/utils.js', 'js/industry.js']);
const { computeRSScores, computeIndustryMoneyFlow, computeAllPeriodsMoneyFlow, mfPctChange, Store } = sb;

function resetStore() {
  Store.dates = [];
  Store.dailyBySymbol = {};
  Store.latestBySymbol = {};
}

// ─── computeRSScores ────────────────────────────────────────────────────────────

test('computeRSScores: empty list is a safe no-op', () => {
  const list = [];
  computeRSScores(list);
  assert.deepEqual(list, []);
});

test('computeRSScores: a single industry gets the neutral rank (50) on everything', () => {
  const list = [{ name: 'Solo', breadth: 10, avgMonthlyChange: -5, avgDist52H: 30 }];
  computeRSScores(list);
  assert.equal(list[0].breadth_rank, 50);
  assert.equal(list[0].avgMonthlyChange_rank, 50);
  assert.equal(list[0].avgDist52H_rank, 50);
  assert.equal(list[0].rsScore, 50);
});

test('computeRSScores: ranks and the weighted 40/30/30 score, hand-derived', () => {
  // breadth (higher better): A=10, B=50, C=90 -> ranks 0, 50, 100
  // avgMonthlyChange (higher better): A=5, B=2, C=8 -> ranks 50, 0, 100
  // avgDist52H (LOWER better - closer to the 52W high): A=1, B=10, C=5 -> ranks 100, 0, 50
  const list = [
    { name: 'A', breadth: 10, avgMonthlyChange: 5, avgDist52H: 1 },
    { name: 'B', breadth: 50, avgMonthlyChange: 2, avgDist52H: 10 },
    { name: 'C', breadth: 90, avgMonthlyChange: 8, avgDist52H: 5 },
  ];
  computeRSScores(list);
  const byName = Object.fromEntries(list.map(i => [i.name, i]));

  assert.equal(byName.A.breadth_rank, 0);
  assert.equal(byName.B.breadth_rank, 50);
  assert.equal(byName.C.breadth_rank, 100);

  assert.equal(byName.A.avgDist52H_rank, 100); // smallest distance -> best -> highest rank
  assert.equal(byName.B.avgDist52H_rank, 0);   // largest distance -> worst -> lowest rank

  // rsScore = breadth*0.4 + avgMonthlyChange*0.3 + avgDist52H*0.3
  assert.equal(byName.A.rsScore, 0 * 0.4 + 50 * 0.3 + 100 * 0.3);  // 45
  assert.equal(byName.B.rsScore, 50 * 0.4 + 0 * 0.3 + 0 * 0.3);    // 20
  assert.equal(byName.C.rsScore, 100 * 0.4 + 100 * 0.3 + 50 * 0.3); // 85
});

// ─── computeIndustryMoneyFlow ────────────────────────────────────────────────────

test('computeIndustryMoneyFlow: splits turnover into back-to-back current/previous windows', () => {
  resetStore();
  const dates = Array.from({ length: 10 }, (_, i) => `day${i + 1}`);
  Store.dates = dates;
  Store.dailyBySymbol = { X: dates.map(d => ({ date: d, turnover: 10 })) };

  const res = computeIndustryMoneyFlow('1w'); // numDays=5, only 10 dates available
  assert.equal(res.currentDays, 5);
  assert.equal(res.prevDays, 5);
  assert.equal(res.current.X, 50); // last 5 days * 10
  assert.equal(res.previous.X, 50); // the 5 days before that
});

test('computeIndustryMoneyFlow: previous window is empty when there is no history before the current one', () => {
  resetStore();
  const dates = ['d1', 'd2', 'd3'];
  Store.dates = dates;
  Store.dailyBySymbol = { X: dates.map(d => ({ date: d, turnover: 10 })) };

  const res = computeIndustryMoneyFlow('1w'); // numDays=5 > 3 available - all 3 become "current"
  assert.equal(res.currentDays, 3);
  assert.equal(res.prevDays, 0);
  assert.equal(res.current.X, 30);
  assert.equal(res.previous.X, 0);
});

test('computeIndustryMoneyFlow: unknown period defaults to 126 trading days (6m)', () => {
  resetStore();
  const dates = Array.from({ length: 130 }, (_, i) => `d${i}`);
  Store.dates = dates;
  Store.dailyBySymbol = { X: dates.map(d => ({ date: d, turnover: 1 })) };

  const res = computeIndustryMoneyFlow('not-a-real-period');
  assert.equal(res.currentDays, 126);
});

// ─── computeIndustryMoneyFlow: endOffsetDays (Money Flow Rate of Change support) ──
// endOffsetDays shifts the "current" anchor back that many trading days, so the same
// current-vs-previous comparison can be replayed as of an earlier date - this is what
// the Money Flow Rate of Change filter/chart uses to compare "the reading now" against
// "the same reading one window-length ago".

test('computeIndustryMoneyFlow: endOffsetDays=0 behaves exactly like the single-arg call (default)', () => {
  resetStore();
  const dates = Array.from({ length: 20 }, (_, i) => `d${i + 1}`);
  Store.dates = dates;
  Store.dailyBySymbol = { X: dates.map((d, i) => ({ date: d, turnover: i + 1 })) };

  const a = computeIndustryMoneyFlow('1w');
  const b = computeIndustryMoneyFlow('1w', 0);
  assert.deepEqual(a, b);
});

test('computeIndustryMoneyFlow: endOffsetDays replays the same window comparison as of N trading days ago', () => {
  resetStore();
  // 20 days, turnover = day index (1..20), so every 5-day block sums predictably.
  const dates = Array.from({ length: 20 }, (_, i) => `d${i + 1}`);
  Store.dates = dates;
  Store.dailyBySymbol = { X: dates.map((d, i) => ({ date: d, turnover: i + 1 })) };

  // "Now" (endOffsetDays=0): current = d16..d20 (16+17+18+19+20=90), previous = d11..d15 (11+..+15=65)
  const now = computeIndustryMoneyFlow('1w');
  assert.equal(now.current.X, 90);
  assert.equal(now.previous.X, 65);

  // "5 trading days ago" (endOffsetDays=5): current = d11..d15 (65), previous = d6..d10 (6+..+10=40)
  const past = computeIndustryMoneyFlow('1w', 5);
  assert.equal(past.current.X, 65);
  assert.equal(past.previous.X, 40);

  // Key invariant: shifting the anchor back by exactly one window-length makes the
  // "past" current window identical to "now"'s previous window - they're the same
  // trading days viewed from two different anchors.
  assert.equal(past.current.X, now.previous.X);
});

test('computeIndustryMoneyFlow: endOffsetDays that leaves no trading days returns the empty shape', () => {
  resetStore();
  const dates = Array.from({ length: 10 }, (_, i) => `d${i + 1}`);
  Store.dates = dates;
  Store.dailyBySymbol = { X: dates.map(d => ({ date: d, turnover: 10 })) };

  // Asserted field-by-field rather than via a whole-object deepEqual against a literal:
  // the sandbox's return value and a plain object literal written here live in different
  // vm realms, which trips deepStrictEqual's prototype-identity check even when the
  // structure matches (Object.keys/values are still identical either way).
  for (const offset of [10, 15]) { // totalAvail = 10-10 = 0, then 10-15 < 0
    const res = computeIndustryMoneyFlow('1w', offset);
    assert.deepEqual(Object.keys(res.current), []);
    assert.deepEqual(Object.keys(res.previous), []);
    assert.equal(res.currentDays, 0);
    assert.equal(res.prevDays, 0);
  }
});

// ─── Money Flow Rate of Change formula (Industry Analysis sort + Scanner F17 filter) ──
// Both call sites aggregate computeIndustryMoneyFlow(period)/(period, numDays) across every
// symbol in the industry (industries[ind].moneyFlowCurrent += mfData.current[key], etc.),
// then compute ROC = mfPctChange(now.current, now.prev) - mfPctChange(past.current, past.prev).
// This exercises that exact pipeline with two symbols aggregated into one industry.

function aggregateAcrossSymbols(mfData, keys) {
  let current = 0, prev = 0;
  for (const k of keys) { current += (mfData.current[k] || 0); prev += (mfData.previous[k] || 0); }
  return { current, prev };
}

test('Money Flow Rate of Change: still negative now but less so than one window ago -> positive pp (improving)', () => {
  resetStore();
  // 15 trading days ('1w' = 5-day window needs 3 windows: now-current, now-previous/past-current,
  // past-previous). Combined industry turnover tapers off block by block: 100/day -> 20/day -> 10/day,
  // split evenly across two symbols to also exercise the cross-symbol aggregation.
  const dates = Array.from({ length: 15 }, (_, i) => `d${i + 1}`);
  Store.dates = dates;
  const combined = [...Array(5).fill(100), ...Array(5).fill(20), ...Array(5).fill(10)];
  Store.dailyBySymbol = {
    A: dates.map((d, i) => ({ date: d, turnover: combined[i] / 2 })),
    B: dates.map((d, i) => ({ date: d, turnover: combined[i] / 2 })),
  };

  const now = aggregateAcrossSymbols(computeIndustryMoneyFlow('1w'), ['A', 'B']);
  const past = aggregateAcrossSymbols(computeIndustryMoneyFlow('1w', 5), ['A', 'B']);
  assert.equal(now.current, 50);  // last 5 days (d11-d15): 10*5
  assert.equal(now.prev, 100);    // d6-d10: 20*5
  assert.equal(past.current, 100); // d6-d10 again, viewed from 5 days back - matches now.prev
  assert.equal(past.prev, 500);   // d1-d5: 100*5

  const nowChg = mfPctChange(now.current, now.prev);     // (50-100)/100*100 = -50%
  const pastChg = mfPctChange(past.current, past.prev);  // (100-500)/500*100 = -80%
  const roc = nowChg - pastChg;

  assert.equal(nowChg, -50);
  assert.equal(pastChg, -80);
  assert.equal(roc, 30); // -80% -> -50% is an improvement, even though still negative -> +30pp
});

test('Money Flow Rate of Change: still positive now but less so than one window ago -> negative pp (fading)', () => {
  resetStore();
  const dates = Array.from({ length: 15 }, (_, i) => `d${i + 1}`);
  Store.dates = dates;
  // Combined industry turnover ramps up fast then keeps climbing, but at a slowing pace: 10/day -> 40/day -> 60/day.
  const combined = [...Array(5).fill(10), ...Array(5).fill(40), ...Array(5).fill(60)];
  Store.dailyBySymbol = {
    A: dates.map((d, i) => ({ date: d, turnover: combined[i] / 2 })),
    B: dates.map((d, i) => ({ date: d, turnover: combined[i] / 2 })),
  };

  const now = aggregateAcrossSymbols(computeIndustryMoneyFlow('1w'), ['A', 'B']);
  const past = aggregateAcrossSymbols(computeIndustryMoneyFlow('1w', 5), ['A', 'B']);

  const nowChg = mfPctChange(now.current, now.prev);    // (300-200)/200*100 = +50%
  const pastChg = mfPctChange(past.current, past.prev); // (200-50)/50*100 = +300%
  const roc = nowChg - pastChg;

  assert.equal(nowChg, 50);
  assert.equal(pastChg, 300);
  assert.equal(roc, -250); // +300% -> +50% is decelerating, even though still positive -> negative pp
});

// ─── mfPctChange ──────────────────────────────────────────────────────────────────

test('mfPctChange: normal percentage change', () => {
  assert.equal(mfPctChange(120, 100), 20);
  assert.equal(mfPctChange(80, 100), -20);
});

test('mfPctChange: zero previous, positive current -> 100 (treated as full growth from nothing)', () => {
  assert.equal(mfPctChange(50, 0), 100);
});

test('mfPctChange: zero previous, zero current -> 0', () => {
  assert.equal(mfPctChange(0, 0), 0);
});

// ─── computeAllPeriodsMoneyFlow ──────────────────────────────────────────────────

test('computeAllPeriodsMoneyFlow: groups stocks by industry and aggregates market cap/turnover', () => {
  resetStore();
  const dates = Array.from({ length: 10 }, (_, i) => `d${i + 1}`);
  Store.dates = dates;
  Store.dailyBySymbol = {
    X: dates.map(d => ({ date: d, turnover: 10 })),
    Y: dates.map(d => ({ date: d, turnover: 20 })),
  };
  Store.latestBySymbol = {
    X: { symbol: 'X', industry: 'Tech', sector: 'IT', marketCap: 100 },
    Y: { symbol: 'Y', industry: 'Tech', sector: 'IT', marketCap: 200 },
  };

  const list = computeAllPeriodsMoneyFlow(1, 0);
  assert.equal(list.length, 1);
  const tech = list[0];
  assert.equal(tech.name, 'Tech');
  assert.equal(tech.stockCount, 2);
  assert.equal(tech.totalMcap, 300);
  // 1w window: 5 of the 10 days each -> X contributes 5*10=50, Y contributes 5*20=100
  assert.equal(tech.periods['1w'].cur, 150);
  assert.equal(tech.periods['1w'].chg, mfPctChange(tech.periods['1w'].cur, tech.periods['1w'].prev));
});

test('computeAllPeriodsMoneyFlow: minStocks filters out under-represented industries', () => {
  resetStore();
  Store.dates = ['d1'];
  Store.dailyBySymbol = { X: [{ date: 'd1', turnover: 10 }] };
  Store.latestBySymbol = { X: { symbol: 'X', industry: 'Niche', sector: '-', marketCap: 10 } };

  assert.equal(computeAllPeriodsMoneyFlow(2, 0).length, 0); // only 1 stock, needs >=2
  assert.equal(computeAllPeriodsMoneyFlow(1, 0).length, 1);
});

test('computeAllPeriodsMoneyFlow: minMcap filters out small-cap industries', () => {
  resetStore();
  Store.dates = ['d1'];
  Store.dailyBySymbol = { X: [{ date: 'd1', turnover: 10 }] };
  Store.latestBySymbol = { X: { symbol: 'X', industry: 'Small', sector: '-', marketCap: 50 } };

  assert.equal(computeAllPeriodsMoneyFlow(1, 100).length, 0); // totalMcap 50 < 100
  assert.equal(computeAllPeriodsMoneyFlow(1, 50).length, 1);  // >= is inclusive
});

test('computeAllPeriodsMoneyFlow: a stock with no industry falls back to Undefined-Diversified', () => {
  resetStore();
  Store.dates = ['d1'];
  Store.dailyBySymbol = { X: [{ date: 'd1', turnover: 10 }] };
  Store.latestBySymbol = { X: { symbol: 'X', industry: '', sector: '-', marketCap: 10 } };

  const list = computeAllPeriodsMoneyFlow(1, 0);
  assert.equal(list[0].name, 'Undefined-Diversified');
});

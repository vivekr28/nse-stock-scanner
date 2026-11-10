'use strict';
// The chart popup's Daily / Weekly switch (js/industry-charts.js + index.html): weekly candles built from the daily ones for the per-stock
// charts and the Industry Chart tab, the 6M / 1Y / 2Y windows in weeks, the redraw on switching, no Purple Dots on the weekly chart, and the
// button's page wiring. Top-level `let` state is read / written through run().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadScripts } = require('./load');

const html = fs.readFileSync(path.join(path.dirname(__dirname), 'index.html'), 'utf8');
const sb = loadScripts(['js/utils.js', 'js/industry.js', 'js/ew-index.js', 'js/chart-tools.js', 'js/industry-charts.js']);
const run = code => vm.runInContext(code, sb);

// Daily bars as icBuildBarsFromDays makes them. Each entry: [year, month, day, open, high, low, close, turnover].
function built(rows) {
  const candleData = rows.map(([year, month, day, open, high, low, close]) => ({ time: { year, month, day }, open, high, low, close }));
  const volumeData = rows.map(r => ({ time: { year: r[0], month: r[1], day: r[2] }, value: r[7], color: 'x' }));
  return { candleData, volumeData, closes: candleData.map(c => c.close) };
}

// Mon 6 - Fri 10 Jan 2025, then Mon 13 - Wed 15 Jan (a week so far)
const ROWS = [
  [2025, 1, 6, 100, 105, 99, 104, 10],
  [2025, 1, 7, 104, 110, 103, 108, 20],
  [2025, 1, 8, 108, 109, 95, 96, 30],
  [2025, 1, 9, 96, 100, 94, 99, 40],
  [2025, 1, 10, 99, 103, 98, 102, 50],
  [2025, 1, 13, 102, 104, 101, 101, 5],
  [2025, 1, 14, 101, 120, 100, 118, 6],
  [2025, 1, 15, 118, 119, 112, 113, 7],
];

test('weekly candles: first open, highest high, lowest low, last close, summed turnover, dated on the first trading day of the week', () => {
  const w = vm.runInContext('icWeeklyFromDaily', sb)(built(ROWS));
  assert.equal(w.candleData.length, 2);
  const [a, b] = w.candleData;
  assert.deepEqual({ o: a.open, h: a.high, l: a.low, c: a.close }, { o: 100, h: 110, l: 94, c: 102 });
  assert.deepEqual(JSON.parse(JSON.stringify(a.time)), { year: 2025, month: 1, day: 6 });      // Monday: the first trading day, not the Friday the week ended on
  assert.deepEqual({ o: b.open, h: b.high, l: b.low, c: b.close }, { o: 102, h: 120, l: 100, c: 113 });
  assert.deepEqual(JSON.parse(JSON.stringify(b.time)), { year: 2025, month: 1, day: 13 });   // the week so far is dated on its first day too
  assert.deepEqual(JSON.parse(JSON.stringify(w.volumeData[0].time)), { year: 2025, month: 1, day: 6 });   // and so is its turnover bar
  const hol = vm.runInContext('icWeeklyFromDaily', sb)(built([[2025, 1, 14, 10, 12, 9, 11, 1], [2025, 1, 15, 11, 13, 10, 12, 1], [2025, 1, 17, 12, 15, 11, 14, 1]]));   // Monday 13th a holiday: Tue 14, Wed 15, Fri 17
  assert.deepEqual(JSON.parse(JSON.stringify(hol.candleData[0].time)), { year: 2025, month: 1, day: 14 });   // Tuesday is the start date
  assert.deepEqual(JSON.parse(JSON.stringify(hol.volumeData[0].time)), { year: 2025, month: 1, day: 14 });
  assert.equal(hol.candleData[0].open, 10);
  assert.deepEqual(Array.from(w.volumeData.map(v => v.value)), [150, 18]);
  assert.deepEqual(Array.from(w.closes), [102, 113]);
});

test('weekly turnover bars are coloured by the week (close vs open), up and down', () => {
  const w = vm.runInContext('icWeeklyFromDaily', sb)(built(ROWS));
  const up = run('ewHexToRgba(IC_UP_COLOR, 0.5)'), down = run('ewHexToRgba(IC_DOWN_COLOR, 0.5)');
  assert.equal(w.volumeData[0].color, up);       // 102 >= 100
  assert.equal(w.volumeData[1].color, up);       // 113 >= 102
  const falling = vm.runInContext('icWeeklyFromDaily', sb)(built([[2025, 1, 6, 100, 101, 80, 85, 1]]));
  assert.equal(falling.volumeData[0].color, down);
});

test('a week crossing a month and a year end stays one candle; a missing Friday or Monday does not split a week', () => {
  const rows = [
    [2024, 12, 30, 10, 12, 9, 11, 1],     // Mon
    [2024, 12, 31, 11, 13, 10, 12, 1],    // Tue
    [2025, 1, 2, 12, 15, 11, 14, 1],      // Thu (Wed was a holiday)
    [2025, 1, 6, 14, 16, 13, 15, 1],      // next Monday
    [2025, 1, 9, 15, 17, 14, 16, 1],      // Thu (Fri missing)
  ];
  const w = vm.runInContext('icWeeklyFromDaily', sb)(built(rows));
  assert.equal(w.candleData.length, 2);
  assert.equal(w.candleData[0].high, 15);
  assert.equal(w.candleData[0].close, 14);
  assert.deepEqual(JSON.parse(JSON.stringify(w.candleData[0].time)), { year: 2024, month: 12, day: 30 });   // Monday 30 Dec, in the previous year
  assert.deepEqual(JSON.parse(JSON.stringify(w.candleData[1].time)), { year: 2025, month: 1, day: 6 });
  assert.equal(w.candleData[1].open, 14);
});

test('icApplyTimeframe returns the daily bars untouched on the Daily chart and weekly ones on the Weekly chart', () => {
  const b = built(ROWS);
  sb.__b = b;
  run("icTimeframe = 'd'");
  assert.equal(run('icApplyTimeframe(__b)'), b);
  run("icTimeframe = 'w'");
  assert.equal(run('icApplyTimeframe(__b).candleData.length'), 2);
  run("icTimeframe = 'd'");
});

test('6M / 1Y / 2Y are 126 / 252 / 504 candles on the daily chart and 26 / 52 / 104 on the weekly one', () => {
  run("icTimeframe = 'd'; icRange = '1y'");
  assert.equal(run('icVisibleCandles()'), 252);
  run("icTimeframe = 'w'");
  assert.equal(run('icVisibleCandles()'), 52);
  assert.deepEqual([run("icRangeCandles('6m')"), run("icRangeCandles('1y')"), run("icRangeCandles('2y')")], [26, 52, 104]);
  run("icRange = 'custom'; icCustomCandles = 40");
  assert.equal(run('icVisibleCandles()'), 40);      // a hand-zoomed width is already in the chart's own candles
  run("icTimeframe = 'd'; icRange = '6m'; icCustomCandles = 0");
});

test('switching redraws the current view; the same choice again does nothing; an unknown value is ignored', () => {
  let redraws = 0;
  sb.icRefreshCurrentView = () => { redraws++; };
  run("icMode = 'industry'; icActiveTab = 'stocks'; icTimeframe = 'd'; icRange = '6m'");
  sb.icSetTimeframe('d');
  sb.icSetTimeframe('x');
  assert.equal(redraws, 0);
  sb.icSetTimeframe('w');
  assert.equal(redraws, 1);
  assert.equal(run('icTimeframe'), 'w');
  sb.icSetTimeframe('d');
  assert.equal(redraws, 2);
  assert.equal(run('icTimeframe'), 'd');
});

test('a hand-zoomed width is converted between days and weeks (about 5 days a week, never under the minimum)', () => {
  sb.icRefreshCurrentView = () => {};
  run("icMode = 'industry'; icActiveTab = 'stocks'; icTimeframe = 'd'; icRange = 'custom'; icCustomCandles = 100");
  sb.icSetTimeframe('w');
  assert.equal(run('icCustomCandles'), 20);
  sb.icSetTimeframe('d');
  assert.equal(run('icCustomCandles'), 100);
  run('icCustomCandles = 8');
  sb.icSetTimeframe('w');
  assert.equal(run('icCustomCandles'), run('IC_MIN_CUSTOM_CANDLES'));
  run("icTimeframe = 'd'; icRange = '6m'; icCustomCandles = 0");
});

test('on the Industry Chart tab, switching rebuilds the industry chart instead of the grid', () => {
  const calls = [];
  sb.icRefreshCurrentView = () => calls.push('refresh');
  sb.icDisposeIndustryChart = () => calls.push('dispose');
  sb.icBuildIndustryChart = () => calls.push('build');
  run("icMode = 'industry'; icActiveTab = 'industry'; icTimeframe = 'd'");
  sb.icSetTimeframe('w');
  assert.deepEqual(calls, ['dispose', 'build']);
  run("icTimeframe = 'd'; icActiveTab = 'stocks'");
});

test('Purple Dots are not drawn on the weekly chart (the rule is per day), but are on the daily one', () => {
  const marks = [];
  const inst = {
    weekly: false,
    candleData: [{ time: 1, close: 100 }, { time: 2, close: 110 }],
    volumeData: [{ value: 0 }, { value: 100000 }],        // 1000 Cr on day 2, +10%
    markersPlugin: { setMarkers: m => marks.push(m.length) },
  };
  sb.document.getElementById = () => ({ checked: true, addEventListener() {}, classList: { toggle() {} }, style: {} });
  sb.icUpdateInstanceMFDots(inst);
  inst.weekly = true;
  sb.icUpdateInstanceMFDots(inst);
  assert.deepEqual(marks, [1, 0]);
});

test('index.html: Daily / Weekly buttons in the header, Daily active, wired to icSetTimeframe', () => {
  const block = html.slice(html.indexOf('id="icTfToggle"'), html.indexOf('id="icLayoutToggle"'));
  assert.match(block, /<button class="btn btn-secondary ic-layout-btn active" data-tf="d" onclick="icSetTimeframe\('d'\)">Daily<\/button>/);
  assert.match(block, /<button class="btn btn-secondary ic-layout-btn" data-tf="w" onclick="icSetTimeframe\('w'\)">Weekly<\/button>/);
  assert.equal(html.split('id="icTfToggle"').length - 1, 1);
  assert.match(html, /Daily chart only\./);                // the Purple Dots tooltip says so
});

test('the switch shows on the stock charts (grid and single stock) and the Industry Chart tab, not on the money flow tab', () => {
  const els = {};
  const el = id => els[id] || (els[id] = { id, style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, dataset: {}, textContent: '' });
  sb.document.getElementById = el;
  sb.document.querySelector = () => null;
  const show = (mode, tab) => { run(`icMode = '${mode}'; icActiveTab = '${tab}'; icIndList = []`); sb.icUpdateControlVisibility(); return els.icTfToggle.style.display; };
  assert.equal(show('industry', 'stocks'), '');
  assert.equal(show('industry', 'industry'), '');
  assert.equal(show('industry', 'moneyflow'), 'none');
  assert.equal(show('single', 'stocks'), '');
});

test('weeks run Monday to Sunday: a weekend special session (Muhurat, Budget day) joins the week it ends, not the next one', () => {
  const weekly = rows => vm.runInContext('icWeeklyFromDaily', sb)(built(rows));
  const when = c => JSON.parse(JSON.stringify(c.time));
  // Mon 2 - Fri 6 Nov 2026, then the Diwali Muhurat session on SUNDAY 8 Nov, then Mon 9 Nov starts a new week
  const nov = weekly([
    [2026, 11, 2, 100, 104, 99, 103, 1], [2026, 11, 3, 103, 106, 102, 105, 1], [2026, 11, 4, 105, 107, 100, 101, 1],
    [2026, 11, 5, 101, 103, 98, 102, 1], [2026, 11, 6, 102, 104, 101, 103, 1],
    [2026, 11, 8, 103, 109, 102, 108, 1],                                     // Sunday: part of the week of Mon 2 Nov
    [2026, 11, 9, 108, 110, 106, 107, 1],
  ]);
  assert.equal(nov.candleData.length, 2);
  assert.deepEqual(when(nov.candleData[0]), { year: 2026, month: 11, day: 2 });
  assert.deepEqual({ o: nov.candleData[0].open, h: nov.candleData[0].high, c: nov.candleData[0].close }, { o: 100, h: 109, c: 108 });   // the Sunday is the week's last close and sets its high
  assert.equal(nov.volumeData[0].value, 6);                                  // five weekdays + the Sunday session
  assert.deepEqual(when(nov.candleData[1]), { year: 2026, month: 11, day: 9 });
  // Budget day, Saturday 1 Feb 2025, closes the week of Mon 27 Jan
  const feb = weekly([[2025, 1, 30, 10, 11, 9, 10, 1], [2025, 1, 31, 10, 12, 9, 11, 1], [2025, 2, 1, 11, 13, 10, 12, 1], [2025, 2, 3, 12, 13, 11, 12, 1]]);
  assert.equal(feb.candleData.length, 2);
  assert.equal(feb.candleData[0].close, 12);
  assert.deepEqual(when(feb.candleData[0]), { year: 2025, month: 1, day: 30 });   // dated on the week's first trading day
  assert.deepEqual(when(feb.candleData[1]), { year: 2025, month: 2, day: 3 });
});

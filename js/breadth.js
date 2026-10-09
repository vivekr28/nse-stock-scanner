// ═══════════════════════════════════════════════════════════════════════════════
// BREADTH — stat cards + a shared TradingView candlestick chart, tabbed across
// 5 breadth metrics (% above 20/50 SMA - one tab with a checkbox per SMA, % with a big day/week/month move).
// Each candle's O/H/L/C is a REAL, independently-computed breadth percentage,
// not a synthetic yesterday-vs-today body: for every stock, its own Open/High/
// Low/Close is tested against a reference (the stock's own SMA for the two SMA
// tabs; its close N trading days ago for the three move tabs), and each of the
// 4 tests is aggregated into its own %-of-stocks-passing figure for that day.
// Since every stock's high >= its own open/close and low <= its own open/close,
// {stocks passing on close} is mathematically a SUBSET of {stocks passing on
// high} and a SUPERSET of {stocks passing on low} for the two SMA tabs - so a
// genuine, meaningful wick falls out of the aggregation instead of being
// fabricated (e.g. "some stocks touched above the 20 SMA intraday - counted in
// the high% - without CLOSING above it - not counted in the close%").
// ═══════════════════════════════════════════════════════════════════════════════

const BRD_CHART_BG = '#000000';
const BRD_UP_COLOR = '#18eee7';
const BRD_DOWN_COLOR = '#ff1616';
const BRD_DAY_MOVE_PCT = 4;    // day change% threshold, either direction
const BRD_WEEK_MOVE_PCT = 10;  // 5-trading-day change% threshold, either direction
const BRD_MONTH_MOVE_PCT = 20; // 21-trading-day change% threshold, either direction

const BRD_METRICS = {
  above20: { label: '% Stocks Above 20 SMA', prefix: 'above20', line: true, countKey: 'above20CloseCount' },
  above50: { label: '% Stocks Above 50 SMA', prefix: 'above50', line: true, countKey: 'above50CloseCount' },
  move4d: { label: `% Stocks with ${BRD_DAY_MOVE_PCT}%+ Move (Day)`, prefix: 'move4d', countKey: 'move4dCloseCount' },
  move10w: { label: `% Stocks with ${BRD_WEEK_MOVE_PCT}%+ Move (Week)`, prefix: 'move10w', countKey: 'move10wCloseCount' },
  move20m: { label: `% Stocks with ${BRD_MONTH_MOVE_PCT}%+ Move (Month)`, prefix: 'move20m', countKey: 'move20mCloseCount' },
  // Sub-metrics of the "Stocks Making New Highs" tab - picked by its dropdown, not by a tab button.
  high1m: { label: '% Stocks Making 1M High', prefix: 'high1m', line: true, countKey: 'high1mCloseCount' },
  high3m: { label: '% Stocks Making 3M High', prefix: 'high3m', line: true, countKey: 'high3mCloseCount' },
  high1y: { label: '% Stocks Making 1Y High', prefix: 'high1y', line: true, countKey: 'high1yCloseCount' },
  highAth: { label: '% Stocks Making ATH', prefix: 'highAth', line: true, countKey: 'highAthCloseCount' },
  // All four new-high lines overlaid on one chart (no single OHLC/count; see brdRenderActiveTab).
  highAll: { label: '% Stocks Making New Highs (All)', multi: true },
  // Both SMA lines overlaid, when the "Above SMA" tab has the 20 and 50 SMA boxes both ticked.
  aboveBoth: { label: '% Stocks Above 20 / 50 SMA', multi: true },
};
const BRD_HIGH_LINES = [
  { key: 'high1m', name: '1M', color: '#18eee7' },
  { key: 'high3m', name: '3M', color: '#f59e0b' },
  { key: 'high1y', name: '1Y', color: '#a78bfa' },
  { key: 'highAth', name: 'ATH', color: '#ff1616' },
];
const BRD_SMA_LINES = [
  { key: 'above20', name: '20 SMA', color: '#18eee7' },
  { key: 'above50', name: '50 SMA', color: '#f59e0b' },
];
// Trailing-window lengths in trading days. ATH has no window: it is the highest high in all data loaded.
const BRD_HIGH_WINDOWS = { high1m: 21, high3m: 63, high1y: 252 };
const BRD_ATH_MIN_BARS = 252; // ATH only counts stocks with >= 1y of history, so early bars of the dataset don't all read as "new highs"

let _brdHistory = [];       // cached per renderBreadth() call - [{date, above20Pct, above20Count, ...}]
let _brdActiveTab = 'aboveSma';

// The SMA lengths ticked on the "Above SMA" tab, in 20 / 50 order. Never empty: with no box ticked it falls back to 20.
function brdSelectedSmas() {
  const on = BRD_SMA_LINES.filter(l => { const cb = document.getElementById('brdSma' + l.key.slice(5)); return cb && cb.checked; });
  return on.length ? on : [BRD_SMA_LINES[0]];
}
// The overlay lines drawn by the active multi-line metric.
function brdMultiLines() {
  return brdActiveMetricKey() === 'aboveBoth' ? BRD_SMA_LINES : BRD_HIGH_LINES;
}
// The "newhighs" tab shows whichever metric its dropdown selects, the "aboveSma" tab whichever SMA boxes are ticked;
// every other tab maps 1:1 to a BRD_METRICS key.
function brdActiveMetricKey() {
  if (_brdActiveTab === 'aboveSma') {
    const sel = brdSelectedSmas();
    return sel.length > 1 ? 'aboveBoth' : sel[0].key;
  }
  if (_brdActiveTab !== 'newhighs') return _brdActiveTab;
  const sel = document.getElementById('brdHighSelect');
  return (sel && BRD_METRICS[sel.value]) ? sel.value : 'high1m';
}
function brdIsMulti() {
  return !!BRD_METRICS[brdActiveMetricKey()].multi;
}
let brdChart = null, brdCandleSeries = null, brdLineSeries = null, brdCountSeries = null;
let brdMultiSeries = [], _brdMultiData = {};
let _brdCandles = [], _brdCounts = []; // currently-displayed series data, for the crosshair legend below
let brdTools = null, _brdToolsSeries = null, _brdToolsKey = null; // one-shot Measure / Trend Line tools (chart-tools.js), the series they draw on and the metric they were drawn for

// Drawings are anchored to a metric's values on one series (candles, a line, or the first overlay line, which
// two metrics can share), so the tools are rebuilt - dropping any drawings - whenever the metric or its series
// changes, i.e. on a tab / dropdown switch. A plain data refresh of the same metric keeps them.
function brdRefreshTools() {
  const series = brdIsMulti() ? brdMultiSeries[0]
    : (BRD_METRICS[brdActiveMetricKey()].line ? brdLineSeries : brdCandleSeries);
  const key = brdActiveMetricKey();
  if (brdTools && _brdToolsSeries === series && _brdToolsKey === key) return;
  if (brdTools) brdTools.destroy();
  _brdToolsSeries = series; _brdToolsKey = key;
  // values are already a % of stocks, so a measurement reads in percentage points, not as a % of a %
  brdTools = new ChartTools(brdChart, [{ series, unit: 'pp' }], document.getElementById('brdChartContainer'), {
    measure: document.getElementById('brdToolMeasure'),
    trend: document.getElementById('brdToolTrend'),
    clear: document.getElementById('brdToolClear'),
    remove: document.getElementById('brdToolDelete'),
  });
}

function renderBreadth() {
  let above = 0, below = 0, advancing = 0, declining = 0, unchanged = 0;
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    if (s.aboveSMA === true) above++;
    else if (s.aboveSMA === false) below++;
    if (s.changePct > 0) advancing++;
    else if (s.changePct < 0) declining++;
    else unchanged++;
  }
  const total = above + below;
  const abovePct = total > 0 ? (above / total * 100) : 50;
  const adTotal = advancing + declining;
  const advPct = adTotal > 0 ? (advancing / adTotal * 100) : 50;

  document.getElementById('breadthStats').innerHTML = `
    <div class="stat-card"><div class="label">Above 20 SMA</div><div class="value positive">${above}</div><div class="sub">${abovePct.toFixed(1)}% of market</div></div>
    <div class="stat-card"><div class="label">Below 20 SMA</div><div class="value negative">${below}</div><div class="sub">${(100-abovePct).toFixed(1)}% of market</div></div>
    <div class="stat-card"><div class="label">Advancing</div><div class="value positive">${advancing}</div><div class="sub">${advPct.toFixed(1)}%</div></div>
    <div class="stat-card"><div class="label">Declining</div><div class="value negative">${declining}</div><div class="sub">${(100-advPct).toFixed(1)}%</div></div>
    <div class="stat-card"><div class="label">Unchanged</div><div class="value neutral">${unchanged}</div></div>
  `;

  const numDays = Math.min(Store.dates.length, 510);
  _brdHistory = computeBreadthHistories(numDays);

  const noteEl = document.getElementById('brdUniverseNote');
  if (noteEl) noteEl.textContent = 'Universe: all NSE stocks';
  // (New Highs tab: windows are 21 / 63 / 252 trading days; ATH = highest high in the data loaded, stocks with >= 1y of history only.)

  // Only render the chart immediately if this panel already happens to be the
  // visible tab (e.g. a Phase-2 background refresh while the user is already
  // looking at it) - otherwise defer to the tab-click handler in ui.js, same
  // lazy-creation pattern the EW Index tab uses. Creating a Lightweight
  // Charts instance while its container is `display:none` (any other tab is
  // active on first load) measures a zero-size box.
  const panel = document.getElementById('panel-breadth');
  if (panel && panel.classList.contains('active')) brdRenderActiveTab();
}

// Single pass over every stock's own chronological daily array (not a
// per-date x per-stock nested loop) - each stock contributes to a shared,
// pre-indexed set of per-day counters via a rolling SMA20/SMA50 sum and
// direct index offsets for the day/week/month change lookups. Each metric
// tracks 4 independent OHLC-field counters (see file header) plus one shared
// denominator (same stocks have data either way).
function computeBreadthHistories(numDays) {
  const historyDates = Store.dates.slice(-numDays);
  const n = historyDates.length;
  const dateIndex = {};
  historyDates.forEach((d, i) => { dateIndex[d] = i; });

  const mk = () => ({ o: new Array(n).fill(0), h: new Array(n).fill(0), l: new Array(n).fill(0), c: new Array(n).fill(0), tot: new Array(n).fill(0) });
  const above20 = mk(), above50 = mk(), move4d = mk(), move10w = mk(), move20m = mk();
  const high1m = mk(), high3m = mk(), high1y = mk(), highAth = mk();
  const highMetrics = { high1m, high3m, high1y };

  // field > reference for all 4 OHLC fields at once
  function tallyAbove(m, gi, day, ref) {
    m.tot[gi]++;
    if (day.open > ref) m.o[gi]++;
    if (day.high > ref) m.h[gi]++;
    if (day.low > ref) m.l[gi]++;
    if (day.close > ref) m.c[gi]++;
  }
  // |field/reference - 1| >= thresholdPct for all 4 OHLC fields at once
  function tallyMove(m, gi, day, ref, thresholdPct) {
    m.tot[gi]++;
    if (Math.abs((day.open - ref) / ref * 100) >= thresholdPct) m.o[gi]++;
    if (Math.abs((day.high - ref) / ref * 100) >= thresholdPct) m.h[gi]++;
    if (Math.abs((day.low - ref) / ref * 100) >= thresholdPct) m.l[gi]++;
    if (Math.abs((day.close - ref) / ref * 100) >= thresholdPct) m.c[gi]++;
  }

  for (const key in Store.dailyBySymbol) {
    const days = Store.dailyBySymbol[key];
    const len = days.length;
    let sum20 = 0, sum50 = 0;
    // Monotonic deques (indices, decreasing highs) give each trailing-window max in O(1) amortised.
    const deques = { high1m: [], high3m: [], high1y: [] };
    const heads = { high1m: 0, high3m: 0, high1y: 0 };
    let athMax = 0;
    for (let i = 0; i < len; i++) {
      const day = days[i];
      const close = day.close;
      sum20 += close;
      if (i >= 20) sum20 -= days[i - 20].close;
      sum50 += close;
      if (i >= 50) sum50 -= days[i - 50].close;

      const hi = day.high;
      // priorMax[k] = highest high of the w-1 bars before today, so "new high" means strictly above them
      // (a flat stock whose high never changes is not making new highs).
      const priorMax = {};
      for (const k in deques) {
        const dq = deques[k], w = BRD_HIGH_WINDOWS[k];
        while (dq.length > heads[k] && dq[heads[k]] <= i - w) heads[k]++;
        priorMax[k] = dq.length > heads[k] ? days[dq[heads[k]]].high : 0;
        while (dq.length > heads[k] && days[dq[dq.length - 1]].high <= hi) dq.pop();
        dq.push(i);
      }
      const athBefore = athMax; // highest high of all earlier bars
      if (hi > athMax) athMax = hi;

      const gi = dateIndex[day.date];
      if (gi === undefined) continue;

      if (hi > 0) {
        for (const k in deques) {
          if (i < BRD_HIGH_WINDOWS[k] - 1) continue; // need a full window
          const m = highMetrics[k];
          m.tot[gi]++;
          if (hi > priorMax[k]) m.c[gi]++;
        }
        if (i >= BRD_ATH_MIN_BARS - 1) {
          highAth.tot[gi]++;
          if (hi > athBefore) highAth.c[gi]++;
        }
      }

      if (i >= 19) tallyAbove(above20, gi, day, sum20 / 20);
      if (i >= 49) tallyAbove(above50, gi, day, sum50 / 50);

      const prev = day.prev;
      if (prev > 0) tallyMove(move4d, gi, day, prev, BRD_DAY_MOVE_PCT);
      if (i >= 5 && days[i - 5].close > 0) tallyMove(move10w, gi, day, days[i - 5].close, BRD_WEEK_MOVE_PCT);
      if (i >= 21 && days[i - 21].close > 0) tallyMove(move20m, gi, day, days[i - 21].close, BRD_MONTH_MOVE_PCT);
    }
  }

  const pct = (n, d) => d > 0 ? (n / d * 100) : 0;
  // Defensive: derive the candle's actual High/Low as max/min across all 4
  // field-percentages (not just h[]/l[]). For the SMA tabs this is provably a
  // no-op (high% is always >= open%/close%, low% always <= them, since each
  // stock's own high/low bound its open/close) - but the move tabs use an
  // absolute-value threshold per field independently, which has no such
  // guarantee, so this keeps every candle validly ordered (low <= open,close
  // <= high) regardless of which raw field-% happens to come out largest.
  function toOHLC(m, i) {
    const o = pct(m.o[i], m.tot[i]), h = pct(m.h[i], m.tot[i]), l = pct(m.l[i], m.tot[i]), c = pct(m.c[i], m.tot[i]);
    return { open: o, high: Math.max(o, h, l, c), low: Math.min(o, h, l, c), close: c };
  }

  return historyDates.map((date, i) => ({
    date,
    above20OHLC: toOHLC(above20, i), above20CloseCount: above20.c[i],
    above50OHLC: toOHLC(above50, i), above50CloseCount: above50.c[i],
    move4dOHLC: toOHLC(move4d, i), move4dCloseCount: move4d.c[i],
    move10wOHLC: toOHLC(move10w, i), move10wCloseCount: move10w.c[i],
    move20mOHLC: toOHLC(move20m, i), move20mCloseCount: move20m.c[i],
    high1mOHLC: toOHLC(high1m, i), high1mCloseCount: high1m.c[i],
    high3mOHLC: toOHLC(high3m, i), high3mCloseCount: high3m.c[i],
    high1yOHLC: toOHLC(high1y, i), high1yCloseCount: high1y.c[i],
    highAthOHLC: toOHLC(highAth, i), highAthCloseCount: highAth.c[i],
  }));
}

// ── Tab switching ─────────────────────────────────────────────────────────
function brdSwitchTab(tab) {
  if (!BRD_METRICS[tab] && tab !== 'newhighs' && tab !== 'aboveSma') return;
  _brdActiveTab = tab;
  const sel = document.getElementById('brdHighSelect');
  if (sel) sel.style.display = tab === 'newhighs' ? '' : 'none';
  const smaBox = document.getElementById('brdSmaChecks');
  if (smaBox) smaBox.style.display = tab === 'aboveSma' ? '' : 'none';
  document.querySelectorAll('#brdTabbar .brd-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('brdChartTitle').textContent = BRD_METRICS[brdActiveMetricKey()].label;
  brdRenderActiveTab();
}

// A box was (un)ticked on the "Above SMA" tab. At least one stays ticked: unticking the last one re-ticks it.
function brdSmaChanged(changed) {
  if (changed && !changed.checked && !BRD_SMA_LINES.some(l => document.getElementById('brdSma' + l.key.slice(5)).checked)) {
    changed.checked = true;
  }
  document.getElementById('brdChartTitle').textContent = BRD_METRICS[brdActiveMetricKey()].label;
  brdRenderActiveTab();
}

function brdHighSelectChanged() {
  document.getElementById('brdChartTitle').textContent = BRD_METRICS[brdActiveMetricKey()].label;
  brdRenderActiveTab();
}

// ── Chart creation (lazy, once) — same black background / candle colors as
// the shared Industry/Stock Charts popup, so this reads as "one more stock
// chart" rather than a different visual language. The metric itself has no
// real "volume", so a second pane shows the RAW COUNT of qualifying stocks
// that day instead (e.g. how many stocks actually closed above their 20 SMA),
// the same role volume plays under a real price chart - a real second pane
// (this library's multi-pane API, not the old shared-scale-plus-margins
// trick), same reasoning as the turnover pane fix in industry-charts.js. ──
function brdEnsureChart() {
  if (brdChart || typeof LightweightCharts === 'undefined') return;
  const container = document.getElementById('brdChartContainer');
  if (!container) return;

  const styles = getComputedStyle(document.documentElement);
  const textColor = (styles.getPropertyValue('--text2') || '#94a3b8').trim();
  const gridColor = (styles.getPropertyValue('--border') || '#334155').trim();

  brdChart = LightweightCharts.createChart(container, {
    layout: { background: { color: BRD_CHART_BG }, textColor },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { borderColor: gridColor },
    timeScale: { rightBarStaysOnScroll: true, borderColor: gridColor },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });

  brdCandleSeries = brdChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: BRD_UP_COLOR, downColor: BRD_DOWN_COLOR,
    borderUpColor: BRD_UP_COLOR, borderDownColor: BRD_DOWN_COLOR,
    wickUpColor: BRD_UP_COLOR, wickDownColor: BRD_DOWN_COLOR,
    priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
  });
  brdCandleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

  // Plain line (close %) for the two SMA tabs; candles for the move tabs.
  brdLineSeries = brdChart.addSeries(LightweightCharts.LineSeries, {
    color: BRD_UP_COLOR, lineWidth: 2,
    priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
  });
  brdLineSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

  brdMultiSeries = BRD_HIGH_LINES.map(l => brdChart.addSeries(LightweightCharts.LineSeries, {
    color: l.color, lineWidth: 2, priceLineVisible: false,
    priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
  }));

  brdCountSeries = brdChart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'brdCount',
  }, 1);
  brdCountSeries.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });

  const countPane = brdChart.panes()[1];
  if (countPane) { brdChart.panes()[0].setStretchFactor(5); countPane.setStretchFactor(1); }

  // Crosshair-driven O/H/L/C + count legend — same pattern as the shared
  // stock-chart popup's updateLegend()/subscribeCrosshairMove(), reusing the
  // same .ic-cell-ohlc styling so it reads identically to a real stock chart.
  const legendEl = document.getElementById('brdChartOhlc');
  function updateBrdLegend(index) {
    if (!legendEl || !_brdCandles.length) { if (legendEl) legendEl.innerHTML = ''; return; }
    const i = (index == null) ? _brdCandles.length - 1 : index;
    const bar = _brdCandles[i];
    const cnt = _brdCounts[i];
    if (!bar) { legendEl.innerHTML = ''; return; }
    if (brdIsMulti()) {
      const suffix = brdActiveMetricKey() === 'aboveBoth' ? '' : ' High';
      legendEl.innerHTML = brdMultiLines().map(l => {
        const v = _brdMultiData[l.key] && _brdMultiData[l.key][i];
        return `<span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;background:${l.color}"></i>${l.name}${suffix} <b style="color:${l.color}">${v ? v.value.toFixed(1) : '0.0'}%</b></span>`;
      }).join('');
      return;
    }
    if (BRD_METRICS[brdActiveMetricKey()].line) {
      legendEl.innerHTML = `<span>% <b>${bar.close.toFixed(1)}%</b></span><span>Stocks <b>${cnt ? cnt.value : 0}</b></span>`;
      return;
    }
    legendEl.innerHTML =
      `<span>O <b>${bar.open.toFixed(1)}%</b></span>` +
      `<span>H <b>${bar.high.toFixed(1)}%</b></span>` +
      `<span>L <b>${bar.low.toFixed(1)}%</b></span>` +
      `<span>C <b>${bar.close.toFixed(1)}%</b></span>` +
      `<span>Stocks <b>${cnt ? cnt.value : 0}</b></span>`;
  }
  brdChart.subscribeCrosshairMove(param => {
    if (!param.time) { updateBrdLegend(null); return; }
    const t = param.time; // BusinessDay objects - compare by value, not identity
    const idx = _brdCandles.findIndex(c => c.time.year === t.year && c.time.month === t.month && c.time.day === t.day);
    updateBrdLegend(idx >= 0 ? idx : null);
  });
  brdChart._updateBrdLegend = updateBrdLegend;
}

function brdRenderActiveTab() {
  if (!_brdHistory.length) return;
  brdEnsureChart();
  if (!brdChart) return; // library failed to load

  const metric = BRD_METRICS[brdActiveMetricKey()];
  if (metric.multi) { brdRenderMulti(); return; }
  brdMultiSeries.forEach(sr => sr.setData([]));
  _brdMultiData = {};
  const ohlcKey = metric.prefix + 'OHLC';
  const candles = [], counts = [];
  _brdHistory.forEach(d => {
    const time = ewToBusinessDay(d.date);
    if (!time) return;
    const bar = d[ohlcKey];
    candles.push({ time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    counts.push({ time, value: d[metric.countKey], color: bar.close >= bar.open ? BRD_UP_COLOR : BRD_DOWN_COLOR });
  });

  const isLine = !!metric.line;
  if (isLine && brdActiveMetricKey() === 'above50') brdLineSeries.applyOptions({ color: BRD_SMA_LINES[1].color });
  else if (isLine) brdLineSeries.applyOptions({ color: BRD_UP_COLOR });
  brdCandleSeries.setData(isLine ? [] : candles);
  brdLineSeries.setData(isLine ? candles.map(c => ({ time: c.time, value: c.close })) : []);
  brdCountSeries.setData(counts);
  _brdCandles = candles;
  _brdCounts = counts;
  if (brdChart._updateBrdLegend) brdChart._updateBrdLegend(); // show the latest bar by default, like the stock-chart popup does
  brdRefreshTools();

  // Run after the current layout/paint pass, not synchronously right after a
  // tab just became visible: `fitContent()` right after `display:none` ->
  // `display:block` can fit to whatever (possibly stale/mid-transition) size
  // the container measured at that exact instant, silently truncating the
  // visible range to fewer bars than actually exist (confirmed live: fit to
  // only ~277 of 507 bars, with a large empty gap of blank space to their
  // left, on the very first render right after the tab was clicked).
  requestAnimationFrame(() => ewFitWithRightPad(brdChart));
}

// Overlay view (all four new-high percentages, or the 20 + 50 SMA percentages) as lines on the one price scale;
// the raw-count pane is left empty since the counts don't share a single meaningful bar.
function brdRenderMulti() {
  brdCandleSeries.setData([]);
  brdLineSeries.setData([]);
  brdCountSeries.setData([]);
  _brdMultiData = {};
  _brdCandles = [];
  const lines = brdMultiLines();
  brdMultiSeries.forEach(sr => sr.setData([])); // the SMA overlay uses fewer series than the new-highs one
  lines.forEach((l, idx) => {
    const data = [];
    _brdHistory.forEach(d => {
      const time = ewToBusinessDay(d.date);
      if (time) data.push({ time, value: d[l.key + 'OHLC'].close });
    });
    _brdMultiData[l.key] = data;
    brdMultiSeries[idx].applyOptions({ color: l.color });
    brdMultiSeries[idx].setData(data);
    if (idx === 0) _brdCandles = data.map(p => ({ time: p.time })); // time axis for the crosshair lookup
  });
  _brdCounts = [];
  if (brdChart._updateBrdLegend) brdChart._updateBrdLegend(null);
  brdRefreshTools();
  requestAnimationFrame(() => ewFitWithRightPad(brdChart));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRY CHARTS — full-screen candlestick popup for a clicked industry
// (Stock Scanner results table → Industry column link)
// Two tabs: "Stock Charts" (2x2 grid, paged, sorted by market cap) and
// "Industry Chart" (single equal-weight index chart built from the constituents).
// ═══════════════════════════════════════════════════════════════════════════════

let icIndustry = null;
let icStocks = [];       // stocks in the clicked industry, sorted by market cap desc
let icPage = 0;
let icMode = 'industry'; // 'industry' (tabs + grid + pagination) | 'single' (one stock, no tabs/pagination)
let icActiveTab = 'stocks'; // 'stocks' | 'industry' — only meaningful in 'industry' mode
let icChartInstances = []; // stock-tab chart instances: [{chart, candleSeries, volumeSeries, smaSeries, closes, candleData}]
let icIndustryChartInst = null; // single big-chart instance (industry index OR single-stock mode)
let icSingleList = [];   // the Stock Scanner results the single-stock view was opened from
let icSingleIndex = -1;  // current stock's position within icSingleList
let icLayout = '2x2';    // '2x2' (4 cells) | '1x1' (one chart at a time) — Stock Charts tab only
let icMeasureMode = false; // when on, dragging on a chart measures instead of panning it

const IC_PAGE_SIZE = 4;
const IC_UP_COLOR = '#18eee7';
const IC_DOWN_COLOR = '#ff1616';
const IC_SMA_COLORS = { 10: '#15ff00', 20: '#ff9800', 50: '#ff1616' };
const IC_SMA_LENGTHS = [10, 20, 50];
const IC_CHART_BG = '#000000';
const IC_MF_DOT_COLOR = '#9c27b0';
const IC_MF_DOT_MIN_CR = 40;   // money flow (turnover) threshold, in crores
const IC_MF_DOT_MIN_CHG = 5;   // day change %, threshold
const IC_VOLUME_SMA_COLOR = '#08c9c2';
const IC_VOLUME_SMA_HIGH_COLOR = '#00ffda';
const IC_VOLUME_SMA_HIGH_LOOKBACK = 65; // trading days
const IC_RIGHT_OFFSET = 10; // empty candle-widths of space kept to the right of the last bar
const IC_STOCK_VISIBLE_CANDLES = 126; // ~6 trading months of candles (plus the right margin on top)
const IC_INDUSTRY_VISIBLE_CANDLES = 252 - IC_RIGHT_OFFSET; // ~1 trading year, minus the right margin
const IC_MEASURE_DRAG_THRESHOLD = 4; // px — a mouse-up past this distance from mouse-down is a chart
                                      // drag (pans as usual), not a measure-tool click

// Native pan/zoom always stays on, including in Measure mode - the measure tool
// is click-click (see icCreateChart), so it never competes with dragging to pan.
// Turning Measure mode off just clears any in-progress/pinned measurements.
function icApplyMeasureMode() {
  const instances = icIndustryChartInst ? [...icChartInstances, icIndustryChartInst] : icChartInstances;
  instances.forEach(inst => {
    if (!icMeasureMode) {
      if (inst.clearMeasure) inst.clearMeasure();
      if (inst.cancelPendingMeasure) inst.cancelPendingMeasure();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTED STOCKS — a pick-list built while browsing chart popups from either the
// Stock Scanner or Industry Analysis tab. Persists across paging / reopening the
// modal for a different industry; cleared only by the Clear Selected button or by
// switching top-level tabs (see js/ui.js), never by re-filtering/re-scanning.
// ═══════════════════════════════════════════════════════════════════════════════
let selectedStocks = new Set(); // ISIN keys

function isStockSelected(isin) { return selectedStocks.has(isin); }

function toggleStockSelection(isin) {
  if (selectedStocks.has(isin)) selectedStocks.delete(isin);
  else selectedStocks.add(isin);
  updateSelectedUI();
}

function clearSelectedStocks() {
  selectedStocks.clear();
  updateSelectedUI();
  // Un-check any checkboxes currently rendered in an open modal.
  document.querySelectorAll('.ic-select-cb').forEach(cb => { cb.checked = false; });
}

function updateSelectedUI() {
  const n = selectedStocks.size;
  const label = n === 1 ? '1 stock selected' : `${n} stocks selected`;
  ['icSelectedBadge', 'selCountLabelScreener', 'selCountLabelIndustry'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
  // Copy / Clear have nothing to act on until something is selected
  document.querySelectorAll('.sel-action-btn').forEach(btn => { btn.disabled = n === 0; });
}

function copySelectedStocksWatchlist() {
  if (selectedStocks.size === 0) { alert('No stocks selected. Tick some from a chart popup first.'); return; }

  const stocks = [...selectedStocks].map(isin => Store.latestBySymbol[isin]).filter(Boolean);
  const byIndustry = {};
  stocks.forEach(s => {
    const ind = s.industry || 'Undefined-Diversified';
    if (!byIndustry[ind]) byIndustry[ind] = [];
    byIndustry[ind].push(s.symbol);
  });

  const parts = [];
  let industryCount = 0;
  Object.keys(byIndustry).sort((a, b) => byIndustry[b].length - byIndustry[a].length).forEach(ind => {
    const syms = byIndustry[ind];
    parts.push('###' + ind + '(' + syms.length + ')');
    syms.forEach(sym => parts.push('NSE:' + sym));
    industryCount++;
  });
  _tvWatchlistText = parts.join(',');

  document.getElementById('tvModalContent').textContent = _tvWatchlistText;
  document.getElementById('tvModalFooter').textContent = `${stocks.length} stocks across ${industryCount} industries — selected`;
  document.getElementById('tvCopyBtn').classList.remove('copied');
  document.getElementById('tvCopyBtn').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
  document.getElementById('tvModal').classList.add('active');
}

// ── Open / close ─────────────────────────────────────────────────────────────
function openIndustryCharts(industryName) {
  icMode = 'industry';
  icIndustry = industryName;
  icStocks = [];
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const ind = s.industry || 'Undefined-Diversified';
    if (ind === industryName) icStocks.push(s);
  }
  icStocks.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  icPage = 0;

  const n = icStocks.length;
  const pct = count => n > 0 ? (count / n * 100).toFixed(0) : '0';
  const above20 = icStocks.filter(s => s.aboveSMA).length;
  const above50 = icStocks.filter(s => {
    const days = Store.dailyBySymbol[s.isin] || [];
    const sma50 = computeDynSMA(days, 'close', 50);
    return !isNaN(sma50) && s.close > sma50;
  }).length;
  const near52H = icStocks.filter(s => !isNaN(s.distFrom52H) && s.distFrom52H <= 30).length;

  const titleEl = document.getElementById('icTitle');
  titleEl.textContent =
    `${industryName} — ${n} stock${n === 1 ? '' : 's'} (by Mkt Cap) · ` +
    `${pct(above20)}% above 20 SMA, ${pct(above50)}% above 50SMA, ${pct(near52H)}% within 30% from 52W high`;
  // Not a single-stock title here - no click-to-select behavior (see icRenderSingleStock).
  titleEl.style.cursor = '';
  titleEl.onclick = null;
  document.getElementById('industryChartsModal').classList.add('active');

  icSwitchTab('stocks');
}

// Single-stock mode: opened from the Symbol column — one big chart, no tabs, with
// Prev/Next to step through the same list currently shown in the results table.
function openStockChart(isin) {
  icMode = 'single';
  const list = (typeof screenerResults !== 'undefined' && screenerResults.length) ? screenerResults : [];
  let idx = list.findIndex(s => s.isin === isin);
  const stock = idx >= 0 ? list[idx] : Store.latestBySymbol[isin];
  if (!stock) return;

  icSingleList = idx >= 0 ? list : [stock];
  icSingleIndex = idx >= 0 ? idx : 0;

  document.getElementById('industryChartsModal').classList.add('active');
  icUpdateControlVisibility();
  icRenderSingleStock();
}

function icTotalSingle() { return icSingleList.length; }
function icPrevStock() { if (icSingleIndex > 0) { icSingleIndex--; icRenderSingleStock(); } }
function icNextStock() { if (icSingleIndex < icTotalSingle() - 1) { icSingleIndex++; icRenderSingleStock(); } }

function icRenderSingleStock() {
  const stock = icSingleList[icSingleIndex];
  if (!stock) return;

  const titleEl = document.getElementById('icTitle');
  titleEl.textContent = `${stock.symbol} — ${stock.industry || 'Undefined-Diversified'}`;
  // Clicking the stock name toggles selection too, not just the checkbox -
  // matches the grid cells, where the checkbox and name share one <label>.
  // toggleStockSelection() only updates the selectedStocks Set, so the
  // checkbox's own checked state (a separate DOM element here, unlike the
  // grid's shared <label>) needs to be synced by hand.
  titleEl.style.cursor = 'pointer';
  titleEl.onclick = () => {
    toggleStockSelection(stock.isin);
    document.getElementById('icSingleSelectCb').checked = isStockSelected(stock.isin);
  };
  document.getElementById('icSinglePageInfo').textContent = `${icSingleIndex + 1} of ${icTotalSingle()} stocks`;
  document.getElementById('icSinglePrevBtn').disabled = icSingleIndex <= 0;
  document.getElementById('icSingleNextBtn').disabled = icSingleIndex >= icTotalSingle() - 1;
  document.getElementById('icSingleSelectCb').checked = isStockSelected(stock.isin);
  document.getElementById('icSingleSelectCb').onchange = () => toggleStockSelection(stock.isin);

  icDisposeCharts();
  icDisposeIndustryChart();

  const container = document.getElementById('icIndustryChartContainer');
  const days = Store.dailyBySymbol[stock.isin] || [];
  document.getElementById('icSingleStats').textContent = icStatsLine(days);
  if (!container || days.length === 0 || typeof LightweightCharts === 'undefined') return;
  const { candleData, volumeData, closes } = icBuildBarsFromDays(days);
  icIndustryChartInst = icCreateChart(container, 'icVolumeSingle', document.getElementById('icSingleOhlc'));
  icSetChartData(icIndustryChartInst, candleData, volumeData, closes, IC_STOCK_VISIBLE_CANDLES);
}

function closeIndustryCharts() {
  document.getElementById('industryChartsModal').classList.remove('active');
  icDisposeCharts();
  icDisposeIndustryChart();
}

// ── Header control visibility (tabs / grid / pagination / single-stock nav) ──
function icUpdateControlVisibility() {
  const tabbar = document.getElementById('icTabbar');
  const grid = document.getElementById('icGrid');
  const gridPagination = document.getElementById('icPaginationWrap');
  const bigChartWrap = document.getElementById('icIndustryChartWrap');
  const singlePagination = document.getElementById('icSinglePaginationWrap');
  const singleSelect = document.getElementById('icSingleSelectWrap');
  const singleStats = document.getElementById('icSingleStats');
  const singleOhlc = document.getElementById('icSingleOhlc');
  const layoutToggle = document.getElementById('icLayoutToggle');

  if (icMode === 'single') {
    tabbar.style.display = 'none';
    grid.style.display = 'none';
    gridPagination.style.display = 'none';
    bigChartWrap.style.display = '';
    singlePagination.style.display = '';
    if (singleSelect) singleSelect.style.display = '';
    if (singleStats) singleStats.style.display = '';
    if (singleOhlc) singleOhlc.style.display = '';
    if (layoutToggle) layoutToggle.style.display = 'none';
  } else {
    tabbar.style.display = '';
    singlePagination.style.display = 'none';
    if (singleSelect) singleSelect.style.display = 'none';
    if (singleStats) singleStats.style.display = 'none';
    if (singleOhlc) singleOhlc.style.display = 'none';
    const showGrid = icActiveTab === 'stocks';
    grid.style.display = showGrid ? '' : 'none';
    gridPagination.style.display = showGrid ? '' : 'none';
    bigChartWrap.style.display = showGrid ? 'none' : '';
    if (layoutToggle) layoutToggle.style.display = showGrid ? '' : 'none';
  }
}

// ── Tabs (industry mode only) ─────────────────────────────────────────────────
function icSwitchTab(tab) {
  icActiveTab = tab;
  document.getElementById('icTabStocks').classList.toggle('active', tab === 'stocks');
  document.getElementById('icTabIndustry').classList.toggle('active', tab === 'industry');
  icUpdateControlVisibility();

  if (tab === 'stocks') {
    icDisposeIndustryChart();
    icRenderPage();
  } else {
    icDisposeCharts();
    icBuildIndustryChart();
  }
}

// ── Pagination (4 stocks per page in 2x2, 1 in 1x1 — sorted by market cap) ────
function icPageSize() { return icLayout === '1x1' ? 1 : IC_PAGE_SIZE; }
function icTotalPages() { return Math.max(1, Math.ceil(icStocks.length / icPageSize())); }

function icPrevPage() { if (icPage > 0) { icPage--; icRenderPage(); } }
function icNextPage() { if (icPage < icTotalPages() - 1) { icPage++; icRenderPage(); } }

// Switching layout keeps whichever stock was first-visible in view, instead of
// jumping back to the start of the list.
function icSetLayout(layout) {
  if (layout === icLayout) return;
  const firstVisibleIndex = icPage * icPageSize();
  icLayout = layout;
  icPage = Math.floor(firstVisibleIndex / icPageSize());
  document.getElementById('icGrid').classList.toggle('layout-1x1', icLayout === '1x1');
  document.getElementById('icLayout2x2Btn').classList.toggle('active', icLayout === '2x2');
  document.getElementById('icLayout1x1Btn').classList.toggle('active', icLayout === '1x1');
  icRenderPage();
}

// Re-renders whichever view (grid page or single stock) is currently showing —
// used when the ADR/Avg-MF checkboxes are toggled.
function icRefreshCurrentView() {
  if (icMode === 'single') { icRenderSingleStock(); return; }
  if (icActiveTab === 'stocks') { icRenderPage(); }
}

// Builds the "50D ADR" / "50D Avg MF" text for a stock, honoring the two toggle
// checkboxes. Returns '' when both are off.
function icStatsLine(days) {
  const bits = [];
  if (document.getElementById('icShowADR').checked) bits.push(`ADR ${fmt2(computeDynADR(days, 50))}%`);
  if (document.getElementById('icShowAvgMF').checked) bits.push(`MF ${fmtTurnoverCr(computeDynSMA(days, 'turnover', 50))}`);
  return bits.join(' · ');
}

function icRenderPage() {
  icDisposeCharts();
  const grid = document.getElementById('icGrid');
  const pageSize = icPageSize();
  const start = icPage * pageSize;
  const pageStocks = icStocks.slice(start, start + pageSize);

  grid.innerHTML = '';
  for (let i = 0; i < pageSize; i++) {
    const s = pageStocks[i];
    const cell = document.createElement('div');
    cell.className = 'ic-cell';
    if (!s) { cell.classList.add('ic-cell-empty'); grid.appendChild(cell); continue; }
    const days = Store.dailyBySymbol[s.isin] || [];
    const statsLine = icStatsLine(days);
    cell.innerHTML =
      `<div class="ic-cell-header">` +
        `<div class="ic-cell-line1">` +
          `<label class="ic-cell-select"><input type="checkbox" class="ic-select-cb" onchange="toggleStockSelection('${s.isin}')" ${isStockSelected(s.isin) ? 'checked' : ''}><span>${escapeHtml(s.symbol)}</span></label>` +
          `<span class="ic-cell-ohlc" id="icOhlc${i}"></span>` +
          `<span class="ic-cell-mcap">${fmtCr(s.marketCap || 0)}</span>` +
        `</div>` +
        (statsLine ? `<div class="ic-cell-line2">${statsLine}</div>` : '') +
      `</div>` +
      `<div class="ic-cell-chart" id="icChart${i}"></div>`;
    grid.appendChild(cell);
  }

  document.getElementById('icPageInfo').textContent = `Page ${icPage + 1} of ${icTotalPages()} (${icStocks.length} stocks)`;
  document.getElementById('icPrevBtn').disabled = icPage === 0;
  document.getElementById('icNextBtn').disabled = icPage >= icTotalPages() - 1;

  pageStocks.forEach((s, i) => {
    const container = document.getElementById('icChart' + i);
    const days = Store.dailyBySymbol[s.isin] || [];
    if (!container || days.length === 0) return;

    const { candleData, volumeData, closes } = icBuildBarsFromDays(days);
    const inst = icCreateChart(container, 'icVolume' + i, document.getElementById('icOhlc' + i));
    icChartInstances.push(inst);
    icSetChartData(inst, candleData, volumeData, closes, IC_STOCK_VISIBLE_CANDLES);
  });
}

// ── Shared chart plumbing (used by both the per-stock grid and the industry chart) ──
// `ohlcTarget`, when given, is a header element (next to the stock name) that the
// crosshair legend renders plain text into — no background/pill, matching the
// stock name's own styling. Without one (the Industry Chart tab, which has no
// per-stock name line to attach to), it falls back to a small overlay on the chart.
function icCreateChart(container, volumeScaleId, ohlcTarget) {
  // Grid cell containers are always freshly created, but the single-stock/
  // industry-index container is reused across renders — clear it first so the
  // legend/measure overlay elements from a previous chart don't pile up.
  container.innerHTML = '';

  const styles = getComputedStyle(document.documentElement);
  const textColor = (styles.getPropertyValue('--text2') || '#94a3b8').trim();
  const gridColor = (styles.getPropertyValue('--border') || '#334155').trim();

  const chart = LightweightCharts.createChart(container, {
    layout: { background: { color: IC_CHART_BG }, textColor },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { borderColor: gridColor },
    timeScale: { borderColor: gridColor, rightOffset: IC_RIGHT_OFFSET },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });

  // Candles/price-SMAs live in pane 0 (the default, main pane); volume bars +
  // their SMA get their OWN pane (index 1) - a real second canvas with a hard
  // boundary, not the old single-shared-pane-plus-scaleMargins trick. That
  // trick let an extreme outlier turnover day (confirmed live on JGCHEM: a
  // ~663 Cr spike vs a ~10-50 Cr typical range) render tall enough to bleed
  // visually past its intended margin and into the candlestick area above,
  // however the shared scale's own range was capped - capping the scale only
  // changes what a given price MAPS to, it doesn't clip rendering at a
  // boundary. A real second pane does actually clip at its own edge.
  const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: IC_UP_COLOR, downColor: IC_DOWN_COLOR,
    borderUpColor: IC_UP_COLOR, borderDownColor: IC_DOWN_COLOR,
    wickUpColor: IC_UP_COLOR, wickDownColor: IC_DOWN_COLOR,
  });
  candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

  const volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: volumeScaleId,
  }, 1);
  // Generous top margin so even the tallest (capped) bar keeps clear headroom
  // below the pane's own ceiling instead of touching it.
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });

  // 50 SMA of the turnover bars, sharing the bars' own pane/scale so its
  // height stays directly comparable to them. The scale's top is still
  // capped near the bars' typical range rather than the literal max (see
  // icComputeVolumeScaleCap/autoscaleInfoProvider in icSetChartData), so an
  // occasional extreme spike day clips at THIS pane's own boundary instead of
  // dominating the whole axis and flattening this line against the bottom.
  const volumeSmaSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: IC_VOLUME_SMA_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    priceScaleId: volumeScaleId,
  }, 1);
  // Circle marker on the line wherever it's a new 65-trading-day high.
  const volumeSmaMarkersPlugin = LightweightCharts.createSeriesMarkers(volumeSmaSeries, []);

  const volumePane = chart.panes()[1];
  if (volumePane) { chart.panes()[0].setStretchFactor(5); volumePane.setStretchFactor(1); }

  const smaSeries = {};
  IC_SMA_LENGTHS.forEach(len => {
    smaSeries[len] = chart.addSeries(LightweightCharts.LineSeries, {
      color: IC_SMA_COLORS[len], lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
  });

  // Purple "MF dot" markers (Money Flow Dots toggle) - a circle below the low
  // of every candle whose day matches the flagged combo (see icComputeMFDotMarkers).
  const markersPlugin = LightweightCharts.createSeriesMarkers(candleSeries, []);

  // Needed for both the fallback OHLC overlay below and the measure tool's overlay elements.
  container.style.position = container.style.position || 'relative';

  // ── TradingView-style OHLC / change% / money-flow legend, driven by the crosshair ──
  let legendEl;
  if (ohlcTarget) {
    legendEl = ohlcTarget; // plain text straight into the header — no background box
  } else {
    legendEl = document.createElement('div');
    legendEl.className = 'ic-legend';
    container.appendChild(legendEl);
  }

  const inst = { chart, candleSeries, volumeSeries, volumeSmaSeries, volumeSmaMarkersPlugin, smaSeries, markersPlugin, closes: [], candleData: [], volumeData: [], legendEl };

  inst.updateLegend = function(index) {
    const bars = inst.candleData;
    if (!bars.length) { legendEl.innerHTML = ''; return; }
    const i = (index == null) ? bars.length - 1 : index;
    const bar = bars[i];
    const vol = inst.volumeData[i];
    const prevClose = i > 0 ? bars[i - 1].close : null;
    const chg = prevClose ? (bar.close - prevClose) / prevClose * 100 : NaN;
    const chgCls = isNaN(chg) ? '' : (chg >= 0 ? 'positive' : 'negative');
    legendEl.innerHTML =
      `<span>O <b>${bar.open.toFixed(2)}</b></span>` +
      `<span>H <b>${bar.high.toFixed(2)}</b></span>` +
      `<span>L <b>${bar.low.toFixed(2)}</b></span>` +
      `<span>C <b>${bar.close.toFixed(2)}</b></span>` +
      `<span class="${chgCls}">${fmtPct(chg)}</span>` +
      `<span>MF <b>${fmtTurnoverCr(vol ? vol.value : 0)}</b></span>`;
  };

  chart.subscribeCrosshairMove(param => {
    if (!param.time) { inst.updateLegend(null); return; }
    const idx = inst.candleData.findIndex(c => c.time === param.time);
    inst.updateLegend(idx >= 0 ? idx : null);
  });

  // ── Custom click-click measure tool (Measure mode) ──────────────────────────
  // Click once to place the start point; the box then follows the pointer live
  // (like the old drag version) as it moves, with no button held; click again
  // to drop the end point and pin the measurement. Native pan/zoom is left on
  // the whole time (see icApplyMeasureMode), so an actual drag always pans the
  // chart as usual; only a stationary mouse-down/up (within
  // IC_MEASURE_DRAG_THRESHOLD) counts as a measure-tool click.
  const measureBox = document.createElement('div');
  measureBox.className = 'ic-measure-box';
  measureBox.style.display = 'none';
  const measureLabel = document.createElement('div');
  measureLabel.className = 'ic-measure-label';
  measureLabel.style.display = 'none';
  measureLabel.innerHTML = '<span class="ic-measure-text"></span><span class="ic-measure-close" title="Remove">&times;</span>';
  container.appendChild(measureBox);
  container.appendChild(measureLabel);
  const measureText = measureLabel.querySelector('.ic-measure-text');

  let measurePending = null; // {x, y} of the start click, until the end click arrives

  function clearMeasure() {
    measureBox.style.display = 'none';
    measureLabel.style.display = 'none';
  }
  inst.clearMeasure = clearMeasure;
  inst.cancelPendingMeasure = () => { measurePending = null; };

  measureLabel.querySelector('.ic-measure-close').addEventListener('click', e => {
    e.stopPropagation();
    clearMeasure();
  });

  function renderMeasure(x0, y0, x1, y1) {
    const price0 = candleSeries.coordinateToPrice(y0);
    const price1 = candleSeries.coordinateToPrice(y1);
    const logical0 = chart.timeScale().coordinateToLogical(x0);
    const logical1 = chart.timeScale().coordinateToLogical(x1);
    if (price0 == null || price1 == null || logical0 == null || logical1 == null) return;

    const bars = Math.abs(Math.round(logical1) - Math.round(logical0));
    const delta = price1 - price0;
    const chg = price0 !== 0 ? (delta / price0) * 100 : NaN;
    const up = delta >= 0;

    measureBox.style.left = Math.min(x0, x1) + 'px';
    measureBox.style.top = Math.min(y0, y1) + 'px';
    measureBox.style.width = Math.abs(x1 - x0) + 'px';
    measureBox.style.height = Math.abs(y1 - y0) + 'px';
    measureBox.classList.toggle('positive', up);
    measureBox.classList.toggle('negative', !up);
    measureBox.style.display = '';

    const sign = up ? '+' : '';
    measureText.innerHTML =
      `<span class="${up ? 'positive' : 'negative'}">${sign}${chg.toFixed(2)}%</span>` +
      ` (${sign}${delta.toFixed(2)}) · ${bars} ${bars === 1 ? 'day' : 'days'}`;
    measureLabel.style.left = x1 + 10 + 'px';
    measureLabel.style.top = Math.max(0, Math.min(y0, y1) - 4) + 'px';
    measureLabel.style.display = '';
  }

  // Live-follow: once a start point is placed, redraw the box/label to the
  // current pointer position on every plain hover move (no button held) -
  // ignored while a button is down so it doesn't fight the click/drag
  // detection below or a genuine chart-pan drag in progress.
  container.addEventListener('mousemove', e => {
    if (!icMeasureMode || !measurePending || e.buttons !== 0) return;
    const r = container.getBoundingClientRect();
    renderMeasure(measurePending.x, measurePending.y, e.clientX - r.left, e.clientY - r.top);
  });

  // A mouse-down/up pair is treated as a measure-tool "click" only if the mouse
  // barely moved between them; anything past IC_MEASURE_DRAG_THRESHOLD is a real
  // drag and is left alone so the chart's own pan handles it.
  container.addEventListener('mousedown', e => {
    if (!icMeasureMode || e.button !== 0) return;
    const rect = container.getBoundingClientRect();
    const downX = e.clientX - rect.left, downY = e.clientY - rect.top;
    let moved = false;

    const onMove = moveEvt => {
      if (Math.abs((moveEvt.clientX - rect.left) - downX) > IC_MEASURE_DRAG_THRESHOLD ||
          Math.abs((moveEvt.clientY - rect.top) - downY) > IC_MEASURE_DRAG_THRESHOLD) {
        moved = true;
      }
    };
    const onUp = upEvt => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) return; // a real drag - the chart already panned, not a measure click

      const r = container.getBoundingClientRect();
      const x = upEvt.clientX - r.left, y = upEvt.clientY - r.top;
      if (!measurePending) {
        clearMeasure(); // starting a fresh measurement replaces any pinned one
        measurePending = { x, y };
        renderMeasure(x, y, x, y); // zero-size box that the hover handler above immediately grows
      } else {
        renderMeasure(measurePending.x, measurePending.y, x, y);
        measurePending = null;
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return inst;
}

// Caps the volume/turnover price scale near the 95th percentile of the
// series (with headroom) instead of its literal max, so one extreme outlier
// day doesn't stretch the shared scale so hard that the 50 SMA line (and
// every typical-sized bar) gets squashed flat near the bottom.
function icComputeVolumeScaleCap(volumeData) {
  const vals = volumeData.map(v => v.value).filter(v => v > 0).sort((a, b) => a - b);
  if (vals.length < 20) return null; // too little data for a percentile to mean anything
  const p95 = vals[Math.floor(vals.length * 0.95)];
  return p95 * 1.3; // headroom so the 95th-percentile bar itself isn't flush against the top
}

// Feed the full history (correct SMA lookback), but default the visible window to
// `visibleCandles` — the user can still scroll back further.
function icSetChartData(inst, candleData, volumeData, closes, visibleCandles) {
  inst.candleData = candleData;
  inst.volumeData = volumeData; // true, uncapped values - used everywhere except the bars' own rendering
  inst.closes = closes;
  inst.candleSeries.setData(candleData);

  // Capping the SCALE's maxValue alone isn't enough: a bar whose raw value is
  // still far past that cap keeps climbing proportionally past the scale's
  // own top-margin line, all the way to the pane's hard edge (confirmed live:
  // a ~663 Cr outlier against a ~300 Cr cap still touched the ceiling despite
  // a 20% top margin, since the margin only reserves space for values AT the
  // cap, not however far beyond it a real outlier goes). Clipping the
  // rendered bar VALUE itself at the same cap guarantees no bar can ever
  // exceed the scale's max, so the margin's headroom always holds. The
  // legend/SMA/MF-dots below all keep reading inst.volumeData (uncapped), so
  // this only affects bar height, never the real numbers.
  const volCap = icComputeVolumeScaleCap(volumeData);
  const renderedVolumeData = volCap
    ? volumeData.map(v => (v.value > volCap ? { ...v, value: volCap } : v))
    : volumeData;
  inst.volumeSeries.setData(renderedVolumeData);
  inst.volumeSeries.applyOptions({
    autoscaleInfoProvider: volCap ? () => ({ priceRange: { minValue: 0, maxValue: volCap } }) : undefined,
  });
  icUpdateInstanceSMA(inst);
  icUpdateVolumeSMA(inst);
  icUpdateInstanceMFDots(inst);
  icApplyPriceScaleMode(inst);
  inst.updateLegend();

  if (candleData.length > visibleCandles) {
    inst.chart.timeScale().setVisibleLogicalRange({ from: candleData.length - visibleCandles, to: candleData.length - 1 + IC_RIGHT_OFFSET });
  } else {
    inst.chart.timeScale().fitContent();
  }
}

function icBuildBarsFromDays(days) {
  const candleData = [], volumeData = [], closes = [];
  days.forEach(d => {
    const time = ewToBusinessDay(d.date);
    if (!time) return;
    candleData.push({ time, open: d.open, high: d.high, low: d.low, close: d.close });
    volumeData.push({
      time,
      value: d.turnover || 0,
      color: d.close >= d.open ? ewHexToRgba(IC_UP_COLOR, 0.5) : ewHexToRgba(IC_DOWN_COLOR, 0.5),
    });
    closes.push(d.close);
  });
  return { candleData, volumeData, closes };
}

function icDisposeCharts() {
  icChartInstances.forEach(inst => { if (inst && inst.chart) { try { inst.chart.remove(); } catch (e) {} } });
  icChartInstances = [];
}

// ── Industry Chart tab: equal-weight index built from the industry's constituents ──
// Each trading day, every stock's own % move (open/high/low/close vs ITS prior
// close) is averaged across all constituents (equal weight), then chained onto the
// previous index close — the same method real equal-weight sector indices use.
// Turnover is summed (total industry activity), not averaged.
function icComputeIndustryIndex(stocks) {
  const perStock = stocks
    .map(s => Store.dailyBySymbol[s.isin] || [])
    .filter(days => days.length > 0)
    .map(days => {
      const byDate = new Map();
      days.forEach(d => byDate.set(d.date, d));
      return byDate;
    });
  if (perStock.length === 0) return null;

  const prevClose = new Array(perStock.length).fill(null);
  const candleData = [], volumeData = [], closes = [];
  let indexClose = 100;

  for (const dateStr of Store.dates) {
    const openR = [], highR = [], lowR = [], closeR = [];
    let turnoverSum = 0;

    for (let i = 0; i < perStock.length; i++) {
      const rec = perStock[i].get(dateStr);
      if (!rec) continue;
      turnoverSum += rec.turnover || 0;
      const pc = prevClose[i];
      if (pc && pc > 0) {
        openR.push(rec.open / pc);
        highR.push(rec.high / pc);
        lowR.push(rec.low / pc);
        closeR.push(rec.close / pc);
      }
      prevClose[i] = rec.close;
    }

    if (closeR.length === 0) continue; // no constituent had a prior close yet
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const open = indexClose * avg(openR);
    const high = indexClose * avg(highR);
    const low = indexClose * avg(lowR);
    const close = indexClose * avg(closeR);
    indexClose = close;

    const time = ewToBusinessDay(dateStr);
    if (!time) continue;
    candleData.push({ time, open, high, low, close });
    volumeData.push({ time, value: turnoverSum, color: close >= open ? ewHexToRgba(IC_UP_COLOR, 0.5) : ewHexToRgba(IC_DOWN_COLOR, 0.5) });
    closes.push(close);
  }

  return { candleData, volumeData, closes };
}

function icBuildIndustryChart() {
  const container = document.getElementById('icIndustryChartContainer');
  if (!container || typeof LightweightCharts === 'undefined') return;

  const data = icComputeIndustryIndex(icStocks);
  if (!data || data.candleData.length === 0) return;

  icIndustryChartInst = icCreateChart(container, 'icVolumeIndustry');
  icSetChartData(icIndustryChartInst, data.candleData, data.volumeData, data.closes, IC_INDUSTRY_VISIBLE_CANDLES);
}

function icDisposeIndustryChart() {
  if (icIndustryChartInst && icIndustryChartInst.chart) {
    try { icIndustryChartInst.chart.remove(); } catch (e) {}
  }
  icIndustryChartInst = null;
}

// ── SMA toggle (updates existing chart instances without rebuilding them) ────
function icUpdateInstanceSMA(inst) {
  IC_SMA_LENGTHS.forEach(len => {
    const cb = document.getElementById('icSMA' + len);
    if (!cb || !cb.checked || inst.closes.length < len) { inst.smaSeries[len].setData([]); return; }
    const sma = ewComputeSMA(inst.closes, len);
    const offset = inst.closes.length - sma.length;
    inst.smaSeries[len].setData(sma.map((v, idx) => ({ time: inst.candleData[idx + offset].time, value: v })));
  });
}

function icUpdateAllSMA() {
  icChartInstances.forEach(icUpdateInstanceSMA);
  if (icIndustryChartInst) icUpdateInstanceSMA(icIndustryChartInst);
}

// Always-on 50 SMA of the turnover bars themselves (not user-toggleable, unlike
// the price SMAs above), on the same price scale/pane as the volume histogram.
// Also marks every point that's a new IC_VOLUME_SMA_HIGH_LOOKBACK-day high of
// the smoothed line itself (not of the raw bars) with a circle on the line.
function icUpdateVolumeSMA(inst) {
  const turnovers = inst.volumeData.map(v => v.value);
  if (turnovers.length < 50) {
    inst.volumeSmaSeries.setData([]);
    inst.volumeSmaMarkersPlugin.setMarkers([]);
    return;
  }
  const sma = ewComputeSMA(turnovers, 50);
  const offset = turnovers.length - sma.length;
  const smaPoints = sma.map((v, idx) => ({ time: inst.volumeData[idx + offset].time, value: v }));
  inst.volumeSmaSeries.setData(smaPoints);

  const markers = [];
  for (let i = 0; i < sma.length; i++) {
    const start = Math.max(0, i - IC_VOLUME_SMA_HIGH_LOOKBACK + 1);
    let isHigh = true;
    for (let j = start; j < i; j++) {
      if (sma[j] > sma[i]) { isHigh = false; break; }
    }
    if (isHigh) {
      markers.push({ time: smaPoints[i].time, position: 'inBar', color: IC_VOLUME_SMA_HIGH_COLOR, shape: 'circle', size: 1 });
    }
  }
  inst.volumeSmaMarkersPlugin.setMarkers(markers);
}

document.getElementById('icSMA10').addEventListener('change', icUpdateAllSMA);
document.getElementById('icSMA20').addEventListener('change', icUpdateAllSMA);
document.getElementById('icSMA50').addEventListener('change', icUpdateAllSMA);

// ── MF Dots toggle: purple circle below the low of every candle whose day had
// Money Flow (turnover) >= IC_MF_DOT_MIN_CR crores AND |day change%| >= IC_MF_DOT_MIN_CHG
// (big moves either direction), on both up and down days (position is anchored
// to the bar's low either way). ──
function icComputeMFDotMarkers(inst) {
  const candles = inst.candleData, vols = inst.volumeData;
  const markers = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    if (!prevClose) continue;
    const chgPct = (candles[i].close - prevClose) / prevClose * 100;
    const mfCr = (vols[i] ? vols[i].value : 0) / 100; // turnover stored in lakhs; Cr = /100
    if (mfCr >= IC_MF_DOT_MIN_CR && Math.abs(chgPct) >= IC_MF_DOT_MIN_CHG) {
      markers.push({ time: candles[i].time, position: 'belowBar', color: IC_MF_DOT_COLOR, shape: 'circle', size: 1 });
    }
  }
  return markers;
}

function icUpdateInstanceMFDots(inst) {
  const cb = document.getElementById('icShowMFDots');
  inst.markersPlugin.setMarkers((cb && cb.checked) ? icComputeMFDotMarkers(inst) : []);
}

function icUpdateAllMFDots() {
  icChartInstances.forEach(icUpdateInstanceMFDots);
  if (icIndustryChartInst) icUpdateInstanceMFDots(icIndustryChartInst);
}

document.getElementById('icShowMFDots').addEventListener('change', icUpdateAllMFDots);

// ── 50D ADR / 50D Avg Money Flow toggles (re-render the current view) ────────
document.getElementById('icShowADR').addEventListener('change', icRefreshCurrentView);
document.getElementById('icShowAvgMF').addEventListener('change', icRefreshCurrentView);

// ── Measure mode toggle ───────────────────────────────────────────────────────
document.getElementById('icMeasureMode').addEventListener('change', () => {
  icMeasureMode = document.getElementById('icMeasureMode').checked;
  icApplyMeasureMode();
});

// ── % Change toggle (TradingView-style percentage price scale, relative to the
// left edge of the visible range, instead of absolute price) ─────────────────
function icApplyPriceScaleMode(inst) {
  const pct = document.getElementById('icPctMode').checked;
  inst.candleSeries.priceScale().applyOptions({
    mode: pct ? LightweightCharts.PriceScaleMode.Percentage : LightweightCharts.PriceScaleMode.Normal,
  });
}

function icUpdateAllPriceScaleMode() {
  icChartInstances.forEach(icApplyPriceScaleMode);
  if (icIndustryChartInst) icApplyPriceScaleMode(icIndustryChartInst);
}

document.getElementById('icPctMode').addEventListener('change', icUpdateAllPriceScaleMode);

// ── Industry / Symbol column links (event delegation — table body is re-rendered often) ──
document.getElementById('screenerBody').addEventListener('click', e => {
  const indLink = e.target.closest('.industry-link');
  if (indLink) { e.preventDefault(); openIndustryCharts(indLink.dataset.industry); return; }
  const stockLink = e.target.closest('.stock-link');
  if (stockLink) { e.preventDefault(); openStockChart(stockLink.dataset.isin); }
});

// ── Keyboard: Down = next stock/page, Up = previous stock/page (single and grid views); Escape = close ──────────────────────────
document.addEventListener('keydown', e => {
  if (!document.getElementById('industryChartsModal').classList.contains('active')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeIndustryCharts(); return; }
  if (icMode === 'single') {
    if (e.key === 'ArrowDown') { e.preventDefault(); icNextStock(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); icPrevStock(); }
    return;
  }
  if (icActiveTab !== 'stocks') return;
  if (e.key === 'ArrowDown') { e.preventDefault(); icNextPage(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); icPrevPage(); }
});

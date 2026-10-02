// ═══════════════════════════════════════════════════════════════════════════════
// MARKET OVERVIEW — candlestick chart for any downloaded NSE index / sector index
// (NSE_DATA/NSE_Indices_Combined.csv, written by Download-NSE-Bhavcopy.ps1), with an
// "indicator" pane underneath: the % of all NSE stocks making a new 1M / 3M / 52Wk /
// all-time high, reusing the history computed for the Market Breadth tab (_brdHistory).
// Display only: nothing here feeds back into data processing.
// ═══════════════════════════════════════════════════════════════════════════════

const MO_INDICES_URL = 'NSE_DATA/NSE_Indices_Combined.csv';
const MO_DEFAULT_INDEX = 'Nifty 500';
const MO_INDICATORS = {
  high1m:  { label: '1M High',   color: '#18eee7' },
  high3m:  { label: '3M High',   color: '#f59e0b' },
  high1y:  { label: '52Wk High', color: '#a78bfa' },
  highAth: { label: 'ATH',       color: '#ff1616' },
};
// Dropdown grouping: these are "Broad Market"; every other index in the file is listed under "Sectors".
const MO_BROAD = [
  'Nifty 50', 'Nifty Next 50', 'Nifty 100', 'Nifty 200', 'Nifty 500', 'Nifty Total Market', 'Nifty Next 100',
  'Nifty Midcap 50', 'Nifty Midcap 100', 'Nifty Midcap 150', 'Nifty Midcap Select', 'Nifty LargeMidcap 250',
  'Nifty Smallcap 50', 'Nifty Smallcap 100', 'Nifty Smallcap 250', 'Nifty Smallcap 500', 'Nifty Microcap 250',
  'Nifty MidSmallcap 400', 'India VIX',
];

let _moData = null;        // { indexName: [{date, open, high, low, close}] } once loaded
let _moNames = {};         // lower-case name -> display name as written in the file
let _moLoadState = 'idle'; // idle | loading | ready | missing
let moChart = null, moCandleSeries = null, moIndicatorSeries = null;
let _moBars = [], _moIndicator = [];
let _moBarByKey = {}, _moIndByKey = {};
let moTools = null, _moToolsIndex = null, _moToolsIndicator = null;
const moMASeries = {}; // SMA length -> line series on the candle pane (lengths/colors shared with the EW Index chart)

function moTimeKey(t) { return t.year + '-' + t.month + '-' + t.day; }

function moParseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Index names contain no commas, so a plain split is safe for this file.
    const f = line.split(',').map(x => x.replace(/^"|"$/g, ''));
    const name = f[0], date = f[1], close = parseFloat(f[5]);
    if (!name || !(close > 0)) continue;
    // Some indexes publish only a close on some days (O/H/L blank); draw those as a flat bar at the close.
    const num = (v) => { const n = parseFloat(v); return n > 0 ? n : close; };
    (out[name] || (out[name] = [])).push({ date, open: num(f[2]), high: num(f[3]), low: num(f[4]), close });
  }
  return out;
}

async function moLoad() {
  if (_moLoadState === 'loading' || _moLoadState === 'ready') return;
  _moLoadState = 'loading';
  try {
    const res = await fetch(MO_INDICES_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _moData = moParseCsv(await res.text());
    _moNames = {};
    Object.keys(_moData).forEach(n => { _moNames[n.toLowerCase()] = n; });
    _moLoadState = Object.keys(_moData).length ? 'ready' : 'missing';
  } catch (e) {
    _moLoadState = 'missing';
  }
}

function moPopulateDropdown() {
  const sel = document.getElementById('moIndexSelect');
  if (!sel || sel.options.length) return;
  const used = new Set();
  const addGroup = (label, names) => {
    const og = document.createElement('optgroup');
    og.label = label;
    names.forEach(n => {
      const real = _moNames[n.toLowerCase()];
      if (!real || used.has(real)) return;
      used.add(real);
      og.appendChild(new Option(real, real));
    });
    if (og.children.length) sel.appendChild(og);
  };
  addGroup('Broad Market', MO_BROAD);
  addGroup('Sectors', Object.keys(_moData).filter(n => !used.has(n)).sort((a, b) => a.localeCompare(b)));
  const def = _moNames[MO_DEFAULT_INDEX.toLowerCase()];
  if (def) sel.value = def;
}

function moEnsureChart() {
  if (moChart || typeof LightweightCharts === 'undefined') return;
  const container = document.getElementById('moChartContainer');
  if (!container) return;
  const styles = getComputedStyle(document.documentElement);
  const textColor = (styles.getPropertyValue('--text2') || '#94a3b8').trim();
  const gridColor = (styles.getPropertyValue('--border') || '#334155').trim();

  moChart = LightweightCharts.createChart(container, {
    layout: { background: { color: BRD_CHART_BG }, textColor },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { borderColor: gridColor },
    timeScale: { rightBarStaysOnScroll: true, borderColor: gridColor },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });
  moCandleSeries = moChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: BRD_UP_COLOR, downColor: BRD_DOWN_COLOR,
    borderUpColor: BRD_UP_COLOR, borderDownColor: BRD_DOWN_COLOR,
    wickUpColor: BRD_UP_COLOR, wickDownColor: BRD_DOWN_COLOR,
  });
  moCandleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });

  EW_MA_LENGTHS.forEach(len => {
    moMASeries[len] = moChart.addSeries(LightweightCharts.LineSeries, {
      color: EW_MA_COLORS[len], lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    });
  });

  moIndicatorSeries = moChart.addSeries(LightweightCharts.LineSeries, {
    color: MO_INDICATORS.high3m.color, lineWidth: 2, priceLineVisible: false,
    priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
  }, 1);
  moIndicatorSeries.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.05 } });
  const panes = moChart.panes();
  if (panes[1]) { panes[0].setStretchFactor(3); panes[1].setStretchFactor(1); }

  moChart.subscribeCrosshairMove(param => moUpdateLegend(param.time ? moTimeKey(param.time) : null));

  // One-shot Measure / Trend Line tools (chart-tools.js)
  moTools = new ChartTools(moChart, [{ series: moCandleSeries }, { series: moIndicatorSeries, unit: 'pts' }], container, {
    measure: document.getElementById('moToolMeasure'),
    trend: document.getElementById('moToolTrend'),
    clear: document.getElementById('moToolClear'),
    remove: document.getElementById('moToolDelete'),
  });
}

function moUpdateLegend(timeKey) {
  const el = document.getElementById('moChartOhlc');
  if (!el) return;
  const bar = timeKey ? _moBarByKey[timeKey] : _moBars[_moBars.length - 1];
  if (!bar) { el.innerHTML = ''; return; }
  const ind = timeKey ? _moIndByKey[timeKey] : _moIndicator[_moIndicator.length - 1];
  const cfg = MO_INDICATORS[document.getElementById('moIndicatorSelect').value];
  const f = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  el.innerHTML =
    `<span>O <b>${f(bar.open)}</b></span><span>H <b>${f(bar.high)}</b></span>` +
    `<span>L <b>${f(bar.low)}</b></span><span>C <b>${f(bar.close)}</b></span>` +
    (ind ? `<span style="color:${cfg.color}">Stocks making ${cfg.label} <b>${ind.value.toFixed(1)}%</b></span>` : '');
}

async function renderMarketOverview() {
  const noteEl = document.getElementById('moNote');
  await moLoad();
  if (_moLoadState !== 'ready') {
    if (noteEl) noteEl.textContent = 'No index data found. Run Download-NSE-Bhavcopy.ps1 to download NSE_Indices_Combined.csv, then reload.';
    return;
  }
  if (noteEl) noteEl.textContent = '';
  moPopulateDropdown();
  moEnsureChart();
  if (!moChart) return;

  const name = document.getElementById('moIndexSelect').value;
  const indKey = document.getElementById('moIndicatorSelect').value;
  const cfg = MO_INDICATORS[indKey];
  const rows = _moData[name] || [];
  // Drawings are anchored to this index's prices, so they don't carry over to another index.
  if (moTools && _moToolsIndex !== name) moTools.clear(0);
  if (moTools && _moToolsIndicator !== indKey) moTools.clear(1); // the indicator's values change with the selection
  _moToolsIndex = name; _moToolsIndicator = indKey;

  _moBars = []; _moBarByKey = {};
  rows.forEach(r => {
    const time = ewToBusinessDay(r.date);
    if (!time) return;
    const bar = { time, open: r.open, high: r.high, low: r.low, close: r.close };
    _moBars.push(bar);
    _moBarByKey[moTimeKey(time)] = bar;
  });
  moCandleSeries.setData(_moBars);

  const closes = _moBars.map(b => b.close);
  EW_MA_LENGTHS.forEach(len => {
    const cb = document.getElementById('moMA' + len);
    if (!cb || !cb.checked || closes.length < len) { moMASeries[len].setData([]); return; }
    const sma = ewComputeSMA(closes, len);
    const offset = closes.length - sma.length;
    moMASeries[len].setData(sma.map((v, i) => ({ time: _moBars[i + offset].time, value: v })));
  });

  // Market-wide breadth indicator; _brdHistory is filled by renderBreadth() once stock history has loaded.
  _moIndicator = []; _moIndByKey = {};
  if (typeof _brdHistory !== 'undefined' && _brdHistory.length) {
    _brdHistory.forEach(d => {
      const time = ewToBusinessDay(d.date);
      const o = d[indKey + 'OHLC'];
      if (!time || !o) return;
      const pt = { time, value: o.close };
      _moIndicator.push(pt);
      _moIndByKey[moTimeKey(time)] = pt;
    });
  }
  moIndicatorSeries.applyOptions({ color: cfg.color });
  moIndicatorSeries.setData(_moIndicator);

  document.getElementById('moChartTitle').textContent = `${name} — with % of stocks making ${cfg.label}`;
  const last = rows[rows.length - 1];
  document.getElementById('moSubtitle').textContent =
    `${rows.length} trading days to ${last ? last.date : '-'} · indicator covers all NSE stocks` +
    (_moIndicator.length ? '' : ' · stock history still loading, indicator will appear once it finishes');
  moUpdateLegend(null);
  requestAnimationFrame(() => ewFitWithRightPad(moChart));
}

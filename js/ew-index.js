// ═══════════════════════════════════════════════════════════════════════════════
// EQUAL-WEIGHT MIDSMALLCAP 400 INDEX — candlestick chart via TradingView Lightweight Charts
// ═══════════════════════════════════════════════════════════════════════════════

let ewChart = null;
let ewCandleSeries = null;
let ewVolumeSeries = null;
let ewUpColor = '#05df72';
let ewDownColor = '#f87171';
const ewMASeries = {};
const EW_MA_LENGTHS = [20, 50, 200];
const EW_MA_COLORS = { 20: '#ffb900', 50: '#00d3f3', 200: '#c27aff' };

const EW_MONTHS = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

function ewHexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function ewToBusinessDay(dmy) {
  // "12-Sep-2025" -> {year:2025, month:9, day:12}
  const parts = (dmy || '').split('-');
  if (parts.length !== 3) return null;
  const month = EW_MONTHS[parts[1]];
  if (!month) return null;
  return { year: parseInt(parts[2], 10), month, day: parseInt(parts[0], 10) };
}

function ewComputeSMA(closes, length) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= length) sum -= closes[i - length];
    if (i >= length - 1) out.push(sum / length);
  }
  return out;
}

// ── Tab visibility (called from showDashboard, before the tab is ever clicked) ──
function updateEWIndexTabVisibility() {
  const tabBtn = document.querySelector('.tab[data-tab="ewindex"]');
  if (!tabBtn) return;
  const ew = Store.ewIndex;
  const hasData = ew && Array.isArray(ew.bars) && ew.bars.length > 0;
  tabBtn.style.display = hasData ? '' : 'none';
}

// ── Chart creation (deferred until the panel is actually visible) ───────────────
function ewEnsureChart() {
  if (ewChart || typeof LightweightCharts === 'undefined') return;
  const container = document.getElementById('ewChartContainer');
  if (!container) return;

  const styles = getComputedStyle(document.documentElement);
  const textColor = (styles.getPropertyValue('--text2') || '#94a3b8').trim();
  const gridColor = (styles.getPropertyValue('--border') || '#334155').trim();
  ewUpColor = (styles.getPropertyValue('--green') || '#05df72').trim();
  ewDownColor = (styles.getPropertyValue('--red') || '#f87171').trim();

  ewChart = LightweightCharts.createChart(container, {
    layout: { background: { color: 'transparent' }, textColor },
    grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
    rightPriceScale: { borderColor: gridColor },
    timeScale: { borderColor: gridColor },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });

  ewCandleSeries = ewChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: ewUpColor, downColor: ewDownColor,
    borderUpColor: ewUpColor, borderDownColor: ewDownColor,
    wickUpColor: ewUpColor, wickDownColor: ewDownColor,
  });
  ewCandleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.28 } });

  ewVolumeSeries = ewChart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'ewVolume',
  });
  ewVolumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

  EW_MA_LENGTHS.forEach(len => {
    ewMASeries[len] = ewChart.addSeries(LightweightCharts.LineSeries, {
      color: EW_MA_COLORS[len],
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
  });
}

// ── Render / refresh (call whenever the ewindex tab is shown or an MA toggle changes) ──
function renderEWIndexChart() {
  const ew = Store.ewIndex;
  if (!ew || !ew.bars || !ew.bars.length) return;

  ewEnsureChart();
  if (!ewChart) return; // library failed to load

  const cols = ew.cols;
  const iDate = cols.indexOf('date'), iOpen = cols.indexOf('open'), iHigh = cols.indexOf('high'),
        iLow = cols.indexOf('low'), iClose = cols.indexOf('close'), iTurnover = cols.indexOf('turnover');

  const candleData = [];
  const volumeData = [];
  const closes = [];

  ew.bars.forEach(b => {
    const time = ewToBusinessDay(b[iDate]);
    if (!time) return;
    const open = b[iOpen], high = b[iHigh], low = b[iLow], close = b[iClose];
    candleData.push({ time, open, high, low, close });
    volumeData.push({
      time,
      value: b[iTurnover],
      color: close >= open ? ewHexToRgba(ewUpColor, 0.5) : ewHexToRgba(ewDownColor, 0.5),
    });
    closes.push(close);
  });

  ewCandleSeries.setData(candleData);
  ewVolumeSeries.setData(volumeData);

  EW_MA_LENGTHS.forEach(len => {
    const cb = document.getElementById('ewMA' + len);
    if (!cb || !cb.checked || closes.length < len) {
      ewMASeries[len].setData([]);
      return;
    }
    const sma = ewComputeSMA(closes, len);
    const offset = closes.length - sma.length;
    ewMASeries[len].setData(sma.map((v, i) => ({ time: candleData[i + offset].time, value: v })));
  });

  const infoEl = document.getElementById('ewConstituentInfo');
  if (infoEl) infoEl.textContent = `${ew.constituentCount} constituents · ${ew.bars.length} trading days`;

  ewChart.timeScale().fitContent();
}

EW_MA_LENGTHS.forEach(len => {
  const cb = document.getElementById('ewMA' + len);
  if (cb) cb.addEventListener('change', () => { if (Store.dashboardVisible) renderEWIndexChart(); });
});

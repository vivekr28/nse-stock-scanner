// ═══════════════════════════════════════════════════════════════════════════════
// SHARED CHART HELPERS - small pure functions used by several charts: Market Overview (js/market-overview.js), Market Breadth
// (js/breadth.js) and the Industry / Stock chart popup (js/industry-charts.js).
//
// This file used to be js/ew-index.js, the code of the "EW Index" tab (an equal-weight Nifty MidSmallcap 400 candlestick chart).
// That tab was removed 2026-11-13; only the helpers the other charts share stayed, under their old names (ew...), so no other file
// had to change. The EW_... names are historical - they are general chart helpers now.
// ═══════════════════════════════════════════════════════════════════════════════

// The moving averages the charts offer, and their colours
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

// Fit all bars into view, leaving EW_RIGHT_PAD_BARS empty bar-widths to the right of the last one.
// fitContent() alone fits to the last bar exactly (flush with the right edge) because it uses the time
// scale's rightOffset option, so set that first. Letting the chart do the fit also means the extent is the
// union of every series on it (e.g. an indicator pane with more history than the candles), which counting one
// series' bars would get wrong and push the newest bars past the right edge.
const EW_RIGHT_PAD_BARS = 10;
function ewFitWithRightPad(chart) {
  chart.timeScale().applyOptions({ rightOffset: EW_RIGHT_PAD_BARS });
  chart.timeScale().fitContent();
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

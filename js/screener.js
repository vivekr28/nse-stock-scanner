// ═══════════════════════════════════════════════════════════════════════════════
// SCREENER — advanced AND-logic stock scanner with 11 filters
// ═══════════════════════════════════════════════════════════════════════════════

let screenerResults = [];
let screenerPassed = [];
let screenerFailed = [];
let screenerPage = 0;
let scrSortCol = null;
let scrSortDir = 1;
let scrShowingFailed = false;
const SCR_PAGE_SIZE = 100;

// Compute dynamic SMA for a given lookback length on a stock's daily data
function computeDynSMA(days, field, length) {
  if (days.length < length) return NaN;
  const slice = days.slice(-length);
  return slice.reduce((s, d) => s + (d[field] || 0), 0) / length;
}

// Compute dynamic EMA for a given lookback length on a stock's daily data
function computeDynEMA(days, field, length) {
  if (days.length < length) return NaN;
  const k = 2 / (length + 1);
  // Seed with SMA of first 'length' values
  let ema = 0;
  for (let i = 0; i < length; i++) ema += (days[i][field] || 0);
  ema /= length;
  // Then apply EMA formula for remaining values
  for (let i = length; i < days.length; i++) {
    ema = (days[i][field] || 0) * k + ema * (1 - k);
  }
  return ema;
}


// Compute SMA using available data (min 5 bars) when full length not available
function computeDynSMAPartial(days, field, length) {
  if (days.length === 0) return NaN;
  const usable = Math.min(days.length, length);
  if (usable < 5) return NaN; // need at least 5 bars for any meaningful average
  const slice = days.slice(-usable);
  return slice.reduce((s, d) => s + (d[field] || 0), 0) / usable;
}

// Compute EMA using available data (min 5 bars) when full length not available
function computeDynEMAPartial(days, field, length) {
  if (days.length === 0) return NaN;
  const usable = Math.min(days.length, length);
  if (usable < 5) return NaN; // need at least 5 bars
  const k = 2 / (usable + 1);
  let ema = 0;
  for (let i = 0; i < usable; i++) ema += (days[i][field] || 0);
  ema /= usable;
  for (let i = usable; i < days.length; i++) {
    ema = (days[i][field] || 0) * k + ema * (1 - k);
  }
  return ema;
}

// Compute dynamic ADR for a given lookback length (strict: requires full length)
function computeDynADR(days, length) {
  if (days.length < length) return NaN;
  const slice = days.slice(-length);
  return slice.reduce((s, d) => s + ((d.high - d.low) / d.close * 100), 0) / length;
}

// Compute ADR using available data (min 5 bars) when full length not available
function computeDynADRPartial(days, length) {
  if (days.length === 0) return NaN;
  const usable = Math.min(days.length, length);
  if (usable < 5) return NaN;
  const slice = days.slice(-usable);
  return slice.reduce((s, d) => s + ((d.high - d.low) / d.close * 100), 0) / usable;
}

// Trading-day lookback for each Performance filter period
const PERF_PERIOD_DAYS = { '1d': 1, '1w': 5, '1m': 21, '3m': 63, '6m': 126, '1y': 250 };

// Compute % price change over N trading days (strict: requires full lookback)
function computeDynPerformance(days, lookbackDays) {
  if (days.length < lookbackDays + 1) return NaN;
  const latest = days[days.length - 1];
  const ref = days[days.length - 1 - lookbackDays];
  return ref.close > 0 ? ((latest.close - ref.close) / ref.close * 100) : NaN;
}

// Compute % price change using available data (min 2 bars) when full lookback not available
function computeDynPerformancePartial(days, lookbackDays) {
  if (days.length < 2) return NaN;
  const usable = Math.min(days.length - 1, lookbackDays);
  const latest = days[days.length - 1];
  const ref = days[days.length - 1 - usable];
  return ref.close > 0 ? ((latest.close - ref.close) / ref.close * 100) : NaN;
}

// 'YYYY-MM-DD' (date input) -> local-midnight timestamp, comparable with parseDate() of 'DD-MMM-YYYY' bar dates
function scrIsoToTs(iso) {
  if (!iso) return NaN;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Index of the last bar dated on/before ts (bars are date-sorted), or -1
function scrBarIdxOnOrBefore(days, ts) {
  let lo = 0, hi = days.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (parseDate(days[mid].date) <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// % change from <fromField> on the fromDate bar to <toField> on the toDate bar.
// A date that isn't a trading day uses the nearest earlier trading day's bar.
function computeDynDateChange(days, fromTs, fromField, toTs, toField, allowPartial) {
  if (isNaN(fromTs)) return { pct: NaN, reason: 'No From date selected' };
  if (fromTs > toTs) return { pct: NaN, reason: 'From date is after To date' };
  if (days.length === 0) return { pct: NaN, reason: 'No data' };
  let fi = scrBarIdxOnOrBefore(days, fromTs);
  if (fi < 0) {
    if (!allowPartial) return { pct: NaN, reason: 'No data on/before From date' };
    fi = 0; // newly listed: fall back to first available bar (same as the other "Partial history" filters)
  }
  const ti = scrBarIdxOnOrBefore(days, toTs);
  if (ti < fi) return { pct: NaN, reason: 'No data in the selected date range' };
  const a = days[fi][fromField], b = days[ti][toField];
  if (!(a > 0) || !(b > 0)) return { pct: NaN, reason: 'Missing price on selected date' };
  return { pct: (b - a) / a * 100 };
}

const SCR_FIELD_LETTER = { open: 'O', high: 'H', low: 'L', close: 'C' };

// Default the F16 date pickers to ~1 month back -> latest bar, and limit them to the loaded data range
function initF16Dates() {
  const from = document.getElementById('scrF16FromDate');
  const to = document.getElementById('scrF16ToDate');
  if (!from || !to || !Store.dates || Store.dates.length === 0) return;
  const iso = ds => {
    const d = new Date(parseDate(ds));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const first = iso(Store.dates[0]), last = iso(Store.dates[Store.dates.length - 1]);
  from.min = to.min = first;
  from.max = to.max = last;
  to.value = last;
  from.value = iso(Store.dates[Math.max(0, Store.dates.length - 1 - PERF_PERIOD_DAYS['1m'])]);
}

// Compute industry RS scores with min stocks / min mcap filters
function computeIndustryRS(minStocks, minMcap) {
  const industries = {};
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const ind = s.industry || 'Undefined-Diversified';
    if (!industries[ind]) industries[ind] = {
      stocks: [], totalMcap: 0, totalMonthlyChange: 0,
      above: 0, below: 0, totalDistFrom52H: 0
    };
    industries[ind].stocks.push(s);
    industries[ind].totalMcap += (s.marketCap || 0);
    industries[ind].totalMonthlyChange += (s.monthlyChangePct || 0);
    industries[ind].totalDistFrom52H += (s.distFrom52H || 0);
    if (s.aboveSMA) industries[ind].above++;
    else industries[ind].below++;
  }

  let indList = Object.entries(industries).map(([name, data]) => {
    const n = data.stocks.length;
    return {
      name, stockCount: n,
      avgMonthlyChange: data.totalMonthlyChange / n,
      breadth: n > 0 ? (data.above / n * 100) : 0,
      avgDist52H: data.totalDistFrom52H / n,
      totalMcap: data.totalMcap
    };
  });

  indList = indList.filter(i => i.stockCount >= minStocks);
  if (minMcap > 0) indList = indList.filter(i => i.totalMcap >= minMcap);

  computeRSScores(indList); // shared with industry.js — see utils.js

  const rsMap = {};
  indList.forEach(ind => { rsMap[ind.name] = ind.rsScore; });
  return rsMap;
}

// Check co-occurrence: Day % change AND Turnover > N× SMA on same day, in last L days
function checkCoOccurrence(days, minChangePct, turnoverMult, smaLen, minTimes, lookbackDays, allowPartial) {
  const minBars = allowPartial ? 5 : smaLen;
  if (days.length < minBars + 1) return { hits: 0 };
  const lookbackSlice = days.slice(-lookbackDays);
  let hits = 0;
  const hitDates = [];

  for (let i = 0; i < lookbackSlice.length; i++) {
    const d = lookbackSlice[i];
    // Find this day's index in the full days array
    const fullIdx = days.length - lookbackSlice.length + i;
    if (fullIdx < minBars) continue; // Not enough history for SMA

    // Day % change
    const prevClose = fullIdx > 0 ? days[fullIdx - 1].close : d.open;
    const dayChange = prevClose > 0 ? ((d.close - prevClose) / prevClose) * 100 : 0;

    if (dayChange < minChangePct) continue;

    // SMA turnover up to the day before (so it's a true lookback, not including current)
    const usable = Math.min(fullIdx, smaLen);
    if (usable < minBars) continue;
    const smaSlice = days.slice(fullIdx - usable, fullIdx);
    const smaTurnover = smaSlice.reduce((s, r) => s + (r.turnover || 0), 0) / usable;
    if (smaTurnover <= 0) continue;

    const turnoverRatio = (d.turnover || 0) / smaTurnover;
    if (turnoverRatio >= turnoverMult) {
      hits++;
      hitDates.push(d.date);
    }
  }
  return { hits, hitDates };
}

function togglePassedFailed() {
  if (screenerPassed.length === 0 && screenerFailed.length === 0) return; // No scan run yet
  scrShowingFailed = !scrShowingFailed;
  screenerResults = scrShowingFailed ? screenerFailed : screenerPassed;
  screenerPage = 0;
  scrSortCol = null;
  scrSortDir = 1;
  updateToggleButton();
  updateFilterBadge();
  renderScreenerTable();
}

function updateToggleButton() {
  const btn = document.getElementById('scrToggleView');
  if (!btn) return;
  if (scrShowingFailed) {
    btn.textContent = `Showing Failed (${screenerFailed.length}) — Click for Passed`;
    btn.classList.add('showing-failed');
    btn.classList.remove('showing-passed');
  } else {
    btn.textContent = `Showing Passed (${screenerPassed.length}) — Click for Failed`;
    btn.classList.remove('showing-failed');
    btn.classList.add('showing-passed');
  }
}

function runScreener() {
  const search = document.getElementById('scrSearch').value.trim().toUpperCase();
  const allowPartial = document.getElementById('scrAllowPartial')?.checked || false;

  // Read filter states
  const f1On = document.getElementById('scrF1On').checked;
  const f1Mult = parseFloat(document.getElementById('scrF1Mult').value) || 3;
  const f1Len = parseInt(document.getElementById('scrF1Len').value) || 50;

  const f2On = document.getElementById('scrF2On').checked;
  const f2Len = parseInt(document.getElementById('scrF2Len').value) || 50;
  const f2ValCr = parseFloat(document.getElementById('scrF2Val').value) || 0;
  const f2Val = f2ValCr * 100; // Convert crores to lakhs for comparison

  const f3On = document.getElementById('scrF3On').checked;
  const f3ValCr = parseFloat(document.getElementById('scrF3Val').value) || 0;
  const f3Val = f3ValCr * 100; // Convert crores to lakhs for comparison

  const f4On = document.getElementById('scrF4On').checked;
  const f4Val = parseFloat(document.getElementById('scrF4Val').value) || 0;
  const f4Mult = parseFloat(document.getElementById('scrF4Mult').value) || 3;
  const f4SmaLen = parseInt(document.getElementById('scrF4SmaLen').value) || 50;
  const f4MinTimes = parseInt(document.getElementById('scrF4MinTimes').value) || 1;
  const f4Lookback = parseInt(document.getElementById('scrF4Lookback').value) || 10;

  const f5On = document.getElementById('scrF5On').checked;
  const f5Min = parseFloat(document.getElementById('scrF5Min').value) || 0;
  const f5Max = parseFloat(document.getElementById('scrF5Max').value) || 100;

  const f6On = document.getElementById('scrF6On').checked;
  const f6Len = parseInt(document.getElementById('scrF6Len').value) || 50;
  const f6Val = parseFloat(document.getElementById('scrF6Val').value) || 0;

  const f7On = document.getElementById('scrF7On').checked;
  const f7Exclude = new Set();
  if (document.getElementById('scrF7_2').checked) f7Exclude.add('2');
  if (document.getElementById('scrF7_5').checked) f7Exclude.add('5');
  if (document.getElementById('scrF7_10').checked) f7Exclude.add('10');

  const f8On = document.getElementById('scrF8On').checked;
  const f8Len = parseInt(document.getElementById('scrF8Len').value) || 50;
  const f8Min = parseFloat(document.getElementById('scrF8Min').value) || 0;
  const f8Max = parseFloat(document.getElementById('scrF8Max').value) || 999;

  const f9On = document.getElementById('scrF9On').checked;
  const f9Val = parseFloat(document.getElementById('scrF9Val').value) || 0;
  const f9MinStk = parseInt(document.getElementById('scrF9MinStk').value) || 1;
  const f9MinMcap = parseFloat(document.getElementById('scrF9MinMcap').value) || 0;

  const f10On = document.getElementById('scrF10On').checked;
  const f10_20sma = document.getElementById('scrF10_20sma').checked;
  const f10_50sma = document.getElementById('scrF10_50sma').checked;
  const f10_200sma = document.getElementById('scrF10_200sma').checked;
  const f10_200ema = document.getElementById('scrF10_200ema').checked;

  const f11On = document.getElementById('scrF11On').checked;
  const f11Sector = document.getElementById('scrF11Sector').value;

  const f12On = document.getElementById('scrF12On').checked;
  const f12Period = document.getElementById('scrF12Period').value;
  const f12Val = parseFloat(document.getElementById('scrF12Val').value) || 0;

  const f13On = document.getElementById('scrF13On').checked;
  const f13Val = parseInt(document.getElementById('scrF13Val').value) || 1;

  const f14On = document.getElementById('scrF14On').checked;
  const f14Val = parseFloat(document.getElementById('scrF14Val').value) || 0;

  const f15On = document.getElementById('scrF15On').checked;
  const f15Period = document.getElementById('scrF15Period').value;
  const f15Val = parseFloat(document.getElementById('scrF15Val').value) || 0;
  const f15Days = PERF_PERIOD_DAYS[f15Period] || 21;

  const f16On = document.getElementById('scrF16On').checked;
  const f16FromField = document.getElementById('scrF16FromField').value;
  const f16ToField = document.getElementById('scrF16ToField').value;
  const f16Val = parseFloat(document.getElementById('scrF16Val').value) || 0;
  const f16FromTs = scrIsoToTs(document.getElementById('scrF16FromDate').value);
  const f16ToRaw = scrIsoToTs(document.getElementById('scrF16ToDate').value);
  const f16ToTs = isNaN(f16ToRaw) ? Infinity : f16ToRaw; // blank To date = latest bar
  const f16Label = `${SCR_FIELD_LETTER[f16FromField]}→${SCR_FIELD_LETTER[f16ToField]}`;

  // Pre-compute industry RS map if needed
  let indRSMap = {};
  if (f9On) {
    indRSMap = computeIndustryRS(f9MinStk, f9MinMcap);
  }

  // Pre-compute industry money flow map if needed
  let indMFMap = {};
  if (f12On) {
    const mfData = computeIndustryMoneyFlow(f12Period);
    // Aggregate money flow by industry
    const indFlows = {};
    for (const key in Store.latestBySymbol) {
      const s = Store.latestBySymbol[key];
      const ind = s.industry || 'Undefined-Diversified';
      if (!indFlows[ind]) indFlows[ind] = { current: 0, prev: 0 };
      indFlows[ind].current += (mfData.current[key] || 0);
      indFlows[ind].prev += (mfData.previous[key] || 0);
    }
    for (const ind in indFlows) {
      const f = indFlows[ind];
      if (f.prev > 0) {
        indMFMap[ind] = ((f.current - f.prev) / f.prev) * 100;
      } else if (f.current > 0) {
        indMFMap[ind] = 100;
      } else {
        indMFMap[ind] = 0;
      }
    }
  }

  // Pre-compute industry aggregates for F13/F14 standalone filters
  let indAgg = {};
  if (f13On || f14On) {
    for (const key in Store.latestBySymbol) {
      const st = Store.latestBySymbol[key];
      const ind = st.industry || 'Undefined-Diversified';
      if (!indAgg[ind]) indAgg[ind] = { count: 0, mcap: 0 };
      indAgg[ind].count++;
      indAgg[ind].mcap += (st.marketCap || 0);
    }
  }

  const passed = [];
  const failed = [];

  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    if (search && !s.symbol.toUpperCase().includes(search)) continue;

    const days = Store.dailyBySymbol[key] || [];
    const failReasons = [];

    // Compute dynamic values on the fly
    const dynTurnoverSMA_f1 = f1On ? (allowPartial ? computeDynSMAPartial(days, 'turnover', f1Len) : computeDynSMA(days, 'turnover', f1Len)) : NaN;
    const dynTurnoverSMA_f2 = f2On ? (allowPartial ? computeDynSMAPartial(days, 'turnover', f2Len) : computeDynSMA(days, 'turnover', f2Len)) : NaN;
    const dynADR = f6On ? (allowPartial ? computeDynADRPartial(days, f6Len) : computeDynADR(days, f6Len)) : NaN;
    const dynCloseSMA = f8On ? (allowPartial ? computeDynSMAPartial(days, 'close', f8Len) : computeDynSMA(days, 'close', f8Len)) : NaN;
    const dynPriceRatio = (!isNaN(dynCloseSMA) && dynCloseSMA > 0) ? (s.close / dynCloseSMA) : NaN;
    const dynPerf = f15On ? (allowPartial ? computeDynPerformancePartial(days, f15Days) : computeDynPerformance(days, f15Days)) : NaN;

    // Store computed values on s for table display.
    // F1 and F2 each get their own key (rather than sharing one) since they can
    // be active simultaneously with different SMA lengths — sharing one column
    // used to silently hide whichever filter wasn't "first".
    s._dynTurnoverSMA_f1 = dynTurnoverSMA_f1;
    s._dynTurnoverSMA_f2 = dynTurnoverSMA_f2;
    s._turnoverToSMA = (!isNaN(dynTurnoverSMA_f1) && dynTurnoverSMA_f1 > 0) ? (s.turnover / dynTurnoverSMA_f1) : NaN;
    s._dynADR = f6On ? dynADR : s.adr;
    s._dynADRLen = f6On ? f6Len : 20;
    s._dynCloseSMA = dynCloseSMA;
    s._dynCloseSMALen = f8On ? f8Len : 20;
    s._dynPriceRatio = dynPriceRatio;
    s._indRS = indRSMap[s.industry] !== undefined ? indRSMap[s.industry] : NaN;
    s._perf = dynPerf;
    s._perfPeriod = f15Period;
    const dateChg = f16On ? computeDynDateChange(days, f16FromTs, f16FromField, f16ToTs, f16ToField, allowPartial) : { pct: NaN };
    s._dateChg = dateChg.pct;

    // F1: Turnover > N × SMA Turnover
    if (f1On) {
      if (isNaN(dynTurnoverSMA_f1) || dynTurnoverSMA_f1 <= 0) {
        failReasons.push(`F1: Insufficient data for ${f1Len}-SMA turnover`);
      } else {
        const ratio = s.turnover / dynTurnoverSMA_f1;
        if (ratio < f1Mult) {
          failReasons.push(`F1: Turnover ${fmtTurnoverCr(s.turnover)} < ${f1Mult}× SMA ${fmtTurnoverCr(dynTurnoverSMA_f1)} (${ratio.toFixed(1)}×)`);
        }
      }
    }

    // F2: SMA Turnover > value
    if (f2On) {
      if (isNaN(dynTurnoverSMA_f2) || dynTurnoverSMA_f2 < f2Val) {
        failReasons.push(`F2: ${f2Len}-SMA Turnover ${isNaN(dynTurnoverSMA_f2) ? 'N/A' : fmtTurnoverCr(dynTurnoverSMA_f2)} < ${f2ValCr}Cr`);
      }
    }

    // F3: Current Turnover > value
    if (f3On) {
      if (isNaN(s.turnover) || s.turnover < f3Val) {
        failReasons.push(`F3: Turnover ${fmtTurnoverCr(s.turnover)} < ${f3ValCr}Cr`);
      }
    }

    // F4: Co-occurrence
    if (f4On) {
      const coResult = checkCoOccurrence(days, f4Val, f4Mult, f4SmaLen, f4MinTimes, f4Lookback, allowPartial);
      s._f4Hits = coResult.hits;
      s._f4Required = f4MinTimes;
      s._f4Lookback = f4Lookback;
      if (coResult.hits < f4MinTimes) {
        failReasons.push(`F4: Co-occur ${coResult.hits}/${f4MinTimes} in last ${f4Lookback}d (need Chg>${f4Val}% + T/O>${f4Mult}×${f4SmaLen}SMA on same day)`);
      }
    }

    // F5: Close % from 52W High in range
    if (f5On) {
      const dist = s.distFrom52H;
      if (isNaN(dist) || dist < f5Min || dist > f5Max) {
        failReasons.push(`F5: Dist 52WH ${fmt2(dist)}% not in ${f5Min}-${f5Max}%`);
      }
    }

    // F6: ADR > value
    if (f6On) {
      if (isNaN(dynADR)) {
        failReasons.push(`F6: Insufficient data for ${f6Len}-day ADR`);
      } else if (dynADR < f6Val) {
        failReasons.push(`F6: ${f6Len}-day ADR ${dynADR.toFixed(2)}% < ${f6Val}%`);
      }
    }

    // F7: Exclude circuit stocks
    if (f7On && s.bandPct) {
      const bandNum = s.bandPct.replace('%', '').trim();
      if (f7Exclude.has(bandNum)) {
        failReasons.push(`F7: Circuit ${s.bandPct} excluded`);
      }
    }

    // F8: Price / SMA proximity
    if (f8On) {
      if (isNaN(dynPriceRatio)) {
        failReasons.push(`F8: Insufficient data for ${f8Len}-SMA`);
      } else if (dynPriceRatio < f8Min || dynPriceRatio > f8Max) {
        failReasons.push(`F8: Price/SMA ratio ${dynPriceRatio.toFixed(3)} not in ${f8Min}-${f8Max}`);
      }
    }

    // F9: Industry RS filter
    if (f9On) {
      const rs = indRSMap[s.industry];
      if (rs === undefined) {
        failReasons.push(`F9: Industry '${s.industry}' excluded by min stocks/mcap`);
      } else if (rs < f9Val) {
        failReasons.push(`F9: Industry RS ${rs.toFixed(1)} < ${f9Val}`);
      }
    }

    // F10: Price Above MAs
    if (f10On) {
      const maResults = [];
      if (f10_20sma) {
        const smaFn = allowPartial ? computeDynSMAPartial : computeDynSMA;
        const v = smaFn(days, 'close', 20);
        maResults.push({ name: '20SMA', val: v, ok: !isNaN(v) && s.close > v });
      }
      if (f10_50sma) {
        const smaFn = allowPartial ? computeDynSMAPartial : computeDynSMA;
        const v = smaFn(days, 'close', 50);
        maResults.push({ name: '50SMA', val: v, ok: !isNaN(v) && s.close > v });
      }
      if (f10_200sma) {
        const smaFn = allowPartial ? computeDynSMAPartial : computeDynSMA;
        const v = smaFn(days, 'close', 200);
        maResults.push({ name: '200SMA', val: v, ok: !isNaN(v) && s.close > v });
      }
      if (f10_200ema) {
        const emaFn = allowPartial ? computeDynEMAPartial : computeDynEMA;
        const v = emaFn(days, 'close', 200);
        maResults.push({ name: '200EMA', val: v, ok: !isNaN(v) && s.close > v });
      }
      s._f10MAs = maResults;
      const failedMAs = maResults.filter(m => !m.ok);
      if (failedMAs.length > 0) {
        failReasons.push(`F10: Close not above ${failedMAs.map(m => m.name + (isNaN(m.val) ? '(N/A)' : '(' + m.val.toFixed(2) + ')')).join(', ')}`);
      }
    }

    // F11: Sector filter
    if (f11On && f11Sector) {
      if (s.sector !== f11Sector) {
        failReasons.push(`F11: Sector '${s.sector}' ≠ '${f11Sector}'`);
      }
    }

    // F12: Industry Money Flow
    if (f12On) {
      const ind = s.industry || 'Undefined-Diversified';
      const mfPct = indMFMap[ind] !== undefined ? indMFMap[ind] : 0;
      s._indMF = mfPct;
      s._indMFPeriod = f12Period;
      if (mfPct < f12Val) {
        failReasons.push(`F12: Industry MF ${mfPct.toFixed(1)}% < ${f12Val}% (${f12Period})`);
      }
    } else {
      s._indMF = NaN;
    }

    // F13: Min stocks in industry (standalone)
    if (f13On) {
      const ind = s.industry || 'Undefined-Diversified';
      const agg = indAgg[ind];
      if (!agg || agg.count < f13Val) {
        failReasons.push(`F13: Industry '${s.industry}' has ${agg ? agg.count : 0} stocks < ${f13Val}`);
      }
    }

    // F14: Min industry market cap (standalone)
    if (f14On) {
      const ind = s.industry || 'Undefined-Diversified';
      const agg = indAgg[ind];
      if (!agg || agg.mcap < f14Val) {
        failReasons.push(`F14: Industry '${s.industry}' MCap ${fmtCr(agg ? agg.mcap : 0)} Cr < ${f14Val} Cr`);
      }
    }

    // F15: Performance (price change over period) >= value
    if (f15On) {
      if (isNaN(dynPerf)) {
        failReasons.push(`F15: Insufficient data for ${f15Period.toUpperCase()} performance`);
      } else if (dynPerf < f15Val) {
        failReasons.push(`F15: ${f15Period.toUpperCase()} Performance ${dynPerf.toFixed(2)}% < ${f15Val}%`);
      }
    }

    // F16: % change between two chosen dates/fields >= value
    if (f16On) {
      if (isNaN(dateChg.pct)) {
        failReasons.push(`F16: ${dateChg.reason}`);
      } else if (dateChg.pct < f16Val) {
        failReasons.push(`F16: ${f16Label} change ${dateChg.pct.toFixed(2)}% < ${f16Val}%`);
      }
    }

    if (failReasons.length === 0) {
      passed.push(s);
    } else {
      s._failReasons = failReasons;
      failed.push(s);
    }
  }

  // Sort passed by turnover descending
  passed.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  failed.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));

  screenerPassed = passed;
  screenerFailed = failed;
  screenerResults = scrShowingFailed ? screenerFailed : screenerPassed;
  screenerPage = 0;
  scrSortCol = null;

  // Count active filters
  const activeCount = [f1On, f2On, f3On, f4On, f5On, f6On, f7On, f8On, f9On, f10On, f11On, f12On, f13On, f14On, f15On, f16On].filter(Boolean).length;

  // Stats
  const advancing = passed.filter(s => s.changePct > 0).length;
  const declining = passed.filter(s => s.changePct < 0).length;
  const avgChange = passed.length > 0 ? (passed.reduce((s, r) => s + (r.changePct || 0), 0) / passed.length) : 0;

  document.getElementById('screenerStats').innerHTML = `
    <div class="stat-card"><div class="label">Active Filters</div><div class="value" style="color:var(--accent)">${activeCount}</div></div>
    <div class="stat-card"><div class="label">Passed</div><div class="value positive">${passed.length}</div></div>
    <div class="stat-card"><div class="label">Failed</div><div class="value negative">${failed.length}</div></div>
    <div class="stat-card"><div class="label">Advancing (Passed)</div><div class="value positive">${advancing}</div></div>
    <div class="stat-card"><div class="label">Declining (Passed)</div><div class="value negative">${declining}</div></div>
    <div class="stat-card"><div class="label">Avg Change % (Passed)</div><div class="value ${avgChange>=0?'positive':'negative'}">${avgChange.toFixed(2)}%</div></div>
  `;

  updateToggleButton();
  updateFilterBadge();
  renderScreenerTable();
}

function renderScreenerTable() {
  const showFailed = scrShowingFailed;
  const f1On = document.getElementById('scrF1On').checked;
  const f1Len = parseInt(document.getElementById('scrF1Len').value) || 50;
  const f2On = document.getElementById('scrF2On').checked;
  const f2Len = parseInt(document.getElementById('scrF2Len').value) || 50;
  const f4On = document.getElementById('scrF4On').checked;
  const f6On = document.getElementById('scrF6On').checked;
  const f8On = document.getElementById('scrF8On').checked;
  const f9On = document.getElementById('scrF9On').checked;
  const f10On = document.getElementById('scrF10On').checked;
  const f12On = document.getElementById('scrF12On').checked;
  const f15On = document.getElementById('scrF15On').checked;
  const f16On = document.getElementById('scrF16On').checked;

  const cols = [
    { key: 'symbol', label: 'Symbol', fmt: (v, row) => `<a href="#" class="stock-link" data-isin="${escapeHtml(row.isin)}">${escapeHtml(v)}</a>` },
    { key: 'sector', label: 'Sector', fmt: v => v || '-' },
    { key: 'industry', label: 'Industry', fmt: v => v ? `<a href="#" class="industry-link" data-industry="${escapeHtml(v)}">${escapeHtml(v)}</a>` : '-' },
    { key: 'close', label: 'Close', fmt: v => fmt2(v) },
    { key: 'changePct', label: 'Chg%', fmt: v => fmtPct(v), cls: v => v >= 0 ? 'positive' : 'negative' },
    { key: 'turnover', label: 'Turnover(Cr)', fmt: v => fmtTurnoverCr(v) },
  ];

  // F4 co-occurrence column
  if (f4On) {
    cols.push({ key: '_f4Hits', label: 'Co-occur Hits', fmt: (v, row) => {
      if (v === undefined) return '-';
      const req = row._f4Required || 1;
      const lb = row._f4Lookback || 10;
      const cls = v >= req ? 'positive' : 'negative';
      return `<span class="${cls}">${v}/${req}</span> <span style="font-size:10px;color:var(--text2);">(${lb}d)</span>`;
    }});
  }

  // Dynamic columns based on active filters.
  // F1 and F2 get separate columns (with distinguishing labels only when both
  // are on) since they can use different SMA lengths at the same time.
  if (f1On) {
    cols.push({ key: '_dynTurnoverSMA_f1', label: f2On ? `F1 SMA(${f1Len}) T/O(Cr)` : 'SMA T/O(Cr)', fmt: v => fmtTurnoverCr(v) });
    cols.push({ key: '_turnoverToSMA', label: 'T/O × SMA', fmt: v => isNaN(v) ? '-' : v.toFixed(1) + '×' });
  }
  if (f2On) {
    cols.push({ key: '_dynTurnoverSMA_f2', label: f1On ? `F2 SMA(${f2Len}) T/O(Cr)` : 'SMA T/O(Cr)', fmt: v => fmtTurnoverCr(v) });
  }
  if (f6On) {
    cols.push({ key: '_dynADR', label: 'ADR%', fmt: v => fmt2(v) });
  } else {
    cols.push({ key: 'adr', label: 'ADR%', fmt: v => fmt2(v) });
  }
  if (f8On) {
    cols.push({ key: '_dynCloseSMA', label: 'SMA Close', fmt: v => fmt2(v) });
    cols.push({ key: '_dynPriceRatio', label: 'Price/SMA', fmt: v => isNaN(v) ? '-' : v.toFixed(3), cls: v => v >= 1 ? 'positive' : 'negative' });
  }
  if (f10On) {
    cols.push({ key: '_f10MAs', label: 'MA Status', fmt: (v) => {
      if (!v || v.length === 0) return '-';
      return v.map(m => {
        const cls = m.ok ? 'positive' : 'negative';
        const icon = m.ok ? '✓' : '✗';
        return `<span class="${cls}" style="font-size:11px;">${icon}${m.name}</span>`;
      }).join(' ');
    }});
  }
  cols.push({ key: 'distFrom52H', label: 'From 52H%', fmt: v => fmtPct(-v), cls: () => 'negative' });
  cols.push({ key: 'high52w', label: '52W High', fmt: v => fmt2(v) });
  cols.push({ key: 'bandPct', label: 'Band', fmt: v => v || '-' });
  if (f9On) {
    cols.push({ key: '_indRS', label: 'Ind RS', fmt: v => isNaN(v) ? '-' : v.toFixed(1) });
  }
  if (f12On) {
    const periodLabel = { '1w': '1W', '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y' }[document.getElementById('scrF12Period').value] || '6M';
    cols.push({ key: '_indMF', label: `Ind MF% (${periodLabel})`, fmt: v => isNaN(v) ? '-' : v.toFixed(1) + '%', cls: v => v >= 0 ? 'positive' : 'negative' });
  }
  if (f15On) {
    const perfPeriodLabel = { '1d': '1D', '1w': '1W', '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y' }[document.getElementById('scrF15Period').value] || '1M';
    cols.push({ key: '_perf', label: `Perf% (${perfPeriodLabel})`, fmt: v => isNaN(v) ? '-' : fmtPct(v), cls: v => v >= 0 ? 'positive' : 'negative' });
  }
  if (f16On) {
    const ff = SCR_FIELD_LETTER[document.getElementById('scrF16FromField').value];
    const tf = SCR_FIELD_LETTER[document.getElementById('scrF16ToField').value];
    cols.push({ key: '_dateChg', label: `Chg% (${ff}→${tf})`, fmt: v => isNaN(v) ? '-' : fmtPct(v), cls: v => v >= 0 ? 'positive' : 'negative' });
  }
  cols.push({ key: 'marketCap', label: 'MCap(Cr)', fmt: v => fmtCr(v) });

  if (showFailed) {
    cols.push({ key: '_failReasons', label: 'Failed Filters', fmt: v => {
      if (!v || v.length === 0) return '-';
      return '<span class="scr-fail-reason">' + v.join('<br>') + '</span>';
    }});
  }

  // Header
  const head = document.getElementById('screenerHead');
  head.innerHTML = cols.map(c =>
    `<th onclick="sortScreener('${c.key}')">${c.label}<span class="sort-arrow">${scrSortCol===c.key?(scrSortDir>0?'▲':'▼'):''}</span></th>`
  ).join('');

  // Paginated body
  const start = screenerPage * SCR_PAGE_SIZE;
  const page = screenerResults.slice(start, start + SCR_PAGE_SIZE);
  const body = document.getElementById('screenerBody');
  body.innerHTML = page.map((row, ri) => {
    return '<tr>' + cols.map(c => {
      const v = row[c.key];
      const cls = c.cls ? c.cls(v) : '';
      return `<td class="${cls}">${c.fmt(v, row)}</td>`;
    }).join('') + '</tr>';
  }).join('');

  document.getElementById('screenerResultCount').textContent =
    screenerResults.length > 0
      ? `Showing ${start+1}-${Math.min(start+SCR_PAGE_SIZE, screenerResults.length)} of ${screenerResults.length} ${showFailed ? 'failed' : 'passed'} stocks`
      : showFailed ? 'No failed stocks' : 'No results — click Scan first';

  // Pagination
  const totalPages = Math.ceil(screenerResults.length / SCR_PAGE_SIZE);
  document.getElementById('screenerPagination').innerHTML = `
    <button onclick="screenerPage=0; renderScreenerTable()" ${screenerPage===0?'disabled':''}>First</button>
    <button onclick="screenerPage--; renderScreenerTable()" ${screenerPage===0?'disabled':''}>Prev</button>
    <span>Page ${screenerPage+1} of ${totalPages || 1}</span>
    <button onclick="screenerPage++; renderScreenerTable()" ${screenerPage>=totalPages-1?'disabled':''}>Next</button>
    <button onclick="screenerPage=${totalPages-1}; renderScreenerTable()" ${screenerPage>=totalPages-1?'disabled':''}>Last</button>
  `;
}

function sortScreener(key) {
  if (key === '_failReasons') return; // Can't sort by fail reasons
  if (scrSortCol === key) { scrSortDir *= -1; }
  else { scrSortCol = key; scrSortDir = 1; }
  screenerResults.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === 'string') return scrSortDir * (va || '').localeCompare(vb || '');
    if (isNaN(va)) va = -Infinity;
    if (isNaN(vb)) vb = -Infinity;
    return scrSortDir * (va - vb);
  });
  screenerPage = 0;
  renderScreenerTable();
}

function resetScreener() {
  document.getElementById('scrF1On').checked = false;
  document.getElementById('scrF2On').checked = false;
  document.getElementById('scrF3On').checked = false;
  document.getElementById('scrF4On').checked = false;
  document.getElementById('scrF5On').checked = false;
  document.getElementById('scrF6On').checked = false;
  document.getElementById('scrF7On').checked = false;
  document.getElementById('scrF8On').checked = false;
  document.getElementById('scrF9On').checked = false;
  document.getElementById('scrF10On').checked = false;
  document.getElementById('scrF10_20sma').checked = true;
  document.getElementById('scrF10_50sma').checked = false;
  document.getElementById('scrF10_200sma').checked = false;
  document.getElementById('scrF10_200ema').checked = false;
  document.getElementById('scrF11On').checked = false;
  document.getElementById('scrF11Sector').value = '';
  document.getElementById('scrF12On').checked = false;
  document.getElementById('scrF12Period').value = '6m';
  document.getElementById('scrF12Val').value = '0';
  document.getElementById('scrF13On').checked = false;
  document.getElementById('scrF13Val').value = '3';
  document.getElementById('scrF14On').checked = false;
  document.getElementById('scrF14Val').value = '0';
  document.getElementById('scrF15On').checked = false;
  document.getElementById('scrF15Period').value = '1m';
  document.getElementById('scrF15Val').value = '0';
  document.getElementById('scrF16On').checked = false;
  document.getElementById('scrF16FromField').value = 'close';
  document.getElementById('scrF16ToField').value = 'close';
  document.getElementById('scrF16Val').value = '0';
  initF16Dates();
  scrShowingFailed = false;
  document.getElementById('scrSearch').value = '';
  if (typeof _multiPresetActive !== 'undefined') _multiPresetActive = null;
  const multiStatusEl = document.getElementById('scrMultiStatus');
  if (multiStatusEl) multiStatusEl.innerHTML = '';
  const multiListEl = document.getElementById('scrMultiPresetList');
  if (multiListEl) multiListEl.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
  // Reset values to defaults
  document.getElementById('scrF1Mult').value = '3';
  document.getElementById('scrF1Len').value = '50';
  document.getElementById('scrF2Len').value = '50';
  document.getElementById('scrF2Val').value = '1';
  document.getElementById('scrF3Val').value = '5';
  document.getElementById('scrF4Val').value = '2';
  document.getElementById('scrF4Mult').value = '3';
  document.getElementById('scrF4SmaLen').value = '50';
  document.getElementById('scrF4MinTimes').value = '1';
  document.getElementById('scrF4Lookback').value = '10';
  document.getElementById('scrF5Min').value = '0';
  document.getElementById('scrF5Max').value = '10';
  document.getElementById('scrF6Len').value = '50';
  document.getElementById('scrF6Val').value = '3';
  document.getElementById('scrF7_2').checked = true;
  document.getElementById('scrF7_5').checked = true;
  document.getElementById('scrF7_10').checked = true;
  document.getElementById('scrF8Len').value = '50';
  document.getElementById('scrF8Min').value = '0.97';
  document.getElementById('scrF8Max').value = '1.10';
  document.getElementById('scrF9Val').value = '60';
  document.getElementById('scrF9MinStk').value = '3';
  document.getElementById('scrF9MinMcap').value = '0';
  screenerResults = [];
  screenerPassed = [];
  screenerFailed = [];
  screenerPage = 0;
  updateToggleButton();
  document.getElementById('screenerStats').innerHTML = '';
  document.getElementById('screenerHead').innerHTML = '';
  document.getElementById('screenerBody').innerHTML = '';
  document.getElementById('screenerPagination').innerHTML = '';
  document.getElementById('screenerResultCount').textContent = '';
  updateFilterBadge();
}

function exportScreenerCSV() {
  if (screenerResults.length === 0) return;
  const keys = ['symbol','series','sector','industry','close','changePct','vol','turnover',
    'adr','_dynADR','_dynTurnoverSMA_f1','_dynTurnoverSMA_f2','_turnoverToSMA','_f4Hits','_dynCloseSMA','_dynPriceRatio',
    'high52w','low52w','distFrom52H','distFrom52L','bandPct','marketCap','_indRS','_indMF','_perf','_dateChg','_f10MAs'];
  const labels = ['Symbol','Series','Sector','Industry','Close','Change%','Volume','Turnover',
    'ADR%','DynADR%','F1_SMA_Turnover','F2_SMA_Turnover','Turnover_x_SMA','CoOccur_Hits','SMA_Close','Price_SMA_Ratio',
    '52W_High','52W_Low','From_52H%','From_52L%','Band','MarketCap_Cr','Industry_RS','Ind_MoneyFlow%','Performance%','DateRange_Chg%','MA_Status'];
  let csv = labels.join(',') + '\n';
  screenerResults.forEach(r => {
    csv += keys.map(k => {
      let v = r[k];
      if (v === undefined || v === null) return '';
      if (Array.isArray(v)) {
        const txt = v.map(x => typeof x === 'object' && x.name ? (x.ok ? '✓' : '✗') + x.name : x).join('; ');
        return '"' + txt.replace(/"/g, '""') + '"';
      }
      if (typeof v === 'number') return isNaN(v) ? '' : v.toFixed(2);
      return '"' + String(v).replace(/"/g, '""') + '"';
    }).join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'screener_results.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let _tvWatchlistText = '';

function exportTradingViewWatchlist() {
  if (screenerPassed.length === 0) { alert('No passed stocks to export. Run a scan first.'); return; }
  const passed = screenerPassed;
  // Group by industry
  const byIndustry = {};
  passed.forEach(s => {
    const ind = s.industry || 'Undefined-Diversified';
    if (!byIndustry[ind]) byIndustry[ind] = [];
    byIndustry[ind].push(s.symbol);
  });
  // Build TradingView watchlist string
  const parts = [];
  let industryCount = 0;
  Object.keys(byIndustry).sort((a, b) => byIndustry[b].length - byIndustry[a].length).forEach(ind => {
    const syms = byIndustry[ind];
    parts.push('###' + ind + '(' + syms.length + ')');
    syms.forEach(sym => parts.push('NSE:' + sym));
    industryCount++;
  });
  _tvWatchlistText = parts.join(',');
  // Show modal
  document.getElementById('tvModalContent').textContent = _tvWatchlistText;
  document.getElementById('tvModalFooter').textContent = `${passed.length} stocks across ${industryCount} industries`;
  document.getElementById('tvCopyBtn').classList.remove('copied');
  document.getElementById('tvCopyBtn').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
  document.getElementById('tvModal').classList.add('active');
}

function copyTvWatchlist() {
  navigator.clipboard.writeText(_tvWatchlistText).then(() => {
    const btn = document.getElementById('tvCopyBtn');
    btn.classList.add('copied');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
    }, 2000);
  });
}

function closeTvModal() {
  document.getElementById('tvModal').classList.remove('active');
}

// ── Auto-run screener when any filter changes ──
// While a Multi-Preset combined scan is active, re-run THAT (it re-reads the
// checked presets/mode from the DOM itself) instead of the plain single-filter
// scan, otherwise any auto-triggered re-scan (e.g. typing in the search box)
// would silently discard the combined result.
function rerunScreenerRespectingMultiPreset() {
  if (typeof _multiPresetActive !== 'undefined' && _multiPresetActive && typeof runMultiPresetScan === 'function') {
    runMultiPresetScan();
  } else {
    runScreener();
  }
}

(function() {
  let _scrDebounce = null;
  const container = document.getElementById('panel-screener');
  if (!container) return;
  container.addEventListener('change', function(e) {
    const tag = e.target.tagName;
    // Checkboxes used to pick which presets to combine are staged for the
    // explicit "Run Combined Scan" button, not an auto-run trigger.
    if (e.target.closest && e.target.closest('#scrMultiPresetList')) return;
    if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type === 'checkbox')) {
      clearTimeout(_scrDebounce);
      _scrDebounce = setTimeout(rerunScreenerRespectingMultiPreset, 150);
    }
  });
  container.addEventListener('input', function(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' && e.target.type !== 'checkbox') {
      clearTimeout(_scrDebounce);
      _scrDebounce = setTimeout(rerunScreenerRespectingMultiPreset, 400);
    }
  });
})();

/* ---------- screener filters popup ---------- */
function openScreenerFilters() {
  const modal = document.getElementById('scrFiltersModal');
  if (modal) modal.classList.add('active');
}

function closeScreenerFilters() {
  const modal = document.getElementById('scrFiltersModal');
  if (modal) modal.classList.remove('active');
}

function updateFilterBadge() {
  const techIds = ['scrF1On','scrF2On','scrF3On','scrF4On','scrF5On','scrF6On','scrF7On','scrF8On','scrF10On','scrF15On','scrF16On'];
  const indIds  = ['scrF9On','scrF11On','scrF12On','scrF13On','scrF14On'];
  const countChecked = ids => ids.filter(id => { const el = document.getElementById(id); return el && el.checked; }).length;

  const techCount = countChecked(techIds);
  const indCount  = countChecked(indIds);

  const badge = document.getElementById('scrActiveFilterBadge');
  if (badge) {
    const total = techCount + indCount;
    badge.textContent = total;
    badge.style.display = total > 0 ? '' : 'none';
  }

  const techBadge = document.getElementById('scrTabTechCount');
  if (techBadge) {
    techBadge.textContent = techCount;
    techBadge.style.display = techCount > 0 ? 'inline-block' : 'none';
  }

  const indBadge = document.getElementById('scrTabIndCount');
  if (indBadge) {
    indBadge.textContent = indCount;
    indBadge.style.display = indCount > 0 ? 'inline-block' : 'none';
  }
}


/* ---------- filter tab switching ---------- */
function switchFilterTab(tab) {
  const techPane  = document.getElementById('scrPaneTechnicals');
  const indPane   = document.getElementById('scrPaneIndustry');
  const multiPane = document.getElementById('scrPaneMulti');
  const techTab   = document.getElementById('scrTabTechnicals');
  const indTab    = document.getElementById('scrTabIndustry');
  const multiTab  = document.getElementById('scrTabMulti');

  techPane.style.display  = tab === 'technicals' ? '' : 'none';
  indPane.style.display   = tab === 'industry'   ? '' : 'none';
  multiPane.style.display = tab === 'multi'      ? '' : 'none';
  techTab.classList.toggle('active', tab === 'technicals');
  indTab.classList.toggle('active', tab === 'industry');
  multiTab.classList.toggle('active', tab === 'multi');

  if (tab === 'multi' && typeof populateMultiPresetList === 'function') populateMultiPresetList();
}

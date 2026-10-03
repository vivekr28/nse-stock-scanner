// ═══════════════════════════════════════════════════════════════════════════════
// AS OF DATE SCAN — the Stock Scanner popup's "As of Date" tab.
// Self-contained: its own filters (asof* element ids), its own calculations and its own results table. It only READS
// Store and does not touch the screener's filters, presets or processing.
// For a chosen past trading day it evaluates each stock using only the bars up to and including that day.
// ═══════════════════════════════════════════════════════════════════════════════

let _asofPassed = [];

function asofEl(id) { return document.getElementById(id); }
function asofIso(ds) {
  const d = new Date(parseDate(ds));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ---------- tab show / hide (own handlers, the existing tab code is untouched) ---------- */
const ASOF_OTHER_PANES = ['scrPaneTechnicals', 'scrPaneIndustry', 'scrPaneMulti'];
const ASOF_OTHER_TABS = ['scrTabTechnicals', 'scrTabIndustry', 'scrTabMulti'];

function asOfShowTab() {
  ASOF_OTHER_PANES.forEach(id => { const p = asofEl(id); if (p) p.style.display = 'none'; });
  ASOF_OTHER_TABS.forEach(id => { const t = asofEl(id); if (t) t.classList.remove('active'); });
  asofEl('scrPaneAsOf').style.display = '';
  asofEl('scrTabAsOf').classList.add('active');
  const footer = document.querySelector('#scrFiltersModal .scr-modal-footer');
  if (footer) footer.style.display = 'none'; // Apply & Scan / Reset All belong to the other tabs
  asOfInitDate();
}

function asOfHideTab() {
  const pane = asofEl('scrPaneAsOf');
  if (pane) pane.style.display = 'none';
  const tab = asofEl('scrTabAsOf');
  if (tab) tab.classList.remove('active');
  const footer = document.querySelector('#scrFiltersModal .scr-modal-footer');
  if (footer) footer.style.display = '';
}

ASOF_OTHER_TABS.forEach(id => {
  const t = asofEl(id);
  if (t) t.addEventListener('click', asOfHideTab);
});

// Limit the picker to the loaded data; default to about one month back
function asOfInitDate() {
  const input = asofEl('asofDate');
  if (!input || !Store.dates || !Store.dates.length) return;
  input.min = asofIso(Store.dates[0]);
  input.max = asofIso(Store.dates[Store.dates.length - 1]);
  if (!input.value) input.value = asofIso(Store.dates[Math.max(0, Store.dates.length - 1 - 21)]);
}

/* ---------- calculations over bars [0..end] ---------- */
function asofSma(days, end, field, len) {
  if (end + 1 < len) return NaN;
  let s = 0;
  for (let i = end - len + 1; i <= end; i++) s += days[i][field] || 0;
  return s / len;
}

// EMA ending at `end`, seeded with the SMA of the first `len` bars (same method as the screener's 200 EMA)
function asofEma(days, end, field, len) {
  if (end + 1 < len) return NaN;
  const k = 2 / (len + 1);
  let ema = 0;
  for (let i = 0; i < len; i++) ema += days[i][field] || 0;
  ema /= len;
  for (let i = len; i <= end; i++) ema = (days[i][field] || 0) * k + ema * (1 - k);
  return ema;
}

function asofAdr(days, end, len) {
  if (end + 1 < len) return NaN;
  let s = 0;
  for (let i = end - len + 1; i <= end; i++) s += (days[i].high - days[i].low) / days[i].close * 100;
  return s / len;
}

// Highest high of up to `n` bars ending at `end` (52W uses up to 250 bars, like the dashboard's 52W high)
function asofHigh(days, end, n, from) {
  let h = 0;
  for (let i = Math.max(0, from !== undefined ? from : end - n + 1); i <= end; i++) if (days[i].high > h) h = days[i].high;
  return h;
}

// Index of the bar dated exactly `dateStr`, or -1 (the stock did not trade that day)
function asofIdx(days, dateStr) {
  const ts = parseDate(dateStr);
  let lo = 0, hi = days.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = parseDate(days[mid].date);
    if (t === ts) return mid;
    if (t < ts) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// Trading day on/before the picked calendar date
function asofResolveDate() {
  const v = asofEl('asofDate').value;
  if (!v || !Store.dates || !Store.dates.length) return null;
  const [y, m, d] = v.split('-').map(Number);
  const ts = new Date(y, m - 1, d).getTime();
  let ans = null;
  for (const ds of Store.dates) { if (parseDate(ds) <= ts) ans = ds; else break; }
  return ans;
}

// Index of the last bar dated on/before ts among bars [0..maxIdx], or -1
function asofIdxOnOrBefore(days, ts, maxIdx) {
  let lo = 0, hi = maxIdx, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (parseDate(days[mid].date) <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function asofIsoToTs(iso) {
  if (!iso) return NaN;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/* ---------- price band history (for Exclude Circuits) ---------- */
// { normalizedSymbol: [[YYYY-MM-DD, band], ...] } listing only the days the band changed. Fetched once, on first use.
let _asofBandHistory = null;

async function asofLoadBandHistory() {
  if (_asofBandHistory) return _asofBandHistory;
  try {
    const resp = await fetch('/api/band-history');
    if (!resp.ok) return null;
    const json = await resp.json();
    _asofBandHistory = json.bySymbol || null;
  } catch (e) {
    _asofBandHistory = null;
  }
  return _asofBandHistory;
}

// The stock's band on `iso` (last change on/before it), or null when there is no band history for that day
function asofBandOn(history, symbol, iso) {
  const list = history[normalizeSymbol(symbol)];
  if (!list || !list.length) return null;
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : String(list[ans][1]);
}

/* ---------- the scan ---------- */
const ASOF_ON_IDS = ['asofAOn', 'asofBOn', 'asofCOn', 'asofDOn', 'asofEOn', 'asofFOn', 'asofGOn', 'asofHOn', 'asofIOn', 'asofJOn', 'asofKOn'];

// How many As of Date filters are switched on (counted in the main Filters button's badge and the tab's own badge)
function asOfActiveCount() {
  return ASOF_ON_IDS.filter(id => { const el = asofEl(id); return !!(el && el.checked); }).length;
}

// The count on the As of Date tab, the same style as the other tabs' badges
function asOfUpdateBadge() {
  const badge = asofEl('scrTabAsOfCount');
  if (!badge) return;
  const n = asOfActiveCount();
  badge.textContent = n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
}

// True when a loaded preset has any As of Date filter switched on (js/presets.js loadPreset() then runs the as-of scan)
function asOfPresetActive() {
  return asOfActiveCount() > 0;
}

// opts.keepOpen: leave the filters popup open (used when a preset is loaded from its header)
async function asOfRun(opts) {
  const status = asofEl('asofStatus');
  const dateStr = asofResolveDate();
  if (!dateStr) { status.textContent = 'Pick a date inside the loaded data.'; return; }
  asofEl('asofDateNote').textContent = '→ trading day ' + dateStr;

  const num = (id, dflt) => { const v = parseFloat(asofEl(id).value); return isNaN(v) ? dflt : v; };
  const on = id => asofEl(id).checked;

  const aOn = on('asofAOn');
  const aLens = [20, 50, 200].filter(n => on('asofA' + n));
  const aEma200 = on('asofAE200');
  const bOn = on('asofBOn'), bVal = num('asofBVal', 0);
  const cOn = on('asofCOn'), cVal = num('asofCVal', 0) * 100;            // Cr -> lakhs
  const dOn = on('asofDOn'), dLen = Math.max(1, Math.round(num('asofDLen', 50))), dVal = num('asofDVal', 0) * 100;
  const eOn = on('asofEOn'), eMult = num('asofEMult', 3), eLen = Math.max(1, Math.round(num('asofELen', 50)));
  const fOn = on('asofFOn'), fMin = num('asofFMin', 0), fMax = num('asofFMax', 100);
  const gOn = on('asofGOn'), gLen = Math.max(1, Math.round(num('asofGLen', 50))), gVal = num('asofGVal', 0);
  const hOn = on('asofHOn'), hDays = Math.round(num('asofHPeriod', 21)), hVal = num('asofHVal', 0);
  const iOn = on('asofIOn');
  const iWins = [21, 63, 252].filter(n => on('asofI' + n));
  const jOn = on('asofJOn');
  const jExclude = new Set([2, 5, 10].filter(n => on('asofJ' + n)).map(String));
  let bandHistory = null;
  if (jOn) {
    status.textContent = 'Loading price band history...';
    bandHistory = await asofLoadBandHistory();
    if (!bandHistory) { status.textContent = 'Could not load the price band history from the server (needs the dashboard server running).'; return; }
  }
  const dateIso = asofIso(dateStr);
  const kOn = on('asofKOn'), kVal = num('asofKVal', 0);
  const kFromField = asofEl('asofKFromField').value || 'close', kToField = asofEl('asofKToField').value || 'close';
  const kFromTs = asofIsoToTs(asofEl('asofKFromDate').value);
  const kToRaw = asofIsoToTs(asofEl('asofKToDate').value);
  if (kOn && isNaN(kFromTs)) { status.textContent = 'Pick a From date for the % Change filter.'; return; }

  const passed = [];
  let scanned = 0;
  for (const key in Store.dailyBySymbol) {
    const days = Store.dailyBySymbol[key];
    const end = asofIdx(days, dateStr);
    if (end < 0) continue; // did not trade that day
    scanned++;
    const bar = days[end];
    const close = bar.close;

    if (aOn) {
      let ok = true;
      for (const n of aLens) { const v = asofSma(days, end, 'close', n); if (isNaN(v) || !(close > v)) { ok = false; break; } }
      if (ok && aEma200) { const v = asofEma(days, end, 'close', 200); if (isNaN(v) || !(close > v)) ok = false; }
      if (!ok) continue;
    }
    const prevClose = bar.prev > 0 ? bar.prev : (end > 0 ? days[end - 1].close : 0);
    const dayChg = prevClose > 0 ? (close - prevClose) / prevClose * 100 : NaN;
    if (bOn && !(dayChg >= bVal)) continue;
    if (cOn && !((bar.turnover || 0) > cVal)) continue;
    if (dOn) { const v = asofSma(days, end, 'turnover', dLen); if (isNaN(v) || !(v > dVal)) continue; }
    if (eOn) {
      // average of the eLen bars BEFORE the day, so a spike is compared against normal activity
      if (end < eLen) continue;
      const avg = asofSma(days, end - 1, 'turnover', eLen);
      if (!(avg > 0) || (bar.turnover || 0) < eMult * avg) continue;
    }
    if (jOn) {
      const band = asofBandOn(bandHistory, bar.symbol, dateIso);
      if (band !== null && jExclude.has(band.replace('%', '').trim())) continue;
    }
    if (kOn) {
      // independent of the scan date: its own From / To dates over the stock's whole history (blank To = the latest bar)
      const toTs = isNaN(kToRaw) ? Infinity : kToRaw;
      if (kFromTs > toTs) continue;
      const fi = asofIdxOnOrBefore(days, kFromTs, days.length - 1), ti = asofIdxOnOrBefore(days, toTs, days.length - 1);
      if (fi < 0 || ti < fi) continue;
      const a = days[fi][kFromField], b = days[ti][kToField];
      if (!(a > 0) || !(b > 0) || !((b - a) / a * 100 >= kVal)) continue;
    }
    const high52 = asofHigh(days, end, 250);
    const dist52 = high52 > 0 ? (high52 - close) / high52 * 100 : NaN;
    if (fOn && !(dist52 >= fMin && dist52 <= fMax)) continue;
    if (gOn) { const v = asofAdr(days, end, gLen); if (isNaN(v) || !(v > gVal)) continue; }
    const perf = (n) => (end >= n && days[end - n].close > 0) ? (close - days[end - n].close) / days[end - n].close * 100 : NaN;
    if (hOn) { const v = perf(hDays); if (isNaN(v) || !(v >= hVal)) continue; }
    if (iOn) {
      let ok = true;
      for (const n of iWins) {
        if (end + 1 < n) { ok = false; break; }
        const prior = asofHigh(days, end - 1, n - 1); // previous n-1 bars
        if (!(bar.high > prior)) { ok = false; break; }
      }
      if (!ok) continue;
    }

    // Same row shape the main results table reads (see renderScreenerTable); sector / industry / market cap are today's
    const sInfo = (Store.sectorMap && Store.sectorMap[normalizeSymbol(bar.symbol)]) || {};
    const band = bandHistory ? asofBandOn(bandHistory, bar.symbol, dateIso) : null;
    passed.push({
      isin: bar.isin || key, symbol: bar.symbol, companyName: bar.companyName || '',
      sector: (sInfo.sector && sInfo.sector !== '-') ? sInfo.sector : 'Undefined-Diversified',
      industry: (sInfo.industry && sInfo.industry !== '-') ? sInfo.industry : 'Undefined-Diversified',
      marketCap: sInfo.marketCap || 0,
      open: bar.open, high: bar.high, low: bar.low, close, changePct: isNaN(dayChg) ? 0 : dayChg,
      turnover: bar.turnover || 0, adr: asofAdr(days, end, 20), high52w: high52, distFrom52H: isNaN(dist52) ? 0 : dist52,
      bandPct: band !== null ? (band.includes('%') || isNaN(parseFloat(band)) ? band : band + '%') : '',
    });
  }

  passed.sort((a, b) => b.turnover - a.turnover);
  _asofPassed = passed;
  const active = [aOn, bOn, cOn, dOn, eOn, fOn, gOn, hOn, iOn, jOn, kOn].filter(Boolean).length;
  asOfShowInMainWindow(passed, scanned, active, dateStr, !!(opts && opts.keepOpen));
}

// Show the result in the main Stock Scanner window, the way the other tabs do: fill the screener's result arrays and
// stats row and let its own table render them (paging, sorting, CSV / TradingView export all work on it).
function asOfShowInMainWindow(passed, scanned, activeFilters, dateStr, keepOpen) {
  screenerPassed = passed;
  screenerFailed = [];
  scrShowingFailed = false;
  screenerResults = passed;
  screenerPage = 0;
  scrSortCol = null;
  const advancing = passed.filter(s => s.changePct > 0).length;
  const declining = passed.filter(s => s.changePct < 0).length;
  const avgChange = passed.length > 0 ? (passed.reduce((t, r) => t + (r.changePct || 0), 0) / passed.length) : 0;
  asofEl('screenerStats').innerHTML = `
    <div class="stat-card"><div class="label">As of Date</div><div class="value" style="color:var(--orange)">${dateStr}</div></div>
    <div class="stat-card"><div class="label">Active Filters</div><div class="value" style="color:var(--accent)">${activeFilters}</div></div>
    <div class="stat-card"><div class="label">Passed</div><div class="value positive">${passed.length}</div></div>
    <div class="stat-card"><div class="label">Traded That Day</div><div class="value">${scanned}</div></div>
    <div class="stat-card"><div class="label">Advancing (Passed)</div><div class="value positive">${advancing}</div></div>
    <div class="stat-card"><div class="label">Declining (Passed)</div><div class="value negative">${declining}</div></div>
    <div class="stat-card"><div class="label">Avg Change % (Passed)</div><div class="value ${avgChange >= 0 ? 'positive' : 'negative'}">${avgChange.toFixed(2)}%</div></div>`;
  updateToggleButton();
  renderScreenerTable();
  asofEl('asofStatus').textContent = '';
  if (!keepOpen) closeScreenerFilters();
}

// Put the tab's controls back to their defaults. Run by the screener's Reset All (resetScreener); the tab's own
// "Reset All" button calls that, so both buttons do the same thing.
function asOfReset() {
  const set = (id, v) => { asofEl(id).value = v; };
  const chk = (id, v) => { asofEl(id).checked = v; };
  ASOF_ON_IDS.forEach(id => chk(id, false));
  chk('asofA20', true); chk('asofA50', false); chk('asofA200', false); chk('asofAE200', false);
  chk('asofJ2', true); chk('asofJ5', true); chk('asofJ10', true);
  chk('asofI21', false); chk('asofI63', true); chk('asofI252', false);
  set('asofBVal', '2'); set('asofCVal', '5'); set('asofDLen', '50'); set('asofDVal', '1');
  set('asofEMult', '3'); set('asofELen', '50'); set('asofFMin', '0'); set('asofFMax', '10');
  set('asofGLen', '50'); set('asofGVal', '3'); set('asofHPeriod', '21'); set('asofHVal', '0');
  set('asofKFromField', 'close'); set('asofKToField', 'close'); set('asofKVal', '0');
  asofEl('asofKFromDate').value = ''; asofEl('asofKToDate').value = '';
  asofEl('asofDate').value = '';
  asOfInitDate();
  _asofPassed = [];
  asofEl('asofStatus').textContent = '';
  asofEl('asofDateNote').textContent = '';
  asOfRefreshBadges();
}

// The screener panel re-runs its own scan whenever an input inside it changes. This tab has its own explicit Scan
// button, so keep its edits from reaching that listener.
['change', 'input'].forEach(type => {
  const pane = asofEl('scrPaneAsOf');
  if (pane) pane.addEventListener(type, e => {
    e.stopPropagation();
    if (type === 'change') asOfRefreshBadges();
  });
});

// Refresh the tab's badge and the main Filters button's badge (the latter via the screener's own updateFilterBadge)
function asOfRefreshBadges() {
  if (typeof updateFilterBadge === 'function') updateFilterBadge();
  else asOfUpdateBadge();
}

// ═══════════════════════════════════════════════════════════════════════════════
// BREADTH UNIVERSE — the Market Breadth tab's "Universe" selector: show every breadth chart for all stocks (the default), one SECTOR or
// one INDUSTRY, e.g. "% of Pharmaceuticals stocks above their 20 SMA" over the last ~2 years, optionally against the market-wide line and
// optionally smoothed. It reuses breadth.js's own calculation (computeBreadthHistories, which takes an optional stock filter), so the
// numbers are the same ones the market-wide chart uses: the industries of a sector, or all industries together, add up to the market-wide
// count on every day. breadth.js reaches this file only through the hooks below (each call guarded by typeof):
//   bruReset(allHistory, numDays)   new data: remember the market-wide history, rebuild the dropdown (keeping the selection if it still exists)
//   bruCurrent()                    the history to chart for the current selection (smoothed when the box is ticked)
//   bruCompare()                    the market-wide history to draw behind it, or null (all stocks selected / box not ticked)
//   bruTitleSuffix() / bruNote()    the chart title's ending and the note line under it
//   bruTag()                        changes whenever the plotted VALUES change (universe, smoothing): the drawing tools reset on it
//   bruSyncControls(isMulti)        enable / disable the "vs market" box (it applies to single-line charts of a sub-universe only)
// Classification is TODAY's (Store.latestBySymbol sector / industry applied to the whole history), like the market-wide chart's universe is
// today's list of stocks. Small groups are jumpy (one stock crossing its average moves a 7-stock industry by 14 points), so industries
// under BRU_SMALL stocks are listed last, under their own heading.
// ═══════════════════════════════════════════════════════════════════════════════

const BRU_ALL = 'all';
const BRU_SMALL = 10;            // an industry with fewer stocks than this is listed under "small (noisy)"
const BRU_SMOOTH_DAYS = 5;       // the "Smooth" box: trailing average of this many days
// the breadth metrics (breadth.js BRD_METRICS prefixes) whose closing % the smoothing replaces
const BRU_PREFIXES = ['above20', 'above50', 'move4d', 'move10w', 'move20m', 'high1m', 'high3m', 'high1y', 'highAth'];

let _bruAll = [];                // the market-wide history, exactly as breadth.js computed it (never smoothed)
let _bruNumDays = 0;
let _bruCache = {};              // universe value -> that universe's history (unsmoothed)

const bruUnknown = 'Undefined-Diversified';
const bruSectorOf = s => (s && s.sector) || bruUnknown;
const bruIndustryOf = s => (s && s.industry) || bruUnknown;

// The groups the dropdown offers, counted over the stocks that have price history: { sectors, industries, small }, each [{ name, count }] by name.
function bruGroups() {
  const sec = {}, ind = {};
  for (const isin in Store.dailyBySymbol) {
    const meta = Store.latestBySymbol[isin];
    if (!meta) continue;
    sec[bruSectorOf(meta)] = (sec[bruSectorOf(meta)] || 0) + 1;
    ind[bruIndustryOf(meta)] = (ind[bruIndustryOf(meta)] || 0) + 1;
  }
  const list = o => Object.keys(o).sort((a, b) => a.localeCompare(b)).map(name => ({ name, count: o[name] }));
  const industries = list(ind);
  return { sectors: list(sec), industries: industries.filter(g => g.count >= BRU_SMALL), small: industries.filter(g => g.count < BRU_SMALL) };
}

// 'all' | 'sec:<sector>' | 'ind:<industry>' -> the stock filter computeBreadthHistories takes (null = every stock)
function bruFilterFor(value) {
  if (!value || value === BRU_ALL) return null;
  const name = value.slice(4);
  if (value.startsWith('sec:')) return isin => !!Store.latestBySymbol[isin] && bruSectorOf(Store.latestBySymbol[isin]) === name;
  if (value.startsWith('ind:')) return isin => !!Store.latestBySymbol[isin] && bruIndustryOf(Store.latestBySymbol[isin]) === name;
  return null;
}

// How many stocks the universe holds (those with price history)
function bruCount(value) {
  const f = bruFilterFor(value);
  let n = 0;
  for (const isin in Store.dailyBySymbol) if (Store.latestBySymbol[isin] && (!f || f(isin))) n++;
  return n;
}

// Trailing mean of the last `days` values (fewer at the start) - the smoothing
function bruSmoothValues(values, days) {
  const out = new Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= days) sum -= values[i - days];
    out[i] = sum / Math.min(i + 1, days);
  }
  return out;
}

// A copy of a history whose closing % of every metric is smoothed; the counts and the open / high / low are left as they were
function bruSmoothHistory(history, days = BRU_SMOOTH_DAYS) {
  const copy = history.map(d => Object.assign({}, d));
  for (const p of BRU_PREFIXES) {
    const key = p + 'OHLC';
    const sm = bruSmoothValues(history.map(d => d[key].close), days);
    copy.forEach((d, i) => { d[key] = Object.assign({}, d[key], { close: sm[i] }); });
  }
  return copy;
}

const bruEl = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
function bruValue() { const s = bruEl('brdUniverse'); return s && s.value ? s.value : BRU_ALL; }
function bruSmoothOn() { const c = bruEl('brdSmooth'); return !!(c && c.checked); }
function bruCompareOn() { const c = bruEl('brdCompare'); return !!(c && c.checked && !c.disabled); }

function bruHistoryOf(value) {
  if (value === BRU_ALL) return _bruAll;
  if (!_bruCache[value]) _bruCache[value] = computeBreadthHistories(_bruNumDays, bruFilterFor(value));
  return _bruCache[value];
}

function bruCurrent() {
  const h = bruHistoryOf(bruValue());
  return bruSmoothOn() ? bruSmoothHistory(h) : h;
}

function bruCompare() {
  if (bruValue() === BRU_ALL || !bruCompareOn()) return null;
  return bruSmoothOn() ? bruSmoothHistory(_bruAll) : _bruAll;
}

// The name the current selection goes by ('' for all stocks)
function bruLabel() {
  const v = bruValue();
  return v === BRU_ALL ? '' : v.slice(4);
}
function bruTitleSuffix() { const l = bruLabel(); return l ? ' - ' + l : ''; }
function bruNote() {
  const v = bruValue();
  if (v === BRU_ALL) return '';
  const n = bruCount(v), kind = v.startsWith('sec:') ? 'sector' : 'industry';
  return `Universe: ${bruLabel()} (${kind}, ${n} stock${n === 1 ? '' : 's'})` +
    (v.startsWith('ind:') && n < BRU_SMALL ? ' - a small group, so the line is jumpy: one stock moves it by ' + (100 / n).toFixed(0) + ' points' : '') +
    (bruCompareOn() ? ' - dashed line: all NSE stocks' : '');
}
function bruTag() { return bruValue() + '|' + (bruSmoothOn() ? 's' : ''); }

// The "vs market" box only means something for a sub-universe on a single-line chart
function bruSyncControls(isMulti) {
  const c = bruEl('brdCompare');
  if (!c) return;
  c.disabled = bruValue() === BRU_ALL || !!isMulti;
  const label = bruEl('brdCompareLabel');
  if (label) label.title = bruValue() === BRU_ALL ? 'Pick a sector or an industry to compare it with the whole market'
    : (isMulti ? 'Not available for the overlay charts (several lines already)' : 'Draw the all-stocks line (dashed) behind this one');
}

// New market-wide data: remember it, forget the cached universes and rebuild the dropdown, keeping the selection when it still exists
function bruReset(allHistory, numDays) {
  _bruAll = allHistory;
  _bruNumDays = numDays;
  _bruCache = {};
  const sel = bruEl('brdUniverse');
  if (!sel || typeof document === 'undefined' || !document.createElement) return;
  const previous = sel.value;
  const g = bruGroups();
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (s => s);
  const opts = (prefix, groups) => groups.map(x => `<option value="${prefix}${esc(x.name)}">${esc(x.name)} (${x.count})</option>`).join('');
  sel.innerHTML = `<option value="${BRU_ALL}">All stocks</option>` +
    `<optgroup label="Sectors">${opts('sec:', g.sectors)}</optgroup>` +
    `<optgroup label="Industries (${BRU_SMALL}+ stocks)">${opts('ind:', g.industries)}</optgroup>` +
    (g.small.length ? `<optgroup label="Industries under ${BRU_SMALL} stocks (jumpy)">${opts('ind:', g.small)}</optgroup>` : '');
  const exists = [...(sel.options || [])].some(o => o.value === previous);
  sel.value = exists ? previous : BRU_ALL;
}

// The dropdown / boxes were changed: refresh the title, note and chart (breadth.js)
function brdUniverseChanged() {
  brdUpdateHeader();
  brdRenderActiveTab();
}

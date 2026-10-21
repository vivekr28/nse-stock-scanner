// Stock Scanner popup's "Sector & Industry" tab: two trend filters on the group a stock belongs to, not on the stock itself.
//   F37 "Sector above SMA"    - the equal-weight index of the stock's sector closes above its own 10 / 20 / 50 SMA
//   F38 "Industry above SMA"  - the same for the stock's industry
// The equal-weight index is the one the Market Overview tab charts for an industry and the chart popup's "Industry Chart" tab shows
// (icComputeIndustryIndex in js/industry-charts.js: every stock's own daily % move averaged across the group's stocks, chained from 100), so
// "above its 50 SMA" here is what the eye sees on that chart. Tick any of 10 / 20 / 50: the index must be above EVERY ticked SMA. Ticking an
// SMA switches the filter on; unticking the last one switches it off; switching it on with none ticked ticks the 20.
// A group with no index (too little history) fails. screener.js reaches this file only through the hooks below (each call guarded by typeof,
// like js/group-breadth.js), so the scanner holds none of these controls, fields or columns.

const GT_LENGTHS = [10, 20, 50];
const GT_FILTERS = [
  { code: 'F37', prefix: 'scrF37', level: 'sector',   noun: 'Sector',   stateKey: 'sec', key: '_gtSec', colLabel: 'Sector EW vs SMA' },
  { code: 'F38', prefix: 'scrF38', level: 'industry', noun: 'Industry', stateKey: 'ind', key: '_gtInd', colLabel: 'Ind EW vs SMA' },
];
const GT_FILTER_IDS = GT_FILTERS.map(d => d.prefix + 'On');
const GT_UNKNOWN = 'Undefined-Diversified';

let _gtCache = {};   // level -> { sig, map }

// Core, pure. For each group of one level ('industry' | 'sector'): { close, sma: { 10, 20, 50 } } of its equal-weight index today
// (an SMA is NaN while the index has fewer closes than its length). Cached until the loaded data changes.
function gtGroupMap(level) {
  const dates = Store.dates || [];
  const sig = dates.length + '|' + (dates[dates.length - 1] || '');
  const hit = _gtCache[level];
  if (hit && hit.sig === sig) return hit.map;

  const members = {};
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const name = s[level] || GT_UNKNOWN;
    (members[name] || (members[name] = [])).push(s);
  }
  const map = {};
  for (const name in members) {
    const idx = icComputeIndustryIndex(members[name]);
    if (!idx || !idx.closes.length) continue;
    const closes = idx.closes;
    const g = { close: closes[closes.length - 1], sma: {} };
    for (const len of GT_LENGTHS) {
      let sum = 0;
      for (let i = closes.length - len; i < closes.length; i++) sum += closes[i];
      g.sma[len] = closes.length >= len ? sum / len : NaN;
    }
    map[name] = g;
  }
  _gtCache[level] = { sig, map };
  return map;
}

const gtEl = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const gtTicked = def => GT_LENGTHS.filter(len => { const e = gtEl(def.prefix + 'Sma' + len); return !!(e && e.checked); });

// ── Hooks for the Stock Scanner (js/screener.js; each call guarded by typeof) ───────────────────────────────────────────────

// F37 and F38 as the scanner should apply them now: { sec:{on, lens}, ind:{on, lens}, any }. A filter is on only with an SMA ticked.
function gtFilterState() {
  const s = {};
  for (const def of GT_FILTERS) {
    const on = gtEl(def.prefix + 'On');
    const lens = gtTicked(def);
    s[def.stateKey] = { on: !!(on && on.checked) && lens.length > 0, lens };
  }
  s.any = GT_FILTERS.some(def => s[def.stateKey].on);
  return s;
}

// The group maps of the levels that are switched on (computed once per scan, not per stock)
function gtPrepare(state) {
  const maps = {};
  for (const def of GT_FILTERS) if (state[def.stateKey].on) maps[def.stateKey] = gtGroupMap(def.level);
  return maps;
}

// Runs the filters that are on for one stock: records what the columns show (_gtSec / _gtInd: the index's % distance above the longest
// ticked SMA) and returns the reasons it fails ([] = passes). `state` is gtFilterState()'s result and `maps` gtPrepare()'s.
function gtApplyToStock(stock, state, maps) {
  const reasons = [];
  for (const def of GT_FILTERS) {
    const f = state[def.stateKey];
    if (!f.on) continue;
    const name = stock[def.level] || GT_UNKNOWN;
    const g = maps[def.stateKey][name];
    const longest = f.lens[f.lens.length - 1];
    stock[def.key] = g && g.sma[longest] > 0 ? (g.close / g.sma[longest] - 1) * 100 : NaN;
    if (!g) { reasons.push(`${def.code}: ${def.noun} '${name}' has no equal-weight index`); continue; }
    const below = f.lens.filter(len => !(g.close > g.sma[len]));
    if (below.length) {
      reasons.push(`${def.code}: ${def.noun} '${name}' EW index ${g.close.toFixed(1)} not above ${below.map(len => len + ' SMA' + (isNaN(g.sma[len]) ? ' (n/a)' : ' ' + g.sma[len].toFixed(1))).join(', ')}`);
    }
  }
  return reasons;
}

// How many of this tab's filters are switched on (added to the Sector & Industry tab's badge and the active-filter count)
function gtActiveCount() {
  return GT_FILTERS.filter(def => { const on = gtEl(def.prefix + 'On'); return !!(on && on.checked) && gtTicked(def).length > 0; }).length;
}

// Extra table columns for each of F37 / F38 that is on: the index's % above (green) or below (red) the longest ticked SMA
function gtColumns() {
  const s = gtFilterState();
  const cols = [];
  for (const def of GT_FILTERS) {
    const f = s[def.stateKey];
    if (!f.on) continue;
    const longest = f.lens[f.lens.length - 1];
    cols.push({ key: def.key, label: `${def.colLabel.replace('SMA', longest + ' SMA')}`,
                fmt: v => isNaN(v) ? '-' : (v > 0 ? '+' : '') + v.toFixed(1) + '%', cls: v => (v > 0 ? 'positive' : 'negative') });
  }
  return cols;
}

// Reset All: both filters off with nothing ticked
function gtReset() {
  const set = (id, v) => { const e = gtEl(id); if (e) e.checked = v; };
  for (const def of GT_FILTERS) {
    set(def.prefix + 'On', false);
    for (const len of GT_LENGTHS) set(def.prefix + 'Sma' + len, false);
  }
}

// A preset or data load: nothing to redraw (plain checkboxes); kept so callers can treat every tab module alike
function gtWire() {
  for (const def of GT_FILTERS) {
    const on = gtEl(def.prefix + 'On');
    if (!on || !on.addEventListener) continue;
    on.addEventListener('change', () => {
      // switching it on with nothing ticked would restrict nothing: tick the 20 SMA so it does what it says
      if (on.checked && !gtTicked(def).length) { const e = gtEl(def.prefix + 'Sma20'); if (e) e.checked = true; }
    });
    for (const len of GT_LENGTHS) {
      const e = gtEl(def.prefix + 'Sma' + len);
      if (e && e.addEventListener) e.addEventListener('change', () => { on.checked = gtTicked(def).length > 0; });
    }
  }
}
gtWire();

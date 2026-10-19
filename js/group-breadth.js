// Stock Scanner popup's "Sector & Industry" tab: two breadth filters on the group a stock belongs to, not on the stock itself.
//   F34 "Industry breadth"  - % of the stocks in the stock's industry that are above their 20 SMA, greater than N
//   F35 "Sector breadth"    - the same for the stock's sector
// "Breadth" is the figure the Industry Analysis and Sector Analysis tabs show in their Breadth column: the stocks flagged aboveSMA (latest
// close above their own 20 SMA) divided by ALL the stocks of the group (a stock with too little history to have an SMA counts as not above).
// So the number typed here means the same as the number in those tables. A group of one stock is 0% or 100% - pair it with "Min Stocks in
// Industry" (F13) to leave out the tiny ones.
// screener.js reaches this file only through the hooks below (each call guarded by typeof, like the Relative Strength and Quarterly Results
// modules), so the scanner holds none of these controls, fields or columns.

// code / prefix = the filter's number and element-id prefix, level = the stock field that names the group, key = the stock fields the columns read
const GB_FILTERS = [
  { code: 'F34', prefix: 'scrF34', level: 'industry', noun: 'Industry', stateKey: 'ind', key: '_gbInd', colLabel: 'Ind Breadth' },
  { code: 'F35', prefix: 'scrF35', level: 'sector',   noun: 'Sector',   stateKey: 'sec', key: '_gbSec', colLabel: 'Sector Breadth' },
];
const GB_FILTER_IDS = GB_FILTERS.map(d => d.prefix + 'On');
const GB_DEFAULT_VAL = '50';
const GB_UNKNOWN = 'Undefined-Diversified';

// Core, pure. Every group's { above, count, pct } for one level ('industry' | 'sector'), over the stocks in Store.latestBySymbol.
function gbBreadthMap(level) {
  const map = {};
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const name = s[level] || GB_UNKNOWN;
    const g = map[name] || (map[name] = { above: 0, count: 0, pct: 0 });
    g.count++;
    if (s.aboveSMA) g.above++;
  }
  for (const name in map) map[name].pct = map[name].above / map[name].count * 100;
  return map;
}

// ── Hooks for the Stock Scanner (js/screener.js; each call guarded by typeof) ───────────────────────────────────────────────

// F34 and F35 as the scanner should apply them now: { ind:{on, val}, sec:{on, val}, any }
function gbFilterState() {
  const el = id => document.getElementById(id);
  const s = {};
  for (const def of GB_FILTERS) {
    const on = el(def.prefix + 'On'), val = el(def.prefix + 'Val');
    s[def.stateKey] = { on: !!(on && on.checked), val: parseFloat(val ? val.value : '') || 0 };
  }
  s.any = GB_FILTERS.some(def => s[def.stateKey].on);
  return s;
}

// The breadth maps of the levels that are switched on (computed once per scan, not per stock)
function gbPrepare(state) {
  const maps = {};
  for (const def of GB_FILTERS) if (state[def.stateKey].on) maps[def.stateKey] = gbBreadthMap(def.level);
  return maps;
}

// Runs the filters that are on for one stock: records what the columns show (_gbInd / _gbSec) and returns the reasons it fails
// ([] = passes). `state` is gbFilterState()'s result and `maps` gbPrepare()'s; call it only when state.any.
function gbApplyToStock(stock, state, maps) {
  const reasons = [];
  for (const def of GB_FILTERS) {
    const f = state[def.stateKey];
    if (!f.on) continue;
    const name = stock[def.level] || GB_UNKNOWN;
    const g = maps[def.stateKey][name];
    stock[def.key] = g ? g.pct : NaN;
    // strictly greater than the typed number, as the label says
    if (!g || !(g.pct > f.val)) {
      reasons.push(`${def.code}: ${def.noun} '${name}' breadth ${g ? g.pct.toFixed(1) + '% (' + g.above + ' of ' + g.count + ' above 20 SMA)' : 'n/a'} not > ${f.val}%`);
    }
  }
  return reasons;
}

// How many of this tab's filters are switched on (the scanner adds it to the Sector & Industry tab's badge and its active-filter count)
function gbActiveCount() {
  return GB_FILTER_IDS.filter(id => { const e = document.getElementById(id); return !!(e && e.checked); }).length;
}

// Extra table columns for each of F34 / F35 that is on: the group's breadth
function gbColumns() {
  const s = gbFilterState();
  const cols = [];
  for (const def of GB_FILTERS) {
    if (!s[def.stateKey].on) continue;
    cols.push({ key: def.key, label: def.colLabel, fmt: v => isNaN(v) ? '-' : v.toFixed(1) + '%',
                cls: v => (v > s[def.stateKey].val ? 'positive' : 'negative') });
  }
  return cols;
}

// Reset All: both filters back to their defaults
function gbReset() {
  const set = (id, prop, v) => { const e = document.getElementById(id); if (e) e[prop] = v; };
  for (const def of GB_FILTERS) {
    set(def.prefix + 'On', 'checked', false);
    set(def.prefix + 'Val', 'value', GB_DEFAULT_VAL);
  }
}

// Stock Scanner popup's "Relative Strength" tab: the Performance filter (F15) and the % Change filter (F16), both moved here from
// Technicals - their logic is still in screener.js - and two filters that compare the next n trading days with the Open / High / Low / Close of a
// chosen date:
//   F24 "Close Above" - did the stock CLOSE above that price on any of the next n days?
//   F25 "High Above"  - did the stock's HIGH trade above that price on any of the next n days?
// screener.js reaches this file only through the hooks at the bottom (each call guarded by typeof, like the Quarterly Results
// module's), so the scanner holds no F24 / F25 controls, fields or columns. Uses scrIsoToTs / scrBarIdxOnOrBefore (screener.js).

const RS_FIELD_LABEL = { open: 'Open', high: 'High', low: 'Low', close: 'Close' };

// The two filters differ only in which price of the following days is tested, so they share one check and one set of hooks.
// prefix = element-id prefix, test = the following days' price compared with the level, key = the stock fields the columns read.
const RS_PRICE_FILTERS = [
  { code: 'F24', prefix: 'scrF24', test: 'close', word: 'close', key: '_rs', hitLabel: 'First Close Above', stateKey: 'f24' },
  { code: 'F25', prefix: 'scrF25', test: 'high',  word: 'high',  key: '_rh', hitLabel: 'First High Above',  stateKey: 'f25' },
];

// Core, pure. `days` = the stock's daily bars (oldest first), `fromTs` = the chosen date (local-midnight timestamp),
// `field` = open | high | low | close (the level to beat, taken from the chosen date's bar), `n` = how many trading days after that
// date to look at, `test` = 'close' or 'high' (which price of those days must beat the level).
// The reference bar is the one dated on the chosen date (the nearest earlier trading day when it is not one); the window is the n
// bars AFTER it (fewer when the data ends sooner - daysChecked says how many were there). It passes when ANY day's `test` price in
// the window is STRICTLY above the level. Same partial-history rule as the % Change filter: a stock with no bar on/before the date
// fails, unless "allow partial" is on, which uses its first bar instead.
// Returns { ok, reason?, level, best, refDate, hitDate, daysChecked, requested }.
function rsPriceAbove(days, fromTs, field, n, allowPartial, test) {
  const fail = reason => ({ ok: false, reason, level: NaN, best: NaN, refDate: '', hitDate: '', daysChecked: 0, requested: n });
  if (isNaN(fromTs)) return fail('No date selected');
  if (!(n >= 1)) return fail('Days must be at least 1');
  if (days.length === 0) return fail('No data');
  let ri = scrBarIdxOnOrBefore(days, fromTs);
  if (ri < 0) {
    if (!allowPartial) return fail('No data on/before the date');
    ri = 0;
  }
  const level = days[ri][field];
  if (!(level > 0)) return fail('Missing price on the selected date');
  const end = Math.min(days.length - 1, ri + Math.floor(n));
  if (end <= ri) return Object.assign(fail('No trading days after ' + days[ri].date), { level, refDate: days[ri].date });
  let best = -Infinity, hit = -1;
  for (let i = ri + 1; i <= end; i++) {
    const p = days[i][test];
    if (p > best) best = p;
    if (hit < 0 && p > level) hit = i;
  }
  return { ok: hit >= 0, level, best, refDate: days[ri].date, hitDate: hit >= 0 ? days[hit].date : '',
           daysChecked: end - ri, requested: n };
}

function rsCloseAbove(days, fromTs, field, n, allowPartial) { return rsPriceAbove(days, fromTs, field, n, allowPartial, 'close'); }
function rsHighAbove(days, fromTs, field, n, allowPartial) { return rsPriceAbove(days, fromTs, field, n, allowPartial, 'high'); }

// The reason line shown in the Failed view
function rsFailReason(r, field, def) {
  if (r.reason && !(r.level > 0 && r.daysChecked > 0)) return `${def.code}: ${r.reason}`;
  const part = r.daysChecked < r.requested ? ` (only ${r.daysChecked} trading day${r.daysChecked === 1 ? '' : 's'} of data after it)` : '';
  return `${def.code}: No ${def.word} above ${RS_FIELD_LABEL[field]} ${fmt2(r.level)} of ${r.refDate} in the next ${r.requested} days - best ${def.word} ${fmt2(r.best)}${part}`;
}

// ── Hooks for the Stock Scanner (js/screener.js; each call guarded by typeof) ───────────────────────────────────────────────

const RS_FILTER_IDS = ['scrF15On', 'scrF16On', 'scrF24On', 'scrF25On'];   // the filters on this tab (F15 and F16 are applied by screener.js; F24 / F25 here)

// F24 and F25 as the scanner should apply them now: { f24:{on, field, ts, n, iso}, f25:{...}, any }
function rsFilterState() {
  const el = id => document.getElementById(id);
  const one = def => {
    const iso = el(def.prefix + 'Date') ? el(def.prefix + 'Date').value : '';
    return { on: !!(el(def.prefix + 'On') && el(def.prefix + 'On').checked),
             field: el(def.prefix + 'Field') ? el(def.prefix + 'Field').value : 'high', iso, ts: scrIsoToTs(iso),
             n: el(def.prefix + 'Days') ? (parseInt(el(def.prefix + 'Days').value) || 0) : 0 };
  };
  const s = {};
  for (const def of RS_PRICE_FILTERS) s[def.stateKey] = one(def);
  s.any = RS_PRICE_FILTERS.some(def => s[def.stateKey].on);
  return s;
}

// Runs the filters that are on for one stock: records what the columns show (the _rs* / _rh* fields) and returns the reasons it
// fails ([] = passes). `state` is rsFilterState()'s result; call it only when state.any.
function rsApplyToStock(stock, days, state, allowPartial) {
  const reasons = [];
  for (const def of RS_PRICE_FILTERS) {
    const f = state[def.stateKey];
    if (!f.on) continue;
    const r = rsPriceAbove(days, f.ts, f.field, f.n, allowPartial, def.test);
    stock[def.key + 'Level'] = r.level;
    stock[def.key + 'Best'] = r.best;
    stock[def.key + 'Hit'] = r.hitDate;
    if (!r.ok) reasons.push(rsFailReason(r, f.field, def));
  }
  return reasons;
}

// How many of this tab's filters are switched on (the scanner adds it to its active-filter count and badge)
function rsActiveCount() {
  return RS_FILTER_IDS.filter(id => { const e = document.getElementById(id); return !!(e && e.checked); }).length;
}

// The tab's own count badge
function rsUpdateBadge() {
  const badge = document.getElementById('scrTabRsCount');
  if (!badge) return;
  const n = rsActiveCount();
  badge.textContent = n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
}

// Extra table columns for each of F24 / F25 that is on: the level it had to beat and the first day it was beaten
function rsColumns() {
  const s = rsFilterState();
  const cols = [];
  for (const def of RS_PRICE_FILTERS) {
    const f = s[def.stateKey];
    if (!f.on) continue;
    const lbl = `${def.code} ${RS_FIELD_LABEL[f.field] || ''} ${f.iso ? f.iso.slice(8) + '/' + f.iso.slice(5, 7) : ''}`.replace(/ +/g, ' ').trim();
    cols.push({ key: def.key + 'Level', label: `${lbl} (level)`, fmt: v => isNaN(v) ? '-' : fmt2(v) });
    cols.push({ key: def.key + 'Hit', label: def.hitLabel, fmt: v => v || '-' });
  }
  return cols;
}

// Default each date to 10 trading days before the latest bar (so the default 5-day window is complete) and limit the pickers to
// the loaded data range. Called once the data has loaded (ui.js, beside initF16Dates).
function rsInitDates() {
  if (!Store.dates || Store.dates.length === 0) return;
  const iso = ds => {
    const t = new Date(parseDate(ds));
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  };
  for (const def of RS_PRICE_FILTERS) {
    const d = document.getElementById(def.prefix + 'Date');
    if (!d) continue;
    d.min = iso(Store.dates[0]);
    d.max = iso(Store.dates[Store.dates.length - 1]);
    d.value = iso(Store.dates[Math.max(0, Store.dates.length - 1 - 10)]);
  }
}

// Reset All: F24 / F25 back to their defaults (F16 is reset by screener.js, which still owns its logic)
function rsReset() {
  const set = (id, prop, v) => { const e = document.getElementById(id); if (e) e[prop] = v; };
  for (const def of RS_PRICE_FILTERS) {
    set(def.prefix + 'On', 'checked', false);
    set(def.prefix + 'Field', 'value', 'high');
    set(def.prefix + 'Days', 'value', '5');
  }
  rsInitDates();
}

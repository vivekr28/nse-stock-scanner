// Stock Scanner popup's "Relative Strength" tab: the % Change filter (F16, moved here from Technicals - its logic is still in
// screener.js, computeDynDateChange) and F24 "Close Above": did the stock CLOSE above the Open / High / Low / Close of a chosen date
// on any of the next n trading days?
// screener.js reaches this file only through the hooks at the bottom (each call guarded by typeof, like the Quarterly Results
// module's), so the scanner holds no F24 controls, fields or columns. Uses scrIsoToTs / scrBarIdxOnOrBefore (screener.js).

const RS_FIELD_LABEL = { open: 'Open', high: 'High', low: 'Low', close: 'Close' };

// Core of F24, pure. `days` = the stock's daily bars (oldest first), `fromTs` = the chosen date (local-midnight timestamp),
// `field` = open | high | low | close, `n` = how many trading days after that date to look at.
// The reference bar is the one dated on the chosen date (the nearest earlier trading day when it is not one); the window is the n
// bars AFTER it (fewer when the data ends sooner - daysChecked says how many were there). It passes when ANY close in the window is
// STRICTLY above the reference bar's field. Same partial-history rule as the % Change filter: a stock with no bar on/before the date
// fails, unless "allow partial" is on, which uses its first bar instead.
// Returns { ok, reason?, level, best, refDate, hitDate, daysChecked, requested }.
function rsCloseAbove(days, fromTs, field, n, allowPartial) {
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
    const c = days[i].close;
    if (c > best) best = c;
    if (hit < 0 && c > level) hit = i;
  }
  return { ok: hit >= 0, level, best, refDate: days[ri].date, hitDate: hit >= 0 ? days[hit].date : '',
           daysChecked: end - ri, requested: n };
}

// The reason line shown in the Failed view
function rsFailReason(r, field) {
  if (r.reason && !(r.level > 0 && r.daysChecked > 0)) return 'F24: ' + r.reason;
  const part = r.daysChecked < r.requested ? ` (only ${r.daysChecked} trading day${r.daysChecked === 1 ? '' : 's'} of data after it)` : '';
  return `F24: No close above ${RS_FIELD_LABEL[field]} ${fmt2(r.level)} of ${r.refDate} in the next ${r.requested} days - best close ${fmt2(r.best)}${part}`;
}

// ── Hooks for the Stock Scanner (js/screener.js; each call guarded by typeof) ───────────────────────────────────────────────

const RS_FILTER_IDS = ['scrF16On', 'scrF24On'];   // the filters on this tab

// F24 as the scanner should apply it now: { f24:{on, field, ts, n, iso}, any }
function rsFilterState() {
  const el = id => document.getElementById(id);
  const on = !!(el('scrF24On') && el('scrF24On').checked);
  const iso = el('scrF24Date') ? el('scrF24Date').value : '';
  const s = {
    f24: { on, field: el('scrF24Field') ? el('scrF24Field').value : 'high', iso, ts: scrIsoToTs(iso),
           n: el('scrF24Days') ? (parseInt(el('scrF24Days').value) || 0) : 0 },
  };
  s.any = on;
  return s;
}

// Runs F24 on one stock: records what the columns show (_rs* fields) and returns the reasons it fails ([] = passes).
// `state` is rsFilterState()'s result; call it only when state.any.
function rsApplyToStock(stock, days, state, allowPartial) {
  const f = state.f24;
  const r = rsCloseAbove(days, f.ts, f.field, f.n, allowPartial);
  stock._rsLevel = r.level;
  stock._rsBest = r.best;
  stock._rsHit = r.hitDate;
  return r.ok ? [] : [rsFailReason(r, f.field)];
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

// Extra table columns while F24 is on: the level it had to beat and the first day a close was above it
function rsColumns() {
  const s = rsFilterState();
  if (!s.any) return [];
  const iso = s.f24.iso;
  const lbl = RS_FIELD_LABEL[s.f24.field] || '';
  return [
    { key: '_rsLevel', label: `${lbl} ${iso ? iso.slice(8) + '/' + iso.slice(5, 7) : ''} (level)`, fmt: v => isNaN(v) ? '-' : fmt2(v) },
    { key: '_rsHit', label: 'First Close Above', fmt: v => v || '-' },
  ];
}

// Default the F24 date to 10 trading days before the latest bar (so the default 5-day window is complete) and limit the picker
// to the loaded data range. Called once the data has loaded (ui.js, beside initF16Dates).
function rsInitDates() {
  const d = document.getElementById('scrF24Date');
  if (!d || !Store.dates || Store.dates.length === 0) return;
  const iso = ds => {
    const t = new Date(parseDate(ds));
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  };
  d.min = iso(Store.dates[0]);
  d.max = iso(Store.dates[Store.dates.length - 1]);
  d.value = iso(Store.dates[Math.max(0, Store.dates.length - 1 - 10)]);
}

// Reset All: F24 back to its defaults (F16 is reset by screener.js, which still owns its logic)
function rsReset() {
  const set = (id, prop, v) => { const e = document.getElementById(id); if (e) e[prop] = v; };
  set('scrF24On', 'checked', false);
  set('scrF24Field', 'value', 'high');
  set('scrF24Days', 'value', '5');
  rsInitDates();
}

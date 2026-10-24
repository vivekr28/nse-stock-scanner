// ═══════════════════════════════════════════════════════════════════════════════
// QUARTERLY RESULTS — the Stock Scanner's "Quarterly Results" filter tab (F20 - F23, F28 - F29, F32 - F33, F40): data, filter logic, scanner hooks
//
// Three files, one feature:  this one (loading the numbers, the filters, the hooks the scanner calls);
//   js/quarterly-chart-table.js (the table over the single-stock chart);  src/quarterly_results.py (the server side).
//
//   F20  QoQ Y Earnings > X %   net profit of the latest declared quarter vs the same quarter a year earlier
//   F21  QoQ Y Sales    > X %   sales (revenue from operations) of that quarter vs the same quarter a year earlier
//   F22  QoQ Y Earnings turnaround   a LOSS in that quarter a year ago, a profit now   (no %, kept apart from F20)
//   F23  QoQ Y Sales turnaround      NO sales in that quarter a year ago, some now     (no %, kept apart from F21)
//   F28 / F29  EPS / Sales YoY% change > X pts   the YoY % of the latest quarter minus the YoY % of the quarter before it (Jun-26 +384% - Mar-26 +3% = 381 pts)
//   F32 / F33  EPS / Sales turnaround            that YoY % was negative a quarter ago and is positive now
//   F40  Results for quarter <picker>            judge every filter on that quarter (a stock with no result for it fails); blank = each stock's own latest quarter
//
// Unless F40 picks a quarter, "latest declared" is per stock (its newest quarter on file), not a global date, so the table shows which
// quarter each row used. The numbers come from /api/quarterly-growth, which the server builds from
// reference-data/QuarterlyResults.csv (created on demand by Download-NSE-Bhavcopy.ps1 -FetchResults) and
// which is keyed by normalized SYMBOL (an ISIN changes at a split/bonus; the results' ISINs would not match).
// Loaded once in the background after the dashboard shows; the filters are inert until it arrives.
// ═══════════════════════════════════════════════════════════════════════════════

// 'missing' until loadQuarterlyResults() runs (it only does when the page was served by nse_server.py, so a dashboard
// opened from a browser cache or a manual file load honestly reports "no results"), then 'loading' -> 'ready'
// (Store.quarterly = { bySymbol, latestQuarter }) or back to 'missing' (no results file yet).
Store.quarterlyState = 'missing';

async function loadQuarterlyResults() {
  Store.quarterlyState = 'loading';
  try {
    const resp = await fetch('/api/quarterly-growth');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    Store.quarterly = { bySymbol: json.bySymbol || {}, latestQuarter: json.latestQuarter || null };
    Store.quarterlyState = 'ready';
  } catch (e) {
    Store.quarterly = null;
    Store.quarterlyState = 'missing';
  }
  qrUpdateStatus();
  if (typeof qctRefresh === 'function') qctRefresh();   // a chart opened before the numbers arrived
  // A saved preset (or ticked filter) may have run before the numbers arrived: run it again now they have
  if (qrActiveCount() > 0 && Store.dashboardVisible && typeof rerunScreenerRespectingMultiPreset === 'function') {
    rerunScreenerRespectingMultiPreset();
  }
}

// '2024-12-31' -> 'Dec-2024'
function qrQuarterLabel(iso) {
  if (!iso) return '-';
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2]) - 1] + '-' + m[1];
}

// '2024-12-31' -> 'Dec-24' (the chart table is a small overlay, so it uses the short form)
function qrQuarterShort(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '');
  return m ? qrQuarterLabel(iso).slice(0, 3) + '-' + m[1].slice(2) : '-';
}

// A stock's record from the results data, or undefined (not loaded, or no results for it)
function qrLookup(symbol) {
  if (!Store.quarterly) return undefined;
  return Store.quarterly.bySymbol[normalizeSymbol(symbol)];
}

// Rs crore for a message: 1,217.0
function qrFmtCr(v) { return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 }); }

// Why a stock fails the Quarterly Results filters that are on - [] when it passes all of them.
//   f20 / f21 = { on, min }  growth: passes only when growth is strictly greater than min (%)
//   f22 / f23 = { on }       turnaround (earnings: a loss a year ago, a profit now; sales: none a year ago, some now)
// Growth is only defined when the result can be compared like for like with a POSITIVE year-ago figure, so a stock that
// was loss-making a year ago fails the growth filters with a reason saying so, rather than a made-up %. That case is what
// the two turnaround filters are for: they are kept separate and never use a percentage.
function qrFailReasons(symbol, f20, f21, f22, f23, quarter) {
  const reasons = [];
  const checks = [];
  if (f20 && f20.on) checks.push({ code: 'F20', name: 'Earnings', kind: 'growth', g: 'eg', cur: 'e', min: f20.min });
  if (f21 && f21.on) checks.push({ code: 'F21', name: 'Sales', kind: 'growth', g: 'sg', cur: 's', min: f21.min });
  if (f22 && f22.on) checks.push({ code: 'F22', name: 'Earnings', kind: 'turnaround', flag: 'et', cur: 'e', prev: 'ep' });
  if (f23 && f23.on) checks.push({ code: 'F23', name: 'Sales', kind: 'turnaround', flag: 'st', cur: 's', prev: 'sp' });
  if (!checks.length) return reasons;

  const stockRec = qrLookup(symbol), rec = qrQuarterRec(stockRec, quarter);
  for (const c of checks) {
    if (Store.quarterlyState === 'loading') { reasons.push(`${c.code}: Quarterly results still loading`); continue; }
    if (!Store.quarterly) { reasons.push(`${c.code}: No quarterly results file (run Download-NSE-Bhavcopy.ps1 -FetchResults)`); continue; }
    if (!stockRec) { reasons.push(`${c.code}: No quarterly results for this stock`); continue; }
    if (!rec) { reasons.push(qrNoQuarterReason(c.code, stockRec, quarter)); continue; }
    const q = qrQuarterLabel(rec.q);
    if (rec.cmp === 'no-prev') { reasons.push(`${c.code}: No ${q} result from the year before to compare with`); continue; }
    if (rec.cmp === 'basis') { reasons.push(`${c.code}: ${q} and last year's quarter are on different bases (standalone vs consolidated)`); continue; }
    if (rec.cmp === 'blank') { reasons.push(`${c.code}: ${q} result numbers unavailable`); continue; }
    if (rec.cmp === 'scale') { reasons.push(`${c.code}: A ${q} or year-ago figure looks mis-scaled in the company's filing (about 100x off the neighbouring quarters) - not compared`); continue; }

    if (c.kind === 'turnaround') {
      if (rec[c.flag]) continue;   // passes
      const cur = rec[c.cur], prev = rec[c.prev];
      if (c.name === 'Earnings') {
        if (prev > 0) reasons.push(`${c.code}: Not an earnings turnaround - ${q} profit was already positive a year ago (${qrFmtCr(prev)} cr)`);
        else if (prev === 0) reasons.push(`${c.code}: Not an earnings turnaround - profit a year ago was zero, not a loss`);
        else reasons.push(`${c.code}: Not an earnings turnaround - still loss-making (${qrFmtCr(cur)} cr vs ${qrFmtCr(prev)} cr a year ago)`);
      } else {
        if (prev > 0) reasons.push(`${c.code}: Not a sales turnaround - ${q} sales were already positive a year ago (${qrFmtCr(prev)} cr)`);
        else reasons.push(`${c.code}: Not a sales turnaround - no sales this quarter either`);
      }
      continue;
    }

    const g = rec[c.g];
    if (g === null || g === undefined) {
      reasons.push(c.name === 'Earnings' && rec[c.cur] > 0
        ? `${c.code}: ${q} profit vs a loss a year ago (turnaround - no % growth; see the turnaround filter)`
        : `${c.code}: Year-ago ${c.name.toLowerCase()} was zero or negative - no % growth`);
    } else if (!(g > c.min)) {
      reasons.push(`${c.code}: ${c.name} ${q} ${g >= 0 ? '+' : ''}${g.toFixed(1)}% YoY, not > ${c.min}%`);
    }
  }
  // a stock compared on the OTHER basis (its year-ago quarter was filed standalone vs consolidated) says so in every reason
  if (rec && rec.ab && reasons.length) return reasons.map(r => r + ` (compared on ${rec.ab === 'S' ? 'Standalone' : 'Consolidated'} results)`);
  return reasons;
}

// The quarter-end n quarters after (negative: before) the quarter holding iso, as 'YYYY-MM-DD' ('2026-06-30', -1 -> '2026-03-31'); '' for no date
function qrQuarterEnd(iso, n) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const t = Number(m[1]) * 12 + Number(m[2]) - 1 + 3 * n;
  const y = Math.floor(t / 12), mo = (t % 12) + 1;
  const pad = v => String(v).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
}

// The quarter before a quarter-end (as a date in that quarter)
function qrPrevQuarter(iso) { return qrQuarterEnd(iso, -1); }

// The record to judge a stock on: its own latest quarter's when no quarter is picked (or the picked one IS its latest), else the one the server
// carries for that earlier quarter (qq); undefined when the stock has no result for the picked quarter. The picker offers the newest quarter on
// file and the 7 before it, which is what qq holds.
function qrQuarterRec(stockRec, quarter) {
  if (!stockRec || !quarter || stockRec.q === quarter) return stockRec;
  return stockRec.qq ? stockRec.qq[quarter] : undefined;
}

// The shared reason for a stock that has results but none for the picked quarter
function qrNoQuarterReason(code, stockRec, quarter) {
  return `${code}: No ${qrQuarterLabel(quarter)} result on file (its latest is ${qrQuarterLabel(stockRec.q)})`;
}

// '+384.0%' / '-33.0%'
function qrFmtPct(v) { return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }

// The two YoY percentages a stock's latest quarter and the quarter before it have, [now, a quarter ago] (each may be null), for the
// earnings (EPS) or the sales; null when the record carries none
function qrYoyPair(rec, earnings) {
  const y = rec && Array.isArray(rec.yy) ? rec.yy : null;
  return y ? (earnings ? [y[0], y[1]] : [y[2], y[3]]) : null;
}

// The "against the previous quarter" filters compare YoY % with YoY %, never raw figures: each quarter's % is its own change on the same
// quarter a year earlier (the numbers the chart table shows). F28 "EPS YoY% change" / F29 "Sales YoY% change": the latest quarter's YoY %
// minus the previous quarter's, in percentage points, strictly above X (Jun-2026 +384% against Mar-2026 +3% = +381 pts). F32 / F33 are the
// turnarounds: the YoY % was NEGATIVE in the previous quarter and is POSITIVE now (Dec-2025 -33%, Mar-2026 +3%). Each stock is judged on its own
// latest declared quarter, or on the quarter F40 picks (the quarter before THAT one is then the previous quarter). A quarter with no YoY % (no result, or a loss / zero year-ago base) cannot be
// compared and fails with that reason. checks: [{ code, earnings, min? }]; returns the reasons ([] = passes).
function qrYoyReasons(symbol, checks, quarter) {
  const reasons = [];
  if (!checks.length) return reasons;
  const stockRec = qrLookup(symbol), rec = qrQuarterRec(stockRec, quarter);
  for (const c of checks) {
    if (Store.quarterlyState === 'loading') { reasons.push(`${c.code}: Quarterly results still loading`); continue; }
    if (!Store.quarterly) { reasons.push(`${c.code}: No quarterly results file (run Download-NSE-Bhavcopy.ps1 -FetchResults)`); continue; }
    if (!stockRec) { reasons.push(`${c.code}: No quarterly results for this stock`); continue; }
    if (!rec) { reasons.push(qrNoQuarterReason(c.code, stockRec, quarter)); continue; }
    const q = qrQuarterLabel(rec.q), pq = qrQuarterLabel(qrPrevQuarter(rec.q)), name = c.earnings ? 'EPS' : 'Sales';
    const pair = qrYoyPair(rec, c.earnings);
    if (!pair) { reasons.push(`${c.code}: No ${pq} result on file to compare ${q} with`); continue; }
    const [now, prev] = pair;
    const missing = (v, label) => v === null || v === undefined
      ? `${c.code}: No ${name} YoY % for ${label} (no result for it or the same quarter a year earlier, or that year-ago figure was a loss / zero)` : '';
    const why = missing(now, q) || missing(prev, pq);
    if (why) { reasons.push(why); continue; }
    if (c.turnaround) {
      if (prev < 0 && now > 0) continue;   // passes
      reasons.push(prev >= 0
        ? `${c.code}: Not ${c.earnings ? 'an' : 'a'} ${name} turnaround - YoY was already ${qrFmtPct(prev)} in ${pq}`
        : `${c.code}: Not ${c.earnings ? 'an' : 'a'} ${name} turnaround - YoY is still ${qrFmtPct(now)} in ${q} (${qrFmtPct(prev)} in ${pq})`);
    } else {
      const d = Math.round((now - prev) * 100) / 100;
      if (!(d > c.min)) reasons.push(`${c.code}: ${name} YoY went from ${qrFmtPct(prev)} (${pq}) to ${qrFmtPct(now)} (${q}): ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts, not > ${c.min} pts`);
    }
  }
  return reasons;
}

// F28 / F29: { on, min }
function qrYoyChangeReasons(symbol, f28, f29, quarter) {
  const checks = [];
  if (f28 && f28.on) checks.push({ code: 'F28', earnings: true, min: f28.min });
  if (f29 && f29.on) checks.push({ code: 'F29', earnings: false, min: f29.min });
  return qrYoyReasons(symbol, checks, quarter);
}

// F32 / F33: { on }
function qrYoyTurnaroundReasons(symbol, f32, f33, quarter) {
  const checks = [];
  if (f32 && f32.on) checks.push({ code: 'F32', earnings: true, turnaround: true });
  if (f33 && f33.on) checks.push({ code: 'F33', earnings: false, turnaround: true });
  return qrYoyReasons(symbol, checks, quarter);
}

// F40 "Results for quarter": a quarter picked in the dropdown (blank = none). With one picked, EVERY Quarterly Results filter judges each stock on that
// quarter instead of the stock's own latest, and a stock with no result for it fails ("No Jun-2026 result on file (its latest is Mar-2026)"); picked
// alone it keeps only the stocks that have a result for that quarter. Blank, each filter uses the stock's last reported quarter. f40 = { on, quarter }.
function qrQuarterReasons(symbol, f40) {
  if (!f40 || !f40.on) return [];
  if (Store.quarterlyState === 'loading') return ['F40: Quarterly results still loading'];
  if (!Store.quarterly) return ['F40: No quarterly results file (run Download-NSE-Bhavcopy.ps1 -FetchResults)'];
  const stockRec = qrLookup(symbol);
  if (!stockRec) return ['F40: No quarterly results for this stock'];
  return qrQuarterRec(stockRec, f40.quarter) ? [] : [qrNoQuarterReason('F40', stockRec, f40.quarter)];
}

// ── Hooks for the Stock Scanner (js/screener.js calls these, each guarded by typeof - the same way it calls the As of Date
// module's) - so the scanner itself knows nothing about the filters' controls, fields or columns. ──────────────────

const QR_FILTER_IDS = ['scrF20On', 'scrF21On', 'scrF22On', 'scrF23On', 'scrF28On', 'scrF29On', 'scrF32On', 'scrF33On'];   // plus the F40 quarter picker, which qrActiveCount counts too

// The filters as the scanner should apply them now: { f20:{on,min}, f21:{on,min}, f22:{on}, f23:{on}, f28 / f29:{on,min}, f32 / f33:{on}, f40:{on,quarter}, any }
// F40's picker: { on, quarter } - quarter is the picked quarter-end ('2026-06-30') or '' when none is picked
function qrPickedQuarter() {
  const el = document.getElementById('scrF40Quarter');
  const quarter = el ? String(el.value || '') : '';
  return { on: !!quarter, quarter };
}

function qrFilterState() {
  const on = id => { const el = document.getElementById(id); return !!(el && el.checked); };
  const num = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) || 0 : 0; };
  const s = {
    f20: { on: on('scrF20On'), min: num('scrF20Val') },
    f21: { on: on('scrF21On'), min: num('scrF21Val') },
    f22: { on: on('scrF22On') },
    f23: { on: on('scrF23On') },
    f28: { on: on('scrF28On'), min: num('scrF28Val') },
    f29: { on: on('scrF29On'), min: num('scrF29Val') },
    f32: { on: on('scrF32On') },
    f33: { on: on('scrF33On') },
    f40: qrPickedQuarter(),
  };
  s.any = s.f20.on || s.f21.on || s.f22.on || s.f23.on || s.f28.on || s.f29.on || s.f32.on || s.f33.on || s.f40.on;
  return s;
}

// Runs the filters on one stock: records what the table columns show on the stock (the _qr* fields) and returns the reasons it
// fails ([] = passes). `state` is qrFilterState()'s result; call it only when state.any.
function qrApplyToStock(stock, state) {
  const rec = qrQuarterRec(qrLookup(stock.symbol), state.f40 && state.f40.quarter);   // the stock's record for the picked quarter, else its latest
  const num = v => (v === null || v === undefined ? NaN : v);
  stock._qrQtr = rec ? rec.q : '';
  stock._qrBasis = rec && rec.ab ? rec.ab : '';   // 'S' / 'C' when compared on the other basis, else ''
  stock._qrEarn = rec ? num(rec.eg) : NaN;
  stock._qrSales = rec ? num(rec.sg) : NaN;
  stock._qrProfitNow = rec ? num(rec.e) : NaN;   // Rs crore, for the turnaround columns
  stock._qrProfitPrev = rec ? num(rec.ep) : NaN;
  stock._qrSalesNow = rec ? num(rec.s) : NaN;
  stock._qrSalesPrev = rec ? num(rec.sp) : NaN;
  const yoy = (earnings) => {                                       // the YoY % now and a quarter ago, and the change between them (percentage points)
    const p = qrYoyPair(rec, earnings), has = v => v !== null && v !== undefined;
    return p ? { now: num(p[0]), prev: num(p[1]), change: has(p[0]) && has(p[1]) ? Math.round((p[0] - p[1]) * 100) / 100 : NaN } : { now: NaN, prev: NaN, change: NaN };
  };
  const ye = yoy(true), ys = yoy(false);
  stock._qrYyNowE = ye.now; stock._qrYyPrevE = ye.prev; stock._qrAccE = ye.change;
  stock._qrYyNowS = ys.now; stock._qrYyPrevS = ys.prev; stock._qrAccS = ys.change;
  const quarter = state.f40 && state.f40.quarter;
  return qrQuarterReasons(stock.symbol, state.f40)
    .concat(qrFailReasons(stock.symbol, state.f20, state.f21, state.f22, state.f23, quarter))
    .concat(qrYoyChangeReasons(stock.symbol, state.f28, state.f29, quarter))
    .concat(qrYoyTurnaroundReasons(stock.symbol, state.f32, state.f33, quarter));
}

// How many of the Quarterly Results filters are switched on (the scanner adds it to its active-filter count and badge)
function qrActiveCount() {
  return QR_FILTER_IDS.filter(id => { const el = document.getElementById(id); return !!(el && el.checked); }).length + (qrPickedQuarter().on ? 1 : 0);
}

// The tab's own count badge
function qrUpdateBadge() {
  const badge = document.getElementById('scrTabQtrCount');
  if (!badge) return;
  const n = qrActiveCount();
  badge.textContent = n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
}

// Extra table columns for the filters that are on ([] when none): the quarter used, the YoY growth %s, for the previous-quarter filters the
// YoY % a quarter ago -> now (and the change in points), and for the year-ago turnaround filters the two amounts (Rs crore, year ago -> now;
// those columns sort by this quarter's figure)
function qrColumns() {
  const s = qrFilterState();
  if (!s.any) return [];
  const cols = [{ key: '_qrQtr', label: 'Result Qtr', fmt: (v, row) => qrQuarterLabel(v) + (row && row._qrBasis ? ` (${row._qrBasis})` : '') }];   // (S) / (C): compared on the other basis
  const growthCol = (key, label) => ({ key, label, fmt: v => isNaN(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%', cls: v => isNaN(v) ? '' : (v >= 0 ? 'positive' : 'negative') });
  if (s.f20.on) cols.push(growthCol('_qrEarn', 'Earnings YoY%'));
  if (s.f21.on) cols.push(growthCol('_qrSales', 'Sales YoY%'));
  const fromTo = (nowKey, prevKey, label) => ({ key: nowKey, label, fmt: (v, row) => {
    const prev = row[prevKey];
    return isNaN(v) || isNaN(prev) ? '-' : `${qrFmtCr(prev)} → ${qrFmtCr(v)}`;
  }, cls: v => isNaN(v) ? '' : (v >= 0 ? 'positive' : 'negative') });
  const yoyPair = (nowKey, prevKey, label) => ({ key: nowKey, label, fmt: (v, row) => {   // sorts by the latest quarter's YoY %
    const prev = row[prevKey];
    return isNaN(v) || isNaN(prev) ? '-' : `${qrFmtPct(prev)} → ${qrFmtPct(v)}`;
  }, cls: v => isNaN(v) ? '' : (v >= 0 ? 'positive' : 'negative') });
  const pts = (key, label) => ({ key, label, fmt: v => isNaN(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(1) + ' pts', cls: v => isNaN(v) ? '' : (v >= 0 ? 'positive' : 'negative') });
  if (s.f28.on || s.f32.on) cols.push(yoyPair('_qrYyNowE', '_qrYyPrevE', 'EPS YoY% (prev qtr → now)'));   // one column however many of the filters on that figure are on
  if (s.f28.on) cols.push(pts('_qrAccE', 'EPS YoY% change'));
  if (s.f29.on || s.f33.on) cols.push(yoyPair('_qrYyNowS', '_qrYyPrevS', 'Sales YoY% (prev qtr → now)'));
  if (s.f29.on) cols.push(pts('_qrAccS', 'Sales YoY% change'));
  if (s.f22.on) cols.push(fromTo('_qrProfitNow', '_qrProfitPrev', 'Profit Cr (yr ago → now)'));
  if (s.f23.on) cols.push(fromTo('_qrSalesNow', '_qrSalesPrev', 'Sales Cr (yr ago → now)'));
  return cols;
}

// Reset All: the Quarterly Results filters back to their defaults
function qrReset() {
  const set = (id, prop, v) => { const el = document.getElementById(id); if (el) el[prop] = v; };
  set('scrF20On', 'checked', false); set('scrF20Val', 'value', '20');
  set('scrF21On', 'checked', false); set('scrF21Val', 'value', '10');
  set('scrF22On', 'checked', false);
  set('scrF23On', 'checked', false);
  set('scrF28On', 'checked', false); set('scrF28Val', 'value', '0');
  set('scrF29On', 'checked', false); set('scrF29Val', 'value', '0');
  set('scrF32On', 'checked', false);
  set('scrF33On', 'checked', false);
  set('scrF40Quarter', 'value', '');
}

// The F40 picker's choices: "each stock's latest" (blank) and the newest quarter on file with the 7 before it, newest first (blank until the data is loaded).
// A picked quarter that is still in the list stays picked when the list is rebuilt.
function qrUpdateQuarterOptions() {
  const el = document.getElementById('scrF40Quarter');
  if (!el) return;
  const kept = String(el.value || '');
  const newest = Store.quarterly && Store.quarterly.latestQuarter;
  const quarters = newest ? Array.from({ length: 8 }, (_, i) => qrQuarterEnd(newest, -i)) : [];
  el.innerHTML = '<option value="">Each stock\'s latest quarter</option>' + quarters.map(q => `<option value="${q}">${qrQuarterLabel(q)}</option>`).join('');
  el.value = quarters.includes(kept) ? kept : '';
}

// The tab's one-line status: what is loaded and how fresh it is
function qrUpdateStatus() {
  qrUpdateQuarterOptions();
  const el = document.getElementById('scrQtrStatus');
  if (!el) return;
  if (Store.quarterlyState === 'loading') {
    el.textContent = 'Loading quarterly results...';
  } else if (!Store.quarterly) {
    el.innerHTML = 'No quarterly results file yet. Create it with <code>Download-NSE-Bhavcopy.ps1 -FetchResults</code>, then reload this page.';
  } else {
    const n = Object.keys(Store.quarterly.bySymbol).length;
    el.textContent = `Results for ${n} stocks; newest quarter on file: ${qrQuarterLabel(Store.quarterly.latestQuarter)}. ` +
      `Each stock uses its own latest declared quarter (shown in the Result Qtr column).`;
  }
}

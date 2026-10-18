// ═══════════════════════════════════════════════════════════════════════════════
// QUARTERLY RESULTS — the Stock Scanner's "Quarterly Results" filter tab (F20 - F23): data, filter logic, scanner hooks
//
// Three files, one feature:  this one (loading the numbers, the filters, the hooks the scanner calls);
//   js/quarterly-chart-table.js (the table over the single-stock chart);  src/quarterly_results.py (the server side).
//
//   F20  QoQ Y Earnings > X %   net profit of the latest declared quarter vs the same quarter a year earlier
//   F21  QoQ Y Sales    > X %   sales (revenue from operations) of that quarter vs the same quarter a year earlier
//   F22  QoQ Y Earnings turnaround   a LOSS in that quarter a year ago, a profit now   (no %, kept apart from F20)
//   F23  QoQ Y Sales turnaround      NO sales in that quarter a year ago, some now     (no %, kept apart from F21)
//
// "Latest declared" is per stock (its newest quarter on file), not a global date, so the table shows which
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
function qrFailReasons(symbol, f20, f21, f22, f23, f26, f27) {
  const reasons = [];
  const checks = [];
  if (f20 && f20.on) checks.push({ code: 'F20', name: 'Earnings', kind: 'growth', g: 'eg', cur: 'e', min: f20.min });
  if (f21 && f21.on) checks.push({ code: 'F21', name: 'Sales', kind: 'growth', g: 'sg', cur: 's', min: f21.min });
  if (f22 && f22.on) checks.push({ code: 'F22', name: 'Earnings', kind: 'turnaround', flag: 'et', cur: 'e', prev: 'ep' });
  if (f23 && f23.on) checks.push({ code: 'F23', name: 'Sales', kind: 'turnaround', flag: 'st', cur: 's', prev: 'sp' });
  // F26 / F27: the same growth tests as F20 / F21, but only for stocks that have declared the NEWEST quarter on file
  if (f26 && f26.on) checks.push({ code: 'F26', name: 'Earnings', kind: 'growth', g: 'eg', cur: 'e', min: f26.min, latest: true });
  if (f27 && f27.on) checks.push({ code: 'F27', name: 'Sales', kind: 'growth', g: 'sg', cur: 's', min: f27.min, latest: true });
  if (!checks.length) return reasons;

  const rec = qrLookup(symbol);
  for (const c of checks) {
    if (Store.quarterlyState === 'loading') { reasons.push(`${c.code}: Quarterly results still loading`); continue; }
    if (!Store.quarterly) { reasons.push(`${c.code}: No quarterly results file (run Download-NSE-Bhavcopy.ps1 -FetchResults)`); continue; }
    if (!rec) { reasons.push(`${c.code}: No quarterly results for this stock`); continue; }
    const q = qrQuarterLabel(rec.q);
    if (c.latest && rec.q !== Store.quarterly.latestQuarter) { reasons.push(`${c.code}: No ${qrQuarterLabel(Store.quarterly.latestQuarter)} result yet (its latest is ${q})`); continue; }
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

// F28 "QoQ Earnings" and F29 "QoQ Sales": growth of the stock's latest declared quarter against the quarter BEFORE it (a sequential step,
// not the year-ago comparison F20 / F21 make), strictly above X %. F30 / F31 are the same two tests restricted to stocks that have declared
// the NEWEST quarter any company has declared (like F26 / F27 are to F20 / F21): a stock whose latest result is an older quarter is left
// out. Each is { on, min }. Returns the reasons a stock fails the ones that are on ([] = passes).
// A stock whose previous quarter is missing, or had zero / negative profit (or no sales), has no sequential % and fails with that reason.
function qrQoqReasons(symbol, f28, f29, f30, f31) {
  const checks = [];
  if (f28 && f28.on) checks.push({ code: 'F28', name: 'Earnings', key: 'qe', min: f28.min, missing: 'the previous quarter is missing, zero or a loss' });
  if (f29 && f29.on) checks.push({ code: 'F29', name: 'Sales', key: 'qs', min: f29.min, missing: 'the previous quarter is missing or had no sales' });
  if (f30 && f30.on) checks.push({ code: 'F30', name: 'Earnings', key: 'qe', min: f30.min, missing: 'the previous quarter is missing, zero or a loss', latest: true });
  if (f31 && f31.on) checks.push({ code: 'F31', name: 'Sales', key: 'qs', min: f31.min, missing: 'the previous quarter is missing or had no sales', latest: true });
  const reasons = [];
  if (!checks.length) return reasons;
  const rec = qrLookup(symbol);
  for (const c of checks) {
    if (Store.quarterlyState === 'loading') { reasons.push(`${c.code}: Quarterly results still loading`); continue; }
    if (!Store.quarterly) { reasons.push(`${c.code}: No quarterly results file (run Download-NSE-Bhavcopy.ps1 -FetchResults)`); continue; }
    if (!rec) { reasons.push(`${c.code}: No quarterly results for this stock`); continue; }
    const q = qrQuarterLabel(rec.q), v = rec[c.key];
    if (c.latest && rec.q !== Store.quarterly.latestQuarter) { reasons.push(`${c.code}: No ${qrQuarterLabel(Store.quarterly.latestQuarter)} result yet (its latest is ${q})`); continue; }
    if (v === undefined || v === null) reasons.push(`${c.code}: No ${q} ${c.name.toLowerCase()} growth vs the previous quarter (${c.missing})`);
    else if (!(v > c.min)) reasons.push(`${c.code}: ${c.name} ${q} ${v >= 0 ? '+' : ''}${v.toFixed(1)}% vs the previous quarter, not > ${c.min}%`);
  }
  return reasons;
}

// F32 "QoQ Earnings turnaround" (a LOSS in the previous quarter, a profit now) and F33 "QoQ Sales turnaround" (NO sales in the previous quarter,
// some now): the sequential twins of F22 / F23, kept apart from F28 / F29 because a growth % needs a positive base. No % is used. They judge
// the stock's own latest declared quarter against the quarter before it; the server's qet / qst flags decide, qp carries the amounts for the
// reasons. A stock with no previous quarter on file, or none on a basis both quarters hold, fails with that reason.
function qrQoqTurnaroundReasons(symbol, f32, f33) {
  const checks = [];
  if (f32 && f32.on) checks.push({ code: 'F32', earnings: true });
  if (f33 && f33.on) checks.push({ code: 'F33', earnings: false });
  const reasons = [];
  if (!checks.length) return reasons;
  const rec = qrLookup(symbol);
  for (const c of checks) {
    if (Store.quarterlyState === 'loading') { reasons.push(`${c.code}: Quarterly results still loading`); continue; }
    if (!Store.quarterly) { reasons.push(`${c.code}: No quarterly results file (run Download-NSE-Bhavcopy.ps1 -FetchResults)`); continue; }
    if (!rec) { reasons.push(`${c.code}: No quarterly results for this stock`); continue; }
    const q = qrQuarterLabel(rec.q), p = rec.qp;
    if (!Array.isArray(p)) {
      reasons.push(`${c.code}: ` + (p === null ? `${q} and the previous quarter are on different bases (standalone vs consolidated)` : `No quarter before ${q} on file to compare with`));
      continue;
    }
    if (c.earnings) {
      if (rec.qet) continue;                                               // passes
      const prev = p[0], cur = p[2];
      if (prev > 0) reasons.push(`F32: Not an earnings turnaround - ${q} profit was already positive in the previous quarter (${qrFmtCr(prev)} cr)`);
      else if (prev === 0) reasons.push('F32: Not an earnings turnaround - profit in the previous quarter was zero, not a loss');
      else reasons.push(`F32: Not an earnings turnaround - still loss-making (${qrFmtCr(cur)} cr vs ${qrFmtCr(prev)} cr the quarter before)`);
    } else {
      if (rec.qst) continue;
      const prev = p[1];
      if (prev > 0) reasons.push(`F33: Not a sales turnaround - ${q} sales were already positive in the previous quarter (${qrFmtCr(prev)} cr)`);
      else reasons.push('F33: Not a sales turnaround - no sales this quarter either');
    }
  }
  return reasons;
}

// ── Hooks for the Stock Scanner (js/screener.js calls these, each guarded by typeof - the same way it calls the As of Date
// module's) - so the scanner itself knows nothing about the four filters' controls, fields or columns. ──────────────────

const QR_FILTER_IDS = ['scrF20On', 'scrF21On', 'scrF22On', 'scrF23On', 'scrF26On', 'scrF27On', 'scrF28On', 'scrF29On', 'scrF30On', 'scrF31On', 'scrF32On', 'scrF33On'];

// The four filters as the scanner should apply them now: { f20:{on,min}, f21:{on,min}, f22:{on}, f23:{on}, any }
function qrFilterState() {
  const on = id => { const el = document.getElementById(id); return !!(el && el.checked); };
  const num = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) || 0 : 0; };
  const s = {
    f20: { on: on('scrF20On'), min: num('scrF20Val') },
    f21: { on: on('scrF21On'), min: num('scrF21Val') },
    f22: { on: on('scrF22On') },
    f23: { on: on('scrF23On') },
    f26: { on: on('scrF26On'), min: num('scrF26Val') },
    f27: { on: on('scrF27On'), min: num('scrF27Val') },
    f28: { on: on('scrF28On'), min: num('scrF28Val') },
    f29: { on: on('scrF29On'), min: num('scrF29Val') },
    f30: { on: on('scrF30On'), min: num('scrF30Val') },
    f31: { on: on('scrF31On'), min: num('scrF31Val') },
    f32: { on: on('scrF32On') },
    f33: { on: on('scrF33On') },
  };
  s.any = s.f20.on || s.f21.on || s.f22.on || s.f23.on || s.f26.on || s.f27.on || s.f28.on || s.f29.on || s.f30.on || s.f31.on || s.f32.on || s.f33.on;
  return s;
}

// Runs the filters on one stock: records what the table columns show on the stock (the _qr* fields) and returns the reasons it
// fails ([] = passes). `state` is qrFilterState()'s result; call it only when state.any.
function qrApplyToStock(stock, state) {
  const rec = qrLookup(stock.symbol);
  const num = v => (v === null || v === undefined ? NaN : v);
  stock._qrQtr = rec ? rec.q : '';
  stock._qrBasis = rec && rec.ab ? rec.ab : '';   // 'S' / 'C' when compared on the other basis, else ''
  stock._qrEarn = rec ? num(rec.eg) : NaN;
  stock._qrSales = rec ? num(rec.sg) : NaN;
  stock._qrProfitNow = rec ? num(rec.e) : NaN;   // Rs crore, for the turnaround columns
  stock._qrProfitPrev = rec ? num(rec.ep) : NaN;
  stock._qrSalesNow = rec ? num(rec.s) : NaN;
  stock._qrSalesPrev = rec ? num(rec.sp) : NaN;
  stock._qrQoqE = rec ? num(rec.qe) : NaN;                         // profit vs the previous quarter, %
  stock._qrQoqS = rec ? num(rec.qs) : NaN;                         // sales vs the previous quarter, %
  const qp = rec && Array.isArray(rec.qp) ? rec.qp : null;         // [previous profit, previous sales, profit now, sales now], Rs crore
  stock._qrQPrevE = qp ? qp[0] : NaN; stock._qrQPrevS = qp ? qp[1] : NaN;
  stock._qrQNowE = qp ? qp[2] : NaN; stock._qrQNowS = qp ? qp[3] : NaN;
  return qrFailReasons(stock.symbol, state.f20, state.f21, state.f22, state.f23, state.f26, state.f27)
    .concat(qrQoqReasons(stock.symbol, state.f28, state.f29, state.f30, state.f31))
    .concat(qrQoqTurnaroundReasons(stock.symbol, state.f32, state.f33));
}

// How many of the four filters are switched on (the scanner adds it to its active-filter count and badge)
function qrActiveCount() {
  return QR_FILTER_IDS.filter(id => { const el = document.getElementById(id); return !!(el && el.checked); }).length;
}

// The tab's own count badge
function qrUpdateBadge() {
  const badge = document.getElementById('scrTabQtrCount');
  if (!badge) return;
  const n = qrActiveCount();
  badge.textContent = n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
}

// Extra table columns for the filters that are on ([] when none): the quarter used, the two growth %s, and for the turnaround
// filters the two amounts (Rs crore, year ago -> now; those columns sort by this quarter's figure)
function qrColumns() {
  const s = qrFilterState();
  if (!s.any) return [];
  const cols = [{ key: '_qrQtr', label: 'Result Qtr', fmt: (v, row) => qrQuarterLabel(v) + (row && row._qrBasis ? ` (${row._qrBasis})` : '') }];   // (S) / (C): compared on the other basis
  const growthCol = (key, label) => ({ key, label, fmt: v => isNaN(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%', cls: v => isNaN(v) ? '' : (v >= 0 ? 'positive' : 'negative') });
  if (s.f20.on || s.f26.on) cols.push(growthCol('_qrEarn', 'Earnings YoY%'));     // one column however many of the earnings filters are on
  if (s.f21.on || s.f27.on) cols.push(growthCol('_qrSales', 'Sales YoY%'));
  const fromTo = (nowKey, prevKey, label) => ({ key: nowKey, label, fmt: (v, row) => {
    const prev = row[prevKey];
    return isNaN(v) || isNaN(prev) ? '-' : `${qrFmtCr(prev)} → ${qrFmtCr(v)}`;
  }, cls: v => isNaN(v) ? '' : (v >= 0 ? 'positive' : 'negative') });
  if (s.f28.on || s.f30.on) cols.push(growthCol('_qrQoqE', 'QoQ Earnings%'));     // one column however many of the two earnings / sales filters are on
  if (s.f29.on || s.f31.on) cols.push(growthCol('_qrQoqS', 'QoQ Sales%'));
  if (s.f22.on) cols.push(fromTo('_qrProfitNow', '_qrProfitPrev', 'Profit Cr (yr ago → now)'));
  if (s.f23.on) cols.push(fromTo('_qrSalesNow', '_qrSalesPrev', 'Sales Cr (yr ago → now)'));
  if (s.f32.on) cols.push(fromTo('_qrQNowE', '_qrQPrevE', 'Profit Cr (prev qtr → now)'));
  if (s.f33.on) cols.push(fromTo('_qrQNowS', '_qrQPrevS', 'Sales Cr (prev qtr → now)'));
  return cols;
}

// Reset All: the four filters back to their defaults
function qrReset() {
  const set = (id, prop, v) => { const el = document.getElementById(id); if (el) el[prop] = v; };
  set('scrF20On', 'checked', false); set('scrF20Val', 'value', '20');
  set('scrF21On', 'checked', false); set('scrF21Val', 'value', '10');
  set('scrF22On', 'checked', false);
  set('scrF23On', 'checked', false);
  set('scrF26On', 'checked', false); set('scrF26Val', 'value', '20');
  set('scrF27On', 'checked', false); set('scrF27Val', 'value', '10');
  set('scrF28On', 'checked', false); set('scrF28Val', 'value', '0');
  set('scrF29On', 'checked', false); set('scrF29Val', 'value', '0');
  set('scrF30On', 'checked', false); set('scrF30Val', 'value', '0');
  set('scrF31On', 'checked', false); set('scrF31Val', 'value', '0');
  set('scrF32On', 'checked', false);
  set('scrF33On', 'checked', false);
}

// The quarter name in the F26 / F27 labels: the newest quarter any stock has declared (blank until the data is loaded)
function qrUpdateLatestLabels() {
  const text = Store.quarterly && Store.quarterly.latestQuarter ? `(${qrQuarterLabel(Store.quarterly.latestQuarter)})` : '';
  for (const id of ['scrF26Q', 'scrF27Q', 'scrF30Q', 'scrF31Q']) { const el = document.getElementById(id); if (el) el.textContent = text; }
}

// The tab's one-line status: what is loaded and how fresh it is
function qrUpdateStatus() {
  qrUpdateLatestLabels();
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

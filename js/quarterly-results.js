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

// ── Hooks for the Stock Scanner (js/screener.js calls these, each guarded by typeof - the same way it calls the As of Date
// module's) - so the scanner itself knows nothing about the four filters' controls, fields or columns. ──────────────────

const QR_FILTER_IDS = ['scrF20On', 'scrF21On', 'scrF22On', 'scrF23On', 'scrF26On', 'scrF27On'];

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
  };
  s.any = s.f20.on || s.f21.on || s.f22.on || s.f23.on || s.f26.on || s.f27.on;
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
  return qrFailReasons(stock.symbol, state.f20, state.f21, state.f22, state.f23, state.f26, state.f27);
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
  if (s.f22.on) cols.push(fromTo('_qrProfitNow', '_qrProfitPrev', 'Profit Cr (yr ago → now)'));
  if (s.f23.on) cols.push(fromTo('_qrSalesNow', '_qrSalesPrev', 'Sales Cr (yr ago → now)'));
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
}

// The quarter name in the F26 / F27 labels: the newest quarter any stock has declared (blank until the data is loaded)
function qrUpdateLatestLabels() {
  const text = Store.quarterly && Store.quarterly.latestQuarter ? `(${qrQuarterLabel(Store.quarterly.latestQuarter)})` : '';
  for (const id of ['scrF26Q', 'scrF27Q']) { const el = document.getElementById(id); if (el) el.textContent = text; }
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

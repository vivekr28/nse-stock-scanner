// ═══════════════════════════════════════════════════════════════════════════════
// QUARTERLY CHART TABLE — the table over the single-stock chart (bottom-right corner of the CANDLE pane)
//
// The stock's last 10 quarters, newest first: EPS and sales with their change against the same quarter a year earlier,
// then its price band. Self-contained: it reads Store (quarterly results, corporate actions) and the chart's DOM, and the
// chart popup (js/industry-charts.js) only calls the hooks at the bottom of this file, guarded by typeof:
//   qctShow(visible)   show / hide the table (single-stock mode only)
//   qctRender(stock)   build the table for this stock and place it
//   qctRefresh()       rebuild it for the same stock (the results arrived after the chart was opened)
//   qctWatch(el)       once the chart exists: place the table, and re-place it whenever the chart or its candle pane resizes
//   qctRelease()       stop watching (popup closed)
// DOM contract with the popup: #icSingleFooter (the table's box), #icIndustryChartWrap (its positioning parent) and
// #icIndustryChartContainer (the chart). Data and number formatting come from js/quarterly-results.js (qrLookup etc.).
// ═══════════════════════════════════════════════════════════════════════════════

// ── The single-stock chart's table (bottom-right corner): the last 10 quarters, newest first ───────────────────────
//   Quarterly | EPS | %Chg | Sales (Cr) | %Chg      - each %Chg is against the same quarter a year earlier
// from the `h` list of /api/quarterly-growth: [quarter-end, sales Rs cr, sales growth %, EPS, EPS growth %, cmp, EPS turnaround 1/0],
// oldest first (the table shows it reversed). A quarter whose year-ago quarter was filed on the OTHER basis (standalone vs
// consolidated) but was compared on a basis both hold carries three more items, ['S'|'C', sales, sales a year ago] on that
// basis: its two %Chg cells are marked (S) / (C) with a hover saying so (the sales and EPS shown stay the quarter's own). EPS is as filed - NOT restated for splits/bonuses - so a quarter pair that
// straddles one is marked with * (qctEpsSplitNote).

// "No Band%" is how the server stores a stock with no price band (it appends % to every band); show it as "No Band"
function qctBandLabel(bandPct) {
  const b = String(bandPct || '').trim();
  if (!b) return '-';
  return /^no band/i.test(b) ? 'No Band' : b;
}

const QCT_CMP_NOTE = {
  'no-prev': 'No result for the same quarter a year earlier to compare with',
  'basis': 'Standalone vs consolidated differs from the year-ago quarter - not comparable',
  'blank': 'The result numbers are unavailable',
  'scale': "A figure looks mis-scaled in the company's filing - not compared",
  'none': 'No result on file for this quarter',
};

// Sales (Rs crore) with one decimal and Indian digit grouping: 58,539.1
function qctFmtSales(v) {
  return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// A %Chg cell: whole percent with its sign (+30%, -34%), coloured; or why there is no number
function qctPctCell(growth, cmp, extra) {
  if (cmp === 'none' || cmp === 'no-prev' || cmp === 'basis' || cmp === 'scale' || cmp === 'blank') return { text: '-', cls: '', title: QCT_CMP_NOTE[cmp] };
  if (growth === null || growth === undefined) return { text: 'n/a', cls: '', title: (extra && extra.naTitle) || 'No % change: the same quarter a year ago was a loss or zero' };
  const r = Math.round(growth);
  return { text: r === 0 ? '0%' : (r > 0 ? '+' : '') + r.toLocaleString('en-IN') + '%', cls: growth >= 0 ? 'positive' : 'negative', title: '' };
}

// '28-Oct-2024' -> time in ms (or NaN)
function qctParseExDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  const mon = m ? ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase()) : -1;
  return m && mon >= 0 ? Date.UTC(Number(m[3]), mon, Number(m[1])) : NaN;
}

// A split/bonus whose ex-date falls between the end of the year-ago quarter and the filing of this one (results come out up
// to ~45 days after a quarter ends): EPS before it is on the old share count and after it on the new, so the as-filed % may
// not be like for like. Deliberately a little wide (a company that reported the year-ago quarter AFTER the ex-date was
// compared on one share count and is flagged anyway) - better a needless warning than a silent wrong percentage.
// Returns a hover sentence, or ''. Uses the corporate actions the server applied to prices (Store.adjustedCorpActions).
function qctEpsSplitNote(stock, quarterIso) {
  if (!stock || !quarterIso || !Array.isArray(Store.adjustedCorpActions)) return '';
  const end = Date.parse(quarterIso + 'T00:00:00Z');
  if (isNaN(end)) return '';
  const DAY = 86400000;
  const hi = end + 45 * DAY, lo = end - 365 * DAY;
  for (const a of Store.adjustedCorpActions) {
    if (a.kind !== 'split-bonus' || (a.isin !== stock.isin && a.symbol !== stock.symbol)) continue;
    const ex = qctParseExDate(a.exDate);
    if (!isNaN(ex) && ex > lo && ex <= hi) return `EPS is as filed and not adjusted for the ${a.detail} (ex-date ${a.exDate}), so this change may not be like for like`;
  }
  return '';
}

// HTML of the table for a stock (the object from Store.latestBySymbol / the results list): a header, one row per quarter
// (up to 10, latest at the top) and the stock's current price band. Pure apart from reading Store.
function qctTableHtml(stock) {
  const cell = c => `<td class="${c.cls}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.text)}${c.mark ? '<span class="ic-qtr-mark">*</span>' : ''}${c.basis ? `<span class="ic-qtr-basis">(${escapeHtml(c.basis)})</span>` : ''}</td>`;
  const band = `<tr><th title="Current price band (circuit limit)">Band</th><td colspan="4" class="ic-qtr-band">${escapeHtml(qctBandLabel(stock && stock.bandPct))}</td></tr>`;
  const rec = stock ? qrLookup(stock.symbol) : undefined;
  let body;
  if (Store.quarterlyState === 'loading') {
    body = '<tr><td colspan="5" class="ic-qtr-note">Loading quarterly results...</td></tr>';
  } else if (!Store.quarterly) {
    body = '<tr><td colspan="5" class="ic-qtr-note">No quarterly results file yet (Download-NSE-Bhavcopy.ps1 -FetchResults)</td></tr>';
  } else if (!rec || !rec.h) {
    body = '<tr><td colspan="5" class="ic-qtr-note">No quarterly results for this stock</td></tr>';
  } else {
    const head = '<tr><th>Quarterly</th><th>EPS</th><th>%Chg</th><th>Sales (Cr)</th><th>%Chg</th></tr>';
    const rows = rec.h.map((h, i) => ({ h, i })).reverse().filter(({ h }) => h[5] !== 'none' || h[1] !== null).map(({ h, i }) => {
      const [q, sales, salesG, eps, epsG, cmp, epsT, ab, abSales, abSalesPrev] = h;
      const epsCell = { text: eps === null || eps === undefined ? '-' : eps.toFixed(2), cls: '', title: eps === null || eps === undefined ? 'No EPS reported in this filing' : '' };
      const epsPct = qctPctCell(epsG, cmp === 'scale' || cmp === 'blank' ? 'ok' : cmp, { naTitle: 'No % change: the same quarter a year ago had zero EPS' });
      // the year-ago EPS was a loss: just the plain mathematical % (new - old) / old, which the server sends for display (rec.hx)
      const lossPct = rec.hx && rec.hx[i] ? rec.hx[i].e : undefined;
      if (lossPct !== undefined) Object.assign(epsPct, qctPctCell(lossPct, 'ok'));
      if (eps === null || eps === undefined) { epsPct.text = '-'; epsPct.cls = ''; epsPct.title = 'No EPS reported in this filing'; }
      const note = epsPct.text !== '-' && epsPct.text !== 'n/a' ? qctEpsSplitNote(stock, q) : '';
      if (note) { epsPct.mark = true; epsPct.title = note; }
      const salesCell = { text: sales === null || sales === undefined ? '-' : qctFmtSales(sales), cls: '', title: sales === null || sales === undefined ? (QCT_CMP_NOTE[cmp === 'ok' ? 'blank' : cmp] || '') : '' };
      const salesPct = qctPctCell(salesG, cmp, { naTitle: 'No % change: sales a year ago were zero' });
      if (ab) {   // compared on the one basis both quarters hold - say so on the cells that show a number
        const name = ab === 'S' ? 'Standalone' : 'Consolidated';
        const why = `The year-ago quarter was filed on a different basis, so this change is computed on ${name} results`;
        if (salesPct.text !== '-' && salesPct.text !== 'n/a') { salesPct.basis = ab; salesPct.title = `${why}: sales ${qctFmtSales(abSales)} Cr vs ${qctFmtSales(abSalesPrev)} Cr a year ago. The sales shown are the quarter's own figure.`; }
        if (epsPct.text !== '-' && epsPct.text !== 'n/a') { epsPct.basis = ab; epsPct.title = (epsPct.title ? epsPct.title + ' ' : '') + `${why}.`; }
      }
      return `<tr><th>${escapeHtml(qrQuarterShort(q))}</th>${cell(epsCell)}${cell(epsPct)}${cell(salesCell)}${cell(salesPct)}</tr>`;
    });
    body = head + rows.join('');
  }
  return `<table class="ic-qtr-table">${body}${band}</table>`;
}

// ── Placement: bottom-right corner of the CANDLE pane (not the chart's own corner, which is the volume pane) ───────────

// Where the table goes, as the CSS offsets of an absolutely positioned box inside the chart wrap: the bottom-right corner of
// the CANDLE pane, just left of the price scale and just above the pane's lower edge. Inputs are bounding rects
// ({left, top, right, bottom}); scaleRect may be null. Pure.
function qctFooterOffsets(wrapRect, paneRect, scaleRect) {
  const rightEdge = scaleRect && scaleRect.right - scaleRect.left > 0 ? scaleRect.left : paneRect.right;
  return {
    right: Math.max(0, Math.round(wrapRect.right - rightEdge + 8)),
    bottom: Math.max(0, Math.round(wrapRect.bottom - paneRect.bottom + 6)),
    maxHeight: Math.max(60, Math.round(paneRect.bottom - paneRect.top - 12)),   // never taller than the candle pane (it scrolls instead)
  };
}

// Measures the live chart and moves the table. The candle pane is the first row of the chart library's table; its third cell is
// the price scale. (The library's own panes() heights read stale/zero right after a render, so the DOM is measured instead.)
function qctPosition() {
  const footer = document.getElementById('icSingleFooter');
  const wrap = document.getElementById('icIndustryChartWrap');
  const container = document.getElementById('icIndustryChartContainer');
  if (!footer || !wrap || !container || footer.style.display === 'none') return;   // hidden: not the single-stock view
  const row = container.querySelector('.tv-lightweight-charts table tr');
  if (!row) return;   // no chart (no price history): the CSS default corner stays
  const scale = row.children[2];
  const o = qctFooterOffsets(wrap.getBoundingClientRect(), row.getBoundingClientRect(), scale ? scale.getBoundingClientRect() : null);
  footer.style.right = o.right + 'px';
  footer.style.bottom = o.bottom + 'px';
  footer.style.maxHeight = o.maxHeight + 'px';
}

// ── Hooks called by the chart popup ─────────────────────────────────────────────────────────────────────────────────

let _qctStock = null;       // the stock the table is currently built for
let _qctObserver = null;

function qctShow(visible) {
  const footer = document.getElementById('icSingleFooter');
  if (footer) footer.style.display = visible ? '' : 'none';
}

function qctRender(stock) {
  _qctStock = stock || null;
  const el = document.getElementById('icSingleFooter');
  if (!el) return;
  el.innerHTML = _qctStock ? qctTableHtml(_qctStock) : '';
  qctPosition();
}

function qctRefresh() { qctRender(_qctStock); }

function qctRelease() {
  if (_qctObserver) { _qctObserver.disconnect(); _qctObserver = null; }
}

// Positions the table once the chart has laid out and again whenever the chart or its candle pane changes size (window resize,
// the user dragging the divider between the candle and volume panes). The chart is rebuilt for every stock, so this is re-armed
// each time.
function qctWatch(container) {
  qctRelease();
  const place = () => requestAnimationFrame(qctPosition);
  place();
  setTimeout(place, 200);   // the library finishes its layout a moment after the data is set
  if (typeof ResizeObserver !== 'function' || !container) return;
  _qctObserver = new ResizeObserver(place);
  _qctObserver.observe(container);
  const row = container.querySelector('.tv-lightweight-charts table tr');
  if (row) _qctObserver.observe(row);
}

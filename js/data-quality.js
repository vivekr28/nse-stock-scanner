// ═══════════════════════════════════════════════════════════════════════════════
// DATA QUALITY — cross-file matching report
// ═══════════════════════════════════════════════════════════════════════════════

// All report sections start collapsed (see the `display:none` on each
// dq-section-body in index.html) - this just toggles one on click.
function dqToggleSection(id) {
  const body = document.getElementById(id + 'Body');
  const arrow = document.getElementById(id + 'Arrow');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  if (arrow) arrow.classList.toggle('dq-open', hidden);
}

function renderDataQuality() {
  const bhavKeys = new Set(Object.keys(Store.latestBySymbol));  // ISIN keys
  const sectorKeys = new Set(Object.keys(Store.sectorMap));     // normalized symbol keys
  const bandKeys = new Set(Object.keys(Store.bandBySymbol));    // ISIN keys

  // Build set of normalized symbols present in bhavcopy (for reverse sector lookup)
  const bhavSymbolSet = new Set();
  for (const key of bhavKeys) {
    bhavSymbolSet.add(normalizeSymbol(Store.latestBySymbol[key].symbol));
  }

  // Bhavcopy stocks not in sector mapping
  const noSector = [];
  // Bhavcopy stocks not in band data
  const noBand = [];
  // Stocks matched
  let sectorMatched = 0, bandMatched = 0;

  for (const key of bhavKeys) {
    const s = Store.latestBySymbol[key];
    if (sectorKeys.has(normalizeSymbol(s.symbol))) sectorMatched++;
    else noSector.push(s);
    if (bandKeys.has(key)) bandMatched++;
    else noBand.push(s);
  }

  // Sector mapping stocks not in bhavcopy
  const noTrade = [];
  for (const key of sectorKeys) {
    if (!bhavSymbolSet.has(key)) {
      const info = Store.sectorMap[key];
      noTrade.push({ symbol: key, sector: info.sector, industry: info.industry, marketCap: info.marketCap });
    }
  }

  // Band stocks not in bhavcopy
  const noBhav = [];
  for (const key of bandKeys) {
    if (!bhavKeys.has(key)) {
      const info = Store.bandBySymbol[key];
      noBhav.push({ symbol: key, bandPct: info.bandPct || '-', upper: info.upper, lower: info.lower });
    }
  }

  // Summary stats
  document.getElementById('dqBhavCount').textContent = bhavKeys.size;
  document.getElementById('dqBandMatched').textContent = bandMatched + ' / ' + bhavKeys.size;
  document.getElementById('dqSectorMatched').textContent = sectorMatched + ' / ' + bhavKeys.size;
  document.getElementById('dqUnmatched').textContent = noSector.length + noBand.length + noTrade.length + noBhav.length;
  document.getElementById('dqStaleCount').textContent = (Store.staleStocks || []).length;

  // Table: no sector mapping
  const t1 = document.getElementById('dqNoSectorTable');
  t1.querySelector('thead tr').innerHTML = '<th>#</th><th>Symbol</th><th>Close</th><th>Change%</th><th>Turnover(Cr)</th>';
  t1.querySelector('tbody').innerHTML = noSector.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text2)">All stocks matched!</td></tr>'
    : noSector.sort((a,b) => (b.turnover||0) - (a.turnover||0)).map((s, i) =>
      `<tr><td>${i+1}</td><td>${s.symbol}</td><td>${fmt2(s.close)}</td>
       <td class="${s.changePct>=0?'positive':'negative'}">${fmtPct(s.changePct)}</td>
       <td>${fmtTurnoverCr(s.turnover)}</td></tr>`).join('');

  // Table: no band data
  const t2 = document.getElementById('dqNoBandTable');
  t2.querySelector('thead tr').innerHTML = '<th>#</th><th>Symbol</th><th>Close</th><th>Sector</th><th>Industry</th>';
  t2.querySelector('tbody').innerHTML = noBand.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text2)">All stocks matched!</td></tr>'
    : noBand.sort((a,b) => a.symbol.localeCompare(b.symbol)).map((s, i) =>
      `<tr><td>${i+1}</td><td>${s.symbol}</td><td>${fmt2(s.close)}</td>
       <td>${s.sector}</td><td>${s.industry}</td></tr>`).join('');

  // Table: in sector mapping but no trade data
  const t3 = document.getElementById('dqNoTradeTable');
  t3.querySelector('thead tr').innerHTML = '<th>#</th><th>Symbol</th><th>Sector</th><th>Industry</th><th>Market Cap</th>';
  t3.querySelector('tbody').innerHTML = noTrade.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text2)">All stocks matched!</td></tr>'
    : noTrade.sort((a,b) => a.symbol.localeCompare(b.symbol)).map((s, i) =>
      `<tr><td>${i+1}</td><td>${s.symbol}</td><td>${s.sector}</td>
       <td>${s.industry}</td><td>${fmtCr(s.marketCap)}</td></tr>`).join('');

  // Table: in band but no bhavcopy
  const t4 = document.getElementById('dqNoBhavTable');
  t4.querySelector('thead tr').innerHTML = '<th>#</th><th>Symbol</th><th>Band</th><th>Upper</th><th>Lower</th>';
  t4.querySelector('tbody').innerHTML = noBhav.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text2)">All stocks matched!</td></tr>'
    : noBhav.sort((a,b) => a.symbol.localeCompare(b.symbol)).map((s, i) =>
      `<tr><td>${i+1}</td><td>${s.symbol}</td><td>${s.bandPct}</td>
       <td>${fmt2(s.upper)}</td><td>${fmt2(s.lower)}</td></tr>`).join('');

  // Table: stale stocks (in bhavcopy but not traded on latest day)
  const stale = Store.staleStocks || [];
  const t5 = document.getElementById('dqStaleTable');
  t5.querySelector('thead tr').innerHTML = '<th>#</th><th>Symbol</th><th>Series</th><th>Last Close</th><th>Last Trade Date</th><th>Trading Days</th><th>Reason</th>';
  t5.querySelector('tbody').innerHTML = stale.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:var(--text2)">All stocks traded on latest day!</td></tr>'
    : stale.sort((a,b) => a.symbol.localeCompare(b.symbol)).map((s, i) =>
      `<tr><td>${i+1}</td><td>${s.symbol}</td><td>${s.series}</td><td>${fmt2(s.close)}</td>
       <td>${s.lastTradeDate}</td><td>${s.tradingDays}</td>
       <td style="color:var(--orange)">Not traded since ${s.lastTradeDate}</td></tr>`).join('');

  dqRenderCorpActions();
  dqLoadTvState();
  dqRenderAdjusted();
  dqLoadTvVerify();
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECENT CORPORATE ACTIONS NOT PRICE-ADJUSTED  +  "Adjust prices from TradingView"
// ═══════════════════════════════════════════════════════════════════════════════
// The list itself comes from the server (Store.unadjustedCorpActions): recent corporate
// actions that cause a real price discontinuity but aren't (or can't correctly be)
// back-adjusted by a ratio - demergers, NCRPS bonuses, capital reductions, etc. (splits/
// bonuses ARE adjusted server-side and don't appear here). Events already corrected from
// TradingView data (reference-data/DemergerAdjustments.csv) are dropped from it server-side.
// SMA/52W/ADR/change% may look distorted for the rest until the affected window rolls
// past exDate. The server only contacts TradingView when the button below is clicked.
let _dqTv = { corrections: [], appliedCount: 0, polling: false };

const dqTvKey = (symbol, exDate) => normalizeSymbol(symbol) + '|' + exDate;

function dqTvCell(row) {
  if (!row) return '<span style="color:var(--text2)">Not checked</span>';
  const when = row.checkedAt ? `<span style="color:var(--text2);font-size:11px"> · checked ${escapeHtml(row.checkedAt)}</span>` : '';
  if (row.status === 'adjusted') return `<span class="positive">Corrected (×${row.factor})</span>${when}`;
  return `<span style="color:var(--orange)">${escapeHtml(row.note || row.status)}</span>${when}`;
}

function dqRenderCorpActions() {
  const corpActions = Store.unadjustedCorpActions || [];
  document.getElementById('dqCorpActionCount').textContent = corpActions.length;
  const byKey = new Map(_dqTv.corrections.map(c => [dqTvKey(c.symbol, c.exDate), c]));
  const t6 = document.getElementById('dqCorpActionTable');
  t6.querySelector('thead tr').innerHTML = '<th>#</th><th>Symbol</th><th>Ex-Date</th><th>Event</th><th>Close</th><th>TradingView check</th>';
  t6.querySelector('tbody').innerHTML = corpActions.length === 0
    ? '<tr><td colspan="6" style="text-align:center;color:var(--text2)">None in the last ~370 days.</td></tr>'
    : corpActions.map((c, i) =>
      `<tr><td>${i+1}</td><td>${escapeHtml(c.symbol)}</td><td>${c.exDate}</td>
       <td style="color:var(--orange)">${escapeHtml(c.subject)}</td>
       <td>${c.close != null ? fmt2(c.close) : '-'}</td>
       <td>${dqTvCell(byKey.get(dqTvKey(c.symbol, c.exDate)))}</td></tr>`).join('');
}

function dqSetTvStatus(text, kind) {
  const el = document.getElementById('dqTvAdjustStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--text2)';
}

// Idle summary shown next to the button: how many corrections are currently applied.
function dqTvIdleText() {
  return _dqTv.appliedCount > 0
    ? `${_dqTv.appliedCount} correction${_dqTv.appliedCount === 1 ? '' : 's'} applied from TradingView (reference-data/DemergerAdjustments.csv)`
    : '';
}

// One status fetch: the stored corrections (to label rows) + whether a run is in progress
// (so a page reload mid-run picks the progress display back up). Silent when there is no
// server (manual file-upload mode).
async function dqLoadTvState() {
  try {
    const resp = await fetch('/api/tv-adjust/status', { cache: 'no-store' });
    if (!resp.ok) return;
    const s = await resp.json();
    _dqTv.corrections = s.corrections || [];
    _dqTv.appliedCount = s.appliedCount || 0;
    const portEl = document.getElementById('dqTvPort');
    if (portEl && s.tvPort) portEl.textContent = s.tvPort;
    dqRenderCorpActions();
    if (s.status === 'running') {
      document.getElementById('dqTvAdjustBtn').disabled = true;
      dqPollTvAdjust();
    } else if (!_dqTv.polling) {
      dqSetTvStatus(dqTvIdleText());
    }
  } catch (e) { /* no server - nothing to show */ }
}

async function dqRunTvAdjust() {
  const btn = document.getElementById('dqTvAdjustBtn');
  btn.disabled = true;
  dqSetTvStatus('Starting…');
  try {
    const resp = await fetch('/api/tv-adjust/start', { method: 'POST', headers: { 'X-Requested-With': 'nse-dashboard' } });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j.ok === false) throw new Error(j.error || `Server returned HTTP ${resp.status}`);
  } catch (e) {
    dqSetTvStatus(e.message, 'error');
    btn.disabled = false;
    return;
  }
  dqPollTvAdjust();
}

async function dqPollTvAdjust() {
  if (_dqTv.polling) return;
  _dqTv.polling = true;
  const btn = document.getElementById('dqTvAdjustBtn');
  let reloading = false;
  try {
    for (;;) {
      const s = await (await fetch('/api/tv-adjust/status', { cache: 'no-store' })).json();
      _dqTv.corrections = s.corrections || [];
      _dqTv.appliedCount = s.appliedCount || 0;
      if (s.status === 'running') {
        const counter = s.total && String(s.step).startsWith('Checking') ? ` (${Math.min(s.current + 1, s.total)}/${s.total})` : '';
        dqSetTvStatus(s.step + counter);
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      if (s.status === 'error') {
        dqSetTvStatus(s.error || 'TradingView correction failed.', 'error');
      } else if (s.adjusted > 0) {
        dqSetTvStatus(`Corrected ${s.adjusted} event${s.adjusted === 1 ? '' : 's'} — reloading the dashboard data…`, 'ok');
        try {
          sessionStorage.setItem('nseReopenTab', 'dataquality');
          sessionStorage.setItem('nseReopenDqCorp', '1');
        } catch (e) { /* storage blocked - the reload just lands on the default tab */ }
        reloading = true;  // button stays disabled until the page reloads
        setTimeout(() => location.reload(), 1200);
        return;
      } else {
        const n = (s.results || []).length;
        dqSetTvStatus(`Checked ${n} event${n === 1 ? '' : 's'}: none could be corrected from TradingView.` +
                      (s.warning ? ' ' + s.warning : ''), s.warning ? 'error' : undefined);
        dqRenderCorpActions();
      }
      break;
    }
  } catch (e) {
    dqSetTvStatus('Lost contact with the server: ' + e.message, 'error');
  } finally {
    _dqTv.polling = false;
    if (btn && !reloading) btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE ADJUSTMENTS APPLIED  +  "Verify against TradingView"
// ═══════════════════════════════════════════════════════════════════════════════
// Every stock whose historical prices were adjusted (Store.adjustedCorpActions, from the
// server): splits/bonuses from NSE's corporate-actions ratios and demergers from the
// TradingView-derived factors. The button asks the server to compare our adjusted daily
// closes with TradingView's over their whole shared history and grade each stock
// (match / minor / major / inconclusive). Read-only - no price changes, so no reload.
// The last result is saved server-side, so the flags survive reloads and restarts.
let _dqVerify = { last: null, polling: false, showVerified: false };

// Problems first, then stocks still waiting for a check, then (if shown) the ones that verified.
const DQ_VERIFY_RANK = { major: 0, minor: 1, inconclusive: 2, pending: 3, match: 4 };

// The stock's current adjustments as [[exDate, factor], ...] - the same shape the server stores next
// to each verification result, so "has anything changed since it was verified?" is a comparison.
function dqAdjustmentsByIsin() {
  const by = {};
  for (const a of Store.adjustedCorpActions || []) (by[a.isin] = by[a.isin] || []).push([a.exDate, a.factor]);
  return by;
}

function dqSameAdjustments(stored, current) {
  if (!Array.isArray(stored) || stored.length !== current.length) return false;
  const norm = list => list.map(([d, f]) => [String(d), Number(f)]).sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]);
  const a = norm(stored), b = norm(current);
  return a.every((e, i) => e[0] === b[i][0] && Math.abs(e[1] - b[i][1]) <= 1e-6 * Math.max(1, Math.abs(b[i][1])));
}

// The saved result for a stock, but only if it still describes the stock's CURRENT adjustments -
// a new or changed adjustment makes an old "matches" stale, so the stock is pending again.
function dqCurrentResult(isin, byIsin) {
  const r = ((_dqVerify.last && _dqVerify.last.stocks) || {})[isin];
  return r && dqSameAdjustments(r.events, byIsin[isin] || []) ? r : null;
}

// 'match' | 'minor' | 'major' | 'inconclusive' | 'pending' (no valid result yet) for one stock.
const dqVerifyState = (isin, byIsin) => (dqCurrentResult(isin, byIsin) || { status: 'pending' }).status;

function dqToggleShowVerified(on) {
  _dqVerify.showVerified = on;
  dqRenderAdjusted();
}

function dqVerifyCell(r, stale) {
  if (!r) {
    return stale
      ? '<span style="color:var(--text2)">Awaiting verification — its adjustments changed since it was last checked</span>'
      : '<span style="color:var(--text2)">Not verified</span>';
  }
  // For a difference, say why: what the TradingView/dashboard ratio's level changes correspond to.
  const causes = (r.causes || []).map(c => `<div style="color:var(--text);font-size:11px;margin-top:2px">→ ${escapeHtml(c)}</div>`).join('');
  const note = `<span style="color:var(--text2);font-size:11px"> ${escapeHtml(r.note || '')}` +
    (r.status !== 'match' && r.firstOff ? ` · differs ${escapeHtml(r.firstOff)} → ${escapeHtml(r.lastOff)}` : '') + `</span>${causes}`;
  if (r.status === 'match') return `<span class="positive">✓ Matches</span>${note}`;
  if (r.status === 'minor') return `<span style="color:var(--orange);font-weight:600">Minor difference</span>${note}`;
  if (r.status === 'major') return `<span class="negative" style="font-weight:700">⚠ MAJOR difference</span>${note}`;
  return `<span style="color:var(--text2)">Inconclusive</span>${note}`;
}

// The list is a to-do queue: stocks that verified as a match for their CURRENT adjustments are
// hidden (Show verified brings them back); flagged and not-yet-checked stocks stay.
function dqRenderAdjusted() {
  const actions = Store.adjustedCorpActions || [];
  const byIsin = dqAdjustmentsByIsin();
  const counts = { match: 0, minor: 0, major: 0, inconclusive: 0, pending: 0 };
  for (const isin of Object.keys(byIsin)) counts[dqVerifyState(isin, byIsin)]++;
  const flagged = counts.major + counts.minor;

  const countEl = document.getElementById('dqAdjustedCount');
  countEl.textContent = actions.length;
  if (flagged) {
    const flag = document.createElement('span');
    flag.style.cssText = `font-size:12px;margin-left:8px;color:var(${counts.major ? '--red' : '--orange'})`;
    flag.textContent = `⚠ ${flagged} flagged`;
    countEl.appendChild(flag);
  }
  const verifiedEl = document.getElementById('dqTvVerifiedCount');
  if (verifiedEl) verifiedEl.textContent = counts.match;

  const t = document.getElementById('dqAdjustedTable');
  t.querySelector('thead tr').innerHTML =
    '<th>#</th><th>Symbol</th><th>Ex-Date</th><th>Type</th><th>Event</th><th>Factor</th><th>TradingView check</th>';
  // Problems float to the top (stable sort keeps the newest-ex-date-first order within a grade).
  const rows = actions
    .map(a => ({ a, v: dqCurrentResult(a.isin, byIsin), st: dqVerifyState(a.isin, byIsin) }))
    .filter(r => _dqVerify.showVerified || r.st !== 'match')
    .sort((x, y) => DQ_VERIFY_RANK[x.st] - DQ_VERIFY_RANK[y.st]);
  // "Its adjustments changed" only when a saved result recorded its adjustments and they now differ
  // (results saved before adjustments were recorded just count as not verified).
  const hadResult = isin => { const r = ((_dqVerify.last && _dqVerify.last.stocks) || {})[isin]; return !!(r && Array.isArray(r.events)); };
  let empty = 'No price adjustments applied.';
  if (actions.length && rows.length === 0) {
    empty = `✓ All ${counts.match} stock${counts.match === 1 ? '' : 's'} with price adjustments verified against TradingView. New or changed adjustments will appear here.`;
  }
  t.querySelector('tbody').innerHTML = rows.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:${actions.length ? 'var(--green)' : 'var(--text2)'}">${empty}</td></tr>`
    : rows.map(({ a, v, st }, i) =>
      `<tr${st === 'major' ? ' style="background:rgba(248,113,113,.08)"' : ''}>
       <td>${i+1}</td><td>${escapeHtml(a.symbol)}</td><td>${a.exDate}</td>
       <td>${a.kind === 'demerger' ? 'Demerger (TradingView)' : 'Split / bonus (NSE)'}</td>
       <td style="color:var(--text2)">${escapeHtml(a.detail)}</td>
       <td>×${a.factor}</td>
       <td>${dqVerifyCell(v, st === 'pending' && hadResult(a.isin))}</td></tr>`).join('');

  dqRenderVerifySummary(counts);
}

function dqRenderVerifySummary(counts) {
  const el = document.getElementById('dqTvVerifySummary');
  const last = _dqVerify.last;
  if (!last) { el.innerHTML = '<span style="color:var(--text2)">Not verified yet.</span>'; return; }
  const parts = [
    `<span class="positive">${counts.match} verified</span>`,
    `<span class="negative">${counts.major} major</span>`,
    `<span style="color:var(--orange)">${counts.minor} minor</span>`,
    `<span style="color:var(--text2)">${counts.inconclusive} inconclusive</span>`,
    `<span style="color:var(--text2)">${counts.pending} awaiting verification</span>`,
  ];
  let html = `<span style="color:var(--text2)">Last verified ${escapeHtml(last.verifiedAt)}:</span> ${parts.join(' · ')}`;
  if (!last.complete) html += ' <span class="negative">(stopped early — run again to finish)</span>';
  if (counts.major) html += `<div class="negative" style="margin-top:4px">⚠ ${counts.major} stock${counts.major === 1 ? '' : 's'} differ materially from TradingView — see the flagged rows at the top of the table.</div>`;
  const cal = last.calendar || {};
  const list = arr => arr.slice(0, 6).map(escapeHtml).join(', ') + (arr.length > 6 ? ` (+${arr.length - 6} more)` : '');
  if ((cal.tvOnly || []).length) html += `<div style="color:var(--text2);margin-top:4px">TradingView has ${cal.tvOnly.length} trading day${cal.tvOnly.length === 1 ? '' : 's'} the dashboard lacks: ${list(cal.tvOnly)}.</div>`;
  if ((cal.oursOnly || []).length) html += `<div style="color:var(--text2);margin-top:4px">The dashboard has ${cal.oursOnly.length} trading day${cal.oursOnly.length === 1 ? '' : 's'} TradingView lacks: ${list(cal.oursOnly)}.</div>`;
  el.innerHTML = html;
}

function dqSetVerifyStatus(text, kind) {
  const el = document.getElementById('dqTvVerifyStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--text2)';
}

// One status fetch: the last saved result (to grade rows) + whether a run is in progress (so a
// page reload mid-run picks the progress display back up). Silent when there is no server.
async function dqLoadTvVerify() {
  try {
    const resp = await fetch('/api/tv-verify/status', { cache: 'no-store' });
    if (!resp.ok) return;
    const s = await resp.json();
    _dqVerify.last = s.last || null;
    const portEl = document.getElementById('dqTvVerifyPort');
    if (portEl && s.tvPort) portEl.textContent = s.tvPort;
    dqRenderAdjusted();
    if (s.status === 'running') {
      document.getElementById('dqTvVerifyBtn').disabled = true;
      dqPollTvVerify();
    }
  } catch (e) { /* no server - nothing to show */ }
}

async function dqRunTvVerify() {
  const btn = document.getElementById('dqTvVerifyBtn');
  btn.disabled = true;
  dqSetVerifyStatus('Starting…');
  try {
    const all = document.getElementById('dqTvVerifyAll').checked;
    const resp = await fetch('/api/tv-verify/start' + (all ? '?all=1' : ''), { method: 'POST', headers: { 'X-Requested-With': 'nse-dashboard' } });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j.ok === false) throw new Error(j.error || `Server returned HTTP ${resp.status}`);
  } catch (e) {
    dqSetVerifyStatus(e.message, 'error');
    btn.disabled = false;
    return;
  }
  dqPollTvVerify();
}

async function dqPollTvVerify() {
  if (_dqVerify.polling) return;
  _dqVerify.polling = true;
  const btn = document.getElementById('dqTvVerifyBtn');
  try {
    for (;;) {
      const s = await (await fetch('/api/tv-verify/status', { cache: 'no-store' })).json();
      if (s.status === 'running') {
        const counter = s.total && String(s.step).startsWith('Verifying') ? ` (${Math.min(s.current + 1, s.total)}/${s.total})` : '';
        dqSetVerifyStatus(s.step + counter);
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      _dqVerify.last = s.last || null;
      dqRenderAdjusted();
      if (s.status === 'error') dqSetVerifyStatus(s.error || 'Verification failed.', 'error');
      else dqSetVerifyStatus(s.step + (s.warning ? ' ' + s.warning : ''), s.warning ? 'error' : 'ok');
      break;
    }
  } catch (e) {
    dqSetVerifyStatus('Lost contact with the server: ' + e.message, 'error');
  } finally {
    _dqVerify.polling = false;
    if (btn) btn.disabled = false;
  }
}

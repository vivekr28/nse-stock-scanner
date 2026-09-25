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

  // Table: recent corporate actions that cause a real price discontinuity but
  // aren't (or can't correctly be) back-adjusted by a ratio - demergers, NCRPS
  // bonuses, capital reductions, etc. (splits/bonuses ARE adjusted server-side
  // and don't appear here). SMA/52W/ADR/change% may look distorted for these
  // stocks until the affected window rolls past exDate.
  const corpActions = Store.unadjustedCorpActions || [];
  document.getElementById('dqCorpActionCount').textContent = corpActions.length;
  const t6 = document.getElementById('dqCorpActionTable');
  t6.querySelector('thead tr').innerHTML = '<th>#</th><th>Symbol</th><th>Ex-Date</th><th>Event</th><th>Close</th>';
  t6.querySelector('tbody').innerHTML = corpActions.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text2)">None in the last ~370 days.</td></tr>'
    : corpActions.map((c, i) =>
      `<tr><td>${i+1}</td><td>${escapeHtml(c.symbol)}</td><td>${c.exDate}</td>
       <td style="color:var(--orange)">${escapeHtml(c.subject)}</td>
       <td>${c.close != null ? fmt2(c.close) : '-'}</td></tr>`).join('');
}

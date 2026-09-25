// ═══════════════════════════════════════════════════════════════════════════════
// SCANNER — basic stock scanner with preset filters
// ═══════════════════════════════════════════════════════════════════════════════

let scannerResults = [];
let scannerPage = 0;
const PAGE_SIZE = 100;
let sortCol = null;
let sortDir = 1;

function runScanner() {
  const scanType = document.getElementById('scanType').value;
  const sector = document.getElementById('filterSector').value;
  const industry = document.getElementById('filterIndustry').value;
  const minTurnoverCr = parseNum(document.getElementById('minTurnover').value) || 0;
  const minTurnoverL = minTurnoverCr * 100; // Convert crores to lakhs for comparison
  const search = document.getElementById('searchSymbol').value.trim().toUpperCase();

  let results = [];
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];

    // Sector filter
    if (sector !== 'ALL' && s.sector !== sector) continue;
    // Industry filter
    if (industry !== 'ALL' && s.industry !== industry) continue;
    // Turnover filter (user enters crores, internal is lakhs)
    if (!isNaN(minTurnoverL) && minTurnoverL > 0 && (isNaN(s.turnover) || s.turnover < minTurnoverL)) continue;
    // Search
    if (search && !s.symbol.toUpperCase().includes(search)) continue;

    results.push(s);
  }

  // Apply scan type filter
  switch (scanType) {
    case 'uc_hit':
      results = results.filter(s => s.hitUC);
      break;
    case 'lc_hit':
      results = results.filter(s => s.hitLC);
      break;
    case 'high_turnover':
      results.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
      results = results.slice(0, 50);
      break;
    case 'high_adr':
      results.sort((a, b) => (b.adr || 0) - (a.adr || 0));
      results = results.slice(0, 50);
      break;
    case 'near_52w_high':
      results = results.filter(s => s.distFrom52H <= 5 && s.distFrom52H >= 0);
      results.sort((a, b) => a.distFrom52H - b.distFrom52H);
      break;
    case 'near_52w_low':
      results = results.filter(s => s.distFrom52L <= 5 && s.distFrom52L >= 0);
      results.sort((a, b) => a.distFrom52L - b.distFrom52L);
      break;
    case 'above_20sma':
      results = results.filter(s => s.aboveSMA === true);
      break;
    case 'below_20sma':
      results = results.filter(s => s.aboveSMA === false);
      break;
    case 'near_20sma':
      results = results.filter(s => !isNaN(s.distFromSMA) && Math.abs(s.distFromSMA) <= 2);
      results.sort((a, b) => Math.abs(a.distFromSMA) - Math.abs(b.distFromSMA));
      break;
    default:
      results.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  }

  scannerResults = results;
  scannerPage = 0;
  sortCol = null;

  // Stats
  const advancing = results.filter(s => s.changePct > 0).length;
  const declining = results.filter(s => s.changePct < 0).length;
  const aboveSMA = results.filter(s => s.aboveSMA).length;
  const avgChange = results.length > 0 ? (results.reduce((s, r) => s + (r.changePct || 0), 0) / results.length) : 0;

  document.getElementById('scannerStats').innerHTML = `
    <div class="stat-card"><div class="label">Results</div><div class="value">${results.length}</div></div>
    <div class="stat-card"><div class="label">Advancing</div><div class="value positive">${advancing}</div></div>
    <div class="stat-card"><div class="label">Declining</div><div class="value negative">${declining}</div></div>
    <div class="stat-card"><div class="label">Above 20 SMA</div><div class="value" style="color:var(--cyan)">${aboveSMA}</div></div>
    <div class="stat-card"><div class="label">Avg Change %</div><div class="value ${avgChange>=0?'positive':'negative'}">${avgChange.toFixed(2)}%</div></div>
  `;

  renderScannerTable();
}

function renderScannerTable() {
  const cols = [
    { key: 'symbol', label: 'Symbol', fmt: v => v },
    { key: 'series', label: 'Series', fmt: v => v },
    { key: 'sector', label: 'Sector', fmt: v => v || '-' },
    { key: 'industry', label: 'Industry', fmt: v => v || '-' },
    { key: 'close', label: 'Close', fmt: v => fmt2(v) },
    { key: 'changePct', label: 'Chg%', fmt: v => fmtPct(v), cls: v => v >= 0 ? 'positive' : 'negative' },
    { key: 'vol', label: 'Volume', fmt: v => fmtLakh(v) },
    { key: 'turnover', label: 'Turnover(Cr)', fmt: v => fmtTurnoverCr(v) },
    { key: 'adr', label: 'ADR%', fmt: v => fmt2(v) },
    { key: 'sma20', label: '20 SMA', fmt: v => fmt2(v) },
    { key: 'distFromSMA', label: 'Dist SMA%', fmt: v => fmtPct(v), cls: v => v >= 0 ? 'positive' : 'negative' },
    { key: 'high52w', label: '52W High', fmt: v => fmt2(v) },
    { key: 'low52w', label: '52W Low', fmt: v => fmt2(v) },
    { key: 'distFrom52H', label: 'From 52H%', fmt: v => fmtPct(-v), cls: v => 'negative' },
    { key: 'bandPct', label: 'Band', fmt: v => v || '-' },
    { key: 'upperBand', label: 'Upper', fmt: v => fmt2(v) },
    { key: 'lowerBand', label: 'Lower', fmt: v => fmt2(v) },
    { key: 'delivPer', label: 'Deliv%', fmt: v => fmt2(v) },
  ];

  // Header
  const head = document.getElementById('scannerHead');
  head.innerHTML = cols.map((c, i) =>
    `<th onclick="sortScanner('${c.key}', ${i})">${c.label}<span class="sort-arrow">${sortCol===c.key?(sortDir>0?'▲':'▼'):''}</span></th>`
  ).join('');

  // Paginated body
  const start = scannerPage * PAGE_SIZE;
  const page = scannerResults.slice(start, start + PAGE_SIZE);
  const body = document.getElementById('scannerBody');
  body.innerHTML = page.map(row =>
    '<tr>' + cols.map(c => {
      const v = row[c.key];
      const cls = c.cls ? c.cls(v) : '';
      return `<td class="${cls}">${c.fmt(v)}</td>`;
    }).join('') + '</tr>'
  ).join('');

  document.getElementById('scannerResultCount').textContent =
    `Showing ${start+1}-${Math.min(start+PAGE_SIZE, scannerResults.length)} of ${scannerResults.length}`;

  // Pagination
  const totalPages = Math.ceil(scannerResults.length / PAGE_SIZE);
  const pag = document.getElementById('scannerPagination');
  pag.innerHTML = `
    <button onclick="scannerPage=0; renderScannerTable()" ${scannerPage===0?'disabled':''}>First</button>
    <button onclick="scannerPage--; renderScannerTable()" ${scannerPage===0?'disabled':''}>Prev</button>
    <span>Page ${scannerPage+1} of ${totalPages || 1}</span>
    <button onclick="scannerPage++; renderScannerTable()" ${scannerPage>=totalPages-1?'disabled':''}>Next</button>
    <button onclick="scannerPage=${totalPages-1}; renderScannerTable()" ${scannerPage>=totalPages-1?'disabled':''}>Last</button>
  `;
}

function sortScanner(key) {
  if (sortCol === key) { sortDir *= -1; }
  else { sortCol = key; sortDir = 1; }
  scannerResults.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === 'string') return sortDir * va.localeCompare(vb);
    if (isNaN(va)) va = -Infinity;
    if (isNaN(vb)) vb = -Infinity;
    return sortDir * (va - vb);
  });
  scannerPage = 0;
  renderScannerTable();
}

function resetFilters() {
  document.getElementById('scanType').value = 'all';
  document.getElementById('filterSector').value = 'ALL';
  populateIndustryFilter();
  document.getElementById('filterIndustry').value = 'ALL';
  document.getElementById('minTurnover').value = '0';
  document.getElementById('searchSymbol').value = '';
  runScanner();
}

function exportCSV() {
  if (scannerResults.length === 0) return;
  const keys = ['symbol','series','sector','industry','close','changePct','vol','turnover',
    'adr','sma20','distFromSMA','high52w','low52w','distFrom52H','distFrom52L',
    'bandPct','upperBand','lowerBand','delivPer'];
  let csv = keys.join(',') + '\n';
  scannerResults.forEach(r => {
    csv += keys.map(k => {
      let v = r[k];
      if (v === undefined || v === null) return '';
      if (typeof v === 'number') return isNaN(v) ? '' : v.toFixed(2);
      return '"' + String(v).replace(/"/g, '""') + '"';
    }).join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'scanner_results.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- collapsible scanner filters ---------- */
function toggleScannerFilters() {
  const body = document.getElementById('scannerFiltersBody');
  const arrow = document.getElementById('scannerFilterArrow');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  if (arrow) arrow.style.transform = hidden ? '' : 'rotate(180deg)';
}

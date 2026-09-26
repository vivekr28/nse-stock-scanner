// ═══════════════════════════════════════════════════════════════════════════════
// UI — dashboard display, filter population, tab switching
// ═══════════════════════════════════════════════════════════════════════════════

function showDashboard() {
  Store.dashboardVisible = true;
  document.getElementById('loaderSection').style.display = 'none';
  document.getElementById('tabBar').classList.remove('hidden');
  document.getElementById('panel-screener').classList.add('active');
  const stockCount = Object.keys(Store.latestBySymbol).length;
  document.getElementById('totalStocks').textContent = stockCount.toLocaleString();
  document.getElementById('totalDays').textContent = Store.dates.length;
  document.getElementById('latestDate').textContent = Store.latestDate || '-';

  if (typeof initF16Dates === 'function') initF16Dates();
  runScanner();
  renderBreadth();
  if (Store.loaded.sector) {
    renderSectorAnalysis();
    renderIndustryAnalysis();
  }
  renderDataQuality();
  if (typeof updateEWIndexTabVisibility === 'function') updateEWIndexTabVisibility();

  // Auto-run screener since Stock Scanner is the default tab
  if (typeof runScreener === 'function') runScreener();

  // Come back to the tab we were on if the page was reloaded by an in-app action (the
  // Data Quality "Adjust prices from TradingView" button reloads after correcting prices).
  try {
    const reopen = sessionStorage.getItem('nseReopenTab');
    if (reopen) {
      sessionStorage.removeItem('nseReopenTab');
      const tabEl = document.querySelector(`.tab[data-tab="${reopen}"]`);
      if (tabEl) tabEl.click();
      if (sessionStorage.getItem('nseReopenDqCorp')) {
        sessionStorage.removeItem('nseReopenDqCorp');
        if (typeof dqToggleSection === 'function') dqToggleSection('dqCorpAction');
      }
    }
  } catch (e) { /* sessionStorage unavailable - stay on the default tab */ }
}

function populateFilters() {
  const sectors = new Set();
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key].sector;
    if (s && s !== '-') sectors.add(s);
  }
  const sel = document.getElementById('filterSector');
  sel.innerHTML = '<option value="ALL">All Sectors</option>';
  const sortedSectors = [...sectors].sort();
  sortedSectors.forEach(s => {
    sel.innerHTML += `<option value="${s}">${s}</option>`;
  });
  populateIndustryFilter();

  // Populate screener F11 sector dropdown
  const f11Sel = document.getElementById('scrF11Sector');
  if (f11Sel) {
    f11Sel.innerHTML = '<option value="">All Sectors</option>';
    sortedSectors.forEach(s => {
      f11Sel.innerHTML += `<option value="${s}">${s}</option>`;
    });
  }
}

function populateIndustryFilter() {
  const sector = document.getElementById('filterSector').value;
  const industries = new Set();
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    if (sector !== 'ALL' && s.sector !== sector) continue;
    const ind = s.industry;
    if (ind && ind !== '-') industries.add(ind);
  }
  const sel = document.getElementById('filterIndustry');
  sel.innerHTML = '<option value="ALL">All Industries</option>';
  [...industries].sort().forEach(ind => {
    sel.innerHTML += `<option value="${ind}">${ind}</option>`;
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const prevTab = document.querySelector('.tab.active');
    const prevTabName = prevTab && prevTab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    // Chart-popup stock picks are a scratchpad for the current tab session only —
    // clear them on any actual tab change (not page refresh, which already clears
    // the in-memory Set for free).
    if (prevTabName && prevTabName !== tab.dataset.tab && typeof clearSelectedStocks === 'function') {
      clearSelectedStocks();
    }
    // Auto-run screener when switching to Stock Scanner tab (respecting an
    // active Multi-Preset combined scan, if one is running — see screener.js)
    if (tab.dataset.tab === 'screener') {
      if (typeof rerunScreenerRespectingMultiPreset === 'function') rerunScreenerRespectingMultiPreset();
      else if (typeof runScreener === 'function') runScreener();
    }
    // Lazily create/refresh the EW index chart only once its panel is visible,
    // so Lightweight Charts measures a real (non-zero) container size.
    if (tab.dataset.tab === 'ewindex' && typeof renderEWIndexChart === 'function') {
      renderEWIndexChart();
    }
    // Same lazy-creation reasoning for the Market Breadth tab's chart.
    if (tab.dataset.tab === 'breadth' && typeof brdRenderActiveTab === 'function') {
      brdRenderActiveTab();
    }
  });
});

// ---- Data Files popup: latest downloaded files + dates (from /api/files) ----
function closeDataFiles() {
  document.getElementById('dataFilesModal').classList.remove('active');
}

function _dfFmtTime(epochSec) {
  if (!epochSec) return '-';
  return new Date(epochSec * 1000).toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function _dfFmtSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function openDataFiles() {
  const modal = document.getElementById('dataFilesModal');
  const body = document.getElementById('dataFilesBody');
  modal.classList.add('active');
  body.textContent = 'Loading…';
  try {
    const resp = await fetch('/api/files', { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const d = await resp.json();
    const th = 'text-align:left;padding:6px 8px;color:var(--text2);font-weight:600;border-bottom:1px solid var(--border);';
    const td = 'padding:6px 8px;border-bottom:1px solid var(--border);';
    const dated = (label, x) => `<tr>
      <td style="${td}">${label}</td>
      <td style="${td}"><b>${x.latest || '-'}</b></td>
      <td style="${td}">${x.count ? x.count + ' files (' + x.earliest + ' → ' + x.latest + ')' : 'none'}</td>
      <td style="${td}">${_dfFmtTime(x.latestFileTime)}</td></tr>`;
    const files = d.files.map(f => `<tr>
      <td style="${td}">${f.label}<div style="color:var(--text2);font-size:11px;">${f.file}</div></td>
      <td style="${td}">${f.exists ? _dfFmtSize(f.size) : '<span style="color:var(--red)">missing</span>'}</td>
      <td style="${td}">${f.exists ? _dfFmtTime(f.modified) : '-'}</td></tr>`).join('');
    body.innerHTML = `
      <div style="font-size:13px;font-weight:600;margin-bottom:6px;">Daily price files</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><th style="${th}">Data</th><th style="${th}">Latest date</th><th style="${th}">Files on disk</th><th style="${th}">Downloaded</th></tr>
        ${dated('Price data (Bhavcopy)', d.bhavcopy)}
        ${dated('Price band', d.priceBand)}
      </table>
      <div style="font-size:13px;font-weight:600;margin:18px 0 6px;">Reference &amp; processed files</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><th style="${th}">File</th><th style="${th}">Size</th><th style="${th}">Last updated</th></tr>
        ${files}
      </table>
      <div style="color:var(--text2);font-size:11px;margin-top:12px;">Times are when each file was last written on disk. Files that are only rewritten when their content changes (MidSmallcap 400, corporate actions) show the last actual change, not the last check.</div>`;
  } catch (e) {
    body.innerHTML = '<span style="color:var(--red)">Could not load file info (' + e.message + '). Is the server running the latest code?</span>';
  }
}

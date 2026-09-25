// ═══════════════════════════════════════════════════════════════════════════════
// NSE DATA LOADER — auto-fetch from Python server or IndexedDB cache
// ═══════════════════════════════════════════════════════════════════════════════

// ── Auto-fetch pre-processed JSON from server (two-phase: lite → daily) ──────
async function tryAutoFetchJSON() {
  try {
    showProgress('Loading from server...', 10, 'Fetching dashboard data...');

    // Phase 1: Fetch lite data (everything except dailyBySymbol — fast, ~3-5MB)
    const resp = await fetch('/api/data?lite=1');
    if (!resp.ok) return false;

    showProgress('Loading from server...', 30, 'Parsing data...');
    const data = await resp.json();
    if (!data || !data.latestBySymbol) return false;

    // Populate Store from lite data
    Store.dates = data.dates || [];
    Store.latestDate = data.latestDate;
    Store.symbolToISIN = data.symbolToISIN || {};
    Store.staleStocks = data.staleStocks || [];
    Store.latestBySymbol = data.latestBySymbol || {};
    Store.bandBySymbol = data.bandBySymbol || {};
    Store.sectorMap = data.sectorMap || {};
    Store.ewIndex = data.ewIndex || null;
    Store.unadjustedCorpActions = data.unadjustedCorpActions || [];

    // Mark as loaded
    Store.loaded.bhav = true;
    Store.loaded.band = Object.keys(Store.bandBySymbol).length > 0;
    Store.loaded.sector = Object.keys(Store.sectorMap).length > 0;

    // Unique symbols list
    Store.symbols = [...new Set(Object.values(Store.latestBySymbol).map(s => s.symbol))];

    showProgress('Loading from server...', 50, `${Object.keys(Store.latestBySymbol).length} stocks loaded`);
    await new Promise(r => setTimeout(r, 30));

    // Show dashboard immediately with lite data
    populateFilters();
    showDashboard();

    const processed = data.processedAt ? new Date(data.processedAt) : null;
    const dateStr = processed
      ? processed.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
      : '';
    const loadStatusEl = document.getElementById('loadStatus');
    if (loadStatusEl) {
      loadStatusEl.innerHTML =
        `<span style="color:var(--green);">Loaded ${Object.keys(Store.latestBySymbol).length} stocks (processed ${dateStr})</span>`;
    }

    console.log(`[NSE] Phase 1: Loaded ${Object.keys(Store.latestBySymbol).length} stocks (lite)`);

    // Phase 2: Fetch daily data in background (large payload — parsed off main thread)
    loadDailyDataInBackground();

    hideProgress();
    return true;
  } catch (e) {
    console.warn('[NSE] Auto-fetch JSON failed:', e);
    hideProgress();
    return false;
  }
}

// ── Load daily OHLCV data in the background ──────────────────────────────────
async function loadDailyDataInBackground() {
  try {
    console.log('[NSE] Phase 2: Fetching daily data...');
    const resp = await fetch('/api/data/daily');
    if (!resp.ok) {
      console.warn('[NSE] Daily data fetch failed:', resp.status);
      return;
    }

    // Get as text first, then parse in chunks via setTimeout to avoid freezing UI
    const text = await resp.text();
    console.log(`[NSE] Daily data received: ${(text.length / 1048576).toFixed(1)}MB, parsing...`);

    // Parse JSON (may take a moment for large data)
    const data = JSON.parse(text);

    const cols = data.dailyCols || ['date','open','high','low','close','vol','turnover','prev','delivQty','delivPer','trades'];
    Store.dailyBySymbol = {};
    const compactDaily = data.dailyBySymbol || {};
    let isinCount = 0;
    for (const isin in compactDaily) {
      Store.dailyBySymbol[isin] = compactDaily[isin].map(arr => {
        const obj = {};
        for (let i = 0; i < cols.length; i++) {
          obj[cols[i]] = arr[i];
        }
        if (Store.latestBySymbol[isin]) {
          obj.symbol = Store.latestBySymbol[isin].symbol;
          obj.series = Store.latestBySymbol[isin].series;
          obj.isin = isin;
        }
        return obj;
      });
      isinCount++;
    }

    console.log(`[NSE] Phase 2: Daily data loaded for ${isinCount} stocks`);

    // Re-render views that depend on daily data
    if (Store.dashboardVisible) {
      if (typeof renderBreadth === 'function') renderBreadth();
      if (typeof runScanner === 'function') runScanner();
      if (typeof runScreener === 'function') runScreener();
    }
  } catch (e) {
    console.warn('[NSE] Daily data background load failed:', e);
  }
}

// ── Auto-fetch CSV files from local HTTP server (legacy fallback) ────────────
async function tryAutoFetchCSV() {
  const files = [
    { path: 'NSE_DATA/NSE_Bhavcopy_Combined.csv', key: 'bhav', label: 'Bhavcopy' },
    { path: 'NSE_DATA/NSE_PriceBand_Combined.csv', key: 'band', label: 'Price Band' },
    { path: 'NSE_DATA/Sector-Stock-Mapping.csv', key: 'sector', label: 'Sector Mapping' },
  ];
  let anyLoaded = false;
  for (const f of files) {
    try {
      showProgress(`Fetching ${f.label}...`, 0, f.path);
      const resp = await fetch(f.path);
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!text || text.length < 100) continue;
      const rows = parseCSV(text);
      if (f.key === 'bhav') {
        Store.bhavData = rows; Store._rawBhav = text; Store.loaded.bhav = true;
        await cacheCSV('bhav', text);
      } else if (f.key === 'band') {
        Store.bandData = rows; Store._rawBand = text; Store.loaded.band = true;
        await cacheCSV('band', text);
      } else if (f.key === 'sector') {
        Store.sectorMap = {};
        rows.forEach(r => {
          const sym = (r['Stock Name'] || r['SYMBOL'] || r['Symbol'] || '').trim();
          if (sym) {
            Store.sectorMap[normalizeSymbol(sym)] = {
              sector: r['Sector'] || r['SECTOR'] || '',
              industry: r['Basic Industry'] || r['Industry'] || r['INDUSTRY'] || '',
              marketCap: parseNum(r['Market Cap'] || r['MARKET_CAP'] || 0)
            };
          }
        });
        Store._rawSector = text; Store.loaded.sector = true;
        await cacheCSV('sector', text);
      }
      anyLoaded = true;
    } catch (e) { /* skip */ }
  }
  if (anyLoaded && Store.loaded.bhav) {
    processData();
    hideProgress();
    return true;
  }
  hideProgress();
  return false;
}

// ── Startup: try JSON API → CSV fetch → IndexedDB cache ──
(async function() {
  const isLocalServer = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (isLocalServer) {
    // First try the pre-processed JSON API (two-phase: lite then daily)
    const jsonLoaded = await tryAutoFetchJSON();
    if (jsonLoaded) return;
    // Fallback: try fetching raw CSVs
    const csvLoaded = await tryAutoFetchCSV();
    if (csvLoaded) return;
  }
  // Last resort: try IndexedDB cache
  const cached = await tryLoadFromCache();
  if (!cached) {
    console.warn('[NSE] No data source available. Start the Python server with Start-Dashboard.ps1');
  }
})();

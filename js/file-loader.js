// ═══════════════════════════════════════════════════════════════════════════════
// FILE LOADER — load CSV files, update status, launch dashboard
// ═══════════════════════════════════════════════════════════════════════════════

// Reload file from header buttons (after dashboard is already open)
function reloadFile(input, type) {
  const labels = { bhav: 'Bhavcopy', band: 'Price Band', sector: 'Sector Mapping' };
  loadFile(input, labels[type] || type, (rows, rawText) => {
    if (type === 'bhav') {
      Store.bhavData = rows;
      Store._rawBhav = rawText;
      Store.loaded.bhav = true;
      cacheCSV('bhav', rawText);
    } else if (type === 'band') {
      Store.bandData = rows;
      Store._rawBand = rawText;
      Store.loaded.band = true;
      cacheCSV('band', rawText);
    } else if (type === 'sector') {
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
      Store._rawSector = rawText;
      Store.loaded.sector = true;
      cacheCSV('sector', rawText);
    }
    processData();
  });
}

function launchDashboard() {
  showProgress('Processing data...', 10, 'Computing indicators (SMA, 52W, ADR)...');
  setTimeout(() => {
    // Cache the raw CSV texts for next time
    if (Store._rawBhav) cacheCSV('bhav', Store._rawBhav);
    if (Store._rawBand) cacheCSV('band', Store._rawBand);
    if (Store._rawSector) cacheCSV('sector', Store._rawSector);
    processData();
    hideProgress();
  }, 50);
}

function loadFile(inputEl, label, onDone) {
  const file = inputEl.files[0];
  if (!file) return;
  const sizeMB = (file.size / 1048576).toFixed(1);
  showProgress(`Reading ${label}...`, 0, `${file.name} (${sizeMB} MB)`);

  const reader = new FileReader();
  reader.onprogress = ev => {
    if (ev.lengthComputable) {
      const pct = Math.round(ev.loaded / ev.total * 50); // 0-50% for reading
      showProgress(`Reading ${label}...`, pct, `${(ev.loaded/1048576).toFixed(1)} / ${sizeMB} MB`);
    }
  };
  reader.onload = ev => {
    showProgress(`Parsing ${label}...`, 55, 'Splitting rows...');
    const rawText = ev.target.result;
    // Use setTimeout to let the UI repaint before heavy parsing
    setTimeout(() => {
      const rows = parseCSV(rawText);
      showProgress(`Parsing ${label}...`, 90, `${rows.length.toLocaleString()} rows parsed`);
      setTimeout(() => {
        onDone(rows, rawText);
        hideProgress();
      }, 50);
    }, 50);
  };
  reader.readAsText(file);
}

// ── File input event listeners ──────────────────────────────────────────────
document.getElementById('bhavFile').addEventListener('change', e => {
  loadFile(e.target, 'Bhavcopy', (rows, rawText) => {
    Store.bhavData = rows;
    Store._rawBhav = rawText;
    Store.loaded.bhav = true;
    cacheCSV('bhav', rawText);
    updateLoadStatus();
  });
});

document.getElementById('bandFile').addEventListener('change', e => {
  loadFile(e.target, 'Price Band', (rows, rawText) => {
    Store.bandData = rows;
    Store._rawBand = rawText;
    Store.loaded.band = true;
    cacheCSV('band', rawText);
    updateLoadStatus();
  });
});

document.getElementById('sectorFile').addEventListener('change', e => {
  loadFile(e.target, 'Sector Mapping', (rows, rawText) => {
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
    Store._rawSector = rawText;
    Store.loaded.sector = true;
    cacheCSV('sector', rawText);
    updateLoadStatus();
  });
});

function updateLoadStatus() {
  const parts = [];
  if (Store.loaded.bhav) parts.push(`✅ Bhavcopy: ${Store.bhavData.length.toLocaleString()} rows`);
  if (Store.loaded.band) parts.push(`✅ Price Band: ${Store.bandData.length.toLocaleString()} rows`);
  if (Store.loaded.sector) parts.push(`✅ Sectors: ${Object.keys(Store.sectorMap).length} stocks mapped`);

  const missing = [];
  if (!Store.loaded.bhav) missing.push('Bhavcopy (required)');
  if (!Store.loaded.band) missing.push('Price Band (optional)');
  if (!Store.loaded.sector) missing.push('Sector Mapping (optional)');

  const statusText = parts.length > 0 ? parts.join(' | ') : 'No files loaded yet.';
  const missingText = missing.length > 0 ? '\nStill needed: ' + missing.join(', ') : '';
  document.getElementById('loadStatus').textContent = statusText + missingText;

  // Show launch button once bhavcopy is loaded
  if (Store.loaded.bhav) {
    document.getElementById('launchWrap').style.display = 'block';
  }

  // If dashboard is already visible, reprocess data
  if (Store.dashboardVisible && Store.loaded.bhav) {
    processData();
  }
}

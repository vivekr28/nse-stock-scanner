// ═══════════════════════════════════════════════════════════════════════════════
// INDEXEDDB CACHE — remember loaded files across sessions
// ═══════════════════════════════════════════════════════════════════════════════
const DB_NAME = 'NSE_Dashboard_Cache';
const DB_VERSION = 2;
const DB_STORE = 'csvFiles';

function openCacheDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        if (!db.objectStoreNames.contains('scannerPresets')) db.createObjectStore('scannerPresets');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function cacheCSV(key, text) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put({ text, savedAt: new Date().toISOString() }, key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) { /* cache is optional, ignore errors */ }
}

async function getCachedCSV(key) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    const result = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
    db.close();
    return result || null;
  } catch (e) { return null; }
}

async function clearCache() {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) { /* ignore */ }
}

// ── Auto-load from cache on startup ──
async function tryLoadFromCache() {
  try {
    const [bhavCache, bandCache, sectorCache] = await Promise.all([
      getCachedCSV('bhav'), getCachedCSV('band'), getCachedCSV('sector')
    ]);

    if (!bhavCache) return false; // At minimum bhavcopy is needed

    showProgress('Loading from cache...', 10, 'Parsing bhavcopy...');
    await new Promise(r => setTimeout(r, 30));

    Store._rawBhav = bhavCache.text;
    Store.bhavData = parseCSV(bhavCache.text);
    Store.loaded.bhav = true;
    showProgress('Loading from cache...', 40, `Bhavcopy: ${Store.bhavData.length.toLocaleString()} rows`);
    await new Promise(r => setTimeout(r, 30));

    if (bandCache) {
      Store._rawBand = bandCache.text;
      Store.bandData = parseCSV(bandCache.text);
      Store.loaded.band = true;
      showProgress('Loading from cache...', 60, `Price Band: ${Store.bandData.length.toLocaleString()} rows`);
      await new Promise(r => setTimeout(r, 30));
    }

    if (sectorCache) {
      const sectorRows = parseCSV(sectorCache.text);
      Store.sectorMap = {};
      sectorRows.forEach(r => {
        const sym = (r['Stock Name'] || r['SYMBOL'] || r['Symbol'] || '').trim();
        if (sym) {
          Store.sectorMap[normalizeSymbol(sym)] = {
            sector: r['Sector'] || r['SECTOR'] || '',
            industry: r['Basic Industry'] || r['Industry'] || r['INDUSTRY'] || '',
            marketCap: parseNum(r['Market Cap'] || r['MARKET_CAP'] || 0)
          };
        }
      });
      Store._rawSector = sectorCache.text;
      Store.loaded.sector = true;
      showProgress('Loading from cache...', 80, `Sectors: ${Object.keys(Store.sectorMap).length} mapped`);
      await new Promise(r => setTimeout(r, 30));
    }

    // Show cached date
    const cachedDate = new Date(bhavCache.savedAt);
    const dateStr = cachedDate.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const loadStatusEl = document.getElementById('loadStatus');
    if (loadStatusEl) {
      loadStatusEl.innerHTML =
        `<span style="color:var(--green);">Loaded from cache (saved ${dateStr})</span>` +
        `<br><a href="#" onclick="clearCacheAndReload(); return false;" style="color:var(--orange);font-size:11px;">clear cache &amp; reload all</a>`;
    }

    showProgress('Processing data...', 90, 'Computing indicators...');
    await new Promise(r => setTimeout(r, 30));
    processData();
    hideProgress();
    return true;
  } catch (e) {
    return false;
  }
}

function clearCacheAndReload() {
  clearCache().then(() => { location.reload(); });
}

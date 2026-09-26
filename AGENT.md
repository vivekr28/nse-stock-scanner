# NSE EOD Stock Analysis Dashboard — Project Context

## Overview

This project is an offline, self-contained NSE (National Stock Exchange of India) end-of-day stock analysis system. It consists of:

1. **`Download-NSE-Bhavcopy.ps1`** — PowerShell script to download and merge daily NSE data (CM-UDiFF format)
2. **Modular Dashboard** — `index.html` + 1 CSS + 15 own JS files + 1 vendored charting library, for analysis (dark theme, server-assisted), plus a standalone `pages/reprocess.html` utility page

All files live in `C:\Users\vivek\Documents\NSE-StockScanner\` on the user's Windows machine.

---

## Project Structure

```
NSE-StockScanner/
├── index.html                    # HTML shell — all markup, 15 script tags at bottom (cache-busted ?v=N). Stays at the top level: it is the app's entry point and its css/ and js/ paths are relative to it
├── agent.md                      # This file — project documentation
├── pages/
│   └── reprocess.html            # Standalone page: triggers a background reprocess, polls/shows live progress, links back to ../index.html
├── src/                          # Python (stdlib only). The server treats the folder ABOVE src/ as the project root (web root, NSE_DATA/, presets.json, Download-NSE-Bhavcopy.ps1); `--dir` overrides
│   ├── nse_server.py             # Python HTTP server — pre-processes CSV→JSON, serves dashboard + API
│   └── tv_adjust.py              # TradingView-assisted demerger price correction (stdlib-only DevTools client + factor derivation) — only ever runs when the Data Quality button is clicked; see "TradingView-Derived Demerger Corrections"
├── Start-Dashboard.ps1           # One-click launcher: runs Download-NSE-Bhavcopy.ps1 (-NoPause), then starts server + opens browser
├── Download-NSE-Bhavcopy.ps1     # Standalone data downloader (no browser launch)
├── Sector-Stock-Mapping.csv      # Manual sector/industry mapping file
├── presets.json                  # Screener presets saved by server API
├── .claude/
│   └── launch.json               # Dev-server launch config (python src/nse_server.py, port 8765) for browser previewing
├── css/
│   ├── styles.css                 # All CSS (dark theme, responsive, components)
│   └── fonts/
│       └── Inter-latin.woff2      # Vendored variable-weight Inter font (latin subset), no CDN at runtime
├── js/
│   ├── store.js                  # Central data store (global `Store` object)
│   ├── utils.js                  # CSV parser, symbol normalizer, date parser, formatters
│   ├── cache.js                  # IndexedDB caching (auto-load, save, clear)
│   ├── nse-download.js           # Two-phase server data loader (lite→daily) + cache fallback
│   ├── data-processor.js         # processData() — ISIN-based grouping, SMA, 52W H/L, ADR, change%, sector merge
│   ├── ui.js                     # Dashboard init, filter population, tab switching
│   ├── scanner.js                # Basic stock scanner (Stocks tab) with preset scan types
│   ├── screener.js               # Advanced 15-filter AND-logic screener (Stock Scanner tab)
│   ├── breadth.js                # Market breadth bars + canvas history charts
│   ├── sector.js                 # Sector analysis table + heatmap
│   ├── industry.js               # Industry RS scoring, bar chart, heatmap, table, Money Flow (incl. all-periods table)
│   ├── ew-index.js               # Equal-Weight MidSmallcap 400 candlestick chart (EW Index tab)
│   ├── industry-charts.js        # Shared full-screen chart popup (Stock Scanner + Industry Analysis): 2x2/1x1 grid, crosshair legend, ADR/Avg MF stats, drag-to-measure tool, stock selection/watchlist
│   ├── data-quality.js           # Cross-file matching/mismatch report
│   ├── presets.js                # Screener filter preset save/load/export/import via IndexedDB
│   └── lib/
│       └── lightweight-charts.standalone.production.js  # TradingView Lightweight Charts v5.2.1, vendored (Apache-2.0)
└── NSE_DATA/
    ├── Bhavcopy/                 # Individual daily files (CM-UDiFF format)
    │   ├── BhavCopy_CM_20260101.csv
    │   └── ...
    ├── PriceBand/                # Individual daily files
    │   ├── sec_list_01012026.csv
    │   └── ...
    ├── NSE_Bhavcopy_Combined.csv # Merged EQ+BE rows (with ISIN and COMPANY_NAME columns)
    ├── NSE_PriceBand_Combined.csv# Merged EQ+BE rows
    ├── EQUITY_L.csv              # NSE master equity list (downloaded alongside bhavcopy)
    ├── MidSmallcap400_Constituents.csv  # Nifty MidSmallcap 400 constituent symbols (downloaded from NSE API; overwritten each run — no point-in-time history, see Design Decisions)
    ├── CorporateActions.csv      # Split/bonus corporate actions (ISIN, SYMBOL, EXDATE, SUBJECT), ~3-year rolling window, overwritten each run — see "Stock Split/Bonus Price Adjustment"
    ├── DemergerAdjustments.csv   # TradingView-derived price corrections (ISIN, SYMBOL, EXDATE, FACTOR, STATUS, CHECKED_AT, NOTE), written by the Data Quality "Adjust prices from TradingView" button, applied on every processing run — see "TradingView-Derived Demerger Corrections". Not touched by the PowerShell downloaders; delete a row to undo that correction
    ├── TradingViewVerification.json  # Last "Verify against TradingView" result (per-stock grades, summary, calendar differences) so flags survive reloads/restarts — see "Verifying Adjusted Prices Against TradingView"
    ├── processed_data.json       # Server-side pre-processed cache (includes ewIndex). Starts with "schemaVersion" — see PROCESSED_SCHEMA
    └── Sector-Stock-Mapping.csv  # Copied from parent if present
```

### Script Load Order (in index.html)

The scripts use global scope (no ES modules or bundler). They must load in this exact order:

1. `store.js` — defines `Store` object (no dependencies)
2. `utils.js` — defines CSV parser, formatters, `showProgress`/`hideProgress` (no dependencies)
3. `cache.js` — uses `DB_NAME`, `parseCSV`, `normalizeSymbol`, `Store`
4. `data-processor.js` — uses `Store`, `parseNum`, `findCol`, `parseDate`, `normalizeSymbol`
5. `scanner.js` — uses `Store`, formatters
6. `screener.js` — uses `Store`, formatters, `computeDynSMA/EMA/ADR`
7. `breadth.js` — uses `Store`, canvas rendering
8. `sector.js` — uses `Store`, formatters
9. `industry.js` — uses `Store`, formatters, canvas rendering
10. `lib/lightweight-charts.standalone.production.js` — third-party vendored library, defines global `LightweightCharts` (no dependency on `Store` or app code)
11. `ew-index.js` — uses `Store.ewIndex`, `LightweightCharts`
12. `industry-charts.js` — uses `Store`, `LightweightCharts`, `computeDynADR`/`computeDynSMA` (from screener.js), `escapeHtml`/`fmtCr`/`fmtTurnoverCr`/`fmtPct`/`fmt2`; defines the shared chart popup opened from both `screener.js` (industry/symbol links) and `industry.js` (industry table/heatmap/chart-bar clicks)
13. `data-quality.js` — uses `Store`, formatters
14. `presets.js` — uses `DB_NAME`, `DB_STORE`, IndexedDB, screener field IDs
15. `ui.js` — uses `Store`, calls `runScanner`, `renderBreadth`, `renderSectorAnalysis`, `renderIndustryAnalysis`, `renderDataQuality`, `updateEWIndexTabVisibility`, `renderEWIndexChart`, `clearSelectedStocks`
16. `nse-download.js` — uses `Store`, `parseCSV`, `cacheCSV`, `processData`, auto-starts two-phase server load

---

## Data Pipeline

### PowerShell Script (`Download-NSE-Bhavcopy.ps1`)

**Purpose:** Downloads daily CM-UDiFF bhavcopy ZIP + price band CSVs from NSE, extracts, converts to standard columns, and merges into combined files. Also downloads EQUITY_L.csv (master equity list) and the Nifty MidSmallcap 400 constituent list.

**Behavior:**
- First run: downloads last 1 year of data
- Subsequent runs: incremental download from the earlier of the last Bhavcopy or PriceBand date (ensures both sources stay in sync)
- "Already up to date" only when **both** Bhavcopy and PriceBand have data for the latest expected trading day
- Displays both dates separately: `Last Bhavcopy: dd-MMM-yyyy` / `Last PriceBand: dd-MMM-yyyy`
- Skips weekends, handles holidays (404/403 = holiday)
- Uses browser-like headers + session cookie to bypass NSE's bot detection
- Downloads CM-UDiFF ZIP files, extracts the CSV inside
- Converts CM-UDiFF columns to standard format with ISIN and COMPANY_NAME
- Merges individual daily files into combined CSVs, filtering only **EQ and BE** series
- Turnover (`TtlTrfVal`) is in absolute rupees in CM-UDiFF; converted to lakhs (÷ 100,000) during merge
- Dates in CM-UDiFF are ISO format (`YYYY-MM-DD`); converted to `dd-Mon-YYYY` in combined CSV

**Download URLs:**
- CM-UDiFF Bhavcopy: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip`
- Price Band: `https://nsearchives.nseindia.com/content/equities/sec_list_{DDMMYYYY}.csv`
- EQUITY_L.csv: `https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv`

**CM-UDiFF source columns:** `TradDt, BizDt, Sgmt, Src, FinInstrmTp, FinInstrmId, ISIN, TckrSymb, SctySrs, XpryDt, FininstrmActlXpryDt, StrikPric, OptnTp, FinInstrmNm, OpnPric, HghPric, LwPric, ClsPric, LastPric, PrvsClsgPric, UndrlygPric, SttlmPric, OpnIntrst, ChngInOpnIntrst, TtlTradgVol, TtlTrfVal, TtlNbOfTxsExctd, SsnId, NewBrdLotQty, Rmks`

**Column mapping (CM-UDiFF → combined CSV):**

| CM-UDiFF Column | Combined CSV Column | Notes |
|-----------------|-------------------|-------|
| TckrSymb | SYMBOL | |
| SctySrs | SERIES | |
| TradDt | DATE1 | Converted from YYYY-MM-DD to dd-Mon-YYYY |
| PrvsClsgPric | PREV_CLOSE | |
| OpnPric | OPEN_PRICE | |
| HghPric | HIGH_PRICE | |
| LwPric | LOW_PRICE | |
| LastPric | LAST_PRICE | |
| ClsPric | CLOSE_PRICE | |
| — | AVG_PRICE | Set to 0 (not available in CM-UDiFF) |
| TtlTradgVol | TTL_TRD_QNTY | |
| TtlTrfVal | TURNOVER_LACS | Divided by 100,000 (CM-UDiFF is absolute rupees) |
| TtlNbOfTxsExctd | NO_OF_TRADES | |
| — | DELIV_QTY | Set to 0 (not available in CM-UDiFF) |
| — | DELIV_PER | Set to 0 (not available in CM-UDiFF) |
| ISIN | ISIN | **Enables rename-proof grouping** |
| FinInstrmNm | COMPANY_NAME | **Company name** |

**Combined CSV output header:** `SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER, ISIN, COMPANY_NAME`

**Known quirks:**
- PowerShell `-Encoding UTF8` writes a BOM (`EF BB BF`); the dashboard strips it with `text.replace(/^\uFEFF/, '')`
- Merge uses `[System.Collections.Generic.List[string]]` for performance (Add-Content was extremely slow at ~600K rows)
- Unicode box-drawing characters garble in older terminals; replaced with ASCII dashes
- Case-insensitive folder resolution (`Resolve-FolderCI`) handles mixed-case folder names
- **NSE's `/api/equity-stockIndices` endpoint is retired** (confirmed 404 on every index, not just MidSmallcap 400) \u2014 replaced with `https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=<short code>`. The `symbol` param needs the **short index code** (e.g. `NIFTY MIDSML 400`), not the display name (`NIFTY MIDSMALLCAP 400`) \u2014 look it up via `functionName=getIndexList` if adding another index later.
- **Invoke-WebRequest + Accept-Encoding on www.nseindia.com JSON APIs silently corrupts the response.** Windows PowerShell 5.1 doesn't auto-decompress gzip/brotli, and NSE's Akamai bot-detection cookie appears to bind the *whole session* to whichever `Accept-Encoding` the *first* request advertised \u2014 so `Accept-Encoding` must be omitted from every request in the session (session warm-up included), not just the JSON call itself, or `ConvertFrom-Json` fails with `Invalid JSON primitive`. See `$ApiHeaders` (no `Accept-Encoding`) vs `$Headers` (has it, fine for `-OutFile` downloads from the separate `nsearchives.nseindia.com` host).

### Input CSV Formats

**Combined Bhavcopy columns (after PowerShell merge):** `SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER, ISIN, COMPANY_NAME`

**Price Band columns:** `Symbol, Series, Date, Upper_Band/High Price Band, Lower_Band/Low Price Band, Price Band/Applicable Price Band` (column names vary across dates)

**Sector-Stock-Mapping.csv columns:** `Stock Name, Listing Date, Basic Industry, Market Cap, 3 Month Returns(%), % from 52W High, % from 52W Low, Index, Sector, Daily Price Turnover 50, 30 Days MA ADR(%), Industry 3M Rank`

**Important:** The `Index` column in the sector mapping contains comma-separated quoted values like `"Nifty 500,Nifty Smallcap 250"`. The CSV parser handles this with a proper quoted-field parser. The `Index` column is **completely ignored** — only `Sector` and `Basic Industry` are used.

**Series codes:**
- **EQ** — Regular equity (most stocks)
- **BE** — Trade-to-trade / compulsory delivery
- SM — SME platform (excluded)

---

## Dashboard Architecture

### Data Flow

**Server-side (Python, on startup):**
```
NSE_Bhavcopy_Combined.csv → process_data()
                           → Filter EQ+BE, group by ISIN
                           → Compute SMA/52W/ADR/change%
                           → Merge bands, sectors
                           → processed_data.json (49MB)
                           → Gzipped caches: lite (~3MB), daily (~14MB), full (~14MB)
```

**Client-side (two-phase load):**
```
Phase 1: /api/data?lite=1 → Store.latestBySymbol, dates, bands, sectors
                           → populateFilters() + showDashboard() (instant)

Phase 2: /api/data/daily  → Store.dailyBySymbol (background)
                           → renderBreadth() + runScanner() + runScreener() re-run when complete

Fallback: CSV fetch → parseCSV() → processData() → showDashboard()
          IndexedDB → parseCSV() → processData() → showDashboard()
```

### Stock Rename Handling via ISIN

The dashboard uses ISIN (International Securities Identification Number) as the internal grouping key instead of stock ticker symbols. ISIN is a permanent identifier tied to the company — it never changes even when NSE renames a ticker symbol. This means when a stock is renamed (e.g., `ABCLTD` → `ABCGROUP`), all historical data automatically groups together under the same ISIN, preserving SMA, 52W high/low, ADR, and monthly change calculations.

The `Store.symbolToISIN` map bridges symbol-based lookups (needed for sector mapping and band data, which have no ISIN column) to the ISIN-keyed data stores.

### Loading Paths (priority order)

1. **Two-phase server JSON** (primary) — `tryAutoFetchJSON()` fetches `/api/data?lite=1` first (everything except dailyBySymbol, ~3-5MB), shows dashboard immediately, then fetches `/api/data/daily` (dailyBySymbol, ~45MB gzipped to ~14MB) in background via `loadDailyDataInBackground()`
2. **CSV fetch from server** (fallback) — `tryAutoFetchCSV()` fetches raw CSVs from `NSE_DATA/` paths served by the static file handler
3. **IndexedDB cache** (last resort) — `tryLoadFromCache()` restores previously cached CSV data

Manual file upload and live NSE download from the browser have been removed. All data flows through the Python server (`src/nse_server.py`), launched by `Start-Dashboard.ps1`.

### Data Caching (IndexedDB)

**Database:** `NSE_Dashboard_Cache` (version 2)

| Object Store | Purpose |
|-------------|---------|
| `csvFiles` | Cached CSV text for bhavcopy, band, and sector files (keys: `bhav`, `band`, `sector`) |
| `scannerPresets` | Saved screener filter presets (key: `preset_<timestamp>`, value: `{name, state, savedAt}`) |

Raw CSV text is stored in `Store._rawBhav`, `Store._rawBand`, `Store._rawSector` and cached via `cacheCSV()` on every file load. On page load, `tryLoadFromCache()` auto-restores cached data.

### Python Server (`src/nse_server.py`)

HTTP server on port 8765 (Python stdlib `http.server`). Pre-processes 163MB bhavcopy CSV into ~49MB `processed_data.json` on startup (or when CSVs change). Serves dashboard HTML, static files, and API endpoints.

**API endpoints:**
- `GET /api/data?lite=1` — Pre-processed JSON without dailyBySymbol (~3-5MB gzipped). Used for instant dashboard display.
- `GET /api/data/daily` — Only dailyBySymbol + dailyCols (~45MB, gzipped to ~14MB). Loaded in background after dashboard shows.
- `GET /api/data` — Full pre-processed JSON (backward compatible, ~49MB).
- `GET /api/presets` — Load screener presets from `presets.json`.
- `POST /api/presets` — Save screener presets to `presets.json`.
- `GET /api/reprocess` — Force re-process CSVs into JSON, **blocking** — doesn't respond until `process_data()` + save fully complete (~30-90s). Kept exactly as-is for the PowerShell scripts' own post-download auto-trigger, which waits for completion before printing its own "reprocessed automatically" message.
- `GET /api/reprocess/start` — Force re-process, **non-blocking**: starts `process_data()` in a background `threading.Thread` and returns immediately (`{"ok": true, "started": true}`, or `{"ok": true, "alreadyRunning": true}` if one is already in flight). Because the heavy work moves off the server's single request-handling loop, `/api/status` and everything else keeps responding normally while it runs — unlike the old blocking endpoint, which used to freeze the entire server (nothing else could be served, not even `/api/status`) for the full duration. Used by `pages/reprocess.html`.
- `GET /api/reprocess/status` — Returns the shared `_reprocess_state` dict (`status`: `idle`/`running`/`done`/`error`, `step`, `startedAt`, `finishedAt`, `error`, `stocks`), updated live via a `progress_cb` threaded through `process_data()`'s major phases (reading bhavcopy, split/bonus adjustment, sector mapping, indicators, price band, EW index, saving). Polled by `pages/reprocess.html` every ~600ms.
- `POST /api/tv-adjust/start` — Data Quality tab's "Adjust prices from TradingView" button (see "TradingView-Derived Demerger Corrections"). Starts `run_tv_adjust()` in a background thread and returns immediately (`{"ok": true, "started": true}`, `alreadyRunning`, or 409 if a reprocess is in flight). Requires an `X-Requested-With: nse-dashboard` header (else 403): a custom header forces a CORS preflight for any cross-site caller, and the server's preflight only approves `Content-Type`, so a random web page can't make the dashboard drive TradingView or rewrite the corrections file. **The only place the server ever contacts TradingView** — never at startup.
- `GET /api/tv-adjust/status` — The shared `_tv_state` (`status`, `step`, `current`/`total`, `adjusted`, `results`, `error`, `warning`) plus `corrections` (every row of `DemergerAdjustments.csv`), `appliedCount` and `tvPort`. Polled by the Data Quality tab during a run, and fetched once on render to label the list rows.
- `POST /api/tv-verify/start` / `GET /api/tv-verify/status` — Data Quality tab's "Verify against TradingView" button (see "Verifying Adjusted Prices Against TradingView"). Same `X-Requested-With: nse-dashboard` same-origin rule as `/api/tv-adjust/start`; 409 while a correction run is using the TradingView chart (and vice versa). Status returns the run state (`_tv_verify_state`) plus `last`, the saved result.
- `GET /api/status` — Health check (returns server info, file existence).

**Cache schema version:** `process_data()` writes `schemaVersion` (`PROCESSED_SCHEMA`) as the *first* key of `processed_data.json`, and `needs_processing()` reads the first 64 bytes of the file: an older/missing version means "regenerate", so adding a field to the output no longer needs a manual forced reprocess after the restart (the sequence "fix code, restart, reprocess" documented under "Server restarts" is now automatic for schema changes). Bump `PROCESSED_SCHEMA` whenever the output gains or changes a field the client relies on; keep `schemaVersion` first in the `result` dict.

**Caching:** Server caches three gzipped variants in memory (full, lite, daily) with ETag support. Invalidated when CSVs change or reprocess is requested. Static files (JS/HTML/CSS) are served with `Cache-Control: no-cache` to prevent browser caching issues.

**Data pipeline:** `process_data()` mirrors the JS `processData()` — reads CSV, groups by ISIN, back-adjusts prices for splits/bonuses (see "Stock Split/Bonus Price Adjustment" below), computes SMA/52W/ADR/change%, merges bands and sectors, outputs compact JSON with dailyBySymbol as arrays (not objects) for smaller payload. Daily data limited to last 510 trading days (raised from 260 — see "Known bugs fixed" below). Reprocessing (either endpoint) only ever *reads* `NSE_Bhavcopy_Combined.csv`/`NSE_PriceBand_Combined.csv`/`CorporateActions.csv` as they currently exist on disk — it never fetches new data from NSE or re-merges the per-day files into those combined CSVs; that's done entirely by the PowerShell scripts, which call `/api/reprocess` themselves once new data has been merged in. Reprocessing bad/missing data in those source files faithfully reproduces the same bad/missing output — only a fresh PowerShell download fixes that.

### Data Store (`Store` object)

```javascript
Store = {
  bhavData: [],           // Raw bhavcopy rows
  bandData: [],           // Raw price band rows
  sectorMap: {},          // normalizedSymbol -> {sector, industry, marketCap}
  dailyBySymbol: {},      // ISIN -> [{symbol, series, date, open, high, low, close, last, prev, vol, turnover, trades, delivQty, delivPer, isin, companyName}, ...]
  latestBySymbol: {},     // ISIN -> {symbol, close, sma20, changePct, monthlyChangePct, sector, industry, isin, companyName, ...}
  bandBySymbol: {},       // ISIN -> {upper, lower, bandPct}
  symbolToISIN: {},       // normalizedSymbol -> ISIN (bridges symbol-keyed data to ISIN keys)
  staleStocks: [],        // Stocks in bhavcopy but not traded on latest day
  dates: [],              // Sorted unique trading dates
  latestDate: '',         // Most recent trading date
  _rawBhav: '',           // Raw CSV text for caching
  _rawBand: '',           // Raw CSV text for caching
  _rawSector: '',         // Raw CSV text for caching
  loaded: { bhav, band, sector },
  dashboardVisible: false
}
```

**Key:** `dailyBySymbol`, `latestBySymbol`, and `bandBySymbol` are all keyed by **ISIN**, not by normalized symbol. The `symbolToISIN` map provides the bridge for lookups that start from a symbol (e.g., sector mapping, band data processing).

### Symbol Matching / Normalization

Symbol-based matching (used for sector mapping and band data bridging) uses `normalizeSymbol()`:
```javascript
function normalizeSymbol(s) {
  return (s || '').trim().toLowerCase().replace(/[&\-]/g, '_');
}
```
Ensures case-insensitive matching and treats `&`, `-` as equivalent to `_`. Original symbol names are preserved for display.

**Sector mapping** (`Sector-Stock-Mapping.csv`) remains symbol-keyed since the file has no ISIN column. The lookup in `processData()` uses `Store.sectorMap[normalizeSymbol(latest.symbol)]` to attach sector/industry to ISIN-keyed entries.

### Turnover Display

All turnover values are displayed in **crores** throughout the dashboard. Internal data is in lakhs (`TURNOVER_LACS` — converted from absolute rupees during PowerShell merge), converted for display by `fmtTurnoverCr(v)` which divides by 100. Filter inputs are in crores and multiplied by 100 for internal comparison.

---

## Dashboard Tabs

### 1. Stock Scanner (`panel-screener`) — `js/screener.js` (DEFAULT TAB)

See detailed description below.

### 2. Stocks (`panel-scanner`) — `js/scanner.js`

Quick-filter stock table with preset scan types:
- All stocks, UC Hit, LC Hit, High Turnover (top 50), High ADR
- Near 52W High (within 5%), Near 52W Low, Above/Below/Near 20 SMA

Filters: Search Symbol (first/prominent), Scan Type, Sector, Industry (cascading dropdown), Min Turnover (Cr). Sortable table with pagination (100/page). CSV export.

Advanced AND-condition scanner with 15 configurable filters. Only enabled (checked) filters apply; all active filters must pass for a stock to qualify.
Filters displayed in a popup modal triggered by a "Filters" button in the toolbar (with active filter count badge). Modal has two tabs:
- **Technicals tab:** F10, F1, F2, F3, F5, F6, F8, F7, F4 (single-column layout)
- **Sector & Industry tab:** F11, F9, F13, F14, F12
Modal header includes preset selector (dropdown + Save/Rename/Delete buttons). Modal footer has "Apply & Scan", "Reset All", and "Partial history" checkbox.
Filter labels use white text (`var(--text)`). `switchFilterTab()` toggles between tab panes. `openScreenerFilters()`/`closeScreenerFilters()` manage modal visibility. `updateFilterBadge()` updates active filter count on toolbar button.

**Passed/Failed Toggle Button:**
- After a scan, results are split into `screenerPassed[]` and `screenerFailed[]` arrays
- A toggle button instantly switches between showing ONLY passed stocks or ONLY failed stocks
- No need to re-run the scan — `togglePassedFailed()` swaps the `screenerResults` pointer and re-renders
- Button shows count and color-codes: green for "Showing Passed", red for "Showing Failed"
- Failed view adds a "Failed Filters" column with per-filter failure reasons
- State tracked by `scrShowingFailed` boolean; `updateToggleButton()` syncs UI
- View state is preserved when search input changes or filters are modified (re-running the scan does not reset the toggle)

**Scanner Presets** (`js/presets.js`):
- Preset controls in the filter popup modal header: dropdown selector, Save, Rename, Delete buttons
- "Save" captures all filter checkboxes and input values via `PRESET_FIELDS` array (includes F1-F14 + scrAllowPartial)
- Stored via server API (`/api/presets`) with IndexedDB fallback, persists across sessions
- Selecting a preset restores all settings and re-runs screener; Rename edits name; Delete removes it

**Multi-Preset combined scan** (`js/presets.js`: `runMultiPresetScan()`, `clearMultiPresetScan()`) — a third tab in the filter popup, "Multi-Preset", lets the user run **two or more saved presets together** and combine their results:
- A checklist of every saved preset name, plus an AND/OR radio (AND default): **AND** = stock must pass every checked preset (set intersection); **OR** = stock passes if it matches any one checked preset (set union).
- Implementation avoids duplicating the 15-filter evaluation logic: for each checked preset, it temporarily applies that preset's saved filter state to the DOM (`applyPresetState()`, the same mechanism `loadPreset()` uses) and calls the existing `runScreener()` once per preset, collecting each run's `screenerPassed` ISINs into a `Set`; combines those sets via plain intersection/union; restores the original single-filter-tab DOM state (`capturePresetState()`/`applyPresetState()`) afterward so the Technicals/Sector & Industry tabs are left untouched.
- Populates `screenerPassed`/`screenerFailed` from the combined set (failed stocks get a generic `_failReasons` of `"Did not pass combined {AND|OR} scan: PresetA, PresetB"`), so the existing Passed/Failed toggle, stats cards, and results table all work unchanged. "Combined Presets (AND/OR)" replaces "Active Filters" in the stats row while a combined view is showing.
- "Clear" exits combined mode (`_multiPresetActive = null`) and reverts to whatever the single-filter tabs currently show.
- **Known limitation:** a handful of filter-specific optional table columns (e.g. F1's SMA-turnover column) may not perfectly reflect the combined view, since column selection in `renderScreenerTable()` still reads from the (restored) single-filter DOM state, not from whichever presets were actually combined. Core columns (Symbol, Sector, Industry, Close, Change%, Turnover, ADR%, 52W High, Band, MCap) are always accurate regardless.
- Verified against real saved presets (`RagingVolume` = 72 stocks alone, `3M-Performance` = 92 alone): AND correctly returned the 14-stock intersection, OR correctly returned the 150-stock union, both matching an independently-computed ground truth exactly.

**Filter details:**

| Filter | Description | Configurable Inputs |
|--------|-------------|-------------------|
| F1 | Current Turnover > N x Day Avg Turnover | Multiplier (def 3), SMA Length (def 50) |
| F2 | N Days Avg Turnover > value Cr | SMA Length (def 50), Value in Cr (def 1) |
| F3 | Current Turnover > value | Value in Cr (def 5) |
| F4 | Co-occurrence: Day Change > X% AND Turnover > Nx SMA on same day | Day Change % (def 2%), T/O Multiplier (def 3), SMA Length (def 50), Min Times (def 1), Lookback Days (def 10) |
| F5 | Close % from 52W High in range | Min % (def 0), Max % (def 10) |
| F6 | ADR > value | SMA Length (def 50), Value % (def 3) |
| F7 | Exclude circuit stocks | Checkboxes for 2%, 5%, 10% (checked = exclude) |
| F8 | Close / SMA proximity ratio | SMA Length (def 50), Min ratio (def 0.97), Max ratio (def 1.10) |
| F9 | Industry RS >= threshold | RS threshold (def 60), Min stocks/industry (def 3), Min industry MCap Cr (def 0) |
| F10 | Price Above MAs | Checkboxes: 20 SMA (def checked), 50 SMA, 200 SMA, 200 EMA |
| F11 | Sector filter | Dropdown of sectors from mapping file |
| F12 | Industry Money Flow | Period (1W/1M/3M/6M/12M), Min % threshold (def 0) |
| F13 | Min Stocks in Industry | Min count (def 3) — filters out stocks whose industry has fewer than N stocks |
| F14 | Min Industry Market Cap | Min MCap in Cr (def 0) — filters out stocks whose industry total MCap is below threshold |
| F15 | Performance (price change over period) >= value | Period dropdown (1D/1W/1M/3M/6M/1Y, def 1M), Min % threshold (def 0) |

**F4 Co-occurrence filter (special):**
- Both conditions must be satisfied on the **same trading day**
- This must happen at least **M times** in the last **L trading days**
- `checkCoOccurrence()` iterates over the lookback window
- Table shows "Co-occur Hits" column when active
- When partial history is enabled, uses `Math.min(availableBars, smaLen)` for turnover SMA — newly listed stocks with ≥5 bars can pass instead of being rejected

**Dynamic computation functions:**
- `computeDynSMA(days, field, length)` — SMA for any field with configurable lookback (returns NaN if insufficient data)
- `computeDynSMAPartial(days, field, length)` — SMA using available data (min 5 bars) when full lookback not available; used when "Include stocks with insufficient price history" is checked
- `computeDynEMA(days, field, length)` — EMA for any field (used for 200 EMA in F10; returns NaN if insufficient data)
- `computeDynEMAPartial(days, field, length)` — EMA using available data (min 5 bars); partial-data variant for newly listed stocks
- `computeDynADR(days, length)` — ADR with configurable lookback
- `computeIndustryRS(minStocks, minMcap)` — Industry RS scores with filters
- `computeIndustryMoneyFlow(period)` — Per-ISIN turnover flow for current vs previous period (1w/1m/3m/6m/1y); returns data keyed by ISIN. Shared by the F12 filter above and the Industry Analysis tab's Money Flow sort/table (see below)
- `checkCoOccurrence(days, minChangePct, turnoverMult, smaLen, minTimes, lookbackDays, allowPartial)` — Co-occurrence check; when allowPartial=true, uses min 5 bars instead of full smaLen

**Include stocks with insufficient price history** (`scrAllowPartial` checkbox):
- When checked, filters F1, F2, F4, F8, and F10 use `computeDynSMAPartial`/`computeDynEMAPartial` instead of their strict counterparts
- These partial functions calculate indicators using whatever data is available (minimum 5 bars) instead of returning NaN and failing the stock
- F4 co-occurrence uses available bars (min 5) for its turnover SMA instead of requiring full smaLen days
- Useful for newly listed stocks that don't have enough trading days for the configured SMA/EMA lookback
- Checked by default so newly listed stocks are included; when unchecked, stocks with insufficient history are rejected by those filters

**Export options:**
- **Export CSV** — Downloads all current results as a CSV file
- **TV Watchlist** — Modal showing all **passed** stocks (always uses `screenerPassed`, unaffected by current view or search filter) in TradingView format: `###IndustryName(count),NSE:STOCK1,...` grouped by industry
- **Copy Selected / Clear Selected** — copies only the stocks hand-picked (checkbox) while browsing chart popups, in the same TV-watchlist format/modal as above, grouped by industry and sorted by number of *selected* stocks per industry. See "Shared Industry/Stock Charts Popup" below — the pick-list (`selectedStocks`) is global across tabs and cleared on tab switch (`js/ui.js`) or page refresh, not by re-scanning/re-filtering.

### 3. Market Breadth (`panel-breadth`) — `js/breadth.js`

**Note:** Breadth charts depend on `Store.dailyBySymbol` which loads in Phase 2 (background). Charts auto-refresh after Phase 2 completes via `nse-download.js`.
- Above/Below 20-SMA counts and ratio bar
- Advancing/Declining counts and ratio bar
- 60-day breadth history chart (canvas, gradient fill, dot markers every 5 points)
- 6-month (~125 day) breadth history chart (canvas, dot markers every 10 points)
- `computeBreadthHistory(numDays)` uses pre-built date->index maps for O(1) lookup

### 4. Sector Analysis (`panel-sector`) — `js/sector.js`

- Sector summary table (avg change%, breadth, turnover, top gainer/loser)
- Heatmap cards (top 20 sectors, color-coded by avg change)
- Sortable by change%, breadth, turnover, stock count

### 5. Industry Analysis (`panel-industry`) — `js/industry.js`

- Industry Relative Strength (RS) composite score (0-100):
  - Breadth rank (40%) + Avg Monthly Change rank (30%) + Proximity to 52W High rank (30%)
  - Each component percentile-ranked across filtered industry set
- Canvas horizontal bar chart (top 40 industries by RS) — hidden in favor of the all-periods table below when that's toggled on
- Industry Breakdown table lists **every** industry passing the filters (the chart is capped at the top 40, the heatmap cards at the top 30), in the same order as the chart (the Sort By metric = "filter order"). Every column header except `#` is click-to-sort (`sortIndustryBreakdown()`): first click uses the column's natural direction (A→Z for Industry/Sector, high→low for metrics, ascending for Avg Dist 52WH and Top 1M Loser), a second click flips it. The default filter order shows its arrow on the Sort By column; a manual sort shows a "Reset to filter order" button (`resetIndustryBreakdownSort()`) and is cleared automatically when Sort By (or the Money Flow period, in that mode) changes, but survives Min Stocks/Min Market Cap edits. Manual sorting only re-orders the table — the chart and heatmap stay in filter order. Ties keep filter order (stable sort); missing values always sort last.
- Filterable by min stocks and min market cap (also applied to the Money Flow all-periods table)
- Money flow lookup uses ISIN keys directly (matches `computeIndustryMoneyFlow()` output)
- **Money Flow sort mode** (`Sort By → Money Flow`) reveals a period dropdown (1W/1M/3M/6M/1Y) driving the chart/table/heatmap, plus an **"All-periods table" checkbox** that replaces the RS bar chart with a dedicated `Industry × {1W,1M,3M,6M,1Y}` comparison table (`computeAllPeriodsMoneyFlow()`/`renderMoneyFlowAllPeriodsTable()`) — each cell shows the period's turnover *and* its % change vs. the prior equivalent period. Column headers are click-sortable by % change (not raw turnover, so you see where money is flowing fastest); the sort column auto-follows the period dropdown unless you've manually clicked a different column (tracked via `_mfAllPeriodTrack`), matching the single-period view's behavior.
- Clicking an industry name (table row, heatmap card, chart bar, or the all-periods table) opens the same shared chart popup used by the Stock Scanner tab (`openIndustryCharts()` — see "Shared Industry/Stock Charts Popup" below), not a separate bare-table modal.

### Shared Industry/Stock Charts Popup — `js/industry-charts.js`

A single full-screen modal (`#industryChartsModal`, deliberately a **top-level sibling of the tab panels** in `index.html`, not nested inside `panel-screener` — nesting it there was a bug that silently no-op'd the popup whenever it was opened from any tab other than Stock Scanner, since a hidden `.panel` ancestor forces `display:none` on everything inside it regardless of the modal's own `.active` class) used from three entry points:
- `openIndustryCharts(industryName)` — Stock Scanner's Industry column links and every Industry Analysis click surface above; a paged grid of every stock in that industry, sorted by market cap descending, plus an "Industry Chart" tab showing a synthetic equal-weight index built from the constituents (`icComputeIndustryIndex()` — same per-stock-return-averaging technique as the EW Index tab).
- `openStockChart(isin)` — Stock Scanner's Symbol column links; one big chart, Prev/Next steps through the *current* Stock Scanner results list.
- Both modes share the same chart plumbing (`icCreateChart()`), so every feature below works identically everywhere a chart is rendered.

**Layout:** `icLayout` toggles between `'2x2'` (`IC_PAGE_SIZE`=4 per page) and `'1x1'` (one chart per page) — `icSetLayout()` recomputes the page index from the currently-first-visible stock so switching layout keeps whatever you were looking at in view instead of jumping back to stock #1.

**Appearance:** solid black chart background (`IC_CHART_BG = '#000000'`, plain, not the dashboard's `--bg` token) with gridlines turned off entirely (`grid: { vertLines: { visible: false }, horzLines: { visible: false } }`) — a deliberate plain-background look, changed from the library's default transparent/gridded style.

**Per-stock cell header** (two lines, both plain text with no background box, matching the stock name's own styling):
- Line 1: checkbox (selection) + symbol — in the grid this is one `<label class="ic-cell-select">` wrapping both, so clicking either toggles selection via native label behavior; in single-stock mode (`openStockChart`/`icRenderSingleStock`) the checkbox was originally a separate control living in the modal's top toolbar next to Measure, inconsistent with the grid — moved into the title line itself (`icSingleSelectWrap`, styled with the same `.ic-cell-select` class) so both views now put the checkbox before the name, and the title text (`icTitle`) itself is also click-to-toggle in single-stock mode (`titleEl.onclick`, cleared/restored to non-interactive when `openIndustryCharts()` shows an industry-level title instead of a single stock's). Then the crosshair-driven OHLC / day-change% / money-flow readout (`icCreateChart()`'s `updateLegend()`, via `chart.subscribeCrosshairMove()` — falls back to the latest bar when not hovering), then market cap (`fmtCr()` — already appends its own "Cr"/"K Cr"/"L Cr" suffix, so callers must NOT append another literal `" Cr"`, a duplication bug fixed in both this file and `industry.js`'s chart tooltip).
- Line 2: 50-day ADR and 50-day Avg Money Flow (`icStatsLine()`, reusing `computeDynADR`/`computeDynSMA` from `screener.js`), shown by default via two checkboxes in the header.
- The Industry Chart tab (no single "stock name" line to attach the legend to) falls back to a small translucent overlay (`.ic-legend`) positioned on the chart itself instead.

**Price SMA overlays** — three toggleable line series on the candlestick pane: `icSMA10`/`icSMA20`/`icSMA50` checkboxes (`IC_SMA_LENGTHS = [10, 20, 50]`; only 20 is checked by default), colored `IC_SMA_COLORS = {10:'#15ff00', 20:'#ff9800', 50:'#ff1616'}`, `lineWidth: 1` (thinned from an earlier `2`). Computed via the EW Index tab's existing `ewComputeSMA()` (shared, not duplicated) in `icUpdateInstanceSMA()`.

**Turnover-pane 50 SMA + real chart panes** (`icUpdateVolumeSMA()`, `IC_VOLUME_SMA_COLOR = '#08c9c2'`) — an always-on (not user-toggleable) 50-period SMA line drawn over the volume histogram. This went through three iterations before landing on real multi-pane separation, each fixing a problem the previous one caused:
1. **Shared scale with the raw bars** (original attempt): a 50-day average dilutes any single-day turnover spike to roughly 1/50th of its raw value, so on a linear scale shared with — and pinned to the max of — the raw bars, the line was squashed flat and invisible whenever one outlier day was in view (confirmed live on `JGCHEM`: a ~663 Cr spike vs a ~10-50 Cr typical range).
2. **Independent auto-scaled price scale** (`priceScaleId: volumeScaleId + 'Sma'`): fixed visibility (the line now fills the pane based on its own value range), but broke height-comparability entirely — the line and bars became two different rulers sharing the same pixel space, so the line could visually sit *above* bars that were actually far larger in real terms.
3. **Final fix — shared scale, but with the scale's max explicitly capped** (`icComputeVolumeScaleCap()`: 95th percentile of the series × 1.3 headroom, via `autoscaleInfoProvider`) **and the *rendered* bar values clipped to that same cap** before `setData()` (a separate `renderedVolumeData` array — `inst.volumeData` itself stays uncapped/true everywhere else: the legend, the SMA calc, and the MF-dot logic below). Capping the scale alone wasn't sufficient on its own: a bar far beyond the cap still computed a proportionally taller pixel position and kept rendering past the scale's own top-margin line, past the intended headroom, all the way to the pane's hard edge — confirmed live (a ~663 Cr bar against a ~300 Cr cap still touched the ceiling despite a 20% top margin). Clipping the *fed-in* bar value at the same cap guarantees no bar can ever exceed the margin's headroom, closing that gap for good.
   Separately, **volume bars and the turnover SMA now live in a genuinely separate chart pane** (`chart.addSeries(..., 1)`, this library's real multi-pane API — `chart.panes()[0].setStretchFactor(5)` / `chart.panes()[1].setStretchFactor(1)`, replacing the old single-shared-pane-plus-`scaleMargins` trick used everywhere else in this file). That trick let an extreme bar's rendered value bleed visually past its intended margin and directly into the candlestick pane above (confirmed live before this fix); a real second pane has a hard boundary a bar can never cross regardless of scale math. `candleSeries`'s own margins were correspondingly simplified from the old `{top:0.08, bottom:0.28}` (which reserved room for the volume pane sharing its canvas) down to `{top:0.1, bottom:0.1}` (a real full-height pane of its own now).
- **65-day-high markers on the SMA line itself** (`IC_VOLUME_SMA_HIGH_LOOKBACK = 65`, `IC_VOLUME_SMA_HIGH_COLOR = '#00ffda'`): a circle drawn `position:'inBar'` directly on the turnover-SMA line at every point that's the highest value of *that line* (not the raw bars) over its trailing 65 points, via a second `createSeriesMarkers` plugin instance (`volumeSmaMarkersPlugin`, separate from the price-pane's purple-dot one below) attached to `volumeSmaSeries`.

**"Purple Dots" money-flow marker** (`icShowMFDots` checkbox, checked by default) — a `#9c27b0` circle (`position:'belowBar'`, so it always anchors to the candle's low regardless of up/down color) on every day where Money Flow (turnover) >= `IC_MF_DOT_MIN_CR` (40 Cr) **and** `|day change%| >= IC_MF_DOT_MIN_CHG` (5, either direction — both a +5% and a -5% day with heavy turnover qualify) via `icComputeMFDotMarkers()` and a `createSeriesMarkers` plugin attached to `candleSeries`.

**Click-click measure tool** (`icMeasureMode`, no equivalent exists in the vendored Lightweight Charts library) — click once to place a start point, move the pointer (no button held) to live-preview the box/label following the cursor exactly like the original drag version did, click again to drop the end point and pin the measurement (% change, price delta, trading-day count, via `coordinateToPrice`/`coordinateToLogical`). Originally a mousedown-drag-mouseup gesture that also force-disabled the chart's own native pan/zoom while Measure mode was on (`chart.applyOptions({handleScroll:false,handleScale:false})`); changed to click-click specifically so **native pan/zoom can stay on permanently, in every mode** — a real drag (movement past `IC_MEASURE_DRAG_THRESHOLD` between mouse-down and mouse-up) is left completely alone for the chart's own pan to handle, while a stationary down/up pair is treated as a measure click. One measurement per chart at a time — a new click-click sequence replaces the old one; the label's "×" clears it without starting a new one. State and DOM elements are per chart instance, so each of the grid's 4 charts measures independently. (Known tooling caveat, carried over from the original drag-tool verification: this project's browser automation cannot dispatch a "trusted" enough gesture to exercise Lightweight Charts' own native pan-drag handling — confirmed neither the automation's own drag action nor manually dispatched `MouseEvent`s panned the chart, with or without Measure mode on, even though nothing in the click-click code calls `preventDefault`/`stopPropagation` or touches `handleScroll`/`handleScale` anymore. The click-click mechanic itself doesn't need trusted events and was verified working live.)

**Stock selection / watchlist** (`selectedStocks`, a global `Set` of ISINs — intentionally lives in this file since both tabs' popups feed it):
- Every chart cell (grid and single-stock) has a checkbox; picks persist across paging, reopening the modal for a different industry, and switching between the Stock Scanner/Industry Analysis tabs' own popups, but are cleared on an actual top-level tab change (`js/ui.js`'s tab-click handler) or a page refresh — never by re-scanning/re-filtering.
- "Copy Selected" (`copySelectedStocksWatchlist()`) reuses the Stock Scanner's existing TV Watchlist modal/clipboard code (`_tvWatchlistText`/`#tvModal`/`copyTvWatchlist()` in `screener.js`) to produce the identical `###Industry(N),NSE:SYM,...` format, but sourced only from the picks and grouped/sorted by selected-count per industry. "Clear Selected" empties the set and un-checks any visible checkboxes. Both buttons + a live count label appear in both tabs' toolbars (`updateSelectedUI()` keeps them in sync).
- Because the single persistent `#icIndustryChartContainer` (used by both single-stock mode and the Industry Chart tab) is reused across renders rather than recreated, `icCreateChart()` clears it (`container.innerHTML = ''`) before building a new chart — otherwise the legend/measure overlay `<div>`s from a previous visit would silently accumulate on every re-render.

### 6. Data Quality (`panel-dataquality`) — `js/data-quality.js`

Cross-file matching report:
- Bhavcopy stocks missing sector mapping (bridges ISIN-keyed bhav data to symbol-keyed sector via `normalizeSymbol(s.symbol)`)
- Bhavcopy stocks missing band data
- Sector mapping stocks with no trade data (builds `bhavSymbolSet` from bhav entries for reverse lookup)
- Band stocks with no bhavcopy entry
- Stale stocks (not traded on latest day)
- **Recent Corporate Actions Not Price-Adjusted** — `Store.unadjustedCorpActions` (populated server-side, see "Stock Split/Bonus Price Adjustment" below): demergers, NCRPS bonuses, capital reductions, etc. from the last ~370 days that cause a real price discontinuity but aren't (or can't correctly be) back-adjusted by a simple ratio. Splits/bonuses that *were* successfully adjusted never appear here — this table is specifically for the ones that couldn't be. Columns: Symbol, Ex-Date, Event, Close, TradingView check. Added directly in response to a user question about why `INDIAGLYCO` showed an unexplained ~-79% gap (a demerger, confirmed via NSE's own corporate-actions feed) that the split/bonus logic correctly left alone. **The section has an "Adjust prices from TradingView" button** that corrects these from TradingView's already-adjusted history — corrected events are stored in `NSE_DATA/DemergerAdjustments.csv`, applied on every processing run and dropped from this list; the rest stay listed with a "TradingView check" note explaining why (e.g. "TradingView shows no adjustment for this event (raw ex-date move -11.7%)"). Full design in "TradingView-Derived Demerger Corrections" below.

- **Price Adjustments Applied** — `Store.adjustedCorpActions` (`adjustedCorpActions` in `processed_data.json`, built by `build_adjusted_corp_actions()`): every price adjustment in effect — **splits and bonuses** (ratio from NSE's feed) and **demergers** (TradingView-derived factor) — one row per event with Ex-Date, Type, Event, **Factor** (what pre-ex-date prices were multiplied by; `1/ratio` for splits/bonuses) and a "TradingView check" column. Only stocks still trading and events whose ex-date falls inside the retained price window are listed (an older event has no visible price effect; a delisted stock isn't in the dashboard anywhere). Verified against the pipeline itself: every price-adjusted stock the dashboard shows is listed (203 of 203) and none is listed that wasn't actually changed; the single price-adjusted stock not listed is a stale/delisted one. **Dividends are not adjusted** by this pipeline, so none are listed. **The list is a to-do queue:** a stock that verified as `match` against TradingView for its *current* adjustments is hidden (a "Show verified stocks (N)" checkbox brings them back) and only returns when it gets a new or changed adjustment; stocks with a difference (`major`/`minor`/`inconclusive`) stay listed until they match; not-yet-checked stocks show "Not verified". Has a "Verify against TradingView" button — see "Verifying Adjusted Prices Against TradingView".

**All seven report sections default to collapsed** (`.dq-section-header`/`.dq-section-body`, `dqToggleSection(id)` in `js/data-quality.js` — same click-header-to-toggle-a-body-div convention as the Stocks tab's `toggleScannerFilters()`), so the tab opens compact instead of dumping every table at once; the seven summary stat cards above them (including "Unadjusted Corp Actions" and "Price Adjustments Applied", the latter showing a red/orange "⚠ N flagged" once verified) are always visible regardless of which sections are expanded.

---

## CSS Architecture — `css/styles.css`

- Dark theme with CSS custom properties (`--bg`, `--bg2`, `--bg3`, `--text`, `--text2`, `--green`, `--red`, `--orange`, `--cyan`, `--purple`, `--accent`, `--border`)
- Component classes: `.stat-card`, `.sector-card`, `.mini-table`, `.breadth-bar`, `.filter-group`
- Screener toggle: `.scr-toggle-btn.showing-passed` (green tint), `.scr-toggle-btn.showing-failed` (red tint)
- Modal dialog (`.modal-overlay`, `.modal-box`) for TradingView watchlist and screener filter popup
- Screener filter tabs (`.scr-filter-tab`, `.scr-filter-pane`) for Technicals / Sector & Industry switching
- NSE download banner with progress bar
- Responsive layout

### Theme: colors + font sampled from wealthlab.in (Completed)

At the user's request, the palette and typeface were re-sampled from `wealthlab.in` (a Tailwind-CSS-based dark SaaS dashboard) to modernize the look. Extracted via `getComputedStyle` + canvas pixel rendering (to resolve Tailwind v4's oklch/oklab colors to hex, since they don't string-compare or convert directly).

- **Palette (Tailwind slate + accent "400" shades):** `--bg:#0f172a` `--bg2:#1e293b` `--bg3:#27324a` `--border:#334155` `--text:#f1f5f9` `--text2:#94a3b8` `--accent:#3b82f6` `--green:#05df72` `--red:#f87171` `--orange:#ffb900` `--cyan:#00d3f3` `--purple:#c27aff`
- **Font:** Inter, replacing the system-font stack (`-apple-system`/`Segoe UI`). Vendored locally at `css/fonts/Inter-latin.woff2` (single variable-weight file, ~47KB, latin subset only) rather than loaded from Google Fonts CDN, to keep the dashboard's offline-first design intact — same rationale as vendoring the Lightweight Charts library. Declared via one `@font-face` with `font-weight: 100 900` covering the whole range.
- **Canvas-drawn charts don't inherit CSS variables** — `breadth.js` (breadth history line/fill charts) and `industry.js` (RS bar chart + hover tooltip) had the old palette hardcoded as literal hex/rgba strings in `ctx.fillStyle`/`ctx.strokeStyle` calls and had to be updated by hand to the new hex values so they don't visually clash with the new theme. `js/ew-index.js` reads `--green`/`--red`/`--text2`/`--border` from `getComputedStyle(document.documentElement)` at chart-creation time instead of hardcoding, so it already tracks `:root` changes automatically; only its MA-line colors (`EW_MA_COLORS`) were hardcoded and got updated to the new orange/cyan/purple to match.
- **Verified in-browser:** Stock Scanner, Market Breadth, Industry Analysis, and EW Index tabs all screenshot-checked after the change — no leftover old-palette colors (confirmed via `grep` across `js/`, `index.html`, `css/styles.css`), no console errors.

---

## Key Computed Indicators

| Indicator | Formula | Lookback |
|-----------|---------|----------|
| 20-day SMA | avg of last 20 closes | 20 trading days |
| 52W High/Low | max high / min low | 250 trading days |
| ADR% | avg((high-low)/close x 100) | 20 days (configurable in screener) |
| Change% | (close - prev) / prev x 100 | 1 day |
| Monthly Change% | (close - close_22d_ago) / close_22d_ago x 100 | 22 sessions (or since listing) |
| Dist from 52W High | (high52w - close) / high52w x 100 | — |
| Dist from SMA | (close - sma20) / sma20 x 100 | — |

---

## Key Global Functions

### Data & Loading
- `parseCSV(text)` — RFC-compliant CSV parser with quoted field support, BOM stripping
- `normalizeSymbol(s)` — lowercase + replace `&`/`-` with `_`
- `processData()` — main data processing pipeline (ISIN-based grouping, used for CSV/cache paths)
- `processBandData()` — merge price band into latestBySymbol (uses `symbolToISIN` to bridge symbol-keyed band data to ISIN keys)
- `tryAutoFetchJSON()` — two-phase server load: lite data for instant dashboard, daily data in background
- `loadDailyDataInBackground()` — fetches `/api/data/daily` after dashboard shows, populates `Store.dailyBySymbol`
- `tryAutoFetchCSV()` — legacy fallback: fetch raw CSVs from server static paths
- `tryLoadFromCache()` — last resort: auto-load from IndexedDB cache
- `showProgress(label, pct, detail)` / `hideProgress()` — show/hide the loader progress bar

### Formatters
- `fmt2(v)` — 2 decimal places or `-`
- `fmtPct(v)` — signed percentage with `+`/`-`
- `fmtTurnoverCr(v)` — lakhs -> crores display
- `fmtCr(v)` — market cap in crores/lakh crores
- `fmtLakh(v)` — generic lakh/crore formatter

### Scanner/Screener
- `runScanner()` — basic scanner with preset scan types
- `runScreener()` — advanced 14-filter screener
- `togglePassedFailed()` — instant switch between passed/failed results
- `updateToggleButton()` — sync toggle button text and color
- `resetScreener()` — reset all filters to defaults
- `exportScreenerCSV()` / `exportTradingViewWatchlist()` — export functions
- `openScreenerFilters()` / `closeScreenerFilters()` — filter popup modal open/close
- `switchFilterTab(tab)` — switch between Technicals and Sector & Industry tabs in popup
- `updateFilterBadge()` — update active filter count badge on toolbar button
- `toggleScannerFilters()` — collapsible filter panel for Stocks tab

### Rendering
- `showDashboard()` — init all tabs (default: Stock Scanner tab; auto-runs `runScreener()` after all other rendering)
- `renderBreadth()` / `renderBreadthChart(canvasId, numDays)` — breadth bars + canvas charts
- `renderSectorAnalysis()` — sector table + heatmap
- `renderIndustryAnalysis()` — industry RS table + chart + heatmap + Money Flow all-periods table
- `renderIndustryBreakdownTable()` / `sortIndustryBreakdown(key)` / `resetIndustryBreakdownSort()` — Industry Breakdown table (all filtered industries) and its click-to-sort headers; default order = Sort By/filter order
- `renderRSChart(data)` — canvas horizontal bar chart
- `renderDataQuality()` — cross-file matching report

### Shared Chart Popup (`js/industry-charts.js`)
- `openIndustryCharts(industryName)` / `openStockChart(isin)` — open the popup in grid mode or single-stock mode
- `icCreateChart(container, volumeScaleId, ohlcTarget)` — shared chart-creation plumbing (candles/volume/SMA series, crosshair legend, drag-to-measure tool); `ohlcTarget` is an optional header element for the legend, omit for the on-chart overlay fallback
- `icSetLayout('2x2'|'1x1')` — grid layout toggle, preserves scroll position across the switch
- `icApplyMeasureMode()` / `icMeasureMode` — Measure-tool on/off, disables/restores native chart pan+zoom
- `toggleStockSelection(isin)` / `clearSelectedStocks()` / `copySelectedStocksWatchlist()` — stock pick-list (see "Shared Industry/Stock Charts Popup" above)
- `computeAllPeriodsMoneyFlow(minStocks, minMcap)` / `renderMoneyFlowAllPeriodsTable(data)` (in `js/industry.js`) — Industry Analysis's Money Flow all-periods table

---

## Design Decisions & Constraints

1. **No stock is excluded** from analysis due to missing sector/industry/band data. Missing sector/industry -> `Undefined-Diversified`. Missing band -> shown as `-`. Stocks with insufficient price history can optionally be included via the "Include stocks with insufficient price history" checkbox (calculates indicators from available data, min 5 bars).
2. **Stocks not traded on latest day** are excluded from scanner and analysis but tracked in Data Quality.
3. **Only EQ and BE series** are included. SM (SME) and other series are filtered out.
4. **Market cap** comes from the static Sector-Stock-Mapping.csv, not computed from live price.
5. **Monthly change** uses 22 trading sessions. Stocks with fewer sessions use change since first available date.
6. **Server-assisted architecture** — Python server (`nse_server.py`) pre-processes CSV data into JSON on startup; browser loads pre-computed data via two-phase fetch (lite for instant display, daily in background). CSV/cache fallback paths still work without the server.
7. **BOM handling** — PowerShell writes UTF-8 BOM; dashboard strips it on parse.
8. **Circuit hit detection:** `hitUC` if high >= upper x 0.999, `hitLC` if low <= lower x 1.001.
9. **ISIN-based grouping** — All daily and latest data is keyed by ISIN, not symbol. This automatically handles stock renames. The `symbolToISIN` map bridges symbol-based lookups (sector mapping, band data) to ISIN keys.
10. **No old-format backward compatibility** — The system exclusively uses CM-UDiFF bhavcopy format. No fallback to the old `sec_bhavdata_full_` format exists in either PowerShell scripts or dashboard JS.
11. **Sector mapping stays symbol-keyed** — `Sector-Stock-Mapping.csv` has no ISIN column. NSE provides no single file with complete industry mapping by ISIN (`ind_niftytotalmarket_list.csv` covers only ~1263 stocks). The current approach of symbol-based sector lookup is retained.

---

## NSE Data Sources

| File | URL | Purpose |
|------|-----|---------|
| CM-UDiFF Bhavcopy | `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip` | Daily OHLCV data with ISIN — ZIP containing CSV |
| Price Band | `https://nsearchives.nseindia.com/content/equities/sec_list_{DDMMYYYY}.csv` | Daily circuit limits / price bands |
| EQUITY_L.csv | `https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv` | Master list of all listed equities with SYMBOL, company name, SERIES, listing date, ISIN |
| ind_niftytotalmarket_list.csv | `https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv` | ~1263 stocks with ISIN + Industry (partial coverage only) |
| Nifty MidSmallcap 400 | `https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20MIDSML%20400` | JSON API — ~400 constituent stock symbols for equal-weight index chart. Note: `symbol` is the short index code, not the display name (see Known quirks above) |

---

## Completed: Stock Split/Bonus Price Adjustment

**Problem (reported by user):** NSE's raw bhavcopy data is unadjusted for stock splits and bonus issues. When a stock splits (or issues bonus shares), its close price drops sharply overnight purely from the share-count change, not from any real move — e.g. a 1:5 split turns a ₹100 stock into a ₹20 stock with zero actual value change. Because the dashboard computes every indicator (`sma20`, 52W high/low, `adr`, `changePct`, `monthlyChangePct`) directly from this raw series, the split/bonus date produced a fake ~80%+ "crash" that failed filters and distorted SMAs/ADR/52W-high for a long time afterward.

**Data source:** `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY` — same internal-API category as the MidSmallcap 400 endpoint, reachable with the existing `$ApiHeaders`/session-cookie approach. Bulk endpoint (no per-symbol looping); response is a **plain JSON array** (not wrapped in a `data` key — confirmed live, this differs from the MidSmallcap 400 endpoint's shape). Each row: `symbol`, `comp`, `isin`, `series`, `faceVal`, `subject` (free text), `exDate`, `recDate`, plus board/notice-period date fields not used here.

### Subject-text parsing (`nse_server.py`: `BONUS_RE`, `FVS_RE`, `parse_corp_action_ratio()`)

Regex-scanned the live endpoint's full available history (~40,000 rows, 2007–2026) to find every subject-text variant actually in use, rather than trusting the two patterns first spotted — this surfaced several cases the initial sample missed:

- `"Bonus X:Y"` (X new shares per Y held) → ratio `(X+Y)/Y`. Regex tolerates real inconsistencies seen in the feed: leading/trailing whitespace, double spaces, a stray dash (`"Bonus- 1:2"`), a space after the colon (`"Bonus 1: 1"`).
- `"Face Value Split (Sub-Division) - From Rs A/- Per Share To Rs B/- Per Share"` → ratio `A/B`. Regex tolerates: `"Rs"` **or** `"Re"` before *either* value (not just when the value is 1, as first assumed — e.g. `"...To Re 2/- Per Share"` occurs), missing `"/-"` suffix, no space between `"Rs"` and the number (`"Rs10/-"`).
- `"Consolidation Of Equity Shares From Re A Per Share To Rs B Per Share"` — a **reverse split** (share count shrinks, price rises), e.g. `VERTOZ` 25-Jun-2025. Handled by the *same* `A/B` ratio formula as the forward-split case with no separate branch: a "from low face-value to high face-value" consolidation naturally yields a ratio `< 1`, and dividing by a ratio `< 1` is the same as multiplying — which is exactly the price-up adjustment a reverse split needs.
- Deliberately **not matched** (would corrupt data if guessed at): `"Bonus Ncrps X:Y"` / `"Scheme Of Arrangement - Bonus Ncrps X:Y"` (a bonus issue of non-convertible redeemable preference shares — a separate security, doesn't dilute the equity share count, e.g. `TVSMOTOR`, `SIYSIL`, `TVSHLTD`); standalone `"Capital Reduction"` / `"Capital Reduction Pursuant To Nclt Order"` (complex restructuring, not a simple ratio). Older pre-2022 combined phrasings (`"Bonus 1:1 And Face Value Split From Rs.10/- To Re.1/-"`, abbreviated `"Fv Split Rs.10/- To Rs.2/-"`) exist in the full history but never appear in the last ~3 years of live data, which is all this feature ever pulls — not worth the false-positive risk of loosening the regex for dates that will never be adjusted anyway. Any subject that matches the broad `bonus|split|consolidation` keyword filter but fails both regexes is logged by `load_split_bonus_events()` at process time (`[!] N corporate-action row(s) ... NOT adjusted`) instead of being silently skipped or guessed at, so a future NSE phrasing change becomes visible rather than silently wrong.
- Multiple events for the same ISIN (e.g. a bonus **and** a split on the same exDate — `CGCL`, `LAL`, `CUPID`, `BESTAGRO`, and others each did both) compound naturally: `apply_split_adjustments()` multiplies every event's ratio whose `exDate` is still ahead of the day being adjusted.

### The ISIN-continuity bug this uncovered (`bridge_split_induced_isin_changes()`)

Implementing the ratio math alone turned out to have **zero effect** on the dashboard's actual output, for a reason not anticipated going in: **NSE assigns a brand-new ISIN when a stock's face value changes**, even though the ticker symbol stays identical. Confirmed directly in the raw bhavcopy — `KAMDHENU` trades as `INE390H01012` through 07-Jan-2025, then as `INE390H01020` from 08-Jan-2025 onward, the exact split exDate. Checked systematically across the whole corporate-actions dataset: **168 of 169** face-value-split events change ISIN (only bonus-only events reliably keep the same ISIN — though a bonus announced *alongside* a split inherits that split's ISIN change too).

Since `dailyBySymbol` is grouped strictly by ISIN (by design, so a ticker *rename* doesn't fragment history — see "Stock Rename Handling via ISIN" above), a face-value split does the opposite of what that design defends against: it silently fragments one company's continuous history into two disconnected ISIN buckets. The pre-split bucket has no entry on the latest trading date, so it's filtered out as a "stale stock" and never reaches the client at all — the SMA/52W/ADR windows on the post-split ISIN saw a hard *gap*, not just an unadjusted discontinuity (confirmed live: `SHRIRAMFIN`'s retained series was only 417 days instead of the full 507-day window, starting exactly at its split's exDate).

This bridging logic went through three versions, each fixing a real bug the previous one had — all three found by the user spot-checking specific real stocks against TradingView/NSE rather than trusting the aggregate "N stocks adjusted" count:

1. **First version** — for each event, looked up the *next* ISIN the same ticker symbol trades under (matched by comparing `daily_by_symbol[isin][-1]['symbol']` strings, first-trade-date order) and prepended the old ISIN's days onto it. Worked for `KAMDHENU`/`SHRIRAMFIN`.
2. **`PGIL` broke it**: user reported an unadjusted ~50% gap-down on an 11-Sep-2026 "Bonus 1:1" that TradingView showed correctly split-adjusted. Root cause — the corp-actions feed listed PGIL's event under ISIN `INE940H01014`, which is over 2.5 years stale (PGIL's *actual* ISIN change happened back in Jan-2024, long before this dashboard's ~2-year retention window even starts). Looking up that old ISIN's own data found **zero rows**, so the code gave up and silently dropped the event, ratio and all — not just skipped bridging, but lost the adjustment entirely, since resolution and bridging were the same step. **Fix:** decoupled the two — every event's ratio is now resolved via its `symbol` field through `symbol_to_isin` (always correct, independent of whether any old ISIN has retained history at all), and bridging (merging old-ISIN history forward) became a separate, best-effort step layered on top.
3. **`ACUTAAS` (formerly `AMIORG`) broke the rewritten version**: a rename happened *at the same time* as its face-value split, and the corp-actions feed inconsistently listed the split's row under `INE00FF01025` — which is actually the **new**, post-split ISIN, not the real pre-split one (`INE00FF01017`, confirmed in the bhavcopy). Symbol-name matching for bridging discovery failed here because the old ISIN's own last row carried the *old* ticker name (`AMIORG`), which never matches the event's `symbol` field (`ACUTAAS`) — two different problems from #2, but both stemming from trusting the corp-actions CSV's own ISIN/context instead of the bhavcopy's actual data. **Final fix:** stopped using symbol names for bridging discovery entirely. Indian ISINs share a fixed 10-character issuer prefix, and only the last 2 digits change when a face-value split gets a new ISIN — confirmed empirically across every case seen (`INE00FF010`-17→-25, `INE390H010`-12→-20, `INE940H010`-14→-22, `INE560A010`-15→-23). `bridge_split_induced_isin_changes()` now finds sibling ISINs purely by matching that prefix in `dailyBySymbol` itself, independent of any symbol name — immune to a simultaneous rename, and still safe (never merges an ISIN that doesn't share the issuer's own prefix).

The current, final design: **ratio resolution** (`current_isin = symbol_to_isin.get(normalize_symbol(symbol)) or old_isin`) and **history bridging** (ISIN-prefix matching, chaining oldest-first so a symbol with more than one ISIN change in the window merges correctly instead of only catching the most recent link) are fully independent steps — a missing or misleading old ISIN can no longer cause the ratio itself to be lost, and a simultaneous rename can no longer break bridging discovery.

### The `prev`-field boundary fix

NSE's own raw feed does **not** adjust `PrvsClsgPric` either — confirmed live: `KAMDHENU`'s 08-Jan-2025 row (the split's exDate) carries `prev=479.30`, a naive carry-forward of the previous day's *unadjusted* close, even though that same row's own open/close are already correctly on the new ~₹45–48 scale. Left alone, this reproduces the exact same fake-crash symptom one field over — `changePct` and, more importantly, `compute_equal_weight_index()`'s per-day return basis (`ret = price / prev - 1`) would both see one wildly wrong day exactly on the split date. Fixed by giving `prev` its own boundary in `apply_split_adjustments()`: a day's own open/high/low/close/last adjust for events with `exDate > day.date` (strict), but `prev` (yesterday's close) adjusts for events with `exDate >= day.date` — the one-day-later cutoff a "previous close" reference needs. Verified live: `RELIANCE`, `SHRIRAMFIN`, `KAMDHENU`, `NMDC` all show smooth `prev`-to-`close` continuity across their exDates with no residual jump.

### Pipeline

1. **PowerShell** (`Download-NSE-Bhavcopy.ps1` and `Start-Dashboard.ps1`, both updated identically): downloads a fresh **3-year rolling window** from the endpoint on every run (full re-pull, not incremental — same pattern already accepted for `MidSmallcap400_Constituents.csv`; the endpoint is cheap enough — a few hundred split/bonus rows even over 3 years — that incremental-fetch state-tracking isn't worth the complexity), filters to rows whose `subject` matches `bonus|split|sub-division|consolidation of equity shares` (a loose pre-filter — real parsing happens server-side), and saves `ISIN,SYMBOL,EXDATE,SUBJECT` to `NSE_DATA/CorporateActions.csv`.
2. **`nse_server.py`**: `needs_processing()` now also watches `CorporateActions.csv`'s mtime. `process_data()` runs `load_split_bonus_events()` → `bridge_split_induced_isin_changes()` → `apply_split_adjustments()` on `dailyBySymbol` immediately after grouping/sorting, before any indicator (`sma20`, 52W high/low, `adr`, `changePct`, `monthlyChangePct`, and the equal-weight index) is computed from it — so every downstream consumer sees already-continuous, already-adjusted prices with no separate adjustment step of its own.
3. **Announced-but-not-yet-effective events are correctly ignored**: `load_split_bonus_events()` drops any event whose `exDate` is after the bhavcopy's own latest date — none of the retained price history spans that discontinuity yet, so adjusting now would incorrectly rescale everything down for no reason until the real split actually shows up in the raw feed.
4. **Turnover is untouched** — only `open`/`high`/`low`/`close`/`prev`/`last` are adjusted; turnover (₹ value = price × volume) doesn't need it.

**Verified end-to-end:** ran `process_data()` directly and via the live HTTP server (`/api/data?lite=1`) against real production data — 154–194 stocks price-adjusted across the several fix iterations, split-induced ISIN pairs bridged per run, KAMDHENU/SHRIRAMFIN/PGIL/ACUTAAS all restored to the full 507-day retained window with smooth `close`/`prev` continuity across their exDates and sane resulting `sma20`/`high52w`/`low52w`/`adr` (spot-checked against hand-verified real splits: `SURYAROSNI` 10→5 FVS, `SHRIRAMFIN` 10→2 FVS, `KAMDHENU` 10→1 FVS, `PGIL` "Bonus 1:1", `ACUTAAS`/`AMIORG` 10→5 FVS + rename, `RELIANCE`/`WIPRO`/`NMDC` bonus-only), with no regressions across any fix iteration. Also confirmed the "not recognized" logging path fires correctly for real `Bonus Ncrps` rows without misclassifying them as equity events, and — separately — that a genuine demerger (`INDIAGLYCO`, ~-79% real gap-down, confirmed via NSE's own feed) is correctly left unadjusted rather than guessed at; that specific investigation is what led to the "Unadjusted Corp Actions" Data Quality report below, so a real-but-non-ratio-based event like this one is surfaced instead of silently unexplained.

**Known scope limits (accepted, not blocking):**
- **Client-side CSV/cache fallback (`js/data-processor.js`) is not adjusted.** This only matters when the Python server is unavailable, which isn't the primary usage path (`Start-Dashboard.ps1` always launches the server). Would need the same three-function logic ported to JS if ever needed.
- Pre-2022 combined/abbreviated subject phrasings aren't parsed (see above) — irrelevant today since the 3-year pull window never reaches that far back, but would need broader regexes if the pull window is ever extended past ~3 years.
- Raw (unadjusted) prices are not separately retained anywhere for audit — adjustment happens in place on `dailyBySymbol`.

---

## Completed: TradingView-Derived Demerger Corrections

**Problem:** demergers (and NCRPS bonuses, capital reductions, …) cause a real price discontinuity but NSE's corporate-actions feed carries no ratio, so they land in the Data Quality tab's "Not Price-Adjusted" list and distort SMA/52W high-low/ADR/change% (e.g. `VEDL` showed a fake 66.5% distance from its 52W high). TradingView already carries demerger-adjusted history for most of them, so rather than guess a ratio we derive it from TradingView.

**Requirements (from the user):** never contact TradingView at server start; give a button to correct prices from TradingView; persist the corrections in a file so corrected events leave the Data Quality list; apply the stored corrections on every server start using data already on disk; anything new/unconfirmed stays listed.

**Flow:**
1. Button → `POST /api/tv-adjust/start` → `run_tv_adjust()` (background thread). For each event in `unadjustedCorpActions` it reads TradingView's daily bars and calls `tv_adjust.derive_correction()`, records the outcome in `NSE_DATA/DemergerAdjustments.csv`, then — only if a price was newly corrected — runs a normal reprocess, and the page reloads back onto the Data Quality tab (`sessionStorage` `nseReopenTab`, handled at the end of `showDashboard()`). ~10 s for TradingView + ~70 s reprocess for 16 events.
2. Every `process_data()` run (server start, Refresh Data, reprocess) reads the CSV via `load_demerger_corrections()` and `add_demerger_corrections()` folds each `adjusted` row into the SAME `corp_events` structure split/bonus events use — *before* `bridge_split_induced_isin_changes()` and `apply_split_adjustments()` — as ratio `1/FACTOR`. So corrections get identical treatment to splits (ISIN re-resolution by symbol, `prev` boundary at the ex-date, compounding with other events, 2-decimal rounding) with no separate adjustment code. Corrected events are removed from the Data Quality list (`corrected_keys`, keyed by normalized symbol + ex-date — never the feed's possibly-stale ISIN).
3. `needs_processing()` also watches the CSV's mtime, so hand-editing it and restarting takes effect. **Deleting a row undoes that correction.** A no-change button click (only `CHECKED_AT`/notes changed) `os.utime()`s `processed_data.json` so the next start doesn't reprocess for nothing.

**`DemergerAdjustments.csv`** — `ISIN,SYMBOL,EXDATE,FACTOR,STATUS,CHECKED_AT,NOTE`, newest ex-date first, written atomically. `STATUS`: `adjusted` (FACTOR applies: multiply pre-ex-date prices by it), `tv-unadjusted` (TradingView shows no adjustment either — e.g. events with no real discontinuity, or one TradingView doesn't handle), `inconclusive` (prices didn't line up / stock not found / history too short). Only `adjusted` changes any price; the other rows just explain why an event is still listed and are re-checked on the next click. Lives in the git-ignored `NSE_DATA/` next to `CorporateActions.csv`; the PowerShell downloaders never touch it.

**Deriving the factor (`tv_adjust.derive_correction`)**: with r(t) = TradingView close / our close, r is one constant before the ex-date (demerger factor × any dividend adjustment TradingView layers on) and another from the ex-date on (dividends only, normally 1). Factor = median r over the last 3 bars before ex-date ÷ median r over the first 3 bars from ex-date on — the boundary ratio cancels dividend adjustment. Safeguards, all leaving the event listed rather than applying a bad number: r must be flat on each side (tolerance `0.2% + 1%/price`, since our prices carry 2 decimals), ≥2 matching bars each side, |factor−1| > 0.3% to count as an adjustment (else `tv-unadjusted`), factor within 0.02–50. Verified against 16 real events: 10 came back with a clean constant factor (VEDL 0.37597, INDIAGLYCO 0.20653, HEGAM 0.36349, TRIVENI 0.6176, DCMSRIND 0.32069, ALLCARGO 0.35204, SKFINDIA 0.47814, SHANKARA 0.25139, TMPV 0.60372, HINDUNILVR 0.98451); 6 were `tv-unadjusted` (3 demergers with no visible discontinuity, 2 NCRPS bonuses, and `GUJENERGY`, whose real −11.7% gap TradingView also leaves in). Notably `HINDUNILVR`'s true demerger effect is only 1.55% while the raw ex-date move was −5% (mostly market) — why a TradingView factor beats inferring one from the gap.

**Talking to TradingView (`tv_adjust.py`, stdlib-only — no websocket package installed/needed):** TradingView Desktop must be started with `--remote-debugging-port=9222` (server option `--tv-port`, default 9222) and have a chart open. `_CDPConnection` is a ~60-line RFC 6455 client for the Chrome DevTools Protocol; `TradingViewChart` (context manager) finds the chart page via `http://127.0.0.1:<port>/json`, records the chart's symbol + resolution, and **restores both on exit**, so a run leaves the user's chart as it found it. Bars are read through the page's own chart API — `TradingViewApi._activeChartWidgetWV.value()`; `setSymbol()`/`setResolution('1D')`, wait until `mainSeries()` `symbolInfo().full_name` matches, `!isLoading()` and the bar count is stable (two identical readings 250 ms apart), then `bars().valueAt(i)` → `[time, o, h, l, c, v]`. (`exportData()` is not available on this account.) TradingView tickers write `&`/`-` as `_` (`tv_symbol()`), and the opened symbol's short name is verified against the requested one. Bar timestamps are 09:15 IST session opens → `ist_date()`. `TradingViewConnectionError` (not reachable / dropped) aborts the run — partial results are still saved — while per-stock failures (symbol not found, timeout) just record `inconclusive` and continue.

**UI (`js/data-quality.js`):** `dqRenderCorpActions()` renders the table with a "TradingView check" column from `_dqTv.corrections`; `dqRunTvAdjust()` starts a run and `dqPollTvAdjust()` polls `/api/tv-adjust/status` every 600 ms showing live progress ("Checking VEDL on TradingView (7/16)"); `dqLoadTvState()` (on every render) labels rows and resumes the progress display if a run is already in flight. Errors (e.g. "TradingView is not reachable on port 9222. Start TradingView Desktop with …") show in red beside the button.

**Verified end-to-end** on an isolated copy of the data (real TradingView Desktop, real button click through the UI): 17 listed → 7 after the run; e.g. `VEDL` 29-Apr close 773.6 → 290.85 (= TradingView's 290.85), 52W high 795 → 360, distance from 52W high 66.5% → 26%; `INDIAGLYCO` 52W high 1222 → 322.8; `GUJENERGY` (unconfirmable) untouched. Also verified: a second click with nothing new checks the remaining events, corrects nothing and skips the reprocess; deleting a CSV row + restart puts that event back, unadjusted, while the others stay corrected; the wrong-port error path; POST without the `X-Requested-With` header → 403; the TradingView chart symbol/resolution restored after every run.

**Known scope limits:**
- Server-only, like split/bonus adjustment: the client-side CSV/cache fallback path (`js/data-processor.js`) applies no corrections.
- A snapshot, not a live feed: when a new demerger appears in the list, click the button again. Factors are relative to our own prices at check time, so later splits/bonuses still compose correctly.
- Prices are rounded to 2 decimals after adjustment (same as splits) — cheap stocks (e.g. `ALLCARGO` ≈ ₹10) carry ~0.05% rounding noise in adjusted history.
- The button needs TradingView Desktop running with the debug port; there is no other way to obtain the data, and nothing is ever attempted automatically.

---

## Completed: Verifying Adjusted Prices Against TradingView

**Purpose (from the user):** list every stock whose prices we adjusted, and let them check on demand that our adjusted prices match what they see on TradingView, flagging any major discrepancy.

**Flow:** Data Quality → "Price Adjustments Applied" → "Verify against TradingView" → `POST /api/tv-verify/start` → `run_tv_verify()` (background thread; read-only, no price changes, no reprocess/reload). For each stock to check it loads TradingView's daily history back to the earliest date in our retained window, compares daily closes over every shared date (`tv_adjust.compare_series`), and merges the result into `NSE_DATA/TradingViewVerification.json` (survives reloads and restarts; the tab shows "Last verified …"). Restores the user's chart symbol/resolution afterwards; refused (409) while a correction run is active.

**Verified stocks leave the list until their adjustments change (user request: "remove the stocks verified, until there is no new adjustment made"):** each saved per-stock result records `events` — the stock's adjustments at check time as `[[exDate, factor], ...]`. A result only counts if it still equals the stock's *current* adjustments (`adjustments_match()` server-side, `dqSameAdjustments()` client-side; order-insensitive, factors within a 1e-6 relative tolerance), so a new split/bonus, a new TradingView correction, or an edited factor makes the old "match" stale and the stock reappears as "Awaiting verification — its adjustments changed since it was last checked". By default a run only checks stocks whose current result isn't `match` — new/changed ones plus anything still flagged — so a repeat run takes seconds instead of ~5 minutes; `?all=1` (the "Re-check verified stocks too" checkbox) re-checks everything. Results are *merged* (obsolete entries — stock gone from the list, or adjustments changed — are pruned; the calendar finding is only recomputed by runs of ≥10 stocks, smaller re-checks keep the earlier one). Results saved before `events` existed simply count as unverified. Only `match` hides a stock: flagged stocks (e.g. ones where TradingView applies an adjustment we don't have) deliberately stay visible and are re-checked on each run, since hiding them would defeat the flagging — an "acknowledge/dismiss a known TradingView difference" mechanism would be the natural follow-up if that becomes noise.

**History loading:** TradingView only loads ~300 daily bars up front, which would leave older events unverifiable. `_JS_LOAD_BARS` therefore calls the series' `requestMoreData(300)` (300 bars per call, up to the stock's full history) until the first bar reaches `since`. Without this a comparison only covers ~1 year and older split boundaries fall outside it.

**Grading (`compare_series`):** a bar "differs" when |TradingView/ours − 1| > 1% + 0.01/price (2-decimal rounding matters for cheap stocks). `match` = no bar differs; `minor` = some bars differ, worst < 5% and < 5 bars; `major` = worst ≥ 5% or ≥ 5 bars differ (a sustained shift, e.g. a wrong ratio); `inconclusive` = < 20 shared bars, or every event of the stock predates the shared history (both sides already on the post-event scale, so the adjustment can't be tested — deliberately not a hollow "match"). Problems sort to the top of the table with a red tint for `major`.

**Explaining a difference (`_explain_level_changes`):** given the stock's own events, each level change in r(t) = TradingView/ours is classified: next to one of our events and equal to that event's factor → "TradingView shows no adjustment for the DD-Mon event"; next to one of ours but a different size → "Adjustments differ"; nowhere near any event of ours → "TradingView also scales prices before DD-Mon by ×G, which the dashboard has no event for (a rights issue or other action missing from the corporate-actions data?)". Several events on one day compound; a step immediately undone on the next bar is a one-bar blip, not a level change.

**Calendar differences:** dates inside the shared range that only one side has, reported when they appear for at least half the verified stocks. Found on real data: TradingView has **01-Feb-2025 and 01-Feb-2026** (the Budget-day special trading sessions, a Saturday and a Sunday) that the dashboard lacks — the downloader evidently skips weekends. Not fixed; it slightly shifts SMA windows by one bar and is separate from price adjustment.

**Results on real data (203 stocks, full ~510-day window):** 193 match (largest single-bar difference 1.15%, median 0.00% — i.e. our split/bonus/demerger adjustments agree with TradingView), 1 minor, 9 major. **In every major case but one the mismatch is at a date where the dashboard has no event** — TradingView applies a one-off adjustment the corporate-actions feed doesn't carry (`DELPHIFX` ×0.932 before 14-Oct-2025, `SHRADHA` ×0.8634 before 16-Sep-2025, `IRISDOREME` ×0.7349 before 13-Mar-2025, `ABINFRA` ×0.902 before 10-Mar-2025, `NARMADA` ×0.754 before 16-Sep-2024, `KILITCH` ×0.9786 before 15-Jul-2025, `TTL` ×0.974 before 4-Jul-2025). Most plausibly rights issues: `Download-NSE-Bhavcopy.ps1` keeps only `bonus|split|sub-division|consolidation of equity shares|demerger` rows, so anything else never reaches `CorporateActions.csv` (not confirmed against NSE's unfiltered feed). The exception is `LEMERITE`, where the TradingView/dashboard ratio is exactly 5.0 until its 29-May-2026 split (×0.2) and 1.0 after — TradingView is simply not split-adjusted for it. `SUMEETINDS` is the alarming one: our adjusted price is ₹0.77 in Sep 2024 against TradingView's ₹13.30 (TradingView scales pre-19-Jun-2025 prices by ×19.96) — a large discontinuity around 19-Jun-2025 that the dashboard doesn't adjust and that sits beyond the Data Quality list's ~370-day window, so it was invisible before.

**Blind spot this exposed:** the "Not Price-Adjusted" list only covers the last ~370 days, but the dashboard keeps ~510 trading days of prices (charts, 1-year money flow), so an unadjusted event 370–700 days old distorts stored prices without being reported anywhere. Worth widening if it matters.

**Verified end-to-end (isolated copy, real TradingView):** first run checked all 203 stocks in 4.5 min (193 verified, 10 flagged → the list dropped from 227 rows to the 11 rows of the flagged stocks); a second click re-checked only those 10 ("(1/10)") in 19 s and left the 193 verified results and the calendar finding intact; the "Show verified" toggle restored all 227 rows with problems on top. Then VEDL's stored factor was deliberately corrupted (0.376 → 0.30): after a restart VEDL reappeared as "Awaiting verification — its adjustments changed", the next run checked just the 11 pending stocks in 21 s and flagged VEDL **MAJOR** ("Adjustments differ at 30-Apr-2026: dashboard ×0.3, TradingView ×0.376" — i.e. it recovered the correct factor); restoring the factor made VEDL pending again, it verified as a match, and left the list.

**Known scope limits:** compares closes only; a chart with TradingView's "adjust for dividends" enabled shows small steady differences (the dashboard applies no dividend adjustment); read-only, so it flags but never corrects (the only correction path is the demerger button above, and only for events in the "Not Price-Adjusted" list).

---

## Completed: Reprocess Data Page (`pages/reprocess.html`)

**Goal:** an in-dashboard way to force a reprocess (e.g. after a code fix, or to pick up an already-refreshed `CorporateActions.csv`) without needing a terminal — a "Reprocess Data" button on the main page, a dedicated page showing live progress, and a way back to the dashboard when it's done.

**Server-side (`nse_server.py`):** the pre-existing `GET /api/reprocess` is **blocking** — it doesn't respond until `process_data()` + save fully complete (~30-90s), which the PowerShell scripts' own post-download auto-trigger relies on (waits for completion before printing its "reprocessed automatically" message) — left completely unchanged. A **new**, separate pair was added for the interactive page instead of changing that endpoint's behavior:
- `GET /api/reprocess/start` — starts `process_data()` in a background `threading.Thread` (guarded by `_reprocess_lock` so a second call while one's already running just returns `{"alreadyRunning": true}` instead of starting a duplicate) and returns immediately. Because the heavy work moves off the server's single request-handling loop, every other endpoint (`/api/status`, page loads, etc.) keeps responding normally throughout — a real, if secondary, fix for a problem hit earlier in this same session: the old blocking `/api/reprocess` used to freeze the *entire* server, nothing else could be served, for the whole run.
- `GET /api/reprocess/status` — returns the shared `_reprocess_state` dict (`status`: `idle`/`running`/`done`/`error`, `step`, `startedAt`, `finishedAt`, `error`, `stocks`). `process_data()` gained an optional `progress_cb` parameter, called at each major phase via a small `report()` closure that both prints (unchanged console behavior) and forwards the same message to the callback — reading bhavcopy, applying split/bonus adjustments, loading sector mapping, computing indicators, processing price band, computing the EW index, saving. `pages/reprocess.html` polls this every ~600ms.

**Client (`pages/reprocess.html`, new standalone page, not part of the SPA)**: on load, calls `/api/reprocess/start` then polls `/api/reprocess/status`. Shows a spinner + the current phase text + a live elapsed-time counter while running; on `done`, shows a checkmark, the stocks-processed count, and a "Back to Dashboard" button (`location.href='index.html'`); on `error`, shows the error message and both "Back to Dashboard" and "Try Again" buttons. Styled with the dashboard's own `css/styles.css` (dark theme, `.btn`/`.btn-primary`/`.btn-secondary`) so it looks native rather than a bare unstyled page.

**Entry point:** a "Reprocess Data" button added to `index.html`'s header (top-right, `margin-left:auto`), linking to `pages/reprocess.html`.

**Verified:** button renders and links correctly; the page's spinner, phase text, and live elapsed-time counter all work correctly client-side even before a server restart (confirmed the polling loop correctly retries through repeated 404s against the pre-restart server, exactly as expected, since the new endpoints don't exist until the code-loading process is restarted — same restart caveat as any other server-side change in this project, see "Development Notes" below).

**Reprocess, scoped precisely:** neither `/api/reprocess` nor `/api/reprocess/start` ever touches `NSE_Bhavcopy_Combined.csv`, `NSE_PriceBand_Combined.csv`, or downloads anything from NSE — `process_data()` only *reads* those files as they currently exist on disk and regenerates `processed_data.json` from them. Fetching new data and merging it into those combined CSVs is done entirely by the PowerShell scripts, which call `/api/reprocess` themselves once that's done. Reprocessing bad/missing data in the source CSVs faithfully reproduces the same bad/missing output — only a fresh PowerShell download fixes that; reprocess only helps when the *code* changed or the cached JSON is stale/corrupted relative to already-correct source CSVs.

**Refresh Data (added later):** a primary "Refresh Data" button next to "Reprocess Data" on `index.html` → `pages/reprocess.html?refresh=1`, which calls `GET /api/reprocess/start?download=1`. The background worker first runs `Download-NSE-Bhavcopy.ps1 -NoPause` as a hidden `powershell` subprocess (stdout mirrored line-by-line into `_reprocess_state['step']` as "Downloading: ..."; nonzero exit -> `error` with the last output lines), then runs the normal `process_data()` + save, and the page auto-redirects to `index.html` ~1.2s after `done`. `_reprocess_state` gained a `mode` field (`reprocess`/`refresh`). The downloader's new `-NoPause` switch skips its "Press any key" prompts **and** its own end-of-run `/api/reprocess` call (the server does the reprocess itself). Interactive double-click runs are unchanged. Like all server-side changes, needs a server restart to take effect. Verified end to end on a temp server (~80-90s total, 2900 stocks).

**Single download implementation:** `Start-Dashboard.ps1` used to carry a ~600-line copy of the downloader's download + merge code that had to be edited in lockstep. It now just runs `& Download-NSE-Bhavcopy.ps1 -NoPause -StartFrom $StartFrom` (nonzero exit -> message, wait for key, don't launch), then does only the launch work (kill old server on 8765, Job Object, start `nse_server.py`, open browser). **All download/merge logic lives only in `Download-NSE-Bhavcopy.ps1`** — Start-Dashboard, the double-clickable downloader, and the dashboard's Refresh Data button all use it. Dropped as a result: Start-Dashboard's `$SkipDownload` "already up to date" shortcut (cosmetic - the downloader finds nothing new and moves on). A pre-change copy was kept as `Start-Dashboard.ps1.bak` (safe to delete). Verified with a temp-port copy of the launcher: download step ran, server started and answered `/api/status`.

**Data Files popup:** a "Data Files" button in `index.html`'s header (left of Refresh Data) opens a modal (`#dataFilesModal`, `openDataFiles()`/`closeDataFiles()` in `js/ui.js`) fed by a new `GET /api/files` (`get_data_files_info()` in `nse_server.py`). It reports, for the Bhavcopy (`Bhavcopy/BhavCopy_CM_YYYYMMDD.csv`) and Price Band (`PriceBand/sec_list_DDMMYYYY.csv`) folders: latest date, file count/date range, and the newest file's mtime ("downloaded"); plus size + last-written time for the combined CSVs, EQUITY_L, MidSmallcap 400, corporate actions, sector mapping and `processed_data.json`. Dates come from the **filenames**, not file contents (the combined price band CSV has no date column). The two dates can legitimately differ (NSE publishes price band files separately; e.g. Bhavcopy 24-Sep vs Price Band 23-Sep). MidSmallcap 400 / corporate actions mtimes reflect the last content change (`Save-IfChanged`), not the last check. The header's single "Latest:" is unchanged (Bhavcopy date). Needs a server restart.

**Threaded server + cache warm-up (fixes slow/unstable page loads):** the server used to be a single-threaded `http.server.HTTPServer`, so it blocked on any idle connection Chrome kept open (CPU idle, yet even `/api/status` hung for minutes; this also made the Data Files popup sit on "Loading..."). Now `ThreadingNSEServer` (`ThreadingHTTPServer`, `daemon_threads`, `request_queue_size=128`) handles each connection in its own thread. A module-level `_cache_lock` (RLock) guards `processed_data.json` and the gzipped caches: `_serve_data`/`_serve_daily` take it while ensuring/building the cache, and both reprocess paths hold it across process + save + cache invalidation, so no request reads a half-written JSON or rebuilds the cache twice. The cache builder is now `NSEHandler._build_cache(base_dir)` (classmethod); `run_server` warms it in a background thread at startup, and the reprocess worker rebuilds it as a "Preparing dashboard data..." step before reporting done, so the first page load after a restart/refresh doesn't pay for it. Measured on a temp server with 3 idle connections held open: all requests served; a data request arriving during warm-up waited ~15s for the build, and after that `/api/data?lite=1` answered in ~3ms. Not done (deferred): skipping the unused full-data gzip variant (`/api/data` without `?lite`), which would shorten the ~15s build. Note: use `127.0.0.1` rather than `localhost` in scripted clients on Windows (IPv6 fallback adds ~2s).

---

## Planned: Exclude F&O Stocks Filter (Analysis Needed)

**Goal:** Add a screener filter to exclude or include only F&O eligible stocks (F13/F14 are now used for industry filters; this would be F15).

**Data source identified (STALE — needs re-verification):** `https://www.nseindia.com/api/equity-stockIndices?index=SECURITIES%20IN%20F%26O` — this whole endpoint family is now confirmed **retired** (see "Known quirks" under the PowerShell script; every `equity-stockIndices` query 404s, not just MidSmallcap 400). Before implementing this filter, find the F&O-list equivalent under NSE's new `/api/NextApi/apiClient/marketWatchApi` gateway the same way the MidSmallcap 400 fix did — check the live site's network requests for the F&O securities page, and look up the correct short `symbol`/`functionName` via `functionName=getIndexList` if it's index-shaped, or find the dedicated F&O-securities endpoint if it's not.

**Open questions:**
- Should the PowerShell script download and cache this list as a local CSV? The API requires browser-like headers (same as other NSE endpoints), and per the Accept-Encoding quirk above, must omit `Accept-Encoding` from the whole session if it's a JSON API on `www.nseindia.com`.
- Or should the dashboard fetch it at runtime from NSE? (Same CORS limitations as other NSE API calls.)
- Should it be "Exclude F&O" or "F&O Only" or a toggle for both?
- The F&O list changes periodically (NSE adds/removes stocks) — how often should it refresh?

**Implementation sketch:**
- PowerShell downloads the F&O list during each run, saves as `NSE_DATA/FnO_Stocks.csv`
- Dashboard loads it alongside other data files
- New filter checkbox in screener: "Exclude F&O stocks" / "F&O stocks only"
- Simple set lookup: if stock symbol is in F&O set, include/exclude based on filter

---

## Completed: Equal-Weight Nifty MidSmallcap 400 Chart

**Goal:** Show an equal-weight index chart for Nifty MidSmallcap 400, giving a better read on market breadth than the cap-weighted official index.

**Why:** The official Nifty MidSmallcap 400 is market-cap weighted, so a few large stocks dominate the movement. An equal-weight version (each stock = 0.25%) shows what the "average stock" is doing — reveals whether a rally/decline is broad-based or driven by heavyweights.

**Data source:** `https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20MIDSML%20400` — returns JSON with all ~400 constituent stock symbols and current data (see "Known quirks" under the PowerShell script for the endpoint migration and header gotchas).

### Phase 1 — Data Acquisition (DONE)

**Files modified:** `Download-NSE-Bhavcopy.ps1`, `Start-Dashboard.ps1`

Both scripts now download the MidSmallcap 400 constituent list from the NSE API after EQUITY_L.csv:
- **URL:** `https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20MIDSML%20400` (the short index code, not the display name — see "Known quirks" above)
- **Response:** JSON — `data.data` array with stock objects; the index summary row (`series: null`) is mixed in with the 400 constituent rows (`series: "EQ"`)
- **Processing:** Filters to rows where `series` is truthy (excludes the index summary row — more robust than matching the index's display name, which the old API required), extracts `symbol`, sorts alphabetically
- **Output:** `NSE_DATA/MidSmallcap400_Constituents.csv` — single-column CSV with header `SYMBOL` and ~400 rows
- **Error handling:** Non-fatal — warns and continues if download fails; dashboard will hide the chart section if file is missing
- **Refresh:** Downloaded on every run (overwrites previous, no history kept — see the point-in-time caveat in Design Decisions below); the constituent list changes periodically as NSE adds/removes stocks
- Uses existing `$Session` / `$ApiHeaders` (no `Accept-Encoding` — see "Known quirks" above) cookie-based auth

### Phase 2 — Server-Side Processing (DONE)

**Files modified:** `nse_server.py`

- `compute_equal_weight_index(base_dir, daily_by_symbol, symbol_to_isin, dates)` — loads `MidSmallcap400_Constituents.csv`, maps each `SYMBOL` to ISIN via `symbol_to_isin`, then builds equal-weight OHLC+turnover bars across the **full history available** in the combined bhavcopy (not windowed — grows automatically as more days accumulate)
- **Return basis:** each constituent's own `prev` field (PREV_CLOSE from bhavcopy, already present on every daily record) is used as that stock's per-day return reference — `ret = price / prev - 1` for open/high/low/close — so individual listing gaps or missing days don't skew the average; a stock simply drops out of that day's average (`count` shrinks) instead of breaking the calc
- **Compounding:** index starts at base 1000; each day's O/H/L/C = previous index close × (1 + average return of that field across all constituents with valid data that day). Averaging preserves per-stock ordering (high ≥ open/close, low ≤ open/close), so the resulting index candle is valid with no extra clamping — verified with 0 ordering violations
- **Turnover:** summed (lakhs) across all constituent stocks trading that day — used as the volume-bar value
- **History window:** uses the **full date range available** in the combined bhavcopy, not a fixed lookback — grows automatically as more days accumulate (originally windowed to 250 days/~1 year; removed after the user pointed out ~2 years of data already existed and wasn't being shown)
- Output shape: `{cols: ['date','open','high','low','close','turnover','count'], bars: [[...], ...], constituentCount}` — compact array-of-arrays per bar (not objects) to keep payload small
- Added as `ewIndex` key in `process_data()`'s result dict; automatically included in the lite payload (lite only excludes `dailyBySymbol`/`dailyCols`)
- `needs_processing()` now also watches `MidSmallcap400_Constituents.csv`'s mtime, so a refreshed constituent list triggers reprocessing
- Returns `None` (not an error) if the constituents CSV is missing or no constituents resolve to an ISIN — client should hide the chart section in that case (Phase 3)
- **Verified:** ran `process_data()` directly against live data — 400/400 constituents resolved, 506 bars produced (full ~2-year history, 02-Sep-2024 to latest), index ranged 787.61–1058.56, payload size 33 KB

### Phase 3 — Client-Side Rendering (DONE)

**Files added:** `js/ew-index.js`, `js/lib/lightweight-charts.standalone.production.js`

- Uses **TradingView Lightweight Charts v5.2.1**, vendored locally (Apache-2.0, standalone UMD build, no CDN) rather than the originally-planned vanilla-canvas approach — chosen for chart quality (built-in crosshair, tooltip, zoom/pan) at the user's request. This is the **first external library dependency** in the project; everything else remains pure vanilla JS.
- `ewEnsureChart()` creates the chart lazily, the first time the EW Index tab is actually clicked — Lightweight Charts measures the container's real size on creation, and the panel is `display:none` until its tab is active, so eager creation at dashboard-load time would size it 0×0. `autoSize: true` handles ongoing resizes after that.
- `renderEWIndexChart()` builds a candlestick series (`ew.bars` open/high/low/close) and a histogram series for volume (bottom pane, `scaleMargins` split from the price scale), colored green/red by up/down day. Dates (`dd-Mon-YYYY`) convert to Lightweight Charts' `{year,month,day}` business-day time via `ewToBusinessDay()`.
- 20/50/200 SMA checkboxes compute simple moving averages client-side from the index's own closes (`ewComputeSMA()`) and render as overlay line series; toggling a checkbox re-renders just that line.
- Crosshair, tooltip-on-hover (date/OHLC/value via the library's built-in crosshair), and zoom/pan all come free from the library — no hand-rolled interaction code needed.
- Tab visibility: `updateEWIndexTabVisibility()` (called from `showDashboard()`) hides the "EW Index" tab entirely when `Store.ewIndex` is missing/empty, rather than showing an empty panel.

### Phase 4 — HTML, CSS & Wiring (DONE)

- `index.html`: new `<div class="tab" data-tab="ewindex" style="display:none;">EW Index</div>` tab button (starts hidden, shown by `updateEWIndexTabVisibility()`) and `panel-ewindex` div (MA checkboxes + `#ewChartContainer` + constituent-count info line) placed after Industry Analysis; `<script>` tags for the vendored library and `js/ew-index.js` added after `industry.js`
- `css/styles.css`: `.ew-controls` (flex row for title/checkboxes/info), `#ewChartContainer` (`height: 520px`)
- `js/store.js`: added `ewIndex: null` property
- `js/nse-download.js`: `Store.ewIndex = data.ewIndex || null` added to the Phase-1 lite-data population in `tryAutoFetchJSON()`
- `js/ui.js`: `showDashboard()` calls `updateEWIndexTabVisibility()`; the tab-click handler calls `renderEWIndexChart()` specifically when the `ewindex` tab is clicked (not eagerly on load — see lazy-creation note above)
- `.claude/launch.json` added (`python src/nse_server.py`, port 8765) so the dashboard can be previewed via the Claude Code browser tooling

### Design Decisions

- **Placement:** Own top-level tab ("EW Index"), not nested inside Market Breadth as originally sketched — simpler wiring, and the candlestick chart deserves its own space rather than competing with the existing breadth bars/charts
- **Charting library:** TradingView Lightweight Charts (vendored locally, not CDN) instead of hand-rolled canvas — explicit tradeoff of "zero dependencies" for chart usability, made deliberately for this one feature
- **No index dropdown for now** — start with MidSmallcap 400 only; adding Nifty 50/500 later is just more constituent lists + a dropdown
- **Current constituents applied historically, retroactively — accepted tradeoff, discussed explicitly with the user.** `MidSmallcap400_Constituents.csv` is overwritten (not versioned) on every download, and `compute_equal_weight_index()` applies whatever list is on disk *today* across the *entire* history. This means a stock swap at NSE's semi-annual rebalance reshapes past bars too (the newly-added stock's pre-membership price history gets folded in; the dropped stock disappears retroactively) — the chart is **not a stable historical record**; the same past date can show a different value after the next rebalance. Diluted across 400 stocks with typically ~10-20 swapped per rebalance, so the effect is usually small. A proper fix (point-in-time constituent snapshots, mirroring how `PriceBand/` keeps one file per day, plus a per-date lookup in `compute_equal_weight_index()`) was scoped as easy-to-moderate (a few hours, no new dependencies) but explicitly **not built**, because it can only prevent *future* rebalances from distorting history — the ~2 years of history that already exist can't be corrected retroactively, since no historical constituent list was ever captured. User chose to keep the simple approximation given that limited payoff.
- **Missing stocks on a given day:** excluded from that day's average (N adjusts per day)
- **Lite payload:** ewIndex is ~15KB — negligible, included in lite for instant rendering
- **Volume proxy:** turnover (₹ lakhs, summed across constituents) rather than raw share volume — avoids skew between high-priced and low-priced stocks, and matches the turnover convention used throughout the rest of the dashboard
- **Verified in-browser:** ran a temporary server instance, forced a reprocess, confirmed the tab appears/hides correctly, candlesticks + volume + both SMA overlays render, crosshair/tooltip work, and no console errors — before restarting the user's live server

---

## Development Notes

### Adding a New Screener Filter

1. Add UI controls to `index.html` inside the screener filter panel
2. Add field IDs to `SCREENER_FIELDS` array in `js/presets.js` (for preset save/load)
3. Read values and implement filter logic in `runScreener()` in `js/screener.js`
4. Optionally add dynamic columns in `renderScreenerTable()`
5. Add default reset values in `resetScreener()`

### Adding a New Tab

1. Add a `.tab` button in the tab bar in `index.html`
2. Add a `.panel` div with `id="panel-<tabname>"` in `index.html`
3. Tab switching is automatic via the event listener in `js/ui.js`
4. Call your render function from `showDashboard()` in `js/ui.js`
5. Create a new JS file and add a `<script>` tag in the correct load order position

### Unit Conventions

- Turnover: internal = lakhs (converted from absolute rupees during PS1 merge); user-facing = crores (1 Cr = 100 L)
- Market cap: internal = crores; displayed with `fmtCr()` (auto K Cr / L Cr)
- Percentages stored as plain numbers (e.g., `5.23` means `5.23%`)

### Browser Requirements

- Modern browser with IndexedDB, Canvas 2D, FileReader API
- Pure vanilla JS, with one exception: TradingView Lightweight Charts (vendored locally at `js/lib/`, not CDN) for the EW Index tab — everything else remains dependency-free
- CORS restrictions may block live NSE downloads (fallback: manual upload or PowerShell script)

### Project layout (reorganised)

Python moved to `src/` (`src/nse_server.py`, `src/tv_adjust.py`) and `reprocess.html` to `pages/`; `index.html` and its `css/` + `js/` stay at the top level. Everything that depended on the old locations was updated: the server's default project root (now the parent of `src/`), the launcher's `$ServerScript`, the two `index.html` buttons and the page's stylesheet/back links, `.claude/launch.json`. **The reprocess page's URL is now `/pages/reprocess.html`** — an old `/reprocess.html` bookmark 404s. `Download-NSE-Bhavcopy.ps1` and `Start-Dashboard.ps1` stay at the top level (the downloader derives the project root from its own folder, so moving it is a separate change). Run the server with `python src/nse_server.py`.

### Server restarts — when they're actually needed

Recurring source of confusion during development, worth stating plainly:
- **JS/HTML/CSS changes** — take effect on the **next browser reload**, no server restart needed. `nse_server.py` serves these as static files with `Cache-Control: no-cache` specifically so this always works.
- **`nse_server.py` code changes** — need the Python **process restarted**. Editing the `.py` file has zero effect on an already-running process; Python doesn't hot-reload.
- **Restart alone often isn't enough**, either: on startup, `run_server()` only calls `process_data()` if `needs_processing()` says the cached `processed_data.json` is older than the watched CSVs. If only the *code* changed (not any CSV), the fresh process just loads the same old cached JSON, computed by the old (pre-fix) code, and the fix appears to do nothing. A **forced reprocess** (`/api/reprocess`, `/api/reprocess/start`, or the "Reprocess Data" button → `pages/reprocess.html`) is needed after every restart-for-a-code-fix, to actually recompute output with the new code. This exact sequence — fix code, restart, reprocess — was needed repeatedly while landing the split/bonus adjustment fixes above.
- **The single-threaded server can appear to hang** under normal use — `nse_server.py` uses plain `http.server.HTTPServer`, which handles one request at a time. A long-running blocking request (the old `/api/reprocess`, or a slow/stalled client mid-download of a large gzip payload) can make the *entire* server unresponsive, including simple health checks, until that one request finishes or errors out. `/api/reprocess/start`'s background-threading (see "Reprocess Data Page" above) fixes this specifically for reprocessing; the same class of issue could in principle recur elsewhere since the server still isn't `ThreadingHTTPServer` — a possible future hardening if it comes up again.

---

## Completed Implementation History

### Industry Analysis Money Flow Table + Shared Chart Popup Overhaul (Completed)

A multi-session round of feature additions to Industry Analysis and the shared Industry/Stock Charts popup (`js/industry-charts.js`), all at the user's request.

**Money Flow, Industry Analysis (`js/industry.js`):**
- Added a **1-Week period** (`'1w': 5` trading days) to `computeIndustryMoneyFlow()`'s period map, and to the Stock Scanner's F12 filter dropdown — both now share the exact same function, so this was a two-line change plus a label-map update in each caller.
- Added an **"All-periods table"** view: `computeAllPeriodsMoneyFlow(minStocks, minMcap)` calls `computeIndustryMoneyFlow()` once per period (1W/1M/3M/6M/1Y) and aggregates per industry, respecting the same Min Stocks/Min Market Cap filters as the main table. `renderMoneyFlowAllPeriodsTable()` renders it with click-to-sort headers (mirroring `screener.js`'s `renderScreenerTable`/`sortScreener` convention) — **sorting by % change, not raw turnover**, per explicit user correction, so the ranking shows where money is moving fastest rather than just the largest industries. The sort column auto-follows the Money Flow Period dropdown (`_mfAllPeriodTrack`) unless manually overridden by clicking a column, and the table takes over the RS bar chart's screen position (not a separate section further down) when toggled on.
- Clicking an industry (table row / heatmap card / chart bar / all-periods table) now opens `openIndustryCharts()` — the same rich chart popup Stock Scanner uses — instead of a bare-table-only popup (`showIndustryStocks()`, now removed as dead code).
- **Bug found while wiring the above:** `#industryChartsModal` was nested inside `#panel-screener` in `index.html`. Since a `.panel`'s `display:none` cascades to everything inside it, the popup silently failed to render (despite its own `.active` class being set correctly) whenever opened from any tab other than Stock Scanner. Fixed by moving the modal markup to be a top-level sibling of the tab panels.
- **Bug found and fixed (twice):** `fmtCr()` already appends its own "Cr"/"K Cr"/"L Cr" suffix; two call sites (`industry-charts.js`'s chart-cell market cap, `industry.js`'s RS-chart hover tooltip) additionally appended a literal `" Cr"`, producing visible "Cr Cr" duplication (e.g. "14.8K Cr Cr").

**Chart popup (`js/industry-charts.js`), new features (see "Shared Industry/Stock Charts Popup" above for the current-state description):**
- Per-stock 50-day ADR / 50-day Avg Money Flow toggle checkboxes (on by default), reusing `computeDynADR`/`computeDynSMA` from `screener.js` rather than adding new calc logic.
- TradingView-style crosshair legend (OHLC, day change%, money flow) built once into the shared `icCreateChart()` via `chart.subscribeCrosshairMove()` — a Lightweight Charts API confirmed unused anywhere else in the codebase — so it works everywhere a chart renders (grid, single-stock, Industry Chart tab) with no per-caller code.
- 1×1/2×2 layout toggle (`icSetLayout()`), preserving the currently-viewed stock's position across the switch instead of resetting to page 1.
- Per-stock selection checkboxes + a global `selectedStocks` Set, "Copy Selected"/"Clear Selected" toolbar controls in both tabs (reusing the Stock Scanner's existing TV Watchlist modal/clipboard code), cleared on tab switch (`js/ui.js`) or page refresh only.
- Iterated on layout per explicit user feedback: OHLC/change%/money-flow moved from a background-boxed on-chart overlay to plain inline text on the same line as the stock name (no background, matching the name's own styling), with ADR/Avg MF on a plain line below it — the on-chart overlay is kept only as a fallback for the Industry Chart tab's synthetic index, which has no per-stock name line to attach to.
- Custom drag-to-measure tool (`icMeasureMode`) — the vendored Lightweight Charts library has no built-in ruler/measure tool, so this is hand-built via raw `mousedown`/`mousemove`/`mouseup` listeners (not `chart.subscribeClick`, to avoid library-specific click semantics) plus `coordinateToPrice`/`coordinateToLogical` for the math, disabling native pan/zoom while active. One measurement per chart at a time; a plain click or explicit "×" clears it.
- **Bug found and fixed while adding the measure tool:** the single persistent `#icIndustryChartContainer` (reused across renders for both single-stock mode and the Industry Chart tab) was never cleared between chart creations, so the legend overlay `<div>` (and later, the measure box/label) would silently accumulate as extra orphaned DOM elements every time that view was revisited. Fixed with `container.innerHTML = ''` at the top of `icCreateChart()`.
- Verified throughout via the Claude Code browser tooling (screenshots + direct DOM/state inspection); one testing caveat noted transparently to the user — this browser automation's synthetic drag gesture didn't reach the canvas's real `mousedown`/`mousemove` handlers (only the chart library's own crosshair reacted), so the measure tool's correctness was confirmed instead by dispatching genuine `MouseEvent`s directly, which matches what a real physical mouse drag produces.

### Stock Scanner Tab Correctness Review + Money Flow Bug Fix (Completed)

Full data-pipeline review of the default "Stock Scanner" tab (`panel-screener` / `js/screener.js`), from `process_data()` through filter logic to table rendering, at the user's request. Verified core indicators (`sma20`, `high52w`, `low52w`, `adr`, `changePct`, `monthlyChangePct`) by manually recomputing them from raw `Store.dailyBySymbol` data and comparing to server output — all matched exactly. All 14 filters' boundary conditions, unit conversions, and AND-combination logic were checked; F1–F11/F13/F14 had no logic errors.

**Bug found and fixed:** `computeIndustryMoneyFlow('1y')` ([industry.js:6](js/industry.js:6), used by both the Industry Analysis tab's money-flow sort and the Stock Scanner's F12 filter) needs a 250-day "current" window plus another 250-day "previous" window — 500 days of per-stock history. The server's `MAX_DAILY_DAYS` cap of 260 (see Python Server section above) meant the "previous" window was almost entirely empty for real stocks, producing grossly inflated money-flow percentages. Confirmed live before the fix: a sample stock showed `current=260,410` vs `prev=4,434` (should be similar magnitude), and every industry on the actual dashboard displayed 1,000–6,000%+ "money flow" at the 12-month setting — meaning the filter was silently non-functional at any reasonable threshold. `3m` (63 days) and `6m` (126 days) periods fit within the old 260-day cap and were unaffected.

**Fix:** raised `MAX_DAILY_DAYS` from 260 to 510 (250 + 250 + buffer) in `nse_server.py` — a one-line root-cause fix, since the server already computes everything from the full uncapped history before this truncation step; only the truncation threshold itself was wrong. Verified after the fix: the same sample stock now shows `current=260,410` vs `prev=417,498` (same order of magnitude, correct), and the live UI shows realistic double/triple-digit money-flow percentages instead of four-digit ones. Trade-off: the background "Phase 2" daily-data payload roughly doubles in size (still async/non-blocking, loaded after the dashboard is already interactive).

**Three more findings fixed on follow-up:**

- **F6 (ADR) now has a strict/partial split**, matching F1/F2/F4/F8/F10. `computeDynADR(days, length)` in `js/screener.js` is now strict (returns `NaN` if `days.length < length`, same convention as `computeDynSMA`); a new `computeDynADRPartial(days, length)` (min 5 bars) handles the "Partial history" case. F6's own filter check now explicitly tests `isNaN(dynADR)` and fails with `"F6: Insufficient data for N-day ADR"` instead of silently passing on a NaN comparison. Verified live: setting F6 to a 600-day length (unreachable given ~506 days of real history) with "Partial history" off correctly failed all 2,888 stocks with that message; turning "Partial history" back on dropped failures to 11 (only stocks with under 5 bars of real history — newly listed).
- **F1 and F2 no longer share one display column.** They used to overwrite the same `s._dynTurnoverSMA` field, so enabling both with different SMA lengths silently hid whichever filter "lost." Each now gets its own field (`s._dynTurnoverSMA_f1` / `_f2`) and its own table column, labeled plainly (`SMA T/O(Cr)`) when only one is active, or disambiguated (`F1 SMA(50) T/O(Cr)` / `F2 SMA(20) T/O(Cr)`) when both are on. Verified live with F1 len=50 + F2 len=20 simultaneously — both columns now appear with their correct, independent values. CSV export updated to match (`F1_SMA_Turnover`, `F2_SMA_Turnover` columns).
- **RS-score formula de-duplicated.** The identical rank-normalize + weighted-score logic that lived separately in `screener.js` (`computeIndustryRS`, used by F9) and `industry.js` (inline in `renderIndustryAnalysis`) is now one shared `computeRSScores(indList)` in `js/utils.js` (mutates each industry object in place with `*_rank` fields and `rsScore`). Both call sites now call this one function. Verified the Industry Analysis tab's RS scores are byte-for-byte identical to before the refactor (e.g. Oil & Gas-Field Services still 97, Oil & Gas-Integrated still 96) — the duplication was already consistent, this just guarantees it can't silently drift apart on a future edit to only one copy.

**Still open (not fixed, lower priority):**
- **`bandPct` display bug:** the server unconditionally appends `%` to the raw Band CSV value (`nse_server.py:316`), so the literal text `"No Band"` (which is what NSE's price-band file actually contains for unrestricted stocks) becomes `"No Band%"` — confirmed live in the rendered table (HDFCBANK, ICICIBANK, SBI, etc.). Doesn't affect F7's filtering (it strips `%` before comparing), purely cosmetic. The client-side CSV-fallback path (`data-processor.js:178`) has the opposite bug — it never appends `%` at all, so the two "mirrored" implementations have quietly diverged.

### CM-UDiFF Format Migration + ISIN-Based Grouping (Completed)

Migrated from the old `sec_bhavdata_full_DDMMYYYY.csv` bhavcopy format to the new CM-UDiFF format with ISIN support. All old-format backward compatibility code has been removed.

**Files modified:**
- `Download-NSE-Bhavcopy.ps1` — Switched to CM-UDiFF ZIP download, extraction, column mapping, turnover conversion (absolute rupees to lakhs), date conversion (ISO to dd-Mon-YYYY), EQUITY_L.csv download. Removed all old-format code paths.
- `Start-Dashboard.ps1` — No longer has its own download/merge code; it invokes `Download-NSE-Bhavcopy.ps1 -NoPause` (see "Single download implementation" below), so download/merge changes only go in the downloader.
- `js/store.js` — Updated comments, added `symbolToISIN` property.
- `js/data-processor.js` — Added ISIN/COMPANY_NAME column resolution, switched grouping from symbol to ISIN, built `symbolToISIN` map, updated `processBandData()` to use ISIN keys via bridge.
- `js/industry.js` — Money flow lookup changed from `normalizeSymbol(s.symbol)` to ISIN key.
- `js/screener.js` — Money flow lookup changed from `normalizeSymbol(s.symbol)` to ISIN key.
- `js/data-quality.js` — Cross-matching updated to bridge ISIN-keyed bhav data with symbol-keyed sector data using `bhavSymbolSet`.

**Files not modified (key-agnostic — iterate `Store.latestBySymbol`/`Store.dailyBySymbol` with `for (const key in ...)`):**
- `js/breadth.js`, `js/scanner.js`, `js/sector.js`, `js/ui.js`, `js/utils.js`, `js/cache.js`, `js/file-loader.js`

---

## File Locations

- **User's machine:** `C:\Users\vivek\Documents\NSE-StockScanner\`
- **Cloud workspace:** `/home/claude/NSE-StockScanner/` (working copies for editing)

When updating files, always commit to the user's disk at `C:\Users\vivek\Documents\NSE-StockScanner\` via `device_commit_files`.

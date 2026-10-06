// ═══════════════════════════════════════════════════════════════════════════════
// PRESETS — save/load screener filter presets via server API or IndexedDB
// ═══════════════════════════════════════════════════════════════════════════════

let _presets = {};  // { name: { filters... } }
let _presetsSource = 'none';  // 'api', 'idb', 'none'

// ── Filter field IDs to capture/restore ──
const PRESET_FIELDS = [
  { id: 'scrF1On', type: 'checkbox' },
  { id: 'scrF1Mult', type: 'number' },
  { id: 'scrF1Len', type: 'number' },
  { id: 'scrF2On', type: 'checkbox' },
  { id: 'scrF2Len', type: 'number' },
  { id: 'scrF2Val', type: 'number' },
  { id: 'scrF3On', type: 'checkbox' },
  { id: 'scrF3Val', type: 'number' },
  { id: 'scrF4On', type: 'checkbox' },
  { id: 'scrF4Val', type: 'number' },
  { id: 'scrF4Mult', type: 'number' },
  { id: 'scrF4SmaLen', type: 'number' },
  { id: 'scrF4MinTimes', type: 'number' },
  { id: 'scrF4Lookback', type: 'number' },
  { id: 'scrF5On', type: 'checkbox' },
  { id: 'scrF5Min', type: 'number' },
  { id: 'scrF5Max', type: 'number' },
  { id: 'scrF6On', type: 'checkbox' },
  { id: 'scrF6Len', type: 'number' },
  { id: 'scrF6Val', type: 'number' },
  { id: 'scrF7On', type: 'checkbox' },
  { id: 'scrF7_2', type: 'checkbox' },
  { id: 'scrF7_5', type: 'checkbox' },
  { id: 'scrF7_10', type: 'checkbox' },
  { id: 'scrF8On', type: 'checkbox' },
  { id: 'scrF8Len', type: 'number' },
  { id: 'scrF8Min', type: 'number' },
  { id: 'scrF8Max', type: 'number' },
  { id: 'scrF9On', type: 'checkbox' },
  { id: 'scrF9Val', type: 'number' },
  { id: 'scrF9MinStk', type: 'number' },
  { id: 'scrF9MinMcap', type: 'number' },
  { id: 'scrF10On', type: 'checkbox' },
  { id: 'scrF10_20sma', type: 'checkbox' },
  { id: 'scrF10_50sma', type: 'checkbox' },
  { id: 'scrF10_200sma', type: 'checkbox' },
  { id: 'scrF10_200ema', type: 'checkbox' },
  { id: 'scrF11On', type: 'checkbox' },
  { id: 'scrF11Sector', type: 'select' },
  { id: 'scrF12On', type: 'checkbox' },
  { id: 'scrF12Period', type: 'select' },
  { id: 'scrF12Val', type: 'number' },
  { id: 'scrF17On', type: 'checkbox' },
  { id: 'scrF17Period', type: 'select' },
  { id: 'scrF17Lag', type: 'select' },
  { id: 'scrF17Val', type: 'number' },
  { id: 'scrF18On', type: 'checkbox' },
  { id: 'scrF18_1m', type: 'checkbox' },
  { id: 'scrF18_3m', type: 'checkbox' },
  { id: 'scrF18_52w', type: 'checkbox' },
  { id: 'scrF13On', type: 'checkbox' },
  { id: 'scrF13Val', type: 'number' },
  { id: 'scrF14On', type: 'checkbox' },
  { id: 'scrF14Val', type: 'number' },
  { id: 'scrF15On', type: 'checkbox' },
  { id: 'scrF15Period', type: 'select' },
  { id: 'scrF15Val', type: 'number' },
  { id: 'scrF16On', type: 'checkbox' },
  { id: 'scrF16FromDate', type: 'date' },
  { id: 'scrF16FromField', type: 'select' },
  { id: 'scrF16ToDate', type: 'date' },
  { id: 'scrF16ToField', type: 'select' },
  { id: 'scrF16Val', type: 'number' },
  { id: 'scrF19On', type: 'checkbox' },
  { id: 'scrF19Date', type: 'date' },
  { id: 'scrAllowPartial', type: 'checkbox' },
  // Stock Scanner 'As of Date' tab (js/asof-scan.js): its own date + filters, saved in presets like the other tabs'
  { id: 'asofAOn', type: 'checkbox' },
  { id: 'asofA20', type: 'checkbox' },
  { id: 'asofA50', type: 'checkbox' },
  { id: 'asofA200', type: 'checkbox' },
  { id: 'asofAE200', type: 'checkbox' },
  { id: 'asofBOn', type: 'checkbox' },
  { id: 'asofCOn', type: 'checkbox' },
  { id: 'asofDOn', type: 'checkbox' },
  { id: 'asofEOn', type: 'checkbox' },
  { id: 'asofFOn', type: 'checkbox' },
  { id: 'asofGOn', type: 'checkbox' },
  { id: 'asofHOn', type: 'checkbox' },
  { id: 'asofIOn', type: 'checkbox' },
  { id: 'asofI21', type: 'checkbox' },
  { id: 'asofI63', type: 'checkbox' },
  { id: 'asofI252', type: 'checkbox' },
  { id: 'asofJOn', type: 'checkbox' },
  { id: 'asofJ2', type: 'checkbox' },
  { id: 'asofJ5', type: 'checkbox' },
  { id: 'asofJ10', type: 'checkbox' },
  { id: 'asofKOn', type: 'checkbox' },
  { id: 'asofBVal', type: 'number' },
  { id: 'asofCVal', type: 'number' },
  { id: 'asofDLen', type: 'number' },
  { id: 'asofDVal', type: 'number' },
  { id: 'asofEMult', type: 'number' },
  { id: 'asofELen', type: 'number' },
  { id: 'asofFMin', type: 'number' },
  { id: 'asofFMax', type: 'number' },
  { id: 'asofGLen', type: 'number' },
  { id: 'asofGVal', type: 'number' },
  { id: 'asofHVal', type: 'number' },
  { id: 'asofKVal', type: 'number' },
  { id: 'asofHPeriod', type: 'select' },
  { id: 'asofKFromField', type: 'select' },
  { id: 'asofKToField', type: 'select' },
  { id: 'asofDate', type: 'date' },
  { id: 'asofKFromDate', type: 'date' },
  { id: 'asofKToDate', type: 'date' },
];

// ── Default (all-off) filter state, used when "— Select preset —" is chosen ──
const DEFAULT_FILTER_STATE = {
  scrF1On: false, scrF1Mult: '3', scrF1Len: '50',
  scrF2On: false, scrF2Len: '50', scrF2Val: '1',
  scrF3On: false, scrF3Val: '5',
  scrF4On: false, scrF4Val: '2', scrF4Mult: '3', scrF4SmaLen: '50', scrF4MinTimes: '1', scrF4Lookback: '10',
  scrF5On: false, scrF5Min: '0', scrF5Max: '10',
  scrF6On: false, scrF6Len: '50', scrF6Val: '3',
  scrF7On: false, scrF7_2: true, scrF7_5: true, scrF7_10: true,
  scrF8On: false, scrF8Len: '50', scrF8Min: '0.97', scrF8Max: '1.10',
  scrF9On: false, scrF9Val: '60', scrF9MinStk: '3', scrF9MinMcap: '0',
  scrF10On: false, scrF10_20sma: true, scrF10_50sma: false, scrF10_200sma: false, scrF10_200ema: false,
  scrF11On: false, scrF11Sector: '',
  scrF12On: false, scrF12Period: '6m', scrF12Val: '0',
  scrF17On: false, scrF17Period: '3m', scrF17Lag: '3m', scrF17Val: '0',
  scrF18On: false, scrF18_1m: false, scrF18_3m: true, scrF18_52w: false,
  scrF13On: false, scrF13Val: '3',
  scrF14On: false, scrF14Val: '0',
  scrF15On: false, scrF15Period: '1m', scrF15Val: '0',
  scrF16On: false, scrF16FromField: 'close', scrF16ToField: 'close', scrF16Val: '0',
  scrF19On: false, scrF19Date: '',
  scrAllowPartial: true,
  // As of Date tab defaults (all off; blank dates - the tab fills in its own default date when opened)
  asofAOn: false, asofA20: true, asofA50: false, asofA200: false, asofAE200: false,
  asofBOn: false, asofBVal: '2', asofCOn: false, asofCVal: '5', asofDOn: false, asofDLen: '50', asofDVal: '1',
  asofEOn: false, asofEMult: '3', asofELen: '50', asofFOn: false, asofFMin: '0', asofFMax: '10',
  asofGOn: false, asofGLen: '50', asofGVal: '3', asofHOn: false, asofHPeriod: '21', asofHVal: '0',
  asofIOn: false, asofI21: false, asofI63: true, asofI252: false,
  asofJOn: false, asofJ2: true, asofJ5: true, asofJ10: true,
  asofKOn: false, asofKFromDate: '', asofKToDate: '', asofKFromField: 'close', asofKToField: 'close', asofKVal: '0',
  asofDate: '',
};

// ── Capture current filter state ──
function capturePresetState() {
  const state = {};
  for (const f of PRESET_FIELDS) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    if (f.type === 'checkbox') state[f.id] = el.checked;
    else state[f.id] = el.value;
  }
  return state;
}

// ── Restore filter state from preset ──
function applyPresetState(state) {
  // Presets saved before the ROC timeframe existed compared against one full window
  // ago, so a missing scrF17Lag means "same as the window".
  if ('scrF17Period' in state && !('scrF17Lag' in state)) state = { ...state, scrF17Lag: state.scrF17Period };
  // The first version of the F18 "Making New High" filter had a single dropdown (scrF18Period) instead of 1M / 3M / 52W tick boxes.
  if ('scrF18Period' in state && !('scrF18_3m' in state)) {
    state = { ...state, scrF18_1m: state.scrF18Period === '1m', scrF18_3m: state.scrF18Period === '3m', scrF18_52w: state.scrF18Period === '52w' };
  }
  for (const f of PRESET_FIELDS) {
    if (!(f.id in state)) continue;
    const el = document.getElementById(f.id);
    if (!el) continue;
    if (f.type === 'checkbox') el.checked = !!state[f.id];
    else el.value = state[f.id];
  }
  if (typeof mfRocSyncLagSelect === 'function') mfRocSyncLagSelect('scrF17Period', 'scrF17Lag');
}

// ── API helpers ──
async function apiLoadPresets() {
  try {
    const resp = await fetch('/api/presets');
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) { return null; }
}

async function apiSavePresets(presets) {
  try {
    const resp = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(presets),
    });
    return resp.ok;
  } catch (e) { return false; }
}

// ── IndexedDB fallback ──
async function idbLoadPresets() {
  try {
    const db = await openCacheDB();
    const tx = db.transaction('scannerPresets', 'readonly');
    const store = tx.objectStore('scannerPresets');
    const req = store.get('allPresets');
    const result = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
    db.close();
    return result || null;
  } catch (e) { return null; }
}

async function idbSavePresets(presets) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction('scannerPresets', 'readwrite');
    tx.objectStore('scannerPresets').put(presets, 'allPresets');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
    return true;
  } catch (e) { return false; }
}

// ── Populate preset dropdown ──
function populatePresetDropdown() {
  const sel = document.getElementById('scrPresetSelect');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">— Select preset —</option>';
  const names = Object.keys(_presets).sort();
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  // Restore selection if still exists
  if (currentVal && _presets[currentVal]) {
    sel.value = currentVal;
  }
  populateMultiPresetList();
}

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-PRESET COMBINED SCAN — run 2+ saved presets together, AND (stock
// must pass every checked preset) or OR (passes if it matches any one).
// ═══════════════════════════════════════════════════════════════════════════
let _multiPresetActive = null; // {presets: [...names], mode: 'AND'|'OR'} while a combined view is showing

function populateMultiPresetList() {
  const wrap = document.getElementById('scrMultiPresetList');
  if (!wrap) return;
  const names = Object.keys(_presets).sort();
  if (names.length === 0) {
    wrap.innerHTML = '<p style="color:var(--text2);font-size:12px;">No saved presets yet — save one from the dropdown above first.</p>';
    return;
  }
  // Keep whatever was already checked (e.g. re-populating after a save elsewhere)
  const checkedBefore = new Set(_multiPresetActive ? _multiPresetActive.presets
    : [...wrap.querySelectorAll('input[type=checkbox]:checked')].map(el => el.value));
  wrap.innerHTML = names.map(name =>
    `<label class="scr-multi-preset-item"><input type="checkbox" value="${escapeHtml(name)}" ${checkedBefore.has(name) ? 'checked' : ''}> ${escapeHtml(name)}</label>`
  ).join('');
  updateApplyBtn();
}

// Runs runScreener() once per selected preset (temporarily applying that
// preset's saved filter state to the DOM, same mechanism loadPreset() uses),
// then combines the resulting passed-ISIN sets with a plain set
// intersection (AND) or union (OR) - no need to duplicate the 15-filter
// evaluation logic in runScreener() itself.
function runMultiPresetScan() {
  const wrap = document.getElementById('scrMultiPresetList');
  const statusEl = document.getElementById('scrMultiStatus');
  if (!wrap) return;
  const selected = [...wrap.querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
  if (selected.length < 2) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--orange)">Select at least 2 presets to combine.</span>';
    return;
  }
  const mode = document.querySelector('input[name="scrMultiMode"]:checked').value;

  // A combined scan is already showing (this call is a re-run triggered by
  // typing in the search box, toggling a filter, etc.) vs. a fresh run from
  // clicking "Run Combined Scan" — only the fresh run should reset the
  // Passed/Failed toggle back to Passed.
  const isFreshRun = !_multiPresetActive;

  // Restore whatever single-filter state was in the DOM before we borrow it
  // for each preset evaluation below.
  const savedState = capturePresetState();

  let combined = null;
  for (const name of selected) {
    if (!_presets[name]) continue;
    applyPresetState(DEFAULT_FILTER_STATE);
    applyPresetState(_presets[name]);
    runScreener();
    const passedIsins = new Set(screenerPassed.map(s => s.isin));
    if (combined === null) combined = passedIsins;
    else if (mode === 'AND') combined = new Set([...combined].filter(isin => passedIsins.has(isin)));
    else passedIsins.forEach(isin => combined.add(isin));
  }
  combined = combined || new Set();

  applyPresetState(savedState);

  // Filters enabled on the Technicals / Sector & Industry tabs apply on top of the
  // combined presets: a stock must pass both. Run last, so the dynamic columns shown
  // in the table reflect the filters currently on screen.
  let singlePassed = null;
  const singleFailReasons = new Map();
  if (anySingleFilterOn()) {
    runScreener();
    singlePassed = new Set(screenerPassed.map(s => s.isin));
    screenerFailed.forEach(s => singleFailReasons.set(s.isin, s._failReasons || []));
  }

  // Combined results still honor whatever's currently typed in the search box,
  // same as a plain runScreener() scan — otherwise typing a symbol after running
  // a combined scan has no visible effect on the (search-blind) combined set.
  const search = document.getElementById('scrSearch').value.trim().toUpperCase();

  const finalPassed = [], finalFailed = [];
  const reason = `Did not pass combined ${mode} scan: ${selected.join(', ')}`;
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    if (search && !s.symbol.toUpperCase().includes(search)) continue;
    const failReasons = [];
    if (!combined.has(key)) failReasons.push(reason);
    if (singlePassed && !singlePassed.has(key)) failReasons.push(...(singleFailReasons.get(key) || ['Did not pass the enabled filters']));
    if (failReasons.length === 0) {
      finalPassed.push(s);
    } else {
      s._failReasons = failReasons;
      finalFailed.push(s);
    }
  }
  finalPassed.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));
  finalFailed.sort((a, b) => (b.turnover || 0) - (a.turnover || 0));

  screenerPassed = finalPassed;
  screenerFailed = finalFailed;
  if (isFreshRun) scrShowingFailed = false;
  screenerResults = scrShowingFailed ? screenerFailed : screenerPassed;
  screenerPage = 0;
  scrSortCol = null;
  _multiPresetActive = { presets: selected, mode };

  const advancing = finalPassed.filter(s => s.changePct > 0).length;
  const declining = finalPassed.filter(s => s.changePct < 0).length;
  const avgChange = finalPassed.length > 0 ? (finalPassed.reduce((s, r) => s + (r.changePct || 0), 0) / finalPassed.length) : 0;
  document.getElementById('screenerStats').innerHTML = `
    <div class="stat-card"><div class="label">Combined Presets (${mode})</div><div class="value" style="color:var(--accent)">${selected.length}</div></div>
    <div class="stat-card"><div class="label">Passed</div><div class="value positive">${finalPassed.length}</div></div>
    <div class="stat-card"><div class="label">Failed</div><div class="value negative">${finalFailed.length}</div></div>
    <div class="stat-card"><div class="label">Advancing (Passed)</div><div class="value positive">${advancing}</div></div>
    <div class="stat-card"><div class="label">Declining (Passed)</div><div class="value negative">${declining}</div></div>
    <div class="stat-card"><div class="label">Avg Change % (Passed)</div><div class="value ${avgChange>=0?'positive':'negative'}">${avgChange.toFixed(2)}%</div></div>
  `;

  if (statusEl) {
    const joiner = mode === 'AND' ? ' AND ' : ' OR ';
    const extra = singlePassed ? ` + ${singleFilterCount()} filter${singleFilterCount() === 1 ? '' : 's'}` : '';
    statusEl.innerHTML = `<span style="color:var(--green)">Active: ${escapeHtml(selected.join(joiner))}${extra}</span>`;
  }

  updateToggleButton();
  renderScreenerTable();
}

// ── Persist presets (API first, IDB fallback) ──
async function persistPresets() {
  if (_presetsSource === 'api' || window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const ok = await apiSavePresets(_presets);
    if (ok) { _presetsSource = 'api'; return; }
  }
  await idbSavePresets(_presets);
  _presetsSource = 'idb';
}

// ── Load preset into filters ──
function loadPreset() {
  const sel = document.getElementById('scrPresetSelect');
  const name = sel.value;
  if (!name) {
    // "— Select preset —" chosen: clear all filters back to defaults
    applyPresetState(DEFAULT_FILTER_STATE);
    runScreener();
    updateFilterBadge();
    if (typeof updateModalPresetName === 'function') updateModalPresetName();
    return;
  }
  if (!_presets[name]) return;
  // Reset to defaults first, then overlay the preset's saved fields — a preset saved
  // before a filter (e.g. F15) existed won't have that key, and without this reset
  // step the filter would silently keep whatever state the previous preset left it in.
  applyPresetState(DEFAULT_FILTER_STATE);
  applyPresetState(_presets[name]);
  // A preset with As of Date filters switched on runs that scan (asof-scan.js); otherwise the normal latest-day scan
  if (typeof asOfPresetActive === 'function' && asOfPresetActive()) asOfRun({ keepOpen: true });
  else runScreener();
  updateFilterBadge();
  if (typeof updateModalPresetName === 'function') updateModalPresetName();
}

// ── Save current filters as preset ──
function savePresetPrompt() {
  const sel = document.getElementById('scrPresetSelect');
  const existing = sel.value || '';
  const name = prompt('Preset name:', existing);
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  _presets[trimmed] = capturePresetState();
  persistPresets();
  populatePresetDropdown();
  sel.value = trimmed;
  if (typeof updateModalPresetName === 'function') updateModalPresetName();
}

// ── Rename preset ──
function editPresetPrompt() {
  const sel = document.getElementById('scrPresetSelect');
  const oldName = sel.value;
  if (!oldName || !_presets[oldName]) {
    alert('Select a preset first.');
    return;
  }
  const newName = prompt('Rename preset:', oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;
  const trimmed = newName.trim();
  _presets[trimmed] = _presets[oldName];
  delete _presets[oldName];
  persistPresets();
  populatePresetDropdown();
  sel.value = trimmed;
}

// ── Delete preset ──
function deletePreset() {
  const sel = document.getElementById('scrPresetSelect');
  const name = sel.value;
  if (!name || !_presets[name]) {
    alert('Select a preset first.');
    return;
  }
  if (!confirm(`Delete preset "${name}"?`)) return;
  delete _presets[name];
  persistPresets();
  populatePresetDropdown();
}

// ── Initialize presets on page load ──
(async function initPresets() {
  // Try API first (works when served via nse_server.py)
  const apiPresets = await apiLoadPresets();
  if (apiPresets && typeof apiPresets === 'object') {
    _presets = apiPresets;
    _presetsSource = 'api';
    populatePresetDropdown();
    return;
  }

  // Fallback to IndexedDB
  const idbPresets = await idbLoadPresets();
  if (idbPresets && typeof idbPresets === 'object') {
    _presets = idbPresets;
    _presetsSource = 'idb';
    // If we're on http, try to migrate IDB presets to API
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      const ok = await apiSavePresets(_presets);
      if (ok) _presetsSource = 'api';
    }
    populatePresetDropdown();
    return;
  }

  _presetsSource = 'none';
  populatePresetDropdown();
})();

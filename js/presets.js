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
  { id: 'scrAllowPartial', type: 'checkbox' },
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
  scrF13On: false, scrF13Val: '3',
  scrF14On: false, scrF14Val: '0',
  scrF15On: false, scrF15Period: '1m', scrF15Val: '0',
  scrF16On: false, scrF16FromField: 'close', scrF16ToField: 'close', scrF16Val: '0',
  scrAllowPartial: true,
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
  for (const f of PRESET_FIELDS) {
    if (!(f.id in state)) continue;
    const el = document.getElementById(f.id);
    if (!el) continue;
    if (f.type === 'checkbox') el.checked = !!state[f.id];
    else el.value = state[f.id];
  }
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

  // Combined results still honor whatever's currently typed in the search box,
  // same as a plain runScreener() scan — otherwise typing a symbol after running
  // a combined scan has no visible effect on the (search-blind) combined set.
  const search = document.getElementById('scrSearch').value.trim().toUpperCase();

  const finalPassed = [], finalFailed = [];
  const reason = `Did not pass combined ${mode} scan: ${selected.join(', ')}`;
  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    if (search && !s.symbol.toUpperCase().includes(search)) continue;
    if (combined.has(key)) {
      finalPassed.push(s);
    } else {
      s._failReasons = [reason];
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
    statusEl.innerHTML = `<span style="color:var(--green)">Active: ${escapeHtml(selected.join(joiner))}</span>`;
  }

  updateToggleButton();
  renderScreenerTable();
  closeScreenerFilters();
}

function clearMultiPresetScan() {
  _multiPresetActive = null;
  const statusEl = document.getElementById('scrMultiStatus');
  if (statusEl) statusEl.innerHTML = '';
  const wrap = document.getElementById('scrMultiPresetList');
  if (wrap) wrap.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
  runScreener(); // back to whatever the single-filter tabs currently show
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
  runScreener();
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

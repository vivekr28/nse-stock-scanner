// ═══════════════════════════════════════════════════════════════════════════════
// GROUP SELECT — Stock Scanner popup's "Sector & Industry" tab: pick ANY NUMBER of sectors (F11) and industries (F36) from a list.
//   F11 "Sector"    - the stock's sector is one of the ticked ones (it used to be a one-sector dropdown)
//   F36 "Industry"  - the stock's industry is one of the ticked ones
// Each filter is a button that opens a panel: a search box, "Select shown" / "Clear", and a checkbox list of every sector / industry with its
// stock count. The two filters combine with each other and with every other filter as AND; inside one filter the ticked groups are OR. A filter
// that is switched on with nothing ticked restricts nothing ("All sectors" / "All industries"). Ticking a group switches its filter on.
// The selection lives in a hidden input (scrF11Sector / scrF36Industry), so presets store and restore it like any other field. Its value is a
// JSON array of names (11 industry names contain a comma, so a comma list would be ambiguous); a plain name - what the one-sector dropdown saved
// in older presets - is read as a one-name selection and written back as JSON the next time presets are applied.
// A stock with no sector / industry belongs to 'Undefined-Diversified', the group the other tabs use for it, and that group is in the list.
// PASTE: the Industry Analysis tab's "Copy industries" buttons put the industries it lists on the clipboard as one comma-separated line (the
// way the scanner copies its stock lists); pasting that text into a picker (Ctrl+V in its search box, or the Paste link) ticks them. Pasting
// REPLACES what was ticked (it means "use this list"), a name that matches nothing is reported, not guessed at, and a paste that matches
// nothing leaves the selection alone. Names are separated by line breaks, tabs or commas, but a whole line that is itself a name is never
// split (11 industry names contain a comma: "Gems, Jewellery And Watches" typed on its own line is one name; the copy writes it without
// the comma). Matching ignores case, spacing, punctuation and & vs "and", and a trailing "(73)" count is tolerated, so a list typed by hand
// or one name per line works too.
// screener.js reaches this file only through the hooks below (each call guarded by typeof, like group-breadth.js), so the scanner holds none
// of these controls or fields:
//   gsFilterState() / gsApplyToStock()  the filter itself, once per scan / per stock
//   gsActiveCount()                     how many of the two are switched on (badges, the Active Filters card)
//   gsReset()                           Reset All
//   gsSync()                            data loaded, or a preset applied: rebuild the lists and the button labels from the hidden values
// ═══════════════════════════════════════════════════════════════════════════════

const GS_FILTERS = [
  { code: 'F11', key: 'sec', on: 'scrF11On', field: 'scrF11Sector',   level: 'sector',   noun: 'Sector',   nouns: 'sectors',    all: 'All sectors' },
  { code: 'F36', key: 'ind', on: 'scrF36On', field: 'scrF36Industry', level: 'industry', noun: 'Industry', nouns: 'industries', all: 'All industries' },
];
const GS_UNKNOWN = 'Undefined-Diversified';
const GS_REASON_NAMES = 4;       // a fail reason names at most this many of the ticked groups

const gsEl = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const gsDef = code => GS_FILTERS.find(d => d.code === code);
const gsEsc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s));

// ── Selection <-> the hidden input's text ─────────────────────────────────────────────────────────────────────────────────────

// '' -> []; '["A","B, C"]' -> ['A', 'B, C']; a plain name (older presets) -> [name]. Duplicates and blanks are dropped.
function gsParse(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return [];
  let names;
  if (text[0] === '[') {
    try { names = JSON.parse(text); } catch (e) { names = [text]; }
    if (!Array.isArray(names)) names = [text];
  } else {
    names = [text];
  }
  return [...new Set(names.map(n => String(n).trim()).filter(Boolean))];
}
function gsEncode(names) { return names.length ? JSON.stringify(names) : ''; }

// The group a stock belongs to at a level ('sector' | 'industry')
function gsGroupOf(stock, level) { return (stock && stock[level]) || GS_UNKNOWN; }

// Every group at a level with the number of stocks in it, by name: [{ name, count }]
function gsGroups(level) {
  const counts = {};
  const all = (typeof Store !== 'undefined' && Store.latestBySymbol) || {};
  for (const key in all) { const g = gsGroupOf(all[key], level); counts[g] = (counts[g] || 0) + 1; }
  return Object.keys(counts).sort((a, b) => a.localeCompare(b)).map(name => ({ name, count: counts[name] }));
}

function gsSelected(d) { const e = gsEl(d.field); return gsParse(e ? e.value : ''); }

// ── The filter (hooks for js/screener.js) ─────────────────────────────────────────────────────────────────────────────────────

// { sec: {on, names, set}, ind: {...}, any } - `any` is true when at least one filter is on AND has something ticked (otherwise nothing to apply)
function gsFilterState() {
  const s = {};
  for (const d of GS_FILTERS) {
    const on = gsEl(d.on), names = gsSelected(d);
    s[d.key] = { on: !!(on && on.checked), names, set: new Set(names) };
  }
  s.any = GS_FILTERS.some(d => s[d.key].on && s[d.key].set.size > 0);
  return s;
}

// The reasons this stock fails F11 / F36 ([] = passes); `state` is gsFilterState()'s result - call it only when state.any
function gsApplyToStock(stock, state) {
  const reasons = [];
  for (const d of GS_FILTERS) {
    const f = state[d.key];
    if (!f.on || !f.set.size) continue;
    const name = gsGroupOf(stock, d.level);
    if (f.set.has(name)) continue;
    const shown = f.names.slice(0, GS_REASON_NAMES).join(', ') + (f.names.length > GS_REASON_NAMES ? ', +' + (f.names.length - GS_REASON_NAMES) + ' more' : '');
    reasons.push(f.names.length === 1
      ? `${d.code}: ${d.noun} '${name}' ≠ '${f.names[0]}'`
      : `${d.code}: ${d.noun} '${name}' not one of the ${f.names.length} selected (${shown})`);
  }
  return reasons;
}

// How many of the two filters are switched on (the scanner adds it to the Sector & Industry tab's badge and its active-filter count)
function gsActiveCount() {
  return GS_FILTERS.filter(d => { const e = gsEl(d.on); return !!(e && e.checked); }).length;
}

// Reset All: both filters off with nothing ticked
function gsReset() {
  for (const d of GS_FILTERS) {
    const on = gsEl(d.on), hidden = gsEl(d.field);
    if (on) on.checked = false;
    if (hidden) hidden.value = '';
  }
  gsSync();
}

// ── The picker ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function gsSkeleton(d) {
  return `<button type="button" class="gs-btn" id="gsBtn${d.code}" onclick="gsToggle('${d.code}')"></button>` +
    `<div class="gs-panel" id="gsPanel${d.code}" style="display:none;">` +
      `<div class="gs-tools">` +
        `<input type="text" class="gs-search" id="gsSearch${d.code}" placeholder="Search ${d.nouns} - or paste a list" autocomplete="off" oninput="event.stopPropagation(); gsRenderList('${d.code}')" onpaste="gsOnPaste('${d.code}', event)">` +
        `<button type="button" class="gs-link" onclick="gsPasteFromClipboard('${d.code}')" title="Tick the ${d.nouns} on the clipboard (e.g. from Industry Analysis - Copy industries); replaces what is ticked">Paste</button>` +
        `<button type="button" class="gs-link" onclick="gsSelectShown('${d.code}')" title="Tick every ${d.noun.toLowerCase()} the search shows">Select shown</button>` +
        `<button type="button" class="gs-link" onclick="gsClear('${d.code}')" title="Untick everything">Clear</button>` +
      `</div>` +
      `<div class="gs-msg" id="gsMsg${d.code}" style="display:none;"></div>` +
      `<div class="gs-list" id="gsList${d.code}"></div>` +
    `</div>`;
}

// The button's text: "All sectors", the one name, or "3 sectors selected" (the tooltip lists them)
function gsUpdateButton(d) {
  const btn = gsEl('gsBtn' + d.code);
  if (!btn) return;
  const names = gsSelected(d);
  btn.textContent = (!names.length ? d.all : names.length === 1 ? names[0] : names.length + ' ' + d.nouns + ' selected') + ' ▾';
  btn.title = names.length ? names.join(', ') : 'Pick one or more ' + d.nouns;
}

// The groups the list shows for the current search text
function gsShown(d) {
  const search = gsEl('gsSearch' + d.code);
  const q = ((search && search.value) || '').trim().toLowerCase();
  const groups = gsGroups(d.level);
  return q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups;
}

function gsRenderList(code) {
  const d = gsDef(code), list = gsEl('gsList' + code);
  if (!d || !list) return;
  const chosen = new Set(gsSelected(d)), shown = gsShown(d);
  list.innerHTML = shown.length
    ? shown.map(g => `<label class="gs-item"><input type="checkbox" value="${gsEsc(g.name)}"${chosen.has(g.name) ? ' checked' : ''} onchange="gsCheck('${code}', this)">` +
        `<span class="gs-name" title="${gsEsc(g.name)}">${gsEsc(g.name)}</span><span class="gs-count">${g.count}</span></label>`).join('')
    : `<div class="gs-empty">${gsGroups(d.level).length ? 'No ' + d.noun.toLowerCase() + ' matches the search' : 'No data loaded yet'}</div>`;
}

// Write a selection into the hidden input (alphabetical, so the saved text does not depend on the order of ticking), refresh the button, and
// switch the filter on when something is ticked
function gsSet(d, names) {
  const hidden = gsEl(d.field);
  if (!hidden) return;
  hidden.value = gsEncode([...new Set(names)].sort((a, b) => a.localeCompare(b)));
  gsUpdateButton(d);
  const on = gsEl(d.on);
  if (on && names.length && !on.checked) on.checked = true;
}

// A programmatic change (Select shown / Clear) does not fire a checkbox change, so ask the scanner to re-run itself and refresh the badges
function gsRerun() {
  if (typeof updateFilterBadge === 'function') updateFilterBadge();
  if (typeof rerunScreenerRespectingMultiPreset === 'function') rerunScreenerRespectingMultiPreset();
}

// A box in the list was ticked / unticked. (The change event itself bubbles to the scanner, which re-runs it - no explicit re-run here.)
function gsCheck(code, input) {
  const d = gsDef(code);
  if (!d || !input) return;
  const names = gsSelected(d).filter(n => n !== input.value);
  if (input.checked) names.push(input.value);
  gsSet(d, names);
}

function gsSelectShown(code) {
  const d = gsDef(code);
  if (!d) return;
  gsSet(d, gsSelected(d).concat(gsShown(d).map(g => g.name)));
  gsRenderList(code);
  gsRerun();
}

function gsClear(code) {
  const d = gsDef(code);
  if (!d) return;
  gsSet(d, []);
  gsMessage(code, '');
  gsRenderList(code);
  gsRerun();
}

// ── Paste a list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Letters and digits only, lower case, "&" read as "and": "Gems, Jewellery And Watches" = "gems jewellery and watches" = "Gems Jewellery & Watches"
function gsNormalizeName(s) {
  return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// The distinct non-blank lines of pasted text (line breaks and tabs separate; a leading "1." / "-" / "*" list marker is dropped)
function gsPastedLines(text) {
  const seen = new Set(), lines = [];
  for (const raw of String(text === undefined || text === null ? '' : text).split(/[\r\n\t]+/)) {
    const line = raw.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim();
    if (line && !seen.has(line)) { seen.add(line); lines.push(line); }
  }
  return lines;
}

// { names: the groups the text names (in the order pasted), missing: the names that matched none, lines: how many lines it had }.
// A line is tried whole first; only when it is not a name by itself and has commas is it split into the comma-separated names it holds.
function gsMatchPasted(d, text) {
  const byNorm = new Map(gsGroups(d.level).map(g => [gsNormalizeName(g.name), g.name]));
  const names = [], missing = [];
  const find = s => byNorm.get(gsNormalizeName(s)) || byNorm.get(gsNormalizeName(s.replace(/\s*\(\d+\)\s*$/, '')));
  const add = name => { if (!names.includes(name)) names.push(name); };
  const lines = gsPastedLines(text);
  for (const line of lines) {
    const whole = find(line);
    if (whole) { add(whole); continue; }
    if (!line.includes(',')) { missing.push(line); continue; }
    for (const piece of line.split(',')) {
      const token = piece.trim();
      if (!token) continue;
      const hit = find(token);
      if (hit) add(hit); else missing.push(token);
    }
  }
  return { names, missing, lines: lines.length };
}

function gsMessage(code, text, warn) {
  const el = gsEl('gsMsg' + code);
  if (!el) return;
  el.textContent = text;
  el.className = 'gs-msg' + (warn ? ' warn' : '');
  el.style.display = text ? '' : 'none';
}

// Tick the groups the text names, replacing the selection; say what was selected and what was not found
function gsPaste(code, text) {
  const d = gsDef(code);
  if (!d) return;
  const m = gsMatchPasted(d, text);
  const word = n => (n === 1 ? d.noun.toLowerCase() : d.nouns);
  if (!m.names.length) {
    gsMessage(code, m.lines
      ? `None of the pasted names matches ${d.noun === 'Industry' ? 'an' : 'a'} ${d.noun.toLowerCase()} - nothing changed.`
      : 'Nothing to paste - the clipboard is empty.', true);
    return;
  }
  gsSet(d, m.names);
  const search = gsEl('gsSearch' + code);
  if (search) search.value = '';
  gsRenderList(code);
  gsMessage(code, `Selected ${m.names.length} ${word(m.names.length)}` + (m.missing.length
    ? `. Not found (${m.missing.length}): ${m.missing.slice(0, 5).join('; ')}${m.missing.length > 5 ? '; ...' : ''}` : '.'), m.missing.length > 0);
  gsRerun();
}

// Ctrl+V in the search box: a list (several lines, or text that names at least one group) is selected; anything else is pasted into
// the search box as ordinary text
function gsOnPaste(code, event) {
  const d = gsDef(code);
  if (!d || !event) return;
  const data = event.clipboardData || (typeof window !== 'undefined' ? window.clipboardData : null);
  const text = data && data.getData ? data.getData('text') : '';
  if (gsPastedLines(text).length > 1 || gsMatchPasted(d, text).names.length) {
    event.preventDefault();
    gsPaste(code, text);
  }
}

// The "Paste" link: read the clipboard (the browser may ask permission, or refuse - then Ctrl+V in the search box still works)
function gsPasteFromClipboard(code) {
  const fallback = 'The browser did not let the page read the clipboard - click the search box and press Ctrl+V instead.';
  if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.readText) { gsMessage(code, fallback, true); return Promise.resolve(false); }
  return navigator.clipboard.readText().then(text => { gsPaste(code, text); return true; }, () => { gsMessage(code, fallback, true); return false; });
}

function gsClosePanels(except) {
  for (const d of GS_FILTERS) {
    const panel = gsEl('gsPanel' + d.code);
    if (panel && d.code !== except) panel.style.display = 'none';
  }
}

function gsToggle(code) {
  const panel = gsEl('gsPanel' + code);
  if (!panel) return;
  const opening = panel.style.display === 'none';
  gsClosePanels(opening ? code : null);
  panel.style.display = opening ? '' : 'none';
  if (opening) {
    gsMessage(code, '');
    gsRenderList(code);
    gsPlacePanel(code, panel);
    const search = gsEl('gsSearch' + code);
    if (search && search.focus) search.focus();
  }
}

// The panel hangs from the button's left edge; when it would run past the right edge of the filter list (a narrow popup), it hangs from the right edge
function gsPlacePanel(code, panel) {
  panel.style.left = ''; panel.style.right = '';
  const pick = gsEl('gsPick' + code);
  if (!pick || !pick.getBoundingClientRect || !panel.offsetWidth) return;
  const box = pick.closest && pick.closest('.scr-filters-list');
  const limit = box ? box.getBoundingClientRect().right : window.innerWidth;
  if (pick.getBoundingClientRect().left + panel.offsetWidth > limit - 8) { panel.style.left = 'auto'; panel.style.right = '0'; }
}

// Data loaded or a preset applied: build the widgets once, tidy the hidden values (an older preset's plain name becomes JSON) and redraw the
// button labels and the lists from them
function gsSync() {
  for (const d of GS_FILTERS) {
    const pick = gsEl('gsPick' + d.code), hidden = gsEl(d.field);
    if (!pick) continue;
    if (!pick.innerHTML) pick.innerHTML = gsSkeleton(d);
    if (hidden) hidden.value = gsEncode(gsParse(hidden.value));
    gsUpdateButton(d);
    gsRenderList(d.code);
  }
}

// A click outside an open panel (or Escape) closes it
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', e => {
    if (!(e.target && e.target.closest && e.target.closest('.gs-pick'))) gsClosePanels(null);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') gsClosePanels(null); });
}

// ═════════════════════════════════════════════════════════════════
// STOCK SCANNER "OVERVIEW" - what the scanned stocks are made of: two donut charts (by sector, by industry) with a ranked list beside each,
// for the stocks the results table is showing now (Passed or Failed, after the symbol search). Plain SVG, no chart library.
// The list also gives, per sector / industry, how much of the WHOLE group passes the filters (passed stocks / every stock in the group), and
// can be sorted by name, number of stocks or that passing %. Both lists start on the number of stocks, biggest first.
// The industry list has a tick box per industry, "Select industries with at least N stocks", and a button that copies the stocks of the
// ticked industries as a TradingView watchlist grouped by industry (the same text as the toolbar's TV Watchlist > Grouped by industry).
// ═════════════════════════════════════════════════════════════════

const OV_TOP = 10;                 // slices that get their own colour; the rest of the groups are joined into one grey "Other" slice
const OV_COLORS = ['#3b82f6', '#05df72', '#ffb900', '#c27aff', '#00d3f3', '#f87171', '#f472b6', '#a3e635', '#fb923c', '#2dd4bf'];
const OV_OTHER_COLOR = '#64748b';
const OV_UNDEFINED = 'Undefined-Diversified';   // the name the rest of the app gives a stock with no sector / industry
const OV_R = 70;                   // donut radius and ring width in the 200 x 200 drawing
const OV_RING = 34;

let ovSort = { col: 'share', dir: -1 };   // the lists' order: col 'name' | 'share' | 'pass', dir 1 ascending / -1 descending (both lists share it); starts on the number of stocks, highest first
let ovSel = new Set();                    // the industries ticked for the copy (names); emptied each time the Overview opens
let ovMinN = 2;                           // the "at least N stocks" box next to the industry list
let ovRows = [];                          // what the open modal shows: the table's stocks ...
let ovCtx = null;                         // ... and { universe: every stock, passed: the stocks that pass } for the passing %

// Stocks per group name: Map(name -> n). A stock without a sector / industry counts under "Undefined-Diversified".
function ovCountBy(rows, field) {
  const m = new Map();
  for (const r of rows || []) {
    const name = (r && r[field]) || OV_UNDEFINED;
    m.set(name, (m.get(name) || 0) + 1);
  }
  return m;
}

// Rows -> { total, groups: [{ name, count, pct, inGroup, passed, passPct, rank, slice }] biggest first (ties by name), slices: [{ name, count,
// pct, color, others }] for the donut }. `field` is 'sector' or 'industry'. With more than `top` groups the smallest are joined into a single
// "Other (n groups)" slice - they all stay in `groups`, so the list still names them. `ctx` ({ universe, passed }, optional) adds each group's size
// in the whole market (`inGroup`), how many of them pass (`passed`) and `passPct` = passed / inGroup * 100 (null when the group is unknown).
// `rank` is the group's place by count (it decides its colour); `slice` is the donut slice it belongs to.
function ovGroupCounts(rows, field, top = OV_TOP, ctx = null) {
  const counts = ovCountBy(rows, field);
  const inAll = ctx ? ovCountBy(ctx.universe, field) : null;
  const passAll = ctx ? ovCountBy(ctx.passed, field) : null;
  const total = (rows || []).length;
  const groups = [...counts].map(([name, count]) => {
    const inGroup = inAll ? (inAll.get(name) || 0) : null;
    const passed = passAll ? (passAll.get(name) || 0) : null;
    return { name, count, pct: total ? count / total * 100 : 0, inGroup, passed, passPct: inGroup ? passed / inGroup * 100 : null };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const slices = groups.slice(0, top).map((g, i) => ({ name: g.name, count: g.count, pct: g.pct, color: OV_COLORS[i % OV_COLORS.length], others: 0 }));
  const rest = groups.slice(top);
  if (rest.length) {
    const count = rest.reduce((s, g) => s + g.count, 0);
    slices.push({ name: `Other (${rest.length} ${field === 'sector' ? 'sectors' : 'industries'})`, count, pct: total ? count / total * 100 : 0,
                  color: OV_OTHER_COLOR, others: rest.length });
  }
  groups.forEach((g, i) => { g.rank = i; g.slice = i < top ? i : slices.length - 1; });
  return { total, groups, slices };
}

// The groups in the order the list shows them: by name (A-Z), by share (= by number of stocks, the share is that count over the total), or by passing % (groups with no passing % last). Ties fall
// back to the bigger group, then the name, so the order is stable.
function ovSortGroups(groups, sort = ovSort) {
  const dir = sort.dir;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const tie = (a, b) => b.count - a.count || byName(a, b);
  return [...groups].sort((a, b) => {
    if (sort.col === 'name') return dir * byName(a, b);
    if (sort.col === 'pass') {
      if (a.passPct === null && b.passPct === null) return tie(a, b);
      if (a.passPct === null) return 1;
      if (b.passPct === null) return -1;
      return dir * (a.passPct - b.passPct) || tie(a, b);
    }
    return dir * (a.count - b.count) || byName(a, b);
  });
}

// The donut: one stroked circle per slice (a dash of the circumference), so a single slice or a tiny one needs no arc maths. Each slice carries
// data-ov="<kind>:<index>" - the hover handler below shows its name in the middle and lights its row in the list.
function ovDonutSvg(kind, slices, total) {
  const C = 2 * Math.PI * OV_R;
  let used = 0;
  const gap = slices.length > 1 ? 0.8 : 0;
  const rings = slices.map((s, i) => {
    const len = total ? s.count / total * C : 0;
    const dash = Math.max(len - gap, 0.01);
    const out = `<circle class="ov-slice" data-ov="${kind}:${i}" cx="100" cy="100" r="${OV_R}" fill="none" stroke="${s.color}" stroke-width="${OV_RING}" ` +
      `stroke-dasharray="${dash.toFixed(3)} ${(C - dash).toFixed(3)}" stroke-dashoffset="${(-used).toFixed(3)}" transform="rotate(-90 100 100)">` +
      `<title>${escapeHtml(s.name)}: ${s.count} (${s.pct.toFixed(1)}%)</title></circle>`;
    used += len;
    return out;
  }).join('');
  return `<svg class="ov-donut" viewBox="0 0 200 200" role="img" aria-label="${kind} breakdown">` +
    `<circle cx="100" cy="100" r="${OV_R}" fill="none" stroke="var(--bg3)" stroke-width="${OV_RING}"/>${rings}` +
    `<text class="ov-mid-main" x="100" y="98" text-anchor="middle">${total}</text>` +
    `<text class="ov-mid-sub" x="100" y="116" text-anchor="middle">stocks</text></svg>`;
}

// The Passing cells of one row: the % over a bar (its length is the % relative to the highest % in the list, so the best groups stand out at a
// glance), then "passed/group size" in a column of its own so every figure lines up.
function ovFmtPass(g, maxPass) {
  if (g.passPct === null) return '<em class="ov-pass">-</em><small class="ov-frac"></small>';
  const tip = `${g.passed} of the ${g.inGroup} stocks in this group pass the filters`;
  const bar = maxPass > 0 ? Math.round(g.passPct / maxPass * 100) : 0;
  return `<em class="ov-pass" style="--bar:${bar}%" title="${tip}">${g.passPct.toFixed(1)}%</em><small class="ov-frac" title="${tip}">${g.passed}/${g.inGroup}</small>`;
}

// The list's header: Name / Share / Passing are buttons that sort (a second click reverses); the arrow marks the active one.
// The same columns as the rows: colour dot | name | Stocks | Share | Passing % (bar) | passed / group size (no header). The arrow sits after the label,
// except on Passing where it comes before (it hangs into the free space beside the label), so it never pushes a label off its column.
function ovHeadHtml(kind, sort = ovSort) {
  const btn = (col, label, cls, tip) => {
    const on = sort.col === col;
    const arrow = `<span>${on ? (sort.dir > 0 ? '▲' : '▼') : ''}</span>`;
    return `<button type="button" class="ov-sort ${cls}${on ? ' on' : ''}" data-sort="${col}" title="${tip}">${col === 'pass' ? arrow + label : label + arrow}</button>`;
  };
  const all = kind === 'industry' ? '<input type="checkbox" class="ov-all" title="Tick / untick every industry">' : '';
  return `<div class="ov-head">${all}<span></span>${btn('name', kind === 'sector' ? 'Sector' : 'Industry', 'ov-h-name', 'Sort by name')}` +
    `<span class="ov-h-num" title="Number of the shown stocks in the group">Stocks</span>${btn('share', 'Share', 'ov-h-share', 'Sort by share of the stocks shown in this Overview (the same order as the number of stocks)')}` +
    `${btn('pass', 'Passing', 'ov-h-pass', 'Sort by the % of ALL stocks in the group that pass the filters (passed / stocks in the group). The bar is relative to the highest % in the list.')}` +
    `<span></span></div>`;   // the last column (passed / group size) has no header
}

// One block of the Overview: heading, donut, sortable ranked list of EVERY group (the ones in the grey "Other" slice get a grey dot).
function ovSectionHtml(kind, label, rows, ctx = null) {
  const g = ovGroupCounts(rows, kind, OV_TOP, ctx);
  const n = g.groups.length;
  const heading = `${label} <span>${n} ${kind === 'sector' ? (n === 1 ? 'sector' : 'sectors') : (n === 1 ? 'industry' : 'industries')}</span>`;
  const maxPass = Math.max(0, ...g.groups.map(x => (x.passPct === null ? 0 : x.passPct)));
  const chk = x => kind === 'industry'
    ? `<input type="checkbox" class="ov-chk" data-name="${escapeHtml(x.name)}"${ovSel.has(x.name) ? ' checked' : ''}>` : '';
  const list = ovSortGroups(g.groups).map(x =>
    `<div class="ov-row" data-ov="${kind}:${x.slice}">${chk(x)}<i style="background:${x.rank < OV_TOP ? OV_COLORS[x.rank % OV_COLORS.length] : OV_OTHER_COLOR}"></i>` +
    `<span class="ov-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</span><b>${x.count}</b><em>${x.pct.toFixed(1)}%</em>${ovFmtPass(x, maxPass)}</div>`).join('');
  const tools = kind === 'industry'
    ? `<div class="ov-tools">Tick industries with at least <input type="number" id="ovMinN" min="1" step="1" value="${ovMinN}"> stocks ` +
      `<button type="button" class="btn btn-secondary" data-act="selmin">Tick</button>` +
      `<button type="button" class="btn btn-secondary" data-act="clear">Clear</button>` +
      `<button type="button" class="btn btn-primary" data-act="copy" id="ovCopyBtn" title="Copy the stocks of the ticked industries, grouped by industry, as a TradingView watchlist"></button></div>` : '';
  return `<section class="ov-sec${kind === 'industry' ? ' ov-sel' : ''}" data-kind="${kind}" data-total="${g.total}"><h4>${heading}</h4>${tools}` +
    `<div class="ov-body"><div class="ov-chart">${ovDonutSvg(kind, g.slices, g.total)}<div class="ov-cap"></div></div>` +
    `<div class="ov-listbox">${ovHeadHtml(kind)}<div class="ov-list">${list}</div></div></div></section>`;
}

// Draws both sections from ovRows / ovCtx (again on every sort click).
function ovRender() {
  document.getElementById('scrOverviewBody').innerHTML = ovRows.length
    ? ovSectionHtml('sector', 'By sector', ovRows, ovCtx) + ovSectionHtml('industry', 'By industry', ovRows, ovCtx)
    : '<div class="ov-empty">No results - click Scan first.</div>';
  ovUpdateSelection();
}

// ── Picking industries and copying them ──
// The stocks of the ticked industries (from the stocks the Overview is showing), in table order.
function ovSelectedStocks() {
  return (ovRows || []).filter(r => ovSel.has((r && r.industry) || OV_UNDEFINED));
}

// Keeps the copy button's label, its enabled state and the "tick all" box in step with ovSel.
function ovUpdateSelection() {
  const btn = document.getElementById('ovCopyBtn');
  if (btn) {
    const n = ovSelectedStocks().length;
    btn.textContent = `Copy ${n} stock${n === 1 ? '' : 's'} (${ovSel.size} ${ovSel.size === 1 ? 'industry' : 'industries'})`;
    btn.disabled = n === 0;
  }
  const all = document.querySelector('#scrOverviewBody .ov-all');
  if (all) {
    const names = [...ovCountBy(ovRows, 'industry').keys()];
    all.checked = names.length > 0 && names.every(n => ovSel.has(n));
    all.indeterminate = !all.checked && ovSel.size > 0;
  }
}

// Tick every industry that has at least n of the shown stocks (adds to what is ticked already).
function ovSelectMin(n) {
  const min = Math.max(1, Math.floor(Number(n)) || 1);
  ovMinN = min;
  for (const [name, count] of ovCountBy(ovRows, 'industry')) if (count >= min) ovSel.add(name);
  ovRender();
}

function ovClearSel() { ovSel = new Set(); ovRender(); }

function ovToggleIndustry(name, on) {
  if (on) ovSel.add(name); else ovSel.delete(name);
  ovUpdateSelection();
}

function ovToggleAll(on) {
  ovSel = on ? new Set(ovCountBy(ovRows, 'industry').keys()) : new Set();
  ovRender();
}

// The TradingView text for the ticked industries: "###Industry(n),NSE:A,NSE:B,..." biggest industry first (tvWatchlistText in screener.js).
function ovCopyText() {
  const stocks = ovSelectedStocks();
  return stocks.length && typeof tvWatchlistText === 'function' ? tvWatchlistText(stocks, 'industry') : null;
}

function ovCopySelected() {
  const built = ovCopyText();
  const btn = document.getElementById('ovCopyBtn');
  if (!built) return Promise.resolve(false);
  const flash = text => {
    if (!btn) return;
    const keep = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { if (btn.textContent === text) btn.textContent = keep; }, 1500);
  };
  return copyTextToClipboard(built.text).then(ok => { flash(ok ? 'Copied \u2713 ' + built.footer : 'Copy failed'); return ok; });
}

// A header click: sort by that column (its natural direction first: names A-Z, share and % biggest first), or reverse it when it is already the one.
function ovSetSort(col) {
  if (col !== 'name' && col !== 'share' && col !== 'pass') return;
  ovSort = ovSort.col === col ? { col, dir: -ovSort.dir } : { col, dir: col === 'name' ? 1 : -1 };
  ovRender();
}

// Fills the modal from the table's current results and opens it.
function openScannerOverview() {
  const modal = document.getElementById('scrOverviewModal');
  if (!modal) return;
  ovRows = typeof screenerResults !== 'undefined' ? screenerResults : [];
  ovSel = new Set();
  const failed = typeof scrShowingFailed !== 'undefined' && scrShowingFailed;
  // The passing % counts against every stock in the market the scanner looks at (Store.latestBySymbol), whichever list the table is showing.
  ovCtx = {
    universe: typeof Store !== 'undefined' && Store.latestBySymbol ? Object.values(Store.latestBySymbol) : [],
    passed: typeof screenerPassed !== 'undefined' ? screenerPassed : [],
  };
  document.getElementById('scrOverviewTitle').textContent = ovRows.length
    ? `Overview - ${ovRows.length} ${failed ? 'failed' : 'passed'} stock${ovRows.length === 1 ? '' : 's'}`
    : 'Overview';
  ovRender();
  document.getElementById('scrOverviewFoot').textContent = ovRows.length
    ? `Charts and "Stocks" / "Share": the ${failed ? 'failed' : 'passed'} stocks the table is showing now (the symbol search applies). "Passing": passed stocks / all stocks in that ` +
      `sector or industry. A stock with no sector / industry counts as ${OV_UNDEFINED}.`
    : '';
  modal.classList.add('active');
}

function closeScannerOverview() {
  const modal = document.getElementById('scrOverviewModal');
  if (modal) modal.classList.remove('active');
}

// Hover a slice or a list row: that slice's count and share show in the middle of its donut, its name under it, and its list row is lit.
function ovHover(target, on) {
  const el = target && target.closest ? target.closest('[data-ov]') : null;
  if (!el) return;
  const [kind, idx] = el.getAttribute('data-ov').split(':');
  const sec = el.closest('.ov-sec');
  if (!sec) return;
  sec.querySelectorAll('.ov-row.hot, .ov-slice.hot').forEach(x => x.classList.remove('hot'));
  const main = sec.querySelector('.ov-mid-main'), sub = sec.querySelector('.ov-mid-sub'), cap = sec.querySelector('.ov-cap');
  if (!on) {
    main.textContent = sec.getAttribute('data-total'); sub.textContent = 'stocks'; cap.textContent = '';
    return;
  }
  sec.querySelectorAll(`[data-ov="${kind}:${idx}"]`).forEach(x => x.classList.add('hot'));
  const row = sec.querySelector(`.ov-row[data-ov="${kind}:${idx}"] .ov-name`);
  const nums = sec.querySelector(`.ov-row[data-ov="${kind}:${idx}"]`);
  if (row && nums) {
    main.textContent = nums.querySelector('b').textContent;
    sub.textContent = nums.querySelector('em').textContent;
    cap.textContent = row.textContent;
  }
}

(function wireOverview() {
  const body = document.getElementById('scrOverviewBody');
  if (!body) return;
  body.addEventListener('mouseover', e => ovHover(e.target, true));
  body.addEventListener('mouseout', e => ovHover(e.target, false));
  body.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('[data-sort]') : null;
    if (b) { ovSetSort(b.getAttribute('data-sort')); return; }
    const a = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!a) return;
    const act = a.getAttribute('data-act');
    if (act === 'selmin') { const box = document.getElementById('ovMinN'); ovSelectMin(box ? box.value : ovMinN); }
    else if (act === 'clear') ovClearSel();
    else if (act === 'copy') ovCopySelected();
  });
  body.addEventListener('change', e => {
    const t = e.target;
    if (!t || !t.classList) return;
    if (t.classList.contains('ov-chk')) ovToggleIndustry(t.getAttribute('data-name'), t.checked);
    else if (t.classList.contains('ov-all')) ovToggleAll(t.checked);
    else if (t.id === 'ovMinN') ovMinN = Math.max(1, Math.floor(Number(t.value)) || 1);
  });
})();

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('scrOverviewModal');
  if (modal && modal.classList.contains('active')) closeScannerOverview();
});

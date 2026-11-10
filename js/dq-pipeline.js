// ═══════════════════════════════════════════════════════════════════════════════
// DATA QUALITY — "where am I in the price-data pipeline, and what do I run next?"
// ═══════════════════════════════════════════════════════════════════════════════
// The four steps (tabs in the Data Quality page):
//   1 Refresh Data -> 2 Adjust prices from TradingView -> 3 Verify against TradingView -> 4 Verify all stocks (audit)
// dqPipelineState() is a PURE function: from a handful of facts about the data it says, per step, whether it is
// done / to do / needs attention / has to wait for an earlier step / is optional, and which step to do next.
// dqPipelineRender() gathers those facts from the page's existing state (Store + data-quality.js globals) and paints
// the status panel (#dqPipeline), a badge on every workflow strip step (.dq-step[data-step]) and a marker on the tab
// that is next. It draws nothing until the three server loads (corrections, verification, full run) have answered,
// so a half-loaded page never claims "never run".

const DQ_PIPE_STEPS = [
  { id: 'refresh', tab: 'dqRefresh',    n: 1, title: 'Refresh Data' },
  { id: 'adjust',  tab: 'dqCorpAction', n: 2, title: 'Adjust prices from TradingView' },
  { id: 'verify',  tab: 'dqAdjusted',   n: 3, title: 'Verify against TradingView' },
  { id: 'audit',   tab: 'dqFull',       n: 4, title: 'Verify all stocks (full audit)' },
];
const DQ_PIPE_RECHECK_DAYS = 7;   // a "TradingView doesn't adjust this" answer is re-asked after this long: TradingView can catch up
const DQ_PIPE_AUDIT_DAYS = 7;     // a full audit older than this is suggested again
const DQ_PIPE_PUBLISH_HOUR = 19;  // NSE's day files are normally up by the evening (local time)
const DQ_PIPE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dqPipeIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dqPipeFmt = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}-${DQ_PIPE_MONTHS[+m - 1]}-${y}`; };
const dqPipePlural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
// 'YYYY-MM-DD HH:mm' (how the server stamps checks and runs) -> Date, or null
const dqPipeParse = s => {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d) ? null : d;
};
const dqPipeDaysSince = (s, now) => { const d = dqPipeParse(s); return d ? (now - d) / 86400000 : null; };

// The newest trading day NSE should have published by `now`: today after the evening cut-off, else the day before,
// skipping Saturday/Sunday (a market holiday is not known here - the wording says so).
function dqPipeExpectedTradingDay(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < DQ_PIPE_PUBLISH_HOUR) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return dqPipeIso(d);
}

// inp = {
//   latestDate:   'YYYY-MM-DD' | null           newest trading day in the data
//   unadjusted:   [{symbol, exDate, status, checkedAt}]   events in the Not Price-Adjusted list; status/checkedAt are
//                                                the TradingViewAdjustments.csv row for it, null when never checked
//   adjustedStocks: number                       stocks with a price adjustment applied
//   verify:       {pending, major, minor, match, inconclusive, lastVerifiedAt}   "Verify against TradingView" state
//   full:         null | {finishedAt, complete, dataDate, match, minor, major}   the last full run
//   fullRunning:  boolean
//   lastCorrectionAt: 'YYYY-MM-DD HH:mm' | null   when the newest TradingView correction was written
// }
// -> { steps: [{id, tab, n, title, status, detail}], next: step | null, upToDate: boolean }
// status: 'done' | 'todo' | 'attention' | 'later' (waits for an earlier step) | 'optional'
function dqPipelineState(inp, now) {
  const steps = DQ_PIPE_STEPS.map(s => ({ ...s, status: 'done', detail: '' }));
  const [refresh, adjust, verify, audit] = steps;

  // 1 ── Refresh Data
  const expected = dqPipeExpectedTradingDay(now);
  if (!inp.latestDate) {
    refresh.status = 'todo';
    refresh.detail = 'No price data is loaded yet. Click Refresh Data.';
  } else if (inp.latestDate < expected) {
    refresh.status = 'todo';
    refresh.detail = `Data ends ${dqPipeFmt(inp.latestDate)}; NSE has probably published newer days. Click Refresh Data (ignore if the market was closed).`;
  } else {
    refresh.detail = `Data is up to ${dqPipeFmt(inp.latestDate)}.`;
  }

  // 2 ── Adjust prices from TradingView: events NSE gives no ratio for, that TradingView has not been asked about
  //      (or was asked more than a week ago and said "no adjustment" - it may have adjusted since)
  const events = inp.unadjusted || [];
  const fresh = [], stale = [], waiting = [];
  for (const e of events) {
    if (!e.status) fresh.push(e);
    else if (e.status !== 'adjusted') {
      const age = dqPipeDaysSince(e.checkedAt, now);
      (age == null || age > DQ_PIPE_RECHECK_DAYS ? stale : waiting).push(e);
    }
  }
  if (fresh.length || stale.length) {
    adjust.status = 'todo';
    const parts = [];
    if (fresh.length) parts.push(`${dqPipePlural(fresh.length, 'new corporate action')} not yet checked on TradingView (${fresh.slice(0, 4).map(e => e.symbol).join(', ')}${fresh.length > 4 ? ', …' : ''})`);
    if (stale.length) parts.push(`${dqPipePlural(stale.length, 'event')} last checked more than ${DQ_PIPE_RECHECK_DAYS} days ago (TradingView may have adjusted since)`);
    adjust.detail = parts.join('; ') + '. Click Adjust prices from TradingView.';
  } else if (!events.length) {
    adjust.detail = 'No unadjusted corporate actions: nothing to do.';
  } else {
    const oldest = waiting.map(e => dqPipeParse(e.checkedAt)).filter(Boolean).sort((a, b) => a - b)[0];
    const again = oldest ? new Date(oldest.getTime() + DQ_PIPE_RECHECK_DAYS * 86400000) : null;
    adjust.detail = `${dqPipePlural(waiting.length, 'event')} checked recently: TradingView does not adjust ${waiting.length === 1 ? 'it' : 'them'}, so nothing to correct` +
      (again ? ` (re-check from ${dqPipeFmt(dqPipeIso(again))})` : '') + '.';
  }

  // 3 ── Verify against TradingView: the price-adjusted stocks
  const v = inp.verify || {};
  if (!inp.adjustedStocks) {
    verify.detail = 'No price-adjusted stocks to verify.';
  } else if (v.pending > 0) {
    verify.status = adjust.status === 'todo' ? 'later' : 'todo';
    verify.detail = `${dqPipePlural(v.pending, 'price-adjusted stock')} not verified yet` +
      (verify.status === 'later' ? ' (do step 2 first, then verify together).' : '. Click Verify against TradingView.');
  } else if (v.major > 0) {
    verify.status = 'attention';
    verify.detail = `${dqPipePlural(v.major, 'stock')} differ${v.major === 1 ? 's' : ''} materially from TradingView. Open the tab: re-run step 2, or use "Correct major differences".`;
  } else {
    verify.detail = `All ${inp.adjustedStocks} price-adjusted stocks verified: ${v.match} match` +
      (v.minor ? `, ${v.minor} minor` : '') + (v.inconclusive ? `, ${v.inconclusive} inconclusive` : '') + '.';
  }

  // 4 ── Full audit: always optional, never blocks
  const f = inp.full;
  audit.status = 'optional';
  if (inp.fullRunning) {
    audit.detail = 'A full verification is running now. Leave TradingView alone.';
  } else if (!f) {
    audit.detail = 'Never run. A full audit of every stock takes about 35 minutes; do it now and then.';
  } else if (!f.complete) {
    audit.detail = 'The last run was stopped before it finished. Open the tab and click Resume (or run it again).';
  } else {
    const age = dqPipeDaysSince(f.finishedAt, now);
    const when = f.finishedAt ? dqPipeFmt(f.finishedAt) : 'earlier';
    const summary = `${f.match} match, ${f.minor} minor, ${f.major} major`;
    if (f.major > 0 && inp.lastCorrectionAt && f.finishedAt && inp.lastCorrectionAt > f.finishedAt) {
      audit.detail = `The last full run (${when}) is older than the corrections you applied since (${summary} at that time). Its major rows may already be fixed: re-run to refresh the table.`;
    } else if (f.major > 0) {
      audit.status = 'attention';
      audit.detail = `The last full run (${when}) found ${dqPipePlural(f.major, 'major difference')}. Open the tab to see why; fix with step 2 and 3.`;
    } else if (age != null && age > DQ_PIPE_AUDIT_DAYS) {
      audit.detail = `The last full run was ${Math.floor(age)} days ago (${when}; ${summary}). Consider running it again.`;
    } else {
      audit.status = 'done';
      audit.detail = `Last full run ${when}: ${summary}.`;
    }
  }

  // What to do next: the first step that needs doing, in order. Steps that wait for an earlier one are skipped.
  const next = steps.find(s => s.status === 'todo') || steps.find(s => s.status === 'attention') || null;
  const upToDate = !next && steps.every(s => s.status === 'done' || s.status === 'optional');
  return { steps, next, upToDate };
}

// ── Page: gather the facts from what data-quality.js already loaded, and paint ──────────────────────────────────
const _dqPipeReady = { tv: false, verify: false, full: false };

function dqPipelineMark(key) {
  _dqPipeReady[key] = true;
  dqPipelineRender();
}

function dqPipelineInputs() {
  const byKey = new Map((_dqTv.corrections || []).map(c => [dqTvKey(c.symbol, c.exDate), c]));
  const unadjusted = (Store.unadjustedCorpActions || []).map(e => {
    const c = byKey.get(dqTvKey(e.symbol, e.exDate));
    return { symbol: e.symbol, exDate: e.exDate, status: c ? c.status : null, checkedAt: c ? c.checkedAt : null };
  });
  const byIsin = dqAdjustmentsByIsin();
  const counts = { match: 0, minor: 0, major: 0, inconclusive: 0, pending: 0 };
  for (const isin of Object.keys(byIsin)) counts[dqVerifyState(isin, byIsin)]++;
  const corrected = (_dqTv.corrections || []).filter(c => c.status === 'adjusted' && c.checkedAt).map(c => c.checkedAt).sort();
  const f = _dqFull.last;
  const c = (f && f.categories) || {};
  const latestTs = Store.latestDate ? parseDate(Store.latestDate) : 0;
  return {
    latestDate: latestTs ? dqPipeIso(new Date(latestTs)) : null,
    unadjusted,
    adjustedStocks: Object.keys(byIsin).length,
    verify: { ...counts, lastVerifiedAt: _dqVerify.last ? _dqVerify.last.verifiedAt : null },
    full: f ? { finishedAt: f.finishedAt || null, complete: !!f.complete, dataDate: f.dataDate || null,
                match: c.match || 0, minor: c.minor || 0, major: c.major || 0 } : null,
    fullRunning: !!_dqFull.running,
    lastCorrectionAt: corrected.length ? corrected[corrected.length - 1] : null,
  };
}

const DQ_PIPE_BADGE = { done: 'Done', todo: 'To do', attention: 'Needs attention', later: 'After step 2', optional: 'Optional' };
const DQ_PIPE_ICON = { done: '✔', todo: '●', attention: '⚠', later: '○', optional: '○' };

function dqPipelineRender() {
  const host = typeof document !== 'undefined' && document.getElementById('dqPipeline');
  if (!host) return;
  if (!(_dqPipeReady.tv && _dqPipeReady.verify && _dqPipeReady.full)) { host.style.display = 'none'; return; }
  const st = dqPipelineState(dqPipelineInputs(), new Date());
  const esc = escapeHtml;

  let head;
  if (st.next) {
    head = `<div class="dq-pipe-next st-${st.next.status}">
      <div><div class="dq-pipe-nexttitle">${st.next.status === 'attention' ? 'Needs your attention' : 'Do this next'}: step ${st.next.n} &mdash; ${esc(st.next.title)}</div>
      <div class="dq-pipe-why">${esc(st.next.detail)}</div></div>
      <button class="btn btn-primary" onclick="dqPipelineGo('${st.next.tab}')">Open step ${st.next.n}</button></div>`;
  } else {
    const opt = st.steps.find(s => s.status === 'optional');
    head = `<div class="dq-pipe-next st-done"><div><div class="dq-pipe-nexttitle">✔ Everything is up to date &mdash; nothing you have to do now</div>` +
      (opt ? `<div class="dq-pipe-why">Optional: step ${opt.n} &mdash; ${esc(opt.detail)}</div>` : '') + `</div>` +
      (opt ? `<button class="btn btn-secondary" onclick="dqPipelineGo('${opt.tab}')">Open step ${opt.n}</button>` : '') + `</div>`;
  }
  const cards = st.steps.map(s => `<li class="dq-pstep st-${s.status}${st.next && st.next.id === s.id ? ' is-next' : ''}" onclick="dqPipelineGo('${s.tab}')">
      <div class="dq-pstep-top"><span class="dq-pstep-n">${DQ_PIPE_ICON[s.status]} Step ${s.n}</span><span class="dq-badge">${DQ_PIPE_BADGE[s.status]}</span></div>
      <b>${esc(s.title)}</b><span class="dq-pstep-detail">${esc(s.detail)}</span></li>`).join('');
  host.innerHTML = `<div class="dq-pipe-label">Price-data pipeline &mdash; where you are</div>${head}<ol class="dq-pipe-steps">${cards}</ol>`;
  host.style.display = '';

  // the same status on the workflow strip inside each tab, and a marker on the tab that is next
  const by = Object.fromEntries(st.steps.map(s => [s.tab, s]));
  document.querySelectorAll('.dq-step[data-step]').forEach(li => {
    const s = by[li.dataset.step];
    if (!s) return;
    li.classList.remove('st-done', 'st-todo', 'st-attention', 'st-later', 'st-optional');
    li.classList.add('st-' + s.status);
    let b = li.querySelector('.dq-badge');
    if (!b) { b = document.createElement('em'); b.className = 'dq-badge'; li.querySelector('b').appendChild(b); }
    b.textContent = DQ_PIPE_BADGE[s.status];
  });
  document.querySelectorAll('#dqTabbar .dq-tab').forEach(t => t.classList.toggle('dq-next', !!st.next && t.dataset.tab === st.next.tab));
}

function dqPipelineGo(tab) {
  dqSwitchTab(tab);
  const bar = document.getElementById('dqTabbar');
  if (bar && bar.scrollIntoView) bar.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

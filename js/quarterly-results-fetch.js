// Data Quality -> Refresh Data -> "Quarterly results (earnings)": the Fetch quarterly results button.
// The server runs Download-NSE-Bhavcopy.ps1 -FetchResults in the background (src/quarterly_results_fetch.py); this file
// starts it, polls its progress and shows the file's state. It is separate from data-quality.js, which only calls
// qrfLoadStatus() when the tab renders (guarded by typeof). Uses escapeHtml (utils.js) and, when a fetch ends,
// loadQuarterlyResults() (quarterly-results.js) so the scanner and chart table pick up the new numbers without a reload.
let _qrf = { polling: false };

function qrfSetStatus(text, kind) {
  const el = document.getElementById('qrfStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--text2)';
}

// While a fetch runs the Refresh/Reprocess buttons are disabled (the server refuses them: the script also rewrites
// the price files they read).
function qrfSetRunning(running, stopping) {
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('qrfBtn', el => { el.disabled = running; });
  set('dqRefreshBtn', el => { el.disabled = running; });
  set('dqReprocessBtn', el => { el.disabled = running; });
  set('qrfStopBtn', el => {
    el.style.display = running ? '' : 'none';
    el.disabled = !!stopping;
    el.textContent = stopping ? 'Stopping…' : 'Stop';
  });
  set('qrfProgress', el => { el.style.display = running ? '' : 'none'; });
}

// What the results file holds: {exists, rows, stocks, newestQuarter, updatedAt} -> one HTML line.
function qrfSummaryHtml(f) {
  if (!f || !f.exists) {
    return '<span style="color:var(--orange)">No results file yet. The first fetch reads about 14,000 filings and takes around 20 minutes.</span>';
  }
  const bits = [`<b>${f.rows.toLocaleString()}</b> result rows for ${f.stocks.toLocaleString()} stocks`];
  if (f.newestQuarter) bits.push(`newest quarter ended ${escapeHtml(f.newestQuarter)}`);
  if (f.updatedAt) bits.push(`file updated ${escapeHtml(new Date(f.updatedAt * 1000).toLocaleString())}`);
  return `<span style="color:var(--text2)">${bits.join(' · ')}</span>`;
}

// The line under the buttons after a run: the script's own summary, then any warnings it printed.
function qrfResultHtml(s) {
  const r = s.result;
  if (!r || s.status === 'error') return '';
  const parts = [];
  if (r.summary) parts.push(`<span style="color:var(--text2)">Last fetch${s.stopped ? ' (stopped)' : ''}: ${escapeHtml(r.summary)}</span>`);
  (r.warnings || []).forEach(w => parts.push(`<span style="color:var(--orange)">Warning: ${escapeHtml(w)}</span>`));
  return parts.join('<br>');
}

function qrfRender(s) {
  const sum = document.getElementById('qrfSummary');
  if (sum) sum.innerHTML = qrfSummaryHtml(s.file);
  const res = document.getElementById('qrfResult');
  if (res) res.innerHTML = qrfResultHtml(s);
  if (s.status === 'error') qrfSetStatus(s.error || 'Fetching quarterly results failed.', 'error');
}

// One status fetch; picks the progress display back up if a fetch is already running (page reload mid-run). Silent without a server.
async function qrfLoadStatus() {
  try {
    const resp = await fetch('/api/quarterly-results/status', { cache: 'no-store' });
    if (!resp.ok) return;
    const s = await resp.json();
    if (s.status === 'running') {
      qrfSetRunning(true, s.stopping);
      await qrfPoll();
      return;
    }
    qrfSetRunning(false);
    qrfRender(s);
  } catch (e) { /* no server - nothing to show */ }
}

async function qrfStart() {
  qrfSetRunning(true);
  qrfSetStatus('Starting…');
  const res = document.getElementById('qrfResult');
  if (res) res.innerHTML = '';
  try {
    const resp = await fetch('/api/quarterly-results/start', { method: 'POST', headers: { 'X-Requested-With': 'nse-dashboard' } });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j.ok === false) throw new Error(j.error || `Server returned HTTP ${resp.status}. Is the server running the latest code (restart it)?`);
  } catch (e) {
    qrfSetStatus(e.message, 'error');
    qrfSetRunning(false);
    return;
  }
  await qrfPoll();
}

async function qrfStop() {
  qrfSetRunning(true, true);
  qrfSetStatus('Stopping…');
  try {
    await fetch('/api/quarterly-results/stop', { method: 'POST', headers: { 'X-Requested-With': 'nse-dashboard' } });
  } catch (e) { qrfSetStatus('Could not reach the server: ' + e.message, 'error'); }
}

async function qrfPoll() {
  if (_qrf.polling) return;
  _qrf.polling = true;
  try {
    for (;;) {
      const s = await (await fetch('/api/quarterly-results/status', { cache: 'no-store' })).json();
      if (s.status === 'running') {
        qrfSetRunning(true, s.stopping);
        const total = s.total || 0, cur = s.current || 0;
        document.getElementById('qrfFill').style.width = (total ? Math.min(100, cur / total * 100) : 0) + '%';
        const secs = Math.round(Date.now() / 1000 - (s.startedAt || Date.now() / 1000));
        qrfSetStatus(s.stopping ? 'Stopping…' : s.step + (total ? ` (${cur.toLocaleString()}/${total.toLocaleString()})` : ''));
        const last = (s.log || []).slice(-1)[0] || '';
        document.getElementById('qrfDetail').textContent = `${Math.floor(secs / 60)}m ${secs % 60}s elapsed` + (last ? ` · ${last}` : '');
        await new Promise(r => setTimeout(r, 700));
        continue;
      }
      qrfSetRunning(false);
      const fresh = await (await fetch('/api/quarterly-results/status', { cache: 'no-store' })).json();
      qrfRender(fresh);
      if (s.status === 'error') qrfSetStatus(s.error || 'Fetching quarterly results failed.', 'error');
      else {
        qrfSetStatus(s.stopped ? 'Stopped - results read so far are saved.' : 'Quarterly results updated.', 'ok');
        if (typeof loadQuarterlyResults === 'function') loadQuarterlyResults();   // scanner filters + chart table use the new numbers now
      }
      break;
    }
  } catch (e) {
    qrfSetStatus('Lost contact with the server: ' + e.message, 'error');
  } finally {
    _qrf.polling = false;
  }
}

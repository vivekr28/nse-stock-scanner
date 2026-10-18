"""The dashboard's "Fetch quarterly results" button, server side (src/quarterly_results_fetch.py): the progress parser, the
results-file summary, a full run against a fake PowerShell child (finish / fail / stop), and the three HTTP routes incl.
the same-origin header rule and the refusal while a refresh/reprocess runs. The real script is never launched and NSE is
never contacted."""
import json
import os
import threading
import time
import urllib.error
import urllib.request

import nse_server as ns
import quarterly_results as qr
import quarterly_results_fetch as qf

HEADER = 'ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ\n'


def write_results(path, *rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        f.write(HEADER + ''.join(f'"X","{s}","{d}","Consolidated","Audited","01-Jan-2025","1","1","1","1","1","1"\n' for s, d in rows))


def reset_state():
    qf._stop.clear()
    qf._state.update(status='idle', step='', current=0, total=0, startedAt=None, finishedAt=None, error=None,
                     stopping=False, stopped=False, log=[], result=None, warnings=[])


# ── progress lines ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_progress_lines_are_understood():
    p = qf.parse_progress
    assert p('Downloading quarterly results (revenue / profit / EPS)...')['step'] == "Reading NSE's result lists"
    assert "27,109 of 27,112" in p('Integrated-filing list: 27,109 of 27,112 filings received')['step']
    assert p('Filings to read: 1,234') == {'step': 'Reading result filings', 'current': 0, 'total': 1234}
    assert p('Filings to read: 0')['step'] == 'No new result filings to read'
    assert p('Results: 1,500 / 14,000 filings processed...') == {'step': 'Reading result filings', 'current': 1500, 'total': 14000}
    assert p('Other-basis filings to read: 309') == {'step': 'Reading other-basis filings (standalone vs consolidated)', 'current': 0, 'total': 309}
    assert p('Other-basis filings to read: 0')['step'] == 'No other-basis filings to read'
    assert p('Other-basis: 50 / 309 filings processed...') == {'step': 'Reading other-basis filings (standalone vs consolidated)', 'current': 50, 'total': 309}
    assert p('Quarterly results: 29571 rows (12 new; 12 read, 0 without numbers, 0 failed) updated in 40s')['step'] == 'Saving the results file'
    assert p('Downloading market-cap file...')['step'].startswith('Updating NSE price files')
    assert p('something unrelated') is None
    assert p('Warning: x') is None


# ── the file summary ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_file_summary(tmp_path):
    f = str(tmp_path / 'r.csv')
    assert qf.file_summary(f) == {'exists': False}
    write_results(f, ('AAA', '31-Dec-2024'), ('AAA', '31-Mar-2025'), ('BBB', '30-Jun-2025'))
    s = qf.file_summary(f)
    assert s['exists'] and s['rows'] == 3 and s['stocks'] == 2 and s['newestQuarter'] == '30-Jun-2025'
    assert abs(s['updatedAt'] - os.path.getmtime(f)) < 1


# ── a run against a fake PowerShell ────────────────────────────────────────────────────────────────────────────────────

class FakeProc:
    def __init__(self, lines, rc=0, wait_for_terminate=False):
        self.stdout = iter(l + '\n' for l in lines)
        self.rc, self.terminated = rc, False
        self._hold = wait_for_terminate

    def poll(self):
        return None

    def wait(self):
        return -1 if self.terminated else self.rc

    def terminate(self):
        self.terminated = True


def run_with(monkeypatch, tmp_path, lines, rc=0):
    reset_state()
    seen = {}

    def popen(cmd, **kw):
        seen['cmd'] = cmd
        return FakeProc(lines, rc)

    monkeypatch.setattr(qf.subprocess, 'Popen', popen)
    (tmp_path / qf.SCRIPT).write_text('# fake')
    code, body = qf.start(str(tmp_path))
    assert code == 200 and body == {'ok': True, 'started': True}
    for _ in range(200):
        if qf._state['status'] != 'running':
            break
        time.sleep(0.01)
    return seen['cmd']


def test_a_finished_run_reports_progress_summary_and_warnings(monkeypatch, tmp_path):
    cmd = run_with(monkeypatch, tmp_path, [
        'Downloading EQUITY_L.csv (master equity list)...', 'Downloading quarterly results (revenue / profit / EPS)...',
        'Filings to read: 100', 'Results: 50 / 100 filings processed...',
        '  Warning: the older results list is unavailable - timeout',
        'Quarterly results: 29600 rows (30 new; 29 read, 1 without numbers, 0 failed) updated in 9s - newest quarter 30-Sep-2026'])
    assert cmd[-2:] == ['-NoPause', '-FetchResults']          # the on-demand switch, headless
    st = qf._state
    assert st['status'] == 'done' and st['step'] == 'Done.' and not st['stopped']
    assert (st['current'], st['total']) == (50, 100)
    assert st['result']['summary'].startswith('Quarterly results: 29600 rows')
    assert st['result']['warnings'] == ['the older results list is unavailable - timeout']
    assert st['finishedAt'] and not st['stopping']


def test_a_run_clears_the_growth_cache_so_new_results_show_without_a_restart(monkeypatch, tmp_path):
    qr._cache['v'] = (1, b'stale')
    run_with(monkeypatch, tmp_path, ['Quarterly results: 1 rows (1 new) updated'])
    assert 'v' not in qr._cache


def test_a_failing_script_is_an_error_with_its_last_lines(monkeypatch, tmp_path):
    run_with(monkeypatch, tmp_path, ['one', 'two', 'boom'], rc=1)
    assert qf._state['status'] == 'error' and 'boom' in qf._state['error'] and qf._state['finishedAt']


def test_no_powershell_is_an_error_not_a_crash(monkeypatch, tmp_path):
    reset_state()
    (tmp_path / qf.SCRIPT).write_text('# fake')

    def popen(cmd, **kw):
        raise OSError('no such file')
    monkeypatch.setattr(qf.subprocess, 'Popen', popen)
    qf.start(str(tmp_path))
    for _ in range(200):
        if qf._state['status'] != 'running':
            break
        time.sleep(0.01)
    assert qf._state['status'] == 'error' and 'Could not launch PowerShell' in qf._state['error']


def test_missing_script_is_refused(tmp_path):
    reset_state()
    code, body = qf.start(str(tmp_path))
    assert code == 500 and qf.SCRIPT in body['error'] and qf._state['status'] == 'idle'


def test_stop_ends_the_run_and_keeps_what_was_saved(monkeypatch, tmp_path):
    reset_state()
    (tmp_path / qf.SCRIPT).write_text('# fake')
    release = threading.Event()
    proc = FakeProc([])

    def lines():
        yield 'Filings to read: 10\n'
        release.wait(5)
    proc.stdout = lines()
    monkeypatch.setattr(qf.subprocess, 'Popen', lambda cmd, **kw: proc)
    qf.start(str(tmp_path))
    for _ in range(200):
        if qf._state['total'] == 10:
            break
        time.sleep(0.01)
    assert qf.stop() is True and proc.terminated and qf._state['stopping']
    release.set()
    for _ in range(200):
        if qf._state['status'] != 'running':
            break
        time.sleep(0.01)
    assert qf._state['status'] == 'done' and qf._state['stopped'] and 'Stopped' in qf._state['step']
    assert qf.stop() is False                                  # nothing running any more


def test_starting_twice_does_not_start_a_second_run(monkeypatch, tmp_path):
    reset_state()
    (tmp_path / qf.SCRIPT).write_text('# fake')
    qf._state['status'] = 'running'
    assert qf.start(str(tmp_path)) == (200, {'ok': True, 'alreadyRunning': True})
    reset_state()


# ── HTTP routes ────────────────────────────────────────────────────────────────────────────────────────────────────────

def _serve(base_dir):
    srv = ns.ThreadingNSEServer(('127.0.0.1', 0), ns.NSEHandler)
    srv.base_dir = str(base_dir)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _call(srv, method, path, headers=None):
    req = urllib.request.Request(f'http://127.0.0.1:{srv.server_address[1]}{path}', method=method,
                                 data=b'' if method == 'POST' else None, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


SAME_ORIGIN = {'X-Requested-With': 'nse-dashboard'}


def test_status_route_describes_the_file_when_idle(tmp_path):
    reset_state()
    write_results(str(tmp_path / ns.REFERENCE_SUBDIR / qr.RESULTS_FILE), ('AAA', '30-Jun-2026'))
    srv = _serve(tmp_path)
    try:
        status, body = _call(srv, 'GET', '/api/quarterly-results/status')
        assert status == 200 and body['status'] == 'idle'
        assert body['file']['rows'] == 1 and body['file']['newestQuarter'] == '30-Jun-2026'
    finally:
        srv.shutdown(); srv.server_close()


def test_start_and_stop_need_the_same_origin_header(tmp_path):
    reset_state()
    srv = _serve(tmp_path)
    try:
        assert _call(srv, 'POST', '/api/quarterly-results/start')[0] == 403
        assert _call(srv, 'POST', '/api/quarterly-results/stop')[0] == 403
        assert qf._state['status'] == 'idle'
        assert _call(srv, 'POST', '/api/quarterly-results/stop', SAME_ORIGIN) == (200, {'ok': True, 'stopping': False})
    finally:
        srv.shutdown(); srv.server_close()


def test_start_route_runs_the_fetch(monkeypatch, tmp_path):
    reset_state()
    (tmp_path / qf.SCRIPT).write_text('# fake')
    monkeypatch.setattr(qf.subprocess, 'Popen', lambda cmd, **kw: FakeProc(['Quarterly results: 5 rows (5 new) updated']))
    srv = _serve(tmp_path)
    try:
        assert _call(srv, 'POST', '/api/quarterly-results/start', SAME_ORIGIN) == (200, {'ok': True, 'started': True})
        for _ in range(200):
            if qf._state['status'] != 'running':
                break
            time.sleep(0.01)
        status, body = _call(srv, 'GET', '/api/quarterly-results/status')
        assert body['status'] == 'done' and body['result']['summary'].startswith('Quarterly results: 5 rows')
    finally:
        srv.shutdown(); srv.server_close()
        reset_state()


def test_a_running_refresh_blocks_the_fetch_and_a_running_fetch_blocks_refresh(tmp_path):
    reset_state()
    srv = _serve(tmp_path)
    try:
        ns._reprocess_state['status'] = 'running'
        status, body = _call(srv, 'POST', '/api/quarterly-results/start', SAME_ORIGIN)
        assert status == 409 and 'refresh/reprocess is running' in body['error']
        ns._reprocess_state['status'] = 'idle'

        qf._state['status'] = 'running'
        status, body = _call(srv, 'GET', '/api/reprocess/start?download=1')
        assert status == 409 and 'Quarterly results are being fetched' in body['error']
        assert ns._reprocess_state['status'] == 'idle'          # the refresh did not start
    finally:
        ns._reprocess_state['status'] = 'idle'
        reset_state()
        srv.shutdown(); srv.server_close()


def test_nse_server_only_routes_the_fetch_logic_lives_in_its_own_module():
    src = open(os.path.join(os.path.dirname(ns.__file__), 'nse_server.py'), encoding='utf-8').read()
    assert 'import quarterly_results_fetch' in src
    for name in ('def parse_progress', 'def file_summary(', 'def _run(', "'-FetchResults'"):
        assert name not in src, f'{name} belongs in quarterly_results_fetch.py'

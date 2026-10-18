"""Fetch quarterly results from the dashboard (Data Quality -> Refresh Data -> "Quarterly results (earnings)").

The fetch itself is Download-NSE-Bhavcopy.ps1 -FetchResults (it is the only place that knows how to read NSE's result
filings), run headless as a child process in a background thread, with its output parsed into live progress. This module
owns that run's state; nse_server.py only routes /api/quarterly-results/{status,start,stop} to it and refuses a
Refresh/Reprocess while it runs (the script also refreshes the price files those read). Never started automatically.

The script saves QuarterlyResults.csv every 500 filings and at the end, so Stop keeps all but the last <500 filings'
work (they are simply fetched again next time). Fetched numbers need no reprocess: quarterly_results.py reads the file
directly and caches by its modification time. Pure stdlib.
"""
import csv
import os
import re
import subprocess
import threading
import time

import quarterly_results

SCRIPT = 'Download-NSE-Bhavcopy.ps1'

_lock = threading.Lock()
_stop = threading.Event()
_proc = None
_state = {
    'status': 'idle',    # 'idle' | 'running' | 'done' | 'error'
    'step': '',
    'current': 0,        # filings read so far / filings to read (0 until the script reports the count)
    'total': 0,
    'startedAt': None,
    'finishedAt': None,
    'error': None,
    'stopping': False,
    'stopped': False,
    'log': [],           # last few lines of the script's output
    'result': None,      # {summary, warnings} of the last finished run
    'warnings': [],
}


def is_running():
    return _state['status'] == 'running'


def parse_progress(line):
    """One line of the script's output -> the _state fields it implies, or None. Pure."""
    line = line.strip()
    if line.startswith('Downloading quarterly results'):
        return {'step': "Reading NSE's result lists", 'current': 0, 'total': 0}
    m = re.match(r'Integrated-filing list: ([\d,]+) of ([\d,]+) filings received', line)
    if m:
        return {'step': f"NSE's result list: {m.group(1)} of {m.group(2)} filings received"}
    m = re.match(r'Filings to read: ([\d,]+)', line)
    if m:
        n = int(m.group(1).replace(',', ''))
        return {'step': 'Reading result filings' if n else 'No new result filings to read', 'current': 0, 'total': n}
    m = re.match(r'Results: ([\d,]+) / ([\d,]+) filings processed', line)
    if m:
        return {'step': 'Reading result filings', 'current': int(m.group(1).replace(',', '')),
                'total': int(m.group(2).replace(',', ''))}
    if line.startswith('Quarterly results:') and 'rows' in line:
        return {'step': 'Saving the results file'}
    if line.startswith(('Downloading', 'Merging', 'Initializing')):
        return {'step': 'Updating NSE price files first (the script does this too)'}
    return None


def file_summary(path):
    """What is in the results file, for the tab: rows, newest quarter, how many stocks, file time. {'exists': False} if absent."""
    if not os.path.isfile(path):
        return {'exists': False}
    rows, symbols, newest = 0, set(), None
    try:
        with open(path, newline='', encoding='utf-8-sig') as f:
            for r in csv.DictReader(f):
                rows += 1
                symbols.add(r.get('SYMBOL', ''))
                d = quarterly_results.parse_date_str(r.get('TO_DATE'))
                if d and (newest is None or d > newest):
                    newest = d
    except OSError:
        return {'exists': False}
    return {'exists': True, 'rows': rows, 'stocks': len(symbols - {''}),
            'newestQuarter': newest.strftime('%d-%b-%Y') if newest else None, 'updatedAt': os.path.getmtime(path)}


def status(base_dir):
    """The run state plus a summary of the file (skipped while running: the script is rewriting it)."""
    out = dict(_state)
    out['log'] = list(_state['log'])
    out['warnings'] = list(_state['warnings'])
    if _state['status'] != 'running':
        out['file'] = file_summary(os.path.join(base_dir, 'reference-data', quarterly_results.RESULTS_FILE))
    return out


def start(base_dir):
    """Start a fetch. Returns (http status, body dict)."""
    with _lock:
        if _state['status'] == 'running':
            return 200, {'ok': True, 'alreadyRunning': True}
        script = os.path.join(base_dir, SCRIPT)
        if not os.path.exists(script):
            return 500, {'ok': False, 'error': f'{SCRIPT} not found'}
        _stop.clear()
        _state.update(status='running', step='Starting...', current=0, total=0, startedAt=time.time(), finishedAt=None,
                      error=None, stopping=False, stopped=False, log=[], result=None, warnings=[])
    threading.Thread(target=_run, args=(base_dir, script), daemon=True).start()
    return 200, {'ok': True, 'started': True}


def stop():
    """End a running fetch now. Returns whether one was running."""
    with _lock:
        running = _state['status'] == 'running'
        if running:
            _stop.set()
            _state['stopping'] = True
            if _proc is not None and _proc.poll() is None:
                _proc.terminate()
    return running


def _run(base_dir, script):
    global _proc
    st = _state
    summary = None
    try:
        try:
            proc = subprocess.Popen(
                ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoPause', '-FetchResults'],
                cwd=base_dir, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                encoding='utf-8', errors='replace', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except OSError as e:
            raise RuntimeError(f'Could not launch PowerShell: {e}')
        _proc = proc
        if _stop.is_set():          # Stop arrived before the child existed
            proc.terminate()
        for line in proc.stdout:
            line = line.strip()
            if not any(c.isalnum() for c in line):
                continue
            print(f'  [quarterly-results] {line}')
            st['log'] = (st['log'] + [line[:200]])[-8:]
            if line.startswith('Warning:'):
                st['warnings'] = (st['warnings'] + [line[len('Warning:'):].strip()[:300]])[-5:]
            if line.startswith('Quarterly results:') and 'rows' in line:
                summary = line
            update = parse_progress(line)
            if update:
                st.update(update)
        rc = proc.wait()
        stopped = _stop.is_set()
        if rc != 0 and not stopped:
            raise RuntimeError('The download failed: ' + (' | '.join(st['log'][-3:]) or f'exit code {rc}'))
        quarterly_results.clear_cache()      # the file changed: the next /api/quarterly-growth rebuilds it
        st['result'] = {'summary': summary, 'warnings': list(st['warnings'])}
        st['stopped'] = stopped
        st['step'] = 'Stopped - results read so far are saved (in batches of 500).' if stopped else 'Done.'
        st['status'] = 'done'
    except Exception as e:
        st['status'] = 'error'
        st['error'] = str(e)
    finally:
        _proc = None
        st['stopping'] = False
        st['finishedAt'] = time.time()

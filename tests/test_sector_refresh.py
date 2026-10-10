"""Data Quality -> "Refresh Data" tab, server side: the sector-mapping rebuild runner (progress parsing, before/after
diff, mapping summary) and its HTTP endpoints - driven by a fake build script, so Screener.in is never contacted."""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date, timedelta

import pytest

import build_screener_classification as bsc
import nse_server as ns

COLS = bsc.OUT_COLUMNS
TODAY = date(2026, 10, 10)


def _write_mapping(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(','.join(COLS) + '\n')
        for r in rows:
            f.write(','.join(r) + '\n')


def _row(sym, industry='Dyes', sector='Chemicals', source='company', fetched='2026-10-01'):
    return [sym, '01-JAN-2000', industry, sector, 'Commodities', 'Chem', source, fetched] if industry else \
        [sym, '01-JAN-2000', '', '', '', '', '', '']


def _equity(path, symbols):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write('SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\n')
        for s in symbols:
            f.write(f'{s},{s} Ltd,EQ,01-JAN-2000\n')


# --- progress parsing: the real script's own output --------------------------------------------

def test_parse_sector_progress_understands_the_real_scripts_output(tmp_path, monkeypatch, capsys):
    """Run build_screener_classification.main() on canned pages and feed every line it prints through the parser."""
    leaf = '/market/IN01/IN0101/IN010101/IN010101004/'
    data = tmp_path / 'NSE_DATA'
    data.mkdir()
    _equity(data / 'EQUITY_L.csv', ['AAA', 'BBB'])
    pages = {'/market/': f'<a href="{leaf}">x</a>',
             leaf: '<html><a href="/market/IN01/">Commodities</a><a href="/market/IN01/IN0101/">Chemicals</a>'
                   '<a href="/market/IN01/IN0101/IN010101/">Chem</a><h1>Dyes Companies</h1>'
                   '<a href="/company/AAA/">AAA</a></html>',
             '/company/BBB/': ''.join(f'<a href="/x" title="{l}">T</a>'
                                      for l in ('Broad Sector', 'Sector', 'Broad Industry', 'Industry'))}
    monkeypatch.setattr(bsc, 'fetch', lambda path, delay: pages.get(path))
    monkeypatch.setattr(sys, 'argv', ['bsc', '--dir', str(tmp_path), '--delay', '0'])
    bsc.main()
    updates = [u for u in map(ns.parse_sector_progress, capsys.readouterr().out.splitlines()) if u]
    phases = [(u.get('phase'), u.get('total')) for u in updates if 'phase' in u]
    assert ('walk', 1) in phases                      # "1 leaf industries"
    assert ('company', 1) in phases                   # "1 stocks need a company page" (BBB)
    assert any(u.get('step') == 'Saving the mapping' for u in updates)


@pytest.mark.parametrize('line,expected', [
    ('180 leaf industries', {'phase': 'walk', 'current': 0, 'total': 180}),
    ('  walked 25/180', {'phase': 'walk', 'current': 25, 'total': 180}),
    ('340 stocks need a company page', {'phase': 'company', 'current': 0, 'total': 340}),
    ('  150/340', {'phase': 'company', 'current': 150, 'total': 340}),
    ('0 stocks need a company page', {'phase': 'company', 'current': 0, 'total': 0}),
])
def test_parse_sector_progress_fields(line, expected):
    got = ns.parse_sector_progress(line)
    assert {k: got[k] for k in expected} == expected


def test_parse_sector_progress_ignores_other_lines():
    assert ns.parse_sector_progress('No classification found (shown as Undefined-Diversified): A, B') is None
    assert ns.parse_sector_progress('') is None


# --- snapshot / diff -------------------------------------------------------------------------------

def test_sector_snapshot_skips_unclassified_rows(tmp_path):
    p = tmp_path / 'm.csv'
    _write_mapping(str(p), [_row('AAA'), _row('BBB', industry='')])
    assert list(ns.sector_snapshot(str(p))) == ['AAA']
    assert ns.sector_snapshot(str(tmp_path / 'nope.csv')) == {}


def test_diff_counts_added_changed_removed_and_labels_the_finest_tier_that_differs():
    before = {'AAA': ('M', 'Chemicals', 'G', 'Dyes'), 'BBB': ('M', 'Banks', 'G', 'Banks'), 'GONE': ('M', 'S', 'G', 'I'),
              'SEC': ('M', 'Old Sector', 'G', 'Same')}
    after = {'AAA': ('M', 'Chemicals', 'G', 'Specialty'), 'BBB': ('M', 'Banks', 'G', 'Banks'), 'NEW': ('M', 'S', 'G', 'I'),
             'SEC': ('M', 'New Sector', 'G', 'Same')}
    d = ns.diff_sector_snapshots(before, after)
    assert (d['added'], d['changed'], d['removed']) == (1, 2, 1)
    assert d['changedSymbols'] == ['AAA: Dyes → Specialty', 'SEC: Old Sector → New Sector']


# --- mapping summary / advice ------------------------------------------------------------------

@pytest.fixture
def proj(tmp_path):
    (tmp_path / 'NSE_DATA').mkdir()
    return tmp_path


def _summary(proj, **kw):
    return ns.summarize_sector_mapping(str(proj), today=TODAY, **kw)


def test_summary_without_a_mapping_file_asks_for_a_full_run(proj):
    s = _summary(proj)
    assert s['exists'] is False and s['suggest'] == 'full' and s['advice']['level'] == 'due'


def test_summary_up_to_date(proj):
    _write_mapping(str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv'), [_row('AAA'), _row('BBB')])
    _equity(str(proj / 'NSE_DATA' / 'EQUITY_L.csv'), ['AAA', 'BBB'])
    s = _summary(proj)
    assert (s['stocks'], s['classified'], s['unclassified'], s['missing'], s['expired']) == (2, 2, 0, 0, 0)
    assert s['advice']['level'] == 'ok' and s['suggest'] is None and s['ageDays'] == 9


def test_summary_new_listing_missing_from_the_mapping_suggests_quick(proj):
    _write_mapping(str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv'), [_row('AAA')])
    _equity(str(proj / 'NSE_DATA' / 'EQUITY_L.csv'), ['AAA', 'NEWCO'])
    s = _summary(proj)
    assert s['missing'] == 1 and s['suggest'] == 'quick'
    assert s['advice']['level'] == 'due' and '1 newly listed stock is not in the mapping' in s['advice']['text']


def test_summary_a_stale_mapping_suggests_the_full_walk(proj):
    old = (TODAY - timedelta(days=45)).isoformat()
    _write_mapping(str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv'), [_row('AAA', fetched=old)])
    _equity(str(proj / 'NSE_DATA' / 'EQUITY_L.csv'), ['AAA'])
    s = _summary(proj)
    assert s['expired'] == 1 and s['ageDays'] == 45 and s['suggest'] == 'full' and s['advice']['level'] == 'due'


def test_summary_unclassifiable_stocks_alone_do_not_make_a_refresh_due(proj):
    _write_mapping(str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv'), [_row('AAA'), _row('GHOST', industry='')])
    _equity(str(proj / 'NSE_DATA' / 'EQUITY_L.csv'), ['AAA', 'GHOST'])
    s = _summary(proj)
    assert s['unclassified'] == 1 and s['advice']['level'] == 'ok'


def test_summary_reprocess_needed_follows_the_file_times(proj):
    mapping = str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv')
    processed = proj / 'NSE_DATA' / 'processed_data.json'
    _write_mapping(mapping, [_row('AAA')])
    _equity(str(proj / 'NSE_DATA' / 'EQUITY_L.csv'), ['AAA'])
    processed.write_text('{}', encoding='utf-8')
    now = time.time()
    os.utime(mapping, (now - 100, now - 100))
    os.utime(processed, (now - 10, now - 10))
    assert _summary(proj)['reprocessNeeded'] is False
    os.utime(mapping, (now, now))                       # mapping rebuilt after the data was processed
    assert _summary(proj)['reprocessNeeded'] is True


# --- HTTP endpoints with a fake build script -----------------------------------------------------

FAKE_SCRIPT = r'''
import os, sys, time
base = sys.argv[sys.argv.index('--dir') + 1]
quick = '--skip-walk' in sys.argv
mode_file = os.path.join(base, 'mode.txt')
mode = open(mode_file).read().strip() if os.path.exists(mode_file) else 'ok'
if mode == 'fail':
    print('Traceback: could not reach screener', flush=True)
    sys.exit(3)
if not quick:
    print('2 leaf industries', flush=True)
    print('  walked 2/2', flush=True)
print('1 stocks need a company page', flush=True)
out = os.path.join(base, 'NSE_DATA', 'Sector-Stock-Mapping.csv')
head = 'Stock Name,Listing Date,Basic Industry,Sector,Macro Sector,Industry Group,Source,Fetched\n'
rows = ['AAA,01-JAN-2000,Specialty,Chemicals,Commodities,Chem,walk,2026-10-10\n',
        'BBB,01-JAN-2000,Banks,Banks,Commodities,Chem,walk,2026-10-10\n',
        'CCC,01-JAN-2000,Housing,Finance,Financials,Fin,company,2026-10-10\n']
def save():
    open(out, 'w', encoding='utf-8', newline='').write(head + ''.join(rows))
if mode == 'hang':
    time.sleep(60)
if mode == 'save-then-hang':
    save()
    print('  1/1', flush=True)
    time.sleep(60)
save()
print('Wrote 3 of 3 stocks to Sector-Stock-Mapping.csv', flush=True)
'''


@pytest.fixture
def scratch(proj):
    """A scratch project whose build script is the fake above: 3 stocks, one unclassified, data newer than mapping."""
    (proj / 'src').mkdir()
    (proj / 'src' / 'build_screener_classification.py').write_text(FAKE_SCRIPT, encoding='utf-8')
    data = proj / 'NSE_DATA'
    _write_mapping(str(data / 'Sector-Stock-Mapping.csv'),
                   [_row('AAA', industry='Dyes', fetched='2026-09-20'), _row('BBB', industry='Banks', sector='Banks'),
                    _row('CCC', industry='')])
    _equity(str(data / 'EQUITY_L.csv'), ['AAA', 'BBB', 'CCC'])
    (data / 'processed_data.json').write_text('{}', encoding='utf-8')
    old = time.time() - 600
    for name in ('Sector-Stock-Mapping.csv', 'processed_data.json'):
        os.utime(data / name, (old, old))
    return proj


@pytest.fixture
def api(scratch):
    """A real server on a free port over the scratch project."""
    proj = scratch
    server = ns.ThreadingNSEServer(('127.0.0.1', 0), ns.NSEHandler)
    server.base_dir = str(proj)
    server.tv_port = 0
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    saved = (dict(ns._sector_state), dict(ns._reprocess_state))

    def call(path, method='GET', header=True):
        req = urllib.request.Request(base + path, method=method, data=b'' if method == 'POST' else None,
                                     headers={'X-Requested-With': 'nse-dashboard'} if header else {})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def wait_done(timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            _, s = call('/api/sector-mapping/status')
            if s['status'] != 'running':
                return s
            time.sleep(0.1)
        raise AssertionError('rebuild did not finish')

    call.wait_done = wait_done
    call.proj = proj
    yield call
    _sector_stop_all()
    server.shutdown()
    server.server_close()
    ns._sector_state.clear(); ns._sector_state.update(saved[0])
    ns._reprocess_state.clear(); ns._reprocess_state.update(saved[1])


def _sector_stop_all():
    ns._sector_stop.set()
    proc = ns._sector_proc
    if proc is not None and proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=10)
    deadline = time.time() + 10
    while ns._sector_state['status'] == 'running' and time.time() < deadline:
        time.sleep(0.05)


def test_status_before_any_run_describes_the_mapping(api):
    code, s = api('/api/sector-mapping/status')
    assert code == 200 and s['status'] == 'idle' and s['result'] is None
    assert s['mapping']['stocks'] == 3 and s['mapping']['unclassified'] == 1 and s['mapping']['reprocessNeeded'] is False


def test_start_requires_the_same_origin_header(api):
    code, body = api('/api/sector-mapping/start', 'POST', header=False)
    assert code == 403 and body['ok'] is False


def test_a_full_run_reports_progress_the_diff_and_that_a_reprocess_is_needed(api):
    code, body = api('/api/sector-mapping/start', 'POST')
    assert code == 200 and body['started'] is True
    s = api.wait_done()
    assert s['status'] == 'done' and s['stopped'] is False and s['quick'] is False
    assert (s['phase'], s['total']) == ('company', 1)
    assert s['result'] == {'added': 1, 'changed': 1, 'removed': 0, 'changedSymbols': ['AAA: Dyes → Specialty']}
    m = s['mapping']
    assert m['classified'] == 3 and m['reprocessNeeded'] is True      # mapping is now newer than processed_data.json


def test_quick_run_skips_the_walk(api):
    api('/api/sector-mapping/start?quick=1', 'POST')
    s = api.wait_done()
    assert s['quick'] is True and s['status'] == 'done'
    assert not any('leaf industries' in line for line in s['log'])


def test_a_failing_script_surfaces_its_output_as_the_error(api):
    (api.proj / 'mode.txt').write_text('fail', encoding='utf-8')
    api('/api/sector-mapping/start', 'POST')
    s = api.wait_done()
    assert s['status'] == 'error' and 'could not reach screener' in s['error']
    assert s['mapping']['stocks'] == 3                               # untouched


def test_missing_equity_list_is_a_clear_error(api):
    os.remove(api.proj / 'NSE_DATA' / 'EQUITY_L.csv')
    api('/api/sector-mapping/start', 'POST')
    s = api.wait_done()
    assert s['status'] == 'error' and 'EQUITY_L.csv' in s['error'] and 'Refresh Data' in s['error']


def test_stop_ends_a_running_rebuild_and_keeps_what_it_has(api):
    (api.proj / 'mode.txt').write_text('hang', encoding='utf-8')
    api('/api/sector-mapping/start', 'POST')
    deadline = time.time() + 10
    while time.time() < deadline and not ns._sector_state['total']:
        time.sleep(0.05)                                             # the script is in its company phase
    code, body = api('/api/sector-mapping/stop', 'POST')
    assert code == 200 and body['stopping'] is True
    s = api.wait_done()
    assert s['status'] == 'done' and s['stopped'] is True
    assert s['result']['changed'] == 0                               # the hanging script never wrote anything


def test_second_start_while_running_is_reported_not_duplicated(api):
    (api.proj / 'mode.txt').write_text('hang', encoding='utf-8')
    api('/api/sector-mapping/start', 'POST')
    code, body = api('/api/sector-mapping/start', 'POST')
    assert code == 200 and body.get('alreadyRunning') is True
    # while running the status carries progress only - no mapping summary (the file is being rewritten)
    assert api('/api/sector-mapping/status')[1]['mapping'] is None


def test_rebuild_is_refused_while_a_reprocess_runs(api):
    ns._reprocess_state['status'] = 'running'
    code, body = api('/api/sector-mapping/start', 'POST')
    assert code == 409 and 'reprocess' in body['error']
    assert ns._sector_state['status'] == 'idle'


def test_reprocess_is_refused_while_the_rebuild_runs(api):
    (api.proj / 'mode.txt').write_text('hang', encoding='utf-8')
    api('/api/sector-mapping/start', 'POST')
    code, body = api('/api/reprocess/start')
    assert code == 409 and 'rebuilt' in body['error']
    assert ns._reprocess_state['status'] != 'running'


def test_a_new_run_after_a_failure_clears_the_error_and_result(api):
    (api.proj / 'mode.txt').write_text('fail', encoding='utf-8')
    api('/api/sector-mapping/start', 'POST')
    assert api.wait_done()['status'] == 'error'
    (api.proj / 'mode.txt').write_text('ok', encoding='utf-8')
    api('/api/sector-mapping/start', 'POST')
    s = api.wait_done()
    assert s['status'] == 'done' and s['error'] is None
    assert s['result']['changed'] == 1 and s['result']['added'] == 1


def test_stopping_after_a_periodic_save_keeps_those_changes(api):
    """The script saves every 50 stocks; a Stop after one of those leaves the changes on disk, and the tab must
    report them (and that a reprocess is due) rather than 'nothing happened'."""
    (api.proj / 'mode.txt').write_text('save-then-hang', encoding='utf-8')
    api('/api/sector-mapping/start', 'POST')
    deadline = time.time() + 10
    while time.time() < deadline and ns._sector_state['current'] < 1:
        time.sleep(0.05)                                             # past the "1/1" line, i.e. after the save
    api('/api/sector-mapping/stop', 'POST')
    s = api.wait_done()
    assert s['status'] == 'done' and s['stopped'] is True
    assert (s['result']['changed'], s['result']['added']) == (1, 1)
    assert s['mapping']['reprocessNeeded'] is True


def test_a_stop_that_arrives_before_the_child_process_exists_still_ends_the_run(scratch):
    (scratch / 'mode.txt').write_text('hang', encoding='utf-8')
    saved = dict(ns._sector_state)
    try:
        ns._sector_state.update(status='running', step='Starting...', phase='', current=0, total=0, quick=False,
                                startedAt=time.time(), finishedAt=None, error=None, stopping=False, stopped=False,
                                log=[], result=None)
        ns._sector_stop.set()                                        # Stop pressed in the instant before Popen
        worker = threading.Thread(target=ns.run_sector_mapping, args=(str(scratch), False), daemon=True)
        t0 = time.time()
        worker.start()
        worker.join(20)
        assert not worker.is_alive(), 'the run never ended'
        assert time.time() - t0 < 15                                 # not the fake script's 60 s sleep
        assert ns._sector_state['status'] == 'done' and ns._sector_state['stopped'] is True
    finally:
        ns._sector_stop.clear()
        ns._sector_state.clear()
        ns._sector_state.update(saved)


# --- summary edge cases --------------------------------------------------------------------------

def test_summary_without_the_equity_list_has_no_missing_count_and_does_not_crash(proj):
    _write_mapping(str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv'), [_row('AAA')])
    s = _summary(proj)
    assert s['missing'] == 0 and s['advice']['level'] == 'ok'


def test_summary_reprocess_needed_when_nothing_has_been_processed_yet(proj):
    _write_mapping(str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv'), [_row('AAA')])
    s = _summary(proj)
    assert s['processedAt'] is None and s['reprocessNeeded'] is True


def test_summary_wording_is_plural_aware(proj):
    _write_mapping(str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv'), [_row('AAA')])
    _equity(str(proj / 'NSE_DATA' / 'EQUITY_L.csv'), ['AAA', 'N1', 'N2'])
    assert '2 newly listed stocks are not in the mapping yet' in _summary(proj)['advice']['text']


def test_summary_a_file_with_no_fetch_dates_has_unknown_age_and_wants_a_full_run(proj):
    path = str(proj / 'NSE_DATA' / 'Sector-Stock-Mapping.csv')
    _write_mapping(path, [['AAA', '01-JAN-2000', 'Dyes', 'Chemicals', 'Commodities', 'Chem', '', '']])
    _equity(str(proj / 'NSE_DATA' / 'EQUITY_L.csv'), ['AAA'])
    s = _summary(proj)
    assert s['ageDays'] is None and s['lastFetched'] is None and s['suggest'] == 'full'

"""run_tv_verify_full(recheck=True): the "Only flagged stocks" scope of the Data Quality full verification.

It re-verifies ONLY the stocks the last COMPLETE run graded minor or major, merges the fresh results into that
run (every other stock keeps its result), keeps the last full run as the report's "previous run", and leaves the
saved run untouched when it cannot run. TradingView is faked: the chart is a no-op context manager and
_verify_stock returns canned grades, so this exercises the worker's merge/bookkeeping only (the comparison itself
is covered by test_tv_adjust.py).
"""
import json
import os
import time

import pytest

import nse_server as ns

DATES = ['03-Nov-2026', '04-Nov-2026', '05-Nov-2026']


def _graded(status, **extra):
    base = {'status': status, 'bars': 3, 'barsOff': 0, 'maxDevPct': 0.0, 'endDevPct': 0.0, 'worstDate': None,
            'firstOff': None, 'lastOff': None, 'tvOnlyDates': [], 'oursOnlyDates': [], 'causes': [],
            'causeDetails': [], 'note': ''}
    if status in ('minor', 'major'):
        base.update(barsOff=1, maxDevPct=-1.5, worstDate=DATES[0], firstOff=DATES[0], lastOff=DATES[0])
    base.update(extra)
    return base


def _processed():
    """Three stocks, traded most to least: AAA, BBB, CCC."""
    daily = {f'INE{i}': [[d, 100.0 + i] for d in DATES] for i in (1, 2, 3)}
    latest = {f'INE{i}': {'symbol': sym, 'series': 'EQ', 'turnover': (4 - i) * 1000, 'close': 100.0 + i}
              for i, sym in ((1, 'AAA'), (2, 'BBB'), (3, 'CCC'))}
    return {'dailyCols': ['date', 'close'], 'dailyBySymbol': daily, 'latestBySymbol': latest,
            'adjustedCorpActions': [], 'latestDate': DATES[-1]}


class FakeChart:
    def __init__(self, port):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def env(tmp_path, monkeypatch):
    os.makedirs(tmp_path / 'NSE_DATA')
    grades = {'AAA': _graded('major'), 'BBB': _graded('minor'), 'CCC': _graded('match')}
    calls = []

    def fake_verify(chart, symbol, ours, events):
        calls.append(symbol)
        return dict(grades[symbol])   # the worker pops tvOnlyDates/oursOnlyDates off its copy

    monkeypatch.setattr(ns, 'load_processed_data', lambda base_dir: _processed())
    monkeypatch.setattr(ns, 'processed_data_stamp', lambda base_dir: 111)
    monkeypatch.setattr(ns.tv_adjust, 'TradingViewChart', FakeChart)
    monkeypatch.setattr(ns, '_verify_stock', fake_verify)

    class Env:
        base = str(tmp_path)

        def run(self, **kw):
            ns._tv_full_stop.clear()
            ns._tv_full_state.update(status='running', step='Starting...', current=0, total=0, startedAt=time.time(),
                                     finishedAt=None, error=None, warning=None, stopping=False, stopped=False, counts={})
            del calls[:]
            ns.run_tv_verify_full(self.base, 9222, **kw)
            return dict(ns._tv_full_state)

        def saved(self):
            return ns.load_full_verification(self.base)

    e = Env()
    e.grades, e.calls = grades, calls
    return e


def test_recheck_revisits_only_the_flagged_stocks_and_merges_into_the_full_run(env):
    full = env.run()
    assert full['status'] == 'done' and sorted(env.calls) == ['AAA', 'BBB', 'CCC']
    before = env.saved()
    assert before['meta']['complete'] and before['meta']['universe'] == 3

    env.grades['AAA'] = _graded('match')          # fixed since the full run (e.g. a correction was applied)
    st = env.run(recheck=True)

    assert st['status'] == 'done', st
    assert sorted(env.calls) == ['AAA', 'BBB']    # CCC matched, so it is not asked again
    after = env.saved()
    by_symbol = {r['symbol']: r['status'] for r in after['stocks'].values()}
    assert by_symbol == {'AAA': 'match', 'BBB': 'minor', 'CCC': 'match'}   # merged, nothing lost
    m = after['meta']
    assert m['complete'] is True and m['universe'] == 3 and m.get('limit') is None
    assert m['startedAt'] == before['meta']['startedAt'] and m['finishedAt'] == before['meta']['finishedAt']
    assert m['recheck']['count'] == 2 and m['recheck']['of'] == 2 and m['recheck']['stopped'] is False
    assert 'Re-checked 2 of 2 flagged stocks: now 1 match, 1 minor, 0 major' in st['step']


def test_recheck_keeps_the_last_full_run_as_the_previous_run_and_writes_a_new_report(env):
    env.run()
    first_report = env.saved()['meta']['report']
    env.grades['AAA'] = _graded('match')
    env.run(recheck=True)

    prev = ns.load_full_verification(env.base, previous=True)
    assert {r['symbol']: r['status'] for r in prev['stocks'].values()}['AAA'] == 'major'   # the report can say it was resolved
    meta = env.saved()['meta']
    assert meta['report'] and meta['report']['md'] != first_report['md']
    out = os.path.join(env.base, 'NSE_DATA', 'verification-reports')
    assert os.path.exists(os.path.join(out, first_report['md']))        # the full run's own report is not deleted
    md = open(os.path.join(out, meta['report']['md']), encoding='utf-8').read()
    assert '**Re-check:** 2 of the 2 stocks flagged by that run were re-verified' in md
    assert 'Resolved (now match):** 1 - AAA (major->match)' in md


def test_recheck_does_not_double_count_the_calendar_or_change_the_full_runs_duration(env):
    env.grades['AAA'] = _graded('major', tvOnlyDates=['06-Nov-2026'])
    env.run()
    before = env.saved()
    env.run(recheck=True)
    after = env.saved()
    assert after['tvOnlyByDate'] == before['tvOnlyByDate'] == {'06-Nov-2026': 1}
    assert after['meta']['durationSec'] == before['meta']['durationSec']


def test_recheck_without_an_earlier_full_run_is_a_clear_error_and_changes_nothing(env):
    st = env.run(recheck=True)
    assert st['status'] == 'error' and 'Run "Verify all stocks" first' in st['error']
    assert env.saved() is None and env.calls == []


def test_recheck_with_nothing_flagged_is_a_clear_error(env):
    env.grades['AAA'] = _graded('match')
    env.grades['BBB'] = _graded('match')
    env.run()
    st = env.run(recheck=True)
    assert st['status'] == 'error' and 'no flagged' in st['error']
    assert env.calls == []


def test_recheck_of_an_unfinished_run_is_refused_and_the_saved_run_is_untouched(env):
    env.run()
    path = os.path.join(env.base, 'NSE_DATA', ns.FULL_VERIFY_FILE)
    payload = json.load(open(path, encoding='utf-8'))
    payload['meta']['complete'] = False
    json.dump(payload, open(path, 'w', encoding='utf-8'))
    st = env.run(recheck=True)
    assert st['status'] == 'error' and 'did not finish' in st['error']
    assert json.load(open(path, encoding='utf-8')) == payload


def test_a_stock_that_left_the_data_is_skipped_not_fatal(env, monkeypatch):
    env.run()
    data = _processed()
    del data['dailyBySymbol']['INE1']        # AAA is gone from the dashboard data
    monkeypatch.setattr(ns, 'load_processed_data', lambda base_dir: data)
    st = env.run(recheck=True)
    assert st['status'] == 'done' and env.calls == ['BBB']
    assert {r['symbol'] for r in env.saved()['stocks'].values()} == {'AAA', 'BBB', 'CCC'}   # its old result is kept


def test_a_normal_full_run_after_a_recheck_starts_fresh_and_has_no_recheck_note(env):
    env.run()
    env.run(recheck=True)
    env.run()
    meta = env.saved()['meta']
    assert 'recheck' not in meta and meta['complete'] and meta['universe'] == 3

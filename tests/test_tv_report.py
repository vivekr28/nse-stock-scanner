"""Phase 4b: pure-logic tests for src/tv_report.py - category(), primary_cause(),
corp_action_hints(), and a build_report() smoke test covering the "changes since
the previous run" section. No I/O (build_report/build_csv are pure functions over
a plain payload dict, per the module's own docstring).
"""
from datetime import date

import tv_report as tvr


# ─── category ────────────────────────────────────────────────────────────────

def test_category_passthrough_for_match_minor_major():
    assert tvr.category({'status': 'match'}) == 'match'
    assert tvr.category({'status': 'minor'}) == 'minor'
    assert tvr.category({'status': 'major'}) == 'major'


def test_category_inconclusive_split_by_reason():
    assert tvr.category({'status': 'inconclusive', 'reason': 'few-bars'}) == 'few-bars'
    assert tvr.category({'status': 'inconclusive', 'reason': 'predates-history'}) == 'predates'
    assert tvr.category({'status': 'inconclusive', 'reason': 'not-found'}) == 'not-found'
    assert tvr.category({'status': 'inconclusive', 'reason': 'tv-error'}) == 'tv-error'


def test_category_unknown_reason_falls_back_to_other():
    assert tvr.category({'status': 'inconclusive', 'reason': None}) == 'other'
    assert tvr.category({'status': 'inconclusive', 'reason': 'something-new'}) == 'other'


# ─── primary_cause ────────────────────────────────────────────────────────────

def test_primary_cause_missing_event():
    rec = {'causeDetails': [{'kind': 'tv-extra-adjustment'}]}
    assert tvr.primary_cause(rec) == 'missing-event'


def test_primary_cause_adjustments_differ():
    rec = {'causeDetails': [{'kind': 'adjustments-differ'}]}
    assert tvr.primary_cause(rec) == 'adjustments-differ'


def test_primary_cause_tv_no_adjustment():
    rec = {'causeDetails': [{'kind': 'tv-no-adjustment'}]}
    assert tvr.primary_cause(rec) == 'tv-no-adjustment'


def test_primary_cause_defaults_to_unexplained():
    assert tvr.primary_cause({'causeDetails': []}) == 'unexplained'
    assert tvr.primary_cause({}) == 'unexplained'


def test_primary_cause_priority_when_multiple_kinds_present():
    # missing-event ('tv-extra-adjustment') takes priority over adjustments-differ
    # when both are present, per CAUSE_ORDER / the function's own iteration order.
    rec = {'causeDetails': [{'kind': 'adjustments-differ'}, {'kind': 'tv-extra-adjustment'}]}
    assert tvr.primary_cause(rec) == 'missing-event'


# ─── corp_action_hints ─────────────────────────────────────────────────────────

def test_corp_action_hints_hit_within_5_day_window():
    rec = {'symbol': 'FOO', 'causeDetails': [{'kind': 'tv-extra-adjustment', 'date': '10-Jan-2025'}]}
    corp_index = {'ISIN1': [(date(2025, 1, 12), '12-Jan-2025', 'Demerger')]}  # 2 days apart
    hints = tvr.corp_action_hints('ISIN1', rec, corp_index)
    assert hints == ['12-Jan-2025: Demerger']


def test_corp_action_hints_miss_outside_window():
    rec = {'symbol': 'FOO', 'causeDetails': [{'kind': 'tv-extra-adjustment', 'date': '10-Jan-2025'}]}
    corp_index = {'ISIN1': [(date(2025, 1, 20), '20-Jan-2025', 'Demerger')]}  # 10 days apart
    assert tvr.corp_action_hints('ISIN1', rec, corp_index) == []


def test_corp_action_hints_falls_back_to_symbol_lookup():
    rec = {'symbol': 'foo', 'causeDetails': [{'kind': 'tv-extra-adjustment', 'date': '10-Jan-2025'}]}
    # keyed by the UPPERCASED symbol, not the ISIN - corp_action_hints checks both.
    corp_index = {'FOO': [(date(2025, 1, 11), '11-Jan-2025', 'Rights 1:1 @ Premium Rs 0/-')]}
    hints = tvr.corp_action_hints('ISIN_NOT_IN_INDEX', rec, corp_index)
    assert hints == ['11-Jan-2025: Rights 1:1 @ Premium Rs 0/-']


def test_corp_action_hints_ignores_non_missing_event_causes():
    rec = {'symbol': 'FOO', 'causeDetails': [{'kind': 'adjustments-differ', 'date': '10-Jan-2025'}]}
    corp_index = {'ISIN1': [(date(2025, 1, 10), '10-Jan-2025', 'Demerger')]}
    assert tvr.corp_action_hints('ISIN1', rec, corp_index) == []


def test_corp_action_hints_empty_index_returns_empty():
    rec = {'symbol': 'FOO', 'causeDetails': [{'kind': 'tv-extra-adjustment', 'date': '10-Jan-2025'}]}
    assert tvr.corp_action_hints('ISIN1', rec, None) == []
    assert tvr.corp_action_hints('ISIN1', rec, {}) == []


# ─── build_report: summary + "changes since the previous run" ─────────────────

def _stock(symbol, status, turnover=100.0, **extra):
    return {'symbol': symbol, 'series': 'EQ', 'turnover': turnover, 'close': 100.0,
            'status': status, 'reason': None, 'bars': 500, 'barsOff': 0, 'maxDevPct': 0.0,
            'endDevPct': 0.0, 'worstDate': '01-Jan-2025', 'firstOff': None, 'lastOff': None,
            'causes': [], 'causeDetails': [], 'note': '', 'events': [], **extra}


def _payload(stocks, **meta):
    return {'meta': {'startedAt': '2026-01-01 00:00', 'finishedAt': '2026-01-01 01:00',
                      'dataDate': '31-Dec-2025', 'universe': len(stocks), 'complete': True, **meta},
            'calendar': {'tvOnly': [], 'oursOnly': []}, 'stocks': stocks}


def test_build_report_summary_counts():
    stocks = {'I1': _stock('AAA', 'match'), 'I2': _stock('BBB', 'match'), 'I3': _stock('CCC', 'major')}
    md, csv_text = tvr.build_report(_payload(stocks))

    assert '# TradingView price verification report' in md
    assert '| Match | 2 |' in md.replace(',', '')
    assert 'MAJOR difference | 1' in md
    assert csv_text.startswith(','.join(tvr.CSV_COLUMNS) + '\r\n')


def test_build_report_no_prev_omits_changes_section():
    stocks = {'I1': _stock('AAA', 'match')}
    md, _ = tvr.build_report(_payload(stocks))
    assert '## Changes since the previous run' not in md


def test_build_report_delta_section_newly_flagged_and_resolved():
    prev_stocks = {'I1': _stock('AAA', 'match'), 'I2': _stock('BBB', 'major')}
    cur_stocks = {'I1': _stock('AAA', 'major'), 'I2': _stock('BBB', 'match')}  # swapped
    prev = _payload(prev_stocks)
    md, _ = tvr.build_report(_payload(cur_stocks), prev=prev)

    assert '## Changes since the previous run' in md
    assert '**Newly flagged:** 1' in md
    assert 'AAA (match->major)' in md
    assert '**Resolved (now match):** 1' in md
    assert 'BBB (major->match)' in md


def test_build_report_delta_section_no_change_says_so():
    stocks = {'I1': _stock('AAA', 'match'), 'I2': _stock('BBB', 'major')}
    prev = _payload(stocks)
    md, _ = tvr.build_report(_payload(stocks), prev=prev)
    assert 'No stock changed grade.' in md


def test_build_report_delta_section_counts_unseen_stocks():
    prev = _payload({'I1': _stock('AAA', 'match')})
    cur_stocks = {'I1': _stock('AAA', 'match'), 'I2': _stock('BBB', 'match')}  # I2 is new
    md, _ = tvr.build_report(_payload(cur_stocks), prev=prev)
    assert '1 stocks are new to this run' in md.replace(',', '')

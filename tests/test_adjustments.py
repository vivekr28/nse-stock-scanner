"""Phase 3: adjustment-application detail tests, using small synthetic in-memory
daily_by_symbol/events_by_isin structures directly (no CSV files, no process_data()
call) - finer-grained edge cases than Phase 2's one big fixture needed room for:
compounding events, stale-ISIN resolution, chained ISIN bridging, TV-correction
STATUS filtering.

Exact data shapes (confirmed against src/nse_server.py, not assumed):
  - apply_split_adjustments(daily_by_symbol, events_by_isin): events_by_isin is
    {isin: [(ex_dt, ratio), ...]} - 2-tuples, no symbol. This is what
    bridge_split_induced_isin_changes() RETURNS, and what add_rights_events()
    appends more of - it's the "already resolved onto current ISIN" shape.
  - bridge_split_induced_isin_changes(...): its INPUT events_by_isin is instead
    {isin: [(ex_dt, ratio, symbol), ...]} - 3-tuples - the shape
    load_split_bonus_events()/add_tv_corrections() build.
  - add_tv_corrections(events_by_isin, corrections, latest_date_str): appends
    3-tuples (pre-bridge shape) in place; returns the set of applied correction_keys.
  - add_rights_events(events_by_isin, rights, daily_by_symbol, symbol_to_isin,
    recognized=None, unhandled=None): appends 2-tuples in place (post-bridge shape).
"""
from datetime import datetime

import pytest

import nse_server as ns
from conftest import make_day, fmt_date


# ─── apply_split_adjustments ───────────────────────────────────────────────────

def test_apply_split_adjustments_single_event():
    isin = 'ISIN1'
    days = [
        make_day(datetime(2025, 1, 1), 200, isin, prev=200),
        make_day(datetime(2025, 1, 2), 200, isin, prev=200),
        make_day(datetime(2025, 1, 3), 100, isin, prev=200),  # ex-date row itself
        make_day(datetime(2025, 1, 4), 100, isin, prev=100),
    ]
    daily_by_symbol = {isin: days}
    events_by_isin = {isin: [(datetime(2025, 1, 3), 2.0)]}

    ns.apply_split_adjustments(daily_by_symbol, events_by_isin)

    assert [d['close'] for d in days] == [100.0, 100.0, 100.0, 100.0]
    # exDate row's own OHLC untouched (already on post-event scale)...
    assert days[2]['open'] == 100.0
    # ...but its `prev` (yesterday's raw close) IS adjusted - the boundary is
    # <= exDate, not the day after. This is the documented "prev-field boundary fix".
    assert days[2]['prev'] == 100.0
    assert days[0]['prev'] == 100.0
    assert days[3]['prev'] == 100.0  # already on new scale, untouched


def test_apply_split_adjustments_two_compounding_events():
    isin = 'ISIN2'
    days = [
        make_day(datetime(2025, 1, 1), 600, isin, prev=600),
        make_day(datetime(2025, 1, 3), 300, isin, prev=600),  # ex-date 1 (ratio 2)
        make_day(datetime(2025, 1, 4), 300, isin, prev=300),
        make_day(datetime(2025, 1, 5), 100, isin, prev=300),  # ex-date 2 (ratio 3)
        make_day(datetime(2025, 1, 6), 100, isin, prev=100),
    ]
    daily_by_symbol = {isin: days}
    events_by_isin = {isin: [(datetime(2025, 1, 3), 2.0), (datetime(2025, 1, 5), 3.0)]}

    ns.apply_split_adjustments(daily_by_symbol, events_by_isin)

    # Day 1: before BOTH events -> /2/3 = /6 -> 600/6=100
    assert days[0]['close'] == 100.0
    # Day 3 (ex-date 1 row): only the SECOND event still applies (d_dt < ex_dt2) -> /3
    assert days[1]['close'] == 100.0
    # Day 4: between the two events -> only ratio 3 applies -> 300/3=100
    assert days[2]['close'] == 100.0
    # Day 5 (ex-date 2 row) and day 6: unaffected
    assert days[3]['close'] == 100.0
    assert days[4]['close'] == 100.0
    # prev boundaries: day3's prev is <= BOTH ex-dates (Jan3<=Jan3 and Jan3<=Jan5), so both
    # apply -> /2/3=/6 -> 600/6=100
    assert days[1]['prev'] == 100.0
    # day5's prev is <= only event2's ex-date (event1's already passed) -> /3 -> 300/3=100
    assert days[3]['prev'] == 100.0


def test_apply_split_adjustments_skips_falsy_fields():
    isin = 'ISIN3'
    days = [make_day(datetime(2025, 1, 1), 200, isin, prev=0, last=0)]
    daily_by_symbol = {isin: days}
    events_by_isin = {isin: [(datetime(2025, 1, 2), 2.0)]}

    ns.apply_split_adjustments(daily_by_symbol, events_by_isin)

    assert days[0]['close'] == 100.0  # a real field still adjusts
    assert days[0]['last'] == 0        # falsy field left alone, no ZeroDivisionError-style surprise
    assert days[0]['prev'] == 0        # falsy prev left alone too


def test_apply_split_adjustments_isin_with_no_events_untouched():
    isin = 'ISIN4'
    days = [make_day(datetime(2025, 1, 1), 200, isin)]
    daily_by_symbol = {isin: days}
    ns.apply_split_adjustments(daily_by_symbol, {isin: []})
    assert days[0]['close'] == 200.0


def test_apply_split_adjustments_isin_not_in_daily_by_symbol_no_crash():
    ns.apply_split_adjustments({}, {'GHOST_ISIN': [(datetime(2025, 1, 1), 2.0)]})  # must not raise


# ─── add_rights_events ──────────────────────────────────────────────────────────

def _rights_event(symbol, ex_dt, new_shares=1, held_shares=1, premium=0, face_value=10, isin_hint='STALE_ISIN'):
    return {'isin': isin_hint, 'symbol': symbol, 'exDate': fmt_date(ex_dt), 'exDt': ex_dt,
            'subject': f'Rights {new_shares:g}:{held_shares:g} @ Premium Rs {premium:g}/-',
            'newShares': new_shares, 'heldShares': held_shares, 'premium': premium, 'faceValue': face_value}


def test_add_rights_events_resolves_by_symbol_even_with_stale_isin_hint():
    real_isin = 'REAL_ISIN'
    ex_dt = datetime(2025, 1, 10)
    days = [make_day(datetime(2025, 1, 9), 130, real_isin, prev=130)]
    daily_by_symbol = {real_isin: days}
    symbol_to_isin = {'foo': real_isin}
    events_by_isin = {}
    rights = [_rights_event('FOO', ex_dt, isin_hint='SOME_OLD_ISIN_NOT_IN_DAILY')]
    recognized = []

    applied = ns.add_rights_events(events_by_isin, rights, daily_by_symbol, symbol_to_isin, recognized)

    assert applied == 1
    assert real_isin in events_by_isin  # resolved via symbol, not the stale isin_hint
    assert 'SOME_OLD_ISIN_NOT_IN_DAILY' not in events_by_isin
    assert recognized[0]['isin'] == real_isin
    assert recognized[0]['kind'] == 'rights'


def test_add_rights_events_no_history_before_ex_date_silently_skipped():
    isin = 'ISIN5'
    ex_dt = datetime(2025, 1, 1)
    days = [make_day(datetime(2025, 1, 5), 100, isin)]  # only trades AFTER the rights ex-date
    daily_by_symbol = {isin: days}
    symbol_to_isin = {'bar': isin}
    events_by_isin = {}
    unhandled = []

    applied = ns.add_rights_events(events_by_isin, [_rights_event('BAR', ex_dt)],
                                    daily_by_symbol, symbol_to_isin, unhandled=unhandled)

    assert applied == 0
    assert events_by_isin == {}
    assert unhandled == []  # not even flagged as unhandled - there's genuinely nothing to adjust


def test_add_rights_events_stale_cum_close_goes_to_unhandled():
    isin = 'ISIN6'
    ex_dt = datetime(2025, 1, 20)
    # Last trade is 15 calendar days before the ex-date - beyond RIGHTS_MAX_CUM_GAP_DAYS (10).
    days = [make_day(datetime(2025, 1, 5), 130, isin)]
    daily_by_symbol = {isin: days}
    symbol_to_isin = {'baz': isin}
    events_by_isin = {}
    unhandled = []

    applied = ns.add_rights_events(events_by_isin, [_rights_event('BAZ', ex_dt)],
                                    daily_by_symbol, symbol_to_isin, unhandled=unhandled)

    assert applied == 0
    assert events_by_isin == {}
    assert len(unhandled) == 1
    assert unhandled[0]['isin'] == isin


def test_add_rights_events_issue_price_above_market_silently_skipped():
    isin = 'ISIN7'
    ex_dt = datetime(2025, 1, 10)
    days = [make_day(datetime(2025, 1, 9), 100, isin)]
    daily_by_symbol = {isin: days}
    symbol_to_isin = {'qux': isin}
    events_by_isin = {}

    applied = ns.add_rights_events(
        events_by_isin, [_rights_event('QUX', ex_dt, premium=200, face_value=10)],  # issue price 210 >> cum close 100
        daily_by_symbol, symbol_to_isin)

    assert applied == 0
    assert events_by_isin == {}


def test_add_rights_events_composes_with_existing_split_event():
    isin = 'ISIN8'
    rights_ex_dt = datetime(2025, 1, 10)
    split_ex_dt = datetime(2025, 1, 20)
    days = [make_day(datetime(2025, 1, 9), 130, isin)]
    daily_by_symbol = {isin: days}
    symbol_to_isin = {'quux': isin}
    events_by_isin = {isin: [(split_ex_dt, 2.0)]}  # a split event already present, added earlier

    applied = ns.add_rights_events(events_by_isin, [_rights_event('QUUX', rights_ex_dt)],
                                    daily_by_symbol, symbol_to_isin)

    assert applied == 1
    assert len(events_by_isin[isin]) == 2
    dates = [e[0] for e in events_by_isin[isin]]
    assert dates == sorted(dates)  # kept in ex-date order after appending


def test_add_rights_events_unknown_symbol_no_crash():
    events_by_isin = {}
    applied = ns.add_rights_events(events_by_isin, [_rights_event('NOPE', datetime(2025, 1, 1))],
                                    daily_by_symbol={}, symbol_to_isin={})
    assert applied == 0
    assert events_by_isin == {}


# ─── bridge_split_induced_isin_changes ──────────────────────────────────────────

OLD_ISIN = 'INE0BRG01012'
NEW_ISIN = 'INE0BRG01020'  # shares the 10-char issuer prefix with OLD_ISIN


def test_bridge_merges_old_isin_and_resolves_ratio_via_symbol_not_isin_hint():
    daily_by_symbol = {
        OLD_ISIN: [make_day(datetime(2025, 1, 1), 800, OLD_ISIN, symbol='OLDNAME')],
        NEW_ISIN: [make_day(datetime(2025, 1, 8), 400, NEW_ISIN, symbol='FOO')],
    }
    symbol_to_isin = {'foo': NEW_ISIN}
    # isin_hint (first tuple element's containing key) is the OLD isin - the docstring's
    # point (1): PGIL/KAMDHENU-style rows can list either the old or new ISIN unreliably,
    # so resolution must go through `symbol`, not this dict key, regardless.
    events_by_isin = {OLD_ISIN: [(datetime(2025, 1, 8), 2.0, 'FOO')]}

    resolved = ns.bridge_split_induced_isin_changes(daily_by_symbol, symbol_to_isin, events_by_isin)

    assert list(resolved.keys()) == [NEW_ISIN]
    assert resolved[NEW_ISIN] == [(datetime(2025, 1, 8), 2.0)]
    # daily_by_symbol[NEW_ISIN] now has both days, oldest first
    merged = daily_by_symbol[NEW_ISIN]
    assert len(merged) == 2
    assert merged[0]['date'] == fmt_date(datetime(2025, 1, 1))
    assert merged[1]['date'] == fmt_date(datetime(2025, 1, 8))
    # the old ISIN's own entry is left in place (untouched) - it naturally falls out of
    # the final output later via the normal staleness check, not by deletion here.
    assert OLD_ISIN in daily_by_symbol


def test_bridge_chains_two_isin_changes_oldest_first():
    oldest, mid, newest = 'INE0CHN01012', 'INE0CHN01020', 'INE0CHN01038'
    daily_by_symbol = {
        oldest: [make_day(datetime(2025, 1, 1), 100, oldest, symbol='X')],
        mid: [make_day(datetime(2025, 2, 1), 200, mid, symbol='X')],
        newest: [make_day(datetime(2025, 3, 1), 300, newest, symbol='X')],
    }
    symbol_to_isin = {'x': newest}
    events_by_isin = {newest: [(datetime(2025, 3, 1), 1.0, 'X')]}  # any event, just to touch symbol 'x'

    ns.bridge_split_induced_isin_changes(daily_by_symbol, symbol_to_isin, events_by_isin)

    merged_dates = [d['date'] for d in daily_by_symbol[newest]]
    assert merged_dates == [fmt_date(datetime(2025, 1, 1)), fmt_date(datetime(2025, 2, 1)), fmt_date(datetime(2025, 3, 1))]


def test_bridge_does_not_merge_a_prefix_sharing_isin_with_overlapping_dates():
    # OTHER_ISIN shares the prefix but its own last date is NOT before current_isin's
    # first date (the real, load-bearing guard - not symbol-based at all, see the
    # `other_last_dt < current_first_dt` check).
    other_isin = 'INE0BRG01099'
    daily_by_symbol = {
        NEW_ISIN: [make_day(datetime(2025, 1, 8), 400, NEW_ISIN, symbol='FOO')],
        other_isin: [make_day(datetime(2025, 1, 10), 999, other_isin, symbol='UNRELATED')],  # AFTER, not before
    }
    symbol_to_isin = {'foo': NEW_ISIN}
    events_by_isin = {NEW_ISIN: [(datetime(2025, 1, 8), 1.0, 'FOO')]}

    ns.bridge_split_induced_isin_changes(daily_by_symbol, symbol_to_isin, events_by_isin)

    assert len(daily_by_symbol[NEW_ISIN]) == 1  # unchanged - other_isin's days never merged in


def test_bridge_extra_symbols_also_gets_considered_for_bridging():
    # extra_symbols (rights-issue symbols) must be bridged too, even with no split/bonus
    # event of their own - this is what process_data() passes rights symbols through as.
    daily_by_symbol = {
        OLD_ISIN: [make_day(datetime(2025, 1, 1), 800, OLD_ISIN, symbol='RIGHTSCO')],
        NEW_ISIN: [make_day(datetime(2025, 1, 8), 400, NEW_ISIN, symbol='RIGHTSCO')],
    }
    symbol_to_isin = {'rightsco': NEW_ISIN}

    ns.bridge_split_induced_isin_changes(daily_by_symbol, symbol_to_isin, {}, extra_symbols=['RIGHTSCO'])

    assert len(daily_by_symbol[NEW_ISIN]) == 2


# ─── add_tv_corrections ──────────────────────────────────────────────────────────

def _correction(isin, symbol, exdate, factor, status='adjusted'):
    return {'isin': isin, 'symbol': symbol, 'exDate': fmt_date(exdate), 'factor': factor,
            'status': status, 'checkedAt': '2026-01-01 00:00', 'note': ''}


def test_add_tv_corrections_only_adjusted_status_applies():
    events_by_isin = {}
    corrections = [
        _correction('A', 'AAA', datetime(2025, 1, 1), 0.5, status='adjusted'),
        _correction('B', 'BBB', datetime(2025, 1, 1), None, status='tv-unadjusted'),
        _correction('C', 'CCC', datetime(2025, 1, 1), 0.7, status='inconclusive'),
    ]

    applied = ns.add_tv_corrections(events_by_isin, corrections, '31-Dec-2025')

    assert 'A' in events_by_isin
    assert 'B' not in events_by_isin
    assert 'C' not in events_by_isin
    assert len(applied) == 1


def test_add_tv_corrections_factor_of_exactly_one_skipped():
    events_by_isin = {}
    corrections = [_correction('A', 'AAA', datetime(2025, 1, 1), 1.0, status='adjusted')]
    ns.add_tv_corrections(events_by_isin, corrections, '31-Dec-2025')
    assert events_by_isin == {}


def test_add_tv_corrections_future_ex_date_skipped():
    events_by_isin = {}
    corrections = [_correction('A', 'AAA', datetime(2026, 6, 1), 0.5, status='adjusted')]
    ns.add_tv_corrections(events_by_isin, corrections, '31-Dec-2025')  # latest data is before the ex-date
    assert events_by_isin == {}


def test_add_tv_correction_composes_with_split_through_the_real_pipeline_order():
    # Same order process_data() actually calls these in: add_tv_corrections (3-tuple
    # shape) -> bridge_split_induced_isin_changes (converts to 2-tuple, resolved onto
    # the current ISIN) -> apply_split_adjustments. Uses the real bridge function
    # (not an approximation) for full fidelity.
    isin = 'ISIN9'
    split_ex_dt = datetime(2025, 1, 5)
    demerger_ex_dt = datetime(2025, 1, 15)
    days = [make_day(datetime(2025, 1, 1), 1000, isin, prev=1000, symbol='AAA')]
    daily_by_symbol = {isin: days}
    symbol_to_isin = {'aaa': isin}
    events_by_isin = {isin: [(split_ex_dt, 2.0, 'AAA')]}  # pre-bridge (3-tuple) shape

    ns.add_tv_corrections(events_by_isin, [_correction(isin, 'AAA', demerger_ex_dt, 0.5)], '31-Dec-2025')
    resolved = ns.bridge_split_induced_isin_changes(daily_by_symbol, symbol_to_isin, events_by_isin)
    ns.apply_split_adjustments(daily_by_symbol, resolved)

    # Before both ex-dates: /2 (split) and /(1/0.5)=/2 (demerger) -> /4
    assert days[0]['close'] == 250.0

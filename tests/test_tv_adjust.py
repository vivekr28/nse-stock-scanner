"""Phase 4a: pure-logic tests for src/tv_adjust.py - derive_correction, compare_series,
_explain_level_changes. No TradingView access (the live TradingViewChart/_CDPConnection
classes aren't touched here at all) - every function under test takes plain {date: close}
dicts and/or lists, matching what tv_adjust.py's own docstrings specify.
"""
from datetime import date, timedelta

import pytest

import tv_adjust as tva


def dates(n, start=date(2025, 1, 1)):
    return [start + timedelta(days=i) for i in range(n)]


# ─── derive_correction ──────────────────────────────────────────────────────────

def test_derive_correction_clean_factor_gives_adjusted():
    d = dates(6)  # 3 pre-ex-date, ex-date + 2 post
    ex_date = d[3]
    our = {d[0]: 100, d[1]: 100, d[2]: 100, d[3]: 80, d[4]: 100, d[5]: 100}
    tv = {d[0]: 50, d[1]: 50, d[2]: 50, d[3]: 80, d[4]: 100, d[5]: 100}  # r_pre=0.5 flat, r_post=1 flat

    res = tva.derive_correction(tv, our, ex_date)

    assert res['status'] == 'adjusted'
    assert res['factor'] == pytest.approx(0.5)
    assert 'Pre-ex-date prices scaled by 0.50000' in res['note']
    assert 'raw ex-date move -20.0%' in res['note']  # our own close: 100 -> 80 on the ex-date row


def test_derive_correction_tv_not_adjusted_gives_tv_unadjusted():
    d = dates(6)
    ex_date = d[3]
    our = {x: 100 for x in d}
    tv = {x: 100 for x in d}  # ratio flat at 1 on both sides -> no real adjustment

    res = tva.derive_correction(tv, our, ex_date)

    assert res['status'] == 'tv-unadjusted'
    assert res['factor'] is None
    assert 'TradingView shows no adjustment for this event' in res['note']


def test_derive_correction_noisy_ratio_before_ex_date_is_inconclusive():
    d = dates(6)
    ex_date = d[3]
    our = {x: 100 for x in d}
    tv = dict(our)
    tv[d[0]], tv[d[1]], tv[d[2]] = 50, 60, 70  # r_pre = [0.5, 0.6, 0.7] - not flat at all

    res = tva.derive_correction(tv, our, ex_date)

    assert res['status'] == 'inconclusive'
    assert res['factor'] is None
    assert 'do not line up before the ex-date' in res['note']


def test_derive_correction_implausible_factor_is_inconclusive():
    d = dates(6)
    ex_date = d[3]
    our = {x: 100 for x in d}
    tv = dict(our)
    for x in d[:3]:
        tv[x] = 6000  # r_pre = 60 flat -> factor 60, outside the plausible [0.02, 50] range

    res = tva.derive_correction(tv, our, ex_date)

    assert res['status'] == 'inconclusive'
    assert 'Implausible factor' in res['note']


def test_derive_correction_too_few_bars_is_inconclusive():
    d = dates(2)
    ex_date = d[1]
    our = {d[0]: 100, d[1]: 100}  # only 1 bar before, 1 at/after - below the min of 2 each
    tv = {d[0]: 50, d[1]: 100}

    res = tva.derive_correction(tv, our, ex_date)

    assert res['status'] == 'inconclusive'
    assert 'Not enough matching bars' in res['note']


# ─── compare_series ──────────────────────────────────────────────────────────────

def test_compare_series_all_match():
    d = dates(25)
    closes = {x: 100.0 + i for i, x in enumerate(d)}
    res = tva.compare_series(closes, dict(closes))
    assert res['status'] == 'match'
    assert res['barsOff'] == 0


def test_compare_series_minor_when_worst_under_5_and_few_bars_off():
    d = dates(25)
    our = {x: 100.0 for x in d}
    tv = dict(our)
    tv[d[5]] = 102.0   # +2%, exceeds the ~1% tolerance
    tv[d[10]] = 98.0   # -2%
    res = tva.compare_series(our, tv)
    assert res['status'] == 'minor'
    assert res['barsOff'] == 2


def test_compare_series_major_when_a_single_bar_exceeds_5_percent():
    d = dates(25)
    our = {x: 100.0 for x in d}
    tv = dict(our)
    tv[d[5]] = 106.0  # a single +6% bar is enough on its own
    res = tva.compare_series(our, tv)
    assert res['status'] == 'major'
    assert res['barsOff'] == 1


def test_compare_series_major_when_5_or_more_bars_off_even_if_each_is_small():
    d = dates(25)
    our = {x: 100.0 for x in d}
    tv = dict(our)
    for i in (2, 5, 8, 11, 14):
        tv[d[i]] = 102.0  # +2% each, 5 bars - a sustained shift, not individually >=5%
    res = tva.compare_series(our, tv)
    assert res['status'] == 'major'
    assert res['barsOff'] == 5


def test_compare_series_too_few_bars_is_inconclusive():
    d = dates(5)  # under the default min_bars=20
    closes = {x: 100.0 for x in d}
    res = tva.compare_series(closes, dict(closes))
    assert res['status'] == 'inconclusive'
    assert res['reason'] == 'few-bars'


def test_compare_series_event_predating_shared_history_is_inconclusive_not_match():
    d = dates(25)
    closes = {x: 100.0 for x in d}
    # An event whose ex-date is at/before the very first shared bar - can't be tested,
    # since both sides are already on the post-event scale throughout what's shared.
    events = [(d[0], 0.5)]
    res = tva.compare_series(closes, dict(closes), events=events)
    assert res['status'] == 'inconclusive'
    assert res['reason'] == 'predates-history'


def test_compare_series_end_dev_pct_is_the_last_bar_deviation():
    d = dates(21)
    our = {x: 100.0 for x in d}
    tv = dict(our)
    tv[d[-1]] = 103.0  # +3% only on the very last (most recent) shared bar
    res = tva.compare_series(our, tv)
    assert res['endDevPct'] == pytest.approx(3.0, abs=0.01)


def test_compare_series_only_dates_captured_within_shared_range():
    d = dates(22)
    our = {x: 100.0 for x in d[:20]}   # ours stops at d[19]
    tv = {x: 100.0 for x in d[2:22]}   # tv starts at d[2]
    res = tva.compare_series(our, tv, min_bars=15)
    # shared range is [d2, d19]; d0/d1 (ours only, before tv starts) fall outside it,
    # so only genuinely-inside gaps should be reported.
    assert res['tvOnlyDates'] == []
    assert res['oursOnlyDates'] == []


def test_compare_series_causes_populated_for_an_unexplained_level_shift():
    d = dates(25)
    our = {x: 100.0 for x in d}
    tv = dict(our)
    for x in d[10:]:
        tv[x] = 150.0  # a sustained level shift from d[10] onward, no matching event at all
    res = tva.compare_series(our, tv, events=[])
    assert res['status'] == 'major'
    assert len(res['causes']) >= 1
    assert res['causeDetails'][0]['kind'] == 'tv-extra-adjustment'


# ─── _explain_level_changes ─────────────────────────────────────────────────────

def _flat_closes(common, value=100.0):
    return {d: value for d in common}


def test_explain_level_changes_tv_no_adjustment():
    common = dates(6)
    ratios = [2.0, 2.0, 2.0, 1.0, 1.0, 1.0]  # our side halves at index 3, tv stays flat there
    events = [(common[3], 0.5)]  # we applied factor 0.5 exactly at that date

    causes = tva._explain_level_changes(common, ratios, _flat_closes(common), events, tolerance=0.01)

    assert len(causes) == 1
    assert causes[0]['kind'] == 'tv-no-adjustment'
    assert causes[0]['ourFactor'] == pytest.approx(0.5)
    assert causes[0]['tvFactor'] == pytest.approx(1.0)


def test_explain_level_changes_adjustments_differ():
    common = dates(6)
    ratios = [2.0, 2.0, 2.0, 1.0, 1.0, 1.0]
    events = [(common[3], 0.6)]  # our own factor (0.6) doesn't match the observed step (0.5)

    causes = tva._explain_level_changes(common, ratios, _flat_closes(common), events, tolerance=0.01)

    assert len(causes) == 1
    assert causes[0]['kind'] == 'adjustments-differ'
    assert causes[0]['ourFactor'] == pytest.approx(0.6)
    assert causes[0]['tvFactor'] == pytest.approx(1.2)  # f/s = 0.6/0.5


def test_explain_level_changes_tv_extra_adjustment_when_no_nearby_event():
    common = dates(6)
    ratios = [2.0, 2.0, 2.0, 1.0, 1.0, 1.0]
    causes = tva._explain_level_changes(common, ratios, _flat_closes(common), events=[], tolerance=0.01)

    assert len(causes) == 1
    assert causes[0]['kind'] == 'tv-extra-adjustment'
    assert causes[0]['ourFactor'] is None
    assert causes[0]['tvFactor'] == pytest.approx(2.0)  # 1/s = 1/0.5


def test_explain_level_changes_one_bar_blip_is_fully_filtered_out():
    common = dates(5)
    ratios = [1.0, 1.0, 2.0, 1.0, 1.0]  # a single-bar spike that reverts immediately
    causes = tva._explain_level_changes(common, ratios, _flat_closes(common), events=[], tolerance=0.01)
    assert causes == []


def test_explain_level_changes_caps_at_three_causes():
    common = dates(9)
    # Four separate, well-isolated level shifts (each followed by a flat run so none is
    # mistaken for a one-bar blip of the next).
    ratios = [1.0, 2.0, 2.0, 4.0, 4.0, 8.0, 8.0, 16.0, 16.0]
    causes = tva._explain_level_changes(common, ratios, _flat_closes(common), events=[], tolerance=0.01)
    assert len(causes) == 3

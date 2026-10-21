"""Data Quality > Price Adjustments Applied > "Correct major differences from TradingView":
plan_verification_corrections() turns the saved verification's findings into extra factors, and
apply_verification_plan() writes them into TradingViewAdjustments.csv (multiplying a row that is already applied
at that date). Pure data-in / data-out: no TradingView, no processing run."""
import os

import nse_server as ns


def adj(isin, symbol, ex_date, factor):
    return {'isin': isin, 'symbol': symbol, 'exDate': ex_date, 'kind': 'split-bonus', 'detail': '', 'factor': factor}


def result(status='major', events=(), causes=(), symbol='AAA'):
    return {'status': status, 'symbol': symbol, 'events': [list(e) for e in events], 'causeDetails': list(causes)}


def cause(kind, date, our, tv):
    return {'kind': kind, 'date': date, 'ourFactor': our, 'tvFactor': tv}


ADJ = [adj('I1', 'AAA', '10-Jan-2026', 0.5)]


def plan_for(res, adjusted=ADJ, isin='I1'):
    return ns.plan_verification_corrections(adjusted, {'stocks': {isin: res}})


# ─── plan_verification_corrections ──────────────────────────────────────────────

def test_extra_adjustment_factor_is_the_tv_factor():
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[cause('tv-extra-adjustment', '19-Oct-2026', None, 10.0)]))
    assert [(c['exDate'], c['factor']) for c in p['stocks'][0]['corrections']] == [('19-Oct-2026', 10.0)]


def test_differing_adjustment_factor_is_tv_over_ours():
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[cause('adjustments-differ', '10-Jan-2026', 0.5, 0.4)]))
    assert p['stocks'][0]['corrections'][0]['factor'] == 0.8


def test_tv_no_adjustment_undoes_ours():
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[cause('tv-no-adjustment', '10-Jan-2026', 0.5, 1.0)]))
    assert p['stocks'][0]['corrections'][0]['factor'] == 2.0


def test_only_major_stocks_are_planned():
    for status in ('match', 'minor', 'inconclusive'):
        p = plan_for(result(status=status, events=[('10-Jan-2026', 0.5)], causes=[cause('tv-extra-adjustment', '19-Oct-2026', None, 10.0)]))
        assert p == {'stocks': [], 'skipped': []}, status


def test_a_stale_result_is_skipped_not_applied():
    # the stock's adjustments changed since it was verified (e.g. it was corrected already): never corrected twice from one finding
    p = plan_for(result(events=[('10-Jan-2026', 0.25)], causes=[cause('tv-extra-adjustment', '19-Oct-2026', None, 10.0)]))
    assert p['stocks'] == []
    assert 'verify again' in p['skipped'][0]['reason']


def test_major_without_a_single_date_cause_is_skipped():
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[]))
    assert p['stocks'] == [] and 'no single-date cause' in p['skipped'][0]['reason']


def test_implausible_or_unusable_findings_skip_the_whole_stock():
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[cause('tv-extra-adjustment', '19-Oct-2026', None, 400.0)]))
    assert p['stocks'] == [] and 'implausible' in p['skipped'][0]['reason']
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[cause('tv-extra-adjustment', 'not a date', None, 2.0)]))
    assert p['stocks'] == [] and 'usable' in p['skipped'][0]['reason']
    # one bad finding stops the stock: a half-applied correction is worse than none
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[cause('tv-extra-adjustment', '19-Oct-2026', None, 2.0),
                                                              cause('tv-extra-adjustment', '20-Oct-2026', None, 400.0)]))
    assert p['stocks'] == []


def test_a_finding_that_is_already_within_tolerance_is_dropped():
    p = plan_for(result(events=[('10-Jan-2026', 0.5)], causes=[cause('adjustments-differ', '10-Jan-2026', 0.5, 0.5001)]))
    assert p == {'stocks': [], 'skipped': []}


def test_a_stock_with_no_current_adjustment_is_not_in_the_plan():
    assert plan_for(result(events=[]), adjusted=[]) == {'stocks': [], 'skipped': []}


def test_no_verification_means_nothing_to_do():
    assert ns.plan_verification_corrections(ADJ, None) == {'stocks': [], 'skipped': []}


def test_stocks_come_out_sorted_by_symbol():
    adjusted = [adj('I1', 'ZZZ', '10-Jan-2026', 0.5), adj('I2', 'AAA', '10-Jan-2026', 0.5)]
    c = [cause('tv-extra-adjustment', '19-Oct-2026', None, 2.0)]
    ver = {'stocks': {'I1': result(events=[('10-Jan-2026', 0.5)], causes=c, symbol='ZZZ'),
                      'I2': result(events=[('10-Jan-2026', 0.5)], causes=c, symbol='AAA')}}
    assert [s['symbol'] for s in ns.plan_verification_corrections(adjusted, ver)['stocks']] == ['AAA', 'ZZZ']


# ─── apply_verification_plan ────────────────────────────────────────────────────

def write_rows(tmp_path, rows):
    for r in rows:
        r.setdefault('checkedAt', '2026-01-01 00:00')
        r.setdefault('note', '')
    ns.save_tv_corrections(str(tmp_path), rows)


def one_plan(factor=10.0, ex='19-Oct-2026', our=None, tv=10.0):
    return {'stocks': [{'isin': 'I1', 'symbol': 'AAA', 'corrections': [
        {'exDate': ex, 'factor': factor, 'kind': 'tv-extra-adjustment', 'ourFactor': our, 'tvFactor': tv}]}], 'skipped': []}


def test_apply_writes_a_new_adjusted_row(tmp_path):
    assert ns.apply_verification_plan(str(tmp_path), one_plan(), '2026-10-21 20:00') == 1
    rows = ns.load_tv_corrections(str(tmp_path))
    assert len(rows) == 1
    r = rows[0]
    assert (r['isin'], r['symbol'], r['exDate'], r['status'], r['factor']) == ('I1', 'AAA', '19-Oct-2026', 'adjusted', 10.0)
    assert 'TradingView verification' in r['note']


def test_apply_multiplies_a_row_already_applied_at_that_date(tmp_path):
    write_rows(tmp_path, [{'isin': 'I1', 'symbol': 'AAA', 'exDate': '19-Oct-2026', 'factor': 0.5, 'status': 'adjusted', 'note': 'demerger'}])
    ns.apply_verification_plan(str(tmp_path), one_plan(factor=4.0, our=0.5, tv=2.0), 'now')
    rows = ns.load_tv_corrections(str(tmp_path))
    assert len(rows) == 1
    assert rows[0]['factor'] == 2.0                              # 0.5 x 4: what TradingView scales by
    assert rows[0]['note'].startswith('demerger | TradingView verification')


def test_apply_replaces_a_row_that_never_changed_prices(tmp_path):
    write_rows(tmp_path, [{'isin': 'I1', 'symbol': 'AAA', 'exDate': '19-Oct-2026', 'factor': None, 'status': 'tv-unadjusted'}])
    ns.apply_verification_plan(str(tmp_path), one_plan(), 'now')
    rows = ns.load_tv_corrections(str(tmp_path))
    assert [(r['status'], r['factor']) for r in rows] == [('adjusted', 10.0)]


def test_apply_keeps_the_other_rows(tmp_path):
    write_rows(tmp_path, [{'isin': 'I9', 'symbol': 'ZZZ', 'exDate': '01-Mar-2026', 'factor': 0.7, 'status': 'adjusted'}])
    ns.apply_verification_plan(str(tmp_path), one_plan(), 'now')
    assert sorted(r['symbol'] for r in ns.load_tv_corrections(str(tmp_path))) == ['AAA', 'ZZZ']


def test_apply_with_an_empty_plan_writes_nothing(tmp_path):
    assert ns.apply_verification_plan(str(tmp_path), {'stocks': [], 'skipped': []}, 'now') == 0
    assert not os.path.exists(os.path.join(str(tmp_path), ns.REFERENCE_SUBDIR, ns.CORRECTIONS_FILE))


def test_a_written_correction_is_picked_up_by_the_pipeline(tmp_path):
    # the row is folded into the events the same way a TradingView-derived correction is: factor F multiplies the earlier prices
    ns.apply_verification_plan(str(tmp_path), one_plan(factor=4.0, our=None, tv=4.0), 'now')
    events = {}
    applied = ns.add_tv_corrections(events, ns.load_tv_corrections(str(tmp_path)), '31-Dec-2026')
    assert len(applied) == 1
    ((ex, ratio, symbol),) = events['I1']
    assert symbol == 'AAA' and abs(ratio - 0.25) < 1e-9          # the split convention's ratio is 1 / factor

"""`yy` in src/quarterly_results.py: a stock's EPS and sales YoY % for its latest quarter AND the quarter before it, behind the Stock Scanner's
"against the previous quarter" filters (F28 / F29 the change in YoY %, F32 / F33 YoY turned from negative to positive). The figures are the same
ones the chart table shows in `h`: each quarter against the same quarter a year earlier. A quarter with no result, or no YoY % (a loss or zero
year-ago base), is None. A year-ago EPS LOSS has the chart table's (new - old) / |old| figure (hx), so a loss turning to a profit is a positive
YoY % and the turnaround filters can see it."""
import json

import quarterly_results as qr

HEADER = ('ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ,'
          'ALT_BASIS,ALT_REVENUE_CR,ALT_PBT_CR,ALT_NET_PROFIT_CR,ALT_EPS_BASIC,ALT_EPS_DILUTED,ALT_SEQ\n')


def arow(sym, to_date, sales, eps, basis='Consolidated', profit=10):
    return f'"","{sym}","{to_date}","{basis}","Unaudited","01-Feb-2025","{sales}","0","{profit}","{eps}","{eps}","1",,,,,,,\n'


def growth(tmp_path, *rows):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + ''.join(rows), encoding='utf-8')
    return qr.build_quarterly_growth(str(f))


# Antelopus-like: Jun-25 and Mar-25 on the left of Jun-26 and Mar-26 (EPS 3.19 -> 15.45 is +384%, 10.48 -> 10.83 is +3%)
ANTELOPUS = (arow('A', '31-Mar-2025', 61.72, 10.48), arow('A', '30-Jun-2025', 50.63, 3.19),
             arow('A', '31-Mar-2026', 102.01, 10.83), arow('A', '30-Jun-2026', 131.04, 15.45))


def test_the_latest_and_the_previous_quarters_yoy_percentages_are_on_the_record(tmp_path):
    g = growth(tmp_path, *ANTELOPUS)
    # [EPS YoY now, EPS YoY a quarter ago, sales YoY now, sales YoY a quarter ago]
    assert g['a']['yy'] == [384.33, 3.34, 158.82, 65.28]


def test_they_are_the_figures_the_chart_table_shows(tmp_path):
    g = growth(tmp_path, *ANTELOPUS)['a']
    h = g['h']                                                  # oldest first, the latest quarter last
    assert g['yy'] == [h[-1][4], h[-2][4], h[-1][2], h[-2][2]]  # EPS growth is item 4, sales growth item 2


def test_a_fall_is_a_negative_percentage(tmp_path):
    g = growth(tmp_path, arow('A', '31-Dec-2024', 100, 10), arow('A', '31-Mar-2025', 100, 20),
               arow('A', '31-Dec-2025', 80, 6), arow('A', '31-Mar-2026', 90, 25))
    assert g['a']['yy'] == [25.0, -40.0, -10.0, -20.0]


def test_a_loss_year_ago_base_has_the_tables_percentage_and_a_zero_base_has_none(tmp_path):
    g = growth(tmp_path, arow('A', '31-Mar-2025', 100, -2), arow('A', '30-Jun-2025', 100, 3),
               arow('A', '31-Mar-2026', 120, 5), arow('A', '30-Jun-2026', 130, 6))
    assert g['a']['yy'][0] == 100.0 and g['a']['yy'][1] == 350.0  # Mar-26: (5 - -2) / |-2| = +350% (the table's number); Jun-26: 3 -> 6
    assert g['a']['yy'][2] == 30.0 and g['a']['yy'][3] == 20.0    # sales are fine in both
    z = growth(tmp_path, arow('Z', '31-Mar-2025', 100, 0), arow('Z', '30-Jun-2025', 100, 3),
               arow('Z', '31-Mar-2026', 120, 5), arow('Z', '30-Jun-2026', 130, 6))
    assert z['z']['yy'][0] == 100.0 and z['z']['yy'][1] is None   # a zero year-ago EPS cannot be divided: still no %


def test_a_loss_that_turns_to_a_profit_then_keeps_growing_is_not_a_second_turnaround(tmp_path):
    # PVRINOX-like: Jun-25 -5.51 vs -18.21 (+70%), Sep-25 10.78 vs -1.20 (+998%), then Sep-26 26.82 against 10.78 (+149%) after Jun-26 5.75 vs -5.51 (+204%)
    g = growth(tmp_path, arow('P', '30-Jun-2024', 100, -18.21), arow('P', '30-Sep-2024', 100, -1.2),
               arow('P', '30-Jun-2025', 100, -5.51), arow('P', '30-Sep-2025', 100, 10.78),
               arow('P', '30-Jun-2026', 100, 5.75), arow('P', '30-Sep-2026', 100, 26.82))['p']
    assert g['yy'][:2] == [148.79, 204.36]                        # Sep-26 and Jun-26: positive both, so F32 (negative then, positive now) does not fire
    assert g['qq']['2025-09-30']['yy'][:2] == [998.33, 69.74]     # Sep-25 and Jun-25: a loss that narrowed, then a profit


def test_a_missing_previous_quarter_is_none_but_the_latest_is_still_measured(tmp_path):
    g = growth(tmp_path, arow('A', '30-Jun-2025', 100, 3), arow('A', '30-Jun-2026', 150, 9))      # no Mar-2026, no Mar-2025
    assert g['a']['yy'] == [200.0, None, 50.0, None]


def test_a_stock_with_no_year_ago_quarter_has_none_for_both(tmp_path):
    g = growth(tmp_path, arow('A', '31-Mar-2026', 100, 3), arow('A', '30-Jun-2026', 150, 9))
    assert g['a']['yy'] == [None, None, None, None]


def test_each_stock_is_judged_on_its_own_latest_and_its_previous_quarter(tmp_path):
    g = growth(tmp_path,
               arow('OLD', '31-Dec-2024', 100, 10), arow('OLD', '30-Sep-2025', 100, 5), arow('OLD', '31-Dec-2025', 110, 15),       # latest Dec-25, previous Sep-25
               arow('NEW', '31-Mar-2025', 100, 10), arow('NEW', '30-Jun-2025', 100, 10), arow('NEW', '31-Mar-2026', 100, 10), arow('NEW', '30-Jun-2026', 150, 30))
    assert g['old']['q'] == '2025-12-31' and g['old']['yy'][:2] == [50.0, None]               # Sep-24 is not on file: the previous quarter has no YoY %
    assert g['new']['q'] == '2026-06-30' and g['new']['yy'][:2] == [200.0, 0.0]


def test_a_quarter_compared_on_the_other_basis_uses_that_basis_figures(tmp_path):
    # Jun-26 filed consolidated against a standalone Jun-25: its EPS YoY % is the one the chart table shows (h)
    g = growth(tmp_path, arow('X', '31-Mar-2025', 100, 10, 'Standalone'), arow('X', '30-Jun-2025', 100, 10, 'Standalone'),
               arow('X', '31-Mar-2026', 110, 20, 'Standalone'), arow('X', '30-Jun-2026', 120, 30, 'Standalone'))
    assert g['x']['yy'] == [200.0, 100.0, 20.0, 10.0]


def test_the_old_sequential_fields_are_gone(tmp_path):
    g = growth(tmp_path, *ANTELOPUS)['a']
    assert not any(k in g for k in ('qe', 'qs', 'qp', 'qet', 'qst'))


def test_it_travels_in_the_payload_for_every_stock(tmp_path):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + ''.join(ANTELOPUS) + arow('B', '30-Jun-2026', 100, 15), encoding='utf-8')
    doc = json.loads(json.dumps(qr.payload(str(f))))
    assert doc['bySymbol']['a']['yy'] == [384.33, 3.34, 158.82, 65.28]
    assert doc['bySymbol']['b']['yy'] == [None, None, None, None]


# ── qq: the stock's 7 quarters before its latest, each as its own comparison record (the scanner's quarter picker) ──────────

def _nine(sym='A'):
    """Nine quarters, Jun-24 to Jun-26, sales 100, 110, ... 180 and EPS 10, 11, ... 18 (profit 10 throughout)."""
    dates = ('30-Jun-2024', '30-Sep-2024', '31-Dec-2024', '31-Mar-2025', '30-Jun-2025', '30-Sep-2025', '31-Dec-2025', '31-Mar-2026', '30-Jun-2026')
    return [arow(sym, d, 100 + 10 * i, 10 + i) for i, d in enumerate(dates)]


def test_qq_holds_the_seven_quarters_before_the_latest_keyed_by_quarter_end(tmp_path):
    g = growth(tmp_path, *_nine())['a']
    assert g['q'] == '2026-06-30'
    assert sorted(g['qq']) == ['2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31']   # not Jun-24 (8 back) nor Jun-26 (the record itself)
    assert all(rec['q'] == key for key, rec in g['qq'].items())


def test_an_earlier_quarter_is_judged_against_its_own_year_ago_quarter(tmp_path):
    mar26 = growth(tmp_path, *_nine())['a']['qq']['2026-03-31']       # sales 170 against Mar-25's 130, EPS 17 against 13
    assert (mar26['cmp'], mar26['s'], mar26['sp'], mar26['sg']) == ('ok', 170.0, 130.0, 30.77)
    assert (mar26['e'], mar26['ep'], mar26['eg']) == (10.0, 10.0, 0.0)  # net profit is flat in this fixture
    assert mar26['yy'] == [30.77, 33.33, 30.77, 33.33]                  # Mar-26 and the quarter before it, Dec-25 (160 against 120, EPS 16 against 12)


def test_its_yy_is_that_quarters_yoy_percentages_and_the_quarter_before_its_own(tmp_path):
    g = growth(tmp_path, *ANTELOPUS)['a']
    assert g['yy'] == [384.33, 3.34, 158.82, 65.28]
    assert g['qq']['2026-03-31']['yy'] == [3.34, None, 65.28, None]     # Mar-26 against Mar-25; Dec-25 is not on file, so the quarter before has no YoY %


def test_the_record_matches_the_top_level_one_for_the_same_quarter(tmp_path):
    # Mar-26 judged as an earlier quarter (qq) equals Mar-26 judged as the latest when Jun-26 is absent from the file
    full = growth(tmp_path, *_nine())['a']['qq']['2026-03-31']
    cut = growth(tmp_path, *_nine()[:-1])['a']
    assert cut['q'] == '2026-03-31'
    for k in ('cmp', 's', 'sp', 'e', 'ep', 'sg', 'eg'):
        assert full[k] == cut[k], k
    assert full['yy'] == cut['yy']


def test_a_quarter_not_on_file_has_no_record_and_a_stock_with_no_earlier_quarters_has_no_qq(tmp_path):
    g = growth(tmp_path, arow('A', '30-Jun-2026', 100, 5), arow('A', '31-Dec-2025', 90, 4))      # Mar-26 missing
    assert list(g['a']['qq']) == ['2025-12-31']
    g = growth(tmp_path, arow('B', '30-Jun-2026', 100, 5))
    assert 'qq' not in g['b']


def test_none_and_false_values_are_left_out_of_a_record_to_keep_the_payload_small(tmp_path):
    g = growth(tmp_path, arow('A', '31-Mar-2026', 100, 3), arow('A', '30-Jun-2026', 150, 9))
    rec = g['a']['qq']['2026-03-31']
    assert rec['cmp'] == 'no-prev'                                  # no year-ago quarter: sp / ep / sg / eg are None, st / et False
    assert not any(k in rec for k in ('sp', 'ep', 'sg', 'eg', 'st', 'et'))
    assert rec['yy'] == [None, None, None, None]                    # but yy keeps its four slots


def test_a_loss_year_ago_quarter_keeps_its_turnaround_flag(tmp_path):
    g = growth(tmp_path, arow('A', '31-Mar-2025', 100, -2, profit=-5), arow('A', '31-Mar-2026', 120, 6, profit=8), arow('A', '30-Jun-2026', 130, 7))
    rec = g['a']['qq']['2026-03-31']
    assert rec['et'] is True and 'eg' not in rec                    # profit now after a loss: a turnaround, with no growth %


def test_qq_travels_in_the_payload(tmp_path):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + ''.join(ANTELOPUS), encoding='utf-8')
    rec = json.loads(json.dumps(qr.payload(str(f))))['bySymbol']['a']
    assert rec['qq']['2026-03-31']['yy'] == [3.34, None, 65.28, None] and rec['qq']['2025-06-30']['q'] == '2025-06-30'

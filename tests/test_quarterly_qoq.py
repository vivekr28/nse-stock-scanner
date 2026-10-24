"""`yy` in src/quarterly_results.py: a stock's EPS and sales YoY % for its latest quarter AND the quarter before it, behind the Stock Scanner's
"against the previous quarter" filters (F28 / F29 the change in YoY %, F32 / F33 YoY turned from negative to positive). The figures are the same
ones the chart table shows in `h`: each quarter against the same quarter a year earlier. A quarter with no result, or no YoY % (a loss or zero
year-ago base), is None."""
import json

import quarterly_results as qr

HEADER = ('ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ,'
          'ALT_BASIS,ALT_REVENUE_CR,ALT_PBT_CR,ALT_NET_PROFIT_CR,ALT_EPS_BASIC,ALT_EPS_DILUTED,ALT_SEQ\n')


def arow(sym, to_date, sales, eps, basis='Consolidated'):
    return f'"","{sym}","{to_date}","{basis}","Unaudited","01-Feb-2025","{sales}","0","10","{eps}","{eps}","1",,,,,,,\n'


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


def test_a_loss_or_zero_year_ago_base_has_no_percentage_for_that_quarter_only(tmp_path):
    g = growth(tmp_path, arow('A', '31-Mar-2025', 100, -2), arow('A', '30-Jun-2025', 100, 3),
               arow('A', '31-Mar-2026', 120, 5), arow('A', '30-Jun-2026', 130, 6))
    assert g['a']['yy'][0] == 100.0 and g['a']['yy'][1] is None   # Mar-26 EPS has a loss a year earlier: no %; Jun-26 does (3 -> 6)
    assert g['a']['yy'][2] == 30.0 and g['a']['yy'][3] == 20.0    # sales are fine in both


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

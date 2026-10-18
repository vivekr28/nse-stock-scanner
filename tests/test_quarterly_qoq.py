"""`qe` and `qs` in src/quarterly_results.py: a stock's latest-quarter net profit and sales against the PREVIOUS quarter (a sequential step,
not the year-ago comparison), behind the Stock Scanner's "QoQ Earnings" / "QoQ Sales" filters (and their latest-quarter versions).
Measured on a basis both quarters hold (the ALT_* columns cover a switch between standalone and consolidated), None when the previous
quarter's profit / sales is not positive, and absent when the previous quarter is not on file at all."""
import json

import quarterly_results as qr

HEADER = ('ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ,'
          'ALT_BASIS,ALT_REVENUE_CR,ALT_PBT_CR,ALT_NET_PROFIT_CR,ALT_EPS_BASIC,ALT_EPS_DILUTED,ALT_SEQ\n')


def arow(sym, to_date, basis, sales, profit, alt=None):
    base = f'"","{sym}","{to_date}","{basis}","Unaudited","01-Feb-2025","{sales}","0","{profit}","1","1","1",'
    if alt is None:
        return base + ',,,,,,\n'
    ab, asales, aprofit = alt
    return base + f'"{ab}","{asales}","0","{aprofit}","1","1","2"\n'


def growth(tmp_path, *rows):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + ''.join(rows), encoding='utf-8')
    return qr.build_quarterly_growth(str(f))


def test_profit_and_sales_against_the_previous_quarter_are_percentages_on_the_record(tmp_path):
    g = growth(tmp_path, arow('AAA', '31-Mar-2026', 'Consolidated', 100, 10), arow('AAA', '30-Jun-2026', 'Consolidated', 120, 15))
    assert (g['aaa']['qe'], g['aaa']['qs']) == (50.0, 20.0)      # profit 15 against 10, sales 120 against 100
    assert g['aaa']['cmp'] == 'no-prev'                          # independent of the year-ago comparison, which has nothing to compare with here


def test_a_fall_is_a_negative_percentage_rounded_to_two_places(tmp_path):
    g = growth(tmp_path, arow('AAA', '31-Mar-2026', 'Consolidated', 90, 30), arow('AAA', '30-Jun-2026', 'Consolidated', 60, 20))
    assert (g['aaa']['qe'], g['aaa']['qs']) == (-33.33, -33.33)


def test_no_percentage_from_a_zero_or_loss_making_previous_quarter_or_from_zero_sales(tmp_path):
    for prev in (0, -5):
        g = growth(tmp_path, arow('AAA', '31-Mar-2026', 'Consolidated', 100, prev), arow('AAA', '30-Jun-2026', 'Consolidated', 100, 20))
        assert g['aaa']['qe'] is None and g['aaa']['qs'] == 0.0   # no % from a loss, but sales (100 against 100) are measured
    g = growth(tmp_path, arow('AAA', '31-Mar-2026', 'Consolidated', 0, 10), arow('AAA', '30-Jun-2026', 'Consolidated', 50, 15))
    assert g['aaa']['qe'] == 50.0 and g['aaa']['qs'] is None      # no sales to grow from


def test_absent_when_the_previous_quarter_is_not_on_file(tmp_path):
    g = growth(tmp_path, arow('AAA', '31-Dec-2025', 'Consolidated', 100, 10), arow('AAA', '30-Jun-2026', 'Consolidated', 100, 15))   # Mar-2026 missing
    assert 'qe' not in g['aaa'] and 'qs' not in g['aaa']
    g = growth(tmp_path, arow('AAA', '30-Jun-2026', 'Consolidated', 100, 15))
    assert 'qe' not in g['aaa'] and 'qs' not in g['aaa']


def test_each_stock_is_judged_on_its_own_latest_and_its_previous_quarter(tmp_path):
    g = growth(tmp_path,
               arow('OLD', '31-Dec-2025', 'Consolidated', 100, 10), arow('OLD', '31-Mar-2026', 'Consolidated', 110, 12),   # latest Mar-26, previous Dec-25
               arow('NEW', '31-Mar-2026', 'Consolidated', 100, 10), arow('NEW', '30-Jun-2026', 'Consolidated', 150, 30))
    assert (g['old']['qe'], g['old']['qs']) == (20.0, 10.0) and (g['new']['qe'], g['new']['qs']) == (200.0, 50.0)


def test_a_switch_between_standalone_and_consolidated_uses_a_basis_both_quarters_hold(tmp_path):
    # previous quarter standalone only; the latest was filed consolidated but also carries its standalone figures
    g = growth(tmp_path,
               arow('XX', '31-Mar-2026', 'Standalone', 100, 10),
               arow('XX', '30-Jun-2026', 'Consolidated', 300, 99, alt=('Standalone', 118, 12)))
    assert (g['xx']['qe'], g['xx']['qs']) == (20.0, 18.0)         # 12 against 10 and 118 against 100 on Standalone, not 99 / 300


def test_without_a_common_basis_the_step_is_none_not_a_made_up_number(tmp_path):
    g = growth(tmp_path, arow('XX', '31-Mar-2026', 'Standalone', 100, 10), arow('XX', '30-Jun-2026', 'Consolidated', 120, 99))
    assert g['xx']['qe'] is None and g['xx']['qs'] is None


def test_it_travels_in_the_payload_only_for_stocks_that_have_it(tmp_path):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + arow('A', '31-Mar-2026', 'Consolidated', 100, 10) + arow('A', '30-Jun-2026', 'Consolidated', 100, 15)
                 + arow('B', '30-Jun-2026', 'Consolidated', 100, 15), encoding='utf-8')
    doc = json.loads(json.dumps(qr.payload(str(f))))
    assert doc['bySymbol']['a']['qe'] == 50.0 and doc['bySymbol']['a']['qs'] == 0.0
    assert 'qe' not in doc['bySymbol']['b'] and 'qs' not in doc['bySymbol']['b']

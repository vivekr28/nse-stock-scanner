"""`hx` in src/quarterly_results.py: the % change of EPS, (new - old) / |old| (so a rise is always +), for the chart table where the year-ago EPS was a
loss (h's own EPS growth is None there, because the scanner's filters need a positive base). It is DISPLAY ONLY: the filters' growth figures
(eg / sg / the history's growth) are untouched. Real case: DEEPINDS Mar-26 (EPS -2.24 against -32.68 a year earlier) used to show n/a."""
import json

import quarterly_results as qr

HEADER = ('ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ,'
          'ALT_BASIS,ALT_REVENUE_CR,ALT_PBT_CR,ALT_NET_PROFIT_CR,ALT_EPS_BASIC,ALT_EPS_DILUTED,ALT_SEQ\n')


def arow(sym, to_date, basis, eps, profit=10, sales=100, alt=None):
    base = f'"","{sym}","{to_date}","{basis}","Unaudited","01-Feb-2025","{sales}","0","{profit}","{eps}","1","1",'
    if alt is None:
        return base + ',,,,,,\n'
    ab, asales, aprofit, aeps = alt
    return base + f'"{ab}","{asales}","0","{aprofit}","{aeps}","1","2"\n'


def growth(tmp_path, *rows):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + ''.join(rows), encoding='utf-8')
    return qr.build_quarterly_growth(str(f))


def pair(tmp_path, then, now):
    """A stock with EPS `then` in Mar-2025 and `now` in Mar-2026 (the latest quarter, so its row is the last of the history, index 9)."""
    return growth(tmp_path, arow('AAA', '31-Mar-2025', 'Consolidated', then), arow('AAA', '31-Mar-2026', 'Consolidated', now))['aaa']


def test_a_loss_that_narrows_is_a_positive_change_not_a_made_up_label(tmp_path):
    r = pair(tmp_path, -32.68, -2.24)
    assert r['hx'] == {9: {'e': 93.15}}                          # (-2.24 - -32.68) / |-32.68|: the loss shrank, so EPS rose
    assert r['h'][9][4] is None                                  # the history's own EPS growth is unchanged (it needs a positive base)


def test_a_loss_that_widens_and_a_loss_that_goes_to_zero(tmp_path):
    assert pair(tmp_path, -5, -10)['hx'] == {9: {'e': -100.0}}   # (-10 - -5) / |-5|: the loss grew, so EPS fell
    assert pair(tmp_path, -5, 0)['hx'] == {9: {'e': 100.0}}


def test_a_loss_that_turns_into_a_profit_is_a_big_positive_change(tmp_path):
    r = pair(tmp_path, -5, 10)
    assert r['hx'] == {9: {'e': 300.0}}                          # (10 - -5) / |-5|; the table shows just the number
    assert r['h'][9][6] == 1                                     # the history still carries its turnaround flag for other users of it


def test_a_zero_base_cannot_be_divided_and_a_positive_base_already_has_its_growth(tmp_path):
    assert pair(tmp_path, 0, 5)['hx'] == {9: {'ez': 1}} and pair(tmp_path, 0, -5)['hx'] == {9: {'ez': -1}}   # no %, but the direction is carried
    assert 'e' not in pair(tmp_path, 0, 5)['hx'][9]
    r = pair(tmp_path, 4, -2)
    assert 'hx' not in r and r['h'][9][4] == -150.0              # profit to loss from a positive base: the existing growth figure


def test_the_index_is_the_quarters_place_in_the_history(tmp_path):
    g = growth(tmp_path,
               arow('AAA', '31-Mar-2025', 'Consolidated', -4), arow('AAA', '30-Jun-2025', 'Consolidated', -4),
               arow('AAA', '31-Mar-2026', 'Consolidated', -2), arow('AAA', '30-Jun-2026', 'Consolidated', 3))['aaa']
    h = g['h']
    assert h[8][0] == '2026-03-31' and h[9][0] == '2026-06-30'
    assert g['hx'] == {8: {'e': 50.0}, 9: {'e': 175.0}}          # Mar-26 against Mar-25 (-2 vs -4); Jun-26 against Jun-25 (3 vs -4): each at its own place


def test_the_filters_figures_are_untouched(tmp_path):
    r = growth(tmp_path, arow('AAA', '31-Mar-2025', 'Consolidated', -32.68, profit=-209), arow('AAA', '31-Mar-2026', 'Consolidated', -2.24, profit=-14))['aaa']
    assert r['hx'] == {9: {'e': 93.15}}                                   # the table gets its number ...
    assert r['eg'] is None and r['et'] is False and r['cmp'] == 'ok'      # ... but the scanner's profit growth stays "no % from a loss", and it is no turnaround


def test_it_uses_the_basis_both_quarters_hold(tmp_path):
    g = growth(tmp_path,
               arow('XX', '31-Mar-2025', 'Standalone', -10, profit=-9),
               arow('XX', '31-Mar-2026', 'Consolidated', 7, profit=50, alt=('Standalone', 100, -3, -5)))['xx']
    assert g['hx'] == {9: {'e': 50.0}}                           # Standalone: -5 now against -10 then, not the consolidated +7


def test_it_travels_in_the_payload_with_string_keys(tmp_path):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + arow('A', '31-Mar-2025', 'Consolidated', -8) + arow('A', '31-Mar-2026', 'Consolidated', -2), encoding='utf-8')
    doc = json.loads(json.dumps(qr.payload(str(f))))
    assert doc['bySymbol']['a']['hx'] == {'9': {'e': 75.0}}


def test_negative_year_ago_sales_get_the_same_percentage_and_a_rise_is_always_plus(tmp_path):
    def sales_pair(then, now):
        return growth(tmp_path, arow('AAA', '31-Mar-2025', 'Consolidated', 1, sales=then), arow('AAA', '31-Mar-2026', 'Consolidated', 1, sales=now))['aaa']
    r = sales_pair(-2.2, 18.2)
    assert r['hx'] == {9: {'s': 927.27}} and r['h'][9][2] is None       # (18.2 - -2.2) / |-2.2|: sales rose; h's own growth still needs a positive base
    assert sales_pair(-2.2, -3.4)['hx'] == {9: {'s': -54.55}}            # a bigger negative figure is a fall
    assert sales_pair(-2.2, -1.0)['hx'] == {9: {'s': 54.55}}             # a smaller one is a rise
    assert sales_pair(0, 5)['hx'] == {9: {'sz': 1}}                       # zero: no %, the direction only
    assert 'hx' not in sales_pair(100, 150)                               # a positive base already has its growth
    assert sales_pair(-2.2, 18.2)['yy'][2] == 927.27                      # the turnaround filters read the same number

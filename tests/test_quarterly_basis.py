"""Standalone-vs-consolidated switches in src/quarterly_results.py. A quarter is compared with the same quarter a year earlier,
which is only meaningful on one basis. When the two stored rows are on different bases, the results file may also hold the OTHER
basis in its ALT_* columns (Download-NSE-Bhavcopy.ps1 reads those only where needed); the server then compares on a basis both
rows hold, preferring consolidated, and says which one (`ab`). Without one, the comparison is refused as before ('basis').
Real case: SGFIN filed standalone only until Sep-2025..Jun-2026, then standalone AND consolidated for Sep-2026."""
import json

import quarterly_results as qr

HEADER = ('ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ,'
          'ALT_BASIS,ALT_REVENUE_CR,ALT_PBT_CR,ALT_NET_PROFIT_CR,ALT_EPS_BASIC,ALT_EPS_DILUTED,ALT_SEQ\n')


def arow(sym, to_date, basis, sales, profit, eps, alt=None):
    """One results row; alt = (basis, sales, profit, eps) fills the ALT_* columns, None leaves them empty (written bare)."""
    base = f'"","{sym}","{to_date}","{basis}","Unaudited","01-Feb-2025","{sales}","0","{profit}","{eps}","1","1",'
    if alt is None:
        return base + ',,,,,,\n'
    ab, asales, aprofit, aeps = alt
    return base + f'"{ab}","{asales}","0","{aprofit}","{aeps}","1","2"\n'


def growth(tmp_path, *rows, header=HEADER):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + header + ''.join(rows), encoding='utf-8')
    return qr.build_quarterly_growth(str(f))


def head(g, sym='sgfin'):
    return {k: v for k, v in g[sym].items() if k not in ('h', 'yy', 'qq')}


# ── the SGFIN case: year-ago standalone only, now consolidated (+ the standalone filing as the alternate) ──────────────────

SGFIN = [
    arow('SGFIN', '30-Sep-2025', 'Standalone', 74.7169, 28.3997, 5.08),
    arow('SGFIN', '30-Sep-2026', 'Consolidated', 160.9381, 58.5307, 8.93, alt=('Standalone', 160.9381, 58.8033, 8.97)),
]


def test_a_quarter_filed_consolidated_after_a_standalone_year_ago_is_compared_on_standalone(tmp_path):
    g = growth(tmp_path, *SGFIN)
    assert head(g) == {
        'q': '2026-09-30', 'b': 'C', 'cmp': 'ok', 'ab': 'S',
        's': 160.9381, 'sp': 74.7169, 'e': 58.8033, 'ep': 28.3997,          # the Standalone numbers on both sides
        'sg': 115.4, 'eg': 107.06, 'st': False, 'et': False}


def test_the_chart_row_keeps_the_stored_sales_and_eps_but_carries_the_comparison_basis(tmp_path):
    h = growth(tmp_path, *SGFIN)['sgfin']['h']
    # [quarter-end, stored sales, sales growth, stored EPS, EPS growth, cmp, turnaround, basis, sales on it, sales a year ago on it]
    assert h[-1] == ['2026-09-30', 160.9, 115.4, 8.93, 76.57, 'ok', 0, 'S', 160.9, 74.7]   # EPS growth: 8.97 vs 5.08 standalone
    assert len(h[-1]) == 10 and all(len(r) == 7 for r in h[:-1])                          # other quarters are unchanged


# ── which basis is used ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_standalone_only_now_after_a_consolidated_year_ago_uses_the_year_ago_standalone_alternate(tmp_path):
    g = growth(tmp_path,
               arow('XX', '30-Sep-2025', 'Consolidated', 200, 20, 2, alt=('Standalone', 100, 10, 1)),
               arow('XX', '30-Sep-2026', 'Standalone', 150, 15, 1.5))
    assert head(g, 'xx') == {'q': '2026-09-30', 'b': 'S', 'cmp': 'ok', 'ab': 'S', 's': 150.0, 'sp': 100.0, 'e': 15.0, 'ep': 10.0,
                             'sg': 50.0, 'eg': 50.0, 'st': False, 'et': False}


def test_consolidated_is_preferred_when_both_quarters_hold_both_bases(tmp_path):
    g = growth(tmp_path,
               arow('XX', '30-Sep-2025', 'Standalone', 100, 10, 1, alt=('Consolidated', 120, 12, 1.2)),
               arow('XX', '30-Sep-2026', 'Consolidated', 180, 18, 1.8, alt=('Standalone', 130, 13, 1.3)))
    r = head(g, 'xx')
    assert (r['ab'], r['s'], r['sp'], r['sg']) == ('C', 180.0, 120.0, 50.0)      # consolidated v consolidated, not 130 v 100


def test_no_basis_held_by_both_quarters_is_still_refused(tmp_path):
    g = growth(tmp_path,
               arow('XX', '30-Sep-2025', 'Standalone', 100, 10, 1),
               arow('XX', '30-Sep-2026', 'Consolidated', 180, 18, 1.8, alt=('Consolidated', 1, 1, 1)))   # the "alternate" repeats the stored basis
    assert g['xx']['cmp'] == 'basis' and 'ab' not in g['xx'] and g['xx']['sg'] is None


def test_an_alternate_with_blank_numbers_is_not_used(tmp_path):
    g = growth(tmp_path,
               arow('XX', '30-Sep-2025', 'Standalone', 100, 10, 1),
               arow('XX', '30-Sep-2026', 'Consolidated', 180, 18, 1.8, alt=('Standalone', '', '', '')))
    assert g['xx']['cmp'] == 'basis' and 'ab' not in g['xx']


# ── nothing changes for the ordinary cases ────────────────────────────────────────────────────────────────────────────────

def test_a_pair_on_the_same_basis_ignores_any_alternate_and_has_no_marker(tmp_path):
    g = growth(tmp_path,
               arow('XX', '30-Sep-2025', 'Consolidated', 100, 10, 1, alt=('Standalone', 1, 1, 1)),
               arow('XX', '30-Sep-2026', 'Consolidated', 130, 15, 1.5, alt=('Standalone', 2, 2, 2)))
    assert head(g, 'xx') == {'q': '2026-09-30', 'b': 'C', 'cmp': 'ok', 's': 130.0, 'sp': 100.0, 'e': 15.0, 'ep': 10.0,
                             'sg': 30.0, 'eg': 50.0, 'st': False, 'et': False}
    assert all(len(r) == 7 for r in g['xx']['h'])


def test_a_file_written_before_the_alternate_columns_existed_still_reads_and_still_refuses_a_basis_switch(tmp_path):
    old_header = 'ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ\n'
    rows = ['"","XX","30-Sep-2025","Standalone","Unaudited","01-Feb-2025","100","0","10","1","1","1"\n',
            '"","XX","30-Sep-2026","Consolidated","Unaudited","01-Feb-2025","180","0","18","1.8","1","1"\n',
            '"","YY","30-Sep-2025","Consolidated","Unaudited","01-Feb-2025","100","0","10","1","1","1"\n',
            '"","YY","30-Sep-2026","Consolidated","Unaudited","01-Feb-2025","150","0","15","1.5","1","1"\n']
    g = growth(tmp_path, *rows, header=old_header)
    assert g['xx']['cmp'] == 'basis'
    assert g['yy']['cmp'] == 'ok' and g['yy']['sg'] == 50.0


def test_turnarounds_are_judged_on_the_comparison_basis(tmp_path):
    # standalone loss a year ago, standalone profit now (the consolidated figure alone could not be compared)
    g = growth(tmp_path,
               arow('XX', '30-Sep-2025', 'Standalone', 100, -5, -0.5),
               arow('XX', '30-Sep-2026', 'Consolidated', 150, 7, 0.7, alt=('Standalone', 140, 9, 0.9)))
    r = g['xx']
    assert (r['cmp'], r['ab'], r['et'], r['eg']) == ('ok', 'S', True, None)       # a turnaround has no percentage
    assert r['e'] == 9.0 and r['ep'] == -5.0
    assert g['xx']['h'][-1][6] == 1                                               # EPS turnaround too (0.9 now, -0.5 then)


def test_the_alternate_basis_marker_is_only_in_the_payload_for_the_stocks_that_need_it(tmp_path):
    f = tmp_path / 'q.csv'
    f.write_text('﻿' + HEADER + ''.join(SGFIN) + arow('PLAIN', '30-Sep-2025', 'Consolidated', 100, 10, 1)
                 + arow('PLAIN', '30-Sep-2026', 'Consolidated', 120, 12, 1.2), encoding='utf-8')
    doc = json.loads(json.dumps(qr.payload(str(f))))
    assert doc['bySymbol']['sgfin']['ab'] == 'S'
    assert 'ab' not in doc['bySymbol']['plain']

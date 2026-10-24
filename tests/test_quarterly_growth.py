"""src/quarterly_results.py (build_quarterly_growth, payload, gzipped_payload) and GET /api/quarterly-growth: each stock's
latest-quarter sales / net-profit growth versus the same quarter a year earlier, behind the Stock Scanner's "Quarterly Results"
filters, plus the last 10 quarters for the single-stock chart's table. The logic lives in its own module and nse_server.py only
routes to it; it is read-only and separate from process_data(), so nothing else in the server is touched."""
import gzip
import json
import os
import threading
import urllib.error
import urllib.request

import nse_server as ns
import quarterly_results as qr

HEADER = 'ISIN,SYMBOL,TO_DATE,BASIS,AUDITED,FILED,REVENUE_CR,PBT_CR,NET_PROFIT_CR,EPS_BASIC,EPS_DILUTED,SEQ\n'


def row(sym, to_date, sales, profit, basis='Consolidated', isin='INE000A01010', eps=1):
    return f'"{isin}","{sym}","{to_date}","{basis}","Unaudited","01-Feb-2025","{sales}","0","{profit}","{eps}","1","1"\n'


def write_results(path, *rows):
    path.write_text('﻿' + HEADER + ''.join(rows), encoding='utf-8')


def growth(tmp_path, *rows):
    f = tmp_path / 'q.csv'
    write_results(f, *rows)
    return qr.build_quarterly_growth(str(f))


def test_growth_is_latest_quarter_against_the_same_quarter_a_year_earlier(tmp_path):
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 100, 10),
               row('AAA', '31-Mar-2024', 999, 999),   # other quarters in between must not be used
               row('AAA', '31-Dec-2024', 130, 15))
    assert {k: v for k, v in g['aaa'].items() if k not in ('h', 'yy', 'qq')} == {
        'q': '2024-12-31', 'b': 'C', 'cmp': 'ok', 's': 130.0, 'sp': 100.0, 'e': 15.0, 'ep': 10.0,
        'sg': 30.0, 'eg': 50.0, 'st': False, 'et': False}


QUARTER_ENDS = ['31-Mar-2023', '30-Jun-2023', '30-Sep-2023', '31-Dec-2023', '31-Mar-2024', '30-Jun-2024', '30-Sep-2024',
                '31-Dec-2024', '31-Mar-2025', '30-Jun-2025', '30-Sep-2025', '31-Dec-2025', '31-Mar-2026', '30-Jun-2026']


def fourteen_quarters(sym, sales, eps, profits=None, **kw):
    """Rows for 14 consecutive quarters Mar-2023..Jun-2026 (oldest first): enough for 10 quarters, each with a year-ago one."""
    profits = profits or [10] * 14
    return [row(sym, d, s, p, eps=e, **kw) for d, s, p, e in zip(QUARTER_ENDS, sales, profits, eps)]


def history(tmp_path, *rows, sym='aaa'):
    return growth(tmp_path, *rows)[sym]['h']


def test_history_is_ten_quarters_newest_last_each_against_its_own_year_ago_quarter(tmp_path):
    sales = [100, 100, 100, 100, 110, 120, 130, 140, 150, 150, 150, 150, 165, 180]
    eps = [10, 10, 10, 10, 11, 9, 20, 5, 12, 18, 10, 10, 6.6, 9]
    g = growth(tmp_path, *fourteen_quarters('AAA', sales, eps))
    h = g['aaa']['h']
    assert len(h) == 10
    assert [x[0] for x in h] == ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31',
                                 '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']
    # [quarter-end, sales, sales growth %, EPS, EPS growth %, cmp, EPS turnaround]
    assert h[0] == ['2024-03-31', 110.0, 10.0, 11.0, 10.0, 'ok', 0]       # Mar-24 vs Mar-23
    assert h[-1] == ['2026-06-30', 180.0, 20.0, 9.0, -50.0, 'ok', 0]      # Jun-26 vs Jun-25 (sales 180 v 150, EPS 9 v 18)
    assert [x[2] for x in h] == [10.0, 20.0, 30.0, 40.0, 36.36, 25.0, 15.38, 7.14, 10.0, 20.0]
    assert (h[-1][2], g['aaa']['sg']) == (20.0, 20.0)   # the newest entry is the comparison the filters use


def test_history_eps_growth_needs_a_positive_year_ago_eps(tmp_path):
    eps = [10, 10, 10, 10, -2, 0, 5, 5, 3, -1, 4, 4, 4, 4]
    h = {x[0]: x for x in history(tmp_path, *fourteen_quarters('AAA', [100] * 14, eps))}
    assert h['2024-03-31'][3:5] == [-2.0, -120.0]                 # a loss now after a profit a year ago: a negative growth
    assert h['2025-03-31'][4] is None                              # year-ago EPS was -2: no % growth
    assert h['2025-06-30'][4] is None                              # year-ago EPS was exactly 0: no % growth


def test_history_marks_an_eps_turnaround(tmp_path):
    eps = [10, 10, -5, -5, 10, 10, 4, 4, 3, 3, 3, 3, 3, 3]
    h = {x[0]: x for x in history(tmp_path, *fourteen_quarters('AAA', [100] * 14, eps))}
    assert h['2024-09-30'][6] == 1 and h['2024-09-30'][4] is None   # 4 now after -5 a year ago
    assert h['2024-12-31'][6] == 1
    assert h['2024-03-31'][6] == 0 and h['2025-09-30'][6] == 0      # ordinary quarters are not


def test_history_reports_a_gap_and_a_basis_switch_but_keeps_what_it_can_show(tmp_path):
    rows = fourteen_quarters('AAA', [100] * 14, [10] * 14)
    rows = [r for r in rows if '30-Jun-2025' not in r]                       # no result on file for Jun-25
    rows[7] = row('AAA', '31-Dec-2024', 100, 10, basis='Standalone', eps=10)  # Dec-24 standalone, Dec-23 consolidated
    h = {x[0]: x for x in growth(tmp_path, *rows)['aaa']['h']}
    assert h['2025-06-30'] == ['2025-06-30', None, None, None, None, 'none', 0]
    assert h['2024-12-31'][1] == 100.0 and h['2024-12-31'][3] == 10.0        # the figures are still shown...
    assert h['2024-12-31'][5] == 'basis' and h['2024-12-31'][2] is None and h['2024-12-31'][4] is None   # ...with no % change
    assert h['2025-12-31'][5] == 'basis'                                     # Dec-25 (consolidated) vs the standalone Dec-24: also not comparable
    assert h['2026-03-31'][5] == 'ok' and h['2024-09-30'][5] == 'ok'         # other quarters are unaffected


def test_history_shows_no_sales_for_a_quarter_filed_at_the_wrong_scale_but_keeps_its_eps(tmp_path):
    sales = [22000] * 14
    sales[3] = 235.7                                                          # Dec-2023, PFC-style
    g = growth(tmp_path, *fourteen_quarters('AAA', sales, [10] * 14))
    h = g['aaa']['h']
    by = {x[0]: x for x in h}
    assert by['2024-03-31'][1] == 22000.0 and by['2024-03-31'][5] == 'ok'
    assert by['2024-12-31'][5] == 'scale' and by['2024-12-31'][2] is None     # its year-ago quarter is the odd one: no sales %
    assert by['2024-12-31'][3] == 10.0 and by['2024-12-31'][4] == 0.0         # EPS is per share: unaffected


def test_history_with_a_short_record_pads_the_missing_quarters(tmp_path):
    h = history(tmp_path, row('AAA', '31-Dec-2024', 130, 15, eps=3))
    assert len(h) == 10 and all(x[5] == 'none' for x in h[:-1])
    assert h[-1] == ['2024-12-31', 130.0, None, 3.0, None, 'no-prev', 0]


def test_each_stock_uses_its_own_latest_declared_quarter(tmp_path):
    g = growth(tmp_path,
               row('AAA', '30-Sep-2023', 100, 10), row('AAA', '30-Sep-2024', 110, 11),
               row('BBB', '31-Dec-2023', 100, 10), row('BBB', '31-Dec-2024', 120, 12))
    assert g['aaa']['q'] == '2024-09-30' and g['aaa']['sg'] == 10.0
    assert g['bbb']['q'] == '2024-12-31' and g['bbb']['sg'] == 20.0


def test_a_decline_is_a_negative_percentage_rounded_to_two_places(tmp_path):
    g = growth(tmp_path, row('AAA', '31-Dec-2023', 300, 30), row('AAA', '31-Dec-2024', 200, 10))
    assert g['aaa']['sg'] == -33.33 and g['aaa']['eg'] == -66.67


def test_no_percentage_from_a_loss_or_zero_base_but_the_figures_are_still_reported(tmp_path):
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 100, -5), row('AAA', '31-Dec-2024', 120, 8),    # loss -> profit (turnaround)
               row('BBB', '31-Dec-2023', 0, 0), row('BBB', '31-Dec-2024', 50, 5))       # nothing a year ago
    assert g['aaa']['cmp'] == 'ok' and g['aaa']['sg'] == 20.0
    assert g['aaa']['eg'] is None and g['aaa']['e'] == 8.0 and g['aaa']['ep'] == -5.0
    assert g['bbb']['sg'] is None and g['bbb']['eg'] is None


def test_a_loss_a_year_ago_then_a_profit_is_an_earnings_turnaround_with_no_percentage(tmp_path):
    g = growth(tmp_path, row('AAA', '31-Dec-2023', 100, -5), row('AAA', '31-Dec-2024', 120, 8))
    assert g['aaa']['et'] is True and g['aaa']['eg'] is None
    assert g['aaa']['st'] is False and g['aaa']['sg'] == 20.0   # sales are an ordinary growth, not a turnaround


def test_only_a_real_loss_to_profit_counts_as_an_earnings_turnaround(tmp_path):
    cases = {   # (year-ago profit, profit now, turnaround?)
        'a': (-5, 8, True),     # loss -> profit
        'b': (0, 8, False),     # zero -> profit: a zero is not a loss (often a filing that left the figure blank)
        'c': (-5, -2, False),   # still losing money
        'd': (-5, 0, False),    # loss -> break-even
        'e': (10, 15, False),   # profit -> profit (that is growth)
        'f': (10, -3, False),   # profit -> loss
    }
    rows = []
    for sym, (prev, cur, _) in cases.items():
        rows += [row(sym.upper(), '31-Dec-2023', 100, prev), row(sym.upper(), '31-Dec-2024', 100, cur)]
    g = growth(tmp_path, *rows)
    for sym, (_, _, expect) in cases.items():
        assert g[sym]['et'] is expect, sym


def test_sales_turnaround_means_no_sales_a_year_ago_and_some_now(tmp_path):
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 0, 1), row('AAA', '31-Dec-2024', 103, 1),     # none -> some
               row('BBB', '31-Dec-2023', 0, 1), row('BBB', '31-Dec-2024', 0, 1),       # still none
               row('CCC', '31-Dec-2023', 50, 1), row('CCC', '31-Dec-2024', 90, 1))     # ordinary growth
    assert g['aaa']['st'] is True and g['aaa']['sg'] is None
    assert g['bbb']['st'] is False and g['ccc']['st'] is False and g['ccc']['sg'] == 80.0


def test_no_turnaround_when_the_two_quarters_cannot_be_compared_like_for_like(tmp_path):
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 100, -5, basis='Standalone'), row('AAA', '31-Dec-2024', 100, 8, basis='Consolidated'),
               row('BBB', '31-Dec-2024', 100, 8),                                                     # no year-ago quarter
               row('CCC', '30-Sep-2023', 22391, 1), row('CCC', '31-Dec-2023', 235.7, -5),             # mis-scaled year-ago quarter
               row('CCC', '31-Mar-2024', 24141, 1), row('CCC', '31-Dec-2024', 26798, 8))
    assert [g[s]['cmp'] for s in ('aaa', 'bbb', 'ccc')] == ['basis', 'no-prev', 'scale']
    assert not any(g[s]['et'] or g[s]['st'] for s in ('aaa', 'bbb', 'ccc'))


def test_no_year_ago_quarter_means_no_comparison(tmp_path):
    g = growth(tmp_path, row('AAA', '31-Dec-2024', 100, 10), row('AAA', '30-Sep-2024', 90, 9))
    assert g['aaa']['cmp'] == 'no-prev' and g['aaa']['sg'] is None and g['aaa']['eg'] is None
    assert g['aaa']['s'] == 100.0   # this quarter's figures are still there


def test_a_change_between_standalone_and_consolidated_is_not_compared(tmp_path):
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 100, 10, basis='Standalone'),
               row('AAA', '31-Dec-2024', 400, 40, basis='Consolidated'))
    assert g['aaa']['cmp'] == 'basis' and g['aaa']['sg'] is None and g['aaa']['b'] == 'C'


def test_a_filing_without_numbers_is_reported_as_blank_not_as_zero(tmp_path):
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 100, 10),
               row('AAA', '31-Dec-2024', '', ''))
    assert g['aaa']['cmp'] == 'blank' and g['aaa']['sg'] is None and g['aaa']['eg'] is None


def test_a_quarter_filed_at_the_wrong_scale_is_not_turned_into_a_huge_growth_figure(tmp_path):
    # PFC's real case: the Dec-2023 filing shows 100x too little between two normal quarters
    g = growth(tmp_path,
               row('AAA', '30-Sep-2023', 22391, 4500), row('AAA', '31-Dec-2023', 235.7, 47.7),
               row('AAA', '31-Mar-2024', 24141, 5600), row('AAA', '31-Dec-2024', 26798, 5828))
    assert g['aaa']['cmp'] == 'scale' and g['aaa']['sg'] is None and g['aaa']['eg'] is None
    assert g['aaa']['s'] == 26798.0 and g['aaa']['sp'] == 235.7   # the figures are still reported


def test_other_power_of_ten_scales_are_caught_too(tmp_path):
    for bad in (22.0, 22000000.0):   # 1/1,000 and x1,000 of its neighbours
        g = growth(tmp_path,
                   row('AAA', '30-Sep-2023', 22000, 1), row('AAA', '31-Dec-2023', bad, 1),
                   row('AAA', '31-Mar-2024', 22000, 1), row('AAA', '31-Dec-2024', 23000, 1))
        assert g['aaa']['cmp'] == 'scale', bad


def test_genuine_swings_are_not_mistaken_for_a_scale_error(tmp_path):
    # a 10x jump and a 20x jump are real growth, not a 100x scale error
    g = growth(tmp_path,
               row('AAA', '30-Sep-2023', 10, 1), row('AAA', '31-Dec-2023', 100, 1), row('AAA', '31-Mar-2024', 1000, 1),
               row('AAA', '31-Dec-2024', 1500, 1))
    assert g['aaa']['cmp'] == 'ok' and g['aaa']['sg'] == 1400.0


def test_a_lumpy_newest_quarter_with_one_neighbour_is_not_flagged(tmp_path):
    # an investment firm's income can fall from 107 to 1 crore: with only one neighbour (the newest quarter) that must NOT
    # be flagged (SUMMITSEC on the real file) - the guard needs a normal quarter on both sides
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 18, 1), row('AAA', '31-Mar-2024', 20, 1), row('AAA', '30-Jun-2024', 21, 1),
               row('AAA', '30-Sep-2024', 106.7, 1), row('AAA', '31-Dec-2024', 1.0, 1))
    assert g['aaa']['cmp'] == 'ok' and g['aaa']['sg'] == -94.44


def test_stocks_are_keyed_by_symbol_so_an_isin_change_does_not_break_the_comparison(tmp_path):
    # a split/bonus gives the stock a new ISIN: the year-ago result carries the OLD one, the latest the new one
    g = growth(tmp_path,
               row('AAA', '31-Dec-2023', 100, 10, isin='INE000A01010'),
               row('AAA', '31-Dec-2024', 150, 20, isin='INE000A01028'))
    assert g['aaa']['cmp'] == 'ok' and g['aaa']['sg'] == 50.0 and g['aaa']['eg'] == 100.0


def test_symbols_are_keyed_like_the_browsers_normalizeSymbol(tmp_path):
    g = growth(tmp_path, row('M&M', '31-Dec-2024', 1, 1), row('BAJAJ-AUTO', '31-Dec-2024', 1, 1))
    assert set(g) == {'m_m', 'bajaj_auto'}


def test_missing_file_gives_an_empty_result(tmp_path):
    assert qr.build_quarterly_growth(str(tmp_path / 'nope.csv')) == {}


def test_rows_with_a_bad_date_or_no_symbol_are_skipped(tmp_path):
    g = growth(tmp_path, row('AAA', 'not-a-date', 1, 1), row('', '31-Dec-2024', 1, 1), row('BBB', '31-Dec-2024', 1, 1))
    assert set(g) == {'bbb'}


def _serve(base_dir):
    srv = ns.ThreadingNSEServer(('127.0.0.1', 0), ns.NSEHandler)
    srv.base_dir = str(base_dir)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _get(srv, path):
    req = urllib.request.Request(f'http://127.0.0.1:{srv.server_address[1]}{path}', headers={'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read()
        return r.status, (gzip.decompress(body) if r.headers.get('Content-Encoding') == 'gzip' else body)


def test_endpoint_serves_growth_and_refreshes_when_the_file_changes(tmp_path):
    (tmp_path / ns.REFERENCE_SUBDIR).mkdir()
    f = tmp_path / ns.REFERENCE_SUBDIR / qr.RESULTS_FILE
    write_results(f, row('AAA', '31-Dec-2023', 100, 10), row('AAA', '31-Dec-2024', 110, 11))
    qr.clear_cache()
    srv = _serve(tmp_path)
    try:
        status, body = _get(srv, '/api/quarterly-growth')
        data = json.loads(body)
        assert status == 200 and data['latestQuarter'] == '2024-12-31'
        assert data['bySymbol']['aaa']['sg'] == 10.0
        # fetching newer results rewrites the file: served fresh, no restart and no reprocess
        write_results(f, row('AAA', '31-Dec-2023', 100, 10), row('AAA', '31-Dec-2024', 150, 11))
        os.utime(f, (os.path.getmtime(f) + 10, os.path.getmtime(f) + 10))
        assert json.loads(_get(srv, '/api/quarterly-growth')[1])['bySymbol']['aaa']['sg'] == 50.0
    finally:
        srv.shutdown()
        srv.server_close()


def test_endpoint_is_404_without_a_results_file(tmp_path):
    srv = _serve(tmp_path)
    try:
        try:
            _get(srv, '/api/quarterly-growth')
            assert False, 'expected 404'
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        srv.shutdown()
        srv.server_close()


# ── the module's own contract ───────────────────────────────────────────────────────────────────────────────────────

def test_the_modules_helpers_match_nse_servers_so_symbols_and_dates_read_the_same(tmp_path):
    # quarterly_results.py has its own copies (it cannot import nse_server, which imports it); the browser keys by
    # normalizeSymbol, so any drift would silently break the join
    for s in ['M&M', 'BAJAJ-AUTO', '  Reliance ', '', None, '20MICRONS', 'A&B-C']:
        assert qr.normalize_symbol(s) == ns.normalize_symbol(s), s
    for s in ['31-Dec-2024', ' 31-Dec-2024 ', '2024-12-31', '31/12/2024', '31Dec2024', 'not-a-date', '', None]:
        assert qr.parse_date_str(s) == ns.parse_date_str(s), s


def test_payload_wraps_the_growth_and_names_the_newest_quarter(tmp_path):
    f = tmp_path / 'q.csv'
    write_results(f, row('AAA', '31-Dec-2023', 100, 10), row('AAA', '31-Dec-2024', 130, 15), row('BBB', '30-Sep-2024', 5, 1))
    p = qr.payload(str(f))
    assert set(p) == {'bySymbol', 'latestQuarter'} and set(p['bySymbol']) == {'aaa', 'bbb'}
    assert p['latestQuarter'] == '2024-12-31'
    write_results(f)   # header only
    assert qr.payload(str(f)) == {'bySymbol': {}, 'latestQuarter': None}


def test_gzipped_payload_is_cached_until_the_file_changes_and_404s_without_one(tmp_path):
    f = tmp_path / 'q.csv'
    write_results(f, row('AAA', '31-Dec-2023', 100, 10), row('AAA', '31-Dec-2024', 110, 11))
    qr.clear_cache()
    first = qr.gzipped_payload(str(f))
    assert json.loads(gzip.decompress(first))['bySymbol']['aaa']['sg'] == 10.0
    assert qr.gzipped_payload(str(f)) is first                       # same file, same mtime: served from the cache
    write_results(f, row('AAA', '31-Dec-2023', 100, 10), row('AAA', '31-Dec-2024', 150, 11))
    os.utime(f, (os.path.getmtime(f) + 10, os.path.getmtime(f) + 10))
    assert json.loads(gzip.decompress(qr.gzipped_payload(str(f))))['bySymbol']['aaa']['sg'] == 50.0   # mtime moved: rebuilt
    try:
        qr.gzipped_payload(str(tmp_path / 'nope.csv'))
        assert False, 'expected FileNotFoundError'
    except FileNotFoundError:
        pass


def test_the_endpoint_serves_exactly_the_modules_payload(tmp_path):
    (tmp_path / ns.REFERENCE_SUBDIR).mkdir()
    f = tmp_path / ns.REFERENCE_SUBDIR / qr.RESULTS_FILE
    write_results(f, row('AAA', '31-Dec-2023', 100, 10), row('AAA', '31-Dec-2024', 110, 11))
    qr.clear_cache()
    srv = _serve(tmp_path)
    try:
        status, body = _get(srv, '/api/quarterly-growth')
        assert status == 200 and json.loads(body) == qr.payload(str(f))
    finally:
        srv.shutdown()
        srv.server_close()


def test_nse_server_only_routes_the_quarterly_logic_lives_in_its_own_module():
    src = open(ns.__file__, encoding='utf-8').read()
    assert 'import quarterly_results' in src
    for name in ('def build_quarterly_growth', 'def _compare_quarter', 'def _looks_mis_scaled', 'def _growth_pct', '_quarterly_growth_cache'):
        assert name not in src, f'{name} belongs in src/quarterly_results.py'

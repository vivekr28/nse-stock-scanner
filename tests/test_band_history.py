"""build_band_history() and GET /api/band-history: the per-symbol price-band history behind the Stock Scanner's
"As of Date" tab (Exclude Circuits uses the band in force ON the chosen date). Read-only and separate from
process_data(), so these also pin that process_data()'s own band handling is not affected."""
import gzip
import json
import threading
import urllib.error
import urllib.request

import nse_server as ns

HEADER = 'Symbol,Series,Security Name,Band,Remarks,Date\n'


def write_band(path, rows, header=HEADER):
    path.write_text('﻿' + header + ''.join(f'{s},{ser},NAME,{b},-,{d}\n' for s, ser, b, d in rows), encoding='utf-8')


def test_only_the_days_the_band_changed_are_kept_oldest_first(tmp_path):
    f = tmp_path / 'b.csv'
    write_band(f, [
        ('AAA', 'EQ', '5', '02-Sep-2024'), ('AAA', 'EQ', '5', '03-Sep-2024'), ('AAA', 'EQ', '10', '04-Sep-2024'),
        ('AAA', 'EQ', '10', '05-Sep-2024'), ('AAA', 'EQ', '5', '06-Sep-2024'),
    ])
    assert ns.build_band_history(str(f)) == {'aaa': [['2024-09-02', '5'], ['2024-09-04', '10'], ['2024-09-06', '5']]}


def test_rows_out_of_order_in_the_file_are_sorted_by_date(tmp_path):
    f = tmp_path / 'b.csv'
    write_band(f, [('AAA', 'EQ', '10', '04-Sep-2024'), ('AAA', 'EQ', '5', '02-Sep-2024')])
    assert ns.build_band_history(str(f))['aaa'] == [['2024-09-02', '5'], ['2024-09-04', '10']]


def test_no_band_and_20_percent_text_are_kept_as_is(tmp_path):
    f = tmp_path / 'b.csv'
    write_band(f, [('AAA', 'EQ', 'No Band', '02-Sep-2024'), ('AAA', 'EQ', '20', '03-Sep-2024')])
    assert ns.build_band_history(str(f))['aaa'] == [['2024-09-02', 'No Band'], ['2024-09-03', '20']]


def test_symbols_are_keyed_like_the_browsers_normalizeSymbol(tmp_path):
    f = tmp_path / 'b.csv'
    write_band(f, [('M&M', 'EQ', '20', '02-Sep-2024'), ('BAJAJ-AUTO', 'EQ', '20', '02-Sep-2024')])
    assert set(ns.build_band_history(str(f))) == {'m_m', 'bajaj_auto'}


def test_a_symbol_on_two_series_the_same_day_takes_the_later_row(tmp_path):
    f = tmp_path / 'b.csv'
    write_band(f, [('AAA', 'BE', '5', '02-Sep-2024'), ('AAA', 'EQ', '10', '02-Sep-2024')])
    assert ns.build_band_history(str(f))['aaa'] == [['2024-09-02', '10']]


def test_missing_file_or_wrong_header_gives_an_empty_result(tmp_path):
    assert ns.build_band_history(str(tmp_path / 'nope.csv')) == {}
    f = tmp_path / 'b.csv'
    f.write_text('Foo,Bar\n1,2\n')
    assert ns.build_band_history(str(f)) == {}


def test_rows_with_a_bad_date_or_short_rows_are_skipped(tmp_path):
    f = tmp_path / 'b.csv'
    f.write_text(HEADER + 'AAA,EQ,NAME,5,-,not-a-date\nshort,row\nBBB,EQ,NAME,2,-,02-Sep-2024\n')
    assert ns.build_band_history(str(f)) == {'bbb': [['2024-09-02', '2']]}


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


def test_endpoint_serves_the_history_and_refreshes_when_the_file_changes(tmp_path):
    (tmp_path / ns.DATA_SUBDIR).mkdir()
    band = tmp_path / ns.DATA_SUBDIR / ns.BAND_FILE
    write_band(band, [('AAA', 'EQ', '5', '02-Sep-2024')])
    ns._band_history_cache.clear()
    srv = _serve(tmp_path)
    try:
        status, body = _get(srv, '/api/band-history')
        assert status == 200
        assert json.loads(body) == {'bySymbol': {'aaa': [['2024-09-02', '5']]}}
        # file changes (new mtime) -> served fresh, not from the cache
        write_band(band, [('AAA', 'EQ', '5', '02-Sep-2024'), ('AAA', 'EQ', '2', '03-Sep-2024')])
        import os
        os.utime(band, (os.path.getmtime(band) + 10, os.path.getmtime(band) + 10))
        assert json.loads(_get(srv, '/api/band-history')[1])['bySymbol']['aaa'][-1] == ['2024-09-03', '2']
    finally:
        srv.shutdown()
        srv.server_close()


def test_endpoint_is_404_without_a_band_file(tmp_path):
    (tmp_path / ns.DATA_SUBDIR).mkdir()
    srv = _serve(tmp_path)
    try:
        try:
            _get(srv, '/api/band-history')
            assert False, 'expected 404'
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        srv.shutdown()
        srv.server_close()

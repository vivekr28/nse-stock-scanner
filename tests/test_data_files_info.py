"""get_data_files_info(): what the dashboard's Data Files popup shows, here the NSE index closing values
(raw per-day IndexClose/ind_close_all_YYYYMMDD.csv files plus the merged NSE_Indices_Combined.csv)."""
import os

import nse_server as ns


def make_base(tmp_path):
    data = tmp_path / ns.DATA_SUBDIR
    (data / ns.INDEX_RAW_SUBDIR).mkdir(parents=True)
    return tmp_path, data


COMBINED_HEADER = '"INDEX_NAME","DATE1","OPEN","HIGH","LOW","CLOSE","CHANGE_PCT","VOLUME","TURNOVER_CR","PE","PB","DIV_YIELD"\n'


def combined_row(name, date, close='100'):
    return f'"{name}","{date}","{close}","{close}","{close}","{close}","0.5","","","","",""\n'


def test_index_raw_files_are_summarised_by_trade_date(tmp_path):
    base, data = make_base(tmp_path)
    for d in ('20241003', '20260930', '20251001'):
        (data / ns.INDEX_RAW_SUBDIR / f'ind_close_all_{d}.csv').write_text('x')
    (data / ns.INDEX_RAW_SUBDIR / 'notes.txt').write_text('ignored')

    info = ns.get_data_files_info(str(base))['indexClose']
    assert info['count'] == 3
    assert info['earliest'] == '03-Oct-2024'
    assert info['latest'] == '30-Sep-2026'
    assert info['latestFileTime'] is not None


def test_combined_index_file_summary(tmp_path):
    base, data = make_base(tmp_path)
    (data / ns.INDICES_FILE).write_text('﻿' + COMBINED_HEADER
        + combined_row('Nifty 50', '03-Oct-2024') + combined_row('Nifty 50', '01-Oct-2026')
        + combined_row('Nifty Bank', '10-Mar-2025'), encoding='utf-8')

    info = ns.get_data_files_info(str(base))
    assert info['indices'] == {'indexes': 2, 'rows': 3, 'latest': '01-Oct-2026', 'earliest': '03-Oct-2024'}
    row = next(f for f in info['files'] if f['file'] == ns.INDICES_FILE)
    assert row['exists'] is True and row['size'] > 0


def test_missing_index_data_is_reported_not_an_error(tmp_path):
    info = ns.get_data_files_info(str(tmp_path))
    assert info['indexClose']['count'] == 0 and info['indexClose']['latest'] is None
    assert info['indices'] == {'indexes': 0, 'rows': 0, 'latest': None, 'earliest': None}
    row = next(f for f in info['files'] if f['file'] == ns.INDICES_FILE)
    assert row['exists'] is False


def test_unparseable_dates_in_the_index_file_are_skipped(tmp_path):
    base, data = make_base(tmp_path)
    (data / ns.INDICES_FILE).write_text(COMBINED_HEADER
        + combined_row('Nifty 50', 'not-a-date') + combined_row('Nifty 50', '02-Oct-2025'), encoding='utf-8')
    info = ns.get_data_files_info(str(base))['indices']
    assert info['rows'] == 2 and info['latest'] == '02-Oct-2025'

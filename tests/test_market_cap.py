"""load_market_caps(): NSE's daily mcap*.csv -> {normalized symbol: market cap in Rs crore}."""
import os

import nse_server as ns

HEADER = ('Trade Date,Symbol,Series,Security Name,Category,Last Trade Date,Face Value(Rs.),Issue Size,'
          'Close Price/Paid up value(Rs.),Market Cap(Rs.)              \n')


def _row(symbol, series, cap):
    return f'30 SEP 2026,{symbol},{series},{symbol} LTD    ,Listed    ,30 SEP 2026,   10.00,  1000, 100.00,  {cap}  \n'


def _write(tmp_path, *rows):
    path = tmp_path / 'NSE_MarketCap.csv'
    path.write_text(HEADER + ''.join(rows), encoding='latin-1')
    return str(path)


def test_converts_rupees_to_crore(tmp_path):
    path = _write(tmp_path, _row('RELIANCE', 'EQ', '16000000000000.00'))
    assert ns.load_market_caps(path) == {ns.normalize_symbol('RELIANCE'): 1600000.0}


def test_prefers_eq_series_over_others(tmp_path):
    path = _write(tmp_path, _row('DUAL', 'BE', '20000000000.00'), _row('DUAL', 'EQ', '10000000000.00'),
                  _row('DUAL', 'SM', '30000000000.00'))
    assert ns.load_market_caps(path)[ns.normalize_symbol('DUAL')] == 1000.0


def test_skips_rows_without_a_usable_cap(tmp_path):
    path = _write(tmp_path, _row('ZERO', 'EQ', '0.00'), _row('BLANK', 'EQ', ''), _row('GOOD', 'EQ', '10000000.00'))
    assert list(ns.load_market_caps(path)) == [ns.normalize_symbol('GOOD')]


def test_missing_file_returns_empty(tmp_path):
    assert ns.load_market_caps(str(tmp_path / 'nope.csv')) == {}


# --- process_data() integration: NSE file > mapping column > 0 ---------------

def _process(project, mapping_rows, mcap_rows=None):
    """3 flat-priced symbols through the real process_data(), with the given sector mapping / NSE mcap file."""
    from datetime import date
    from conftest import business_days, bhav_row
    days = business_days(date(2025, 9, 1), 15)
    bhav = []
    for d in days:
        for sym, isin in (('AAA', 'INE000A01011'), ('BBB', 'INE000B01011'), ('CCC', 'INE000C01011')):
            bhav.append(bhav_row(sym, 'EQ', d, 100, isin, prev=100))
    project.write_bhavcopy(bhav)
    data_dir = os.path.join(project.base_dir, 'NSE_DATA')
    with open(os.path.join(data_dir, 'Sector-Stock-Mapping.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write('Stock Name,Basic Industry,Sector,Market Cap\n' + ''.join(mapping_rows))
    if mcap_rows is not None:
        with open(os.path.join(data_dir, ns.MARKETCAP_FILE), 'w', encoding='latin-1', newline='') as f:
            f.write(HEADER + ''.join(mcap_rows))
    result = ns.process_data(project.base_dir)
    return {s['symbol']: s for s in result['latestBySymbol'].values()}


def test_nse_market_cap_overrides_mapping_and_covers_unmapped_stocks(project):
    stocks = _process(
        project,
        mapping_rows=['AAA,Dyes And Pigments,Chemicals,111\n', 'BBB,Housing Finance,Financial Services,222\n'],
        mcap_rows=[_row('AAA', 'EQ', '5000000000.00'), _row('CCC', 'EQ', '20000000000.00')])
    assert stocks['AAA']['marketCap'] == 500.0      # NSE file wins over the mapping's 111
    assert stocks['BBB']['marketCap'] == 222        # not in the NSE file -> mapping value is the fallback
    assert stocks['CCC']['marketCap'] == 2000.0     # not in the mapping at all, but NSE has it


def test_market_cap_falls_back_when_the_nse_file_is_absent(project):
    stocks = _process(project, mapping_rows=['AAA,Dyes And Pigments,Chemicals,111\n'])
    assert stocks['AAA']['marketCap'] == 111
    assert stocks['CCC']['marketCap'] == 0


def test_sector_and_industry_come_from_the_mapping_and_default_to_undefined(project):
    stocks = _process(project, mapping_rows=['AAA,Dyes And Pigments,Chemicals,1\n', 'BBB,,,1\n'])
    assert (stocks['AAA']['sector'], stocks['AAA']['industry']) == ('Chemicals', 'Dyes And Pigments')
    assert (stocks['BBB']['sector'], stocks['BBB']['industry']) == ('Undefined-Diversified', 'Undefined-Diversified')
    assert (stocks['CCC']['sector'], stocks['CCC']['industry']) == ('Undefined-Diversified', 'Undefined-Diversified')

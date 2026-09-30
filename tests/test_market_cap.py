"""load_market_caps(): NSE's daily mcap*.csv -> {normalized symbol: market cap in Rs crore}."""
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

"""ETFs / mutual-fund units (ISIN starting INF) are not stocks: process_data() leaves them out of the stock data and
lists them in `excludedEtfs` for the Data Quality tab."""
from datetime import date

import pytest

import nse_server as ns
from conftest import business_days, bhav_row, price_band_row

DAYS = business_days(date(2025, 9, 1), 15)
STOCK = 'INE1STK01011'
ETF = 'INF1ETF01011'
ETF2 = 'INF2ETF01011'


def test_is_fund_isin():
    assert ns.is_fund_isin('INF204K01XI3')
    assert ns.is_fund_isin('inf204k01xi3')          # case-insensitive
    assert not ns.is_fund_isin('INE002A01018')      # a company share
    assert not ns.is_fund_isin('')
    assert not ns.is_fund_isin(None)


@pytest.fixture
def data(project):
    rows = []
    for i, d in enumerate(DAYS):
        rows.append(bhav_row('STOCKCO', 'EQ', d, 100 + i, STOCK, company='Stock Co Ltd'))
        rows.append(bhav_row('GOLDETF', 'EQ', d, 50 + i, ETF, company='Some Gold ETF'))
    # a second fund that also trades on a day AFTER the last stock trade
    rows.append(bhav_row('NIFTYETF', 'EQ', DAYS[-1], 200, ETF2, company='Some Nifty ETF'))
    extra_day = business_days(date(2025, 9, 22), 1)[0]
    rows.append(bhav_row('NIFTYETF', 'EQ', extra_day, 210, ETF2, company='Some Nifty ETF'))
    project.write_bhavcopy(rows)
    project.write_price_band([price_band_row('STOCKCO', 'EQ', '20'), price_band_row('GOLDETF', 'EQ', '20')])
    result = ns.process_data(project.base_dir)
    assert result is not None
    return result


def test_etfs_are_not_in_the_stock_data(data):
    assert list(data['latestBySymbol']) == [STOCK]
    assert list(data['dailyBySymbol']) == [STOCK]
    assert set(data['symbolToISIN'].values()) == {STOCK}
    assert 'goldetf' not in data['symbolToISIN']


def test_excluded_etfs_are_listed_with_their_newest_row(data):
    etfs = {e['symbol']: e for e in data['excludedEtfs']}
    assert list(etfs) == ['GOLDETF', 'NIFTYETF']                    # sorted by symbol
    gold = etfs['GOLDETF']
    assert gold['isin'] == ETF and gold['name'] == 'Some Gold ETF' and gold['series'] == 'EQ'
    assert gold['close'] == 50 + 14                                 # the last of its 15 rows
    assert gold['lastTradeDate'] == DAYS[-1].strftime('%d-%b-%Y')
    assert gold['turnover'] == 10
    assert 'ts' not in gold                                         # internal sort key is not leaked into the JSON


def test_a_fund_trading_later_than_every_stock_does_not_move_the_latest_date(data):
    assert data['latestDate'] == DAYS[-1].strftime('%d-%b-%Y')
    assert data['staleStocks'] == []                                # the stock is not "stale" because of the fund
    nifty = next(e for e in data['excludedEtfs'] if e['symbol'] == 'NIFTYETF')
    assert nifty['close'] == 210                                    # newest row wins, even though it is after latestDate


def test_price_band_rows_for_etfs_are_ignored(data):
    assert list(data['bandBySymbol']) == [STOCK]
    assert data['latestBySymbol'][STOCK]['bandPct'] == '20%'


def test_schema_version_forces_old_caches_to_regenerate():
    assert ns.PROCESSED_SCHEMA >= 3                                 # caches written before excludedEtfs existed


def test_no_etfs_gives_an_empty_list(project):
    project.write_bhavcopy([bhav_row('STOCKCO', 'EQ', d, 100, STOCK) for d in DAYS])
    result = ns.process_data(project.base_dir)
    assert result['excludedEtfs'] == []

"""ETFs, REITs and InvITs are not stocks: none of them may reach the stock data, and each is listed for the Data Quality
tab (`excludedEtfs` for funds with an INF ISIN, `excludedTrusts` for REIT/InvIT units, series RR / IV)."""
import os
from datetime import date
from pathlib import Path

import pytest

import nse_server as ns
from conftest import REPO_ROOT, business_days, bhav_row, price_band_row

MCAP_HEADER = ('Trade Date,Symbol,Series,Security Name,Category,Last Trade Date,Face Value(Rs.),Issue Size,'
               'Close Price/Paid up value(Rs.),Market Cap(Rs.)              \n')


def mcap_row(symbol, series, name, close, cap, trade_date='30 SEP 2026'):
    return f'{trade_date},{symbol},{series},{name}    ,Listed    ,{trade_date},   10.00,  1000, {close}, {cap}  \n'


def write_mcap(path, *rows):
    path.write_text(MCAP_HEADER + ''.join(rows), encoding='latin-1')
    return str(path)


DAYS = business_days(date(2025, 9, 1), 15)
STOCK, ETF = 'INE1STK01011', 'INF1ETF01011'
REIT_ISIN, INVIT_ISIN = 'INE0RT025011', 'INE0IV023019'


# --- load_trust_units --------------------------------------------------------

def test_load_trust_units_returns_only_reit_and_invit_series(tmp_path):
    path = write_mcap(
        tmp_path / 'm.csv',
        mcap_row('EMBASSY', 'RR', 'EMBASSY OFFICE PARKS REIT', '434.40', '411783999834.05'),
        mcap_row('INDIGRID', 'IV', 'INDIGRID INFRASTRUCT TRST', '171.00', '162869515654.60'),
        mcap_row('RELIANCE', 'EQ', 'RELIANCE INDUSTRIES', '1390.00', '16000000000000.00'),
        mcap_row('SMECO', 'SM', 'SOME SME CO', '50.00', '500000000.00'))
    units = ns.load_trust_units(path)
    assert [(u['symbol'], u['type'], u['series']) for u in units] == [('EMBASSY', 'REIT', 'RR'), ('INDIGRID', 'InvIT', 'IV')]
    embassy = units[0]
    assert embassy['name'] == 'EMBASSY OFFICE PARKS REIT'
    assert embassy['close'] == 434.40
    assert embassy['marketCap'] == 41178.4                  # rupees -> crore
    assert embassy['tradeDate'] == '30 SEP 2026'


def test_load_trust_units_lists_reits_first_then_invits_each_by_symbol(tmp_path):
    path = write_mcap(tmp_path / 'm.csv',
                      mcap_row('ZINVIT', 'IV', 'Z', '1', '10000000'), mcap_row('BREIT', 'RR', 'B', '1', '10000000'),
                      mcap_row('AINVIT', 'IV', 'A', '1', '10000000'), mcap_row('AREIT', 'RR', 'A', '1', '10000000'))
    assert [u['symbol'] for u in ns.load_trust_units(path)] == ['AREIT', 'BREIT', 'AINVIT', 'ZINVIT']


def test_load_trust_units_blank_market_cap_becomes_none(tmp_path):
    path = write_mcap(tmp_path / 'm.csv', mcap_row('NEWREIT', 'RR', 'New REIT', '100.00', ''))
    assert ns.load_trust_units(path)[0]['marketCap'] is None


def test_load_trust_units_missing_file_is_empty(tmp_path):
    assert ns.load_trust_units(str(tmp_path / 'nope.csv')) == []


# --- all three exclusions together, through the real process_data() ----------

@pytest.fixture
def data(project):
    rows = []
    for i, d in enumerate(DAYS):
        rows.append(bhav_row('STOCKCO', 'EQ', d, 100 + i, STOCK, company='Stock Co Ltd'))
        rows.append(bhav_row('GOLDETF', 'EQ', d, 50 + i, ETF, company='Some Gold ETF'))
        # Not expected in the real combined file (the downloader keeps EQ/BE only), but if RR / IV rows ever get there
        # the series filter must still keep them out.
        rows.append(bhav_row('EMBASSY', 'RR', d, 400, REIT_ISIN, company='EMBASSY OFFICE PARKS REIT'))
        rows.append(bhav_row('INDIGRID', 'IV', d, 170, INVIT_ISIN, company='INDIGRID INFRASTRUCT TRST'))
    project.write_bhavcopy(rows)
    project.write_price_band([price_band_row(s, 'EQ', '20') for s in ('STOCKCO', 'GOLDETF', 'EMBASSY', 'INDIGRID')])
    write_mcap(Path(project.base_dir) / 'NSE_DATA' / ns.MARKETCAP_FILE,
        mcap_row('STOCKCO', 'EQ', 'STOCK CO LTD', '114.00', '5000000000.00'),
        mcap_row('EMBASSY', 'RR', 'EMBASSY OFFICE PARKS REIT', '434.40', '411783999834.05'),
        mcap_row('INDIGRID', 'IV', 'INDIGRID INFRASTRUCT TRST', '171.00', '162869515654.60'))
    result = ns.process_data(project.base_dir)
    assert result is not None
    return result


def test_only_the_real_stock_reaches_the_stock_data(data):
    assert list(data['latestBySymbol']) == [STOCK]
    assert list(data['dailyBySymbol']) == [STOCK]
    assert set(data['symbolToISIN'].values()) == {STOCK}
    assert list(data['bandBySymbol']) == [STOCK]                    # no band rows kept for the excluded ones


def test_etfs_are_listed_for_the_data_quality_tab(data):
    assert [e['symbol'] for e in data['excludedEtfs']] == ['GOLDETF']
    assert data['excludedEtfs'][0]['isin'] == ETF


def test_reits_and_invits_are_listed_for_the_data_quality_tab(data):
    assert [(u['symbol'], u['type']) for u in data['excludedTrusts']] == [('EMBASSY', 'REIT'), ('INDIGRID', 'InvIT')]
    embassy = next(u for u in data['excludedTrusts'] if u['symbol'] == 'EMBASSY')
    assert embassy['marketCap'] == 41178.4


def test_the_three_groups_never_overlap(data):
    stocks = {s['symbol'] for s in data['latestBySymbol'].values()}
    etfs = {e['symbol'] for e in data['excludedEtfs']}
    trusts = {u['symbol'] for u in data['excludedTrusts']}
    assert stocks and etfs and trusts
    assert not (stocks & etfs) and not (stocks & trusts) and not (etfs & trusts)


def test_no_market_cap_file_means_no_trust_list_but_still_works(project):
    project.write_bhavcopy([bhav_row('STOCKCO', 'EQ', d, 100, STOCK) for d in DAYS])
    result = ns.process_data(project.base_dir)
    assert result['excludedTrusts'] == []
    assert list(result['latestBySymbol']) == [STOCK]


def test_schema_version_forces_old_caches_to_regenerate():
    assert ns.PROCESSED_SCHEMA >= 4                                 # caches written before excludedTrusts existed


# --- the same validation against the real data on this machine (opt-in: pytest -m slow) ---

@pytest.mark.slow
def test_real_data_has_no_etfs_reits_or_invits_among_the_stocks():
    if not os.path.exists(os.path.join(REPO_ROOT, 'NSE_DATA', 'NSE_Bhavcopy_Combined.csv')):
        pytest.skip('No real NSE_DATA - run Download-NSE-Bhavcopy.ps1 first')
    result = ns.process_data(REPO_ROOT)
    stocks = result['latestBySymbol'].values()
    assert not [s['symbol'] for s in stocks if s['isin'].upper().startswith('INF')], 'an ETF/fund got into the stocks'
    assert not [s['symbol'] for s in stocks if s['series'] not in ('EQ', 'BE')], 'a non-EQ/BE series got into the stocks'
    trust_symbols = {u['symbol'] for u in result['excludedTrusts']}
    assert not trust_symbols & {s['symbol'] for s in stocks}, 'a REIT/InvIT got into the stocks'
    # NSE lists dozens of ETFs and (as of 2026) 6 REITs / 20+ InvITs; the lists must actually be populated
    assert len(result['excludedEtfs']) > 100
    if os.path.exists(os.path.join(REPO_ROOT, 'NSE_DATA', ns.MARKETCAP_FILE)):
        assert {u['type'] for u in result['excludedTrusts']} == {'REIT', 'InvIT'}

"""The scanner's Listed Date filter needs each stock's listing date: Sector-Stock-Mapping.csv's `Listing Date`
('06-OCT-2008') reaches the dashboard data as an ISO `listingDate`, on the sector map and on every stock."""
import os
from datetime import date

import pytest

import nse_server as ns
from conftest import business_days, bhav_row


@pytest.mark.parametrize('raw, iso', [
    ('06-OCT-2008', '2008-10-06'),
    ('1-Jan-1995', '1995-01-01'),
    (' 31-dec-2025 ', '2025-12-31'),
    ('2026-09-01', '2026-09-01'),
    ('', ''), (None, ''), ('-', ''), ('31-XXX-2025', ''), ('06/10/2008', ''),
])
def test_parse_listing_date(raw, iso):
    assert ns.parse_listing_date(raw) == iso


def test_listing_date_reaches_the_sector_map_and_every_stock(project):
    days = business_days(date(2025, 9, 1), 15)
    project.write_bhavcopy([bhav_row(sym, 'EQ', d, 100, isin, prev=100)
                            for d in days for sym, isin in (('AAA', 'INE000A01011'), ('BBB', 'INE000B01011'), ('CCC', 'INE000C01011'))])
    with open(os.path.join(project.base_dir, 'NSE_DATA', 'Sector-Stock-Mapping.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write('Stock Name,Listing Date,Basic Industry,Sector\nAAA,06-OCT-2008,Dyes,Chemicals\nBBB,,Housing Finance,Financial Services\n')
    result = ns.process_data(project.base_dir)
    stocks = {s['symbol']: s for s in result['latestBySymbol'].values()}
    assert stocks['AAA']['listingDate'] == '2008-10-06'
    assert stocks['BBB']['listingDate'] == ''        # blank in the mapping
    assert stocks['CCC']['listingDate'] == ''        # not in the mapping at all
    assert result['sectorMap']['aaa']['listingDate'] == '2008-10-06'


def test_caches_written_before_listing_date_existed_are_reprocessed():
    assert ns.PROCESSED_SCHEMA >= 6


def test_equity_list_covers_stocks_the_mapping_lacks_and_wins_over_it(project):
    days = business_days(date(2025, 9, 1), 15)
    project.write_bhavcopy([bhav_row(sym, 'EQ', d, 100, isin, prev=100)
                            for d in days for sym, isin in (('AAA', 'INE000A01011'), ('NEWCO', 'INE000N01011'))])
    data_dir = os.path.join(project.base_dir, 'NSE_DATA')
    with open(os.path.join(data_dir, 'Sector-Stock-Mapping.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write('Stock Name,Listing Date,Basic Industry,Sector\n'
                'AAA,01-JAN-2000,Dyes,Chemicals\n')               # NEWCO is not in the mapping yet
    with open(os.path.join(data_dir, ns.EQUITY_LIST_FILE), 'w', encoding='utf-8', newline='') as f:
        f.write('SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE\n'
                'AAA,Aaa Ltd,EQ,06-OCT-2008,1\n'
                'NEWCO,New Co Ltd,EQ,05-OCT-2026,1\n')
    stocks = {s['symbol']: s for s in ns.process_data(project.base_dir)['latestBySymbol'].values()}
    assert stocks['NEWCO']['listingDate'] == '2026-10-05'    # only EQUITY_L knows it
    assert stocks['AAA']['listingDate'] == '2008-10-06'      # EQUITY_L wins over the mapping's 01-JAN-2000


def test_load_listing_dates_reads_the_spaced_header_and_skips_blank_dates(tmp_path):
    path = tmp_path / 'EQUITY_L.csv'
    path.write_text('SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\n'
                    'M&M,Mahindra,EQ,06-OCT-2008\n'
                    'BAD,Bad,EQ,\n', encoding='utf-8')
    assert ns.load_listing_dates(str(path)) == {ns.normalize_symbol('M&M'): '2008-10-06'}
    assert ns.load_listing_dates(str(tmp_path / 'nope.csv')) == {}

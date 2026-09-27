"""Price band merge/selection tests - covers a real live bug found and fixed this
session: TBZ's price band sat stale at 20% for weeks (NSE had actually moved it to 5%)
because process_data() picked whichever row appeared LAST in NSE_PriceBand_Combined.csv
for a symbol, and that file's rows are not guaranteed to be in chronological order for
every symbol - Download-NSE-Bhavcopy.ps1's incremental merge used to key off filesystem
mtimes, which a bulk restore/recovery of NSE_DATA (or any operation that touches file
timestamps) can leave completely out of sync with the trading dates the files represent.

The fix has two parts, both covered here from the process_data() side:
1. Download-NSE-Bhavcopy.ps1 now carries each row's trading date through into the
   combined file (a `Date` column, derived from the source `sec_list_ddMMyyyy.csv`
   filename - not touched by these tests, which write the combined file directly).
2. process_data() (src/nse_server.py) now picks the row with the LATEST Date per
   symbol, not the physically-last row in the file.
"""
from datetime import date

import nse_server as ns
from conftest import business_days, bhav_row, price_band_row

DAYS = business_days(date(2026, 9, 1), 5)
LATEST_DAY = DAYS[-1]

AAA_ISIN = 'INE1AAA01011'
BBB_ISIN = 'INE2BBB01011'


def test_latest_dated_band_row_wins_even_when_a_stale_row_appears_later_in_the_file(project):
    """Reproduces the real TBZ bug: each symbol's genuinely-latest row appears BEFORE an
    older, stale row for the same symbol later in the file - the old file-order-only
    heuristic would have picked the stale one for both."""
    project.write_bhavcopy([
        bhav_row('AAA', 'EQ', LATEST_DAY, close=100, isin=AAA_ISIN),
        bhav_row('BBB', 'EQ', LATEST_DAY, close=50, isin=BBB_ISIN),
    ])
    project.write_price_band([
        price_band_row('AAA', 'EQ', 5, LATEST_DAY),   # AAA's genuinely-latest band
        price_band_row('BBB', 'EQ', 20, LATEST_DAY),  # BBB's genuinely-latest band
        price_band_row('AAA', 'EQ', 20, DAYS[0]),     # stale AAA, appears LATER in the file
        price_band_row('BBB', 'EQ', 10, DAYS[0]),     # stale BBB, appears LATER in the file
    ])

    data = ns.process_data(project.base_dir)

    assert data['latestBySymbol'][AAA_ISIN]['bandPct'] == '5%'
    assert data['latestBySymbol'][BBB_ISIN]['bandPct'] == '20%'


def test_a_middle_date_between_two_others_does_not_win_regardless_of_row_position(project):
    """Three rows for one symbol, dates out of order in the file, middle date placed
    last - confirms real per-symbol max-date tracking, not just "first row seen wins"
    or "most recent row scanned wins" as a coincidence of this particular ordering."""
    project.write_bhavcopy([bhav_row('AAA', 'EQ', LATEST_DAY, close=100, isin=AAA_ISIN)])
    project.write_price_band([
        price_band_row('AAA', 'EQ', 5, DAYS[3]),   # genuinely latest
        price_band_row('AAA', 'EQ', 20, DAYS[0]),  # oldest
        price_band_row('AAA', 'EQ', 10, DAYS[1]),  # middle - placed last, must still lose
    ])

    data = ns.process_data(project.base_dir)

    assert data['latestBySymbol'][AAA_ISIN]['bandPct'] == '5%'


def test_a_row_with_no_date_column_still_applies_unconditionally_backward_compat(project):
    """Legacy-format safety net: data merged before the Date column existed has no Date
    field at all - process_data() must still apply it (matching the pre-fix unconditional
    behavior), not silently drop it. Also confirms upper/lower band price is still
    derived from the band % and prev-close when no explicit Upper_Band/Lower_Band columns
    are present, same as the real sec_list format."""
    project.write_bhavcopy([bhav_row('AAA', 'EQ', LATEST_DAY, close=100, isin=AAA_ISIN, prev=100)])
    project.write_price_band(
        [price_band_row('AAA', 'EQ', 7)],  # d=None -> no Date field at all
        cols=['Symbol', 'Series', 'Security Name', 'Band', 'Remarks'],
    )

    data = ns.process_data(project.base_dir)

    aaa = data['latestBySymbol'][AAA_ISIN]
    assert aaa['bandPct'] == '7%'
    assert aaa['upperBand'] == 107.0
    assert aaa['lowerBand'] == 93.0

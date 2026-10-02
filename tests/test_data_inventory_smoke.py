"""Disaster-recovery smoke tests: prove that the data and reference files on this machine are complete and correct.

The scenario these exist for: NSE_DATA is lost, everything is downloaded again and the reference files are
recreated. Running `pytest -m slow tests/test_data_inventory_smoke.py` (together with test_data_accuracy_smoke.py and
test_index_data_smoke.py) should then say whether the rebuilt data can be trusted. They check three things:

  1. INVENTORY - every data / reference file exists and is well-formed (columns, ISIN format, dates parse, no
     duplicate rows, archive covers the price history) and every per-day source file has made it into its
     merged file, row for row;
  2. COVERAGE - the reference files (equity list, market cap, sector mapping, MidSmallcap 400 list, TradingView
     corrections) cover the stocks that are actually traded, and the TradingView corrections are really applied;
  3. GOLDEN CHECKPOINTS - values that can never legitimately change (raw closes of 20 stocks on 8 dates, closes of
     12 indexes on 8 dates, row totals up to a frozen cut-off date, price ratios across 16 corporate actions) are
     pinned in tests/golden/data_checkpoints.json, so a rebuild must reproduce history exactly.

Opt-in (`slow`, never in CI, skips without real data), strictly read-only. To re-pick WHICH checkpoints are pinned
(not needed as new days arrive): python tests/golden/make_checkpoints.py
"""
import csv
import json
import os
import re
from datetime import datetime, timedelta

import pytest

import nse_server as ns
import realdata as rd

pytestmark = pytest.mark.slow


# ─── 1. inventory ───────────────────────────────────────────────────────────────

REQUIRED_FILES = [  # (path, minimum size in bytes)
    (rd.BHAV_PATH, 50_000_000), (rd.BAND_PATH, 20_000_000), (rd.INDICES_PATH, 1_000_000),
    (os.path.join(rd.DATA_DIR, 'EQUITY_L.csv'), 100_000), (os.path.join(rd.DATA_DIR, ns.MARKETCAP_FILE), 100_000),
    (os.path.join(rd.DATA_DIR, ns.MIDSMALL400_FILE), 1_000), (os.path.join(rd.DATA_DIR, ns.SECTOR_FILE), 100_000),
    (os.path.join(rd.REFERENCE_DIR, ns.CORPACTIONS_FILE), 20_000), (os.path.join(rd.REFERENCE_DIR, 'Sector-Stock-Mapping.csv'), 100_000),
    (os.path.join(rd.REFERENCE_DIR, 'TradingViewAdjustments.csv'), 100), (rd.PROCESSED_PATH, 10_000_000),
    (os.path.join(rd.REPO_ROOT, ns.PRESETS_FILE), 100),
]


def test_every_data_and_reference_file_exists_and_is_not_trivially_small():
    rd.require_real_data(rd.BHAV_PATH)
    problems = []
    for path, min_size in REQUIRED_FILES:
        if not os.path.exists(path):
            problems.append(f'MISSING {path}')
        elif os.path.getsize(path) < min_size:
            problems.append(f'TOO SMALL ({os.path.getsize(path)} B < {min_size} B) {path}')
    assert not problems, '\n'.join(problems)


def test_per_day_folders_and_merged_files_cover_the_same_trading_days():
    rd.require_real_data(rd.BHAV_PATH)
    bhav_files = set(rd.dated_files(rd.BHAV_DIR, 'BhavCopy_CM_', '%Y%m%d'))
    band_files = set(rd.dated_files(rd.BAND_DIR, 'sec_list_', '%d%m%Y'))
    merged_bhav, merged_band = set(rd.bhav_scan()[0]), set(rd.band_scan())
    assert bhav_files, 'no per-day bhavcopy files'
    assert bhav_files == merged_bhav, (
        f'per-day bhavcopy files vs merged file differ: only files {sorted(bhav_files - merged_bhav, key=rd.day)[:5]}, '
        f'only merged {sorted(merged_bhav - bhav_files, key=rd.day)[:5]}')
    assert band_files == merged_band, (
        f'per-day price band files vs merged file differ: only files {sorted(band_files - merged_band, key=rd.day)[:5]}, '
        f'only merged {sorted(merged_band - band_files, key=rd.day)[:5]}')
    assert bhav_files == band_files, (
        f'bhavcopy and price band cover different days: {sorted(bhav_files ^ band_files, key=rd.day)[:10]}')


def test_merged_bhavcopy_has_every_row_of_every_per_day_file():
    rd.require_real_data(rd.BHAV_PATH)
    merged, raw = rd.bhav_scan()[0], rd.raw_bhav_counts()
    bad = {d: (merged.get(d), n) for d, n in raw.items() if merged.get(d) != n}
    assert not bad, f'{len(bad)} days where merged rows != EQ/BE rows in that day\'s file (merged, file): {dict(list(bad.items())[:5])}'


def test_merged_price_band_has_every_row_of_every_per_day_file():
    rd.require_real_data(rd.BAND_PATH)
    merged, raw = rd.band_scan(), rd.raw_band_counts()
    bad = {d: (merged.get(d), n) for d, n in raw.items() if merged.get(d) != n}
    assert not bad, f'{len(bad)} days where merged rows != EQ/BE rows in that day\'s file (merged, file): {dict(list(bad.items())[:5])}'


def test_merged_index_file_has_every_configured_index_of_every_daily_file():
    rd.require_real_data(rd.INDICES_PATH)
    merged, _, per_index = rd.index_scan()
    raw = rd.raw_index_counts()
    assert raw, 'no raw index files'
    bad = {d: (merged.get(d), n) for d, n in raw.items() if merged.get(d) != n}
    assert not bad, f'{len(bad)} days where merged rows != configured-index rows in that day\'s file (merged, file): {dict(list(bad.items())[:5])}'
    assert set(merged) == set(raw), 'merged index file has days with no raw file (or vice versa)'
    assert len(per_index) == len(rd.wanted_indexes())


# ─── 2. reference files and their coverage ──────────────────────────────────────

def equity_list():
    return list(rd.read_csv_rows(os.path.join(rd.DATA_DIR, 'EQUITY_L.csv')))


def test_equity_list_is_well_formed_and_covers_every_traded_stock():
    rd.require_real_data(rd.PROCESSED_PATH)
    rows = equity_list()
    assert len(rows) > 2000, f'only {len(rows)} listed companies'
    symbols = [r['SYMBOL'] for r in rows]
    assert len(set(symbols)) == len(symbols), 'duplicate symbols in EQUITY_L.csv'
    bad_isin = [r['ISIN NUMBER'] for r in rows if not re.fullmatch(r'IN[A-Z0-9]{10}', r['ISIN NUMBER'])]
    assert not bad_isin, f'malformed ISINs: {bad_isin[:5]}'
    traded = {s['symbol'] for s in rd.processed()['latestBySymbol'].values()}
    missing = traded - set(symbols)
    assert len(missing) / len(traded) < 0.01, f'{len(missing)} traded stocks are not in EQUITY_L.csv: {sorted(missing)[:10]}'


def test_market_cap_file_is_current_and_covers_every_traded_stock():
    rd.require_real_data(rd.PROCESSED_PATH)
    rows = list(rd.read_csv_rows(os.path.join(rd.DATA_DIR, ns.MARKETCAP_FILE)))
    assert len(rows) > 2500, f'only {len(rows)} rows'
    file_date = datetime.strptime(rows[0]['Trade Date'], '%d %b %Y')
    latest = rd.day(rd.processed()['latestDate'])
    assert abs((latest - file_date).days) <= 7, f'market-cap file is dated {file_date:%d-%b-%Y}, stock data ends {latest:%d-%b-%Y}'
    covered = {r['Symbol'] for r in rows}
    traded = {s['symbol'] for s in rd.processed()['latestBySymbol'].values()}
    assert len(traded - covered) / len(traded) < 0.02, f'{len(traded - covered)} traded stocks have no market cap: {sorted(traded - covered)[:10]}'


def test_midsmallcap_400_list_is_complete_and_listed():
    rows = [r['SYMBOL'] for r in rd.read_csv_rows(os.path.join(rd.DATA_DIR, ns.MIDSMALL400_FILE))]
    assert 380 <= len(rows) <= 420, f'{len(rows)} constituents (expected ~400)'
    assert len(set(rows)) == len(rows), 'duplicate constituents'
    listed = {r['SYMBOL'] for r in equity_list()}
    assert len(set(rows) - listed) / len(rows) < 0.03, f'constituents not in EQUITY_L.csv: {sorted(set(rows) - listed)}'


def test_sector_mapping_is_complete_and_recent():
    rd.require_real_data(rd.PROCESSED_PATH)
    for path in (os.path.join(rd.DATA_DIR, ns.SECTOR_FILE), os.path.join(rd.REFERENCE_DIR, 'Sector-Stock-Mapping.csv')):
        rows = list(rd.read_csv_rows(path))
        assert rows and {'Stock Name', 'Sector', 'Basic Industry', 'Macro Sector', 'Industry Group', 'Fetched'} <= set(rows[0]), \
            f'unexpected columns in {path}'
        listed = {r['SYMBOL'] for r in equity_list()}
        covered = {r['Stock Name'] for r in rows}
        assert len(listed - covered) / len(listed) < 0.01, f'{len(listed - covered)} listed stocks have no sector row in {path}'
        assert sum(1 for r in rows if not r['Sector']) / len(rows) < 0.01, f'too many blank sectors in {path}'
        fetched = [datetime.strptime(r['Fetched'], '%Y-%m-%d') for r in rows if r['Fetched']]
        assert fetched and max(fetched) > datetime.now() - timedelta(days=180), (
            f'sector mapping not refreshed in 180 days (python src/build_screener_classification.py): {path}')


def test_reference_copy_of_the_sector_mapping_matches_the_working_copy():
    a = list(rd.read_csv_rows(os.path.join(rd.DATA_DIR, ns.SECTOR_FILE)))
    b = list(rd.read_csv_rows(os.path.join(rd.REFERENCE_DIR, 'Sector-Stock-Mapping.csv')))
    assert a == b, 'NSE_DATA and reference-data copies of Sector-Stock-Mapping.csv differ (commit/copy the newer one)'


def test_corporate_action_archive_is_well_formed_and_covers_the_price_history():
    rd.require_real_data(rd.PROCESSED_PATH)
    rows = list(rd.read_csv_rows(os.path.join(rd.REFERENCE_DIR, ns.CORPACTIONS_FILE)))
    assert len(rows) > 300, f'only {len(rows)} corporate actions'
    assert {'ISIN', 'SYMBOL', 'EXDATE', 'SUBJECT', 'FACEVAL', 'FV_ASOF'} <= set(rows[0])
    dates = [rd.day(r['EXDATE']) for r in rows]
    assert dates == sorted(dates), 'archive is not sorted by ex-date (the downloader writes it sorted)'
    keys = [(r['ISIN'], r['EXDATE'], r['SUBJECT']) for r in rows]
    assert len(set(keys)) == len(keys), 'duplicate corporate actions'
    assert all(re.fullmatch(r'IN[A-Z0-9]{10}', r['ISIN']) for r in rows), 'malformed ISIN in the archive'
    first_price_day = rd.day(rd.processed()['dates'][0])
    assert min(dates) <= first_price_day, (
        f'archive starts {min(dates):%d-%b-%Y}, after the first price day {first_price_day:%d-%b-%Y}: earlier actions would be missed')
    assert max(dates) >= rd.day(rd.processed()['latestDate']) - timedelta(days=90), 'archive has no recent actions - the feed may have failed'


def test_every_recognised_corporate_action_is_either_applied_or_listed_as_unadjusted():
    data = rd.processed()
    assert len(data['adjustedCorpActions']) > 100, 'almost no price adjustments applied - corporate actions not being read?'
    assert len(data['unadjustedCorpActions']) <= 30, (
        f'{len(data["unadjustedCorpActions"])} corporate actions left unadjusted (see Data Quality tab)')


def test_tradingview_corrections_file_is_valid_and_every_correction_is_applied():
    data = rd.processed()
    rows = list(rd.read_csv_rows(os.path.join(rd.REFERENCE_DIR, 'TradingViewAdjustments.csv')))
    assert rows and {'ISIN', 'SYMBOL', 'EXDATE', 'FACTOR', 'STATUS'} <= set(rows[0])
    assert {r['STATUS'] for r in rows} <= {'adjusted', 'tv-unadjusted', 'inconclusive'}, f'unknown STATUS values: {sorted({r["STATUS"] for r in rows})}'
    applied = {(a['isin'], a['exDate']): a['factor'] for a in data['adjustedCorpActions']}
    for r in rows:
        if r['STATUS'] != 'adjusted':
            continue
        factor = float(r['FACTOR'])
        assert 0 < factor < 2, f'{r["SYMBOL"]} {r["EXDATE"]}: implausible factor {factor}'
        key = (r['ISIN'], r['EXDATE'])
        assert key in applied, f'TradingView correction for {r["SYMBOL"]} {r["EXDATE"]} is not applied in the processed data'
        assert abs(applied[key] - factor) < 1e-4, f'{r["SYMBOL"]} {r["EXDATE"]}: applied factor {applied[key]} != file {factor}'


def test_saved_scanner_presets_are_valid_json():
    path = os.path.join(rd.REPO_ROOT, ns.PRESETS_FILE)
    rd.require_real_data(path)
    with open(path, encoding='utf-8') as f:
        presets = json.load(f)
    assert isinstance(presets, dict) and presets, 'no saved presets'
    assert all(isinstance(v, dict) for v in presets.values()), 'a preset is not an object'


# ─── 3. golden checkpoints ──────────────────────────────────────────────────────

def test_golden_row_totals_and_trading_days():
    g = rd.golden()
    m = rd.measure(g)
    exp = g['expected']
    for key in ('tradingDays', 'bhavcopyRows', 'priceBandRows', 'indexRows'):
        assert m[key] == exp[key], (
            f'{key} up to {g["cutoff"]}: have {m[key]}, golden {exp[key]} - data was lost or re-downloaded from a '
            f'different start date')


def test_golden_raw_stock_closes_are_reproduced():
    g = rd.golden()
    m = rd.measure(g)['stockCloses']
    bad = {k: (m[k], v) for k, v in g['expected']['stockCloses'].items() if m[k] is None or abs(m[k] - v) > 1e-6}
    assert not bad, f'{len(bad)} raw closes differ from the pinned values (have, golden): {dict(list(bad.items())[:5])}'


def test_golden_index_closes_are_reproduced():
    g = rd.golden()
    m = rd.measure(g)['indexCloses']
    bad = {k: (m[k], v) for k, v in g['expected']['indexCloses'].items() if m[k] is None or abs(m[k] - v) > 1e-6}
    assert not bad, f'{len(bad)} index closes differ from the pinned values (have, golden): {dict(list(bad.items())[:5])}'


def test_golden_corporate_action_adjustments_are_reproduced():
    """Close before the ex-date / close on it (both adjusted) across 16 pinned events: this is the ratio an adjustment
    factor controls, so it proves the corporate-action archive, the TradingView corrections and the adjustment
    maths together rebuild to the same prices."""
    g = rd.golden()
    m = rd.measure(g)['adjustmentRatios']
    bad = {k: (m[k], v) for k, v in g['expected']['adjustmentRatios'].items() if m[k] is None or abs(m[k] / v - 1) > 5e-4}
    assert not bad, f'{len(bad)} adjusted price ratios differ from the pinned values (have, golden): {dict(list(bad.items())[:5])}'

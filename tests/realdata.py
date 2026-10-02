"""Readers for the REAL NSE_DATA on this machine, shared by the opt-in `slow` smoke tests
(test_data_inventory_smoke.py, tests/golden/make_checkpoints.py). Everything here is strictly read-only, and the
expensive scans are cached for the pytest session so several tests can share one pass over the big CSVs.

The golden checkpoints (tests/golden/data_checkpoints.json) pin down values that can never legitimately change -
raw historical closes, index closes, row totals up to a frozen cut-off date, and the price ratio across a
corporate action - so that after losing and rebuilding NSE_DATA the rebuilt data can be proven identical.
"""
import collections
import csv
import functools
import json
import os
from datetime import datetime

import pytest

import nse_server as ns
from conftest import REPO_ROOT

DATA_DIR = os.path.join(REPO_ROOT, 'NSE_DATA')
REFERENCE_DIR = os.path.join(REPO_ROOT, ns.REFERENCE_SUBDIR)
GOLDEN_PATH = os.path.join(REPO_ROOT, 'tests', 'golden', 'data_checkpoints.json')
BHAV_DIR = os.path.join(DATA_DIR, 'Bhavcopy')
BAND_DIR = os.path.join(DATA_DIR, 'PriceBand')
INDEX_DIR = os.path.join(DATA_DIR, ns.INDEX_RAW_SUBDIR)
PROCESSED_PATH = os.path.join(DATA_DIR, ns.PROCESSED_FILE)
INDICES_PATH = os.path.join(DATA_DIR, ns.INDICES_FILE)
BHAV_PATH = os.path.join(DATA_DIR, ns.BHAV_FILE)
BAND_PATH = os.path.join(DATA_DIR, ns.BAND_FILE)

STOCK_SERIES = ('EQ', 'BE')   # the series the downloader keeps in the combined files


def day(s):
    return datetime.strptime(s, '%d-%b-%Y')


def require_real_data(*paths):
    for p in paths:
        if not os.path.exists(p):
            pytest.skip(f'No real data at {p} - run Start-Dashboard.ps1 first.')


@functools.lru_cache(None)
def golden():
    require_real_data(GOLDEN_PATH)
    with open(GOLDEN_PATH, encoding='utf-8') as f:
        return json.load(f)


@functools.lru_cache(None)
def processed():
    require_real_data(PROCESSED_PATH)
    with open(PROCESSED_PATH, encoding='utf-8') as f:
        return json.load(f)


def read_csv_rows(path):
    """DictReader rows with every header and value stripped (NSE pads fields with spaces)."""
    with open(path, newline='', encoding='utf-8-sig') as f:
        rd = csv.reader(f)
        header = [h.strip() for h in next(rd)]
        for r in rd:
            yield dict(zip(header, (v.strip() for v in r)))


# ─── merged files ───────────────────────────────────────────────────────────────

@functools.lru_cache(None)
def bhav_scan():
    """(rows per date, {(symbol, date): close} for the golden stocks/dates) from the combined bhavcopy."""
    g = golden()
    want = {(s, d) for s in g['stocks'] for d in g['dates']}
    counts, closes = collections.Counter(), {}
    for r in read_csv_rows(BHAV_PATH):
        counts[r['DATE1']] += 1
        key = (r['SYMBOL'], r['DATE1'])
        if key in want:
            closes[key] = float(r['CLOSE_PRICE'])
    return counts, closes


@functools.lru_cache(None)
def band_scan():
    """Rows per date in the combined price band file."""
    counts = collections.Counter()
    for r in read_csv_rows(BAND_PATH):
        counts[r['Date']] += 1
    return counts


@functools.lru_cache(None)
def index_scan():
    """(rows per date, {(index, date): close} for the golden indexes/dates, rows per index) from the merged index file."""
    g = golden()
    want = {(n, d) for n in g['indexes'] for d in g['indexDates']}
    counts, closes, per_index = collections.Counter(), {}, collections.Counter()
    for r in read_csv_rows(INDICES_PATH):
        counts[r['DATE1']] += 1
        per_index[r['INDEX_NAME']] += 1
        if (r['INDEX_NAME'], r['DATE1']) in want:
            closes[(r['INDEX_NAME'], r['DATE1'])] = float(r['CLOSE'])
    return counts, closes, per_index


# ─── per-day source files ───────────────────────────────────────────────────────

def dated_files(folder, prefix, date_fmt, suffix='.csv'):
    """{date string dd-Mon-yyyy: path} for files like <prefix><date><suffix>."""
    out = {}
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            if name.startswith(prefix) and name.endswith(suffix):
                try:
                    out[datetime.strptime(name[len(prefix):-len(suffix)], date_fmt).strftime('%d-%b-%Y')] = os.path.join(folder, name)
                except ValueError:
                    pass
    return out


@functools.lru_cache(None)
def raw_bhav_counts():
    """{date: number of EQ/BE stock rows} in each per-day UDiFF bhavcopy file."""
    out = {}
    for d, path in dated_files(BHAV_DIR, 'BhavCopy_CM_', '%Y%m%d').items():
        with open(path, newline='', encoding='utf-8-sig') as f:
            out[d] = sum(1 for r in csv.DictReader(f) if r['SctySrs'].strip() in STOCK_SERIES and r['FinInstrmTp'].strip() == 'STK')
    return out


@functools.lru_cache(None)
def raw_band_counts():
    """{date: number of EQ/BE rows} in each per-day price band file."""
    out = {}
    for d, path in dated_files(BAND_DIR, 'sec_list_', '%d%m%Y').items():
        with open(path, newline='', encoding='utf-8-sig') as f:
            out[d] = sum(1 for r in csv.DictReader(f) if r['Series'].strip() in STOCK_SERIES)
    return out


def wanted_indexes():
    """The index names the downloader saves: the $IndexWanted list in Download-NSE-Bhavcopy.ps1."""
    import re
    src = open(os.path.join(REPO_ROOT, 'Download-NSE-Bhavcopy.ps1'), encoding='utf-8-sig').read()
    block = re.search(r'\$IndexWanted\s*=\s*@\((.*?)\n\)', src, re.S).group(1)
    return re.findall(r'"([^"]+)"', re.sub(r'#[^\n]*', '', block))


@functools.lru_cache(None)
def raw_index_counts():
    """{date: number of configured indexes present} in each raw ind_close_all file."""
    wanted = {n.lower() for n in wanted_indexes()}
    out = {}
    for d, path in dated_files(INDEX_DIR, 'ind_close_all_', '%Y%m%d').items():
        with open(path, newline='', encoding='utf-8-sig') as f:
            out[d] = sum(1 for r in csv.DictReader(f) if r['Index Name'].strip().lower() in wanted)
    return out


# ─── golden measurement ─────────────────────────────────────────────────────────

def adjusted_ratio(data, isin, ex_date):
    """Adjusted close the day before the ex-date divided by the adjusted close ON the ex-date, or None.
    Only this action sits between the two bars, so the ratio is unaffected by any later corporate action."""
    cols = data['dailyCols']
    di, ci = cols.index('date'), cols.index('close')
    days = data['dailyBySymbol'].get(isin) or []
    for i, r in enumerate(days):
        if r[di] == ex_date and i > 0 and days[i - 1][ci] and r[ci]:
            return days[i - 1][ci] / r[ci]
    return None


def measure(g):
    """Recompute, from the real data on disk, every value the golden file records."""
    counts, closes = bhav_scan()
    band = band_scan()
    icounts, icloses, _ = index_scan()
    cutoff = day(g['cutoff'])
    up_to = lambda c: sum(n for d, n in c.items() if day(d) <= cutoff)
    index_from = day(g['indexDates'][0])   # the index history starts where the golden index checks start
    data = processed()
    return {
        'bhavcopyRows': up_to(counts),
        'tradingDays': sum(1 for d in counts if day(d) <= cutoff),
        'priceBandRows': up_to(band),
        'indexRows': sum(n for d, n in icounts.items() if index_from <= day(d) <= cutoff),
        'stockCloses': {f'{s}|{d}': closes.get((s, d)) for s in g['stocks'] for d in g['dates']},
        'indexCloses': {f'{n}|{d}': icloses.get((n, d)) for n in g['indexes'] for d in g['indexDates']},
        'adjustmentRatios': {f'{i}|{d}': adjusted_ratio(data, i, d) for i, d in g['events']},
    }

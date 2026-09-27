"""Shared pytest fixtures/setup for the whole suite.

src/ has no __init__.py (this project is a flat stdlib-only script layout, not
a package - see AGENT.md), so tests import nse_server/tv_adjust/tv_report as
top-level modules with src/ added to sys.path here, once, for the whole run.
"""
import csv
import io
import os
import sys
from datetime import date, timedelta

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(REPO_ROOT, 'src')
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

import pytest


# ─── Fixture-building helpers (Phase 2+: small end-to-end process_data() tests) ────

BHAV_COLS = ['SYMBOL', 'SERIES', 'DATE1', 'PREV_CLOSE', 'OPEN_PRICE', 'HIGH_PRICE', 'LOW_PRICE',
             'LAST_PRICE', 'CLOSE_PRICE', 'AVG_PRICE', 'TTL_TRD_QNTY', 'TURNOVER_LACS',
             'NO_OF_TRADES', 'DELIV_QTY', 'DELIV_PER', 'ISIN', 'COMPANY_NAME']
CORP_ACTION_COLS = ['ISIN', 'SYMBOL', 'EXDATE', 'SUBJECT', 'FACEVAL', 'FV_ASOF']
TV_ADJUSTMENT_COLS = ['ISIN', 'SYMBOL', 'EXDATE', 'FACTOR', 'STATUS', 'CHECKED_AT', 'NOTE']


def business_days(start, n):
    """n consecutive weekdays starting from `start` (a date), skipping Sat/Sun -
    avoids hand-verifying weekday alignment when picking fixture dates."""
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def fmt_date(d):
    """dd-Mon-yyyy, matching parse_date_str's primary format and the real combined CSV."""
    return d.strftime('%d-%b-%Y')


def bhav_row(symbol, series, d, close, isin, prev=None, company=''):
    """One bhavcopy row. open/high/low/last/avg all default to `close` (irrelevant to the
    adjustment logic under test here); prev defaults to `close` too when not given
    (callers that care about `prev`-field adjustment pass it explicitly)."""
    p = close if prev is None else prev
    return {
        'SYMBOL': symbol, 'SERIES': series, 'DATE1': fmt_date(d),
        'PREV_CLOSE': p, 'OPEN_PRICE': close, 'HIGH_PRICE': close, 'LOW_PRICE': close,
        'LAST_PRICE': close, 'CLOSE_PRICE': close, 'AVG_PRICE': close,
        'TTL_TRD_QNTY': 1000, 'TURNOVER_LACS': 10, 'NO_OF_TRADES': 50,
        'DELIV_QTY': '', 'DELIV_PER': '', 'ISIN': isin, 'COMPANY_NAME': company,
    }


def corp_action_row(isin, symbol, exdate, subject, faceval='', fv_asof=''):
    return {'ISIN': isin, 'SYMBOL': symbol, 'EXDATE': fmt_date(exdate), 'SUBJECT': subject,
            'FACEVAL': faceval, 'FV_ASOF': fmt_date(fv_asof) if fv_asof else ''}


def tv_adjustment_row(isin, symbol, exdate, factor, status='adjusted', checked_at='2026-01-01 00:00', note=''):
    return {'ISIN': isin, 'SYMBOL': symbol, 'EXDATE': fmt_date(exdate), 'FACTOR': factor,
            'STATUS': status, 'CHECKED_AT': checked_at, 'NOTE': note}


def _write_csv(path, cols, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols)
    w.writeheader()
    for r in rows:
        w.writerow(r)
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        f.write(buf.getvalue())


@pytest.fixture
def project(tmp_path):
    """A minimal on-disk project directory process_data(base_dir) can run against:
    NSE_DATA/ + reference-data/, containing whatever CSVs the test writes via the
    returned `write(...)` helper. Never touches the real project's NSE_DATA/ or
    reference-data/ - tmp_path is a fresh pytest-managed temp directory per test."""
    base_dir = tmp_path

    class Project:
        def write_bhavcopy(self, rows):
            _write_csv(os.path.join(base_dir, 'NSE_DATA', 'NSE_Bhavcopy_Combined.csv'), BHAV_COLS, rows)

        def write_bhavcopy_raw_header(self, header_line, data_rows):
            """For the malformed-header regression test: write literal CSV text with a
            caller-supplied header rather than going through BHAV_COLS."""
            path = os.path.join(base_dir, 'NSE_DATA', 'NSE_Bhavcopy_Combined.csv')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8-sig', newline='') as f:
                f.write(header_line + '\n')
                for row in data_rows:
                    f.write(row + '\n')

        def write_corp_actions(self, rows):
            _write_csv(os.path.join(base_dir, 'reference-data', 'CorporateActions.csv'), CORP_ACTION_COLS, rows)

        def write_tv_adjustments(self, rows):
            _write_csv(os.path.join(base_dir, 'reference-data', 'TradingViewAdjustments.csv'), TV_ADJUSTMENT_COLS, rows)

        @property
        def base_dir(self):
            return str(base_dir)

    return Project()


def decode_daily(data, isin):
    """compact_daily rows are plain lists in DAILY_COLS order (see nse_server.py's
    DAILY_COLS/compact_daily) - decode data['dailyBySymbol'][isin] into a list of
    {date, open, high, low, close, vol, turnover, prev, delivQty, delivPer, trades}
    dicts for readable assertions. Returns [] if the ISIN isn't in the output at all
    (e.g. correctly excluded as stale)."""
    cols = data['dailyCols']
    rows = data['dailyBySymbol'].get(isin, [])
    return [dict(zip(cols, row)) for row in rows]

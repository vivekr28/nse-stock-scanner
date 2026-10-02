"""One real-data smoke test for the NSE index file (NSE_DATA/NSE_Indices_Combined.csv).

Like test_real_data_smoke.py this is NOT hermetic: it reads the real, git-ignored NSE_DATA on this machine,
so it is marked `slow` (excluded by default, never run in CI) and skips itself when the file is missing.
It is the only automated check on Download-NSE-Bhavcopy.ps1's index download + merge step, which has no unit
tests of its own: it guards against a bad download or a change in NSE's file format. Loose sanity checks only.
Strictly read-only. Run explicitly with:
    pytest -m slow tests/test_index_data_smoke.py
"""
import csv
import os
import re
from datetime import datetime

import pytest

from conftest import REPO_ROOT

INDEX_PATH = os.path.join(REPO_ROOT, 'NSE_DATA', 'NSE_Indices_Combined.csv')
PS1_PATH = os.path.join(REPO_ROOT, 'Download-NSE-Bhavcopy.ps1')

# Indexes that have existed for the whole 2-year window, so they must have close to a full history.
LONG_HISTORY = ['Nifty 50', 'Nifty 500', 'Nifty Bank', 'Nifty IT', 'Nifty MidSmallcap 400']


def wanted_indexes():
    """The index names the downloader is configured to save: the $IndexWanted list in the PowerShell script."""
    src = open(PS1_PATH, encoding='utf-8-sig').read()
    block = re.search(r'\$IndexWanted\s*=\s*@\((.*?)\n\)', src, re.S).group(1)
    return re.findall(r'"([^"]+)"', re.sub(r'#[^\n]*', '', block))


def load_rows():
    with open(INDEX_PATH, newline='', encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


@pytest.mark.slow
def test_index_file_is_complete_and_sane():
    if not os.path.exists(INDEX_PATH):
        pytest.skip(f'No index file at {INDEX_PATH} - run Download-NSE-Bhavcopy.ps1 first.')

    rows = load_rows()
    assert rows, 'index file has no rows'

    by_index = {}
    for r in rows:
        by_index.setdefault(r['INDEX_NAME'], []).append(r)

    # every configured index made it into the file (names are matched case-insensitively by the downloader)
    have = {n.lower() for n in by_index}
    missing = [n for n in wanted_indexes() if n.lower() not in have]
    assert not missing, f'configured indexes missing from the file: {missing}'

    seen = set()
    for name, rs in by_index.items():
        dates = [datetime.strptime(r['DATE1'], '%d-%b-%Y') for r in rs]
        assert dates == sorted(dates), f'{name}: rows are not in date order'
        for r in rs:
            key = (name, r['DATE1'])
            assert key not in seen, f'duplicate row {key}'
            seen.add(key)
            close = float(r['CLOSE'])
            assert close > 0, f'{key}: non-positive close'
            if r['OPEN'] and r['HIGH'] and r['LOW']:
                o, h, l = float(r['OPEN']), float(r['HIGH']), float(r['LOW'])
                assert h >= l, f'{key}: high < low'
                eps = 1e-6 * max(h, 1)
                assert l - eps <= close <= h + eps, f'{key}: close outside the day range'

    for name in LONG_HISTORY:
        assert len(by_index[name]) >= 300, f'{name}: only {len(by_index[name])} days of history'

    # the latest trading day should be present for the core index, and shared across it and a sector index
    assert by_index['Nifty 500'][-1]['DATE1'] == by_index['Nifty Bank'][-1]['DATE1']

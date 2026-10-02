"""The dashboard has two implementations of the per-stock indicators: the Python server (nse_server.process_data, used
whenever the server is running) and a JavaScript fallback (js/data-processor.js processData, used when CSVs are loaded in
the browser without the server). They must agree. This runs the same synthetic bhavcopy (random-walk prices, histories of
many different lengths around the 20 / 22 / 250-day window edges, a stale stock, a stock with no previous close) through
both and compares every indicator.

The fixture has no corporate actions on purpose: only the Python side adjusts prices for splits / bonuses / rights.
Needs `node` on the PATH (skips without it).
"""
import json
import os
import random
import shutil
import subprocess
from datetime import date

import pytest

import nse_server as ns
from conftest import REPO_ROOT, business_days, bhav_row

N_DAYS = 300
DAYS = business_days(date(2025, 6, 2), N_DAYS)

# (symbol, number of days of history, offset of its LAST day from the final trading day)
STOCKS = [('S005', 5, 0), ('S019', 19, 0), ('S020', 20, 0), ('S021', 21, 0), ('S022', 22, 0), ('S023', 23, 0),
          ('S100', 100, 0), ('S249', 249, 0), ('S250', 250, 0), ('S251', 251, 0), ('S300', 300, 0),
          ('STALE', 120, 3),            # last traded 3 trading days before the end: excluded from the indicators by both
          ('NOPREV', 60, 0),            # exchange previous close of 0 on its last day
          ('EDGEIN', 300, 0),           # price spike on the OLDEST day inside the 250-day window -> must be counted
          ('EDGEOUT', 300, 0)]          # price spike on the day just OUTSIDE the window -> must be ignored

# day index (0-based, of the stock's 300 days) that gets an extreme high and low: days 50..299 are the last 250
SPIKES = {'EDGEIN': 50, 'EDGEOUT': 49}


def build_rows():
    rng = random.Random(20260930)
    rows = []
    for idx, (symbol, length, tail) in enumerate(STOCKS):
        isin = f'INE{idx:03d}Z01011'
        price = rng.uniform(20, 3000)
        end = N_DAYS - tail
        for j in range(length):
            d = DAYS[end - length + j]
            prev = price
            open_ = price * (1 + rng.uniform(-0.03, 0.03))
            price = max(1.0, price * (1 + rng.uniform(-0.06, 0.06)))
            row = bhav_row(symbol, 'EQ', d, round(price, 2), isin, prev=round(prev, 2))
            row['OPEN_PRICE'] = round(open_, 2)
            row['HIGH_PRICE'] = round(max(open_, price) * (1 + rng.uniform(0, 0.03)), 2)
            row['LOW_PRICE'] = round(min(open_, price) * (1 - rng.uniform(0, 0.03)), 2)
            if symbol == 'NOPREV' and j == length - 1:
                row['PREV_CLOSE'] = 0
            if SPIKES.get(symbol) == j:
                row['HIGH_PRICE'], row['LOW_PRICE'] = round(price * 5, 2), round(price * 0.2, 2)
            rows.append(row)
    return rows


FIELDS = ['sma20', 'high52w', 'low52w', 'adr', 'changePct', 'monthlyChangePct', 'distFrom52H', 'distFrom52L', 'distFromSMA']


def test_python_and_javascript_indicators_agree(project, tmp_path):
    node = shutil.which('node')
    if not node:
        pytest.skip('node is not on the PATH')

    rows = build_rows()
    project.write_bhavcopy(rows)
    py = ns.process_data(project.base_dir)
    py_stocks = {v['symbol']: v for v in py['latestBySymbol'].values()}

    rows_json = tmp_path / 'rows.json'
    rows_json.write_text(json.dumps(rows), encoding='utf-8')
    out = subprocess.run([node, os.path.join(REPO_ROOT, 'tests-js', 'parity-runner.js'), str(rows_json)],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-800:]
    js = json.loads(out.stdout)

    # the same stocks are active, and the same ones are stale
    assert set(js['stocks']) == set(py_stocks) == {s for s, _, tail in STOCKS if tail == 0}
    assert js['stale'] == sorted(s['symbol'] for s in py['staleStocks']) == ['STALE']
    assert js['latestDate'] == py['latestDate']
    assert js['dates'] == py['dates']

    problems = []
    for symbol, p in py_stocks.items():
        j = js['stocks'][symbol]
        for f in FIELDS:
            a, b = p[f], j[f]
            if a is None or b is None:
                if a is not b:
                    problems.append((symbol, f, a, b))
            elif abs(a - b) > 0.0051:        # Python stores 2 decimals, JavaScript keeps full precision
                problems.append((symbol, f, a, b))
        for f in ('aboveSMA', 'tradingDays', 'close', 'sector', 'industry'):
            if p[f] != j[f]:
                problems.append((symbol, f, p[f], j[f]))
    assert not problems, f'{len(problems)} differences between the Python and JavaScript indicators, e.g. {problems[:6]}'

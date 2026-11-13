"""Real-data checks of the data PROCESSING itself (opt-in `slow`, local only, read-only): are the numbers the dashboard
derives from the prices correct? Everything is recomputed independently here and compared:

  * the per-stock indicators in processed_data.json (20 SMA, 52-week high/low, ADR, change %, monthly change %,
    distances from the 52-week high/low and the SMA, above-SMA) against a fresh calculation from each stock's own stored
    price history - all ~2,500 stocks;
  * every stock's sector and industry against the Sector-Stock-Mapping.csv it came from;
  * the Money Flow tab: the dashboard's own industry grouping and money-flow code (js/money-flow.js) is run
    under Node on the REAL data and its group sizes, market-cap totals and money flow (current / previous window, % change,
    the reading one lag ago, rate of change) are compared with a separate Python calculation from the daily prices. (Needs `node` on the PATH; skips without it.)

Run explicitly with:  pytest -m slow tests/test_processing_realdata_smoke.py
"""
import json
import os
import shutil
import subprocess
from collections import defaultdict

import pytest

import nse_server as ns
import realdata as rd

pytestmark = pytest.mark.slow

ROUNDING = 0.0051   # indicators are stored rounded to 2 decimals


@pytest.fixture(scope='module')
def data():
    rd.require_real_data(rd.PROCESSED_PATH)
    assert not ns.needs_processing(rd.REPO_ROOT), 'processed_data.json is older than the CSVs: start the dashboard (or Reprocess Data)'
    return rd.processed()


# ─── indicators ─────────────────────────────────────────────────────────────────

def expected_indicators(days, ci):
    """The indicators of one stock, recomputed from its daily rows (last row = latest day)."""
    n = len(days)
    close = lambda r: r[ci['close']]
    last = days[-1]
    sma20 = sum(close(r) for r in days[-20:]) / 20 if n >= 20 else None
    window = days[-min(n, 250):]
    high52, low52 = max(r[ci['high']] for r in window), min(r[ci['low']] for r in window)
    adr_days = days[-20:]
    adr = sum((r[ci['high']] - r[ci['low']]) / close(r) * 100 for r in adr_days) / len(adr_days)
    prev = last[ci['prev']]
    ref = days[-22] if n >= 22 else days[0]
    return {
        'sma20': sma20, 'high52w': high52, 'low52w': low52, 'adr': adr,
        'changePct': (close(last) - prev) / prev * 100 if prev > 0 else 0,
        'monthlyChangePct': (close(last) - close(ref)) / close(ref) * 100 if close(ref) > 0 else 0,
        'distFrom52H': (high52 - close(last)) / high52 * 100 if high52 > 0 else 0,
        'distFrom52L': (close(last) - low52) / low52 * 100 if low52 > 0 else 0,
        'distFromSMA': (close(last) - sma20) / sma20 * 100 if sma20 else None,
        'aboveSMA': (close(last) > sma20) if sma20 else False,
    }


def test_every_stocks_indicators_match_an_independent_recomputation(data):
    ci = {c: i for i, c in enumerate(data['dailyCols'])}
    bad = defaultdict(list)
    for isin, snap in data['latestBySymbol'].items():
        exp = expected_indicators(data['dailyBySymbol'][isin], ci)
        assert snap['close'] == data['dailyBySymbol'][isin][-1][ci['close']], f'{snap["symbol"]}: close differs from last daily row'
        for k, v in exp.items():
            got = snap[k]
            if v is None or isinstance(v, bool):
                if got != v:
                    bad[k].append((snap['symbol'], got, v))
            elif got is None or abs(got - v) > ROUNDING:
                bad[k].append((snap['symbol'], got, round(v, 4)))
    assert not bad, '\n'.join(f'{k}: {len(v)} stocks differ, e.g. {v[:3]}' for k, v in bad.items())


def test_trading_days_and_latest_date_are_consistent(data):
    n = len(data['latestBySymbol'])
    assert n > 1000
    for isin, snap in data['latestBySymbol'].items():
        assert snap['date'] == data['latestDate']
        assert snap['tradingDays'] >= len(data['dailyBySymbol'][isin]), f'{snap["symbol"]}: tradingDays < stored rows'


# ─── sector / industry labels ───────────────────────────────────────────────────

def test_sector_and_industry_come_from_the_mapping_file(data):
    mapping = {}
    for r in rd.read_csv_rows(os.path.join(rd.DATA_DIR, ns.SECTOR_FILE)):
        mapping[ns.normalize_symbol(r['Stock Name'])] = (r['Sector'], r['Basic Industry'])
    undefined = 'Undefined-Diversified'
    clean = lambda v: v if v and v != '-' else undefined
    wrong = []
    for snap in data['latestBySymbol'].values():
        sector, industry = mapping.get(ns.normalize_symbol(snap['symbol']), ('', ''))
        if (snap['sector'], snap['industry']) != (clean(sector), clean(industry)):
            wrong.append((snap['symbol'], (snap['sector'], snap['industry']), (clean(sector), clean(industry))))
    assert not wrong, f'{len(wrong)} stocks whose sector/industry differ from the mapping file: {wrong[:5]}'


def test_each_industry_belongs_to_exactly_one_sector(data):
    sectors_of = defaultdict(set)
    for s in data['latestBySymbol'].values():
        sectors_of[s['industry']].add(s['sector'])
    multi = {k: sorted(v) for k, v in sectors_of.items() if len(v) > 1 and k != 'Undefined-Diversified'}
    assert not multi, f'industries spread over several sectors (the Industry tab would show only the first): {dict(list(multi.items())[:5])}'


# ─── Money Flow tab (the dashboard's own JS, on the real data) ─

@pytest.fixture(scope='module')
def tabs(data):
    node = shutil.which('node')
    if not node:
        pytest.skip('node is not on the PATH')
    out = subprocess.run([node, os.path.join(rd.REPO_ROOT, 'tests-js', 'realdata-groups.js'), rd.PROCESSED_PATH],
                         capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, f'node failed: {out.stderr[-800:]}'
    result = json.loads(out.stdout)
    assert 'error' not in result['industries'], result['industries'].get('error')
    return result


def group(snaps, key):
    g = defaultdict(list)
    for s in snaps:
        g[s[key]].append(s)
    return g


def test_money_flow_tab_grouping_matches_an_independent_grouping(data, tabs):
    snaps = list(data['latestBySymbol'].values())
    expected = group(snaps, 'industry')
    shown = tabs['industries']
    assert set(shown) == set(expected), f'industries differ: {sorted(set(shown) ^ set(expected))[:5]}'
    assert sum(v['stockCount'] for v in shown.values()) == len(snaps)
    close = lambda a, b: abs(a - b) <= 1e-6 * max(1.0, abs(b))
    for name, members in expected.items():
        got = shown[name]
        assert got['stockCount'] == len(members), name
        assert close(got['totalMcap'], sum(s['marketCap'] or 0 for s in members)), name
        assert got['sector'] == members[0]['sector'], name      # the tab shows the sector of the industry's first stock


def expected_money_flow(data, period_days, offset=0):
    """Per industry: (turnover of the last `period_days` trading days, turnover of the `period_days` before them), the whole window shifted
    back `offset` trading days. Recomputed straight from every stock's daily rows."""
    dates = data['dates']
    end = len(dates) - offset
    cur_dates = set(dates[max(0, end - period_days):end])
    cur_n = len(cur_dates)
    prev_end = end - cur_n
    prev_dates = set(dates[max(0, prev_end - period_days):prev_end])
    ci = {c: i for i, c in enumerate(data['dailyCols'])}
    industry_of = {k: v['industry'] for k, v in data['latestBySymbol'].items()}
    flow = defaultdict(lambda: [0.0, 0.0])
    for key, rows in data['dailyBySymbol'].items():
        ind = industry_of.get(key)
        if ind is None:          # no latest row (not in the dashboard's stock list): the tab never groups it
            continue
        for r in rows:
            t = r[ci['turnover']] or 0
            if r[ci['date']] in cur_dates:
                flow[ind][0] += t
            elif r[ci['date']] in prev_dates:
                flow[ind][1] += t
    return flow


def pct(cur, prev):
    return (cur - prev) / prev * 100 if prev > 0 else (100.0 if cur > 0 else 0.0)


@pytest.mark.parametrize('pair', ['6m_1m', '1m_1w', '3m_3m'])
def test_money_flow_numbers_match_an_independent_recomputation(data, tabs, pair):
    """The Money Flow tab (and the Stock Scanner's F12 / F17 filters, which use the same engine): money flow, its % change, the same reading one
    lag ago and the rate of change, for every industry, against a separate Python calculation from the daily prices."""
    shown = tabs['moneyFlow'][pair]
    now = expected_money_flow(data, shown['periodDays'])
    past = expected_money_flow(data, shown['periodDays'], offset=shown['lagDays'])
    close = lambda a, b: abs(a - b) <= 1e-6 * max(1.0, abs(b))
    rows = shown['rows']
    assert set(rows) == set(group(list(data['latestBySymbol'].values()), 'industry'))
    for name, got in rows.items():
        cur, prev = now[name]
        pcur, pprev = past[name]
        assert close(got['cur'], cur) and close(got['prev'], prev), (name, got['cur'], cur, got['prev'], prev)
        assert close(got['chg'], pct(cur, prev)), name
        assert close(got['pastChg'], pct(pcur, pprev)), name
        assert close(got['roc'], pct(cur, prev) - pct(pcur, pprev)), name

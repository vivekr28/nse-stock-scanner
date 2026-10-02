"""Real-data ACCURACY smoke tests: is the data on this machine, and what the dashboard computes from it, correct?

Like the other `slow` tests this reads the real, git-ignored NSE_DATA on this machine (never run in CI, skipped if
the data is missing; strictly read-only). Where test_real_data_smoke.py only asks "does the pipeline run and
produce a plausible number of stocks", these check the numbers themselves, mostly by cross-checking independent
sources against each other:

  * the stock trading calendar against NSE's own index calendar (a missing or extra day shows up immediately);
  * per-stock price rows against basic market invariants (OHLC ordering, prev-close chain, no unexplained
    price cliffs after split/bonus adjustment);
  * the dashboard's equal-weight MidSmallcap 400 index against NSE's OFFICIAL Nifty MidSmallcap 400, and the
    market breadth (share of stocks up) against the Nifty 500 - two stock-level computations validated by index
    data that never went through our processing;
  * coverage of sector / market cap / price band, and the constituent list against the computed index.

It reads NSE_DATA/processed_data.json (what the dashboard actually serves), so it first checks that file is not
stale relative to the CSVs. Thresholds are loose margins around the values measured on real data (correlation
0.984 / mean daily gap 0.16% for the EW index; 0.84 for breadth), so a pass means "still consistent", a fail
means something drifted. Run explicitly with:
    pytest -m slow tests/test_data_accuracy_smoke.py
"""
import csv
import json
import os
from datetime import datetime

import pytest

import nse_server as ns
from conftest import REPO_ROOT

DATA_DIR = os.path.join(REPO_ROOT, 'NSE_DATA')
PROCESSED_PATH = os.path.join(DATA_DIR, ns.PROCESSED_FILE)
INDEX_PATH = os.path.join(DATA_DIR, ns.INDICES_FILE)
CONSTITUENTS_PATH = os.path.join(DATA_DIR, ns.MIDSMALL400_FILE)

pytestmark = pytest.mark.slow


def day(s):
    return datetime.strptime(s, '%d-%b-%Y')


@pytest.fixture(scope='module')
def data():
    if not (os.path.exists(PROCESSED_PATH) and os.path.exists(INDEX_PATH)):
        pytest.skip(f'Needs the real {ns.PROCESSED_FILE} and {ns.INDICES_FILE} in {DATA_DIR} '
                    f'(run Start-Dashboard.ps1 once first).')
    assert not ns.needs_processing(REPO_ROOT), (
        f'{ns.PROCESSED_FILE} is older than the CSVs it is built from - start the dashboard (or click Reprocess '
        f'Data) so it is rebuilt, then re-run.')
    with open(PROCESSED_PATH, encoding='utf-8') as f:
        return json.load(f)


@pytest.fixture(scope='module')
def index_closes():
    """{index name: {date string: close}} from NSE_Indices_Combined.csv."""
    out = {}
    with open(INDEX_PATH, newline='', encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            out.setdefault(r['INDEX_NAME'], {})[r['DATE1']] = float(r['CLOSE'])
    return out


def returns(closes_by_date):
    """{date: close-to-close return} for consecutive dates."""
    ds = sorted(closes_by_date, key=day)
    return {ds[i]: closes_by_date[ds[i]] / closes_by_date[ds[i - 1]] - 1 for i in range(1, len(ds))}


def correlation(a, b):
    """(n, pearson r, mean absolute gap) over the dates both series have."""
    ks = [k for k in a if k in b]
    x, y = [a[k] for k in ks], [b[k] for k in ks]
    mx, my = sum(x) / len(x), sum(y) / len(y)
    cov = sum((p - mx) * (q - my) for p, q in zip(x, y))
    var = (sum((p - mx) ** 2 for p in x) * sum((q - my) ** 2 for q in y)) ** 0.5
    return len(ks), cov / var, sum(abs(p - q) for p, q in zip(x, y)) / len(ks)


def rows(data):
    """Every daily row as a dict-free tuple view: yields (isin, row, col-index map)."""
    ci = {c: i for i, c in enumerate(data['dailyCols'])}
    for isin, days in data['dailyBySymbol'].items():
        yield isin, days, ci


# ─── calendar ───────────────────────────────────────────────────────────────────

def test_stock_calendar_matches_the_official_index_calendar(data, index_closes):
    stock_dates = set(data['dates'])
    index_dates = set(index_closes['Nifty 500'])
    start = min(map(day, index_dates))
    # the two feeds can differ by the very latest day (published at slightly different times), nothing else
    cutoff = min(max(map(day, stock_dates)), max(map(day, index_dates)))
    only_stocks = sorted((d for d in stock_dates - index_dates if start <= day(d) <= cutoff), key=day)
    only_index = sorted((d for d in index_dates - stock_dates if day(d) <= cutoff), key=day)
    assert not only_stocks, f'trading days in the stock data but not in NSE\'s index file: {only_stocks[:10]}'
    assert not only_index, f'trading days NSE published an index close for but the stock data lacks: {only_index[:10]}'


def test_dates_are_weekdays_with_no_long_gaps(data):
    ds = [day(d) for d in data['dates']]
    assert ds == sorted(ds) and len(set(ds)) == len(ds), 'dates are not strictly increasing'
    assert not [d for d in data['dates'] if day(d).weekday() >= 5], 'weekend dates present'
    gaps = [(data['dates'][i], data['dates'][i + 1]) for i in range(len(ds) - 1) if (ds[i + 1] - ds[i]).days > 5]
    assert not gaps, f'gaps of more than 5 calendar days (a missing week?): {gaps}'


def test_data_is_current_with_the_index_feed(data, index_closes):
    latest_index = max(index_closes['Nifty 500'], key=day)
    assert latest_index in data['dates'][-2:], (
        f'newest index close is {latest_index} but the stock data ends {data["latestDate"]}: one feed is behind')
    assert data['latestDate'] == data['dates'][-1]


# ─── per-stock price rows ───────────────────────────────────────────────────────

def test_ohlc_rows_are_valid(data):
    bad, total = [], 0
    for isin, days, ci in rows(data):
        for r in days:
            total += 1
            o, h, l, c = r[ci['open']], r[ci['high']], r[ci['low']], r[ci['close']]
            if min(o, h, l, c) <= 0 or l > min(o, c) + 1e-6 or h < max(o, c) - 1e-6:
                bad.append((isin, r[0], o, h, l, c))
    assert total > 500_000, f'only {total} price rows'
    assert len(bad) <= 10, f'{len(bad)} rows violate low <= open,close <= high / positive prices, e.g. {bad[:5]}'


def test_prev_close_chain_is_consistent(data):
    """Each row's `prev` should equal the stock's previous row's close, except where the stock did not trade the
    day before (suspension) or a corporate-action adjustment shifted history: measured at ~0.3% of rows."""
    mism, total = 0, 0
    for isin, days, ci in rows(data):
        for a, b in zip(days, days[1:]):
            total += 1
            if a[ci['close']] and abs(b[ci['prev']] - a[ci['close']]) / a[ci['close']] > 0.005:
                mism += 1
    assert mism / total < 0.01, f'{mism} of {total} rows ({mism / total:.2%}) have prev != previous close'


def test_no_unexplained_price_cliffs(data):
    """After split / bonus adjustment a >40% one-day close-to-close move is very rare (listing-day repricing,
    demergers, genuine circuit moves): 5 in 1.09M rows measured. A jump in this count usually means an
    unadjusted split or a bad price."""
    cliffs = []
    for isin, days, ci in rows(data):
        for a, b in zip(days, days[1:]):
            if a[ci['close']] and abs(b[ci['close']] / a[ci['close']] - 1) > 0.40:
                cliffs.append((isin, b[0], round((b[ci['close']] / a[ci['close']] - 1) * 100)))
    assert len(cliffs) <= 20, f'{len(cliffs)} one-day moves over 40% (unadjusted corporate actions?): {cliffs[:10]}'


# ─── independent cross-checks against NSE's index data ──────────────────────────

def test_equal_weight_index_tracks_the_official_midsmallcap_400(data, index_closes):
    ew = data['ewIndex']
    ci = {c: i for i, c in enumerate(ew['cols'])}
    ew_closes = {b[ci['date']]: b[ci['close']] for b in ew['bars']}
    n, r, gap = correlation(returns(ew_closes), returns(index_closes['Nifty MidSmallcap 400']))
    assert n > 400, f'only {n} overlapping days'
    assert r > 0.95, f'EW index vs official Nifty MidSmallcap 400 daily-return correlation {r:.3f} (expected ~0.98)'
    assert gap < 0.004, f'mean daily return gap {gap:.3%} vs the official index (expected ~0.16%)'


def test_market_breadth_tracks_the_nifty_500(data, index_closes):
    adv, tot = {}, {}
    for isin, days, ci in rows(data):
        for r in days:
            if r[ci['prev']] > 0:
                tot[r[0]] = tot.get(r[0], 0) + 1
                adv[r[0]] = adv.get(r[0], 0) + (r[ci['close']] > r[ci['prev']])
    share = {d: adv[d] / tot[d] for d in tot if tot[d] > 500}  # drop the first, near-empty history days
    n, r, _ = correlation(share, returns(index_closes['Nifty 500']))
    assert n > 400, f'only {n} overlapping days'
    assert r > 0.75, f'share of stocks advancing vs Nifty 500 daily return: correlation {r:.3f} (expected ~0.84)'


# ─── snapshot and reference-data coverage ───────────────────────────────────────

def test_latest_snapshot_agrees_with_the_daily_history(data):
    daily_by_isin = data['dailyBySymbol']
    ci = {c: i for i, c in enumerate(data['dailyCols'])}
    mismatched = []
    for isin, snap in data['latestBySymbol'].items():
        days = daily_by_isin.get(isin)
        if not days:
            mismatched.append((isin, 'no daily rows'))
            continue
        if days[-1][0] != snap['date'] or abs(days[-1][ci['close']] - snap['close']) > 1e-6:
            mismatched.append((isin, snap['date'], days[-1][0]))
    assert not mismatched, f'{len(mismatched)} stocks whose latest snapshot disagrees with their last daily row: {mismatched[:5]}'
    assert all(s['date'] == data['latestDate'] for s in data['latestBySymbol'].values()), \
        'latestBySymbol includes stocks that did not trade on the latest day'


def test_reference_data_coverage(data):
    snaps = list(data['latestBySymbol'].values())
    n = len(snaps)
    sector = sum(1 for s in snaps if s.get('sector')) / n
    mcap = sum(1 for s in snaps if s.get('marketCap')) / n
    band = sum(1 for s in snaps if s.get('upperBand')) / n
    assert sector > 0.95, f'only {sector:.1%} of stocks have a sector (run src/build_screener_classification.py)'
    assert mcap > 0.95, f'only {mcap:.1%} of stocks have a market cap'
    assert band > 0.80, f'only {band:.1%} of stocks have a price band'


def test_midsmallcap_constituents_are_all_in_the_equal_weight_index(data):
    if not os.path.exists(CONSTITUENTS_PATH):
        pytest.skip('no MidSmallcap 400 constituent file')
    with open(CONSTITUENTS_PATH, newline='', encoding='utf-8-sig') as f:
        listed = [r['SYMBOL'] for r in csv.DictReader(f) if r['SYMBOL']]
    assert 350 < len(listed) < 450, f'{len(listed)} constituents listed'
    ew = data['ewIndex']
    assert ew['constituentCount'] >= 0.95 * len(listed), (
        f'EW index built from {ew["constituentCount"]} of {len(listed)} constituents (expected ~397 of 400)')
    missing = [i for i in ew['isins'] if i not in data['dailyBySymbol']]
    assert not missing, f'EW index ISINs with no price history: {missing[:5]}'

"""Smoke tests that validate our stock prices against TradingView.

TradingView is an independent source for adjusted daily closes, so it is the strongest check that the whole chain
(NSE bhavcopy -> corporate-action archive -> price adjustments -> processed data) produces correct prices.

PREREQUISITE for the live test: TradingView Desktop running with remote debugging on and a chart open, e.g.
    TradingView.exe --remote-debugging-port=9222        (the same setup the dashboard's Data Quality tab uses)
Without it the live test SKIPS (it never fails just because TradingView is closed). Settings:
    NSE_TV_PORT=9222          debug port (default: tv_adjust.DEFAULT_CDP_PORT)
    NSE_TV_SAMPLE=40          how many of the most-traded stocks to compare (default 40, ~1 minute);
                              NSE_TV_SAMPLE=all compares every stock (~45 minutes, like the Data Quality tab's full run)

Both tests are read-only: the live test uses the same comparison as the dashboard's "verify against TradingView" run
(nse_server._verify_stock / tv_adjust.compare_series) but saves nothing, and the TradingView chart's symbol and
resolution are restored afterwards. Run with:
    pytest -m tradingview tests/test_tradingview_smoke.py        # live comparison (needs TradingView)
    pytest -m slow tests/test_tradingview_smoke.py               # also checks the last saved full run
"""
import math
import os

import pytest

import nse_server as ns
import realdata as rd
import tv_adjust

pytestmark = pytest.mark.slow


def test_last_full_tradingview_verification_run_is_clean():
    """The Data Quality tab's "verify every stock against TradingView" run saves its results; this checks they are
    complete and good. Skips (with the reason) if there is no such run, or it was made on older data than is now
    on disk - re-run it from the Data Quality tab after rebuilding the data."""
    rd.require_real_data(rd.PROCESSED_PATH)
    run = ns.load_full_verification(rd.REPO_ROOT)
    if not run:
        pytest.skip('No saved full TradingView verification run - run "Verify all stocks" in the Data Quality tab.')
    meta = run['meta']
    if not meta.get('complete'):
        pytest.skip('The last full TradingView verification run did not finish - resume or re-run it.')
    if meta.get('dataStamp') != ns.processed_data_stamp(rd.REPO_ROOT):
        pytest.skip(f'The last full TradingView run (data of {meta.get("dataDate")}) predates the current processed '
                    f'data - re-run "Verify all stocks" in the Data Quality tab for a result that applies.')

    stocks = run['stocks']
    counts = ns._count_statuses(stocks)
    n = sum(counts.values())
    assert n == meta.get('universe') == meta.get('verified'), 'verification run does not cover every stock'
    conclusive = counts['match'] + counts['minor'] + counts['major']
    assert conclusive / n > 0.9, f'only {conclusive} of {n} stocks could be compared with TradingView: {counts}'
    major = sorted(r['symbol'] for r in stocks.values() if r['status'] == 'major')
    assert len(major) <= math.ceil(0.01 * n), f'{len(major)} stocks differ MAJORLY from TradingView: {major[:20]}'
    assert counts['match'] / conclusive > 0.97, f'only {counts["match"] / conclusive:.1%} of compared stocks match: {counts}'


@pytest.mark.tradingview
def test_prices_match_tradingview_for_the_most_traded_stocks():
    rd.require_real_data(rd.PROCESSED_PATH)
    port = int(os.environ.get('NSE_TV_PORT', tv_adjust.DEFAULT_CDP_PORT))
    sample = os.environ.get('NSE_TV_SAMPLE', '40')

    _, universe = ns.collect_verify_universe(rd.processed())     # most-traded first
    scope = universe if sample.lower() == 'all' else universe[:int(sample)]

    chart = tv_adjust.TradingViewChart(port)
    try:
        chart.__enter__()
    except tv_adjust.TradingViewError as e:
        pytest.skip(f'TradingView is not available on port {port} ({e}) - start it with --remote-debugging-port={port}')
    results = {}
    try:
        for s in scope:
            results[s['symbol']] = ns._verify_stock(chart, s['symbol'], dict(zip(s['dates'], s['closes'])), s['events'])
    finally:
        chart.__exit__(None, None, None)

    by_status = {}
    for sym, r in results.items():
        by_status.setdefault(r['status'], []).append(sym)
    n = len(results)
    conclusive = n - len(by_status.get('inconclusive', []))
    detail = lambda syms: [(s, results[s].get('note'), results[s].get('maxDevPct')) for s in syms[:10]]

    assert conclusive / n > 0.8, (f'TradingView could not provide {n - conclusive} of {n} stocks: '
                                  f'{detail(by_status.get("inconclusive", []))}')
    allowed_major = max(1, math.ceil(0.01 * n))
    assert len(by_status.get('major', [])) <= allowed_major, (
        f'{len(by_status["major"])} of {n} stocks differ MAJORLY from TradingView: {detail(by_status["major"])}')
    matched = len(by_status.get('match', []))
    assert matched / conclusive > 0.95, (f'only {matched} of {conclusive} compared stocks match TradingView; '
                                         f'flagged: {detail(by_status.get("minor", []) + by_status.get("major", []))}')

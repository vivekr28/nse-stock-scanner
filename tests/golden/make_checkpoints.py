"""Generate tests/golden/data_checkpoints.json from the REAL data currently on this machine.

Run this only when the data is known to be good (e.g. right after a clean download plus a TradingView
verification), and only to (re)choose WHICH checkpoints are pinned - the values pinned are history that never
changes (raw closes, index closes, row totals up to a frozen cut-off date, and the price ratio across a
corporate action), so the file does not need regenerating as new trading days arrive:

    python tests/golden/make_checkpoints.py            # writes tests/golden/data_checkpoints.json
    python tests/golden/make_checkpoints.py --cutoff 30-Sep-2026

After losing NSE_DATA and rebuilding it, `pytest -m slow tests/test_data_inventory_smoke.py` compares the
rebuilt data against this file.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.dirname(HERE), os.path.join(os.path.dirname(os.path.dirname(HERE)), 'src')]

import realdata as rd  # noqa: E402  (needs the sys.path entries above)

# Large, liquid companies listed for the whole price history, so a missing value means a data gap, not a listing date.
STOCKS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'ITC', 'LT', 'BHARTIARTL', 'HINDUNILVR',
          'KOTAKBANK', 'AXISBANK', 'MARUTI', 'SUNPHARMA', 'TITAN', 'BAJFINANCE', 'ASIANPAINT', 'NTPC',
          'ULTRACEMCO', 'POWERGRID']
INDEXES = ['Nifty 50', 'Nifty 500', 'Nifty Bank', 'Nifty IT', 'Nifty Pharma', 'Nifty Auto', 'Nifty FMCG',
           'Nifty Midcap 150', 'Nifty Smallcap 250', 'Nifty MidSmallcap 400', 'India VIX', 'Nifty Metal']
N_EVENTS = 16


def spread(items, n):
    """n items evenly spread across a list, always including the first and the last."""
    if len(items) <= n:
        return list(items)
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cutoff', default=None, help='frozen cut-off date dd-Mon-yyyy (default: the latest trading day)')
    args = ap.parse_args()

    data = rd.processed()
    cutoff = args.cutoff or data['dates'][-1]
    dates = [d for d in data['dates'] if rd.day(d) <= rd.day(cutoff)]
    cutoff = dates[-1]

    # Bhavcopy checkpoint dates: spread over the history; index dates likewise but only where the index file has data.
    sel_dates = spread(dates, 8)
    index_dates = spread([d for d in dates if d in rd.raw_index_counts()], 8)

    # Pin only events whose ex-date has both neighbouring bars in the price history.
    adjusted = sorted((a for a in data['adjustedCorpActions'] if rd.day(a['exDate']) <= rd.day(cutoff)),
                      key=lambda a: (rd.day(a['exDate']), a['isin']))
    events = []
    for a in adjusted:
        if rd.adjusted_ratio(data, a['isin'], a['exDate']) is not None:
            events.append([a['isin'], a['exDate']])
    events = spread(events, N_EVENTS)

    g = {'cutoff': cutoff, 'stocks': STOCKS, 'dates': sel_dates, 'indexes': INDEXES, 'indexDates': index_dates, 'events': events}
    # golden() is cached and reads the file; hand measure() the selection directly through a temp swap
    rd.golden.cache_clear()
    rd.bhav_scan.cache_clear()
    rd.index_scan.cache_clear()
    os.makedirs(HERE, exist_ok=True)
    with open(rd.GOLDEN_PATH, 'w', encoding='utf-8') as f:
        json.dump(g, f)          # selection only, so measure() can scan for it
    rd.golden.cache_clear()
    m = rd.measure(g)

    missing = [k for section in ('stockCloses', 'indexCloses', 'adjustmentRatios') for k, v in m[section].items() if v is None]
    if missing:
        sys.exit(f'Cannot pin these checkpoints (no data): {missing[:10]} - adjust the selection lists and re-run.')

    out = {**g, 'expected': {**{k: v for k, v in m.items() if k not in ('stockCloses', 'indexCloses', 'adjustmentRatios')},
                             'stockCloses': m['stockCloses'], 'indexCloses': m['indexCloses'],
                             'adjustmentRatios': {k: round(v, 6) for k, v in m['adjustmentRatios'].items()}}}
    with open(rd.GOLDEN_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1)
    print(f'Wrote {rd.GOLDEN_PATH}: cutoff {cutoff}, {len(STOCKS)} stocks x {len(sel_dates)} dates, '
          f'{len(INDEXES)} indexes x {len(index_dates)} dates, {len(events)} adjustment ratios, '
          f'{m["bhavcopyRows"]} bhavcopy rows / {m["tradingDays"]} trading days / {m["priceBandRows"]} band rows / '
          f'{m["indexRows"]} index rows up to the cut-off.')


if __name__ == '__main__':
    main()

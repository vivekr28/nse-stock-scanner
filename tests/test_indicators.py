"""The per-stock indicators process_data() computes (the numbers the scanner, screener and breadth tabs are built on):
20 SMA, 52-week high/low, ADR, change %, monthly change %, distance from the 52-week high/low and from the SMA,
and above-SMA. Until now only the JavaScript copy of this maths (js/data-processor.js) was tested; this is the
server-side original the dashboard actually uses.

Each expected number is worked out independently of the code from the definitions below, using simple fixtures:

  INDI  - 60 days, close = 100 + i (100..159), high = close + 2, low = close - 1, prev = previous close.
          last day: close 159, prev 158, high 161, low 158.
            sma20      = mean(closes 140..159)                          = 149.5
            52w high   = max(high)  = 161 (all 60 days are inside the window);  52w low = min(low) = 99
            adr        = mean over the last 20 days of (high-low)/close*100 = mean(300/close)         = 2.01
            changePct  = (159-158)/158*100                                                     = 0.63
            monthly    = (159 - close 22 sessions back [days[-22] = 138]) / 138 * 100        = 15.22
            dist52H    = (161-159)/161*100 = 1.24      dist52L = (159-99)/99*100            = 60.61
            distSMA    = (159-149.5)/149.5*100                                              = 6.35
"""
from datetime import date

import pytest

import nse_server as ns
from conftest import business_days, bhav_row


def stock_rows(symbol, isin, closes, highs=None, lows=None, prevs=None, start=date(2025, 6, 2), opens=None):
    """Bhavcopy rows for one stock over len(closes) weekdays; highs/lows default to close+2 / close-1."""
    days = business_days(start, len(closes))
    rows = []
    for i, d in enumerate(days):
        c = closes[i]
        prev = (prevs[i] if prevs else (closes[i - 1] if i else closes[0]))
        row = bhav_row(symbol, 'EQ', d, c, isin, prev=prev)
        row['HIGH_PRICE'] = highs[i] if highs else c + 2
        row['LOW_PRICE'] = lows[i] if lows else c - 1
        if opens:
            row['OPEN_PRICE'] = opens[i]
        rows.append(row)
    return rows


def run(project, *stock_row_lists):
    project.write_bhavcopy([r for rows in stock_row_lists for r in rows])
    out = ns.process_data(project.base_dir)
    assert out is not None
    return out['latestBySymbol']


def by_symbol(latest):
    return {v['symbol']: v for v in latest.values()}


# ─── the main fixture, every indicator ──────────────────────────────────────────

def test_every_indicator_matches_the_hand_worked_values(project):
    indi = by_symbol(run(project, stock_rows('INDI', 'INE000A01011', [100 + i for i in range(60)])))['INDI']
    assert indi['sma20'] == 149.5
    assert indi['high52w'] == 161
    assert indi['low52w'] == 99
    assert indi['adr'] == 2.01
    assert indi['changePct'] == 0.63
    assert indi['monthlyChangePct'] == 15.22
    assert indi['distFrom52H'] == 1.24
    assert indi['distFrom52L'] == 60.61
    assert indi['distFromSMA'] == 6.35
    assert indi['aboveSMA'] is True
    assert indi['tradingDays'] == 60
    assert indi['close'] == 159


# ─── history shorter than the windows ───────────────────────────────────────────

def test_under_20_days_has_no_sma_and_is_not_above_it(project):
    closes = [50 + i for i in range(10)]
    s = by_symbol(run(project, stock_rows('SHORT', 'INE000B01011', closes, highs=[c + 1 for c in closes], lows=[c - 1 for c in closes])))['SHORT']
    assert s['sma20'] is None and s['distFromSMA'] is None
    assert s['aboveSMA'] is False
    # ADR averages whatever days exist (10): mean(2/close*100) = 3.68
    assert s['adr'] == 3.68
    # 52-week range is over all available days
    assert (s['high52w'], s['low52w']) == (60, 49)
    # fewer than 22 sessions: the monthly change is measured from the first day (50 -> 59)
    assert s['monthlyChangePct'] == 18.0


def test_exactly_20_days_gives_an_sma_and_21_still_has_no_22_session_reference(project):
    s20 = by_symbol(run(project, stock_rows('TWENTY', 'INE000C01011', [100 + i for i in range(20)])))['TWENTY']
    assert s20['sma20'] == 109.5          # mean(100..119)
    s21 = by_symbol(run(project, stock_rows('TWENTYONE', 'INE000D01011', [100 + i for i in range(21)])))['TWENTYONE']
    assert s21['monthlyChangePct'] == round((120 - 100) / 100 * 100, 2)   # still measured from day 1 (21 < 22 days)
    s22 = by_symbol(run(project, stock_rows('TWENTYTWO', 'INE000E01011', [100 + i for i in range(22)])))['TWENTYTWO']
    assert s22['monthlyChangePct'] == round((121 - 100) / 100 * 100, 2)   # days[-22] is now day 1 (exactly 22 days)
    s23 = by_symbol(run(project, stock_rows('TWENTYTHREE', 'INE000F01011', [100 + i for i in range(23)])))['TWENTYTHREE']
    assert s23['monthlyChangePct'] == round((122 - 101) / 101 * 100, 2)   # days[-22] is day 2


# ─── the 52-week window is exactly the last 250 trading days ────────────────────

def test_52_week_window_is_the_last_250_days(project):
    n = 300
    closes = [100] * n
    highs = [102] * n
    lows = [99] * n
    highs[49] = 1000   # day 50: just outside the last 250 days (days 51..300) -> must be ignored
    highs[50] = 500    # day 51: the oldest day inside the window -> must count
    lows[49] = 1       # outside
    lows[50] = 40      # inside
    s = by_symbol(run(project, stock_rows('LONGCO', 'INE000G01011', closes, highs=highs, lows=lows)))['LONGCO']
    assert s['high52w'] == 500
    assert s['low52w'] == 40
    assert s['tradingDays'] == n


# ─── comparisons and edge cases ─────────────────────────────────────────────────

def test_above_sma_is_strict(project):
    flat = by_symbol(run(project, stock_rows('FLATCO', 'INE000H01011', [100] * 30)))['FLATCO']
    assert flat['sma20'] == 100 and flat['aboveSMA'] is False and flat['distFromSMA'] == 0
    down = by_symbol(run(project, stock_rows('DOWNCO', 'INE000I01011', [200 - i for i in range(30)])))['DOWNCO']
    assert down['aboveSMA'] is False and down['distFromSMA'] < 0


def test_change_pct_is_zero_when_there_is_no_previous_close(project):
    closes = [100 + i for i in range(25)]
    prevs = [0] * 25
    s = by_symbol(run(project, stock_rows('NOPREV', 'INE000J01011', closes, prevs=prevs)))['NOPREV']
    assert s['changePct'] == 0


def test_change_pct_uses_the_exchange_previous_close_not_the_previous_row(project):
    # e.g. a stock that was adjusted/suspended: NSE's own previous close differs from the prior row's close
    closes = [100 + i for i in range(25)]
    prevs = [100] + closes[:-1]
    prevs[-1] = 110.0                          # NSE says yesterday's close was 110; last close is 124
    s = by_symbol(run(project, stock_rows('NSEPREV', 'INE000K01011', closes, prevs=prevs)))['NSEPREV']
    assert s['changePct'] == round((124 - 110) / 110 * 100, 2)


def test_values_are_rounded_to_two_decimals(project):
    closes = [100 + i / 3 for i in range(30)]
    s = by_symbol(run(project, stock_rows('ROUNDCO', 'INE000L01011', closes)))['ROUNDCO']
    for k in ('sma20', 'high52w', 'low52w', 'adr', 'changePct', 'monthlyChangePct', 'distFrom52H', 'distFrom52L', 'distFromSMA'):
        assert s[k] == round(s[k], 2), k


def test_each_stock_is_computed_from_its_own_history(project):
    a = stock_rows('AAA', 'INE000M01011', [100 + i for i in range(40)])
    b = stock_rows('BBB', 'INE000N01011', [500 - i for i in range(40)])
    latest = by_symbol(run(project, a, b))
    assert latest['AAA']['aboveSMA'] is True and latest['BBB']['aboveSMA'] is False
    assert latest['AAA']['sma20'] == 129.5          # mean(120..139)
    assert latest['BBB']['sma20'] == 470.5          # 500-i for i in 20..39 = 480..461

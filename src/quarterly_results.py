"""Quarterly results for the Stock Scanner's "Quarterly Results" filters and the single-stock chart table.

Everything server-side about them lives here, so nse_server.py only has to route /api/quarterly-growth (the same way it
uses tv_adjust.py):
  * build_quarterly_growth(path)  - reference-data/QuarterlyResults.csv -> each stock's latest declared quarter against
                                    the same quarter a year earlier, plus the last 10 quarters for the chart table
  * payload(path)                 - that, wrapped as the JSON document the browser fetches
  * gzipped_payload(path)         - the same, gzipped and cached until the file's modification time changes

Read-only: it never touches process_data() or processed_data.json, so fetching new results (Download-NSE-Bhavcopy.ps1
-FetchResults) needs no reprocess and no server restart. Pure stdlib. See AGENT.md, "Quarterly results".
"""
import calendar
import csv
import gzip
import json
import os
import re
import threading
from datetime import datetime

RESULTS_FILE = 'QuarterlyResults.csv'   # in reference-data/; created on demand by Download-NSE-Bhavcopy.ps1 -FetchResults


def normalize_symbol(s):
    """Match JS normalizeSymbol (and nse_server.normalize_symbol, which a test pins this against): lowercase, & and - -> _."""
    if not s:
        return ''
    return re.sub(r'[&\-]', '_', s.strip().lower())


def parse_date_str(s):
    """DD-Mon-YYYY (what the results file always holds) and the other formats nse_server.parse_date_str accepts."""
    if not s:
        return None
    s = s.strip()
    for fmt in ('%d-%b-%Y', '%d-%B-%Y', '%Y-%m-%d', '%d/%m/%Y', '%d%b%Y'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _growth_pct(cur, prev):
    """(cur - prev) / prev as a percentage, rounded to 2 places - only when the year-ago figure is positive. Growth
    from a zero or negative base (a loss, or no sales) has no meaningful percentage, so it is None."""
    if cur is None or prev is None or prev <= 0:
        return None
    return round((cur - prev) / prev * 100, 2)


def _result_num(text):
    try:
        return float(text) if text not in (None, '') else None
    except ValueError:
        return None


# Some companies file a quarter with every figure at the wrong scale (e.g. PFC's Dec-2023 filing shows Rs 236 crore of
# revenue between quarters of ~Rs 22,000 crore and ~Rs 24,000 crore), which would give a 12,000% "growth". A real
# quarter is never a clean 100x / 1,000x / 100,000x / 10,000,000x of BOTH its neighbours, so that signature is flagged.
_SCALE_FACTORS = (100, 1000, 1e5, 1e7)


def _off_by_scale(v, n):
    if not v or not n or v <= 0 or n <= 0:
        return False
    r = v / n
    return any(0.75 / k <= r <= 1.33 / k or 0.75 * k <= r <= 1.33 * k for k in _SCALE_FACTORS)


def _shift_quarter(d, n):
    """The quarter-end n quarters after (negative: before) quarter-end date d."""
    months = d.year * 12 + d.month - 1 + 3 * n
    year, month = divmod(months, 12)
    return d.replace(year=year, month=month + 1, day=calendar.monthrange(year, month + 1)[1])


def _looks_mis_scaled(sales_by_date, d):
    """True when the sales for quarter-end d is a clean power-of-100 multiple/fraction of BOTH adjacent quarters. Both
    neighbours are required: with one (the newest quarter has only the one before it) a genuinely lumpy company, e.g.
    an investment firm whose income drops from 107 to 1 crore, would be wrongly flagged (SUMMITSEC on the real file)."""
    v = sales_by_date.get(d)
    neighbours = [sales_by_date.get(_shift_quarter(d, -1)), sales_by_date.get(_shift_quarter(d, 1))]
    return bool(v and v > 0 and all(n is not None and n > 0 for n in neighbours)
                and all(_off_by_scale(v, n) for n in neighbours))


def build_quarterly_growth(path):
    """Latest-quarter growth versus the same quarter a year earlier, per stock, for the Stock Scanner's "Quarterly
    Results" filters (read-only; nothing else uses it). `path` is reference-data/QuarterlyResults.csv (written by
    Download-NSE-Bhavcopy.ps1 -FetchResults).

    Returns {normalized_symbol: {q, b, cmp, s, sp, e, ep, sg, eg, st, et, h}}, keyed by SYMBOL (normalize_symbol, like the band
    history) and NOT by ISIN: a stock's ISIN changes at a split/bonus, so results filed before that carry an older ISIN
    than the stock has today, and joining on ISIN would silently drop ~450 stocks (verified on the real file).
      q   the stock's latest declared quarter-end (YYYY-MM-DD) - per stock, not a global date
      b   'C' consolidated / 'S' standalone (the basis of that latest result)
      cmp 'ok' when the year-ago quarter can be compared like for like; otherwise why not: 'no-prev' (no result for
          the same quarter a year earlier), 'basis' (one year consolidated, the other standalone - not comparable),
          'blank' (a result is on file but NSE's filing gave no numbers), 'scale' (this quarter's or the year-ago
          quarter's figures look mis-scaled in the company's filing - see _looks_mis_scaled)
      s/sp  sales (Rs crore) this quarter / a year ago;  e/ep  net profit (Rs crore) this quarter / a year ago
      sg/eg sales / net-profit growth %, None unless cmp is 'ok' AND the year-ago figure is positive
      st/et turnaround flags (kept apart from growth, which needs a positive base), only ever True when cmp is 'ok':
            et = profit this quarter after a LOSS in the same quarter a year ago (year-ago below zero, now above);
            st = sales this quarter after NO sales a year ago (year-ago zero, now above - sales cannot be negative)
      h     the last 10 quarters (oldest first) each against its own year-ago quarter, for the stock chart's table:
            [[quarter-end, sales Rs cr, sales growth %, EPS, EPS growth %, cmp, EPS turnaround 1/0], ...]; EPS is as filed;
            a quarter with no result on file is [d, None, None, None, None, 'none', 0]
    Sales is revenue from operations (total income for banks); profit is the owners' share where reported."""
    if not os.path.exists(path):
        return {}
    by_symbol = {}
    with open(path, 'r', encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            sym = normalize_symbol(r.get('SYMBOL') or '')
            d = parse_date_str(r.get('TO_DATE') or '')
            if not sym or not d:
                continue
            by_symbol.setdefault(sym, {})[d.date()] = r
    out = {}
    for sym, quarters in by_symbol.items():
        sales_by_date = {d: _result_num(r.get('REVENUE_CR')) for d, r in quarters.items()}
        latest = max(quarters)
        rec = _compare_quarter(quarters, sales_by_date, latest)
        rec['q'] = latest.isoformat()
        rec['b'] = 'C' if quarters[latest].get('BASIS') == 'Consolidated' else 'S'
        # The last 10 calendar quarters ending at the latest one (oldest first), each against its own year-ago quarter - the
        # stock chart's table: [quarter-end, sales Rs cr, sales growth %, EPS, EPS growth %, cmp, EPS turnaround 1/0].
        # A quarter with no result on file is [quarter-end, None, None, None, None, 'none', 0]. EPS is as filed (NOT restated
        # for later splits/bonuses; the browser flags those), so its growth is None unless the year-ago EPS is positive.
        hist = []
        for n in range(-9, 1):
            d = _shift_quarter(latest, n)
            row = quarters.get(d)
            if row is None:
                hist.append([d.isoformat(), None, None, None, None, 'none', 0])
                continue
            c = _compare_quarter(quarters, sales_by_date, d)
            eps = _result_num(row.get('EPS_BASIC'))
            prev = quarters.get(_shift_quarter(d, -4))
            eps_growth, eps_turnaround = None, 0
            if prev is not None and prev.get('BASIS') == row.get('BASIS') and eps is not None:
                prev_eps = _result_num(prev.get('EPS_BASIC'))
                if prev_eps is not None:
                    eps_growth = _growth_pct(eps, prev_eps)
                    eps_turnaround = int(prev_eps < 0 and eps > 0)
            # a quarter whose own figures look mis-scaled shows no sales (its EPS is per share and is unaffected)
            sales = None if _looks_mis_scaled(sales_by_date, d) or c['s'] is None else round(c['s'], 1)
            hist.append([d.isoformat(), sales, c['sg'], eps, eps_growth, c['cmp'], eps_turnaround])
        rec['h'] = hist
        out[sym] = rec
    return out


def _compare_quarter(quarters, sales_by_date, d):
    """One quarter (quarter-end date d, which must be in `quarters`) against the same quarter a year earlier: the
    {cmp, s, sp, e, ep, sg, eg, st, et} part of build_quarterly_growth's record."""
    cur = quarters[d]
    year_ago = _shift_quarter(d, -4)
    prev = quarters.get(year_ago)
    s, e = _result_num(cur.get('REVENUE_CR')), _result_num(cur.get('NET_PROFIT_CR'))
    rec = {'cmp': 'ok', 's': s, 'sp': None, 'e': e, 'ep': None, 'sg': None, 'eg': None, 'st': False, 'et': False}
    if prev is None:
        rec['cmp'] = 'no-prev'
        return rec
    rec['sp'], rec['ep'] = _result_num(prev.get('REVENUE_CR')), _result_num(prev.get('NET_PROFIT_CR'))
    if prev.get('BASIS') != cur.get('BASIS'):
        rec['cmp'] = 'basis'
    elif s is None or e is None or rec['sp'] is None or rec['ep'] is None:
        rec['cmp'] = 'blank'
    elif _looks_mis_scaled(sales_by_date, d) or _looks_mis_scaled(sales_by_date, year_ago):
        rec['cmp'] = 'scale'
    else:
        rec['sg'], rec['eg'] = _growth_pct(s, rec['sp']), _growth_pct(e, rec['ep'])
        rec['st'] = rec['sp'] <= 0 and s > 0
        rec['et'] = rec['ep'] < 0 and e > 0
    return rec


# ── the JSON document, and its cache ────────────────────────────────────────────────────────────────────────────────

def payload(path):
    """{'bySymbol': build_quarterly_growth(path), 'latestQuarter': newest quarter-end on file or None}."""
    by_symbol = build_quarterly_growth(path)
    latest = max((r['q'] for r in by_symbol.values()), default=None)
    return {'bySymbol': by_symbol, 'latestQuarter': latest}


_lock = threading.Lock()
_cache = {}  # 'v' -> (results file mtime, gzipped JSON)


def clear_cache():
    with _lock:
        _cache.clear()


def gzipped_payload(path):
    """The gzipped JSON body for /api/quarterly-growth, rebuilt only when the file's modification time changes.
    Raises FileNotFoundError when the results file does not exist yet."""
    try:
        stamp = os.path.getmtime(path)
    except OSError:
        raise FileNotFoundError(path)
    with _lock:
        cached = _cache.get('v')
        if cached is None or cached[0] != stamp:
            body = json.dumps(payload(path), separators=(',', ':')).encode('utf-8')
            cached = _cache['v'] = (stamp, gzip.compress(body, 5))
    return cached[1]

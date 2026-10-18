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


def _view(row, prefix=''):
    return {'s': _result_num(row.get(prefix + 'REVENUE_CR')), 'e': _result_num(row.get(prefix + 'NET_PROFIT_CR')),
            'eps': _result_num(row.get(prefix + 'EPS_BASIC'))}


def _views(row):
    """{basis: figures} a stored row holds: its own BASIS, plus the ALT_BASIS ones (the other basis, filled by
    Download-NSE-Bhavcopy.ps1 only where a quarter and its year-ago quarter are on different bases)."""
    out = {row.get('BASIS'): _view(row)}
    alt = row.get('ALT_BASIS')
    if alt and alt != row.get('BASIS'):
        out[alt] = _view(row, 'ALT_')
    return out


def _common_basis(cur, prev):
    """(basis, this quarter's figures, year-ago figures) for a basis both rows hold with sales and profit, preferring
    consolidated; None when there is none."""
    cv, pv = _views(cur), _views(prev)
    for basis in ('Consolidated', 'Standalone'):
        a, b = cv.get(basis), pv.get(basis)
        if a and b and None not in (a['s'], a['e'], b['s'], b['e']):
            return basis, a, b
    return None


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
          the same quarter a year earlier), 'basis' (one year consolidated, the other standalone and no basis on file
          for BOTH - not comparable),
          'blank' (a result is on file but NSE's filing gave no numbers), 'scale' (this quarter's or the year-ago
          quarter's figures look mis-scaled in the company's filing - see _looks_mis_scaled)
      ab    only present when the quarter and its year-ago quarter are stored on different bases but the file also holds
            the OTHER basis (the ALT_* columns, read by Download-NSE-Bhavcopy.ps1): 'S' or 'C', the basis the comparison
            was made on (preferring consolidated). The browser marks such figures; everything below is then on that basis
      qe/qs net-profit / sales growth % against the PREVIOUS quarter (not the year-ago one), on a basis both quarters hold; None when the
            previous quarter's profit / sales is not positive. Only present when the previous quarter is on file
      qp    [previous profit, previous sales, profit now, sales now] (Rs crore, 2 dp) of that same sequential comparison, or None when the two
            quarters share no basis; qet / qst turnaround flags: qet = a LOSS in the previous quarter and a profit now, qst = NO sales in the
            previous quarter and some now (kept apart from qe / qs, which need a positive base). Present together with qe / qs
      s/sp  sales (Rs crore) this quarter / a year ago;  e/ep  net profit (Rs crore) this quarter / a year ago
      sg/eg sales / net-profit growth %, None unless cmp is 'ok' AND the year-ago figure is positive
      st/et turnaround flags (kept apart from growth, which needs a positive base), only ever True when cmp is 'ok':
            et = profit this quarter after a LOSS in the same quarter a year ago (year-ago below zero, now above);
            st = sales this quarter after NO sales a year ago (year-ago zero, now above - sales cannot be negative)
      h     the last 10 quarters (oldest first) each against its own year-ago quarter, for the stock chart's table:
            [[quarter-end, sales Rs cr, sales growth %, EPS, EPS growth %, cmp, EPS turnaround 1/0], ...]; EPS is as filed
            (sales and EPS shown are the quarter's STORED figures; when a quarter was compared on the other basis the row has
            three more items, [..., 'S'|'C', sales this quarter, sales a year ago] on that basis, and the two growth figures
            are on that basis too);
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
        # growth against the previous quarter (a sequential step, for the scanner's QoQ Earnings / QoQ Sales filters)
        prev_q = quarters.get(_shift_quarter(latest, -1))
        if prev_q is not None:
            seq = _common_basis(quarters[latest], prev_q)
            rec['qe'] = _growth_pct(seq[1]['e'], seq[2]['e']) if seq else None
            rec['qs'] = _growth_pct(seq[1]['s'], seq[2]['s']) if seq else None
            if seq:
                now, then = seq[1], seq[2]
                rec['qp'] = [round(then['e'], 2), round(then['s'], 2), round(now['e'], 2), round(now['s'], 2)]
                rec['qet'] = then['e'] < 0 and now['e'] > 0
                rec['qst'] = then['s'] <= 0 and now['s'] > 0
            else:
                rec['qp'], rec['qet'], rec['qst'] = None, False, False
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
            elif prev is not None and c.get('ab'):
                # different stored bases, compared on the one both hold: the EPS growth is on that basis too
                basis = 'Consolidated' if c['ab'] == 'C' else 'Standalone'
                cur_eps, prev_eps = _views(row)[basis]['eps'], _views(prev)[basis]['eps']
                if cur_eps is not None and prev_eps is not None:
                    eps_growth = _growth_pct(cur_eps, prev_eps)
                    eps_turnaround = int(prev_eps < 0 and cur_eps > 0)
            # a quarter whose own figures look mis-scaled shows no sales (its EPS is per share and is unaffected)
            shown = _result_num(row.get('REVENUE_CR'))       # the stored figure, whatever basis the comparison used
            sales = None if _looks_mis_scaled(sales_by_date, d) or shown is None else round(shown, 1)
            entry = [d.isoformat(), sales, c['sg'], eps, eps_growth, c['cmp'], eps_turnaround]
            if c.get('ab'):
                entry += [c['ab'], round(c['s'], 1), round(c['sp'], 1)]
            hist.append(entry)
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
        common = _common_basis(cur, prev)
        if common is None:
            rec['cmp'] = 'basis'
        else:
            # compared on a basis both quarters hold. The mis-scaled-filing guard is not applied here (it reads the stored
            # sales series); a filing that is off by a clean power of 100 on the other basis only is not caught
            basis, a, b = common
            rec['ab'] = 'C' if basis == 'Consolidated' else 'S'
            rec['s'], rec['sp'], rec['e'], rec['ep'] = a['s'], b['s'], a['e'], b['e']
            rec['sg'], rec['eg'] = _growth_pct(a['s'], b['s']), _growth_pct(a['e'], b['e'])
            rec['st'] = b['s'] <= 0 and a['s'] > 0
            rec['et'] = b['e'] < 0 and a['e'] > 0
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

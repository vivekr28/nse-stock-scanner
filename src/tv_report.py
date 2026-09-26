"""
Report for a full "verify every stock against TradingView" run (Data Quality tab).

Pure functions, no I/O and no TradingView access: `build_report()` turns a finished (or partial) run
payload into a Markdown summary for reading and a CSV with one row per stock for analysis.

The payload is what nse_server.run_tv_verify_full() saves:
    {'meta': {...run info...}, 'calendar': {'tvOnly': [...], 'oursOnly': [...]},
     'stocks': {isin: {symbol, series, turnover, close, status, reason, bars, barsOff, maxDevPct,
                       endDevPct, worstDate, firstOff, lastOff, causes, causeDetails, note, events, ...}}}
"""

import csv
import io
from datetime import datetime
from statistics import median

# Result categories: match / minor / major come straight from tv_adjust.compare_series; an 'inconclusive'
# result is split by its reason so "TradingView doesn't have it" isn't mixed up with "too new to compare".
CATEGORY_LABELS = {
    'match': 'Match',
    'minor': 'Minor difference',
    'major': 'MAJOR difference',
    'not-found': 'Not on TradingView (symbol not found, or a different one opened)',
    'tv-error': 'TradingView error while loading (timeout etc.)',
    'few-bars': 'Too little shared history to compare (under 20 bars)',
    'predates': 'Adjustment predates the shared history (cannot be tested)',
    'other': 'Inconclusive (other)',
}
CATEGORY_ORDER = ('match', 'minor', 'major', 'not-found', 'tv-error', 'few-bars', 'predates', 'other')
_REASON_TO_CATEGORY = {'not-found': 'not-found', 'tv-error': 'tv-error', 'few-bars': 'few-bars',
                       'predates-history': 'predates'}

# Why a flagged stock differs, most actionable first (a stock with several causes is filed under the first).
CAUSE_LABELS = {
    'missing-event': 'TradingView adjusts for an action the dashboard has no event for',
    'adjustments-differ': "Our adjustment differs from TradingView's",
    'tv-no-adjustment': 'TradingView shows no adjustment for an event the dashboard applied',
    'unexplained': 'No level shift found - only isolated bars differ (possible bad data on particular days)',
}
_KIND_TO_CAUSE = {'tv-extra-adjustment': 'missing-event', 'adjustments-differ': 'adjustments-differ',
                  'tv-no-adjustment': 'tv-no-adjustment'}
CAUSE_ORDER = ('missing-event', 'adjustments-differ', 'tv-no-adjustment', 'unexplained')

MD_ROW_CAP = 100  # rows per table in the Markdown; the CSV always has every stock


def category(rec):
    st = rec.get('status')
    if st != 'inconclusive':
        return st if st in CATEGORY_LABELS else 'other'
    return _REASON_TO_CATEGORY.get(rec.get('reason'), 'other')


def primary_cause(rec):
    """Which CAUSE_LABELS key a flagged stock belongs to."""
    kinds = {d.get('kind') for d in rec.get('causeDetails') or []}
    for kind, cause in (('tv-extra-adjustment', 'missing-event'), ('adjustments-differ', 'adjustments-differ'),
                        ('tv-no-adjustment', 'tv-no-adjustment')):
        if kind in kinds:
            return cause
    return 'unexplained'


def _parse_date(s):
    try:
        return datetime.strptime((s or '').strip(), '%d-%b-%Y').date()
    except ValueError:
        return None


def corp_action_hints(isin, rec, corp_index):
    """Corporate-actions-archive rows that may explain a 'TradingView adjusts for an action the dashboard has no
    event for' difference: rows for the same stock (by ISIN or symbol) dated within 5 days of the date TradingView's
    level shifts. `corp_index` is {ISIN or SYMBOL: [(ex_date, 'DD-Mon-YYYY', subject)]}. A hit means the action IS in
    the feed but is not price-adjusted (a demerger or other non-ratio action, or one older than the Data Quality
    list's window); no hit means the feed doesn't carry it at all (e.g. a rights issue, which the downloader filters out)."""
    if not corp_index:
        return []
    rows = list(corp_index.get(isin) or []) + list(corp_index.get((rec.get('symbol') or '').upper()) or [])
    hints, seen = [], set()
    for det in rec.get('causeDetails') or []:
        if det.get('kind') != 'tv-extra-adjustment':
            continue
        d = _parse_date(det.get('date'))
        for ex, ex_str, subject in rows:
            if d and abs((ex - d).days) <= 5 and (ex_str, subject) not in seen:
                seen.add((ex_str, subject))
                hints.append(f'{ex_str}: {subject}')
    return hints


def _num(x, default=0.0):
    return x if isinstance(x, (int, float)) else default


def _pct(n, d):
    return f'{100.0 * n / d:.1f}%' if d else '-'


def _cell(text):
    return str(text if text is not None else '').replace('|', '/').replace('\r', ' ').replace('\n', ' ').strip()


def _signed(x):
    return f'{x:+.2f}' if isinstance(x, (int, float)) else '-'


def _adjustments_text(rec):
    ev = rec.get('events') or []
    return '; '.join(f'{d} x{f:.6g}' for d, f in ev)


def _table(headers, rows):
    lines = ['| ' + ' | '.join(headers) + ' |', '|' + '|'.join(' --- ' for _ in headers) + '|']
    lines += ['| ' + ' | '.join(_cell(c) for c in r) + ' |' for r in rows]
    return lines


def _by_importance(items):
    """[(isin, rec)] most liquid first - a difference in a heavily traded stock matters most."""
    return sorted(items, key=lambda x: (-_num(x[1].get('turnover')), x[1].get('symbol') or ''))


def _stock_rows(items, hints, cap=MD_ROW_CAP):
    rows = []
    for isin, r in items[:cap]:
        first, last = r.get('firstOff'), r.get('lastOff')
        detail = '; '.join(r.get('causes') or []) or r.get('note') or ''
        if hints.get(isin):
            detail += ' **In the NSE corporate-actions feed:** ' + ' / '.join(hints[isin])
        rows.append([
            r.get('symbol'), r.get('series') or '', f"{_num(r.get('turnover')):,.1f}", _signed(r.get('maxDevPct')),
            f"{r.get('barsOff', 0)}/{r.get('bars', 0)}", f'{first} -> {last}' if first else '-',
            _signed(r.get('endDevPct')), detail,
        ])
    return rows


_STOCK_HEADERS = ['Symbol', 'Series', 'Turnover (Cr)', 'Max dev %', 'Bars off/compared', 'Differs',
                  'Latest-bar dev %', 'Detail']


def _percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    return sorted_vals[min(len(sorted_vals) - 1, int(round(p * (len(sorted_vals) - 1))))]


def _delta_section(stocks, prev):
    """Lines describing what changed since the previous run (stocks present in both)."""
    pm = prev.get('meta') or {}
    pst = prev.get('stocks') or {}
    flagged = ('minor', 'major')
    rank = {'match': 0, 'minor': 1, 'major': 2}
    new_problems, resolved, worse, better, common, unseen = [], [], [], [], 0, 0
    gained, lost = [], []            # could not be compared before / now (or the other way round)
    for isin, r in stocks.items():
        p = pst.get(isin)
        if p is None:
            unseen += 1
            continue
        common += 1
        now, before = r.get('status'), p.get('status')
        if now == before:
            continue
        if now in flagged and before not in flagged:
            new_problems.append((isin, r, before))
        elif now == 'match' and before in flagged:
            resolved.append((isin, r, before))
        elif now in rank and before in rank:
            (worse if rank[now] > rank[before] else better).append((isin, r, before))
        elif now == 'match':                   # was not comparable before
            gained.append((isin, r, before))
        elif before in rank:                   # comparable before, not now
            lost.append((isin, r, before))

    def names(items, cap=40):
        s = ', '.join(f"{r.get('symbol')} ({b}->{r.get('status')})" for _i, r, b in
                      sorted(items, key=lambda x: -_num(x[1].get('turnover')))[:cap])
        return s + (f' ... (+{len(items) - cap} more)' if len(items) > cap else '')

    lines = ['## Changes since the previous run', '',
             f"Previous run: {pm.get('finishedAt') or pm.get('startedAt') or '?'} on data up to {pm.get('dataDate') or '?'} "
             f"({'complete' if pm.get('complete') else 'partial'}). Compared on {common:,} stocks present in both"
             + (f'; {unseen:,} stocks are new to this run.' if unseen else '.'), '']
    if not (new_problems or resolved or worse or better or gained or lost):
        lines += ['No stock changed grade.', '']
        return lines
    lines += [f'- **Newly flagged:** {len(new_problems)}' + (f' - {names(new_problems)}' if new_problems else ''),
              f'- **Resolved (now match):** {len(resolved)}' + (f' - {names(resolved)}' if resolved else ''),
              f'- **Got worse (minor -> major):** {len(worse)}' + (f' - {names(worse)}' if worse else ''),
              f'- **Improved (major -> minor):** {len(better)}' + (f' - {names(better)}' if better else '')]
    if gained:
        lines += [f'- **Newly comparable** (could not be compared last time): {len(gained)} - {names(gained)}']
    if lost:
        lines += [f'- **No longer comparable:** {len(lost)} - {names(lost)}']
    return lines + ['']


def build_report(payload, prev=None, corp_index=None):
    """(markdown_text, csv_text) for a run payload. `prev` is the previous run's payload, if any; `corp_index`
    (see corp_action_hints) lets a "missing event" difference name the corporate action behind it."""
    meta = payload.get('meta') or {}
    stocks = payload.get('stocks') or {}
    cal = payload.get('calendar') or {}

    cats = {k: [] for k in CATEGORY_ORDER}
    for isin, r in stocks.items():
        cats[category(r)].append((isin, r))
    n = len(stocks)
    comparable = cats['match'] + cats['minor'] + cats['major']
    flagged = cats['minor'] + cats['major']
    hints = {isin: corp_action_hints(isin, r, corp_index) for isin, r in flagged}

    md = []
    partial = not meta.get('complete')
    md += ['# TradingView price verification report', '']
    if partial:
        md += [f"> **PARTIAL RUN** - {n:,} of {meta.get('universe', n):,} stocks were verified"
               + (' before the run was stopped.' if meta.get('stopped') else ' before it ended early.')
               + ' Everything below covers only those stocks.', '']
    scope = (f"the {meta['limit']:,} most-traded stocks" if meta.get('limit') else 'all stocks')
    md += [f"- **Run:** {meta.get('startedAt') or '?'} -> {meta.get('finishedAt') or '?'}"
           + (f" ({meta['durationSec'] / 60:.0f} min)" if meta.get('durationSec') else '')
           + (' (resumed after an interruption)' if meta.get('resumed') else ''),
           f"- **Dashboard data:** prices up to {meta.get('dataDate') or '?'} (about 510 trading days of history per stock)",
           f"- **Scope:** {scope} in the dashboard, {n:,} verified",
           '- **Method:** each stock\'s daily closes are compared with TradingView\'s over every date both have. A bar '
           'counts as different when TradingView/dashboard differs by more than 1% (plus a rounding allowance for cheap '
           'stocks). Grades: **match** = no bar differs; **minor** = a few bars differ, worst under 5%; **major** = worst '
           '5% or more, or 5+ bars differ (a sustained shift, e.g. a missing or wrong adjustment).',
           '']

    # ── summary ────────────────────────────────────────────────────────────────
    md += ['## Summary', '']
    md += _table(['Result', 'Stocks', '% of verified'],
                 [[CATEGORY_LABELS[k], f'{len(cats[k]):,}', _pct(len(cats[k]), n)] for k in CATEGORY_ORDER if cats[k]]
                 + [['**Total verified**', f'**{n:,}**', '']])
    md += ['']
    if comparable:
        bars = sum(r.get('bars', 0) for _i, r in comparable)
        bars_off = sum(r.get('barsOff', 0) for _i, r in comparable)
        devs = sorted(abs(_num(r.get('maxDevPct'))) for _i, r in comparable)
        md += [f"- **{_pct(len(cats['match']), len(comparable))}** of the {len(comparable):,} comparable stocks match TradingView exactly "
               f"(within tolerance) on every bar; {len(flagged):,} are flagged ({len(cats['major']):,} major).",
               f"- {bars:,} daily bars compared, {bars_off:,} differ ({_pct(bars_off, bars)}).",
               f"- Largest single-bar difference per stock: median {_percentile(devs, .5):.2f}%, 95th percentile "
               f"{_percentile(devs, .95):.2f}%, worst {devs[-1]:.2f}%.", '']
        end_off = [(i, r) for i, r in comparable if abs(_num(r.get('endDevPct'))) > 1.0]
        if end_off:
            md += [f"- **{len(end_off):,} stock(s) differ on the latest shared bar by more than 1%** - i.e. today's price itself "
                   f"disagrees, not just older history (listed in the CSV: `latest_dev_pct`).", '']

    adj = [(i, r) for i, r in stocks.items() if r.get('events')]
    if adj:
        adj_flagged = [x for x in adj if category(x[1]) in ('minor', 'major')]
        adj_match = [x for x in adj if category(x[1]) == 'match']
        plain_flagged = [x for x in flagged if not x[1].get('events')]
        md += [f'- **Stocks the dashboard price-adjusted (splits, bonuses, demergers):** {len(adj):,} in this run - '
               f'{len(adj_match):,} match TradingView, {len(adj_flagged):,} flagged. **Flagged stocks with no adjustment of ours:** '
               f'{len(plain_flagged):,} (TradingView shows a level shift we never applied - see the first cause below).', '']

    # ── changes since the previous run ─────────────────────────────────────────
    if prev and (prev.get('stocks') or {}):
        md += _delta_section(stocks, prev)

    # ── flagged stocks by cause ────────────────────────────────────────────────
    if cats['major']:
        md += ['## Major differences by cause', '',
               f'Most-traded stocks first; at most {MD_ROW_CAP} rows per table (the CSV has all of them).', '']
        groups = {c: [] for c in CAUSE_ORDER}
        for isin, r in cats['major']:
            groups[primary_cause(r)].append((isin, r))
        for c in CAUSE_ORDER:
            if not groups[c]:
                continue
            items = _by_importance(groups[c])
            md += [f'### {CAUSE_LABELS[c]} ({len(items):,})', '']
            md += _table(_STOCK_HEADERS, _stock_rows(items, hints))
            if len(items) > MD_ROW_CAP:
                md += ['', f'... and {len(items) - MD_ROW_CAP:,} more (see the CSV).']
            md += ['']
    if cats['minor']:
        items = _by_importance(cats['minor'])
        md += [f"## Minor differences ({len(items):,})", '']
        md += _table(_STOCK_HEADERS, _stock_rows(items, hints))
        if len(items) > MD_ROW_CAP:
            md += ['', f'... and {len(items) - MD_ROW_CAP:,} more (see the CSV).']
        md += ['']

    # ── inconclusive ───────────────────────────────────────────────────────────
    inc_keys = [k for k in ('not-found', 'tv-error', 'few-bars', 'predates', 'other') if cats[k]]
    if inc_keys:
        md += ['## Could not be compared', '']
        for k in inc_keys:
            items = _by_importance(cats[k])
            shown = ', '.join(r.get('symbol') or '?' for _i, r in items[:MD_ROW_CAP])
            md += [f'- **{CATEGORY_LABELS[k]}** - {len(items):,}: {shown}'
                   + (f' ... (+{len(items) - MD_ROW_CAP:,} more)' if len(items) > MD_ROW_CAP else '')]
        md += ['']

    # ── by series ──────────────────────────────────────────────────────────────
    by_series = {}
    for _i, r in comparable:
        b = by_series.setdefault(r.get('series') or '?', {'match': 0, 'minor': 0, 'major': 0})
        b[category(r)] += 1
    if len(by_series) > 1:
        md += ['## By series', '']
        md += _table(['Series', 'Comparable', 'Match', 'Minor', 'Major', 'Match rate'],
                     [[s, sum(b.values()), b['match'], b['minor'], b['major'], _pct(b['match'], sum(b.values()))]
                      for s, b in sorted(by_series.items())])
        md += ['']

    # ── calendar ───────────────────────────────────────────────────────────────
    md += ['## Trading-calendar differences', '']
    tv_only, ours_only = cal.get('tvOnly') or [], cal.get('oursOnly') or []
    if not tv_only and not ours_only:
        md += ['No date is missing from one side for a large share of the stocks.', '']
    else:
        if tv_only:
            md += [f'- TradingView has {len(tv_only)} trading day(s) the dashboard lacks: {", ".join(tv_only[:30])}'
                   + (f' ... (+{len(tv_only) - 30} more)' if len(tv_only) > 30 else '')]
        if ours_only:
            md += [f'- The dashboard has {len(ours_only)} trading day(s) TradingView lacks: {", ".join(ours_only[:30])}'
                   + (f' ... (+{len(ours_only) - 30} more)' if len(ours_only) > 30 else '')]
        md += ['']

    # ── how to read ────────────────────────────────────────────────────────────
    md += ['## Reading this report', '',
           '- **TradingView adjusts for an action the dashboard has no event for** - usually a rights issue or another action '
           'the downloader filters out of `CorporateActions.csv` (it keeps only bonus, split, sub-division, consolidation and '
           'demerger rows). When the detail says "In the NSE corporate-actions feed", the action IS in `CorporateActions.csv` but '
           'is not price-adjusted - typically a demerger or other non-ratio action that the Data Quality "Not Price-Adjusted" '
           'list no longer shows (it only looks back about 370 days) and so was never corrected from TradingView. Without that '
           'line the feed does not carry the action at all (e.g. a rights issue): it needs handling, or a TradingView-derived '
           'correction like the demerger ones.',
           "- **Our adjustment differs from TradingView's** - both sides adjusted but by a different factor: check the ratio in "
           '`CorporateActions.csv` / `DemergerAdjustments.csv` against TradingView.',
           '- **TradingView shows no adjustment for an event the dashboard applied** - either TradingView is not adjusted for '
           'that action (it happens) or our event is wrong. Compare the raw NSE close before/after the ex-date.',
           '- **No level shift found** - isolated bars differ: a bad or missing bar in the downloaded data, or a TradingView '
           'data glitch. The `worst_date` column says where to look.',
           '- **Not on TradingView** - renamed, merged or delisted symbols, or NSE tickers TradingView spells differently.',
           '- **Latest-bar dev %** is the deviation on the newest shared day. A non-zero value there means the price you see '
           'today is affected, not only history.',
           '- Dividends are not adjusted by the dashboard; TradingView charts with dividend adjustment switched on will show '
           'small steady differences.', '']

    return '\n'.join(md), build_csv(stocks, hints)


CSV_COLUMNS = ['symbol', 'isin', 'series', 'turnover_cr', 'last_close', 'result', 'reason', 'cause_group', 'bars_compared',
               'bars_off', 'max_dev_pct', 'worst_date', 'first_off', 'last_off', 'latest_dev_pct', 'dashboard_adjustments',
               'cause_kinds', 'causes', 'nse_corporate_action', 'note', 'verified_at']


def build_csv(stocks, hints=None):
    """One row per verified stock, most-traded first. UTF-8 with a BOM so Excel opens it correctly."""
    out = io.StringIO(newline='')
    w = csv.writer(out, lineterminator='\r\n')
    w.writerow(CSV_COLUMNS)
    for isin, r in sorted(stocks.items(), key=lambda x: (-_num(x[1].get('turnover')), x[1].get('symbol') or '')):
        cat = category(r)
        w.writerow([
            r.get('symbol'), isin, r.get('series') or '', r.get('turnover', ''), r.get('close', ''), r.get('status'),
            r.get('reason') or '', primary_cause(r) if cat in ('minor', 'major') else '', r.get('bars', ''),
            r.get('barsOff', ''), '' if r.get('maxDevPct') is None else r['maxDevPct'], r.get('worstDate') or '',
            r.get('firstOff') or '', r.get('lastOff') or '', '' if r.get('endDevPct') is None else r['endDevPct'],
            _adjustments_text(r), ';'.join(d.get('kind', '') for d in r.get('causeDetails') or []),
            ' | '.join(r.get('causes') or []), ' / '.join((hints or {}).get(isin) or []), r.get('note') or '',
            r.get('verifiedAt') or '',
        ])
    return out.getvalue()

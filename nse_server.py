#!/usr/bin/env python3
"""
NSE Dashboard Server — serves dashboard, pre-processed JSON data, and preset API.
Usage: python nse_server.py [--port 8765] [--dir /path/to/NSE-StockScanner]
"""

import http.server
import json
import os
import sys
import csv
import io
import gzip
import re
import time
import argparse
import threading
import subprocess
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import tv_adjust  # TradingView-assisted corrections; does nothing until the Data Quality button is clicked

# ─── Configuration ───────────────────────────────────────────────────────────
DEFAULT_PORT = 8765
DATA_SUBDIR = 'NSE_DATA'
BHAV_FILE = 'NSE_Bhavcopy_Combined.csv'
BAND_FILE = 'NSE_PriceBand_Combined.csv'
SECTOR_FILE = 'Sector-Stock-Mapping.csv'
PROCESSED_FILE = 'processed_data.json'
PRESETS_FILE = 'presets.json'
MIDSMALL400_FILE = 'MidSmallcap400_Constituents.csv'
CORPACTIONS_FILE = 'CorporateActions.csv'
CORRECTIONS_FILE = 'DemergerAdjustments.csv'  # TradingView-derived price corrections (see tv_adjust.py)
VERIFY_FILE = 'TradingViewVerification.json'  # last "Verify against TradingView" result (see run_tv_verify)
# Bump whenever processed_data.json gains/changes a field the client relies on: startup then
# reprocesses an older cache by itself instead of silently serving output missing the new field.
PROCESSED_SCHEMA = 2
CORRECTION_COLUMNS = ['ISIN', 'SYMBOL', 'EXDATE', 'FACTOR', 'STATUS', 'CHECKED_AT', 'NOTE']

# ─── TradingView correction run state (polled by the Data Quality tab) ───────
# Same pattern as the reprocess state below: the run happens in a background thread
# so the request returns immediately and the tab can show live progress.
_tv_lock = threading.Lock()
_tv_state = {
    'status': 'idle',   # 'idle' | 'running' | 'done' | 'error'
    'step': '',
    'current': 0,
    'total': 0,
    'startedAt': None,
    'finishedAt': None,
    'error': None,
    'warning': None,
    'adjusted': 0,      # events newly corrected by the last run
    'results': [],      # [{symbol, exDate, status, factor, note}] for the last run
}

# Same for "Verify against TradingView" (compares our adjusted prices with TradingView's).
# Shares _tv_lock with the correction run: both drive the one TradingView chart, so only
# one of them may run at a time.
_tv_verify_state = {
    'status': 'idle',   # 'idle' | 'running' | 'done' | 'error'
    'step': '',
    'current': 0,
    'total': 0,
    'startedAt': None,
    'finishedAt': None,
    'error': None,
    'warning': None,
}

# ─── Reprocess progress state (for the /reprocess.html page) ─────────────────
# Runs the actual reprocessing in a background thread so /api/reprocess
# returns immediately instead of blocking the server's single request-handling
# loop for the full ~30-90s process_data()+save takes - a prior version of
# this endpoint blocked the entire server (nothing else could be served, not
# even /api/status) for that whole duration on every reprocess.
_reprocess_lock = threading.Lock()
_reprocess_state = {
    'status': 'idle',  # 'idle' | 'running' | 'done' | 'error'
    'step': '',
    'startedAt': None,
    'finishedAt': None,
    'error': None,
    'stocks': None,
    'mode': 'reprocess',  # 'reprocess' | 'refresh' (download from NSE first, then reprocess)
}
DOWNLOAD_SCRIPT = 'Download-NSE-Bhavcopy.ps1'

# Guards processed_data.json + the gzipped response caches. The server is
# multi-threaded (see ThreadingNSEServer), so without this two requests could
# both rebuild the caches, or read the JSON while a reprocess is writing it.
_cache_lock = threading.RLock()


# ─── Data Processing ────────────────────────────────────────────────────────
def parse_num(v):
    """Parse a number from string, return None on failure."""
    if v is None or v == '' or v == '-':
        return None
    try:
        return float(v.replace(',', ''))
    except (ValueError, AttributeError):
        return None


def parse_date_str(s):
    """Parse date string to datetime. Handles DD-Mon-YYYY, etc."""
    if not s:
        return None
    s = s.strip()
    for fmt in ('%d-%b-%Y', '%d-%B-%Y', '%Y-%m-%d', '%d/%m/%Y', '%d%b%Y'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # Try generic parse
    try:
        return datetime.strptime(s, '%d-%b-%Y')
    except ValueError:
        return None


def normalize_symbol(s):
    """Match JS normalizeSymbol: lowercase, replace & and - with _."""
    if not s:
        return ''
    return re.sub(r'[&\-]', '_', s.strip().lower())


def read_csv_file(filepath):
    """Read CSV file, return list of dicts. Handle BOM and whitespace in headers."""
    if not os.path.exists(filepath):
        return []
    with open(filepath, 'r', encoding='utf-8-sig') as f:
        text = f.read()
    # Normalize line endings
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    reader = csv.DictReader(io.StringIO(text))
    # Strip whitespace from fieldnames
    if reader.fieldnames:
        reader.fieldnames = [f.strip() for f in reader.fieldnames]
    rows = []
    for row in reader:
        cleaned = {k.strip(): v.strip() if v else '' for k, v in row.items() if k}
        rows.append(cleaned)
    return rows


def find_col(row, candidates):
    """Find the first matching column name (case-insensitive, ignore spaces/underscores)."""
    keys = list(row.keys())
    for c in candidates:
        if c in row:
            return c
        c_norm = c.replace(' ', '').replace('_', '').lower()
        for k in keys:
            if k.replace(' ', '').replace('_', '').lower() == c_norm:
                return k
    return candidates[0] if candidates else None


# ─── Split/Bonus Price Adjustment ──────────────────────────────────────────
# NSE's raw bhavcopy is unadjusted for stock splits/bonuses, so a split date
# looks like a fake ~80%+ crash in every price-derived indicator (sma20,
# 52W high/low, adr, changePct, monthlyChangePct). We back-adjust prices for
# dates before each event's exDate using the corporate-actions feed.
#
# Subject-text patterns below were derived by regex-scanning the live
# corporates-corporateActions API response across its full ~2007-2026
# history (40k+ rows), not just the two patterns originally spotted:
#  - "Bonus X:Y" - equity bonus (X new shares per Y held)
#  - "Face Value Split (Sub-Division) - From Rs A/- Per Share To Rs B/- Per Share"
#    (also seen as "Re" instead of "Rs" for ANY value, not just 1; with/without
#    the "/-" suffix; with/without a space between "Rs" and the number)
#  - "Consolidation Of Equity Shares From Re A Per Share To Rs B Per Share" -
#    a REVERSE split (share count shrinks, price rises); same A/B ratio
#    formula as the split case handles this correctly with no separate logic,
#    since a "from low FV to high FV" consolidation naturally yields ratio < 1.
# Deliberately NOT matched (would corrupt data if guessed at):
#  - "Bonus Ncrps X:Y" / "Scheme Of Arrangement - Bonus Ncrps X:Y" - a bonus
#    issue of non-convertible redeemable preference shares, a separate
#    security; doesn't dilute the equity share count or affect its price.
#  - Standalone "Capital Reduction" / "Capital Reduction Pursuant To Nclt
#    Order" - complex restructurings, not a simple share-count ratio.
#  - Combined old-style subjects like "Bonus 1:1 And Face Value Split From
#    Rs.10/- To Re.1/-" or abbreviated "Fv Split Rs.10/- To Rs.2/-" only
#    appear in pre-2022 data, outside the ~2 years of history this dashboard
#    ever adjusts (MAX_DAILY_DAYS below) - not worth the false-positive risk
#    of a looser regex. Any keyword-matching subject that doesn't parse is
#    logged at process time (see load_split_bonus_events) rather than
#    silently skipped or guessed at, so a future format change is visible.
BONUS_RE = re.compile(r'^\s*Bonus\s*-?\s*(\d+)\s*:\s*(\d+)\s*(?:/|$)', re.IGNORECASE)
FVS_RE = re.compile(
    r'(?:Face Value Split\s*\(Sub-Division\)|Consolidation Of Equity Shares)'
    r'\s*-?\s*From\s+R[se]\.?\s*([\d.]+)\s*/?-?\s*Per\s*Share'
    r'\s*To\s+R[se]\.?\s*([\d.]+)\s*/?-?\s*Per\s*Share',
    re.IGNORECASE
)


def parse_corp_action_ratio(subject):
    """Return the price-adjustment ratio for a corporate-action subject, or
    None if unrecognized. Convention: divide PRE-exDate prices by this ratio
    to bring them to the POST-event scale (ratio > 1 for bonus/forward-split,
    which push price down; ratio < 1 for a reverse-split consolidation)."""
    subject = (subject or '').strip()
    ratio = None

    m = BONUS_RE.match(subject)
    if m:
        x, y = int(m.group(1)), int(m.group(2))
        if y > 0:
            ratio = (x + y) / y

    m2 = FVS_RE.search(subject)
    if m2:
        a, b = float(m2.group(1)), float(m2.group(2))
        if b > 0:
            fvs_ratio = a / b
            ratio = fvs_ratio if ratio is None else ratio * fvs_ratio

    return ratio


def load_split_bonus_events(base_dir, latest_date_str, recognized=None):
    """Read CorporateActions.csv and return (events, unhandled). If a list is passed as
    `recognized`, every row that parsed to a ratio is also appended to it as
    {isin, symbol, exDate, subject, ratio} (used for the Data Quality "Price Adjustments
    Applied" list; the return value is unaffected).
      - events and unhandled as follows:
      - events: {isin: [(exDate_dt, ratio, symbol), ...]} sorted ascending,
        limited to events whose exDate has already occurred (<= latest_date).
        An announced-but-not-yet-effective split must NOT be applied yet -
        none of our price history spans that discontinuity until the raw
        bhavcopy actually reaches exDate. `isin` here is whatever ISIN the
        corp-actions feed happens to list for the row, which can be stale
        (see bridge_split_induced_isin_changes) - `symbol` travels with each
        event so it can be re-resolved to the CURRENT ISIN regardless.
      - unhandled: rows that matched the CSV's split/bonus/demerger keyword
        pre-filter but don't fit a recognized ratio pattern (e.g. "Demerger",
        "Bonus Ncrps", "Capital Reduction") - real corporate actions that
        still cause a genuine price discontinuity around exDate but can't be
        (or, for a demerger, shouldn't be) back-adjusted by a simple ratio.
        Surfaced in the Data Quality tab rather than silently left unadjusted."""
    path = os.path.join(base_dir, DATA_SUBDIR, CORPACTIONS_FILE)
    if not os.path.exists(path):
        return {}, []

    latest_dt = parse_date_str(latest_date_str) if latest_date_str else None
    rows = read_csv_file(path)
    events = defaultdict(list)
    unhandled = []
    skipped_subjects = []

    for r in rows:
        isin = (r.get('ISIN') or '').strip()
        symbol = (r.get('SYMBOL') or '').strip()
        subject = (r.get('SUBJECT') or '').strip()
        ex_date_str = (r.get('EXDATE') or '').strip()
        if not isin or not subject or not ex_date_str:
            continue

        ex_dt = parse_date_str(ex_date_str)
        if not ex_dt:
            continue
        if latest_dt and ex_dt > latest_dt:
            continue  # announced but not yet effective in our downloaded data

        ratio = parse_corp_action_ratio(subject)
        if ratio is None:
            skipped_subjects.append(subject)
            unhandled.append({'isin': isin, 'symbol': symbol, 'exDate': ex_date_str, 'subject': subject})
            continue
        events[isin].append((ex_dt, ratio, symbol))
        if recognized is not None:
            recognized.append({'isin': isin, 'symbol': symbol, 'exDate': ex_date_str,
                               'subject': subject, 'ratio': ratio})

    if skipped_subjects:
        uniq_skipped = sorted(set(skipped_subjects))
        preview = uniq_skipped[:10]
        more = f" (+{len(uniq_skipped) - 10} more)" if len(uniq_skipped) > 10 else ""
        print(f"    [!] {len(skipped_subjects)} corporate-action row(s) matched split/bonus keywords "
              f"but weren't recognized (NOT adjusted): {preview}{more}")

    for isin in events:
        events[isin].sort(key=lambda e: e[0])

    return dict(events), unhandled


def bridge_split_induced_isin_changes(daily_by_symbol, symbol_to_isin, events_by_isin):
    """Re-key every event onto the CURRENT ISIN for its symbol (via
    symbol_to_isin) rather than trusting whatever ISIN the corp-actions feed
    happens to list, and best-effort merge older-ISIN price history forward
    when the symbol has traded under more than one ISIN within our window.

    NSE routinely gives a face-value split/consolidation a BRAND-NEW ISIN for
    the same ticker symbol - confirmed directly against the raw bhavcopy
    (e.g. KAMDHENU traded as INE390H01012 through 07-Jan-2025, then as
    INE390H01020 from 08-Jan-2025, the exact split exDate). Since
    dailyBySymbol is keyed strictly by ISIN, this silently orphans pre-split
    history under the old ISIN unless it's bridged forward.

    Three issues were found and fixed here, in order:
      (1) Trusting the corp-actions CSV row's own `isin` field to find the
          "old" ISIN to bridge from - that field is inconsistent about which
          ISIN it names (confirmed live: PGIL's and KAMDHENU's rows list the
          OLD pre-event ISIN, while ACUTAAS's lists `INE00FF01025`, which is
          actually the CURRENT/new one). Fixed by resolving every event's
          ratio via its `symbol` field through symbol_to_isin instead -
          always correct, independent of the CSV's isin field or of whether
          any old ISIN has retained history at all (PGIL's case: its ISIN
          changed over a year before our data even starts, so there was
          nothing to bridge, but the ratio must still apply).
      (2) Discovering "other ISINs for this symbol" by matching normalized
          SYMBOL NAME across dailyBySymbol - fails whenever a rename happens
          at the same time as the ISIN change, because the old ISIN's own
          last row carries the OLD name (confirmed live: AMIORG -> ACUTAAS,
          isin INE00FF01017 -> INE00FF01025 - the old isin's rows are all
          "AMIORG", which never matches the event's "ACUTAAS").
      (3) Fixed by discovering sibling ISINs via the ISIN's own PREFIX
          instead of any symbol name at all: Indian ISINs share a fixed
          10-character issuer code, and only the last 2 digits change when a
          face-value split gets a new ISIN - confirmed empirically across
          every case seen (INE00FF010-17->-25, INE390H010-12->-20 (KAMDHENU),
          INE940H010-14->-22 (PGIL), INE560A010-15->-23 (INDIAGLYCO)). This
          needs no symbol match at all, so a simultaneous rename can't break
          it, and still only merges ISINs verified to share an issuer code -
          never an unrelated symbol that happens to reuse a similar name."""
    ISIN_PREFIX_LEN = 10
    isins_by_prefix = defaultdict(list)
    for isin, days in daily_by_symbol.items():
        if days and len(isin) >= ISIN_PREFIX_LEN:
            isins_by_prefix[isin[:ISIN_PREFIX_LEN]].append(isin)

    resolved = defaultdict(list)
    touched_symbols = set()
    for old_isin, events in events_by_isin.items():
        for ex_dt, ratio, symbol in events:
            norm_symbol = normalize_symbol(symbol)
            current_isin = symbol_to_isin.get(norm_symbol) or old_isin
            resolved[current_isin].append((ex_dt, ratio))
            touched_symbols.add(norm_symbol)

    bridged = set()
    for norm_symbol in touched_symbols:
        current_isin = symbol_to_isin.get(norm_symbol)
        current_days = daily_by_symbol.get(current_isin) if current_isin else None
        if not current_days or len(current_isin) < ISIN_PREFIX_LEN:
            continue

        candidates = []
        for other_isin in isins_by_prefix.get(current_isin[:ISIN_PREFIX_LEN], ()):
            if other_isin == current_isin or other_isin in bridged:
                continue
            other_days = daily_by_symbol.get(other_isin)
            if not other_days:
                continue
            other_last_dt = parse_date_str(other_days[-1]['date'])
            current_first_dt = parse_date_str(current_days[0]['date'])
            if other_last_dt and current_first_dt and other_last_dt < current_first_dt:
                candidates.append((other_last_dt, other_isin, other_days))

        # Prepend newest-old-ISIN first, so an older chain link ends up at
        # the very front - final order is oldest ISIN's days -> ... -> current.
        candidates.sort(reverse=True)
        for _, other_isin, other_days in candidates:
            daily_by_symbol[current_isin] = other_days + daily_by_symbol[current_isin]
            bridged.add(other_isin)

    if bridged:
        print(f"    Bridged {len(bridged)} split-induced ISIN change(s) "
              f"(old ISIN's history merged into the current ISIN)")

    for isin in resolved:
        resolved[isin].sort(key=lambda e: e[0])

    return dict(resolved)


def apply_split_adjustments(daily_by_symbol, events_by_isin):
    """Back-adjust open/high/low/close/last for days before each event's
    exDate, compounding when a stock has multiple events in its history.
    'prev' (yesterday's close, as NSE's own raw feed reports it - unadjusted,
    even on the exDate row) needs the boundary at exDate itself rather than
    the day after: the exDate row's own OHLC is correctly left un-adjusted
    since it's already on the post-event scale, but its 'prev' field refers
    to the PRIOR day's close, which - if that prior day is being adjusted -
    must be adjusted too, or every consumer of 'prev' (changePct, and
    compute_equal_weight_index()'s per-day return basis) sees one fake
    multiple-hundred-percent day exactly on the split date."""
    adjusted_isins = 0
    ohlc_fields = ('open', 'high', 'low', 'close', 'last')

    for isin, events in events_by_isin.items():
        days = daily_by_symbol.get(isin)
        if not days or not events:
            continue

        touched = False
        for day in days:
            d_dt = parse_date_str(day['date'])
            if not d_dt:
                continue
            cum_ohlc = 1.0
            cum_prev = 1.0
            for ex_dt, ratio in events:
                if d_dt < ex_dt:
                    cum_ohlc *= ratio
                if d_dt <= ex_dt:
                    cum_prev *= ratio
            if cum_ohlc != 1.0:
                touched = True
                for f in ohlc_fields:
                    if day.get(f):
                        day[f] = round(day[f] / cum_ohlc, 2)
            if cum_prev != 1.0 and day.get('prev'):
                touched = True
                day['prev'] = round(day['prev'] / cum_prev, 2)

        if touched:
            adjusted_isins += 1

    if adjusted_isins:
        print(f"    Split/bonus-adjusted {adjusted_isins} stock(s)")


# ─── TradingView-derived demerger corrections ───────────────────────────────
# Demergers (and similar) have no ratio in NSE's feed, so they land in the Data
# Quality tab's "Not Price-Adjusted" list. The "Adjust prices from TradingView" button
# (see run_tv_adjust) compares TradingView's already-adjusted history with ours and
# stores one factor per event in NSE_DATA/DemergerAdjustments.csv. Every processing run
# - including server start - then applies the stored factors through the SAME machinery
# as splits/bonuses, with no TradingView access at all. Deleting a row from the CSV
# undoes that correction on the next (re)process.
#
# STATUS: 'adjusted' (FACTOR applies), 'tv-unadjusted' (TradingView shows no
# adjustment for the event either) or 'inconclusive' (prices didn't line up / stock
# not found). Only 'adjusted' rows change any price; the others just record why an
# event is still listed and are re-checked on the next button click.
def correction_key(symbol, ex_date_str):
    """Identity of one corporate action: (normalized symbol, ex-date). The ISIN in the feed
    can be stale (see bridge_split_induced_isin_changes), so it is never part of the key."""
    ex_dt = parse_date_str(ex_date_str)
    return (normalize_symbol(symbol), ex_dt.date() if ex_dt else None)


def load_demerger_corrections(base_dir):
    """All rows of DemergerAdjustments.csv as dicts (missing file -> [])."""
    rows = []
    for r in read_csv_file(os.path.join(base_dir, DATA_SUBDIR, CORRECTIONS_FILE)):
        symbol, ex_date = r.get('SYMBOL', ''), r.get('EXDATE', '')
        if not symbol or not parse_date_str(ex_date):
            continue
        rows.append({
            'isin': r.get('ISIN', ''),
            'symbol': symbol,
            'exDate': ex_date,
            'factor': parse_num(r.get('FACTOR')),
            'status': (r.get('STATUS') or '').strip().lower(),
            'checkedAt': r.get('CHECKED_AT', ''),
            'note': r.get('NOTE', ''),
        })
    return rows


def save_demerger_corrections(base_dir, rows):
    """Write the corrections CSV atomically (newest ex-date first)."""
    path = os.path.join(base_dir, DATA_SUBDIR, CORRECTIONS_FILE)
    tmp = path + '.tmp'
    ordered = sorted(rows, key=lambda r: parse_date_str(r['exDate']) or datetime.min, reverse=True)
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(CORRECTION_COLUMNS)
        for r in ordered:
            w.writerow([r['isin'], r['symbol'], r['exDate'],
                        '' if r['factor'] is None else f"{r['factor']:.6f}",
                        r['status'], r['checkedAt'], r['note']])
    os.replace(tmp, path)


def add_demerger_corrections(events_by_isin, corrections, latest_date_str):
    """Fold every 'adjusted' correction into `events_by_isin` (same shape
    load_split_bonus_events returns) so bridge_split_induced_isin_changes and
    apply_split_adjustments treat it exactly like a split. A factor F means
    "multiply pre-ex-date prices by F", i.e. the split convention's ratio is 1/F.
    Returns the set of correction_keys applied, so the caller can drop those events
    from the Data Quality list."""
    latest_dt = parse_date_str(latest_date_str) if latest_date_str else None
    applied = set()
    for c in corrections:
        if c['status'] != 'adjusted' or not c['factor'] or c['factor'] <= 0 or abs(c['factor'] - 1) < 1e-9:
            continue
        ex_dt = parse_date_str(c['exDate'])
        if not ex_dt or (latest_dt and ex_dt > latest_dt):
            continue
        events_by_isin.setdefault(c['isin'], []).append((ex_dt, 1.0 / c['factor'], c['symbol']))
        events_by_isin[c['isin']].sort(key=lambda e: e[0])
        applied.add(correction_key(c['symbol'], c['exDate']))
    if applied:
        print(f"    Applying {len(applied)} TradingView demerger correction(s) from {CORRECTIONS_FILE}")
    return applied


def build_adjusted_corp_actions(recognized, corrections, corrected_keys, latest_by_symbol,
                                daily_by_symbol, symbol_to_isin, max_days):
    """The Data Quality "Price Adjustments Applied" list: every split/bonus and every
    TradingView demerger correction that actually changed prices the dashboard keeps
    (stock still trading, ex-date inside its retained window - an older event has no
    visible price effect). `factor` is what pre-ex-date prices were multiplied by
    (1/ratio for splits/bonuses). Sorted newest ex-date first."""
    out, seen = [], set()

    def add(isin_hint, symbol, ex_date_str, kind, detail, factor):
        isin = symbol_to_isin.get(normalize_symbol(symbol)) or isin_hint
        latest, days, ex_dt = latest_by_symbol.get(isin), daily_by_symbol.get(isin), parse_date_str(ex_date_str)
        if not latest or not days or not ex_dt:
            return
        first_dt = parse_date_str(days[-max_days:][0]['date'])
        if first_dt and ex_dt <= first_dt:
            return
        key = (isin, ex_dt, kind, detail)
        if key in seen:
            return
        seen.add(key)
        out.append({'isin': isin, 'symbol': latest['symbol'], 'exDate': ex_date_str,
                    'kind': kind, 'detail': detail, 'factor': round(factor, 6)})

    for ev in recognized:
        add(ev['isin'], ev['symbol'], ev['exDate'], 'split-bonus', ev['subject'], 1.0 / ev['ratio'])
    for c in corrections:
        if correction_key(c['symbol'], c['exDate']) in corrected_keys:
            add(c['isin'], c['symbol'], c['exDate'], 'demerger', 'Demerger (factor derived from TradingView)', c['factor'])
    out.sort(key=lambda e: parse_date_str(e['exDate']) or datetime.min, reverse=True)
    return out


def process_data(base_dir, progress_cb=None):
    """Process raw CSVs into pre-computed JSON. Mirrors JS processData().
    `progress_cb`, if given, is called with a short human-readable phase
    name at each major step (used by /reprocess.html's progress display)."""
    def report(msg):
        print(msg)
        if progress_cb:
            progress_cb(msg.strip())

    data_dir = os.path.join(base_dir, DATA_SUBDIR)
    bhav_path = os.path.join(data_dir, BHAV_FILE)
    band_path = os.path.join(data_dir, BAND_FILE)
    sector_path = os.path.join(data_dir, SECTOR_FILE)

    if not os.path.exists(bhav_path):
        print(f"  [!] Bhavcopy not found: {bhav_path}")
        return None

    t0 = time.time()
    report(f"  Processing bhavcopy...")
    bhav_rows = read_csv_file(bhav_path)
    print(f"    Read {len(bhav_rows):,} rows in {time.time()-t0:.1f}s")

    if not bhav_rows:
        return None

    # Identify columns
    sample = bhav_rows[0]
    col_sym = find_col(sample, ['SYMBOL', 'Symbol', 'TckrSymb'])
    col_series = find_col(sample, ['SERIES', 'Series', 'SctySrs'])
    col_date = find_col(sample, ['DATE1', 'Date', 'DATE', 'TradDt'])
    col_open = find_col(sample, ['OPEN_PRICE', 'OPEN', 'Open', 'OpnPric'])
    col_high = find_col(sample, ['HIGH_PRICE', 'HIGH', 'High', 'HghPric'])
    col_low = find_col(sample, ['LOW_PRICE', 'LOW', 'Low', 'LwPric'])
    col_close = find_col(sample, ['CLOSE_PRICE', 'CLOSE', 'Close', 'ClsPric'])
    col_last = find_col(sample, ['LAST_PRICE', 'LAST', 'Last', 'LastPric'])
    col_prev = find_col(sample, ['PREV_CLOSE', 'PREVCLOSE', 'PrevClose', 'PrvsClsgPric'])
    col_vol = find_col(sample, ['TTL_TRD_QNTY', 'VOLUME', 'Volume', 'TtlTradgVol'])
    col_turnover = find_col(sample, ['TURNOVER_LACS', 'TURNOVER', 'Turnover', 'TtlTrfVal'])
    col_trades = find_col(sample, ['NO_OF_TRADES', 'TRADES', 'NoOfTrades', 'TtlNbOfTxsExctd'])
    col_deliv = find_col(sample, ['DELIV_QTY', 'DELIVQTY', 'DelivQty'])
    col_deliv_per = find_col(sample, ['DELIV_PER', 'DELIVPER', 'DelivPer'])
    col_isin = find_col(sample, ['ISIN', 'Isin'])
    col_company = find_col(sample, ['COMPANY_NAME', 'CompanyName', 'FinInstrmNm'])

    # Group by ISIN
    daily_by_symbol = defaultdict(list)
    symbol_to_isin = {}
    date_set = set()

    t1 = time.time()
    for row in bhav_rows:
        sym = (row.get(col_sym) or '').strip()
        series = (row.get(col_series) or '').strip()
        if not sym or series not in ('EQ', 'BE'):
            continue

        date_str = (row.get(col_date) or '').strip()
        close = parse_num(row.get(col_close))
        if close is None or close <= 0:
            continue

        isin = (row.get(col_isin) or '').strip()
        if not isin:
            continue

        date_set.add(date_str)
        symbol_to_isin[normalize_symbol(sym)] = isin

        daily_by_symbol[isin].append({
            'symbol': sym,
            'series': series,
            'date': date_str,
            'open': parse_num(row.get(col_open)) or 0,
            'high': parse_num(row.get(col_high)) or 0,
            'low': parse_num(row.get(col_low)) or 0,
            'close': close,
            'last': parse_num(row.get(col_last)) or 0,
            'prev': parse_num(row.get(col_prev)) or 0,
            'vol': parse_num(row.get(col_vol)) or 0,
            'turnover': parse_num(row.get(col_turnover)) or 0,
            'trades': parse_num(row.get(col_trades)) or 0,
            'delivQty': parse_num(row.get(col_deliv)) or 0,
            'delivPer': parse_num(row.get(col_deliv_per)) or 0,
            'isin': isin,
            'companyName': (row.get(col_company) or '').strip(),
        })

    print(f"    Grouped {len(daily_by_symbol):,} ISINs in {time.time()-t1:.1f}s")

    # Sort dates
    def date_sort_key(s):
        d = parse_date_str(s)
        return d.timestamp() if d else 0

    dates = sorted(date_set, key=date_sort_key)
    latest_date = dates[-1] if dates else None

    # Sort each symbol's data by date
    for isin in daily_by_symbol:
        daily_by_symbol[isin].sort(key=lambda d: date_sort_key(d['date']))

    # Split/bonus price adjustment (back-adjusts open/high/low/close/prev/last
    # in place for dates before each event's exDate) - must run before any
    # indicator below is computed from these prices.
    t1b = time.time()
    report(f"  Applying split/bonus price adjustments...")
    recognized_corp_events = []
    corp_events, unhandled_corp_events = load_split_bonus_events(base_dir, latest_date, recognized_corp_events)
    demerger_corrections = load_demerger_corrections(base_dir)
    corrected_keys = add_demerger_corrections(corp_events, demerger_corrections, latest_date)
    corp_events = bridge_split_induced_isin_changes(daily_by_symbol, symbol_to_isin, corp_events)
    apply_split_adjustments(daily_by_symbol, corp_events)
    print(f"    Done in {time.time()-t1b:.1f}s")

    # Load sector mapping
    sector_map = {}
    if os.path.exists(sector_path):
        report(f"  Loading sector mapping...")
        sector_rows = read_csv_file(sector_path)
        for r in sector_rows:
            sym = (r.get('Stock Name') or r.get('SYMBOL') or r.get('Symbol') or '').strip()
            if sym:
                sector_map[normalize_symbol(sym)] = {
                    'sector': r.get('Sector') or r.get('SECTOR') or '',
                    'industry': r.get('Basic Industry') or r.get('Industry') or r.get('INDUSTRY') or '',
                    'marketCap': parse_num(r.get('Market Cap') or r.get('MARKET_CAP') or '0') or 0,
                }
        print(f"    {len(sector_map)} stocks mapped")

    # Compute indicators for each symbol
    t2 = time.time()
    report(f"  Computing indicators...")
    latest_by_symbol = {}
    stale_stocks = []

    for isin, days in daily_by_symbol.items():
        latest = days[-1]
        if latest['date'] != latest_date:
            stale_stocks.append({
                'symbol': latest['symbol'],
                'series': latest['series'],
                'lastTradeDate': latest['date'],
                'close': latest['close'],
                'tradingDays': len(days),
            })
            continue

        # 20 SMA
        closes = [d['close'] for d in days]
        sma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else None

        # 52W high/low (250 trading days)
        lookback = min(len(days), 250)
        recent = days[-lookback:]
        high52w = max(d['high'] for d in recent)
        low52w = min(d['low'] for d in recent)

        # ADR % (last 20 days)
        adr_days = days[-20:]
        adr = (sum((d['high'] - d['low']) / d['close'] * 100 for d in adr_days) / len(adr_days)) if adr_days else 0

        # Change %
        change_pct = ((latest['close'] - latest['prev']) / latest['prev'] * 100) if latest['prev'] > 0 else 0

        # Distance from 52W high/low
        dist_from_52h = ((high52w - latest['close']) / high52w * 100) if high52w > 0 else 0
        dist_from_52l = ((latest['close'] - low52w) / low52w * 100) if low52w > 0 else 0

        # Distance from 20 SMA
        dist_from_sma = ((latest['close'] - sma20) / sma20 * 100) if sma20 and sma20 > 0 else None

        # Sector info
        s_info = sector_map.get(normalize_symbol(latest['symbol']), {'sector': '', 'industry': '', 'marketCap': 0})

        # Monthly change % (22 trading sessions)
        month_ref = days[-22] if len(days) >= 22 else days[0]
        monthly_change_pct = ((latest['close'] - month_ref['close']) / month_ref['close'] * 100) if month_ref['close'] > 0 else 0

        sector = s_info['sector'] if s_info['sector'] and s_info['sector'] != '-' else 'Undefined-Diversified'
        industry = s_info['industry'] if s_info['industry'] and s_info['industry'] != '-' else 'Undefined-Diversified'

        latest_by_symbol[isin] = {
            **latest,
            'sma20': round(sma20, 2) if sma20 else None,
            'high52w': round(high52w, 2),
            'low52w': round(low52w, 2),
            'adr': round(adr, 2),
            'changePct': round(change_pct, 2),
            'monthlyChangePct': round(monthly_change_pct, 2),
            'distFrom52H': round(dist_from_52h, 2),
            'distFrom52L': round(dist_from_52l, 2),
            'distFromSMA': round(dist_from_sma, 2) if dist_from_sma is not None else None,
            'sector': sector,
            'industry': industry,
            'marketCap': s_info['marketCap'],
            'aboveSMA': (latest['close'] > sma20) if sma20 else False,
            'tradingDays': len(days),
        }

    print(f"    {len(latest_by_symbol):,} active stocks, {len(stale_stocks)} stale in {time.time()-t2:.1f}s")

    # Resolve unhandled corporate actions (demergers, "Bonus Ncrps", capital
    # reductions, etc.) to the stock's CURRENT isin/close for the Data Quality
    # report - the corp-actions feed's own isin can be stale (confirmed live:
    # INDIAGLYCO's demerger row carries its ISIN from before an unrelated 2025
    # split, not the one currently in daily_by_symbol), so resolve by symbol
    # instead of trusting the row's isin directly. Only the last ~370 days are
    # kept - that's the outer edge of the 52-week window these events can
    # still be distorting; older ones have already fully rolled off.
    unadjusted_corp_actions = []
    if unhandled_corp_events:
        latest_dt_for_filter = parse_date_str(latest_date) if latest_date else None
        for ev in unhandled_corp_events:
            ex_dt = parse_date_str(ev['exDate'])
            if not ex_dt or (latest_dt_for_filter and (latest_dt_for_filter - ex_dt).days > 370):
                continue
            if correction_key(ev['symbol'], ev['exDate']) in corrected_keys:
                continue  # already price-corrected from TradingView data - nothing left to report
            resolved_isin = symbol_to_isin.get(normalize_symbol(ev['symbol'])) or ev['isin']
            current = latest_by_symbol.get(resolved_isin)
            unadjusted_corp_actions.append({
                'isin': resolved_isin,
                'symbol': ev['symbol'],
                'exDate': ev['exDate'],
                'subject': ev['subject'],
                'close': current['close'] if current else None,
            })
        unadjusted_corp_actions.sort(key=lambda e: parse_date_str(e['exDate']) or datetime.min, reverse=True)

    # Process price band data
    band_by_symbol = {}
    if os.path.exists(band_path):
        report(f"  Processing price band...")
        band_rows = read_csv_file(band_path)
        for r in band_rows:
            sym = (r.get('Symbol') or r.get('SYMBOL') or '').strip()
            series = (r.get('Series') or r.get('SERIES') or '').strip()
            if not sym or series not in ('EQ', 'BE'):
                continue
            isin_key = symbol_to_isin.get(normalize_symbol(sym))
            if not isin_key:
                continue

            band_pct_str = (r.get('Band') or r.get('Price Band') or r.get('Applicable Price Band') or '').strip()
            upper_val = parse_num(r.get('Upper_Band') or r.get('High Price Band') or r.get('HighPriceBand') or '')
            lower_val = parse_num(r.get('Lower_Band') or r.get('Low Price Band') or r.get('LowPriceBand') or '')

            # If we only have band % (not upper/lower), compute from latest close
            if (upper_val is None or lower_val is None) and band_pct_str and isin_key in latest_by_symbol:
                try:
                    bp = float(band_pct_str)
                    close = latest_by_symbol[isin_key]['close']
                    # Use prev_close to compute bands (standard NSE calculation)
                    prev = latest_by_symbol[isin_key]['prev']
                    base = prev if prev > 0 else close
                    upper_val = round(base * (1 + bp / 100), 2)
                    lower_val = round(base * (1 - bp / 100), 2)
                except (ValueError, KeyError):
                    pass

            band_by_symbol[isin_key] = {
                'upper': upper_val,
                'lower': lower_val,
                'bandPct': band_pct_str + '%' if band_pct_str and '%' not in band_pct_str else band_pct_str,
            }

            # Merge into latestBySymbol
            if isin_key in latest_by_symbol:
                s = latest_by_symbol[isin_key]
                s['upperBand'] = upper_val
                s['lowerBand'] = lower_val
                s['bandPct'] = band_by_symbol[isin_key]['bandPct']
                # Check circuit hits
                if upper_val and upper_val > 0:
                    s['hitUC'] = s['high'] >= upper_val * 0.999
                if lower_val and lower_val > 0:
                    s['hitLC'] = s['low'] <= lower_val * 1.001

        print(f"    {len(band_by_symbol)} bands mapped")

    # Convert dailyBySymbol to compact array format for JSON
    # Kept at 510 days (250 current + 250 previous + buffer) rather than the old
    # 260 (52 weeks + buffer): client-side computeIndustryMoneyFlow('1y') needs a
    # full 250-day "current" window plus another 250-day "previous" window to
    # compare against, and silently truncating to 260 made the "previous" window
    # almost entirely empty for real stocks, producing wildly inflated money-flow
    # percentages (confirmed live: ~59x understated denominator for a sample
    # stock; every industry showed 1000-6000%+ money flow at the 12-month
    # setting). 3m/6m periods already fit within the old cap and were unaffected.
    # Columns: date, open, high, low, close, vol, turnover, prev, delivQty, delivPer, trades
    DAILY_COLS = ['date', 'open', 'high', 'low', 'close', 'vol', 'turnover', 'prev', 'delivQty', 'delivPer', 'trades']
    MAX_DAILY_DAYS = 510
    compact_daily = {}
    for isin, days in daily_by_symbol.items():
        if isin not in latest_by_symbol:
            continue  # skip stale stocks
        recent_days = days[-MAX_DAILY_DAYS:]
        compact_daily[isin] = [
            [d.get(c, 0) for c in DAILY_COLS]
            for d in recent_days
        ]

    adjusted_corp_actions = build_adjusted_corp_actions(
        recognized_corp_events, demerger_corrections, corrected_keys,
        latest_by_symbol, daily_by_symbol, symbol_to_isin, MAX_DAILY_DAYS)

    report(f"  Computing equal-weight MidSmallcap 400 index...")
    ew_index = compute_equal_weight_index(base_dir, daily_by_symbol, symbol_to_isin, dates)
    if ew_index:
        print(f"    {ew_index['constituentCount']} constituents matched, {len(ew_index['bars'])} bars")
    else:
        print(f"    Skipped ({MIDSMALL400_FILE} missing or no constituents matched)")

    result = {
        'schemaVersion': PROCESSED_SCHEMA,  # keep FIRST - needs_processing() reads it from the file's head
        'latestDate': latest_date,
        'dates': dates,
        'latestBySymbol': latest_by_symbol,
        'dailyBySymbol': compact_daily,
        'dailyCols': DAILY_COLS,
        'bandBySymbol': band_by_symbol,
        'symbolToISIN': symbol_to_isin,
        'sectorMap': sector_map,
        'staleStocks': stale_stocks,
        'ewIndex': ew_index,
        'unadjustedCorpActions': unadjusted_corp_actions,
        'adjustedCorpActions': adjusted_corp_actions,
        'processedAt': datetime.now().isoformat(),
    }

    total = time.time() - t0
    print(f"  Done! {len(latest_by_symbol):,} stocks processed in {total:.1f}s")
    return result


def compute_equal_weight_index(base_dir, daily_by_symbol, symbol_to_isin, dates):
    """Equal-weight OHLC+turnover series for the Nifty MidSmallcap 400 constituents.

    Each stock's own 'prev' (PREV_CLOSE from bhavcopy) is used as its per-day
    return reference, so gaps/holidays for individual stocks don't skew the
    average. Index O/H/L/C compounds the cross-sectional average daily return
    from a base of 1000. Averaging preserves per-stock high>=open,close and
    low<=open,close ordering, so the resulting index candle is valid without
    extra clamping.
    """
    ms400_path = os.path.join(base_dir, DATA_SUBDIR, MIDSMALL400_FILE)
    if not os.path.exists(ms400_path):
        return None

    rows = read_csv_file(ms400_path)
    isins = set()
    for r in rows:
        sym = (r.get('SYMBOL') or r.get('Symbol') or '').strip()
        if not sym:
            continue
        isin = symbol_to_isin.get(normalize_symbol(sym))
        if isin:
            isins.add(isin)

    if not isins or not dates:
        return None

    # Use the full history available in the combined bhavcopy (not just a
    # recent window) so the chart shows everything that's been downloaded.
    window_dates = dates
    window_set = set(window_dates)

    by_date = defaultdict(list)
    for isin in isins:
        for d in daily_by_symbol.get(isin, ()):
            if d['date'] in window_set:
                by_date[d['date']].append(d)

    bars = []
    index_close = 1000.0
    for date in window_dates:
        recs = by_date.get(date, [])
        turnover_sum = sum(r.get('turnover') or 0 for r in recs)
        valid = [r for r in recs if (r.get('prev') or 0) > 0 and r.get('close')]

        if not valid:
            # No usable constituent data this day — hold the index flat
            bars.append([date, round(index_close, 2), round(index_close, 2),
                         round(index_close, 2), round(index_close, 2),
                         round(turnover_sum, 2), 0])
            continue

        n = len(valid)
        ret_open = sum(r['open'] / r['prev'] - 1 for r in valid) / n
        ret_high = sum(r['high'] / r['prev'] - 1 for r in valid) / n
        ret_low = sum(r['low'] / r['prev'] - 1 for r in valid) / n
        ret_close = sum(r['close'] / r['prev'] - 1 for r in valid) / n

        prev_index_close = index_close
        index_close = prev_index_close * (1 + ret_close)
        bars.append([
            date,
            round(prev_index_close * (1 + ret_open), 2),
            round(prev_index_close * (1 + ret_high), 2),
            round(prev_index_close * (1 + ret_low), 2),
            round(index_close, 2),
            round(turnover_sum, 2),
            n,
        ])

    return {
        'cols': ['date', 'open', 'high', 'low', 'close', 'turnover', 'count'],
        'bars': bars,
        'constituentCount': len(isins),
        'isins': sorted(isins),  # exposes membership itself (not just the computed index) - used client-side to scope Market Breadth to this narrower, less noisy universe
    }


def needs_processing(base_dir):
    """Check if processed JSON needs regeneration."""
    data_dir = os.path.join(base_dir, DATA_SUBDIR)
    json_path = os.path.join(data_dir, PROCESSED_FILE)

    if not os.path.exists(json_path):
        return True

    # Cache written by older code (no / lower schemaVersion, which process_data() writes as the
    # file's very first key)? Regenerate so the new fields exist - without this a restart alone
    # keeps serving the stale cache. Only the first few bytes are read.
    with open(json_path, 'r', encoding='utf-8') as f:
        m = re.match(r'\{"schemaVersion":(\d+)', f.read(64))
    if not m or int(m.group(1)) < PROCESSED_SCHEMA:
        return True

    json_mtime = os.path.getmtime(json_path)
    for csv_file in [BHAV_FILE, BAND_FILE, SECTOR_FILE, MIDSMALL400_FILE, CORPACTIONS_FILE, CORRECTIONS_FILE]:
        csv_path = os.path.join(data_dir, csv_file)
        if os.path.exists(csv_path) and os.path.getmtime(csv_path) > json_mtime:
            return True

    return False


def save_processed_data(base_dir, data):
    """Save processed data as JSON."""
    data_dir = os.path.join(base_dir, DATA_SUBDIR)
    json_path = os.path.join(data_dir, PROCESSED_FILE)
    print(f"  Saving {json_path}...")
    t0 = time.time()
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    size_mb = os.path.getsize(json_path) / 1048576
    print(f"  Saved: {size_mb:.1f} MB in {time.time()-t0:.1f}s")
    return json_path


def load_processed_data(base_dir):
    """Load pre-processed JSON."""
    data_dir = os.path.join(base_dir, DATA_SUBDIR)
    json_path = os.path.join(data_dir, PROCESSED_FILE)
    if not os.path.exists(json_path):
        return None
    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)


# ─── Presets ─────────────────────────────────────────────────────────────────
def load_presets(base_dir):
    """Load presets from JSON file."""
    path = os.path.join(base_dir, PRESETS_FILE)
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_presets(base_dir, presets):
    """Save presets to JSON file."""
    path = os.path.join(base_dir, PRESETS_FILE)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(presets, f, indent=2, ensure_ascii=False)


# ─── TradingView correction run (the Data Quality "Adjust prices" button) ────
def run_tv_adjust(base_dir, port):
    """Background worker behind POST /api/tv-adjust/start. For every event currently in the
    Data Quality "Not Price-Adjusted" list: read TradingView's daily bars, derive the
    correction factor (tv_adjust.derive_correction), record the outcome in
    DemergerAdjustments.csv, and - if any price was newly corrected - reprocess so the
    corrected prices (and the shrunken list) are live. TradingView is only ever touched
    here, never at server start; the user's chart symbol/resolution are restored after."""
    st = _tv_state
    try:
        st['step'] = 'Reading dashboard data...'
        with _cache_lock:
            data = load_processed_data(base_dir)
        if not data:
            raise RuntimeError('No processed data available yet - reprocess first.')

        cols = data.get('dailyCols') or []
        date_i, close_i = cols.index('date'), cols.index('close')
        daily = data.get('dailyBySymbol') or {}
        pending, seen = [], set()
        for ev in data.get('unadjustedCorpActions') or []:
            key = correction_key(ev['symbol'], ev['exDate'])
            if key in seen:
                continue
            seen.add(key)
            days = daily.get(ev['isin'])
            pending.append({
                'ev': ev, 'key': key,
                'ours': {parse_date_str(r[date_i]).date(): r[close_i] for r in days} if days else None,
            })
        data = daily = None  # the full price history is big - only the small per-event slices are kept

        st.update(total=len(pending), current=0)
        if not pending:
            st['step'] = 'Nothing to check - no unadjusted corporate actions are listed.'
            st['status'] = 'done'
            return

        rows = {correction_key(r['symbol'], r['exDate']): r for r in load_demerger_corrections(base_dir)}
        checked_at = datetime.now().strftime('%Y-%m-%d %H:%M')
        newly_adjusted = 0
        stopped_early = None

        with tv_adjust.TradingViewChart(port) as chart:
            for i, item in enumerate(pending):
                ev = item['ev']
                st.update(step=f"Checking {ev['symbol']} on TradingView", current=i)
                if item['ours'] is None:
                    res = {'status': 'inconclusive', 'factor': None,
                           'note': 'No price history for this stock in the dashboard data'}
                else:
                    try:
                        res = tv_adjust.derive_correction(
                            chart.daily_closes(ev['symbol'], since=item['key'][1] - timedelta(days=15)),
                            item['ours'], item['key'][1])
                    except tv_adjust.TradingViewConnectionError as e:
                        stopped_early = str(e)
                        break
                    except tv_adjust.TradingViewError as e:
                        res = {'status': 'inconclusive', 'factor': None, 'note': str(e)}

                rows[item['key']] = {
                    'isin': ev['isin'], 'symbol': ev['symbol'], 'exDate': ev['exDate'],
                    'factor': res['factor'], 'status': res['status'],
                    'checkedAt': checked_at, 'note': res['note'],
                }
                if res['status'] == 'adjusted':
                    newly_adjusted += 1
                st['results'].append({'symbol': ev['symbol'], 'exDate': ev['exDate'],
                                      'status': res['status'], 'factor': res['factor'], 'note': res['note']})
            st['current'] = len(st['results'])

        if st['results']:
            was_current = not needs_processing(base_dir)
            save_demerger_corrections(base_dir, list(rows.values()))
            if was_current and not newly_adjusted:
                # Only "checked" notes/timestamps changed - no price is affected, so the
                # processed data is still current. Touch it so the next server start
                # doesn't reprocess (~1 min) just because the corrections CSV is newer.
                os.utime(os.path.join(base_dir, DATA_SUBDIR, PROCESSED_FILE))

        if newly_adjusted:
            st['step'] = 'Applying corrections...'
            with _cache_lock:
                new_data = process_data(base_dir, progress_cb=lambda s: st.__setitem__('step', s))
                if not new_data:
                    raise RuntimeError('Corrections were saved but reprocessing failed - reprocess manually.')
                st['step'] = 'Saving processed_data.json...'
                save_processed_data(base_dir, new_data)
                NSEHandler._gzipped_data = None
                NSEHandler._gzipped_lite = None
                NSEHandler._gzipped_daily = None
                st['step'] = 'Preparing dashboard data...'
                NSEHandler._build_cache(base_dir)

        st['adjusted'] = newly_adjusted
        if stopped_early:
            st['warning'] = f'Stopped early: {stopped_early}'
        st['status'] = 'done'
    except (tv_adjust.TradingViewError, RuntimeError, OSError, ValueError, KeyError) as e:
        st['status'] = 'error'
        st['error'] = str(e)
    except Exception as e:  # never leave the UI stuck on "running"
        st['status'] = 'error'
        st['error'] = f'Unexpected error: {e}'
    finally:
        st['finishedAt'] = time.time()


def load_verification(base_dir):
    """The last saved "Verify against TradingView" result, or None."""
    path = os.path.join(base_dir, DATA_SUBDIR, VERIFY_FILE)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_verification(base_dir, payload):
    path = os.path.join(base_dir, DATA_SUBDIR, VERIFY_FILE)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'))
    os.replace(tmp, path)


def adjustments_match(stored, current):
    """Do two [[exDate, factor], ...] lists describe the same set of price adjustments?
    Order-insensitive; factors compared with a small relative tolerance. `stored` may be None
    (results saved before adjustments were recorded) - then nothing matches."""
    if not isinstance(stored, list) or len(stored) != len(current):
        return False
    a, b = sorted((str(d), float(f)) for d, f in stored), sorted((str(d), float(f)) for d, f in current)
    return all(x[0] == y[0] and abs(x[1] - y[1]) <= 1e-6 * max(1.0, abs(y[1])) for x, y in zip(a, b))


def run_tv_verify(base_dir, port, verify_all=False):
    """Background worker behind POST /api/tv-verify/start. For the stocks in the Data Quality
    "Price Adjustments Applied" list (splits, bonuses and TradingView demerger corrections),
    compare our adjusted daily closes with TradingView's over their whole shared history
    (tv_adjust.compare_series) and grade each stock match / minor / major / inconclusive.

    A stock that already verified as 'match' for exactly the same adjustments is skipped
    (the tab hides it from the list, and only comes back when a new/changed adjustment makes
    the stored result stale) - so a repeat run only checks what's new or still flagged.
    `verify_all` re-checks everything. Results are MERGED into the saved file.

    Read-only apart from the result file: no price is changed. The user's chart symbol and
    resolution are restored afterwards. Also reports calendar differences - dates TradingView
    has that we don't (or vice versa) for most stocks, e.g. a special Sunday session."""
    st = _tv_verify_state
    try:
        st['step'] = 'Reading dashboard data...'
        with _cache_lock:
            data = load_processed_data(base_dir)
        if not data:
            raise RuntimeError('No processed data available yet - reprocess first.')

        cols = data.get('dailyCols') or []
        date_i, close_i = cols.index('date'), cols.index('close')
        daily = data.get('dailyBySymbol') or {}
        stocks = {}
        for a in data.get('adjustedCorpActions') or []:
            isin = a['isin']
            days = daily.get(isin)
            if not days:
                continue
            if isin not in stocks:
                stocks[isin] = {'symbol': a['symbol'], 'events': [], 'sig': [],
                                'ours': {parse_date_str(r[date_i]).date(): r[close_i] for r in days}}
            stocks[isin]['events'].append((parse_date_str(a['exDate']).date(), a['factor']))
            stocks[isin]['sig'].append([a['exDate'], a['factor']])
        data = daily = None  # only the per-stock closes are kept

        prev = load_verification(base_dir) or {}
        # Keep only earlier results that still describe the stock's CURRENT adjustments.
        kept = {i: r for i, r in (prev.get('stocks') or {}).items()
                if i in stocks and adjustments_match(r.get('events'), stocks[i]['sig'])}
        todo = {i: s for i, s in stocks.items()
                if verify_all or kept.get(i, {}).get('status') != 'match'}

        st.update(total=len(todo), current=0)
        if not stocks:
            st['step'] = 'Nothing to verify - no price adjustments are listed.'
            st['status'] = 'done'
            return
        if not todo:
            st['step'] = 'Everything is already verified - nothing new to check.'
            st['status'] = 'done'
            return

        results = {}
        tv_only, ours_only = defaultdict(int), defaultdict(int)
        stopped_early = None
        stamp = datetime.now().strftime('%Y-%m-%d %H:%M')
        with tv_adjust.TradingViewChart(port) as chart:
            for i, (isin, s) in enumerate(todo.items()):
                st.update(step=f"Verifying {s['symbol']} against TradingView", current=i)
                try:
                    res = tv_adjust.compare_series(
                        s['ours'], chart.daily_closes(s['symbol'], since=min(s['ours'])), events=s['events'])
                except tv_adjust.TradingViewConnectionError as e:
                    stopped_early = str(e)
                    break
                except tv_adjust.TradingViewError as e:
                    res = {'status': 'inconclusive', 'bars': 0, 'barsOff': 0, 'maxDevPct': None,
                           'worstDate': None, 'firstOff': None, 'lastOff': None,
                           'tvOnlyDates': [], 'oursOnlyDates': [], 'causes': [], 'note': str(e)}
                for d in res.pop('tvOnlyDates'):
                    tv_only[d] += 1
                for d in res.pop('oursOnlyDates'):
                    ours_only[d] += 1
                res.update(symbol=s['symbol'], events=s['sig'], verifiedAt=stamp)
                results[isin] = res

        merged = {**kept, **results}
        summary = {k: sum(1 for r in merged.values() if r['status'] == k)
                   for k in ('match', 'minor', 'major', 'inconclusive')}
        # A date is a calendar difference only if it shows up for at least half the stocks -
        # meaningful only for a reasonably large run; a small re-check keeps the earlier finding.
        if len(results) >= 10:
            cutoff = max(3, len(results) // 2)
            calendar = {
                'tvOnly': sorted((d for d, n in tv_only.items() if n >= cutoff), key=lambda x: parse_date_str(x)),
                'oursOnly': sorted((d for d, n in ours_only.items() if n >= cutoff), key=lambda x: parse_date_str(x)),
            }
        else:
            calendar = prev.get('calendar') or {'tvOnly': [], 'oursOnly': []}
        if results:
            save_verification(base_dir, {
                'verifiedAt': stamp, 'total': len(stocks), 'checked': len(results),
                'complete': stopped_early is None,
                'summary': summary, 'calendar': calendar, 'stocks': merged,
            })
        ok = sum(1 for r in results.values() if r['status'] == 'match')
        st['step'] = (f'Checked {len(results)} stock{"s" if len(results) != 1 else ""}: {ok} verified'
                      f'{"" if ok == len(results) else f", {len(results) - ok} flagged"}.')
        if stopped_early:
            st['warning'] = f'Stopped early after {len(results)} of {len(todo)} stocks: {stopped_early}'
        st['status'] = 'done'
    except (tv_adjust.TradingViewError, RuntimeError, OSError, ValueError, KeyError) as e:
        st['status'] = 'error'
        st['error'] = str(e)
    except Exception as e:  # never leave the UI stuck on "running"
        st['status'] = 'error'
        st['error'] = f'Unexpected error: {e}'
    finally:
        st['finishedAt'] = time.time()


# ─── HTTP Server ─────────────────────────────────────────────────────────────
class NSEHandler(http.server.SimpleHTTPRequestHandler):
    """Custom handler for API endpoints + static file serving."""

    # Cached gzipped data (full, lite, daily)
    _gzipped_data = None
    _gzipped_etag = None
    _gzipped_lite = None
    _gzipped_lite_etag = None
    _gzipped_daily = None
    _gzipped_daily_etag = None

    def end_headers(self):
        # Prevent browser caching of static files (JS, HTML, CSS)
        path = self.path.split('?')[0]
        if path.endswith(('.js', '.html', '.css')):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def log_message(self, format, *args):
        # Suppress noisy static file logs, show API calls
        if '/api/' in str(args[0]) if args else False:
            super().log_message(format, *args)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/api/data':
            query = parse_qs(parsed.query)
            lite = 'lite' in query
            self._serve_data(lite=lite)
        elif path == '/api/data/daily':
            self._serve_daily()
        elif path == '/api/presets':
            self._serve_presets()
        elif path == '/api/reprocess':
            self._handle_reprocess()
        elif path == '/api/reprocess/start':
            self._handle_reprocess_start()
        elif path == '/api/reprocess/status':
            self._serve_reprocess_status()
        elif path == '/api/tv-adjust/status':
            self._serve_tv_adjust_status()
        elif path == '/api/tv-verify/status':
            self._serve_tv_verify_status()
        elif path == '/api/status':
            self._serve_status()
        elif path == '/api/files':
            self._serve_files()
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/presets':
            self._save_presets()
        elif parsed.path == '/api/tv-adjust/start':
            self._handle_tv_adjust_start()
        elif parsed.path == '/api/tv-verify/start':
            self._handle_tv_verify_start()
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _ensure_processed(self):
        """Ensure data is processed and cached. Returns False on failure."""
        base_dir = self.server.base_dir
        if needs_processing(base_dir):
            print("\n[Server] CSV files changed, re-processing...")
            data = process_data(base_dir)
            if data:
                save_processed_data(base_dir, data)
                NSEHandler._gzipped_data = None
                NSEHandler._gzipped_lite = None
                NSEHandler._gzipped_daily = None
            else:
                return False
        return True

    def _load_and_cache(self):
        return NSEHandler._build_cache(self.server.base_dir)

    @classmethod
    def _build_cache(cls, base_dir):
        """Load processed JSON and build gzipped caches (full, lite, daily).
        Callers must hold _cache_lock."""
        json_path = os.path.join(base_dir, DATA_SUBDIR, PROCESSED_FILE)
        if not os.path.exists(json_path):
            return False

        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Full data (keep for backward compat)
        full_raw = json.dumps(data).encode('utf-8')
        NSEHandler._gzipped_data = gzip.compress(full_raw, compresslevel=6)
        NSEHandler._gzipped_etag = f'"{hash(NSEHandler._gzipped_data) & 0xFFFFFFFF:08x}"'

        # Lite data (everything except dailyBySymbol — small enough for browser)
        lite_data = {k: v for k, v in data.items() if k not in ('dailyBySymbol', 'dailyCols')}
        lite_raw = json.dumps(lite_data).encode('utf-8')
        NSEHandler._gzipped_lite = gzip.compress(lite_raw, compresslevel=6)
        NSEHandler._gzipped_lite_etag = f'"{hash(NSEHandler._gzipped_lite) & 0xFFFFFFFF:08x}"'

        # Daily data only
        daily_data = {
            'dailyBySymbol': data.get('dailyBySymbol', {}),
            'dailyCols': data.get('dailyCols', []),
        }
        daily_raw = json.dumps(daily_data).encode('utf-8')
        NSEHandler._gzipped_daily = gzip.compress(daily_raw, compresslevel=6)
        NSEHandler._gzipped_daily_etag = f'"{hash(NSEHandler._gzipped_daily) & 0xFFFFFFFF:08x}"'

        print(f"[Server] Cached: full={len(full_raw)/1048576:.1f}MB->{len(NSEHandler._gzipped_data)/1048576:.1f}MB, "
              f"lite={len(lite_raw)/1048576:.1f}MB->{len(NSEHandler._gzipped_lite)/1048576:.1f}MB, "
              f"daily={len(daily_raw)/1048576:.1f}MB->{len(NSEHandler._gzipped_daily)/1048576:.1f}MB")
        return True

    def _serve_gzipped(self, gz_data, etag):
        """Send a gzipped JSON response with ETag support."""
        if_none = self.headers.get('If-None-Match')
        if if_none == etag:
            self.send_response(304)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', len(gz_data))
        self.send_header('ETag', etag)
        self.send_header('Cache-Control', 'no-cache')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(gz_data)

    def _serve_data(self, lite=False):
        """Serve pre-processed data as gzipped JSON. lite=True excludes dailyBySymbol."""
        with _cache_lock:
            if not self._ensure_processed():
                self.send_error(500, 'Data processing failed')
                return
            if NSEHandler._gzipped_data is None:
                if not self._load_and_cache():
                    self.send_error(404, 'No processed data available')
                    return
            if lite:
                gz, etag = NSEHandler._gzipped_lite, NSEHandler._gzipped_lite_etag
            else:
                gz, etag = NSEHandler._gzipped_data, NSEHandler._gzipped_etag
        self._serve_gzipped(gz, etag)

    def _serve_daily(self):
        """Serve only dailyBySymbol as gzipped JSON (loaded after dashboard shows)."""
        with _cache_lock:
            if not self._ensure_processed():
                self.send_error(500, 'Data processing failed')
                return
            if NSEHandler._gzipped_daily is None:
                if not self._load_and_cache():
                    self.send_error(404, 'No processed data available')
                    return
            gz, etag = NSEHandler._gzipped_daily, NSEHandler._gzipped_daily_etag
        self._serve_gzipped(gz, etag)

    def _serve_presets(self):
        """Serve presets as JSON."""
        presets = load_presets(self.server.base_dir)
        body = json.dumps(presets).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _save_presets(self):
        """Save presets from POST body."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            presets = json.loads(body.decode('utf-8'))
            save_presets(self.server.base_dir, presets)
            resp = json.dumps({'ok': True}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(resp))
            self._cors_headers()
            self.end_headers()
            self.wfile.write(resp)
        except Exception as e:
            self.send_error(400, str(e))

    def _handle_reprocess(self):
        """Force re-process data. Blocking (used by the PowerShell scripts'
        post-download auto-trigger, which waits for completion before
        printing its own "reprocessed automatically" message) - the
        interactive /reprocess.html page uses the non-blocking
        /api/reprocess/start + /api/reprocess/status pair below instead."""
        print("\n[Server] Forced reprocess requested...")
        with _cache_lock:
            data = process_data(self.server.base_dir)
            if data:
                save_processed_data(self.server.base_dir, data)
                NSEHandler._gzipped_data = None
                NSEHandler._gzipped_lite = None
                NSEHandler._gzipped_daily = None
        if data:
            resp = json.dumps({'ok': True, 'stocks': len(data['latestBySymbol'])}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._cors_headers()
            self.end_headers()
            self.wfile.write(resp)
        else:
            self.send_error(500, 'Processing failed')

    def _handle_reprocess_start(self):
        """Start reprocessing in a background thread and return immediately -
        unlike /api/reprocess, this doesn't block the server's single
        request-handling loop for the full run, so /api/reprocess/status
        polls (and everything else) keep working while it runs. Used by
        /reprocess.html for a live progress display. With ?download=1, the
        NSE downloader script runs first ("Refresh Data")."""
        download = 'download' in parse_qs(urlparse(self.path).query)
        with _reprocess_lock:
            if _reprocess_state['status'] == 'running':
                body = json.dumps({'ok': True, 'alreadyRunning': True}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self._cors_headers()
                self.end_headers()
                self.wfile.write(body)
                return
            _reprocess_state.update(status='running', step='Starting...', startedAt=time.time(),
                                     finishedAt=None, error=None, stocks=None,
                                     mode='refresh' if download else 'reprocess')

        base_dir = self.server.base_dir

        def run_download():
            """Run the PowerShell downloader headless, mirroring its output
            into the progress step. Returns an error string, or None on success."""
            script = os.path.join(base_dir, DOWNLOAD_SCRIPT)
            if not os.path.exists(script):
                return f'{DOWNLOAD_SCRIPT} not found'
            _reprocess_state['step'] = 'Downloading new data from NSE...'
            try:
                proc = subprocess.Popen(
                    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                     '-File', script, '-NoPause'],
                    cwd=base_dir, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            except OSError as e:
                return f'Could not launch PowerShell: {e}'
            tail = []
            for line in proc.stdout:
                line = line.strip()
                if not any(c.isalnum() for c in line):
                    continue
                print(f'  [download] {line}')
                tail.append(line)
                del tail[:-5]
                _reprocess_state['step'] = 'Downloading: ' + line[:90]
            if proc.wait() != 0:
                return 'Download failed: ' + ' | '.join(tail[-3:])
            return None

        def worker():
            try:
                if download:
                    err = run_download()
                    if err:
                        _reprocess_state['status'] = 'error'
                        _reprocess_state['error'] = err
                        return
                def progress_cb(step):
                    _reprocess_state['step'] = step
                with _cache_lock:
                    data = process_data(base_dir, progress_cb=progress_cb)
                    if data:
                        _reprocess_state['step'] = 'Saving processed_data.json...'
                        save_processed_data(base_dir, data)
                        NSEHandler._gzipped_data = None
                        NSEHandler._gzipped_lite = None
                        NSEHandler._gzipped_daily = None
                        # Rebuild here (shown as a progress step) so the dashboard's
                        # first load after a refresh doesn't pay for it.
                        _reprocess_state['step'] = 'Preparing dashboard data...'
                        NSEHandler._build_cache(base_dir)
                if data:
                    _reprocess_state['stocks'] = len(data['latestBySymbol'])
                    _reprocess_state['status'] = 'done'
                else:
                    _reprocess_state['status'] = 'error'
                    _reprocess_state['error'] = 'Processing failed (bhavcopy missing or empty?)'
            except Exception as e:
                _reprocess_state['status'] = 'error'
                _reprocess_state['error'] = str(e)
            finally:
                _reprocess_state['finishedAt'] = time.time()

        threading.Thread(target=worker, daemon=True).start()

        body = json.dumps({'ok': True, 'started': True}).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _serve_reprocess_status(self):
        """Current state of a background reprocess started via
        /api/reprocess/start - polled by /reprocess.html."""
        body = json.dumps(_reprocess_state).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Cache-Control', 'no-cache')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _handle_tv_adjust_start(self):
        """POST /api/tv-adjust/start - kick off the TradingView price-correction run in a
        background thread and return immediately; the Data Quality tab polls
        /api/tv-adjust/status. The only place the server ever contacts TradingView."""
        # Custom header = same-origin only: cross-site pages can't send it without a
        # CORS preflight, which this server doesn't approve. Keeps a random web page
        # from making the dashboard drive TradingView / rewrite the corrections file.
        if self.headers.get('X-Requested-With') != 'nse-dashboard':
            self._send_json({'ok': False, 'error': 'Forbidden'}, 403)
            return
        with _tv_lock:
            if _tv_state['status'] == 'running':
                self._send_json({'ok': True, 'alreadyRunning': True})
                return
            if _tv_verify_state['status'] == 'running':
                self._send_json({'ok': False, 'error': 'A TradingView verification is running - try again when it finishes.'}, 409)
                return
            if _reprocess_state['status'] == 'running':
                self._send_json({'ok': False, 'error': 'A data refresh/reprocess is running - try again when it finishes.'}, 409)
                return
            _tv_state.update(status='running', step='Starting...', current=0, total=0,
                             startedAt=time.time(), finishedAt=None, error=None,
                             warning=None, adjusted=0, results=[])
        threading.Thread(target=run_tv_adjust, args=(self.server.base_dir, self.server.tv_port),
                         daemon=True).start()
        self._send_json({'ok': True, 'started': True})

    def _serve_tv_adjust_status(self):
        """Run state plus every stored correction row (so the Data Quality table can show
        why an event is still listed) and the count of corrections currently applied."""
        rows = load_demerger_corrections(self.server.base_dir)
        self._send_json({
            **_tv_state,
            'corrections': rows,
            'appliedCount': sum(1 for r in rows if r['status'] == 'adjusted'),
            'tvPort': self.server.tv_port,
        })

    def _handle_tv_verify_start(self):
        """POST /api/tv-verify/start - compare our adjusted prices with TradingView's in a
        background thread (read-only; changes no price). By default only stocks that haven't
        verified yet for their current adjustments are checked; ?all=1 re-checks everything.
        Same same-origin header rule as the correction endpoint. Refused while a correction
        run is using the TradingView chart."""
        if self.headers.get('X-Requested-With') != 'nse-dashboard':
            self._send_json({'ok': False, 'error': 'Forbidden'}, 403)
            return
        with _tv_lock:
            if _tv_verify_state['status'] == 'running':
                self._send_json({'ok': True, 'alreadyRunning': True})
                return
            if _tv_state['status'] == 'running':
                self._send_json({'ok': False, 'error': 'A TradingView price correction is running - try again when it finishes.'}, 409)
                return
            _tv_verify_state.update(status='running', step='Starting...', current=0, total=0,
                                    startedAt=time.time(), finishedAt=None, error=None, warning=None)
        verify_all = 'all' in parse_qs(urlparse(self.path).query)
        threading.Thread(target=run_tv_verify, args=(self.server.base_dir, self.server.tv_port, verify_all),
                         daemon=True).start()
        self._send_json({'ok': True, 'started': True})

    def _serve_tv_verify_status(self):
        """Run state plus the last saved verification result (per-stock grades, summary,
        calendar differences), so flags survive page reloads and server restarts."""
        self._send_json({**_tv_verify_state, 'last': load_verification(self.server.base_dir),
                         'tvPort': self.server.tv_port})

    def _serve_files(self):
        """Latest downloaded data files + dates (Data Files popup)."""
        body = json.dumps(get_data_files_info(self.server.base_dir)).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-cache')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _serve_status(self):
        """Server status / health check."""
        data_dir = os.path.join(self.server.base_dir, DATA_SUBDIR)
        status = {
            'server': 'nse_server',
            'port': self.server.server_address[1],
            'baseDir': self.server.base_dir,
            'bhavExists': os.path.exists(os.path.join(data_dir, BHAV_FILE)),
            'processedExists': os.path.exists(os.path.join(data_dir, PROCESSED_FILE)),
            'presetsExists': os.path.exists(os.path.join(self.server.base_dir, PRESETS_FILE)),
        }
        body = json.dumps(status).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)


def _scan_dated_files(folder, pattern, date_fmt):
    """Summarise a folder of per-day files named by trade date: latest/earliest
    date, file count, and when the newest file was written (= downloaded)."""
    rx = re.compile(pattern, re.IGNORECASE)
    found = []
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            m = rx.fullmatch(name)
            if not m:
                continue
            try:
                d = datetime.strptime(m.group(1), date_fmt)
            except ValueError:
                continue
            found.append((d, os.path.join(folder, name)))
    if not found:
        return {'count': 0, 'latest': None, 'earliest': None, 'latestFileTime': None}
    found.sort()
    latest_d, latest_path = found[-1]
    return {
        'count': len(found),
        'latest': latest_d.strftime('%d-%b-%Y'),
        'earliest': found[0][0].strftime('%d-%b-%Y'),
        'latestFileTime': os.path.getmtime(latest_path),
    }


def _file_info(path):
    if not os.path.exists(path):
        return {'exists': False}
    return {'exists': True, 'size': os.path.getsize(path), 'modified': os.path.getmtime(path)}


def get_data_files_info(base_dir):
    """Latest downloaded data files and dates, for the dashboard's Data Files popup."""
    data_dir = os.path.join(base_dir, DATA_SUBDIR)
    ref = lambda label, name, folder=data_dir: dict(label=label, file=name, **_file_info(os.path.join(folder, name)))
    return {
        'bhavcopy': _scan_dated_files(os.path.join(data_dir, 'Bhavcopy'),
                                      r'BhavCopy_CM_(\d{8})\.csv', '%Y%m%d'),
        'priceBand': _scan_dated_files(os.path.join(data_dir, 'PriceBand'),
                                       r'sec_list_(\d{8})\.csv', '%d%m%Y'),
        'files': [
            ref('Bhavcopy (combined)', BHAV_FILE),
            ref('Price band (combined)', BAND_FILE),
            ref('Equity list (ISIN master)', 'EQUITY_L.csv'),
            ref('MidSmallcap 400 constituents', MIDSMALL400_FILE),
            ref('Corporate actions', CORPACTIONS_FILE),
            ref('Sector mapping', SECTOR_FILE),
            ref('Processed data (dashboard JSON)', PROCESSED_FILE),
        ],
    }


class ThreadingNSEServer(http.server.ThreadingHTTPServer):
    """One thread per connection. The old single-threaded HTTPServer blocked
    on any idle browser connection (Chrome keeps spare sockets open), stalling
    every other request - the dashboard's slow/unstable page loads."""
    daemon_threads = True
    request_queue_size = 128

    def handle_error(self, request, client_address):
        # A client (browser tab, the launcher's status poll with a short timeout)
        # hanging up before the reply is fully sent is normal, not a server
        # error - skip the traceback socketserver would otherwise print. Real
        # errors still go through the default handler.
        if isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def run_server(port, base_dir, tv_port=tv_adjust.DEFAULT_CDP_PORT):
    """Start the HTTP server. `tv_port` is TradingView Desktop's DevTools port - only used
    when the Data Quality "Adjust prices from TradingView" button is clicked."""
    os.chdir(base_dir)

    # Pre-process data on startup if needed
    data_dir = os.path.join(base_dir, DATA_SUBDIR)
    if os.path.exists(os.path.join(data_dir, BHAV_FILE)):
        if needs_processing(base_dir):
            print("[Server] Processing data on startup...")
            data = process_data(base_dir)
            if data:
                save_processed_data(base_dir, data)
        else:
            print("[Server] Processed data is up to date.")
    else:
        print("[Server] No bhavcopy CSV found — dashboard will use manual file upload.")

    server = ThreadingNSEServer(('', port), NSEHandler)
    server.base_dir = base_dir
    server.tv_port = tv_port

    def warm_cache():
        # Build the gzipped response caches now so the first page load doesn't
        # pay for it. Holds the lock, so an early request waits for this build
        # instead of duplicating it; /api/status etc. answer immediately meanwhile.
        try:
            with _cache_lock:
                if NSEHandler._gzipped_lite is None:
                    NSEHandler._build_cache(base_dir)
        except Exception as e:
            print(f"[Server] Cache warm-up failed (will retry on first request): {e}")
    threading.Thread(target=warm_cache, daemon=True).start()
    print(f"\n[Server] NSE Dashboard running at http://localhost:{port}")
    print(f"[Server] Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] Shutting down.")
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='NSE Dashboard Server')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'Port (default {DEFAULT_PORT})')
    parser.add_argument('--dir', type=str, default=None, help='Base directory (default: script directory)')
    parser.add_argument('--tv-port', type=int, default=tv_adjust.DEFAULT_CDP_PORT,
                        help=f'TradingView Desktop DevTools port, used only by the Data Quality '
                             f'"Adjust prices from TradingView" button (default {tv_adjust.DEFAULT_CDP_PORT})')
    args = parser.parse_args()

    base_dir = args.dir or os.path.dirname(os.path.abspath(__file__))
    if not os.path.isdir(base_dir):
        print(f"Error: {base_dir} is not a directory")
        sys.exit(1)

    run_server(args.port, base_dir, args.tv_port)

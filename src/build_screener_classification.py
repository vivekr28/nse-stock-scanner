#!/usr/bin/env python3
"""
Rebuild NSE_DATA/Sector-Stock-Mapping.csv from Screener.in's copy of the NSE four-tier industry classification
(Macro Sector > Sector > Industry Group > Basic Industry; Screener labels them Broad Sector / Sector /
Broad Industry / Industry). Screener is the only source of the classification.

Usage: python src/build_screener_classification.py [--dir /path/to/NSE-StockScanner] [--skip-walk]
                                                    [--delay 1.0] [--max-age-days 30]

How it works
  1. The stock universe (symbol, listing date) comes from NSE_DATA/EQUITY_L.csv, which the downloader refreshes
     daily, so new NSE listings are picked up automatically. Only these NSE symbols are kept (Screener also
     lists BSE-only companies; they are ignored).
  2. The previous Sector-Stock-Mapping.csv (NSE_DATA/, else the git-tracked reference-data/ copy) is the starting
     point: its `Source` / `Fetched` columns record where and when each stock was last classified.
  3. Walks the leaf industry pages listed on https://www.screener.in/market/. Each page lists at most 25
     companies (`?page=N` is disallowed by Screener's robots.txt, so it is not used).
  4. Fetches the company page of every stock without a classification, of every stock the walk did not return
     that was last classified on an earlier walk, and of every company-page entry older than --max-age-days.
  5. Writes Sector-Stock-Mapping.csv (to NSE_DATA/ and to the git-tracked reference-data/): `Sector` = Screener
     Sector, `Basic Industry` = Screener Industry (the finest tier, ~190 values), plus `Macro Sector`,
     `Industry Group`, `Source` (`walk` | `company`) and `Fetched` (date). Market cap is not stored here: it
     comes from NSE_MarketCap.csv (see nse_server.load_market_caps).
--skip-walk skips step 3 and only fetches missing or expired stocks. Requests are rate-limited (--delay): ~4 min for
a walk, ~20 min for a first run with no previous mapping.
"""

import argparse
import csv
import html
import os
import re
import shutil
import time
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = 'https://www.screener.in'
UA = {'User-Agent': 'Mozilla/5.0 (personal research; low rate)'}
EQUITY_LIST_FILE = 'EQUITY_L.csv'
MAPPING_FILE = 'Sector-Stock-Mapping.csv'
REFERENCE_SUBDIR = 'reference-data'   # git-tracked copy of the mapping, so a fresh clone works without a scrape
OUT_COLUMNS = ['Stock Name', 'Listing Date', 'Basic Industry', 'Sector', 'Macro Sector', 'Industry Group',
               'Source', 'Fetched']


def _clean(fragment):
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', fragment))).strip()


def fetch(path, delay):
    """GET a Screener page; returns text, or None on 404 / repeated failure."""
    for _ in range(3):
        try:
            req = urllib.request.Request(BASE + path, headers=UA)
            text = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
            time.sleep(delay)
            return text
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(5)
        except Exception:
            time.sleep(3)
    return None


def parse_industry_page(page, leaf_path):
    """-> (tiers [macro, sector, industry group, industry], [company slugs])."""
    parents = {}
    for href, label in re.findall(r'<a[^>]*href="(/market/IN[^"]*)"[^>]*>(.*?)</a>', page, re.S):
        if leaf_path.startswith(href) and href != leaf_path:
            parents[href] = _clean(label)
    # keyed by href (not name): a tier can repeat its parent's name, e.g. Insurance > Insurance
    tiers = [parents[k] for k in sorted(parents, key=len)][:3]
    tiers.append(re.sub(r' Companies$', '', _clean(re.search(r'<h1[^>]*>(.*?)</h1>', page, re.S).group(1))))
    slugs = list(dict.fromkeys(re.findall(r'href="/company/([^/"]+)/', page)))
    return tiers, slugs


def parse_company_page(page):
    tiers = []
    for label in ('Broad Sector', 'Sector', 'Broad Industry', 'Industry'):
        found = re.findall(r'title="%s">(.*?)</a>' % label, page, re.S)
        if not found:
            return None
        tiers.append(_clean(found[0]))
    return tiers


def load_universe(path):
    """EQUITY_L.csv -> {symbol: listing date}. Header names carry stray spaces, so keys are stripped."""
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = [{(k or '').strip(): (v or '').strip() for k, v in r.items()} for r in csv.DictReader(f)]
    return {r['SYMBOL']: r.get('DATE OF LISTING', '') for r in rows if r.get('SYMBOL')}


def load_previous(*paths):
    """Previous mapping (first path that exists) -> {symbol: {'tiers': [...], 'src': ..., 'at': 'YYYY-MM-DD'}}.
    Rows without a classification are skipped. A file written before `Source`/`Fetched` existed is treated as
    company-page data fetched on the file's modification date."""
    path = next((p for p in paths if os.path.exists(p)), None)
    if not path:
        return {}
    stamp = date.fromtimestamp(os.path.getmtime(path)).isoformat()
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    state = {}
    for r in rows:
        if r.get('Basic Industry') and r.get('Sector'):
            state[r['Stock Name']] = {
                'tiers': [r.get('Macro Sector', ''), r['Sector'], r.get('Industry Group', ''), r['Basic Industry']],
                'src': r.get('Source') or 'company', 'at': r.get('Fetched') or stamp}
    return state


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    ap.add_argument('--skip-walk', action='store_true', help='only fetch stocks that are missing or expired')
    ap.add_argument('--delay', type=float, default=1.0, help='seconds between requests')
    ap.add_argument('--max-age-days', type=int, default=30, help='re-fetch company-page entries older than this')
    args = ap.parse_args()

    data_dir = os.path.join(args.dir, 'NSE_DATA')
    reference_dir = os.path.join(args.dir, REFERENCE_SUBDIR)
    mapping_path = os.path.join(data_dir, MAPPING_FILE)
    universe = load_universe(os.path.join(data_dir, EQUITY_LIST_FILE))
    previous = load_previous(mapping_path, os.path.join(reference_dir, MAPPING_FILE))
    state = {s: previous[s] for s in universe if s in previous}
    today = date.today().isoformat()

    def write_mapping():
        with open(mapping_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=OUT_COLUMNS)
            writer.writeheader()
            for symbol, listed in universe.items():
                entry = state.get(symbol)
                macro, sector, group, industry = entry['tiers'] if entry else ('', '', '', '')
                writer.writerow({'Stock Name': symbol, 'Listing Date': listed, 'Basic Industry': industry,
                                 'Sector': sector, 'Macro Sector': macro, 'Industry Group': group,
                                 'Source': entry['src'] if entry else '', 'Fetched': entry['at'] if entry else ''})

    if not args.skip_walk:
        index = fetch('/market/', args.delay)
        leaves = sorted(set(re.findall(r'href="(/market/IN\d+/IN\d+/IN\d+/IN\d+/)"', index or '')))
        print(f'{len(leaves)} leaf industries')
        for n, leaf in enumerate(leaves, 1):
            page = fetch(leaf, args.delay)
            if not page:
                continue
            tiers, slugs = parse_industry_page(page, leaf)
            for slug in slugs:
                if slug in universe:            # NSE symbols only; Screener also lists BSE-only companies
                    state[slug] = {'tiers': tiers, 'src': 'walk', 'at': today}
            if n % 25 == 0:
                print(f'  walked {n}/{len(leaves)}')
        write_mapping()

    cutoff = (date.today() - timedelta(days=args.max_age_days)).isoformat()

    def needs_company_page(symbol):
        entry = state.get(symbol)
        if not entry:
            return True
        if entry['src'] == 'company':
            return entry['at'] < cutoff
        return not args.skip_walk and entry['at'] != today   # a walk was run and did not return it this time

    todo = [s for s in universe if needs_company_page(s)]
    print(f'{len(todo)} stocks need a company page')
    for n, symbol in enumerate(todo, 1):
        for path in (f'/company/{symbol}/consolidated/', f'/company/{symbol}/'):
            page = fetch(path, args.delay)
            tiers = parse_company_page(page) if page else None
            if tiers:
                state[symbol] = {'tiers': tiers, 'src': 'company', 'at': today}
                break
        if n % 50 == 0:
            print(f'  {n}/{len(todo)}')
            write_mapping()                     # progress survives an interrupted run
    write_mapping()

    unresolved = [s for s in universe if s not in state]
    print(f'Wrote {len(universe) - len(unresolved)} of {len(universe)} stocks to {MAPPING_FILE}')
    os.makedirs(reference_dir, exist_ok=True)
    shutil.copyfile(mapping_path, os.path.join(reference_dir, MAPPING_FILE))
    print(f'Copied to {REFERENCE_SUBDIR}/{MAPPING_FILE} (git-tracked; commit it when it changes)')
    if unresolved:
        print('No classification found (shown as Undefined-Diversified):', ', '.join(unresolved))


if __name__ == '__main__':
    main()

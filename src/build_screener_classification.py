#!/usr/bin/env python3
"""
Rebuild NSE_DATA/Sector-Stock-Mapping.csv from Screener.in's copy of the NSE four-tier industry classification
(Macro Sector > Sector > Industry Group > Basic Industry; Screener labels them Broad Sector / Sector /
Broad Industry / Industry). Screener is the only source of the classification; nothing is read from a
previous mapping file.

Usage: python src/build_screener_classification.py [--dir /path/to/NSE-StockScanner] [--skip-walk]
                                                    [--delay 1.0] [--max-age-days 30]

How it works
  1. The stock universe (symbol, listing date) comes from NSE_DATA/EQUITY_L.csv, which the downloader refreshes
     daily, so new listings are picked up automatically.
  2. Walks the leaf industry pages listed on https://www.screener.in/market/. Each page lists at most 25
     companies (`?page=N` is disallowed by Screener's robots.txt, so it is not used).
  3. Fetches the company page of every stock the walk did not return, and re-fetches such entries once they are
     older than --max-age-days (walked entries are refreshed by every walk).
  4. Writes Sector-Stock-Mapping.csv (to NSE_DATA/ and to the git-tracked reference-data/): `Sector` = Screener Sector, `Basic Industry` = Screener Industry (the finest
     tier, ~190 values), plus `Macro Sector` and `Industry Group`. Market cap is not stored here: it comes from
     NSE_MarketCap.csv (see nse_server.load_market_caps).
Results are cached in screener-classification-cache.json; --skip-walk reuses the cache and only fetches missing or
expired entries. Requests are rate-limited (--delay): ~4 min for a walk, ~20 min for a first run with no cache.
"""

import argparse
import csv
import html
import json
import os
import re
import shutil
import time
from datetime import date, timedelta
import urllib.error
import urllib.request

BASE = 'https://www.screener.in'
UA = {'User-Agent': 'Mozilla/5.0 (personal research; low rate)'}
EQUITY_LIST_FILE = 'EQUITY_L.csv'
MAPPING_FILE = 'Sector-Stock-Mapping.csv'
CACHE_FILE = 'screener-classification-cache.json'
REFERENCE_SUBDIR = 'reference-data'   # git-tracked copy of the mapping, so a fresh clone works without a scrape
OUT_COLUMNS = ['Stock Name', 'Listing Date', 'Basic Industry', 'Sector', 'Macro Sector', 'Industry Group']


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


def load_cache(path):
    """{symbol: {'tiers': [...], 'src': 'walk'|'company', 'at': 'YYYY-MM-DD'}}; upgrades the old {symbol: tiers} form."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        raw = json.load(f)
    stamp = date.fromtimestamp(os.path.getmtime(path)).isoformat()
    return {k: v if isinstance(v, dict) else {'tiers': v, 'src': 'company', 'at': stamp} for k, v in raw.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    ap.add_argument('--skip-walk', action='store_true', help='reuse the cache; only fetch missing/expired stocks')
    ap.add_argument('--delay', type=float, default=1.0, help='seconds between requests')
    ap.add_argument('--max-age-days', type=int, default=30, help='re-fetch company-page entries older than this')
    args = ap.parse_args()

    data_dir = os.path.join(args.dir, 'NSE_DATA')
    mapping_path = os.path.join(data_dir, MAPPING_FILE)
    cache_path = os.path.join(data_dir, CACHE_FILE)
    universe = load_universe(os.path.join(data_dir, EQUITY_LIST_FILE))
    cache = load_cache(cache_path)
    today = date.today().isoformat()

    def save_cache():
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump(cache, f)

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
                cache[slug] = {'tiers': tiers, 'src': 'walk', 'at': today}
            if n % 25 == 0:
                print(f'  walked {n}/{len(leaves)}')
        save_cache()

    cutoff = (date.today() - timedelta(days=args.max_age_days)).isoformat()
    stale = lambda e: e['src'] == 'company' and e['at'] < cutoff
    walked_today = lambda e: e['src'] == 'walk' and e['at'] == today
    todo = [s for s in universe if s not in cache or stale(cache[s])
            or (not args.skip_walk and not walked_today(cache[s]) and cache[s]['src'] == 'walk')]
    print(f'{len(todo)} stocks need a company page')
    for n, symbol in enumerate(todo, 1):
        for path in (f'/company/{symbol}/consolidated/', f'/company/{symbol}/'):
            page = fetch(path, args.delay)
            tiers = parse_company_page(page) if page else None
            if tiers:
                cache[symbol] = {'tiers': tiers, 'src': 'company', 'at': today}
                break
        if n % 50 == 0:
            print(f'  {n}/{len(todo)}')
            save_cache()
    save_cache()

    unresolved = []
    with open(mapping_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=OUT_COLUMNS)
        writer.writeheader()
        for symbol, listed in universe.items():
            entry = cache.get(symbol)
            if not entry:
                unresolved.append(symbol)
            macro, sector, group, industry = entry['tiers'] if entry else ('', '', '', '')
            writer.writerow({'Stock Name': symbol, 'Listing Date': listed, 'Basic Industry': industry,
                             'Sector': sector, 'Macro Sector': macro, 'Industry Group': group})
    print(f'Wrote {len(universe) - len(unresolved)} of {len(universe)} stocks to {MAPPING_FILE}')
    reference_dir = os.path.join(args.dir, REFERENCE_SUBDIR)
    os.makedirs(reference_dir, exist_ok=True)
    shutil.copyfile(mapping_path, os.path.join(reference_dir, MAPPING_FILE))
    print(f'Copied to {REFERENCE_SUBDIR}/{MAPPING_FILE} (git-tracked; commit it when it changes)')
    if unresolved:
        print('No classification found (shown as Undefined-Diversified):', ', '.join(unresolved))


if __name__ == '__main__':
    main()

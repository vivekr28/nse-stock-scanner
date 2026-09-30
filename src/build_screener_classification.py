#!/usr/bin/env python3
"""
Rebuild NSE_DATA/Sector-Stock-Mapping.csv with the NSE four-tier industry classification as published by
Screener.in (Macro Sector > Sector > Industry > Basic Industry; Screener labels them Broad Sector / Sector /
Broad Industry / Industry).

Usage: python src/build_screener_classification.py [--dir /path/to/NSE-StockScanner] [--skip-walk] [--delay 1.0]

How it works
  1. Reads the stock list (and Market Cap / Listing Date / Index) from Sector-Stock-Mapping.legacy.csv. The first
     run copies the existing Sector-Stock-Mapping.csv to that name, so the original mapping is never lost.
  2. Walks the leaf industry pages listed on https://www.screener.in/market/. Each page lists at most 25
     companies (`?page=N` is disallowed by Screener's robots.txt, so it is not used).
  3. Fetches the individual company page of every stock the walk did not return.
  4. Writes Sector-Stock-Mapping.csv: `Sector` = Screener Sector, `Basic Industry` = Screener Industry (the finest
     tier, ~190 values), plus extra `Macro Sector` and `Industry Group` columns the dashboard ignores.
Results are cached in screener-classification-cache.json; --skip-walk reuses the cache and fetches only stocks
that are missing from it. Requests are rate-limited (--delay); a full run takes ~20 minutes.
"""

import argparse
import csv
import html
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.request

BASE = 'https://www.screener.in'
UA = {'User-Agent': 'Mozilla/5.0 (personal research; low rate)'}
LEGACY_FILE = 'Sector-Stock-Mapping.legacy.csv'
MAPPING_FILE = 'Sector-Stock-Mapping.csv'
CACHE_FILE = 'screener-classification-cache.json'
OUT_COLUMNS = ['Stock Name', 'Listing Date', 'Basic Industry', 'Market Cap', 'Index', 'Sector',
               'Macro Sector', 'Industry Group']


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    ap.add_argument('--skip-walk', action='store_true', help='reuse the cache; only fetch stocks missing from it')
    ap.add_argument('--delay', type=float, default=1.0, help='seconds between requests')
    args = ap.parse_args()

    data_dir = os.path.join(args.dir, 'NSE_DATA')
    mapping_path = os.path.join(data_dir, MAPPING_FILE)
    legacy_path = os.path.join(data_dir, LEGACY_FILE)
    cache_path = os.path.join(data_dir, CACHE_FILE)
    if not os.path.exists(legacy_path):
        shutil.copyfile(mapping_path, legacy_path)
        print(f'Backed up existing mapping to {LEGACY_FILE}')

    with open(legacy_path, encoding='utf-8-sig', newline='') as f:
        legacy = {r['Stock Name']: r for r in csv.DictReader(f)}
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, encoding='utf-8') as f:
            cache = json.load(f)

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
                cache[slug] = tiers
            if n % 25 == 0:
                print(f'  walked {n}/{len(leaves)}')

    missing = [s for s in legacy if s not in cache]
    print(f'{len(missing)} stocks not covered by the industry pages; fetching company pages')
    for n, symbol in enumerate(missing, 1):
        for path in (f'/company/{symbol}/consolidated/', f'/company/{symbol}/'):
            page = fetch(path, args.delay)
            tiers = parse_company_page(page) if page else None
            if tiers:
                cache[symbol] = tiers
                break
        if n % 50 == 0:
            print(f'  {n}/{len(missing)}')
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(cache, f)
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(cache, f)

    unresolved = []
    with open(mapping_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=OUT_COLUMNS)
        writer.writeheader()
        for symbol, row in legacy.items():
            tiers = cache.get(symbol)
            if not tiers:
                unresolved.append(symbol)
            macro, sector, group, industry = tiers or ('', '', '', '')
            writer.writerow({
                'Stock Name': symbol, 'Listing Date': row.get('Listing Date', ''),
                'Basic Industry': industry, 'Market Cap': row.get('Market Cap', ''),
                'Index': row.get('Index', ''), 'Sector': sector,
                'Macro Sector': macro, 'Industry Group': group,
            })
    print(f'Wrote {len(legacy) - len(unresolved)} of {len(legacy)} stocks to {MAPPING_FILE}')
    if unresolved:
        print('No classification found (shown as Undefined-Diversified):', ', '.join(unresolved))


if __name__ == '__main__':
    main()

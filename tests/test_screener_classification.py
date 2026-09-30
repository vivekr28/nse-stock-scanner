"""build_screener_classification.py: page parsers, universe/previous-mapping loaders, and main() end to end with the
network replaced by canned Screener pages (no real requests are ever made)."""
import csv
import sys
from datetime import date, timedelta

import pytest

import build_screener_classification as bsc

LEAF = '/market/IN01/IN0101/IN010101/IN010101004/'
TIERS = ['Commodities', 'Chemicals', 'Chemicals & Petrochemicals', 'Dyes And Pigments']
SYMBOLS = ['BODALCHEM', 'NEWCO', 'GHOST', 'OLDCO', 'FRESHCO']


def industry_page(parents, leaf_name, slugs):
    """parents: [(href, label)] breadcrumb anchors, in any order; slugs: company links."""
    crumbs = ''.join(f'<a href="{h}" title="crumb">{l}</a>' for h, l in parents)
    cos = ''.join(f'<a href="/company/{s}/consolidated/">{s}</a><a href="/company/{s}/">{s}</a>' for s in slugs)
    return f'<html>{crumbs}<h1 class="margin-0">{leaf_name} Companies</h1>{cos}</html>'


PARENTS = [('/market/', 'Market'), ('/market/IN01/', 'Commodities'), ('/market/IN01/IN0101/', 'Chemicals'),
           ('/market/IN01/IN0101/IN010101/', 'Chemicals &amp; Petrochemicals'), (LEAF, 'Dyes And Pigments')]


def company_page(tiers):
    labels = ('Broad Sector', 'Sector', 'Broad Industry', 'Industry')
    return '<html>' + ''.join(f'<a href="/x" title="{l}">{t}</a>' for l, t in zip(labels, tiers)) + '</html>'


# --- parsers -----------------------------------------------------------------

def test_parse_industry_page_returns_four_tiers_and_unique_companies():
    tiers, slugs = bsc.parse_industry_page(industry_page(PARENTS, 'Dyes And Pigments', ['BODALCHEM', 'ATUL']), LEAF)
    assert tiers == TIERS                      # entities unescaped; '/market/' and the leaf link itself excluded
    assert slugs == ['BODALCHEM', 'ATUL']      # each company is linked twice on the page; deduplicated in order


def test_parse_industry_page_keeps_a_tier_that_repeats_its_parent_name():
    leaf = '/market/IN04/IN0401/IN040101/IN040101001/'
    parents = [('/market/IN04/', 'Financial Services'), ('/market/IN04/IN0401/', 'Insurance'),
               ('/market/IN04/IN0401/IN040101/', 'Insurance'), (leaf, 'Life Insurance')]
    tiers, _ = bsc.parse_industry_page(industry_page(parents, 'Life Insurance', ['LICI']), leaf)
    assert tiers == ['Financial Services', 'Insurance', 'Insurance', 'Life Insurance']


def test_parse_company_page_reads_all_four_tiers():
    assert bsc.parse_company_page(company_page(TIERS)) == TIERS


def test_parse_company_page_without_a_classification_returns_none():
    assert bsc.parse_company_page(company_page(TIERS[:3])) is None
    assert bsc.parse_company_page('<html>no breadcrumb</html>') is None


# --- loaders -----------------------------------------------------------------

def _write_mapping(path, rows, header=bsc.OUT_COLUMNS):
    path.write_text(','.join(header) + '\n' + ''.join(','.join(r) + '\n' for r in rows), encoding='utf-8')


def test_load_universe_strips_the_padded_equity_l_headers(tmp_path):
    path = tmp_path / 'EQUITY_L.csv'
    path.write_text('SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE\n'
                    '20MICRONS,20 Microns Limited,EQ,06-OCT-2008,5\nATUL,Atul Ltd,EQ,01-JAN-1990,10\n',
                    encoding='utf-8')
    assert bsc.load_universe(str(path)) == {'20MICRONS': '06-OCT-2008', 'ATUL': '01-JAN-1990'}


def test_load_previous_reads_tiers_source_and_fetch_date(tmp_path):
    path = tmp_path / 'map.csv'
    _write_mapping(path, [['AAA', '01-JAN-2000', 'Dyes And Pigments', 'Chemicals', 'Commodities',
                           'Chemicals & Petrochemicals', 'walk', '2026-01-01']])
    assert bsc.load_previous(str(path)) == {'AAA': {'tiers': TIERS, 'src': 'walk', 'at': '2026-01-01'}}


def test_load_previous_treats_a_file_without_source_columns_as_company_data_and_skips_blank_rows(tmp_path):
    path = tmp_path / 'map.csv'
    _write_mapping(path, [['AAA', '01-JAN-2000', 'Dyes And Pigments', 'Chemicals', 'Commodities', 'Chem'],
                          ['BBB', '01-JAN-2000', '', '', '', '']],
                   header=['Stock Name', 'Listing Date', 'Basic Industry', 'Sector', 'Macro Sector', 'Industry Group'])
    state = bsc.load_previous(str(path))
    assert list(state) == ['AAA']                                    # BBB has no classification
    assert state['AAA']['src'] == 'company' and state['AAA']['at'] == date.today().isoformat()   # file mtime


def test_load_previous_uses_the_first_existing_path(tmp_path):
    path = tmp_path / 'map.csv'
    _write_mapping(path, [['AAA', '', 'I', 'S', 'M', 'G', 'walk', '2026-01-01']])
    assert list(bsc.load_previous(str(tmp_path / 'nope.csv'), str(path))) == ['AAA']
    assert bsc.load_previous(str(tmp_path / 'nope.csv')) == {}


# --- main() end to end -------------------------------------------------------

@pytest.fixture
def run(tmp_path, monkeypatch):
    """run(pages, previous=None, *flags) -> (fetched paths, mapping rows). `pages` maps a Screener path to canned
    HTML (any other path behaves like a 404); `previous` is {symbol: (source, fetched date)}, written first as the
    existing Sector-Stock-Mapping.csv, each stock with the TIERS classification."""
    data_dir = tmp_path / 'NSE_DATA'
    data_dir.mkdir()
    (data_dir / 'EQUITY_L.csv').write_text(
        'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\n'
        'BODALCHEM,Bodal,EQ,22-AUG-2011\nNEWCO,New Co,EQ,01-SEP-2026\nGHOST,Ghost,EQ,01-JAN-2000\n'
        'OLDCO,Old Co,EQ,01-JAN-2000\nFRESHCO,Fresh Co,EQ,01-JAN-2000\n', encoding='utf-8')

    def _run(pages, previous=None, *flags):
        if previous is not None:
            _write_mapping(data_dir / 'Sector-Stock-Mapping.csv',
                           [[s, '', TIERS[3], TIERS[1], TIERS[0], TIERS[2], src, at]
                            for s, (src, at) in previous.items()])
        fetched = []
        monkeypatch.setattr(bsc, 'fetch', lambda path, delay: fetched.append(path) or pages.get(path))
        monkeypatch.setattr(sys, 'argv', ['bsc', '--dir', str(tmp_path), '--delay', '0', *flags])
        bsc.main()
        with open(data_dir / 'Sector-Stock-Mapping.csv', encoding='utf-8', newline='') as f:
            return fetched, {r['Stock Name']: r for r in csv.DictReader(f)}
    return _run


def test_main_walks_then_fills_gaps_from_company_pages(run):
    today = date.today().isoformat()
    pages = {
        '/market/': f'<a href="{LEAF}">x</a>',
        LEAF: industry_page(PARENTS, 'Dyes And Pigments', ['BODALCHEM']),
        # NEWCO has no consolidated page (404), so the standalone page is used
        '/company/NEWCO/': company_page(['Financials', 'Financial Services', 'Finance', 'Housing Finance']),
    }
    fetched, rows = run(pages)
    assert rows['BODALCHEM']['Basic Industry'] == 'Dyes And Pigments' and rows['BODALCHEM']['Sector'] == 'Chemicals'
    assert rows['BODALCHEM']['Macro Sector'] == 'Commodities'
    assert rows['BODALCHEM']['Industry Group'] == 'Chemicals & Petrochemicals'
    assert rows['BODALCHEM']['Listing Date'] == '22-AUG-2011'        # listing date comes from EQUITY_L
    assert rows['NEWCO']['Basic Industry'] == 'Housing Finance'      # a listing no earlier mapping had
    assert '/company/NEWCO/consolidated/' in fetched and '/company/NEWCO/' in fetched
    assert '/company/BODALCHEM/consolidated/' not in fetched         # the walk already covered it
    assert (rows['BODALCHEM']['Source'], rows['BODALCHEM']['Fetched']) == ('walk', today)
    assert (rows['NEWCO']['Source'], rows['NEWCO']['Fetched']) == ('company', today)


def test_only_nse_symbols_are_kept(run):
    pages = {'/market/': f'<a href="{LEAF}">x</a>',
             LEAF: industry_page(PARENTS, 'Dyes And Pigments', ['BODALCHEM', '506854', 'BSEONLY'])}
    _, rows = run(pages)
    assert list(rows) == SYMBOLS                                     # the walk saw BSE-only companies; none are kept


def test_main_writes_unclassifiable_stocks_with_blank_tiers(run):
    _, rows = run({'/market/': ''})
    assert rows['GHOST']['Sector'] == '' and rows['GHOST']['Basic Industry'] == ''
    assert rows['GHOST']['Source'] == '' and rows['GHOST']['Fetched'] == ''
    assert list(rows) == SYMBOLS                                     # every EQUITY_L symbol gets a row


def test_main_output_columns(run, tmp_path):
    run({'/market/': ''})
    header = (tmp_path / 'NSE_DATA' / 'Sector-Stock-Mapping.csv').read_text(encoding='utf-8').splitlines()[0]
    assert header == 'Stock Name,Listing Date,Basic Industry,Sector,Macro Sector,Industry Group,Source,Fetched'


def test_main_also_writes_the_git_tracked_copy_in_reference_data(run, tmp_path):
    run({'/market/': ''})
    live = (tmp_path / 'NSE_DATA' / 'Sector-Stock-Mapping.csv').read_bytes()
    assert (tmp_path / 'reference-data' / 'Sector-Stock-Mapping.csv').read_bytes() == live


def test_a_fresh_clone_starts_from_the_tracked_copy(run, tmp_path):
    """No NSE_DATA mapping yet, but reference-data/ has one: nothing needs re-fetching under --skip-walk."""
    ref = tmp_path / 'reference-data'
    ref.mkdir()
    today = date.today().isoformat()
    _write_mapping(ref / 'Sector-Stock-Mapping.csv',
                   [[s, '', TIERS[3], TIERS[1], TIERS[0], TIERS[2], 'company', today] for s in SYMBOLS])
    fetched, rows = run({}, None, '--skip-walk')
    assert fetched == []
    assert rows['GHOST']['Basic Industry'] == 'Dyes And Pigments'


def test_skip_walk_only_refetches_missing_and_expired_company_entries(run):
    today = date.today().isoformat()
    old = (date.today() - timedelta(days=45)).isoformat()
    previous = {'BODALCHEM': ('walk', today), 'FRESHCO': ('company', today), 'OLDCO': ('company', old)}
    fetched, rows = run({}, previous, '--skip-walk')
    assert '/market/' not in fetched                                 # no industry walk
    assert {p.split('/')[2] for p in fetched} == {'NEWCO', 'GHOST', 'OLDCO'}   # missing + expired only
    assert rows['FRESHCO']['Fetched'] == today and rows['OLDCO']['Fetched'] == old   # 404s keep the old entry


def test_max_age_days_controls_expiry(run):
    ten_days_ago = (date.today() - timedelta(days=10)).isoformat()
    previous = {s: ('company', ten_days_ago) for s in SYMBOLS}
    fetched, _ = run({}, previous, '--skip-walk', '--max-age-days', '5')
    assert len(fetched) == 10                                        # 5 stocks x (consolidated + standalone)
    fetched, _ = run({}, previous, '--skip-walk', '--max-age-days', '30')
    assert fetched == []


def test_stale_walk_entry_is_refetched_when_the_walk_no_longer_returns_it(run):
    old = (date.today() - timedelta(days=3)).isoformat()
    previous = {s: ('company', date.today().isoformat()) for s in SYMBOLS[1:]}
    previous['BODALCHEM'] = ('walk', old)
    fetched, _ = run({'/market/': ''}, previous)                     # walk finds nothing today
    assert '/company/BODALCHEM/consolidated/' in fetched

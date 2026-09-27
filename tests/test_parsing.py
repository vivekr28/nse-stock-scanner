"""Phase 1: pure-function unit tests for parsing/factor logic in src/nse_server.py.

No I/O, no synthetic files - every function here takes plain values and returns
plain values. Many cases are the exact real-world subject strings/numbers this
project has hit live (see each function's own docstring/comment block in
nse_server.py and AGENT.md's "Rights-Issue Price Adjustment" section).
"""
from datetime import datetime

import pytest

import nse_server as ns


# ─── parse_num ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize('raw, expected', [
    ('123.45', 123.45),
    ('0', 0.0),
    ('-12.5', -12.5),
    ('1,234.5', 1234.5),      # comma-thousands
    ('', None),
    ('-', None),
    (None, None),
])
def test_parse_num(raw, expected):
    assert ns.parse_num(raw) == expected


def test_parse_num_garbage_returns_none():
    assert ns.parse_num('not-a-number') is None


# ─── parse_date_str ─────────────────────────────────────────────────────────

@pytest.mark.parametrize('raw, expected', [
    ('04-Sep-2024', datetime(2024, 9, 4)),
    ('2024-09-04', datetime(2024, 9, 4)),
])
def test_parse_date_str_valid(raw, expected):
    assert ns.parse_date_str(raw) == expected


@pytest.mark.parametrize('raw', ['', None, 'garbage', '31-Feb-2024', '2024/09/04'])
def test_parse_date_str_invalid(raw):
    assert ns.parse_date_str(raw) is None


# ─── normalize_symbol ───────────────────────────────────────────────────────

@pytest.mark.parametrize('raw, expected', [
    ('TCS', 'tcs'),
    ('  TCS  ', 'tcs'),
    ('M&MFIN', 'm_mfin'),
    ('L&T-FH', 'l_t_fh'),
    ('', ''),
    (None, ''),
])
def test_normalize_symbol(raw, expected):
    assert ns.normalize_symbol(raw) == expected


# ─── find_col ────────────────────────────────────────────────────────────────

def test_find_col_exact_match():
    row = {'ISIN': 'X', 'SYMBOL': 'Y'}
    assert ns.find_col(row, ['ISIN', 'Isin']) == 'ISIN'


def test_find_col_case_and_space_insensitive():
    row = {'company name': 'Y'}
    assert ns.find_col(row, ['COMPANY_NAME', 'CompanyName']) == 'company name'


def test_find_col_no_match_falls_back_to_first_candidate():
    row = {'SOMETHING_ELSE': 'Y'}
    assert ns.find_col(row, ['ISIN', 'Isin']) == 'ISIN'


def test_find_col_empty_candidates_returns_none():
    assert ns.find_col({'A': '1'}, []) is None


# ─── parse_corp_action_ratio (bonus / split / consolidation) ────────────────

@pytest.mark.parametrize('subject, expected', [
    ('Bonus 2:1', 3.0),                          # 2 new per 1 held -> (2+1)/1
    ('Bonus- 1:1', 2.0),
    ('Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share', 10.0),
    ('Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 5/- Per Share', 2.0),
    ('Consolidation Of Equity Shares From Re 1 Per Share To Rs 10 Per Share', 0.1),
])
def test_parse_corp_action_ratio_recognized(subject, expected):
    assert ns.parse_corp_action_ratio(subject) == pytest.approx(expected)


def test_parse_corp_action_ratio_combined_bonus_and_split():
    # BONUS_RE requires its digits to be immediately followed by '/' or end-of-string
    # (see its comment: real combined pre-2022 subjects use "And"/different wording and
    # aren't matched at all, by design). This subject is synthetic, built only to exercise
    # the ratio *= fvs_ratio combining code path: Bonus 1:1 (ratio 2) x FVS 10->5 (ratio 2).
    subject = 'Bonus 1:1/Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 5/- Per Share'
    assert ns.parse_corp_action_ratio(subject) == pytest.approx(4.0)


@pytest.mark.parametrize('subject', [
    'Demerger',
    'Bonus Ncrps 3:1',
    'Scheme Of Arrangement - Bonus Ncrps 46:1',
    'Capital Reduction',
    'Capital Reduction Pursuant To Nclt Order',
    '',
    None,
])
def test_parse_corp_action_ratio_unrecognized(subject):
    assert ns.parse_corp_action_ratio(subject) is None


# ─── parse_rights_terms ──────────────────────────────────────────────────────

@pytest.mark.parametrize('subject, expected', [
    ('Rights 3:25 @ Premium Rs 1799/-', (3.0, 25.0, 1799.0)),
    ('Rights 10:121@ Premium Rs 38/-', (10.0, 121.0, 38.0)),
    ('Rights 11: 50 @ Premium Rs 0/-', (11.0, 50.0, 0.0)),
    ('Rights 7:10 @ Prm Rs 102/-', (7.0, 10.0, 102.0)),
    ('Rights 1:1 @ Premium Re 1/-', (1.0, 1.0, 1.0)),
    ('Rights 3:2 @ Premium Re. 0.63/-', (3.0, 2.0, 0.63)),
    ('Rights 1:9 @ Premium 91', (1.0, 9.0, 91.0)),
    ('Rights 161:250 @ Premium Re 0.45 /-', (161.0, 250.0, 0.45)),
    ('Rights 36:311 @ Premium Rs 3.86', (36.0, 311.0, 3.86)),
    ('Rights 1:19.07 @ Premium Rs 0', (1.0, 19.07, 0.0)),
    ('Rights 1:6 @ Premium Rs 49/-', (1.0, 6.0, 49.0)),
])
def test_parse_rights_terms_recognized(subject, expected):
    assert ns.parse_rights_terms(subject) == expected


@pytest.mark.parametrize('subject', [
    'Rights - 7 Ccps And 7 Warrants:40',
    'Rights 10:63',
    'Rights',
    'Bonus 1:1',
    'Demerger',
    'Rights 0:5 @ Premium Rs 3/-',   # zero new-shares ratio: rejected, not guessed at
    '',
    None,
])
def test_parse_rights_terms_rejected(subject):
    assert ns.parse_rights_terms(subject) is None


# ─── parse_face_value_ratio ──────────────────────────────────────────────────

def test_parse_face_value_ratio_split():
    subject = 'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share'
    assert ns.parse_face_value_ratio(subject) == pytest.approx(10.0)


def test_parse_face_value_ratio_consolidation():
    subject = 'Consolidation Of Equity Shares From Re 1 Per Share To Rs 10 Per Share'
    assert ns.parse_face_value_ratio(subject) == pytest.approx(0.1)


@pytest.mark.parametrize('subject', ['Bonus 1:1', 'Demerger', '', None])
def test_parse_face_value_ratio_non_matching(subject):
    assert ns.parse_face_value_ratio(subject) is None


# ─── rights_price_factor ─────────────────────────────────────────────────────

def test_rights_price_factor_matches_real_adanient_case():
    # ADANIENT: Rights 3:25 @ premium Rs 1799, face value Rs 1, cum-rights close 2516.80.
    # TradingView's own factor for this event was x0.9699 (see verification report).
    factor = ns.rights_price_factor(2516.80, 3, 25, 1799 + 1)
    assert factor == pytest.approx(0.9699, abs=5e-4)


def test_rights_price_factor_issue_price_at_market_no_dilution():
    assert ns.rights_price_factor(100, 1, 1, 100) is None


def test_rights_price_factor_issue_price_above_market_no_dilution():
    assert ns.rights_price_factor(100, 1, 1, 120) is None


def test_rights_price_factor_zero_cum_close():
    assert ns.rights_price_factor(0, 1, 1, 10) is None


def test_rights_price_factor_negative_cum_close():
    assert ns.rights_price_factor(-5, 1, 1, 10) is None


def test_rights_price_factor_zero_issue_price_is_valid_and_maximally_dilutive():
    # 1:1 at a subscription price of 0 halves the theoretical ex-rights price.
    assert ns.rights_price_factor(100, 1, 1, 0) == pytest.approx(0.5)


# ─── fv_at_ex_date ────────────────────────────────────────────────────────────

def test_fv_at_ex_date_no_splits_in_between():
    fv_asof = datetime(2026, 9, 27)
    ex_dt = datetime(2025, 3, 10)
    assert ns.fv_at_ex_date(1, fv_asof, ex_dt, []) == 1


def test_fv_at_ex_date_split_between_ex_date_and_asof_is_undone():
    # ABINFRA: rights 10-Mar-2025, feed reports FV 1 as of 27-Sep-2026, and a
    # 10->1 split happened in between - the face value at the ex-date was 10.
    fv_asof = datetime(2026, 9, 27)
    ex_dt = datetime(2025, 3, 10)
    split_ratios = [(datetime(2025, 7, 1), 10.0)]
    assert ns.fv_at_ex_date(1, fv_asof, ex_dt, split_ratios) == 10


def test_fv_at_ex_date_split_before_ex_date_already_reflected_not_undone():
    fv_asof = datetime(2026, 9, 27)
    ex_dt = datetime(2025, 3, 10)
    split_ratios = [(datetime(2025, 1, 1), 10.0)]  # split predates the rights event itself
    assert ns.fv_at_ex_date(1, fv_asof, ex_dt, split_ratios) == 1


def test_fv_at_ex_date_split_after_asof_not_yet_reflected_not_undone():
    fv_asof = datetime(2025, 6, 1)
    ex_dt = datetime(2025, 3, 10)
    split_ratios = [(datetime(2025, 7, 1), 10.0)]  # split happens after FV was read
    assert ns.fv_at_ex_date(1, fv_asof, ex_dt, split_ratios) == 1


def test_fv_at_ex_date_two_compounding_splits():
    fv_asof = datetime(2026, 9, 27)
    ex_dt = datetime(2025, 3, 10)
    split_ratios = [(datetime(2025, 4, 1), 2.0), (datetime(2025, 5, 1), 5.0)]
    assert ns.fv_at_ex_date(1, fv_asof, ex_dt, split_ratios) == pytest.approx(10.0)


# ─── correction_key ───────────────────────────────────────────────────────────

def test_correction_key_normalizes_symbol_and_date():
    a = ns.correction_key('  tcs  ', '04-Sep-2024')
    b = ns.correction_key('TCS', '04-Sep-2024')
    assert a == b


def test_correction_key_different_symbols_differ():
    a = ns.correction_key('TCS', '04-Sep-2024')
    b = ns.correction_key('INFY', '04-Sep-2024')
    assert a != b


def test_correction_key_invalid_date_gives_none_component():
    key = ns.correction_key('TCS', 'not-a-date')
    assert key == ('tcs', None)

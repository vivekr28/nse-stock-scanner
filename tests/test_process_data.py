"""Phase 2: small-fixture end-to-end process_data() tests.

Builds a tiny (9-symbol, 15-trading-day) synthetic NSE_Bhavcopy_Combined.csv +
CorporateActions.csv + TradingViewAdjustments.csv and runs the real
process_data() against it, asserting on the actual output shape. This is the
tier that would have caught the 27-Sep-2026 incident: a stale/malformed
combined CSV silently produced zero processed stocks with no error anywhere.

Every expected adjusted value below was hand-derived (see the PR description /
commit message for the full derivation) and, for the rights-issue cases, cross-
checked against the already-unit-tested rights_price_factor()/fv_at_ex_date()
directly, rather than hardcoded - Phase 1 already covers the correctness of
those formulas in isolation; what's under test here is that process_data()
*wires them up correctly* end-to-end (CSV parsing -> event extraction -> cum-
close lookup -> application), which is a different, integration-level class of
bug from anything Phase 1 can catch.
"""
from datetime import date

import pytest

import nse_server as ns
from conftest import business_days, bhav_row, corp_action_row, tv_adjustment_row, decode_daily

DAYS = business_days(date(2025, 9, 1), 15)  # 15 weekdays, index 0..14 ("day 1".."day 15")

PLAINCO = 'INE1PLA01011'
BONUSCO = 'INE2BON01011'
SPLITCO = 'INE3SPL01011'
RIGHTSCO = 'INE4RGT01011'
RIGHTSFVCO = 'INE5RFV01011'
DEMERGERCO = 'INE6DEM01011'
UNHANDLEDCO = 'INE7UNH01011'
ISINCHANGECO_OLD = 'INE8ISN01012'
ISINCHANGECO_NEW = 'INE8ISN01020'  # same 10-char issuer prefix as _OLD, last 2 digits differ
STALECO = 'INE9STL01011'


def _build_scenario(project):
    """Writes the full 9-symbol fixture (see module docstring) into `project`."""
    bhav_rows = []

    def add(symbol, isin, closes, prevs=None):
        prevs = prevs or ([closes[0]] + closes[:-1])
        for i, d in enumerate(DAYS[:len(closes)]):
            bhav_rows.append(bhav_row(symbol, 'EQ', d, closes[i], isin, prev=prevs[i]))

    # Interleave by symbol is fine for correctness, but real bhavcopy files are laid out
    # day-block by day-block (all symbols per day) - do the same here so symbol_to_isin's
    # "last row wins" resolution genuinely exercises chronological file order, not
    # incidental dict/list ordering (matters for ISINCHANGECO below).
    plain_close = [100 + i for i in range(15)]
    bonus_close = [200] * 5 + [100] * 10
    split_close = [400] * 6 + [200] * 9
    rights_close = [130] * 7 + [70] * 8
    rightsfv_close = [130] * 5 + [70] * 5 + [7.0] * 5
    demerger_close = [500] * 8 + [300] * 7
    unhandled_close = [50] * 15
    isinchange_old_close = [800] * 7
    isinchange_new_close = [400] * 8
    stale_close = [90] * 10

    for i, d in enumerate(DAYS):
        bhav_rows.append(bhav_row('PLAINCO', 'EQ', d, plain_close[i], PLAINCO,
                                   prev=(plain_close[i - 1] if i else plain_close[0])))
        bhav_rows.append(bhav_row('BONUSCO', 'EQ', d, bonus_close[i], BONUSCO,
                                   prev=(bonus_close[i - 1] if i else bonus_close[0])))
        bhav_rows.append(bhav_row('SPLITCO', 'EQ', d, split_close[i], SPLITCO,
                                   prev=(split_close[i - 1] if i else split_close[0])))
        bhav_rows.append(bhav_row('RIGHTSCO', 'EQ', d, rights_close[i], RIGHTSCO,
                                   prev=(rights_close[i - 1] if i else rights_close[0])))
        bhav_rows.append(bhav_row('RIGHTSFVCO', 'EQ', d, rightsfv_close[i], RIGHTSFVCO,
                                   prev=(rightsfv_close[i - 1] if i else rightsfv_close[0])))
        bhav_rows.append(bhav_row('DEMERGERCO', 'EQ', d, demerger_close[i], DEMERGERCO,
                                   prev=(demerger_close[i - 1] if i else demerger_close[0])))
        bhav_rows.append(bhav_row('UNHANDLEDCO', 'EQ', d, unhandled_close[i], UNHANDLEDCO,
                                   prev=(unhandled_close[i - 1] if i else unhandled_close[0])))
        if i < 7:
            bhav_rows.append(bhav_row('ISINCHANGECO', 'EQ', d, isinchange_old_close[i], ISINCHANGECO_OLD,
                                       prev=(isinchange_old_close[i - 1] if i else isinchange_old_close[0])))
        else:
            j = i - 7
            prev_val = isinchange_old_close[6] if j == 0 else isinchange_new_close[j - 1]
            bhav_rows.append(bhav_row('ISINCHANGECO', 'EQ', d, isinchange_new_close[j], ISINCHANGECO_NEW, prev=prev_val))
        if i < 10:
            bhav_rows.append(bhav_row('STALECO', 'EQ', d, stale_close[i], STALECO,
                                       prev=(stale_close[i - 1] if i else stale_close[0])))

    project.write_bhavcopy(bhav_rows)

    project.write_corp_actions([
        corp_action_row(BONUSCO, 'BONUSCO', DAYS[5], 'Bonus 1:1'),
        corp_action_row(SPLITCO, 'SPLITCO', DAYS[6],
                         'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 5/- Per Share'),
        corp_action_row(RIGHTSCO, 'RIGHTSCO', DAYS[7], 'Rights 1:1 @ Premium Rs 0/-',
                         faceval=10, fv_asof=DAYS[14]),
        corp_action_row(RIGHTSFVCO, 'RIGHTSFVCO', DAYS[5], 'Rights 1:1 @ Premium Rs 0/-',
                         faceval=1, fv_asof=DAYS[14]),
        corp_action_row(RIGHTSFVCO, 'RIGHTSFVCO', DAYS[10],
                         'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share'),
        corp_action_row(DEMERGERCO, 'DEMERGERCO', DAYS[8], 'Demerger'),
        corp_action_row(UNHANDLEDCO, 'UNHANDLEDCO', DAYS[9], 'Capital Reduction'),
        corp_action_row(ISINCHANGECO_NEW, 'ISINCHANGECO', DAYS[7],
                         'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 5/- Per Share'),
    ])

    project.write_tv_adjustments([
        tv_adjustment_row(DEMERGERCO, 'DEMERGERCO', DAYS[8], 0.6,
                           note='Pre-ex-date prices scaled by 0.60000 to match TradingView (raw ex-date move -40.0%)'),
    ])


@pytest.fixture
def data(project):
    """Runs the real process_data() against the built scenario once per test."""
    _build_scenario(project)
    result = ns.process_data(project.base_dir)
    assert result is not None
    return result


# ─── Baseline sanity (the class of check that would have caught 27-Sep-2026) ───

def test_process_data_produces_nonempty_output(data):
    assert len(data['dailyBySymbol']) > 0
    assert len(data['latestBySymbol']) > 0


def test_process_data_stock_count_matches_active_symbols(data):
    # 9 symbols but 10 ISINs (ISINCHANGECO has both an old and a new one), active on
    # the latest day except STALECO and ISINCHANGECO_OLD (subsumed into _NEW by
    # bridging) -> 10 - 2 = 8 active.
    assert len(data['latestBySymbol']) == 8


# ─── The zero-stocks regression itself + the new warning ──────────────────────

def test_malformed_header_reproduces_zero_stocks_bug(project, capsys):
    # The exact 27-Sep-2026 shape: a bhavcopy file whose header lacks ISIN/COMPANY_NAME
    # (an old, pre-CM-UDiFF-migration format) - every row fails the `if not isin`
    # check, silently, so dailyBySymbol ends up empty even though rows were read.
    header = 'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER'
    row = '20MICRONS, EQ, 02-Sep-2024, 316.50, 318.80, 323.80, 316.00, 320.00, 318.50, 319.25, 151582, 483.92, 3528, 78911, 52.06'
    project.write_bhavcopy_raw_header(header, [row])
    result = ns.process_data(project.base_dir)
    assert result is not None
    assert result['dailyBySymbol'] == {}
    # ...but it's no longer silent: the fix added alongside this test prints a specific warning.
    out = capsys.readouterr().out
    assert 'WARNING' in out
    assert 'grouped 0 stocks' in out


def test_valid_fixture_does_not_trigger_the_warning(data, project, capsys):
    # data fixture already ran process_data(); capsys here only captures what happened
    # during THIS test, so re-run explicitly against the same good fixture to check.
    capsys.readouterr()  # clear whatever the `data` fixture's own run already printed
    ns.process_data(project.base_dir)
    out = capsys.readouterr().out
    assert 'WARNING' not in out


# ─── Split/bonus/rights/demerger adjustment correctness, end-to-end ───────────

def test_plain_stock_prices_untouched(data):
    days = decode_daily(data, PLAINCO)
    assert len(days) == 15
    assert [d['close'] for d in days] == [100 + i for i in range(15)]


def test_bonus_adjustment_continuous_and_prev_boundary_correct(data):
    days = decode_daily(data, BONUSCO)
    assert len(days) == 15
    closes = [d['close'] for d in days]
    assert closes == [100.0] * 15  # 200/2 pre-event, 100 unchanged post-event - fully continuous
    # The ex-date row's own `prev` must be adjusted too (boundary is <= exDate, not the day
    # after) - otherwise day 6 would show a fake -50% changePct. This is the exact bug
    # documented in AGENT.md's "prev-field boundary fix".
    assert days[5]['prev'] == 100.0


def test_split_adjustment_continuous_and_prev_boundary_correct(data):
    days = decode_daily(data, SPLITCO)
    closes = [d['close'] for d in days]
    assert closes == [200.0] * 15
    assert days[6]['prev'] == 200.0  # ex-date row's prev, via the FVS path this time


def test_rights_adjustment_matches_computed_terp_factor(data):
    # Cross-check against the already-unit-tested formula directly, rather than a
    # hardcoded expected value - this test is about correct WIRING, not re-deriving
    # the math (Phase 1 already covers rights_price_factor's own correctness).
    factor = ns.rights_price_factor(130, 1, 1, 10)
    days = decode_daily(data, RIGHTSCO)
    closes = [d['close'] for d in days]
    expected_pre = round(130 * factor, 2)
    assert closes == [expected_pre] * 7 + [70.0] * 8
    assert days[7]['prev'] == expected_pre  # ex-date row's prev boundary


def test_rights_with_face_value_rolled_back_through_later_split(data):
    # RIGHTSFVCO's stored FACEVAL (1) is the value AS OF the later split, not what was
    # in force at the rights ex-date (10) - if fv_at_ex_date() didn't roll it back, the
    # factor (and thus every adjusted price) would be wrong. Composing the rights factor
    # with the later 10:1 split happens to make the whole 15-day series exactly flat.
    days = decode_daily(data, RIGHTSFVCO)
    closes = [d['close'] for d in days]
    prevs = [d['prev'] for d in days]
    assert closes == pytest.approx([7.0] * 15, abs=1e-6)
    assert prevs == pytest.approx([7.0] * 15, abs=1e-6)


def test_demerger_correction_from_tv_adjustments_applied(data):
    days = decode_daily(data, DEMERGERCO)
    closes = [d['close'] for d in days]
    assert closes == [300.0] * 15
    assert days[8]['prev'] == 300.0  # ex-date row's prev boundary


def test_unhandled_corp_action_leaves_prices_untouched_and_is_listed(data):
    days = decode_daily(data, UNHANDLEDCO)
    assert [d['close'] for d in days] == [50.0] * 15  # Capital Reduction: not a ratio, not guessed at

    unhandled = [e for e in data['unadjustedCorpActions'] if e['symbol'] == 'UNHANDLEDCO']
    assert len(unhandled) == 1
    assert unhandled[0]['subject'] == 'Capital Reduction'

    adjusted_symbols = {e['symbol'] for e in data['adjustedCorpActions']}
    assert 'UNHANDLEDCO' not in adjusted_symbols


def test_isin_bridging_merges_old_isin_history_and_adjusts_across_it(data):
    # The old ISIN's own (now-stale, unbridged) entry must not appear in the final output.
    assert ISINCHANGECO_OLD not in data['dailyBySymbol']
    assert ISINCHANGECO_OLD not in data['latestBySymbol']

    days = decode_daily(data, ISINCHANGECO_NEW)
    assert len(days) == 15  # 7 bridged-in old-ISIN rows + 8 native new-ISIN rows
    closes = [d['close'] for d in days]
    assert closes == [400.0] * 15  # 800/2 pre-split (bridged), 400 unchanged post-split - continuous
    assert days[7]['prev'] == 400.0  # crosses BOTH the ISIN-bridge boundary and the split boundary


def test_stale_stock_excluded_from_output_but_recorded(data):
    assert STALECO not in data['latestBySymbol']
    assert STALECO not in data['dailyBySymbol']
    stale_entry = next((s for s in data['staleStocks'] if s['symbol'] == 'STALECO'), None)
    assert stale_entry is not None
    assert stale_entry['lastTradeDate'] == DAYS[9].strftime('%d-%b-%Y')


# ─── adjustedCorpActions listing ───────────────────────────────────────────────

def test_adjusted_corp_actions_lists_expected_kinds(data):
    by_symbol = {e['symbol']: e for e in data['adjustedCorpActions']}
    assert by_symbol['BONUSCO']['kind'] == 'split-bonus'
    assert by_symbol['SPLITCO']['kind'] == 'split-bonus'
    assert by_symbol['RIGHTSCO']['kind'] == 'rights'
    assert by_symbol['RIGHTSFVCO']['kind'] == 'rights'
    assert by_symbol['DEMERGERCO']['kind'] == 'tv-correction'
    assert by_symbol['ISINCHANGECO']['kind'] == 'split-bonus'
    assert 'UNHANDLEDCO' not in by_symbol


def test_demerger_correction_detail_carries_the_note_through(data):
    entry = next(e for e in data['adjustedCorpActions'] if e['symbol'] == 'DEMERGERCO')
    assert entry['detail'] == 'Pre-ex-date prices scaled by 0.60000 to match TradingView (raw ex-date move -40.0%)'


def test_demerger_removed_from_unadjusted_once_corrected(data):
    unadjusted_symbols = {e['symbol'] for e in data['unadjustedCorpActions']}
    assert 'DEMERGERCO' not in unadjusted_symbols

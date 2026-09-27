"""Phase 6: one real-data smoke test, against the actual project's NSE_DATA/ on disk.

Marked `slow` and excluded by default (see pytest.ini's addopts) - unlike every other
test in this suite, this one is NOT hermetic: it reads whatever real bhavcopy/corp-
actions data happens to be on this machine right now, which is git-ignored, not
guaranteed to exist (a fresh clone has none until Download-NSE-Bhavcopy.ps1 runs), and
changes over time as new trading days/corporate actions arrive. That's exactly why it's
only loose sanity bounds, not exact values - the goal is "did something break the whole
pipeline" (a repeat of the 27-Sep-2026 zero-stocks incident being the motivating case),
not "does today's output match some fixed golden snapshot".

Strictly READ-ONLY: process_data() only reads from disk and returns a dict - it never
writes processed_data.json or anything else itself (that's the caller's job elsewhere
in nse_server.py, which this test deliberately never calls). Run explicitly with:
    pytest -m slow
"""
import os

import pytest

import nse_server as ns
from conftest import REPO_ROOT

BHAV_PATH = os.path.join(REPO_ROOT, 'NSE_DATA', 'NSE_Bhavcopy_Combined.csv')


@pytest.mark.slow
def test_real_data_processes_without_error_and_within_plausible_bounds(capsys):
    if not os.path.exists(BHAV_PATH):
        pytest.skip(f'No real NSE_DATA at {BHAV_PATH} - run Download-NSE-Bhavcopy.ps1 first '
                    f'to exercise this test (it is opt-in and never runs in CI for this reason).')

    result = ns.process_data(REPO_ROOT)

    assert result is not None, 'process_data() returned None against real data'

    # Loose bounds, not exact counts - the real universe drifts over time (new listings,
    # delistings). The point is catching a *pipeline* failure (all-or-nothing), not
    # tracking the exact stock count.
    n = len(result['dailyBySymbol'])
    assert 1000 < n < 10000, (
        f'{n} stocks processed - implausible either way for the whole NSE EQ+BE universe; '
        f'the 27-Sep-2026 incident looked exactly like this, but at n=0')
    assert len(result['latestBySymbol']) > 0

    # The exact regression this phase exists to catch: a stale/malformed combined CSV
    # silently producing zero stocks used to print nothing at all - now it would print
    # this specific warning (see process_data(), added alongside the Phase 2 tests).
    # On healthy real data it must NOT appear.
    out = capsys.readouterr().out
    assert 'WARNING' not in out, f'process_data() warned against real data:\n{out}'

    # dailyCols/adjustedCorpActions/unadjustedCorpActions are always present, even if empty.
    assert result['dailyCols']
    assert isinstance(result['adjustedCorpActions'], list)
    assert isinstance(result['unadjustedCorpActions'], list)

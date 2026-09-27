"""Shared pytest fixtures/setup for the whole suite.

src/ has no __init__.py (this project is a flat stdlib-only script layout, not
a package - see AGENT.md), so tests import nse_server/tv_adjust/tv_report as
top-level modules with src/ added to sys.path here, once, for the whole run.
"""
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(REPO_ROOT, 'src')
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

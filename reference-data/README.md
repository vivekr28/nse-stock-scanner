# reference-data

Small data files that are **tracked in git on purpose**. Unlike `NSE_DATA/` (bulk downloads, git-ignored and
re-downloadable), these can't be recovered from NSE later, so the repo is their backup.

| File | What it is | Written by |
|---|---|---|
| `CorporateActions.csv` | NSE's splits / bonuses / demergers / rights issues (`ISIN, SYMBOL, EXDATE, SUBJECT, FACEVAL, FV_ASOF`; the last two are the face value NSE reported and the date it was read - a rights issue's subscription price needs the face value in force at its ex-date, which the server derives from them). NSE only serves a rolling window, so this file is a permanent **archive**: each download replaces the rows inside NSE's window with its fresh copy and keeps everything older, so events that age out are never lost. Run `Download-NSE-Bhavcopy.ps1 -CorpActionsFrom "01-Jan-2010"` once to archive everything NSE still serves. The server ignores events older than its price history, so the archive can grow safely. | `Download-NSE-Bhavcopy.ps1` (Refresh Data / `Start-Dashboard.ps1`); rows are written sorted by ex-date, symbol, subject so an unchanged feed leaves the file untouched |
| `TradingViewAdjustments.csv` | Price-correction factors derived from TradingView, for corporate actions NSE gives no ratio for (demergers, "Scheme Of Arrangement" restructurings, etc.) (`ISIN, SYMBOL, EXDATE, FACTOR, STATUS, CHECKED_AT, NOTE`). Only rows with `STATUS = adjusted` change prices. Can only be re-derived for events inside the ~510-day price history the dashboard keeps, and needs TradingView. Delete a row to undo that correction. | The Data Quality tab's "Adjust prices from TradingView" button |
| `Sector-Stock-Mapping.csv` | Sector / industry tags for every listed stock (`Stock Name, Listing Date, Basic Industry, Sector, Macro Sector, Industry Group, Source, Fetched`; the last two record where and when each stock was last classified, so the script can refresh only what is stale): NSE's four-tier classification as published by Screener.in. Kept here (rather than only in git-ignored `NSE_DATA/`) because it changes rarely and rebuilding it means ~20 minutes of scraping; `Download-NSE-Bhavcopy.ps1` copies it into `NSE_DATA/` when none exists there. | `python src/build_screener_classification.py` (writes both `NSE_DATA/` and this copy; run monthly or quarterly, then commit) |

Presets live next to this in `scanner-presets/presets.json` (also tracked).

**Keeping the backup current:** these files change when you Refresh Data, click "Adjust prices from TradingView",
or save a preset, so `git status` will show them modified. Commit them when it suits you, e.g.
`git add reference-data scanner-presets && git commit -m "Update reference data"`.

The server reads and writes these paths itself; on startup it also moves any copy left at an old location
(`NSE_DATA/CorporateActions.csv`, `NSE_DATA/DemergerAdjustments.csv`, `reference-data/DemergerAdjustments.csv`, `./presets.json`) into place without
losing anything.

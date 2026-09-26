# reference-data

Small data files that are **tracked in git on purpose**. Unlike `NSE_DATA/` (bulk downloads, git-ignored and
re-downloadable), these can't be recovered from NSE later, so the repo is their backup.

| File | What it is | Written by |
|---|---|---|
| `CorporateActions.csv` | NSE's splits / bonuses / demergers (`ISIN, SYMBOL, EXDATE, SUBJECT`). NSE only serves a rolling ~3-year window and the downloader overwrites this file on every run, so events that age out of that window are gone from NSE for good. Git history keeps them. | `Download-NSE-Bhavcopy.ps1` (Refresh Data / `Start-Dashboard.ps1`); rows are written sorted by ex-date, symbol, subject so an unchanged feed leaves the file untouched |
| `DemergerAdjustments.csv` | Price-correction factors for demergers, derived from TradingView (`ISIN, SYMBOL, EXDATE, FACTOR, STATUS, CHECKED_AT, NOTE`). Only rows with `STATUS = adjusted` change prices. Can only be re-derived for events in the last ~370 days, and needs TradingView. Delete a row to undo that correction. | The Data Quality tab's "Adjust prices from TradingView" button |

Presets live next to this in `scanner-presets/presets.json` (also tracked).

**Keeping the backup current:** these files change when you Refresh Data, click "Adjust prices from TradingView",
or save a preset, so `git status` will show them modified. Commit them when it suits you, e.g.
`git add reference-data scanner-presets && git commit -m "Update reference data"`.

The server reads and writes these paths itself; on startup it also moves any copy left at an old location
(`NSE_DATA/CorporateActions.csv`, `NSE_DATA/DemergerAdjustments.csv`, `./presets.json`) into place without
losing anything.

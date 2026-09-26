<#
.SYNOPSIS
    Downloads NSE Equity Bhavcopy + Price Band data. Double-click to run.
.DESCRIPTION
    - First run: downloads last 1 year of daily bhavcopy + price band CSVs
    - Subsequent runs: incremental download from last available date
    - Use -StartFrom "01-Sep-2024" to backfill older data (skips existing files)
    - Downloads CM-UDiFF format bhavcopy (ZIP with ISIN) + price band
    - Merges all files into combined CSVs for the dashboard
    - Downloads EQUITY_L.csv (master equity list with ISIN mappings)
    - Keeps window open so you can see the results
#>

# -- Parameters ----------------------------------------------------------------
param(
    [string]$StartFrom = "",   # Optional: force start date, e.g. "01-Sep-2024" or "2024-09-01"
    [switch]$NoPause           # Headless (launched by the dashboard's Refresh Data): no key prompts, no server reprocess call
)

# -- Make this script double-click friendly ------------------------------------
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ($ScriptDir) { Set-Location $ScriptDir }

$Host.UI.RawUI.WindowTitle = "NSE Bhavcopy Downloader"

# -- Configuration (case-insensitive folder resolution) ------------------------
function Resolve-FolderCI {
    param([string]$Parent, [string]$Name)
    $match = Get-ChildItem -Path $Parent -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($match) { return $match.FullName }
    return Join-Path $Parent $Name
}

$MergedFolder = Resolve-FolderCI -Parent $ScriptDir -Name "NSE_DATA"
$BhavFolder   = Resolve-FolderCI -Parent $MergedFolder -Name "Bhavcopy"
$BandFolder   = Resolve-FolderCI -Parent $MergedFolder -Name "PriceBand"

# Git-tracked reference data (see reference-data\README.md). The corporate-actions feed is only a rolling
# ~3-year window that this script overwrites on every run, so it is kept in the repo instead of NSE_DATA.
$ReferenceFolder = Resolve-FolderCI -Parent $ScriptDir -Name "reference-data"

# CM-UDiFF format (ZIP containing CSV with ISIN)
$BhavBaseUrl = "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{0}_F_0000.csv.zip"
# Price band URL unchanged
$BandBaseUrl = "https://nsearchives.nseindia.com/content/equities/sec_list_{0}.csv"
# Master equity list with ISIN mappings
$EquityListUrl = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
# Nifty MidSmallcap 400 constituent list (JSON API)
# NSE retired /api/equity-stockIndices; the new gateway takes the short index
# code ("NIFTY MIDSML 400"), not the display name - see getIndexList API.
$MidSmall400Url = "https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=" + [uri]::EscapeDataString("NIFTY MIDSML 400")
# Corporate actions (splits/bonuses, for price back-adjustment) - bulk endpoint,
# one call returns every stock's actions in the date range.
$CorpActionsBaseUrl = "https://www.nseindia.com/api/corporates-corporateActions?index=equities"

# NSE blocks requests without browser-like headers
$Headers = @{
    "User-Agent"       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    "Accept"           = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    "Accept-Language"  = "en-US,en;q=0.9"
    "Accept-Encoding"  = "gzip, deflate"   # never "br": PS 5.1 cannot decode brotli, and one br request poisons the whole NSE session
    "Referer"          = "https://www.nseindia.com/"
}

# For www.nseindia.com JSON API calls (session warm-up + index data). Windows
# PowerShell 5.1's Invoke-WebRequest does not auto-decompress gzip/brotli, and
# Akamai's bot-detection cookie binds the whole session to the encoding the
# requests advertise - verified: a single request sending "br" makes every later
# JSON call return brotli. So no request may advertise br (see $Headers), or
# ConvertFrom-Json fails with "Invalid JSON primitive".
$ApiHeaders = @{
    "User-Agent"      = $Headers["User-Agent"]
    "Accept"          = "application/json, text/plain, */*"
    "Accept-Language" = $Headers["Accept-Language"]
    "Referer"         = $Headers["Referer"]
}

$RetryDelay = 2  # seconds between requests

# Rewrites a file only when its content changed, so a no-op refresh does not bump
# the mtime (nse_server.py reprocesses everything when these files look newer).
function Save-IfChanged {
    param([string]$Path, [string]$Text)
    if ((Test-Path $Path) -and ((Get-Content $Path -Raw -Encoding UTF8) -eq $Text)) { return $false }
    Set-Content -Path $Path -Value $Text -Encoding UTF8 -NoNewline
    return $true
}

# For ZIP extraction
Add-Type -AssemblyName System.IO.Compression.FileSystem

# -- Setup ---------------------------------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

foreach ($dir in @($BhavFolder, $BandFolder, $MergedFolder, $ReferenceFolder)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# -- Determine date range (supports -StartFrom for backfill) -------------------
$EndDate = (Get-Date).Date

# Helper: extract date from either old or new bhavcopy filename
function Get-BhavFileDate {
    param([string]$BaseName)
    # CM-UDiFF format: BhavCopy_CM_YYYYMMDD
    if ($BaseName -match '^BhavCopy_CM_(\d{8})$') {
        try { return [DateTime]::ParseExact($Matches[1], "yyyyMMdd", $null) } catch { return $null }
    }
    return $null
}

if ($StartFrom -ne "") {
    try {
        $StartDate = [DateTime]::Parse($StartFrom)
        Write-Host "`n  Custom start date: $($StartDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Magenta
        Write-Host "  Downloading range: $($StartDate.ToString('dd-MMM-yyyy')) to $($EndDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Magenta
        Write-Host "  (Existing files will be skipped automatically)" -ForegroundColor DarkGray
    }
    catch {
        Write-Host "`n  ERROR: Could not parse StartFrom date '$StartFrom'" -ForegroundColor Red
        Write-Host "  Use format like: 01-Sep-2024 or 2024-09-01" -ForegroundColor Yellow
        if (-not $NoPause) {
            Write-Host "`nPress any key to exit..." -ForegroundColor DarkGray
            $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        }
        exit 1
    }
}
else {
    # Default incremental logic - check Bhavcopy files
    $ExistingFiles = Get-ChildItem -Path $BhavFolder -Filter "*.csv" -ErrorAction SilentlyContinue |
                     Where-Object { $_.BaseName -match '^BhavCopy_CM_\d{8}$' } |
                     ForEach-Object {
                         $dt = Get-BhavFileDate $_.BaseName
                         [PSCustomObject]@{ File = $_; Date = $dt }
                     } |
                     Where-Object { $_.Date -ne $null } |
                     Sort-Object Date -Descending

    # Also check PriceBand files (sec_list_ddMMyyyy.csv)
    $ExistingBandFiles = Get-ChildItem -Path $BandFolder -Filter "sec_list_*.csv" -ErrorAction SilentlyContinue |
                         Where-Object { $_.BaseName -match '^sec_list_\d{8}$' } |
                         ForEach-Object {
                             $dateStr = $_.BaseName -replace '^sec_list_', ''
                             try {
                                 $dt = [DateTime]::ParseExact($dateStr, "ddMMyyyy", $null)
                                 [PSCustomObject]@{ File = $_; Date = $dt }
                             } catch {
                                 $null
                             }
                         } |
                         Where-Object { $_ -ne $null } |
                         Sort-Object Date -Descending

    $LastBhavDate = if ($ExistingFiles.Count -gt 0) { $ExistingFiles[0].Date } else { $null }
    $LastBandDate = if ($ExistingBandFiles.Count -gt 0) { $ExistingBandFiles[0].Date } else { $null }

    if ($LastBhavDate -and $LastBandDate) {
        $LastDate = if ($LastBhavDate -le $LastBandDate) { $LastBhavDate } else { $LastBandDate }
        $StartDate = $LastDate.AddDays(1)
        Write-Host "`n  Last Bhavcopy : $($LastBhavDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
        Write-Host "  Last PriceBand: $($LastBandDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
        if ($LastBhavDate -ne $LastBandDate) {
            Write-Host "  (Using earlier date: $($LastDate.ToString('dd-MMM-yyyy')) to sync both)" -ForegroundColor Yellow
        }
        Write-Host "  Downloading from: $($StartDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
    } elseif ($LastBhavDate) {
        $LastDate  = $LastBhavDate
        $StartDate = $LastDate.AddDays(1)
        Write-Host "`n  Last Bhavcopy : $($LastBhavDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
        Write-Host "  Last PriceBand: (none found)" -ForegroundColor Yellow
        Write-Host "  Downloading from: $($StartDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
    } elseif ($LastBandDate) {
        $LastDate  = $LastBandDate
        $StartDate = $LastDate.AddDays(1)
        Write-Host "`n  Last Bhavcopy : (none found)" -ForegroundColor Yellow
        Write-Host "  Last PriceBand: $($LastBandDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
        Write-Host "  Downloading from: $($StartDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
    } else {
        $StartDate = (Get-Date).AddYears(-1).Date
    }

    if ($LastBhavDate -and $LastBandDate -and $LastBhavDate -ge $EndDate -and $LastBandDate -ge $EndDate) {
        Write-Host "`n  Data is already up to date! Nothing new to download." -ForegroundColor Green
        Write-Host "  Last Bhavcopy : $($LastBhavDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
        Write-Host "  Last PriceBand: $($LastBandDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Cyan
    } elseif ($StartDate -gt $EndDate) {
        Write-Host "`n  Data is already up to date! Nothing new to download." -ForegroundColor Green
    }
}

# -- Initialize NSE session ----------------------------------------------------
Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "  NSE Bhavcopy + Price Band Downloader" -ForegroundColor Yellow
Write-Host "  Range: $($StartDate.ToString('dd-MMM-yyyy')) to $($EndDate.ToString('dd-MMM-yyyy'))" -ForegroundColor Yellow
Write-Host "========================================`n" -ForegroundColor Yellow

Write-Host "Initializing session with NSE..." -ForegroundColor Cyan

$Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
    # Bare homepage often 403s; the market-data page reliably sets the cookies
    # the www.nseindia.com API endpoints (EQUITY_L companion APIs, index data) need.
    # Uses $ApiHeaders (no Accept-Encoding) - see note above.
    $null = Invoke-WebRequest -Uri "https://www.nseindia.com/market-data/live-equity-market" `
        -Headers $ApiHeaders `
        -WebSession $Session `
        -UseBasicParsing `
        -TimeoutSec 30 `
        -ErrorAction Stop
    Write-Host "Session initialized.`n" -ForegroundColor Green
}
catch {
    Write-Host "Warning: Session init failed, will try anyway.`n" -ForegroundColor Yellow
}

# -- Build list of weekdays in range -------------------------------------------
$TradingDays = @()
$d = $StartDate
while ($d -le $EndDate) {
    if ($d.DayOfWeek -ne [DayOfWeek]::Saturday -and $d.DayOfWeek -ne [DayOfWeek]::Sunday) {
        $TradingDays += $d
    }
    $d = $d.AddDays(1)
}

Write-Host "Potential trading days: $($TradingDays.Count)`n" -ForegroundColor Cyan

# -- Helper: download bhavcopy (ZIP) and extract CSV ---------------------------
function Download-BhavFile {
    param(
        [string]$Url,
        [string]$CsvPath,
        [string]$DateLabel
    )

    # Skip if CSV already exists and is valid
    if (Test-Path $CsvPath) {
        $sz = (Get-Item $CsvPath).Length
        if ($sz -gt 500) { return "SKIP" }
    }

    $zipPath = $CsvPath + ".zip"
    try {
        $null = Invoke-WebRequest -Uri $Url `
            -Headers $Headers `
            -WebSession $Session `
            -OutFile $zipPath `
            -UseBasicParsing `
            -TimeoutSec 60 `
            -ErrorAction Stop

        $sz = (Get-Item $zipPath).Length
        if ($sz -gt 500) {
            # Extract CSV from ZIP
            try {
                $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
                $entry = $zip.Entries | Where-Object { $_.Name -like "*.csv" } | Select-Object -First 1
                if ($entry) {
                    $stream = $entry.Open()
                    $fileStream = [System.IO.File]::Create($CsvPath)
                    $stream.CopyTo($fileStream)
                    $fileStream.Close()
                    $stream.Close()
                }
                $zip.Dispose()
                Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

                if ((Test-Path $CsvPath) -and (Get-Item $CsvPath).Length -gt 500) {
                    $csvSz = [math]::Round((Get-Item $CsvPath).Length / 1KB, 1)
                    return "OK|$csvSz"
                }
                else {
                    Remove-Item $CsvPath -Force -ErrorAction SilentlyContinue
                    return "NODATA"
                }
            }
            catch {
                Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
                Remove-Item $CsvPath -Force -ErrorAction SilentlyContinue
                return "FAIL|ZIP extract error: $($_.Exception.Message)"
            }
        }
        else {
            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            return "NODATA"
        }
    }
    catch {
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force -ErrorAction SilentlyContinue }
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 404 -or $code -eq 403) { return "HOLIDAY" }
        return "FAIL|$($_.Exception.Message)"
    }
}

# -- Helper: download price band (plain CSV, unchanged) ------------------------
function Download-BandFile {
    param([string]$Url, [string]$FilePath)

    if (Test-Path $FilePath) {
        $sz = (Get-Item $FilePath).Length
        if ($sz -gt 500) { return "SKIP" }
    }

    try {
        $null = Invoke-WebRequest -Uri $Url `
            -Headers $Headers `
            -WebSession $Session `
            -OutFile $FilePath `
            -UseBasicParsing `
            -TimeoutSec 60 `
            -ErrorAction Stop

        $sz = (Get-Item $FilePath).Length
        if ($sz -gt 500) { return "OK|$([math]::Round($sz/1KB,1))" }
        else { Remove-Item $FilePath -Force -ErrorAction SilentlyContinue; return "NODATA" }
    }
    catch {
        if (Test-Path $FilePath) { Remove-Item $FilePath -Force -ErrorAction SilentlyContinue }
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 404 -or $code -eq 403) { return "HOLIDAY" }
        return "FAIL|$($_.Exception.Message)"
    }
}

# -- Download loop -------------------------------------------------------------
$BhavOK = @(); $BhavFail = @(); $BhavHoliday = @(); $BhavExist = @()
$BandOK = @(); $BandFail = @(); $BandHoliday = @(); $BandExist = @()

foreach ($Day in $TradingDays) {
    $DateStrNew = $Day.ToString("yyyyMMdd")           # For bhavcopy URL
    $DateStrOld = $Day.ToString("ddMMyyyy")           # For price band URL
    $DateLabel  = $Day.ToString("dd-MMM-yyyy")

    # -- Bhavcopy (CM-UDiFF ZIP format) --
    $bhavFile = Join-Path $BhavFolder "BhavCopy_CM_$DateStrNew.csv"
    $bhavUrl  = $BhavBaseUrl -f $DateStrNew
    $bhavResult = Download-BhavFile -Url $bhavUrl -CsvPath $bhavFile -DateLabel $DateLabel

    # -- Price Band (unchanged format) --
    $bandFile = Join-Path $BandFolder "sec_list_$DateStrOld.csv"
    $bandUrl  = $BandBaseUrl -f $DateStrOld
    $bandResult = Download-BandFile -Url $bandUrl -FilePath $bandFile

    # -- Track bhavcopy --
    $bhavStatus = switch -Wildcard ($bhavResult) {
        "OK*"      { $BhavOK += $DateLabel;      "Bhav:OK($($bhavResult.Split('|')[1])KB)" }
        "SKIP"     { $BhavExist += $DateLabel;    "Bhav:EXISTS" }
        "NODATA"   { $BhavHoliday += $DateLabel;  "Bhav:NoData" }
        "HOLIDAY"  { $BhavHoliday += $DateLabel;  "Bhav:Holiday" }
        "FAIL*"    { $BhavFail += $DateLabel;     "Bhav:FAIL" }
    }
    # -- Track price band --
    $bandStatus = switch -Wildcard ($bandResult) {
        "OK*"      { $BandOK += $DateLabel;      "Band:OK($($bandResult.Split('|')[1])KB)" }
        "SKIP"     { $BandExist += $DateLabel;    "Band:EXISTS" }
        "NODATA"   { $BandHoliday += $DateLabel;  "Band:NoData" }
        "HOLIDAY"  { $BandHoliday += $DateLabel;  "Band:Holiday" }
        "FAIL*"    { $BandFail += $DateLabel;     "Band:FAIL" }
    }

    $color = if ($bhavResult -like "OK*" -or $bandResult -like "OK*") { "Green" }
             elseif ($bhavResult -like "FAIL*" -or $bandResult -like "FAIL*") { "Red" }
             else { "DarkGray" }

    Write-Host "  $DateLabel  |  $bhavStatus  |  $bandStatus" -ForegroundColor $color

    if ($bhavResult -like "OK*" -or $bandResult -like "OK*") {
        Start-Sleep -Seconds $RetryDelay
    }
}

# -- Download EQUITY_L.csv (master equity list with ISIN) ----------------------
Write-Host "`nDownloading EQUITY_L.csv (master equity list)..." -ForegroundColor Cyan
$EquityListFile = Join-Path $MergedFolder "EQUITY_L.csv"
try {
    $null = Invoke-WebRequest -Uri $EquityListUrl `
        -Headers $Headers `
        -WebSession $Session `
        -OutFile $EquityListFile `
        -UseBasicParsing `
        -TimeoutSec 30 `
        -ErrorAction Stop
    $elSz = [math]::Round((Get-Item $EquityListFile).Length / 1KB, 1)
    Write-Host "  EQUITY_L.csv downloaded ($elSz KB)" -ForegroundColor Green
}
catch {
    Write-Host "  Warning: Could not download EQUITY_L.csv - $($_.Exception.Message)" -ForegroundColor Yellow
}

# -- Download Nifty MidSmallcap 400 constituent list ---------------------------
Write-Host "`nDownloading MidSmallcap 400 constituents..." -ForegroundColor Cyan
$MidSmall400File = Join-Path $MergedFolder "MidSmallcap400_Constituents.csv"
try {
    $ms400Response = Invoke-WebRequest -Uri $MidSmall400Url `
        -Headers $ApiHeaders `
        -WebSession $Session `
        -UseBasicParsing `
        -TimeoutSec 30 `
        -ErrorAction Stop
    $ms400Json = $ms400Response.Content | ConvertFrom-Json
    $ms400Symbols = @()
    foreach ($stock in $ms400Json.data.data) {
        # The index summary row has series=null; only constituent rows have a series (EQ)
        if ($stock.series -and $stock.symbol) {
            $sym = ($stock.symbol -replace '^\s+|\s+$', '')
            if ($sym) { $ms400Symbols += $sym }
        }
    }
    if ($ms400Symbols.Count -gt 0) {
        $ms400Lines = @("SYMBOL")
        $ms400Lines += $ms400Symbols | Sort-Object
        $ms400Changed = Save-IfChanged $MidSmall400File ($ms400Lines -join "`n")
        Write-Host "  MidSmallcap 400: $($ms400Symbols.Count) stocks $(if ($ms400Changed) { 'updated' } else { 'unchanged' })" -ForegroundColor Green
    } else {
        Write-Host "  Warning: MidSmallcap 400 API returned no stocks" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "  Warning: Could not download MidSmallcap 400 list - $($_.Exception.Message)" -ForegroundColor Yellow
}

# -- Download Corporate Actions (splits/bonuses, for price adjustment) ---------
# Full ~3-year window pulled fresh every run (like MidSmallcap 400 above) rather
# than incrementally - the endpoint is cheap (a few thousand rows even for a
# multi-year range) and this avoids tracking any incremental state. Actual
# ratio parsing happens server-side (nse_server.py); this is just a size filter
# so the CSV doesn't carry every dividend/AGM notice too.
Write-Host "`nDownloading corporate actions (splits/bonuses)..." -ForegroundColor Cyan
$CorpActionsFile = Join-Path $ReferenceFolder "CorporateActions.csv"
$CorpFromDate = (Get-Date).AddYears(-3).ToString("dd-MM-yyyy")
$CorpToDate = (Get-Date).ToString("dd-MM-yyyy")
$CorpActionsUrl = "$CorpActionsBaseUrl&from_date=$CorpFromDate&to_date=$CorpToDate"
try {
    $corpResponse = Invoke-WebRequest -Uri $CorpActionsUrl `
        -Headers $ApiHeaders `
        -WebSession $Session `
        -UseBasicParsing `
        -TimeoutSec 30 `
        -ErrorAction Stop
    $corpJson = $corpResponse.Content | ConvertFrom-Json
    $corpFiltered = $corpJson | Where-Object {
        $_.subject -match '(?i)bonus|split|sub-division|consolidation of equity shares|demerger'
    }
    # NSE returns rows that share an ex-date in an arbitrary order that differs from call to call, which made
    # every download look "changed" (file rewritten, reprocess triggered, noisy git diffs now that the file is
    # tracked). Write them in a stable order instead: ex-date, then symbol, then subject.
    $corpFiltered = @($corpFiltered | Sort-Object `
        @{ Expression = { $d = [datetime]::MinValue
                          if ([datetime]::TryParseExact($_.exDate, 'dd-MMM-yyyy', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$d)) { $d } else { [datetime]::MaxValue } } }, `
        @{ Expression = { $_.symbol } }, `
        @{ Expression = { $_.subject } })
    $corpLines = @("ISIN,SYMBOL,EXDATE,SUBJECT")
    foreach ($row in $corpFiltered) {
        $isin = ($row.isin -replace '"','""')
        $sym = ($row.symbol -replace '"','""')
        $exDate = ($row.exDate -replace '"','""')
        $subj = ($row.subject -replace '"','""').Trim()
        if ($isin -and $exDate -and $subj) {
            $corpLines += "`"$isin`",`"$sym`",`"$exDate`",`"$subj`""
        }
    }
    if ($corpLines.Count -gt 1) {
        $corpChanged = Save-IfChanged $CorpActionsFile ($corpLines -join "`n")
        Write-Host "  Corporate actions: $($corpLines.Count - 1) split/bonus rows $(if ($corpChanged) { 'updated' } else { 'unchanged' }) ($CorpFromDate to $CorpToDate)" -ForegroundColor Green
    } else {
        Write-Host "  Warning: No split/bonus corporate actions found in range" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "  Warning: Could not download corporate actions - $($_.Exception.Message)" -ForegroundColor Yellow
}

# -- Merge Bhavcopy files (supports both old and new format) -------------------
Write-Host "`n----------------------------------------" -ForegroundColor Yellow
Write-Host "Merging bhavcopy files..." -ForegroundColor Cyan

# Gather all bhavcopy CSVs (old + new format), sorted by date
$AllBhav = Get-ChildItem -Path $BhavFolder -Filter "*.csv" -ErrorAction SilentlyContinue |
           Where-Object { $_.BaseName -match '^BhavCopy_CM_\d{8}$' } |
           ForEach-Object {
               $dt = Get-BhavFileDate $_.BaseName
               [PSCustomObject]@{ File = $_; Date = $dt }
           } |
           Where-Object { $_.Date -ne $null } |
           Sort-Object Date

if ($AllBhav.Count -gt 0) {
    $MergedBhav = Join-Path $MergedFolder "NSE_Bhavcopy_Combined.csv"

    # Output header: old column names + ISIN + COMPANY_NAME (backward compatible)
    $outHeader = "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER, ISIN, COMPANY_NAME"

    # Incremental: only process files newer than what's already merged
    $bhavToProcess = $AllBhav
    $bhavAppend = $false
    if (Test-Path $MergedBhav) {
        $tailLines = Get-Content $MergedBhav -Tail 10 | Where-Object { $_.Trim() -ne '' }
        $lastMergedDate = $null
        for ($t = $tailLines.Count - 1; $t -ge 0; $t--) {
            try {
                $dateField = ($tailLines[$t] -split ',')[2].Trim()
                $lastMergedDate = [DateTime]::ParseExact($dateField, "dd-MMM-yyyy", $null)
                break
            } catch { }
        }
        if ($lastMergedDate) {
            $newFiles = @($AllBhav | Where-Object { $_.Date -gt $lastMergedDate })
            if ($newFiles.Count -eq 0) {
                $bhavToProcess = @()
                $sz = [math]::Round((Get-Item $MergedBhav).Length / 1MB, 2)
                Write-Host "  Bhavcopy up to date ($sz MB)" -ForegroundColor Green
            } else {
                $bhavToProcess = $newFiles
                $bhavAppend = $true
                Write-Host "  Incremental: $($AllBhav.Count - $newFiles.Count) cached, $($newFiles.Count) new" -ForegroundColor Cyan
            }
        }
    }

    if ($bhavToProcess.Count -gt 0) {
    $allLines = [System.Collections.Generic.List[string]]::new()
    if (-not $bhavAppend) { $allLines.Add($outHeader) }

    foreach ($entry in $bhavToProcess) {
        $f = $entry.File
        $lines = Get-Content $f.FullName
        if ($lines.Count -lt 2) { continue }

        $headerCols = $lines[0] -split ','
        # Trim header columns for matching
        $headerTrimmed = $headerCols | ForEach-Object { $_.Trim() }

        # -- CM-UDiFF format --
            # Build column index map
            $colMap = @{}
            for ($i = 0; $i -lt $headerTrimmed.Count; $i++) {
                $colMap[$headerTrimmed[$i]] = $i
            }

            $iSctySrs     = if ($colMap.ContainsKey('SctySrs'))        { $colMap['SctySrs'] }        else { -1 }
            $iTckrSymb    = if ($colMap.ContainsKey('TckrSymb'))       { $colMap['TckrSymb'] }       else { -1 }
            $iTradDt      = if ($colMap.ContainsKey('TradDt'))         { $colMap['TradDt'] }         else { -1 }
            $iPrvsClsg    = if ($colMap.ContainsKey('PrvsClsgPric'))   { $colMap['PrvsClsgPric'] }   else { -1 }
            $iOpnPric     = if ($colMap.ContainsKey('OpnPric'))        { $colMap['OpnPric'] }        else { -1 }
            $iHghPric     = if ($colMap.ContainsKey('HghPric'))        { $colMap['HghPric'] }        else { -1 }
            $iLwPric      = if ($colMap.ContainsKey('LwPric'))         { $colMap['LwPric'] }         else { -1 }
            $iLastPric    = if ($colMap.ContainsKey('LastPric'))       { $colMap['LastPric'] }       else { -1 }
            $iClsPric     = if ($colMap.ContainsKey('ClsPric'))        { $colMap['ClsPric'] }        else { -1 }
            $iTtlVol      = if ($colMap.ContainsKey('TtlTradgVol'))   { $colMap['TtlTradgVol'] }    else { -1 }
            $iTtlTrfVal   = if ($colMap.ContainsKey('TtlTrfVal'))     { $colMap['TtlTrfVal'] }      else { -1 }
            $iTtlTxs      = if ($colMap.ContainsKey('TtlNbOfTxsExctd')) { $colMap['TtlNbOfTxsExctd'] } else { -1 }
            $iISIN        = if ($colMap.ContainsKey('ISIN'))           { $colMap['ISIN'] }           else { -1 }
            $iFinNm       = if ($colMap.ContainsKey('FinInstrmNm'))    { $colMap['FinInstrmNm'] }    else { -1 }

            for ($j = 1; $j -lt $lines.Count; $j++) {
                $line = $lines[$j]
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $cols = $line -split ','

                # Filter EQ + BE only
                if ($iSctySrs -ge 0 -and $cols.Count -gt $iSctySrs) {
                    $ser = $cols[$iSctySrs].Trim()
                    if ($ser -ine 'EQ' -and $ser -ine 'BE') { continue }
                }

                # Map CM-UDiFF columns to combined CSV format + append ISIN, COMPANY_NAME
                $symbol    = if ($iTckrSymb -ge 0 -and $cols.Count -gt $iTckrSymb) { $cols[$iTckrSymb].Trim() } else { "" }
                $series    = if ($iSctySrs  -ge 0 -and $cols.Count -gt $iSctySrs)  { $cols[$iSctySrs].Trim() }  else { "" }
                $tradDt    = if ($iTradDt   -ge 0 -and $cols.Count -gt $iTradDt)   { $cols[$iTradDt].Trim() }   else { "" }
                $prevClose = if ($iPrvsClsg -ge 0 -and $cols.Count -gt $iPrvsClsg) { $cols[$iPrvsClsg].Trim() } else { "" }
                $openPr    = if ($iOpnPric  -ge 0 -and $cols.Count -gt $iOpnPric)  { $cols[$iOpnPric].Trim() }  else { "" }
                $highPr    = if ($iHghPric  -ge 0 -and $cols.Count -gt $iHghPric)  { $cols[$iHghPric].Trim() }  else { "" }
                $lowPr     = if ($iLwPric   -ge 0 -and $cols.Count -gt $iLwPric)   { $cols[$iLwPric].Trim() }   else { "" }
                $lastPr    = if ($iLastPric -ge 0 -and $cols.Count -gt $iLastPric) { $cols[$iLastPric].Trim() } else { "" }
                $closePr   = if ($iClsPric  -ge 0 -and $cols.Count -gt $iClsPric)  { $cols[$iClsPric].Trim() }  else { "" }
                $ttlVol    = if ($iTtlVol   -ge 0 -and $cols.Count -gt $iTtlVol)   { $cols[$iTtlVol].Trim() }   else { "" }
                $ttlTxs    = if ($iTtlTxs   -ge 0 -and $cols.Count -gt $iTtlTxs)   { $cols[$iTtlTxs].Trim() }   else { "" }
                $isin      = if ($iISIN     -ge 0 -and $cols.Count -gt $iISIN)     { $cols[$iISIN].Trim() }     else { "" }
                $finNm     = if ($iFinNm    -ge 0 -and $cols.Count -gt $iFinNm)    { $cols[$iFinNm].Trim() }    else { "" }

                # Convert TtlTrfVal (absolute rupees) to lakhs for TURNOVER_LACS
                $turnoverLacs = ""
                if ($iTtlTrfVal -ge 0 -and $cols.Count -gt $iTtlTrfVal) {
                    $rawVal = $cols[$iTtlTrfVal].Trim()
                    if ($rawVal -ne "") {
                        try {
                            $turnoverLacs = [math]::Round([double]$rawVal / 100000, 2)
                        } catch {
                            $turnoverLacs = $rawVal
                        }
                    }
                }

                # Convert date: YYYY-MM-DD -> dd-Mon-YYYY
                $dateOut = $tradDt
                if ($tradDt -match '^\d{4}-\d{2}-\d{2}$') {
                    try {
                        $parsedDt = [DateTime]::ParseExact($tradDt, "yyyy-MM-dd", $null)
                        $dateOut = $parsedDt.ToString("dd-MMM-yyyy")
                    } catch {
                        $dateOut = $tradDt
                    }
                }

                # AVG_PRICE, DELIV_QTY, DELIV_PER not available in new format
                $outLine = " $symbol, $series, $dateOut, $prevClose, $openPr, $highPr, $lowPr, $lastPr, $closePr, , $ttlVol, $turnoverLacs, $ttlTxs, , , $isin, $finNm"
                $allLines.Add($outLine)
            }
        }

    if ($bhavAppend) {
        $allLines | Add-Content $MergedBhav -Encoding UTF8
        $sz = [math]::Round((Get-Item $MergedBhav).Length / 1MB, 2)
        Write-Host "  Appended $($allLines.Count) rows ($sz MB total)" -ForegroundColor Green
    } else {
        $allLines | Set-Content $MergedBhav -Encoding UTF8
        $sz = [math]::Round((Get-Item $MergedBhav).Length / 1MB, 2)
        Write-Host "  Full merge: $($allLines.Count - 1) rows, $sz MB" -ForegroundColor Green
    }
    }
}

# -- Merge Price Band files (incremental) --------------------------------------
Write-Host "Merging price band files..." -ForegroundColor Cyan

$AllBand = Get-ChildItem -Path $BandFolder -Filter "sec_list_*.csv" -ErrorAction SilentlyContinue |
           Sort-Object { $d = $_.BaseName -replace 'sec_list_',''; try { [DateTime]::ParseExact($d,'ddMMyyyy',$null) } catch { [DateTime]::MinValue } }
if ($AllBand.Count -gt 0) {
    $MergedBand = Join-Path $MergedFolder "NSE_PriceBand_Combined.csv"

    # Incremental: only process files newer than the combined file
    $bandToProcess = $AllBand
    $bandAppend = $false
    $bandSeriesIdx = -1
    if (Test-Path $MergedBand) {
        $mergedBandMtime = (Get-Item $MergedBand).LastWriteTime
        $newBandFiles = @($AllBand | Where-Object { $_.LastWriteTime -gt $mergedBandMtime })
        if ($newBandFiles.Count -eq 0) {
            $bandToProcess = @()
            $sz = [math]::Round((Get-Item $MergedBand).Length / 1MB, 2)
            Write-Host "  Price band up to date ($sz MB)" -ForegroundColor Green
        } else {
            $bandToProcess = $newBandFiles
            $bandAppend = $true
            $existingHeader = Get-Content $MergedBand -TotalCount 1
            $headerCols = $existingHeader -split ','
            for ($i = 0; $i -lt $headerCols.Count; $i++) {
                if ($headerCols[$i].Trim() -ieq 'Series' -or $headerCols[$i].Trim() -ieq 'SERIES') {
                    $bandSeriesIdx = $i; break
                }
            }
            Write-Host "  Incremental: $($AllBand.Count - $newBandFiles.Count) cached, $($newBandFiles.Count) new" -ForegroundColor Cyan
        }
    }

    if ($bandToProcess.Count -gt 0) {
    $allBandLines = [System.Collections.Generic.List[string]]::new()
    $bandHeaderDone = $bandAppend
    foreach ($f in $bandToProcess) {
        $lines = Get-Content $f.FullName
        if (-not $bandHeaderDone) {
            $allBandLines.Add($lines[0])
            $headerCols = $lines[0] -split ','
            for ($i = 0; $i -lt $headerCols.Count; $i++) {
                if ($headerCols[$i].Trim() -ieq 'Series' -or $headerCols[$i].Trim() -ieq 'SERIES') {
                    $bandSeriesIdx = $i; break
                }
            }
            $bandHeaderDone = $true
        }
        for ($j = 1; $j -lt $lines.Count; $j++) {
            if ($bandSeriesIdx -ge 0) {
                $cols = $lines[$j] -split ','
                $ser = $cols[$bandSeriesIdx].Trim()
                if ($cols.Count -gt $bandSeriesIdx -and ($ser -ieq 'EQ' -or $ser -ieq 'BE')) {
                    $allBandLines.Add($lines[$j])
                }
            } else {
                $allBandLines.Add($lines[$j])
            }
        }
    }
    if ($bandAppend) {
        $allBandLines | Add-Content $MergedBand -Encoding UTF8
        $sz = [math]::Round((Get-Item $MergedBand).Length / 1MB, 2)
        Write-Host "  Appended $($allBandLines.Count) rows ($sz MB total)" -ForegroundColor Green
    } else {
        $allBandLines | Set-Content $MergedBand -Encoding UTF8
        $sz = [math]::Round((Get-Item $MergedBand).Length / 1MB, 2)
        Write-Host "  Full merge: $($allBandLines.Count - 1) rows, $sz MB" -ForegroundColor Green
    }
    }
}

# -- Copy sector mapping if present --------------------------------------------
$SectorSrc = Join-Path $ScriptDir "Sector-Stock-Mapping.csv"
$SectorDst = Join-Path $MergedFolder "Sector-Stock-Mapping.csv"
if ((Test-Path $SectorSrc) -and -not (Test-Path $SectorDst)) {
    Copy-Item $SectorSrc $SectorDst
    Write-Host "  Copied sector mapping to NSE_Data folder." -ForegroundColor Cyan
}

# -- Detailed Download Summary -------------------------------------------------
Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "  Download Summary" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow

Write-Host "`n  BHAVCOPY (CM-UDiFF):" -ForegroundColor Cyan
if ($BhavOK.Count -gt 0) {
    Write-Host "    Downloaded ($($BhavOK.Count)):" -ForegroundColor Green -NoNewline
    Write-Host "  $($BhavOK -join ', ')" -ForegroundColor White
}
if ($BhavExist.Count -gt 0) {
    Write-Host "    Already had ($($BhavExist.Count)):" -ForegroundColor DarkGray -NoNewline
    Write-Host "  $($BhavExist -join ', ')" -ForegroundColor DarkGray
}
if ($BhavHoliday.Count -gt 0) {
    Write-Host "    Holidays ($($BhavHoliday.Count)):" -ForegroundColor DarkGray -NoNewline
    Write-Host "  $($BhavHoliday -join ', ')" -ForegroundColor DarkGray
}
if ($BhavFail.Count -gt 0) {
    Write-Host "    FAILED ($($BhavFail.Count)):" -ForegroundColor Red -NoNewline
    Write-Host "  $($BhavFail -join ', ')" -ForegroundColor Red
}
if ($BhavOK.Count -eq 0 -and $BhavFail.Count -eq 0 -and $BhavExist.Count -eq 0 -and $BhavHoliday.Count -eq 0) {
    Write-Host "    Nothing to download." -ForegroundColor DarkGray
}

Write-Host "`n  PRICE BAND:" -ForegroundColor Cyan
if ($BandOK.Count -gt 0) {
    Write-Host "    Downloaded ($($BandOK.Count)):" -ForegroundColor Green -NoNewline
    Write-Host "  $($BandOK -join ', ')" -ForegroundColor White
}
if ($BandExist.Count -gt 0) {
    Write-Host "    Already had ($($BandExist.Count)):" -ForegroundColor DarkGray -NoNewline
    Write-Host "  $($BandExist -join ', ')" -ForegroundColor DarkGray
}
if ($BandHoliday.Count -gt 0) {
    Write-Host "    Holidays ($($BandHoliday.Count)):" -ForegroundColor DarkGray -NoNewline
    Write-Host "  $($BandHoliday -join ', ')" -ForegroundColor DarkGray
}
if ($BandFail.Count -gt 0) {
    Write-Host "    FAILED ($($BandFail.Count)):" -ForegroundColor Red -NoNewline
    Write-Host "  $($BandFail -join ', ')" -ForegroundColor Red
}
if ($BandOK.Count -eq 0 -and $BandFail.Count -eq 0 -and $BandExist.Count -eq 0 -and $BandHoliday.Count -eq 0) {
    Write-Host "    Nothing to download." -ForegroundColor DarkGray
}

Write-Host "`n  Output: $MergedFolder" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Yellow

# -- Trigger server reprocessing if running ------------------------------------
$port = 8765
if (-not $NoPause) { try {
    $reprocessResp = Invoke-WebRequest -Uri "http://localhost:$port/api/reprocess" -UseBasicParsing -TimeoutSec 60 -ErrorAction SilentlyContinue
    if ($reprocessResp.StatusCode -eq 200) {
        Write-Host "`n  Server reprocessed data automatically." -ForegroundColor Green
        Write-Host "  Refresh the dashboard to see updated data." -ForegroundColor Cyan
    }
} catch {
    Write-Host "`n  Tip: Run Start-Dashboard.ps1 to launch the dashboard with auto-loading." -ForegroundColor DarkGray
} }

# -- Keep window open ----------------------------------------------------------
if (-not $NoPause) {
    Write-Host "`nPress any key to exit..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

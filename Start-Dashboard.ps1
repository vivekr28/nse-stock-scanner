<#
.SYNOPSIS
    One-click NSE Dashboard launcher. Double-click to run.
.DESCRIPTION
    1. Runs Download-NSE-Bhavcopy.ps1 (the single copy of the download + merge
       code): missing bhavcopy + price band CSVs, EQUITY_L.csv, MidSmallcap 400,
       corporate actions, merged into the combined CSVs
    2. Starts the local dashboard server (nse_server.py) and opens the dashboard
       in your default browser
#>

# -- Parameters ----------------------------------------------------------------
param(
    [string]$StartFrom = ""   # Optional: force start date, e.g. "01-Sep-2024" to backfill older data
)

# -- Make this script double-click friendly ------------------------------------
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if ($ScriptDir) { Set-Location $ScriptDir }

$Host.UI.RawUI.WindowTitle = "NSE Dashboard"


# -- Download + merge NSE data (all logic lives in Download-NSE-Bhavcopy.ps1) --
$DownloadScript = Join-Path $ScriptDir "Download-NSE-Bhavcopy.ps1"
if (-not (Test-Path $DownloadScript)) {
    Write-Host "`n  ERROR: Download-NSE-Bhavcopy.ps1 not found at $DownloadScript" -ForegroundColor Red
    Write-Host "`nPress any key to exit..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

$global:LASTEXITCODE = 0
& $DownloadScript -NoPause -StartFrom $StartFrom
$downloadExit = $LASTEXITCODE
$Host.UI.RawUI.WindowTitle = "NSE Dashboard"   # the downloader sets its own title

if ($downloadExit -ne 0) {
    Write-Host "`n  Download step failed (exit code $downloadExit). Dashboard not launched." -ForegroundColor Red
    Write-Host "`nPress any key to exit..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit $downloadExit
}

# -- Launch Dashboard via Custom Server ----------------------------------------
$DashboardPath = Join-Path $ScriptDir "index.html"
$ServerScript = Join-Path $ScriptDir "nse_server.py"
$port = 8765

if (Test-Path $DashboardPath) {
    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  Launching Dashboard..." -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    # Find Python
    $pythonCmd = $null
    foreach ($cmd in @('python', 'python3', 'py')) {
        $found = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($found) { $pythonCmd = $found.Source; break }
    }

    $serverStarted = $false
    if ($pythonCmd -and (Test-Path $ServerScript)) {
        # Kill any previous server on this port
        try {
            $existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
                        Where-Object { $_.State -eq 'Listen' }
            if ($existing) {
                Stop-Process -Id (Get-Process -Id $existing.OwningProcess -ErrorAction SilentlyContinue).Id -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
            }
        } catch { }

        # -- Windows Job Object: ensures Python server dies when this console closes --
        # When the console window is closed (X button), Windows terminates all processes
        # in the Job Object automatically — no cleanup script needed.
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class JobObject : IDisposable {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr hObject);
    private IntPtr handle;
    public JobObject() {
        handle = CreateJobObject(IntPtr.Zero, null);
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        // Size MUST be 144 bytes on x64 (confirmed via Marshal.SizeOf) — the previous
        // 112-byte buffer made SetInformationJobObject fail silently with
        // ERROR_BAD_LENGTH, so the kill-on-close flag never actually got set and the
        // Python server kept running even after this script's console was closed.
        var info = new byte[144];
        BitConverter.GetBytes((uint)0x2000).CopyTo(info, 16); // LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE at offset 16
        var pinned = GCHandle.Alloc(info, GCHandleType.Pinned);
        bool ok = SetInformationJobObject(handle, 9, pinned.AddrOfPinnedObject(), (uint)info.Length); // 9 = JobObjectExtendedLimitInformation
        pinned.Free();
        if (!ok) throw new InvalidOperationException("SetInformationJobObject failed, error " + Marshal.GetLastWin32Error());
    }
    public void AddProcess(IntPtr processHandle) { AssignProcessToJobObject(handle, processHandle); }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}
"@ -ErrorAction SilentlyContinue

        # Start custom server (it pre-processes data on startup)
        Write-Host "  Starting NSE server (port $port)..." -ForegroundColor Cyan
        Write-Host "  Server will pre-process data on first run." -ForegroundColor DarkGray
        $serverProc = Start-Process -FilePath $pythonCmd -ArgumentList "`"$ServerScript`" --port $port --dir `"$ScriptDir`"" -WorkingDirectory $ScriptDir -WindowStyle Minimized -PassThru

        # Assign server to Job Object so it dies when this console closes
        try {
            $job = New-Object JobObject
            $job.AddProcess($serverProc.Handle)
            Write-Host "  Server tied to this window (will auto-stop on close)." -ForegroundColor DarkGray
        } catch {
            Write-Host "  Warning: Could not bind server to window. You may need to stop it manually." -ForegroundColor Yellow
        }

        Start-Sleep -Milliseconds 500

        # Verify server is up — poll instead of a couple of fixed-length tries, since
        # first-run data pre-processing (or today's larger bhavcopy) can take well
        # over the ~4.5s the old two-shot check allowed, causing a false "failed to
        # start" that fell back to opening index.html as a bare file:// page even
        # though the server was still starting up fine in the background.
        $maxWaitSeconds = 45
        $waited = 0
        while ($waited -lt $maxWaitSeconds) {
            if ($serverProc.HasExited) {
                Write-Host "  Server process exited unexpectedly (exit code $($serverProc.ExitCode))." -ForegroundColor Red
                break
            }
            try {
                $testResp = Invoke-WebRequest -Uri "http://localhost:$port/api/status" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
                if ($testResp.StatusCode -eq 200) {
                    $serverStarted = $true
                    Write-Host "  Server running at http://localhost:$port" -ForegroundColor Green
                    break
                }
            } catch { }
            Start-Sleep -Seconds 1
            $waited++
        }
        if (-not $serverStarted -and -not $serverProc.HasExited) {
            Write-Host "  Server did not respond within ${maxWaitSeconds}s." -ForegroundColor Yellow
        }
    }

    if ($serverStarted) {
        Start-Process "http://localhost:$port/index.html"
        Write-Host "`n  Dashboard opened at http://localhost:$port" -ForegroundColor Cyan
        Write-Host "  Data loads automatically from pre-processed JSON." -ForegroundColor Cyan
        Write-Host "  Presets are saved to presets.json on disk." -ForegroundColor Cyan
        Write-Host "`n  Keep this window open while using the dashboard." -ForegroundColor Yellow
        Write-Host "  Press Ctrl+C or close this window to stop the server." -ForegroundColor DarkGray

        # Keep window open; try/finally ensures server cleanup on Enter, Ctrl+C, or window close
        try {
            Write-Host "`nServer is running. Press Enter to stop..." -ForegroundColor DarkGray
            Read-Host | Out-Null
        } finally {
            if ($serverProc -and -not $serverProc.HasExited) {
                Write-Host "`n  Stopping NSE server (PID $($serverProc.Id))..." -ForegroundColor Yellow
                try { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } catch { }
                Write-Host "  Server stopped." -ForegroundColor Green
            }
            if ($job) { try { $job.Dispose() } catch { } }
        }
    } else {
        # Fallback: open file directly. Clean up the server process first if it's
        # still running (e.g. it was just slow, not actually dead) — otherwise it's
        # left orphaned on $port with nothing managing or stopping it.
        Write-Host "  Could not start server. Opening dashboard directly..." -ForegroundColor Yellow
        if ($serverProc -and -not $serverProc.HasExited) {
            try { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } catch { }
        }
        Start-Process $DashboardPath
        Write-Host "`n  Dashboard opened in your browser." -ForegroundColor Cyan
        Write-Host "  Use the file picker to load CSVs manually." -ForegroundColor DarkGray
        Write-Host "`nThis window will close in 5 seconds..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
} else {
    Write-Host "`n  ERROR: index.html not found at $DashboardPath" -ForegroundColor Red
    Write-Host "`nThis window will close in 5 seconds..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
}

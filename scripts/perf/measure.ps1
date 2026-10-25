<#
.SYNOPSIS
  Story 9.3: measure Switchboard's performance budgets on Windows (see docs/perf.md).

.DESCRIPTION
  Two steps, run against a release build (npm run tauri build -- --no-bundle):

  Start    Cold start, -Runs times (default 5). Each run starts a fresh switchboard.exe and records
           (a) from the outside: Start-Process -> the main window first appears (MainWindowHandle), and
           (b) from the inside: process start -> first canvas frame, which the app appends to a file
               named by SWITCHBOARD_PERF_OUT (an absolute path, a fresh <OutDir>\startup-runN.jsonl per
               run, set for the child only; the app reads it once and removes it from its environment).
           Then the window is closed (WM_CLOSE; killed after a timeout) and the WebView2 processes are
           waited for (any captured at launch and still alive are killed), so the next run is a fresh
           process. Reports raw runs and the medians.

  Session  One launch for idle RSS and typing. The script waits for the operator (Enter in this
           console, or creating the file <OutDir>\go) to set up the NFR session: 3 stub sessions with
           their terminals open. Then it waits -IdleSeconds (default 60) without input and samples the
           working set and private bytes of switchboard.exe and its WebView2 processes (msedgewebview2.exe
           in its process tree). Everything else in the tree (claude, stubs, shells, conhost) is listed
           as excluded. Then it prints the typing instructions and waits for the operator again before
           closing the app.

  All      Start, then Session.

  Config: the app always reads %APPDATA%\switchboard (the Known Folder, not the APPDATA variable), so
  the scratch config in -ConfigDir can only be used by moving the real one aside. The script does that
  only with -SwapRealConfig: the real folder is renamed to switchboard.perf-backup, -ConfigDir's files
  (hidden ones too) are copied in, and on exit (also on error or Ctrl+C) the copy is deleted, retrying
  for about 10 s, and the backup renamed back only once the copy is gone. If the copy cannot be
  removed, the backup is left where it is, a loud message says where the real config is and how to put
  it back, and the script exits with code 3. Without -SwapRealConfig nothing is launched. -DryRun
  checks the guards, prints the plan and touches nothing.

  Guards (checked before anything else, -DryRun included): -ConfigDir\settings.json must set
  claude.path to an existing file given by an absolute path that is not, directly or through a link,
  %USERPROFILE%\.local\bin\claude.exe (the real claude must never run); -OutDir must not be inside
  %APPDATA%\switchboard or its backup. A launch also refuses while switchboard.exe runs or a backup
  from an interrupted run exists.

  Results (raw runs, samples, machine) are written as JSON to <OutDir>\results.json after each step
  (default -OutDir: a new folder under %TEMP%) and printed. A leftover <OutDir>\go is deleted at start.
  The config the app left behind is kept as <OutDir>\config-after (e.g. to build the 5-project
  workspace.json once and reuse it as -ConfigDir).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\perf\measure.ps1 -Exe src-tauri\target\release\switchboard.exe -ConfigDir C:\scratch\perf-config -SwapRealConfig -Step All
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Exe,
    [Parameter(Mandatory = $true)] [string] $ConfigDir,
    [ValidateSet('All', 'Start', 'Session')] [string] $Step = 'All',
    [switch] $SwapRealConfig,
    [ValidateRange(1, 50)] [int] $Runs = 5,
    [ValidateRange(0, 3600)] [int] $IdleSeconds = 60,
    [ValidateRange(1, 300)] [int] $StartTimeoutSeconds = 20,
    [string] $OutDir = '',
    [switch] $DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$PerfOutEnv = 'SWITCHBOARD_PERF_OUT'
$AppName = 'switchboard'
$WebViewName = 'msedgewebview2'

function Write-Step([string] $text) { Write-Host ''; Write-Host "== $text" }

function Get-Median([double[]] $values) {
    if ($values.Count -eq 0) { return $null }
    $sorted = @($values | Sort-Object)
    $n = $sorted.Count
    if ($n % 2 -eq 1) { return $sorted[[int](($n - 1) / 2)] }
    return ($sorted[$n / 2 - 1] + $sorted[$n / 2]) / 2
}

function Get-MachineInfo {
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $cs = Get-CimInstance Win32_ComputerSystem
    $os = Get-CimInstance Win32_OperatingSystem
    $exeItem = Get-Item -LiteralPath $Exe
    [ordered]@{
        cpu         = $cpu.Name.Trim()
        cores       = $cpu.NumberOfCores
        threads     = $cpu.NumberOfLogicalProcessors
        ram_gb      = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
        os          = "$($os.Caption) $($os.Version) (build $($os.BuildNumber))"
        exe         = $exeItem.FullName
        exe_bytes   = $exeItem.Length
        exe_written = $exeItem.LastWriteTime.ToString('s')
        measured_at = (Get-Date).ToString('s')
    }
}

# The process tree under $rootId (inclusive), from one Win32_Process snapshot.
function Get-ProcessTree([int] $rootId) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate)
    $children = @{}
    foreach ($p in $all) {
        $key = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($key)) { $children[$key] = New-Object System.Collections.ArrayList }
        [void]$children[$key].Add($p)
    }
    $root = $all | Where-Object { $_.ProcessId -eq $rootId } | Select-Object -First 1
    if ($null -eq $root) { return @() }
    $result = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root)
    $seen = @{}
    while ($queue.Count -gt 0) {
        $p = $queue.Dequeue()
        if ($seen.ContainsKey([int]$p.ProcessId)) { continue }
        $seen[[int]$p.ProcessId] = $true
        [void]$result.Add($p)
        $key = [int]$p.ProcessId
        if ($children.ContainsKey($key)) { foreach ($c in $children[$key]) { $queue.Enqueue($c) } }
    }
    return $result.ToArray()
}

function Test-Counted([string] $name) {
    $base = [IO.Path]::GetFileNameWithoutExtension($name)
    return ($base -ieq $AppName) -or ($base -ieq $WebViewName)
}

function Get-AppProcesses {
    $exeFull = (Get-Item -LiteralPath $Exe).FullName
    return @(Get-Process -Name $AppName -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -ieq $exeFull } catch { $false }
        })
}

function Assert-NotRunning {
    $running = @(Get-Process -Name $AppName -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        throw "switchboard.exe is already running (pid $(($running | ForEach-Object { $_.Id }) -join ', ')). Quit it first: a second launch would only hand over to it."
    }
}

function Wait-Window([System.Diagnostics.Process] $proc, [System.Diagnostics.Stopwatch] $sw) {
    while ($true) {
        if ($proc.HasExited) { throw "switchboard.exe exited (code $($proc.ExitCode)) before its window appeared" }
        $proc.Refresh()
        # The app's main window is the one titled Switchboard; WebView2/tao create helper windows first.
        if ($proc.MainWindowHandle -ne [IntPtr]::Zero -and $proc.MainWindowTitle -eq 'Switchboard') { return $sw.Elapsed.TotalMilliseconds }
        if ($sw.Elapsed.TotalSeconds -gt $StartTimeoutSeconds) { throw "no main window within $StartTimeoutSeconds s" }
        Start-Sleep -Milliseconds 2
    }
}

function Wait-StartupLine([string] $file, [int] $processId) {
    $deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $file) {
            foreach ($line in @(Get-Content -LiteralPath $file)) {
                if ($line.Trim() -eq '') { continue }
                # The app may still be writing the line: skip a partial one and read it again next time.
                try { $entry = $line | ConvertFrom-Json } catch { continue }
                if ([int]$entry.pid -eq $processId) { return [double]$entry.startup_ms }
            }
        }
        Start-Sleep -Milliseconds 50
    }
    return $null
}

# Whether $entry (from Get-ProcessTree) is still the same live process: same pid, same name, and a start
# time matching its creation date (a reused pid is another process).
function Test-SameProcess($entry) {
    $gp = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $gp) { return $false }
    if ($gp.ProcessName -ine [IO.Path]::GetFileNameWithoutExtension($entry.Name)) { return $false }
    if ($null -ne $entry.CreationDate) {
        try { if ([math]::Abs(($gp.StartTime - $entry.CreationDate).TotalSeconds) -gt 2) { return $false } } catch { }
    }
    return $true
}

# Every process tree captured at launch (once the window is up), for the final cleanup.
$script:LaunchedTrees = New-Object System.Collections.ArrayList

# The app's tree right after launch (the window is up, so WebView2 is in it); remembered for cleanup.
function Get-LaunchTree([System.Diagnostics.Process] $proc) {
    $tree = @(Get-ProcessTree $proc.Id)
    [void]$script:LaunchedTrees.Add($tree)
    return $tree
}

# Kill what is left alive of $tree's WebView2 processes (even when the root has exited).
function Stop-WebViews($tree) {
    foreach ($p in @($tree)) {
        if ([IO.Path]::GetFileNameWithoutExtension($p.Name) -ieq $WebViewName -and (Test-SameProcess $p)) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

# Close the app and wait for its whole tree (WebView2 included) to go; kill what is left after a timeout.
# $tree is the one captured at launch; without one (the window never came) it is read now.
function Stop-App([System.Diagnostics.Process] $proc, $tree) {
    if ($null -eq $tree -or @($tree).Count -eq 0) {
        if (-not $proc.HasExited) { $tree = Get-LaunchTree $proc } else { $tree = @() }
    }
    $tree = @($tree)
    if (-not $proc.HasExited) {
        $proc.Refresh()
        if ($proc.MainWindowTitle -eq 'Switchboard') { [void]$proc.CloseMainWindow() }
        else { Write-Warning 'no main window to close: killing the app after the timeout' }
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $deadline -and -not $proc.HasExited) { Start-Sleep -Milliseconds 100 }
        if (-not $proc.HasExited) {
            Write-Warning 'the app did not exit within 10 s (close_to_tray on?); killing it'
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    # The root is gone: give its WebView2 processes a moment to follow, then kill any still alive.
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline -and @($tree | Where-Object { Test-SameProcess $_ }).Count -gt 0) { Start-Sleep -Milliseconds 100 }
    Stop-WebViews $tree
}

# Remove $path (recursively), retrying for up to $seconds (a killed app's watcher or antivirus may still
# hold it). Returns whether it is gone.
function Remove-WithRetry([string] $path, [int] $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ($true) {
        if (-not (Test-Path -LiteralPath $path)) { return $true }
        try { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop } catch { }
        if (-not (Test-Path -LiteralPath $path)) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 500
    }
}

# The run is over: put the real config back. Steps, each on its own so one failing cannot skip the next:
# keep what the app left in the scratch copy as <OutDir>\config-after (best effort); delete the scratch
# copy (only one this script created, never the real folder), retrying for $retrySeconds; rename the
# backup back only once nothing is left at $realConfig. Returns whether all is back as it was; when not,
# prints where the real config is and how to put it back.
function Restore-RealConfig([string] $realConfig, [string] $backup, [bool] $created, [bool] $moved, [string] $outDir, [int] $retrySeconds) {
    if ($created -and (Test-Path -LiteralPath $realConfig)) {
        try { Copy-Item -LiteralPath $realConfig -Destination (Join-Path $outDir 'config-after') -Recurse -Force } catch { Write-Warning "could not keep config-after: $_" }
    }
    $scratchGone = $true
    if ($created) {
        try { $scratchGone = Remove-WithRetry $realConfig $retrySeconds } catch { $scratchGone = $false }
    }
    $ok = $true
    try {
        if ($moved) {
            # Never move the backup into a leftover scratch copy (it would land inside it).
            if ($scratchGone -and -not (Test-Path -LiteralPath $realConfig)) {
                Move-Item -LiteralPath $backup -Destination $realConfig
            } else {
                $ok = $false
            }
        } elseif (-not $scratchGone) {
            $ok = $false
        }
    } catch {
        Write-Warning "restore failed: $_"
        $ok = $false
    }
    Write-Host ''
    if ($ok) {
        if ($moved) { Write-Host "real config restored: $realConfig" }
        elseif ($created) { Write-Host 'there was no real config; the scratch copy is removed' }
        else { Write-Host 'nothing was moved; the real config was not touched' }
        return $true
    }
    Write-Host '#####################################################################################'
    Write-Host '##  REAL CONFIG NOT RESTORED'
    if ($moved) {
        Write-Host "##  Your real Switchboard config is at: $backup"
        if (Test-Path -LiteralPath $realConfig) { Write-Host "##  The scratch copy could not be removed from: $realConfig" }
        Write-Host '##  To put it back: quit Switchboard, then in PowerShell run'
        Write-Host "##    Remove-Item -LiteralPath '$realConfig' -Recurse -Force"
        Write-Host "##    Rename-Item -LiteralPath '$backup' -NewName '$([IO.Path]::GetFileName($realConfig))'"
    } else {
        Write-Host "##  There was no real config, but the scratch copy is still at: $realConfig"
        Write-Host '##  Quit Switchboard and delete that folder, or the app will use the scratch config.'
    }
    Write-Host '#####################################################################################'
    return $false
}

# Whether $child is $parent or inside it (full paths, case-insensitive).
function Test-Inside([string] $child, [string] $parent) {
    $c = [IO.Path]::GetFullPath($child).TrimEnd('\')
    $p = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    return ($c -ieq $p) -or $c.StartsWith($p + '\', [StringComparison]::OrdinalIgnoreCase)
}

# Refuse unless the scratch settings.json names a stub claude: claude.path set, an existing file, not the
# real native install (%USERPROFILE%\.local\bin\claude.exe), directly or through a link.
function Assert-StubClaude([string] $configDir) {
    $settingsFile = Join-Path $configDir 'settings.json'
    if (-not (Test-Path -LiteralPath $settingsFile -PathType Leaf)) { throw "Refusing: $settingsFile is missing (it must set claude.path to the stub claude)" }
    try { $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json } catch { throw "Refusing: $settingsFile is not valid JSON: $_" }
    $path = $null
    if ($null -ne $settings -and ($settings.PSObject.Properties.Name -contains 'claude') -and $null -ne $settings.claude -and
        ($settings.claude.PSObject.Properties.Name -contains 'path')) { $path = $settings.claude.path }
    if ($null -eq $path -or [string]$path -eq '') { throw "Refusing: $settingsFile has no claude.path; set it to the stub claude (the real claude must never run)" }
    $path = [string]$path
    if (-not [IO.Path]::IsPathRooted($path)) { throw "Refusing: claude.path '$path' is not an absolute path to the stub" }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Refusing: claude.path '$path' does not exist" }
    $real = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\bin\claude.exe'))
    $resolved = @([IO.Path]::GetFullPath((Resolve-Path -LiteralPath $path).Path))
    $item = Get-Item -LiteralPath $path -Force
    if (($item.PSObject.Properties.Name -contains 'Target') -and $null -ne $item.Target) {
        foreach ($t in @($item.Target)) {
            if ([string]$t -ne '') { $resolved += [IO.Path]::GetFullPath([IO.Path]::Combine($item.DirectoryName, [string]$t)) }
        }
    }
    foreach ($r in $resolved) {
        if ($r -ieq $real) { throw "Refusing: claude.path resolves to the real claude ($real); point it at the stub" }
    }
    return $path
}

function Wait-Operator([string] $prompt, [string] $goFile) {
    Write-Host ''
    Write-Host $prompt
    Write-Host "   (press Enter here, or create the file $goFile)"
    while ($true) {
        if (Test-Path -LiteralPath $goFile) { Remove-Item -LiteralPath $goFile -Force; return }
        try {
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq [ConsoleKey]::Enter) { return }
            }
        } catch {
            # No console (redirected input): only the file continues.
        }
        Start-Sleep -Milliseconds 200
    }
}

function Invoke-StartRuns([string] $outDir) {
    Write-Step "Cold start: $Runs runs"
    $startRuns = New-Object System.Collections.ArrayList
    for ($i = 1; $i -le $Runs; $i++) {
        Assert-NotRunning
        # A fresh file per run: no line from an earlier process can match.
        $perfFile = Join-Path $outDir ("startup-run{0}.jsonl" -f $i)
        if (Test-Path -LiteralPath $perfFile) { Remove-Item -LiteralPath $perfFile -Force }
        $env:SWITCHBOARD_PERF_OUT = $perfFile
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $proc = Start-Process -FilePath $Exe -PassThru
        } finally {
            Remove-Item Env:\SWITCHBOARD_PERF_OUT -ErrorAction SilentlyContinue
        }
        $tree = $null
        try {
            $windowMs = Wait-Window $proc $sw
            $tree = Get-LaunchTree $proc
            $inAppMs = Wait-StartupLine $perfFile $proc.Id
        } finally {
            Stop-App $proc $tree
        }
        $run = [ordered]@{ run = $i; pid = $proc.Id; window_ms = [math]::Round($windowMs, 1); startup_ms = $inAppMs }
        [void]$startRuns.Add($run)
        $inAppText = if ($null -eq $inAppMs) { 'no line (canvas never reported)' } else { "$inAppMs ms" }
        Write-Host ("  run {0}: window {1} ms, in-app {2}" -f $i, $run.window_ms, $inAppText)
        Start-Sleep -Seconds 2
    }
    $inApp = @($startRuns | Where-Object { $null -ne $_.startup_ms } | ForEach-Object { [double]$_.startup_ms })
    $window = @($startRuns | ForEach-Object { [double]$_.window_ms })
    $summary = [ordered]@{
        runs                = $startRuns.ToArray()
        median_startup_ms   = Get-Median $inApp
        median_window_ms    = Get-Median $window
        budget_ms           = 1000
    }
    $pass = ($null -ne $summary.median_startup_ms) -and ($summary.median_startup_ms -lt 1000)
    $summary.pass = $pass
    Write-Host ("  median in-app startup: {0} ms; median window-visible: {1} ms; budget < 1000 ms: {2}" -f `
            $summary.median_startup_ms, $summary.median_window_ms, $(if ($pass) { 'PASS' } else { 'MISS' }))
    return $summary
}

function Get-MemorySample([int] $rootId) {
    $tree = @(Get-ProcessTree $rootId)
    $counted = New-Object System.Collections.ArrayList
    $excluded = New-Object System.Collections.ArrayList
    foreach ($p in $tree) {
        if (Test-Counted $p.Name) {
            $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
            if ($null -eq $gp) { continue }
            [void]$counted.Add([ordered]@{
                    name      = $p.Name
                    pid       = [int]$p.ProcessId
                    ws_mb     = [math]::Round($gp.WorkingSet64 / 1MB, 1)
                    private_mb = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1)
                })
        } else {
            [void]$excluded.Add("$($p.Name) ($($p.ProcessId))")
        }
    }
    $ws = 0.0; $priv = 0.0
    foreach ($c in $counted) { $ws += $c.ws_mb; $priv += $c.private_mb }
    return [ordered]@{
        processes        = $counted.ToArray()
        total_ws_mb      = [math]::Round($ws, 1)
        total_private_mb = [math]::Round($priv, 1)
        excluded         = $excluded.ToArray()
        budget_mb        = 150
        pass             = ($ws -lt 150)
    }
}

function Invoke-Session([string] $outDir) {
    Write-Step 'Session: idle RSS and typing'
    Assert-NotRunning
    $goFile = Join-Path $outDir 'go'
    $proc = Start-Process -FilePath $Exe -PassThru
    $tree = $null
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        [void](Wait-Window $proc $sw)
        $tree = Get-LaunchTree $proc
        Wait-Operator '>> Set up the NFR session now: the 5-project workspace is loaded; start 3 stub sessions and leave their terminals open (terminal pane shown). Then leave the app alone.' $goFile
        Write-Host "  idling $IdleSeconds s: do not touch the app"
        Start-Sleep -Seconds $IdleSeconds
        $mem = Get-MemorySample $proc.Id
        Write-Host ''
        Write-Host '  counted processes:'
        foreach ($p in $mem.processes) {
            Write-Host ("    {0,-20} pid {1,-7} working set {2,8} MB   private {3,8} MB" -f $p.name, $p.pid, $p.ws_mb, $p.private_mb)
        }
        Write-Host ("  total working set {0} MB, private {1} MB; budget < 150 MB (working set): {2}" -f `
                $mem.total_ws_mb, $mem.total_private_mb, $(if ($mem.pass) { 'PASS' } else { 'MISS' }))
        if ($mem.excluded.Count -gt 0) { Write-Host "  excluded: $($mem.excluded -join ', ')" }
        Wait-Operator ('>> Typing: focus a plain shell terminal (cmd or pwsh, not a session), type 50 printable keys at an ordinary pace ' +
            '(no Enter needed), then open Settings (ctrl+,) and read Diagnostics -> Performance -> typing: median / p95. ' +
            'Record them in docs/perf.md. Then continue to close the app.') $goFile
        return $mem
    } finally {
        Stop-App $proc $tree
    }
}

# ---------------------------------------------------------------------------------------------

$Exe = (Resolve-Path -LiteralPath $Exe).Path
if (-not (Test-Path -LiteralPath $ConfigDir -PathType Container)) { throw "-ConfigDir $ConfigDir is not a folder" }
$ConfigDir = (Resolve-Path -LiteralPath $ConfigDir).Path
$realConfig = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'switchboard'
$backup = "$realConfig.perf-backup"
if (Test-Inside $ConfigDir $realConfig) { throw '-ConfigDir must be a scratch copy, not the real config folder' }
if (Test-Inside $ConfigDir $backup) { throw '-ConfigDir must not be inside the real config backup' }
if ($OutDir -eq '') { $OutDir = Join-Path $env:TEMP ('switchboard-perf-' + (Get-Date).ToString('yyyyMMdd-HHmmss')) }
$OutDir = [IO.Path]::GetFullPath($OutDir)
if ((Test-Inside $OutDir $realConfig) -or (Test-Inside $OutDir $backup)) {
    throw "Refusing: -OutDir $OutDir is inside $realConfig (or its backup), which the script replaces and deletes"
}
$stub = Assert-StubClaude $ConfigDir
if (-not (Test-Path -LiteralPath (Join-Path $ConfigDir 'workspace.json'))) {
    Write-Warning "$ConfigDir has no workspace.json: the app would start on an empty canvas, not the 5-project setup"
}

Write-Step 'Plan'
Write-Host "  exe:          $Exe"
Write-Host "  scratch cfg:  $ConfigDir"
Write-Host "  stub claude:  $stub"
Write-Host "  real cfg:     $realConfig ($(if (Test-Path -LiteralPath $realConfig) { 'exists' } else { 'absent' }); moved to $backup during the run)"
Write-Host "  step:         $Step (runs $Runs, idle $IdleSeconds s)"
Write-Host "  results:      $OutDir"
if ($DryRun) { Write-Host '  dry run: nothing launched, nothing moved'; return }
if (-not $SwapRealConfig) {
    throw 'Refusing to launch: pass -SwapRealConfig to move the real config aside for the run (it is restored afterwards).'
}
Assert-NotRunning
if (Test-Path -LiteralPath $backup) {
    throw "$backup exists: an earlier run did not restore it. Put it back by hand (it is the real config) and retry."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$goFile = Join-Path $OutDir 'go'
if (Test-Path -LiteralPath $goFile) { Remove-Item -LiteralPath $goFile -Force }
$resultsFile = Join-Path $OutDir 'results.json'
$results = [ordered]@{ machine = Get-MachineInfo; config = $ConfigDir; stub_claude = $stub }
$results.machine | ConvertTo-Json | Write-Host

# Written after each step, so one step's results survive a later step failing.
function Save-Results {
    $results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultsFile -Encoding UTF8
}
Save-Results

$moved = $false
$created = $false
try {
    if (Test-Path -LiteralPath $realConfig) {
        Move-Item -LiteralPath $realConfig -Destination $backup
        $moved = $true
    }
    New-Item -ItemType Directory -Path $realConfig | Out-Null
    # From here on the folder at $realConfig is the scratch copy (the real one is the backup, or there was none).
    $created = $true
    # -Force on both: hidden files too; items piped by literal path, so brackets are not wildcards.
    Get-ChildItem -LiteralPath $ConfigDir -Force | Copy-Item -Destination $realConfig -Recurse -Force

    if ($Step -eq 'All' -or $Step -eq 'Start') { $results.start = Invoke-StartRuns $OutDir; Save-Results }
    if ($Step -eq 'All' -or $Step -eq 'Session') { $results.idle = Invoke-Session $OutDir; Save-Results }
} finally {
    # 1. Nothing of the app may hold the folder: kill what is left (the app, and every WebView2 process
    #    captured at launch, even if its root has gone).
    try {
        foreach ($p in @(Get-AppProcesses)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        foreach ($t in $script:LaunchedTrees) { Stop-WebViews $t }
    } catch { Write-Warning "cleanup of app processes failed: $_" }

    if (-not (Restore-RealConfig $realConfig $backup $created $moved $OutDir 10)) { exit 3 }
}

Save-Results
Write-Host "results: $resultsFile"

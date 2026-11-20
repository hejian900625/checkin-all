# Unified daily check-in runner for all services.
# Contract of each service daily.ps1: exit 0 = done/no-op, 2 = needs client/token, 1 = error.
# Pure ASCII on purpose: Windows PowerShell 5.1 mis-parses UTF-8 CJK inside .ps1 files.
param(
    [string[]]$Only = @(),
    [switch]$Status,
    [switch]$NoMail,
    [int]$TimeoutSec = 900
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Ws = Split-Path -Parent $Root
$StateFile = Join-Path $Root 'last-run.json'

$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ((Get-Date).ToString('yyyy-MM-dd') + '.log')
if (-not (Test-Path $LogFile)) { [System.IO.File]::WriteAllText($LogFile, '', (New-Object System.Text.UTF8Encoding($false))) }

function Log([string]$msg) {
    $line = (Get-Date).ToString('HH:mm:ss') + ' ' + $msg
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# name, folder, timeout seconds, note, tolerated exit codes (besides 0)
$Jobs = @(
    [pscustomobject]@{ Name = 'WorkBuddy'; Dir = 'wb-checkin';     Timeout = 300; Note = 'www.workbuddy.cn';   Tolerate = @() },
    [pscustomobject]@{ Name = 'Trae';      Dir = 'trae-checkin';   Timeout = 300; Note = 'api.trae.cn';        Tolerate = @() },
    [pscustomobject]@{ Name = 'Qoder';     Dir = 'qoder-checkin';  Timeout = 300; Note = 'openapi.qoder.com.cn'; Tolerate = @() },
    [pscustomobject]@{ Name = 'MiniMax';   Dir = 'mm-checkin';     Timeout = 300; Note = 'agent.minimax.cn';   Tolerate = @() },
    [pscustomobject]@{ Name = 'Doubao';    Dir = 'doubao-checkin'; Timeout = 420; Note = 'www.doubao.com';     Tolerate = @(1) },
    [pscustomobject]@{ Name = 'Loomy';     Dir = 'loomy-checkin';  Timeout = 180; Note = 'loomyad.xunfei.cn';  Tolerate = @() }
)

if ($Only.Count -gt 0) {
    # when launched via -File, "A,B" arrives as one string; split it back into names
    $names = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $Jobs = @($Jobs | Where-Object { $names -contains $_.Name })
}

function Invoke-Job($job) {
    $script = Join-Path (Join-Path $Ws $job.Dir) 'daily.ps1'
    if (-not (Test-Path $script)) {
        return [pscustomobject]@{ Name = $job.Name; Exit = -1; Elapsed = 0; State = 'MISSING'; Tail = ''; Balance = '' }
    }

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $outFile = Join-Path $env:TEMP ('checkin-' + $job.Name + '-' + [guid]::NewGuid().ToString('N') + '.log')

    # Windows PowerShell 5.1: Start-Process -PassThru cannot report ExitCode for a redirected
    # child, so run a small wrapper .ps1 that invokes the job and writes its exit code to a file.
    $statusFile = Join-Path $env:TEMP ('checkin-' + $job.Name + '-' + [guid]::NewGuid().ToString('N') + '.exit')
    $wrapFile = Join-Path $env:TEMP ('checkin-' + $job.Name + '-' + [guid]::NewGuid().ToString('N') + '.wrap.ps1')
    $wrap = @(
        '$ErrorActionPreference = ''Continue'''
        '& ' + "'" + $script + "'"
        '$c = $LASTEXITCODE'
        'if ($null -eq $c) { $c = 0 }'
        '[System.IO.File]::WriteAllText(' + "'" + $statusFile + "', [string]`$c)"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($wrapFile, $wrap, (New-Object System.Text.UTF8Encoding($false)))

    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $wrapFile + '"'))

    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -RedirectStandardOutput $outFile `
        -RedirectStandardError ($outFile + '.err') -WindowStyle Hidden -PassThru -ErrorAction Stop

    $finished = $p.WaitForExit($job.Timeout * 1000)
    if (-not $finished) {
        try { $p.Kill() } catch { }
        $p.WaitForExit(10000) | Out-Null
    }
    $sw.Stop()

    $text = ''
    if (Test-Path $outFile) { $text = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8) }
    if (Test-Path ($outFile + '.err')) {
        $errText = [System.IO.File]::ReadAllText(($outFile + '.err'), [System.Text.Encoding]::UTF8)
        if ($errText) { $text = $text + "`n" + $errText }
    }
    Remove-Item $outFile, ($outFile + '.err'), $wrapFile -ErrorAction SilentlyContinue

    $lines = @(($text -split "`r?`n") | Where-Object { $_.Trim() })
    $tailLines = @($lines | Select-Object -Last 4)
    $tail = ($tailLines -join ' | ')
    if ($tail.Length -gt 300) { $tail = $tail.Substring(0, 300) + '...' }

    $balLine = $lines | Where-Object { $_ -match 'BALANCE\s+\{.*\}\s*$' } | Select-Object -Last 1
    $balance = ''
    if ($balLine -and $balLine -match '(BALANCE\s+\{.*\})\s*$') { $balance = $Matches[1] }

    if (-not $finished) {
        return [pscustomobject]@{ Name = $job.Name; Exit = -2; Elapsed = [int]$sw.Elapsed.TotalSeconds; State = 'TIMEOUT'; Tail = $tail; Balance = $balance }
    }

    # WaitForExit(int) returns but does not always populate ExitCode; empty = 1 (powershell's own
    # error indicator). Prefer the sentinel file written by the wrapper.
    $exitCode = $null
    if (Test-Path $statusFile) {
        $raw = (Get-Content $statusFile -Raw -ErrorAction SilentlyContinue)
        Remove-Item $statusFile -ErrorAction SilentlyContinue
        if ($raw -and $raw.Trim() -match '^-?\d+$') { $exitCode = [int]$raw.Trim() }
    }
    if ($null -eq $exitCode) {
        try { $p.WaitForExit() } catch { }
        try { $p.Refresh(); $exitCode = $p.ExitCode } catch { }
    }
    if ($null -eq $exitCode) { $exitCode = 1 }

    # network flake retry: retry after 20s if the full output looks like a transport error.
    # Match $text, not the 300-char tail: PowerShell wraps native stderr in several lines of
    # boilerplate, so the real "getaddrinfo ..." line can be cut off from the tail.
    if ($exitCode -ne 0 -and $job.Tolerate -notcontains $exitCode) {
        if ($text -match 'fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo') {
            Log ('    network error detected, retrying in 20s')
            Start-Sleep -Seconds 20
            return Invoke-Job $job
        }
    }

    $state = 'FAIL'
    if ($exitCode -eq 0) { $state = 'OK' }
    elseif ($job.Tolerate -contains $exitCode) { $state = 'WARN' }

    return [pscustomobject]@{
        Name    = $job.Name
        Exit    = $exitCode
        Elapsed = [int]$sw.Elapsed.TotalSeconds
        State   = $state
        Tail    = $tail
        Balance = $balance
    }
}

# wait for network before starting (max 180s)
function Wait-Network {
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        try {
            $req = [System.Net.WebRequest]::Create('https://www.workbuddy.cn')
            $req.Timeout = 5000
            $resp = $req.GetResponse()
            $resp.Close()
            return $true
        } catch {
            Start-Sleep -Seconds 5
        }
    }
    return $false
}

Log ('=== run start (jobs: ' + (($Jobs | ForEach-Object { $_.Name }) -join ', ') + ') ===')

if (-not (Wait-Network)) { Log 'network not ready after 180s, continuing anyway' }

$results = @()
foreach ($job in $Jobs) {
    Log ('--- ' + $job.Name + ' (' + $job.Note + ')')
    $r = Invoke-Job $job
    $results += $r
    Log ('    ' + $r.State + ' exit=' + $r.Exit + ' ' + $r.Elapsed + 's' + $(if ($r.Tail) { ' :: ' + $r.Tail } else { '' }))
}

$bad = @($results | Where-Object { $_.State -ne 'OK' -and $_.State -ne 'WARN' })

# exit 2 = credential/session expired, only the user can re-login -- the mail highlights these separately.
# ASCII only: Windows PowerShell 5.1 mangles UTF-8 CJK literals in .ps1 sources.
$reauthHints = @{
    'Loomy'     = @{ Hint = 'Loomy session expires after ~14 days; phone SMS code required'; Command = 'cd ' + (Join-Path $Ws 'loomy-checkin') + '; D:\nodejs\node.exe login.js send <phone>' }
    'Qoder'     = @{ Hint = 'Qoder token expired and cannot be refreshed offline; open the client once'; Command = 'cd ' + (Join-Path $Ws 'qoder-checkin') + '; .\daily.ps1' }
    'Trae'      = @{ Hint = 'Trae token expired (7 days); open the client once'; Command = 'cd ' + (Join-Path $Ws 'trae-checkin') + '; .\daily.ps1' }
    'MiniMax'   = @{ Hint = 'MiniMax refresh token family invalidated; re-login with QR in the client'; Command = 'cd ' + (Join-Path $Ws 'mm-checkin') + '; .\daily.ps1' }
    'Doubao'    = @{ Hint = 'Doubao cookies expired; open the client once to refresh them'; Command = 'cd ' + (Join-Path $Ws 'doubao-checkin') + '; .\daily.ps1' }
    'WorkBuddy' = @{ Hint = 'WorkBuddy token expired; open the client once'; Command = 'cd ' + (Join-Path $Ws 'wb-checkin') + '; .\daily.ps1' }
}
$reauth = @($results | Where-Object { $_.Exit -eq 2 } | ForEach-Object {
    $h = $reauthHints[$_.Name]
    [pscustomobject]@{
        Name    = $_.Name
        Exit    = $_.Exit
        Hint    = $(if ($h) { $h.Hint } else { 'Login state expired; please re-login' })
        Command = $(if ($h) { $h.Command } else { '' })
    }
})

Log '=== summary ==='
foreach ($r in $results) {
    Log ('  {0,-10} {1,-11} exit={2,-4} {3,4}s' -f $r.Name, $r.State, $r.Exit, $r.Elapsed)
}
Log ('overall: ' + $(if ($bad.Count -eq 0) { 'ok' } else { 'attention needed: ' + (($bad | ForEach-Object { $_.Name }) -join ', ') }))

$record = [pscustomobject]@{
    at      = (Get-Date).ToString('o')
    overall = $(if ($bad.Count -eq 0) { 'ok' } else { 'attention' })
    reauth  = $reauth
    jobs    = $results
}
# UTF8 without BOM so other tools (node) can parse it directly
$json = $record | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($StateFile, $json, (New-Object System.Text.UTF8Encoding($false)))

if ($Status) {
    $results | Format-Table Name, State, Exit, Elapsed -AutoSize | Out-Host
    exit 0
}

# mail the summary (silently skipped when mail.json has no credentials)
if (-not $NoMail) {
    $nodeExe = 'D:\nodejs\node.exe'
    if (-not (Test-Path $nodeExe)) { $nodeExe = 'node.exe' }
    $mailJs = Join-Path $Root 'mail.js'
    if (Test-Path $mailJs) {
        $mailOut = & $nodeExe $mailJs --state $StateFile 2>&1
        foreach ($l in $mailOut) { Log ('  ' + $l) }
        Log ('mail exit=' + $LASTEXITCODE)
    }
}

if ($bad.Count -eq 0) { Log 'done'; exit 0 }
Log 'done with issues'
exit 1

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$botPath = Join-Path $projectRoot 'src\telegram\bot.js'
$logDirectory = Join-Path $projectRoot 'runs'

# Avoid a second long-polling listener when the launcher is run twice.
$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($botPath) }
if ($existing) { exit 0 }

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
Start-Process -FilePath $nodePath -ArgumentList ('"' + $botPath + '"') `
    -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDirectory 'telegram.stdout.log') `
    -RedirectStandardError (Join-Path $logDirectory 'telegram.stderr.log')

# claude-setup for Windows: runs install.js, then adds the cc / cco shortcuts to your PowerShell profiles.
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [-DryRun] [-NoPlugins] [-NoBypass]
param([switch]$DryRun, [switch]$NoPlugins, [switch]$NoBypass)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js is required (the hooks run on it): https://nodejs.org' -ForegroundColor Red; exit 1 }
$a = @()
if ($DryRun) { $a += '--dry-run' }
if ($NoPlugins) { $a += '--no-plugins' }
if ($NoBypass) { $a += '--no-bypass' }
& node (Join-Path $PSScriptRoot 'install.js') @a
$code = $LASTEXITCODE

$cfg = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$skip = if ($NoBypass) { '' } else { ' --dangerously-skip-permissions' }
$cc  = "function cc  { claude --model sonnet --effort medium$skip --settings `"$cfg\cc-settings.json`" @args }"
$cco = "function cco { claude --model opus --effort medium$skip @args }"
$profiles = @(
  (Join-Path $HOME 'Documents\PowerShell\Microsoft.PowerShell_profile.ps1'),
  (Join-Path $HOME 'Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1')
) | Where-Object { (Test-Path $_) -or ($_ -eq $PROFILE) }
foreach ($p in $profiles) {
  # rewrite line by line (never append to an unterminated last line); first split any
  # "function cc/cco" that an earlier tool glued onto the end of another line
  $raw = if (Test-Path $p) { [IO.File]::ReadAllText($p) } else { '' }
  $raw = $raw -replace '(?<=[^\r\n])(function cco?\s)', "`r`n`$1"
  $lines = @($raw -split "`r?`n" | Where-Object { $_ -notmatch '^function cco?\s' })
  while ($lines.Count -gt 0 -and $lines[-1] -eq '') { $lines = @($lines | Select-Object -SkipLast 1) }
  $lines += $cc; $lines += $cco
  if ($DryRun) { Write-Host "[dry-run] shortcuts -> $p"; continue }
  New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
  Set-Content $p $lines -Encoding UTF8
  Write-Host "shortcuts cc / cco -> $p"
}
Write-Host 'Open a NEW PowerShell window for cc / cco.'
exit $code

[CmdletBinding()]
param([string]$ProjectPath = (Get-Location).Path, [switch]$NoOpen, [switch]$Stop, [switch]$Recent)
$ErrorActionPreference = 'Stop'
try {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Node.js was not found.' }
    $launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\open-dashboard.mjs'
    $arguments = @($launcher, '--cwd', $ProjectPath)
    if ($NoOpen) { $arguments += '--no-open' }
    if ($Stop) { $arguments += '--stop' }
    if ($Recent) { $arguments += '--recent' }
    & $nodePath @arguments
    exit $LASTEXITCODE
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }

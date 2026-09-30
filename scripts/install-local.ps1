[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Resolve-CodexExecutable {
    $command = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }

    # Desktop bundles its CLI outside the normal Windows terminal PATH.
    $desktopBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $desktopBin -PathType Container) {
        $candidates = @(Get-ChildItem -LiteralPath $desktopBin -Directory | ForEach-Object {
            $candidate = Join-Path $_.FullName 'codex.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                Get-Item -LiteralPath $candidate
            }
        } | Sort-Object LastWriteTimeUtc -Descending)
        if ($candidates.Count -gt 0) { return $candidates[0].FullName }
    }
    throw 'Codex CLI was not found in PATH or the local Codex Desktop installation. Open Codex Desktop once, then retry.'
}

try {
    $sourceRoot = Split-Path -Parent $PSScriptRoot
    $targetRoot = Join-Path $env:USERPROFILE 'plugins\context-window-monitor'
    $marketplacePath = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
    $entries = @('.codex-plugin', '.mcp.json', 'runtime', 'hooks', 'skills', 'scripts', 'docs', 'README.md', 'LICENSE')

    $null = Get-Command node -CommandType Application -ErrorAction Stop
    $codexExecutable = Resolve-CodexExecutable
    Write-Host "Codex CLI: $codexExecutable"
    & $codexExecutable --version
    if ($LASTEXITCODE -ne 0) { throw 'The resolved Codex CLI could not start.' }
    foreach ($entry in $entries) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $entry))) {
            throw "Missing package entry: $entry"
        }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $sourceRoot '.codex-plugin\plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -ne 'context-window-monitor') { throw 'Unexpected plugin name.' }
    if ([IO.Path]::GetFullPath($sourceRoot) -eq [IO.Path]::GetFullPath($targetRoot)) {
        throw 'Run this installer from the development folder or extracted release package.'
    }

    $marketplace = Get-Content -LiteralPath $marketplacePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $marketplaceName = $marketplace.name
    if ($marketplaceName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid marketplace name.' }
    $matching = @($marketplace.plugins | Where-Object { $_.name -eq $manifest.name })
    if ($matching.Count -ne 1 -or $matching[0].source.source -ne 'local') {
        throw 'The existing local marketplace entry could not be verified.'
    }
    $registeredPath = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE $matching[0].source.path))
    if ($registeredPath -ne [IO.Path]::GetFullPath($targetRoot)) {
        throw "Marketplace points to a different folder: $registeredPath"
    }
    Write-Host "Validated $($manifest.name) $($manifest.version) -> $targetRoot"
    if ($CheckOnly) {
        Write-Host 'Check complete. No files or installed plugins were changed.'
        exit 0
    }

    if (Test-Path -LiteralPath $targetRoot) {
        $backupPath = "$targetRoot.backup-$(Get-Date -Format yyyyMMdd-HHmmss)-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
        Copy-Item -LiteralPath $targetRoot -Destination $backupPath -Recurse
        Write-Host "Backup: $backupPath"
    } else {
        $null = New-Item -ItemType Directory -Path $targetRoot -Force
    }
    foreach ($entry in $entries) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $entry) -Destination $targetRoot -Recurse -Force
    }
    # A unique SemVer build suffix makes Codex refresh the local plugin cache.
    # Keep this installer independent of removed Desktop-internal helper scripts.
    $targetManifestPath = Join-Path $targetRoot '.codex-plugin\plugin.json'
    $targetManifest = Get-Content -LiteralPath $targetManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $targetManifest.version = ($manifest.version -split '\+')[0] + '+codex.' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    [IO.File]::WriteAllText($targetManifestPath, ($targetManifest | ConvertTo-Json -Depth 30) + "`n", (New-Object System.Text.UTF8Encoding($false)))

    $selector = "$($manifest.name)@$marketplaceName"
    Write-Host "Installing $selector ..."
    & $codexExecutable plugin add $selector
    if ($LASTEXITCODE -ne 0) { throw 'Codex plugin installation failed. The backup is preserved.' }
    Write-Host 'Checking installed version ...'
    $listing = & $codexExecutable plugin list --json
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify installed plugin status.' }
    $installed = @(($listing | ConvertFrom-Json).installed | Where-Object { $_.pluginId -eq $selector })
    if ($installed.Count -ne 1 -or -not $installed[0].installed -or -not $installed[0].enabled) {
        throw 'The plugin was not reported as installed and enabled.'
    }
    if (($installed[0].version -split '\+')[0] -ne ($manifest.version -split '\+')[0]) {
        throw "Installed version differs from the package: $($installed[0].version)"
    }
    Write-Host "SUCCESS: $selector $($installed[0].version) is installed and enabled."
    Write-Host 'Use the context-monitor project action, or run scripts\open-dashboard.ps1. MCP updates apply to new Codex chats.'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}

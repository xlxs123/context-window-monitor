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

    $nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $nodeVersion = & $nodeExecutable -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [Version]$nodeVersion -lt [Version]'22.13.0') {
        throw 'Node.js 22.13 or newer is required. Install a current Node.js LTS release, then retry.'
    }
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

    $marketplaceExists = Test-Path -LiteralPath $marketplacePath -PathType Leaf
    if ($marketplaceExists) {
        $marketplace = Get-Content -LiteralPath $marketplacePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $marketplace = [PSCustomObject]@{ name = 'personal'; interface = @{ displayName = 'Personal' }; plugins = @() }
    }
    $marketplaceName = $marketplace.name
    if ($marketplaceName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid marketplace name.' }
    $matching = @($marketplace.plugins | Where-Object { $_.name -eq $manifest.name })
    if ($matching.Count -eq 0) {
        $marketplace.plugins = @($marketplace.plugins) + @([PSCustomObject]@{
            name = $manifest.name
            source = @{ source = 'local'; path = './plugins/context-window-monitor' }
            policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
            category = 'Productivity'
        })
    } elseif ($matching.Count -ne 1 -or $matching[0].source.source -ne 'local') {
        throw 'An incompatible marketplace entry already exists; it was not changed.'
    }
    $matching = @($marketplace.plugins | Where-Object { $_.name -eq $manifest.name })
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
        $oldLauncher = Join-Path $targetRoot 'runtime\open-dashboard.mjs'
        if (Test-Path -LiteralPath $oldLauncher -PathType Leaf) {
            & $nodeExecutable $oldLauncher --stop
            if ($LASTEXITCODE -ne 0) { throw 'Could not stop the previous dashboard service.' }
        }
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

    $marketplaceJson = ($marketplace | ConvertTo-Json -Depth 30) + "`n"
    if (-not $marketplaceExists -or (Get-Content -LiteralPath $marketplacePath -Raw -Encoding UTF8) -ne $marketplaceJson) {
        if ($marketplaceExists) { Copy-Item -LiteralPath $marketplacePath -Destination "$marketplacePath.backup-$([Guid]::NewGuid().ToString('N'))" }
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $marketplacePath) -Force
        [IO.File]::WriteAllText($marketplacePath, $marketplaceJson, (New-Object System.Text.UTF8Encoding($false)))
    }
    # Register through the supported CLI as well, including nonstandard home layouts.
    & $codexExecutable plugin marketplace add $env:USERPROFILE
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the local plugin marketplace.' }

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
    $startupText = & $nodeExecutable (Join-Path $targetRoot 'runtime\open-dashboard.mjs') --ensure
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installed, but automatic project integration did not start.' }
    $startup = ($startupText -join "`n") | ConvertFrom-Json
    if ($env:CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY -ne '1') {
        if (-not $startup.desktopEntry.visible) { throw 'Plugin installed, but the tray entry did not start. The dashboard service is running.' }
        Write-Host 'Click Context Monitor in the Windows notification area (near the clock). No chat command is needed.'
        if ($startup.desktopEntry.hotkeyRegistered) { Write-Host "Shortcut is ready: $($startup.desktopEntry.hotkey)." }
        else { Write-Warning 'The shortcuts are already in use or unavailable. The tray button remains available.' }
    }
    Write-Host 'Optional project-action configurations are maintained automatically; their visibility depends on the Codex UI.'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}

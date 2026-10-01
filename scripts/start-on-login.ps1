[CmdletBinding()]
param(
    [string]$PluginId,
    [string]$CodexHome,
    [string]$NodePath,
    [string]$CodexExecutable,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# A damaged settings file must still leave a diagnostic for the hidden process.
$directory = $PSScriptRoot
$statusPath = Join-Path $directory 'startup-last-run.json'
try {
    if (-not $PluginId -and -not $CodexHome) {
        $settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'startup-registration.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $PluginId = $settings.pluginId
        $CodexHome = $settings.codexHome
        $NodePath = $settings.nodePath
    }
    if (-not $CodexHome) { throw 'Codex home was not supplied.' }
    $directory = Join-Path $CodexHome 'context-window-monitor'
    $statusPath = Join-Path $directory 'startup-last-run.json'
    if ($PluginId -notmatch '^context-window-monitor@[A-Za-z0-9_-]+$') { throw 'Invalid plugin selector.' }
    if (-not $CodexExecutable) {
        $command = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $CodexExecutable = $command.Source }
        else {
            $bin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
            if (Test-Path -LiteralPath $bin) {
                $CodexExecutable = Get-ChildItem -LiteralPath $bin -Directory | ForEach-Object {
                    $candidate = Join-Path $_.FullName 'codex.exe'
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
                } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
            }
        }
    }
    if (-not $CodexExecutable -or -not (Test-Path -LiteralPath $CodexExecutable -PathType Leaf)) { throw 'Codex CLI was not found.' }
    $env:CODEX_HOME = $CodexHome
    $listing = & $CodexExecutable plugin list --json
    if ($LASTEXITCODE -ne 0) { throw 'Could not read installed plugin status.' }
    $plugins = @((($listing -join "`n") | ConvertFrom-Json).installed | Where-Object { $_.pluginId -eq $PluginId })
    $status = 'not-installed'
    if ($plugins.Count -eq 1 -and $plugins[0].installed) {
        $status = 'disabled'
        if ($plugins[0].enabled) { $status = 'enabled' }
    }
    if ($status -eq 'enabled' -and ($env:CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY -eq '1' -or $env:CONTEXT_MONITOR_DISABLE_LOGIN_STARTUP -eq '1')) { $status = 'disabled' }
    if ($status -eq 'enabled') {
        $plugin = $plugins[0]
        $roots = @()
        if ($plugin.source.source -eq 'local') { $roots += $plugin.source.path }
        foreach ($component in @($plugin.marketplaceName, $plugin.name, $plugin.version)) {
            if ($component -notmatch '^[A-Za-z0-9_.+@-]+$' -or $component -eq '.' -or $component -eq '..') { throw 'Invalid installed plugin path component.' }
        }
        $roots += Join-Path (Join-Path (Join-Path (Join-Path $CodexHome 'plugins\cache') $plugin.marketplaceName) $plugin.name) $plugin.version
        $launcher = $null
        foreach ($root in $roots) {
            $manifestPath = Join-Path $root '.codex-plugin\plugin.json'
            $candidate = Join-Path $root 'runtime\open-dashboard.mjs'
            if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($manifest.name -eq 'context-window-monitor' -and $manifest.version -eq $plugin.version) { $launcher = $candidate; break }
        }
        if (-not $launcher) { throw 'The currently installed plugin runtime was not found.' }
        if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($nodeCommand) { $NodePath = $nodeCommand.Source }
        }
        if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js was not found.' }
        if (-not $CheckOnly) {
            $text = & $NodePath $launcher --ensure
            if ($LASTEXITCODE -ne 0) { throw 'The monitor could not start.' }
            $entry = ($text -join "`n") | ConvertFrom-Json
            if (-not $entry.desktopEntry.visible) { throw 'The monitor tray could not start.' }
            $status = 'started'
        }
    }
    $result = [PSCustomObject]@{ pluginId = $PluginId; status = $status; checkedAt = [DateTime]::UtcNow.ToString('o'); error = $null }
    if (-not $CheckOnly) {
        $null = New-Item -ItemType Directory -Path $directory -Force
        [IO.File]::WriteAllText($statusPath, ($result | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }
    $result | ConvertTo-Json -Compress
} catch {
    if (-not $CheckOnly -and $statusPath) {
        $null = New-Item -ItemType Directory -Path $directory -Force
        [IO.File]::WriteAllText($statusPath, (@{ pluginId = $PluginId; status = 'failed'; checkedAt = [DateTime]::UtcNow.ToString('o'); error = $_.Exception.Message } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }
    Write-Error $_ -ErrorAction Continue
    exit 1
}

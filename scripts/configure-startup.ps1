[CmdletBinding()]
param(
    [ValidateSet('Install', 'Check', 'Remove')][string]$Mode = 'Install',
    [string]$NodePath,
    [string]$PluginId,
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
    [string]$StartupDirectory = (Join-Path $env:LOCALAPPDATA 'OpenAI\CodexContextMonitor'),
    [ValidatePattern('^HKCU:\\')][string]$RegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Get-BootstrapHash([string]$file) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-', '') }
    finally { $algorithm.Dispose() }
}
$name = 'CodexContextMonitor'
$directory = $StartupDirectory
$ownerPath = Join-Path $directory 'startup-registration.json'
$bootstrap = Join-Path $directory 'login-startup.ps1'
try {
    $owner = $null
    if (Test-Path -LiteralPath $ownerPath -PathType Leaf) { $owner = Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    $current = $null
    $kind = $null
    if (Test-Path -LiteralPath $RegistryPath) {
        $key = Get-Item -LiteralPath $RegistryPath
        $current = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $current) { $kind = $key.GetValueKind($name).ToString() }
    }
    $owned = $owner -and $owner.name -eq $name -and $owner.registryPath -eq $RegistryPath -and $owner.command -eq $current -and $kind -eq 'ExpandString'
    if ($Mode -eq 'Check') { @{ registered = ($null -ne $current); owned = [bool]$owned; name = $name } | ConvertTo-Json -Compress; exit 0 }
    if ($Mode -eq 'Remove') {
        if ($owned) {
            Remove-ItemProperty -LiteralPath $RegistryPath -Name $name
            if ((Test-Path -LiteralPath $bootstrap -PathType Leaf) -and (Get-BootstrapHash $bootstrap) -eq $owner.bootstrapHash) { Remove-Item -LiteralPath $bootstrap }
            Remove-Item -LiteralPath $ownerPath
        }
        @{ removed = [bool]$owned; preservedUserEdit = [bool]($null -ne $current -and -not $owned) } | ConvertTo-Json -Compress; exit 0
    }
    if ($env:CONTEXT_MONITOR_DISABLE_LOGIN_STARTUP -eq '1' -or $env:CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY -eq '1') { @{ registered = $false; disabled = $true } | ConvertTo-Json -Compress; exit 0 }
    if ($null -ne $current -and -not $owned) { throw 'The login startup entry was modified or belongs to another owner; it was preserved.' }
    if (-not $PluginId) {
        $env:CODEX_HOME = $CodexHome
        $command = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $cli = if ($command) { $command.Source } else { $null }
        if (-not $cli) {
            $bin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
            if (Test-Path -LiteralPath $bin) {
                $cli = Get-ChildItem -LiteralPath $bin -Directory | ForEach-Object {
                    $candidate = Join-Path $_.FullName 'codex.exe'
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
                } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
            }
        }
        if (-not $cli) { throw 'Codex CLI was not found.' }
        $text = & $cli plugin list --json
        if ($LASTEXITCODE -ne 0) { throw 'Could not read installed plugin status.' }
        $entries = @((($text -join "`n") | ConvertFrom-Json).installed | Where-Object { $_.name -eq 'context-window-monitor' -and $_.installed -and $_.enabled })
        if ($entries.Count -ne 1) { throw 'A unique enabled context monitor plugin was not found.' }
        $PluginId = $entries[0].pluginId
    }
    if ($PluginId -notmatch '^context-window-monitor@[A-Za-z0-9_-]+$') { throw 'Invalid plugin selector.' }
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js was not found.' }
    # Run values have a 260-character limit. Keep parameters in the owned JSON,
    # use a stable bootstrap outside the versioned cache, and expand user paths.
    $bootstrapArgument = $bootstrap
    if ([IO.Path]::GetFullPath($directory).TrimEnd('\') -eq (Join-Path $env:LOCALAPPDATA 'OpenAI\CodexContextMonitor').TrimEnd('\')) {
        $bootstrapArgument = '%LOCALAPPDATA%\OpenAI\CodexContextMonitor\login-startup.ps1'
    }
    $startupCommand = '"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $bootstrapArgument + '"'
    if ($startupCommand.Length -gt 260) { throw 'The login command exceeds the Windows Run limit.' }
    $null = New-Item -ItemType Directory -Path $directory -Force
    $source = Join-Path $PSScriptRoot 'start-on-login.ps1'
    if ((Test-Path -LiteralPath $bootstrap -PathType Leaf) -and (-not $owner -or (Get-BootstrapHash $bootstrap) -ne $owner.bootstrapHash)) { throw 'The login bootstrap was edited; it was preserved.' }
    [IO.File]::WriteAllBytes($bootstrap, [IO.File]::ReadAllBytes($source))
    if (-not (Test-Path -LiteralPath $RegistryPath)) { $null = New-Item -Path $RegistryPath -Force }
    $record = @{ name = $name; registryPath = $RegistryPath; command = $startupCommand; pluginId = $PluginId; codexHome = $CodexHome; nodePath = $NodePath; bootstrapHash = (Get-BootstrapHash $bootstrap) }
    [IO.File]::WriteAllText($ownerPath, ($record | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $null = New-ItemProperty -LiteralPath $RegistryPath -Name $name -PropertyType ExpandString -Value $startupCommand -Force
    @{ registered = $true; owned = $true; name = $name } | ConvertTo-Json -Compress
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }

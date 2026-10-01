[CmdletBinding()]
param([string]$LaunchUrl, [switch]$ResolveOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    if (-not $ResolveOnly -and $LaunchUrl -notmatch '^codex://browser\?url=[A-Za-z0-9%._~+*-]+$') {
        throw 'Invalid Codex browser launch URL.'
    }
    $desktopExecutable = $null
    if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
        $packages = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | Sort-Object { [Version]$_.Version } -Descending)
        foreach ($package in $packages) {
            $packageRoot = [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\', '/')
            $manifestPath = Join-Path $packageRoot 'AppxManifest.xml'
            if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
            $manifest = New-Object System.Xml.XmlDocument
            $manifest.XmlResolver = $null
            $manifest.Load($manifestPath)
            foreach ($application in $manifest.SelectNodes('//*[local-name()="Application"]')) {
                if ($application.SelectNodes('.//*[local-name()="Protocol" and @Name="codex"]').Count -eq 0) { continue }
                $relativeExecutable = $application.GetAttribute('Executable')
                if (-not $relativeExecutable) { continue }
                $candidate = [IO.Path]::GetFullPath((Join-Path $packageRoot $relativeExecutable))
                if (-not $candidate.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'The Codex executable is outside its package.'
                }
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $desktopExecutable = $candidate; break }
            }
            if ($desktopExecutable) { break }
        }
    }
    $registeredProtocol = Test-Path -LiteralPath 'Registry::HKEY_CLASSES_ROOT\codex'
    if (-not $desktopExecutable -and -not $registeredProtocol) {
        throw 'Codex Desktop was not found. Install Desktop or explicitly choose --external-browser.'
    }
    if ($ResolveOnly) {
        [PSCustomObject]@{ method = $(if ($desktopExecutable) { 'desktop-executable' } else { 'system-protocol' }); executable = $desktopExecutable } | ConvertTo-Json -Compress
        exit 0
    }
    if ($desktopExecutable) {
        # MSIX protocol activation can discard URL arguments. Starting the
        # manifest's executable lets Codex forward the link to its own instance.
        Start-Process -FilePath $desktopExecutable -ArgumentList $LaunchUrl -WindowStyle Hidden -ErrorAction Stop
    } else {
        Start-Process -FilePath $LaunchUrl -ErrorAction Stop
    }
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }

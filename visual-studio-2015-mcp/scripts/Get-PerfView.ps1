#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(?:\.\d+)?$')][string]$Version,
    [string]$DestinationRoot = (Join-Path $env:LOCALAPPDATA 'VS2015Mcp/Tools/PerfView')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Explicit versions make downloads reproducible. No PATH, registry or client
# settings are modified; only this tool's own versioned directory is published.
$root = [IO.Path]::GetFullPath($DestinationRoot)
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/microsoft/perfview/releases/tags/v$Version"
$assets = @($release.assets | Where-Object { $_.name -ceq 'PerfView.exe' })
if ($assets.Count -ne 1) { throw 'The official release does not contain exactly one PerfView.exe asset.' }
$asset = $assets[0]
if ($asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'The official asset has no verifiable SHA-256 digest.' }
$expectedHash = $Matches[1]
$uri = [uri]$asset.browser_download_url
if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or $uri.AbsolutePath -cne "/microsoft/perfview/releases/download/v$Version/PerfView.exe") { throw 'Unexpected official asset URL.' }
$destination = [IO.Path]::GetFullPath((Join-Path $root $Version))
$executable = Join-Path $destination 'PerfView.exe'
$exists = [IO.Directory]::Exists($destination)
if ($exists -and -not [IO.File]::Exists($executable)) { throw 'Version directory exists without PerfView.exe; choose a new DestinationRoot rather than replacing it.' }
$staging = if ($exists) { $destination } else { [IO.Path]::GetFullPath((Join-Path $root ('.pending-' + [guid]::NewGuid().ToString('N')))) }
$candidate = Join-Path $staging 'PerfView.exe'
if (-not $exists) {
    $null = [IO.Directory]::CreateDirectory($staging)
    Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $candidate
}
$actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
if ($actualHash -ine $expectedHash -or (Get-Item -LiteralPath $candidate).Length -ne $asset.size) { throw "Official asset integrity verification failed. Unpublished files remain at $staging" }
$signature = Get-AuthenticodeSignature -LiteralPath $candidate
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw "Expected a valid Microsoft signature; got $($signature.Status). Files remain at $staging" }
if (-not $exists) {
    $manifest = @{ version=$Version; release=$release.html_url; source=$uri.AbsoluteUri; sha256=$actualHash.ToLowerInvariant(); bytes=$asset.size
        signatureStatus=[string]$signature.Status; signer=$signature.SignerCertificate.Subject; obtainedAtUtc=[DateTimeOffset]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Join-Path $staging 'installation.json'), ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $staging.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not $destination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Publication paths are outside DestinationRoot.' }
    Move-Item -LiteralPath $staging -Destination $destination
}
@{ path=$executable; version=$Version; sha256=$actualHash.ToLowerInvariant(); signatureStatus=[string]$signature.Status; alreadyPresent=$exists } | ConvertTo-Json -Compress

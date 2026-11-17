#requires -Version 7.0
[CmdletBinding()]
param([string]$DestinationRoot = (Join-Path $env:LOCALAPPDATA 'VS2015Mcp\Tools\WindowsDebugger'), [switch]$ProbeHelp)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not [IO.Path]::IsPathFullyQualified($DestinationRoot)) { throw 'DestinationRoot must be fully qualified.' }
$DestinationRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($DestinationRoot))
$version = '1.2611.4001.0'
$finalPath = Join-Path $DestinationRoot $version
if (Test-Path -LiteralPath $finalPath) { throw "Destination already exists; refusing overwrite: $finalPath" }
$stagePath = Join-Path $DestinationRoot ('.download-' + [guid]::NewGuid().ToString('N'))
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$helperPath = Join-Path $PSScriptRoot 'get-debugger-range.mjs'
$json = & $nodePath $helperPath $stagePath
if ($LASTEXITCODE -ne 0) { throw "Range download failed. Partial staging directory retained for inspection: $stagePath" }
$manifest = ($json -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable
$signatures = @()
foreach ($file in $manifest.files) {
    $filePath = Join-Path $stagePath $file.path
    if ([IO.Path]::GetExtension($filePath) -in @('.exe', '.dll')) {
        $signature = Get-AuthenticodeSignature -LiteralPath $filePath
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
            throw "Microsoft Authenticode verification failed: $filePath ($($signature.Status)). No downloaded executable was run."
        }
        $signatures += @{ path = $file.path; status = [string]$signature.Status; subject = $signature.SignerCertificate.Subject; thumbprint = $signature.SignerCertificate.Thumbprint }
    }
}
$manifest.signatureVerified = $true
$manifest.signatures = $signatures
$manifest.directory = $finalPath
$manifest.cdbPath = Join-Path $finalPath 'cdb.exe'
[IO.File]::WriteAllText((Join-Path $stagePath 'download-manifest.json'), ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
if (-not $stagePath.StartsWith($DestinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    -not $finalPath.StartsWith($DestinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved move paths escaped DestinationRoot.' }
[IO.Directory]::Move($stagePath, $finalPath)
if ($ProbeHelp) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $manifest.cdbPath
    $info.ArgumentList.Add('-?')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = $finalPath
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill($true); $process.WaitForExit(); throw 'CDB help probe exceeded 30 seconds.' }
    $manifest.helpProbe = @{ exitCode = $process.ExitCode; stdout = $stdout.GetAwaiter().GetResult(); stderr = $stderr.GetAwaiter().GetResult() }
    $process.Dispose()
    [IO.File]::WriteAllText((Join-Path $finalPath 'help-probe.json'), ($manifest.helpProbe | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
$manifest | ConvertTo-Json -Depth 10 -Compress

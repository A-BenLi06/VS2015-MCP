#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSScriptRoot 'NativeProcess.psm1')

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    $tool = Get-Value $request 'tool'
    $filenames = @{ appdeploy = 'AppDeployCmd.exe'; xapdeploy = 'XapDeployCmd.exe'; winappdeploy = 'WinAppDeployCmd.exe' }
    if (-not $filenames.ContainsKey($tool)) { throw 'Unknown phone deployment tool.' }
    $explicitPath = Get-Value $request 'toolPath'
    if ($explicitPath) {
        $executable = [IO.Path]::GetFullPath($explicitPath)
        if ([IO.Path]::GetFileName($executable) -ine $filenames[$tool]) { throw 'Explicit toolPath must name the selected deployment executable.' }
    } else {
        $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Microsoft SDKs/Windows Phone'
        $candidates = switch ($tool) {
            'appdeploy' { Join-Path $sdkRoot 'v8.1/Tools/AppDeploy/AppDeployCmd.exe' }
            'xapdeploy' { Join-Path $sdkRoot 'v8.0/Tools/XAP Deployment/XapDeployCmd.exe' }
            'winappdeploy' {
                $kitRoot = try { Get-ItemPropertyValue 'HKLM:/SOFTWARE/WOW6432Node/Microsoft/Windows Kits/Installed Roots' 'KitsRoot10' } catch { Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10' }
                $bin = Join-Path $kitRoot 'bin'
                # The unversioned tool is shipped by the mobile-era SDK.
                Join-Path $bin 'x86/WinAppDeployCmd.exe'
                if (Test-Path -LiteralPath $bin) {
                    Get-ChildItem -LiteralPath $bin -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
                        Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'x86/WinAppDeployCmd.exe' }
                }
            }
        }
        $executable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Deployment tool is not installed. Supply toolPath for a custom SDK installation.' }
    $arguments = Get-Value $request 'arguments' @()
    if ($arguments -isnot [Array]) { throw 'arguments must be a string array.' }
    foreach ($argument in $arguments) { if ($argument -isnot [string] -or $argument.Contains([char]0)) { throw 'Invalid native argument.' } }
    $directory = [IO.Path]::GetFullPath((Get-Value $request 'workingDirectory' (Get-Location).Path))
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'workingDirectory must exist.' }
    $timeout = Get-Value $request 'timeoutMs' 120000
    $limit = Get-Value $request 'maxOutputChars' 64000
    if ($timeout -lt 100 -or $timeout -gt 3600000 -or $limit -lt 256 -or $limit -gt 1048576) { throw 'Invalid timeout or output limit.' }
    [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
    $encodingName = Get-Value $request 'encoding'
    $encoding = if ($encodingName) { [Text.Encoding]::GetEncoding([string]$encodingName) } else { [Text.Encoding]::GetEncoding([int][Vs2015Capture]::GetOEMCP()) }
    $safeArguments = [string[]]$arguments.Clone()
    $secrets = @()
    for ($i = 0; $i -lt $arguments.Length - 1; $i++) {
        if ($arguments[$i] -ieq '-pin') { $secrets += $arguments[$i + 1]; $safeArguments[$i + 1] = '[redacted]' }
    }
    if (Get-Value $request 'dryRun' $false) {
        $result = @{ dryRun = $true; executable = $executable; arguments = @($safeArguments); workingDirectory = $directory }
    } else {
        $result = Invoke-CapturedProcess -Executable $executable -Arguments $arguments -Directory $directory -TimeoutMs $timeout -Limit $limit -Encoding $encoding
        $result['arguments'] = @($safeArguments)
        foreach ($secret in $secrets) {
            if ($secret) { $result.stdout = $result.stdout.Replace($secret, '[redacted]'); $result.stderr = $result.stderr.Replace($secret, '[redacted]') }
        }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 12 -Compress))
} catch {
    [Console]::Out.WriteLine((@{error=@{code='PHONE_CLI_ERROR';message=$_.Exception.Message}} | ConvertTo-Json -Compress))
    exit 1
}

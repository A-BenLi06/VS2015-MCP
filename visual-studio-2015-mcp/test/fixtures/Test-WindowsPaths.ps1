param([string]$ScriptsDirectory = (Join-Path $PSScriptRoot '../../scripts'))
$ErrorActionPreference = 'Stop'
foreach ($name in @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'windir', 'SystemRoot')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
Import-Module (Join-Path $ScriptsDirectory 'WindowsPaths.psm1') -Force
$windows = Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::Windows)
$programs = @(Get-WindowsProgramDirectoryPaths)
if (-not [IO.Directory]::Exists($windows) -or $programs.Count -lt 1 -or @($programs | Where-Object { -not [IO.Directory]::Exists($_) }).Count) {
    throw 'Known-folder directories are unavailable'
}
if (@($programs | Select-Object -Unique).Count -ne $programs.Count) {
    throw 'Program directory enumeration contains duplicates'
}
$environment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment['ProgramFiles'] = 'explicit-program-directory-value'
$environment['PATH'] = 'explicit-search-path'
Add-WindowsSetupEnvironmentDefaults $environment
if ($environment['ProgramFiles'] -ne 'explicit-program-directory-value' -or $environment['PATH'] -ne 'explicit-search-path') {
    throw 'Existing setup environment values were overwritten'
}
if ($environment['windir'] -ne $windows -or $environment['SystemRoot'] -ne $windows -or -not [IO.File]::Exists($environment['ComSpec'])) {
    throw 'Missing child SDK setup defaults were not populated from actual OS folders'
}
foreach ($name in @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'windir', 'SystemRoot')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) {
        throw 'Parent environment was modified by directory resolution'
    }
}
@{
    passed = $true
    windows = $windows
    programDirectories = $programs
    childDefaultsAdded = $true
    existingValuesPreserved = $true
    parentEnvironmentStillAbsent = $true
} | ConvertTo-Json -Depth 5 -Compress

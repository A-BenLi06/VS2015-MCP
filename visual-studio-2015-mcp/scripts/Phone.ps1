# Runs in 32-bit Windows PowerShell 5.1 because the installed XDE assemblies target x86/.NET Framework.
# JSON input via stdin or -RequestFile; JSON output only. One request per process isolates SDK versions.
param([string]$RequestFile)
$ErrorActionPreference = 'Stop'
$script:CleanupWarnings=New-Object 'System.Collections.Generic.List[string]'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Import-Module (Join-Path $PSScriptRoot 'PhoneCore.psm1') -Force -DisableNameChecking

try {
    if ([IntPtr]::Size -ne 4 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Run Phone.ps1 with 32-bit Windows PowerShell 5.1 (SysWOW64), invoked by the PowerShell 7 server.' }
    $raw=if($RequestFile){[IO.File]::ReadAllText($RequestFile)}else{[Console]::In.ReadToEnd()}
    $request=$raw | ConvertFrom-Json
    Initialize-PhoneCore $request
    $result=Invoke-PhoneRequest $request
    @{ok=$true;action=$request.action;result=$result;cleanupWarnings=@(Get-PhoneCleanupWarnings)} | ConvertTo-Json -Depth 16 -Compress
} catch {
    @{ok=$false;error=@{code='PHONE_BACKEND_ERROR';message=$_.Exception.Message;detail=$_.ToString()}} | ConvertTo-Json -Depth 4 -Compress
    exit 1
}

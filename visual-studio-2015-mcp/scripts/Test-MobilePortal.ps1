# Interactive, local-only runner. The code is never put in argv or a transcript.
#Requires -Version 7.0
param([Parameter(Mandatory)][string]$ContextPath)
$ErrorActionPreference = 'Stop'
$context = Get-Content -LiteralPath $ContextPath -Raw | ConvertFrom-Json
$variableName = $context.pairingPinEnv
if ($variableName -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$') { throw 'Context must name pairingPinEnv.' }
$previous = [Environment]::GetEnvironmentVariable($variableName, 'Process')
$secret = Read-Host 'Press Pair in the phone developer settings, then enter its current six-character code' -AsSecureString
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    [Environment]::SetEnvironmentVariable($variableName, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer), 'Process')
    & node (Join-Path $PSScriptRoot 'validate-mobile-portal.mjs') $ContextPath
    if ($LASTEXITCODE -ne 0) { throw 'Mobile Portal validation failed; inspect the reported evidence directory.' }
} finally {
    [Environment]::SetEnvironmentVariable($variableName, $previous, 'Process')
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secret.Dispose()
}

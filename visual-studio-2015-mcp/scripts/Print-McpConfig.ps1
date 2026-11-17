#requires -Version 7.0
[CmdletBinding()]
param([string]$VsRoot, [string]$PerfViewPath, [string]$DebuggerRoot, [string]$HistoryRoot)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/server.mjs'))
$environment = @{ VS2015_MCP_PWSH = $pwsh }
if ($VsRoot) { $environment['VS2015_MCP_ROOT'] = [IO.Path]::GetFullPath($VsRoot) }
if ($PerfViewPath) {
    $full = [IO.Path]::GetFullPath($PerfViewPath)
    if (-not [IO.File]::Exists($full)) { throw 'PerfViewPath does not exist.' }
    $environment['VS2015_MCP_PERFVIEW'] = $full
}
if ($DebuggerRoot) {
    $full = [IO.Path]::GetFullPath($DebuggerRoot)
    if (-not [IO.Directory]::Exists($full)) { throw 'DebuggerRoot does not exist.' }
    $environment['VS2015_MCP_DEBUGGER_ROOT'] = $full
}
if ($HistoryRoot) { $environment['VS2015_MCP_HISTORY'] = [IO.Path]::GetFullPath($HistoryRoot) }
@{ mcpServers = @{ 'visual-studio-2015' = @{ command = $node; args = @($entry); env = $environment } } } | ConvertTo-Json -Depth 8

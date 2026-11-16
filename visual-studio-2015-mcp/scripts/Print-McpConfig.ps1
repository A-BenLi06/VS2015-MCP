#requires -Version 7.0
[CmdletBinding()]
param([string]$VsRoot)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop).Source
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/server.mjs'))
$environment = @{ VS2015_MCP_PWSH = $pwsh }
if ($VsRoot) { $environment['VS2015_MCP_ROOT'] = [IO.Path]::GetFullPath($VsRoot) }
@{ mcpServers = @{ 'visual-studio-2015' = @{ command = $node; args = @($entry); env = $environment } } } | ConvertTo-Json -Depth 8

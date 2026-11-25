param([string]$ScriptsDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('Fixture phase: clearing optional directory variables and importing PhoneCore.')
foreach($name in @('ProgramFiles','ProgramFiles(x86)','ProgramW6432','windir')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
Import-Module (Join-Path $ScriptsDirectory 'PhoneCore.psm1') -Force -DisableNameChecking
Initialize-PhoneCore ([pscustomobject]@{})
[Console]::Error.WriteLine('Fixture phase: resolving Windows known folders.')
$windows=Get-PhoneSystemPath ([Environment+SpecialFolder]::Windows)
$programFiles=Get-PhoneSystemPath ([Environment+SpecialFolder]::ProgramFilesX86)
if(-not [IO.Directory]::Exists($windows) -or -not [IO.Directory]::Exists($programFiles)){throw 'Actual Windows known folders were unavailable'}
[Console]::Error.WriteLine('Fixture phase: enumerating installed XDE and deployment tools.')
$xde=@(Get-XdeInstallations);$tools=@(Get-PhoneTools)
if(${env:ProgramFiles(x86)} -or $env:windir){throw 'The module fabricated environment variables instead of observing OS paths'}
@{passed=$true;windows=$windows;programFilesX86=$programFiles;xdeCount=$xde.Count;toolCount=$tools.Count;environmentStillAbsent=$true} | ConvertTo-Json -Compress

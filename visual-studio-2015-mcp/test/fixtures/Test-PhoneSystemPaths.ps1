param([string]$ScriptsDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
foreach($name in @('ProgramFiles','ProgramFiles(x86)','ProgramW6432','windir')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
Import-Module (Join-Path $ScriptsDirectory 'PhoneCore.psm1') -Force -DisableNameChecking
Initialize-PhoneCore ([pscustomobject]@{})
$windows=Get-PhoneSystemPath ([Environment+SpecialFolder]::Windows)
$programFiles=Get-PhoneSystemPath ([Environment+SpecialFolder]::ProgramFilesX86)
if(-not [IO.Directory]::Exists($windows) -or -not [IO.Directory]::Exists($programFiles)){throw 'Actual Windows known folders were unavailable'}
$xde=@(Get-XdeInstallations);$tools=@(Get-PhoneTools)
if(${env:ProgramFiles(x86)} -or $env:windir){throw 'The module fabricated environment variables instead of observing OS paths'}
@{passed=$true;windows=$windows;programFilesX86=$programFiles;xdeCount=$xde.Count;toolCount=$tools.Count;environmentStillAbsent=$true} | ConvertTo-Json -Compress

param([string]$ScriptsDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $ScriptsDirectory 'PhoneCore.psm1') -Force -PassThru -DisableNameChecking
Initialize-PhoneCore ([pscustomobject]@{})
& $module {
    $script:Queries=0;$script:FailVmQuery=$false;$script:Disposed=$false
    $script:Processes=@(
      [pscustomobject]@{processId=111;startTimeUtc='2026-11-18T00:00:00Z';vmName='Exact A';executable='C:\sdk\xde.exe'},
      [pscustomobject]@{processId=222;startTimeUtc='2026-11-18T00:00:01Z';vmName='Exact B';executable='C:\sdk\xde.exe'},
      [pscustomobject]@{processId=333;startTimeUtc='2026-11-18T00:00:02Z';vmName='exact a';executable='C:\sdk\xde.exe'})
    $script:Machines=@([pscustomobject]@{Name='11111111-2222-3333-4444-555555555555';ElementName='Exact A'},[pscustomobject]@{Name='AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';ElementName='Exact B'})
    function script:Get-XdeProcesses {return $script:Processes}
    function script:Get-XdeInstallations {return [pscustomobject]@{executable='C:\sdk\xde.exe'}}
    function script:Get-PhoneTools {return @()}
    function script:Get-CimInstance {param($Namespace,$ClassName,$ErrorAction);if($Namespace -ne 'root/virtualization/v2' -or $ClassName -ne 'Msvm_ComputerSystem'){throw 'Unexpected fake query'};$script:Queries++;if($script:FailVmQuery){throw (New-Object UnauthorizedAccessException('denied-by-fake-hyperv-query'))};return $script:Machines}
    function script:Get-Client($Process){$client=[pscustomobject]@{};$client | Add-Member ScriptMethod Dispose {$script:Disposed=$true};return $client}
    function script:Invoke-XdeOperation($Request,$Process,$Client,$InputObject){if($Request.action -ne 'status'){throw 'Unexpected fake operation'};return [pscustomobject]@{processId=$Process.processId;startTimeUtc=$Process.startTimeUtc;vmName=$Process.vmName;shellReady=$true;state='Running'}}
}
$script:Checks=0
function Assert([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:Checks++}
$discovered=Invoke-PhoneRequest ([pscustomobject]@{action='discover'})
Assert ((& $module {$script:Queries}) -eq 1) 'Discovery queried Hyper-V once per process'
Assert ($discovered.running.Count -eq 3 -and $discovered.running[0].vmId -eq '11111111-2222-3333-4444-555555555555') 'Actual exact VM GUID not returned'
Assert ($discovered.running[1].vmId -ceq 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') 'VM GUID not normalized'
Assert ($null -eq $discovered.running[2].vmId -and $discovered.running[2].identityUnavailable.code -eq 'PHONE_VM_NOT_FOUND') 'Case-insensitive display guess was accepted'
Assert ($discovered.running[0].startTimeUtc -eq '2026-11-18T00:00:00Z' -and $discovered.running[0].vmIdentityObservedAtUtc -eq $discovered.running[1].vmIdentityObservedAtUtc) 'Discovery lost process identity or combined different VM snapshots'
$ambiguous=Resolve-PhoneVmIdentity @{available=$true;observedAtUtc='test';machines=@([pscustomobject]@{Name='11111111-2222-3333-4444-555555555555';ElementName='Same'},[pscustomobject]@{Name='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';ElementName='Same'})} 'Same'
Assert ($null -eq $ambiguous.vmId -and $ambiguous.identityUnavailable.code -eq 'PHONE_VM_NAME_AMBIGUOUS') 'Ambiguous VM names selected first entry'
$invalid=Resolve-PhoneVmIdentity @{available=$true;observedAtUtc='test';machines=@([pscustomobject]@{Name='not-a-vm-guid';ElementName='Invalid'})} 'Invalid'
Assert ($null -eq $invalid.vmId -and $invalid.identityUnavailable.code -eq 'PHONE_VM_IDENTITY_INVALID') 'Invalid VM identifier was fabricated'
& $module {$script:FailVmQuery=$true;$script:Queries=0}
$unavailable=Invoke-PhoneRequest ([pscustomobject]@{action='discover'})
Assert ($unavailable.running.Count -eq 3 -and -not $unavailable.vmIdentitySnapshot.available -and (& $module {$script:Queries}) -eq 1) 'Unavailable VM query broke process discovery'
$status=Invoke-PhoneRequest ([pscustomobject]@{action='status';processId=111})
Assert ($status.shellReady -and $null -eq $status.vmId -and $status.identityUnavailable.code -eq 'PHONE_VM_QUERY_FAILED') 'Legacy status became unusable on VM query failure'
Assert ($status.startTimeUtc -eq '2026-11-18T00:00:00Z') 'Legacy status omitted process start identity'
try{Get-XdeVmIdentity ([pscustomobject]@{vmName='Exact A'});throw 'Strong session identity became permissive'}catch{Assert ($_.Exception.Message -like '*denied-by-fake-hyperv-query*') 'Strong session validation was relaxed'}
@{passed=$true;checks=$script:Checks;oneDiscoverySnapshot=$discovered.vmIdentitySnapshot;unavailableStatus=$status} | ConvertTo-Json -Depth 9 -Compress

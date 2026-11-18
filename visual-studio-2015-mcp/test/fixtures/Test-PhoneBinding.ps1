param([string]$ScriptsDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $ScriptsDirectory 'PhoneSessions.psm1') -Force -PassThru -DisableNameChecking
$core=Get-Module PhoneCore -All | Select-Object -First 1
& $core {
    $script:Target=[pscustomobject]@{processId=12346;startTimeUtc='2026-11-18T00:00:00.0000000Z';vmName='Owned endpoint VM';executable='C:\sdk\XDE.exe';directory='C:\sdk'}
    $script:Log=New-Object 'Collections.Generic.List[string]'
    $script:Client=[pscustomobject]@{Log=$script:Log}
    $script:Client | Add-Member ScriptMethod GetEndPoint {param($source,$destination);$source.Value='169.254.1.1';$destination.Value='169.254.1.2'}
    $script:Client | Add-Member ScriptMethod Dispose {$this.Log.Add('client:dispose')}
    $script:Device=[pscustomobject]@{Connected=$false;Source='::ffff:169.254.1.1';Destination='169.254.1.2';Log=$script:Log}
    $script:Device | Add-Member ScriptMethod IsConnected {return $this.Connected}
    $script:Device | Add-Member ScriptMethod Connect {$this.Connected=$true;$this.Log.Add('corecon:connect')}
    $script:Device | Add-Member ScriptMethod Disconnect {$this.Connected=$false;$this.Log.Add('corecon:disconnect')}
    $script:Device | Add-Member ScriptMethod GetEndPoints {param($port,$source,$destination,$destinationPort);$source.Value=$this.Source;$destination.Value=$this.Destination;$destinationPort.Value=$port}
    function script:Get-XdeProcesses {return $script:Target}
    function script:Get-XdeVmIdentity($Process){return '00000000-0000-0000-0000-000000000001'}
    function script:Get-Client($Process){return $script:Client}
    function script:Get-CoreConDevices([int]$LocaleId){if($LocaleId -eq 1033){return [pscustomobject]@{deviceId='00000000-0000-0000-0000-000000000002';emulator=$true;device=$script:Device}}}
}
& $module {
    param($core)
    $script:TestCore=$core
    function script:Get-Client($Process){return & $script:TestCore {param($p);Get-Client $p} $Process}
    function script:Get-XdeProcesses {return & $script:TestCore {Get-XdeProcesses}}
    function script:Get-XdeVmIdentity($Process){return & $script:TestCore {param($p);Get-XdeVmIdentity $p} $Process}
    function script:Get-CoreConDevices([int]$LocaleId){return & $script:TestCore {param($l);Get-CoreConDevices $l} $LocaleId}
} $core
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Invoke($Request){return Invoke-PhoneSessionRequest ([pscustomobject]$Request)}
$open=@{operation='open';processId=12346;expectedStartTimeUtc='2026-11-18T00:00:00.0000000Z';expectedVmId='00000000-0000-0000-0000-000000000001';coreConDeviceId='00000000-0000-0000-0000-000000000002';localeId=1033;coreConServicePort=6791}
$session=Invoke $open
Assert ($session.crossChannelMapping.matched -and $session.crossChannelMapping.method -eq 'sdk-endpoint-pair') 'No endpoint-pair evidence'
Assert ($session.crossChannelMapping.hostAddress -eq '169.254.1.1') 'Mapped IPv4 address did not normalize'
$id=$session.sessionId
$null=Invoke @{operation='identity';sessionId=$id}
& $core {$script:Device.Destination='169.254.1.99'}
try{Invoke @{operation='identity';sessionId=$id};throw 'Changed endpoint accepted'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_CHANNEL_TARGET_MISMATCH') 'Unexpected endpoint mismatch failure'}
$null=Invoke @{operation='close';sessionId=$id}
$log=& $core {return @($script:Log.ToArray())}
Assert ($log -contains 'corecon:disconnect') 'Own CoreCon connection not disconnected'
& $core {$script:Device.Destination='169.254.1.99';$script:Log.Clear()}
try{Invoke $open;throw 'Wrong profile endpoint accepted at open'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_CHANNEL_TARGET_MISMATCH') 'Unexpected open mismatch failure'}
$log=& $core {return @($script:Log.ToArray())}
Assert (($log -join '|') -eq 'corecon:connect|corecon:disconnect|client:dispose') 'Failed open did not clean own connection/client'
# A connection that predates this bridge is observed and never disconnected.
& $core {$script:Device.Destination='169.254.1.2';$script:Device.Connected=$true;$script:Log.Clear()}
$session=Invoke $open
$null=Invoke @{operation='close';sessionId=$session.sessionId}
$log=& $core {return @($script:Log.ToArray())}
Assert ($log -notcontains 'corecon:connect' -and $log -notcontains 'corecon:disconnect') 'Existing connection ownership was claimed'
foreach($address in @('0.0.0.0','::','::ffff:0.0.0.0','127.0.0.1')){
    try{& $module {param($value);ConvertTo-PhoneIp $value} $address;throw 'Non-guest endpoint accepted'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_ENDPOINT_UNAVAILABLE') 'Unexpected invalid endpoint failure'}
}
& $core {$script:Device.Source='169.254.1.99'}
try{Invoke $open;throw 'Changed host endpoint accepted'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_CHANNEL_TARGET_MISMATCH') 'Unexpected host endpoint failure'}
@{passed=$true;checks=11;preexistingConnectionLog=$log} | ConvertTo-Json -Depth 6 -Compress

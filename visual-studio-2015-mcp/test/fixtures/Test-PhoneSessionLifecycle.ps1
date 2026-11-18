param([string]$ScriptsDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $ScriptsDirectory 'PhoneSessions.psm1') -Force -PassThru -DisableNameChecking
$core=Get-Module PhoneCore -All | Select-Object -First 1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'namespace Microsoft.Xde.Common { public enum KeyboardKeyOption { Type, Press, Release } }'
& $core {
    $script:Log=New-Object 'Collections.Generic.List[string]'
    $script:ClientCount=0;$script:InputCount=0;$script:VmId='00000000-0000-0000-0000-000000000001'
    $script:Target=[pscustomobject]@{processId=12345;startTimeUtc='2026-11-18T00:00:00.0000000Z';vmName='Owned fake VM';executable='C:\sdk\XDE.exe';directory='C:\sdk';video='480x800'}
    $script:Input=[pscustomobject]@{Log=$script:Log}
    $script:Input | Add-Member ScriptMethod SendKeyboardKeys {param($keys,$mode);$this.Log.Add(('key:'+($keys -join ',')+':'+$mode))}
    $script:Feature=[pscustomobject]@{Log=$script:Log}
    $script:Feature | Add-Member ScriptMethod Dispose {$this.Log.Add('feature:dispose')}
    $script:Client=[pscustomobject]@{IsShellReady=$true;Log=$script:Log}
    $script:Client | Add-Member ScriptMethod Dispose {$this.Log.Add('client:dispose')}
    $script:Client | Add-Member ScriptMethod Close {throw 'VM Close must never be called by a session close'}
    function script:Get-XdeProcesses {return $script:Target}
    function script:Get-XdeVmIdentity($Process){return $script:VmId}
    function script:Get-Client($Process){$script:ClientCount++;return $script:Client}
    function script:Get-InputClient($Client,$Process){$script:InputCount++;return [pscustomobject]@{input=$script:Input;feature=$script:Feature;legacy=$false}}
    function script:Get-State($Client,$Process){return [pscustomobject]@{shellReady=$true;state='Running';processId=$Process.processId}}
}
& $module {
    param($core)
    $script:TestCore=$core
    function script:Get-Client($Process){return & $script:TestCore {param($p);Get-Client $p} $Process}
    function script:Get-InputClient($Client,$Process){return & $script:TestCore {param($c,$p);Get-InputClient $c $p} $Client $Process}
    function script:Get-XdeProcesses {return & $script:TestCore {Get-XdeProcesses}}
    function script:Get-XdeVmIdentity($Process){return & $script:TestCore {param($p);Get-XdeVmIdentity $p} $Process}
} $core
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Invoke($Request){if($Request.operation -eq 'open' -and -not $Request.ContainsKey('expectedVmId')){$Request.expectedVmId='00000000-0000-0000-0000-000000000001'};return Invoke-PhoneSessionRequest ([pscustomobject]$Request)}
try{Invoke @{operation='open';processId=12345;expectedStartTimeUtc='2026-11-18T00:00:00.0000000Z';expectedVmId='00000000-0000-0000-0000-000000000099'};throw 'Wrong VM GUID accepted'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_TARGET_CHANGED') 'Unexpected VM GUID failure'}
$session=Invoke @{operation='open';processId=12345;expectedStartTimeUtc='2026-11-18T00:00:00.0000000Z'}
$id=$session.sessionId
$pressed=Invoke @{operation='key';sessionId=$id;keys=@('ControlKey');mode='Press'}
Assert ($pressed.heldKeys.Count -eq 1) 'Press not retained'
$null=Invoke @{operation='key';sessionId=$id;keys=@('A');mode='Type'}
$state=Invoke @{operation='status';sessionId=$id}
Assert ($state.heldKeys -contains 'ControlKey') 'Control did not persist across requests'
try{Invoke @{operation='key';sessionId=$id;keys=@('ShiftKey');mode='Release'};throw 'Unowned Release was permitted'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_KEY_NOT_HELD') 'Unexpected release failure'}
try{Invoke @{operation='key';sessionId=$id;keys=@('ControlKey');mode='Type'};throw 'Type released held key'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_KEY_ALREADY_HELD') 'Unexpected held-type failure'}
$closed=Invoke @{operation='close';sessionId=$id}
Assert ($closed.closed -and -not $closed.vmClosed) 'Session close changed VM lifecycle'
Assert ($closed.unreleasedKeys.Count -eq 0 -and $closed.cleanupWarnings.Count -eq 0) 'Clean close failed'
$counts=& $core {return @{client=$script:ClientCount;input=$script:InputCount;log=@($script:Log.ToArray())}}
Assert ($counts.client -eq 1 -and $counts.input -eq 1) 'Clients were recreated'
Assert (($counts.log -join '|') -eq 'key:ControlKey:Press|key:A:Type|key:ControlKey:Release|feature:dispose|client:dispose') 'Lifecycle ordering differs'
# EOF uses the same Close-All path and releases only keys this session held.
$session=Invoke @{operation='open';processId=12345;expectedStartTimeUtc='2026-11-18T00:00:00.0000000Z'}
$id=$session.sessionId
$null=Invoke @{operation='key';sessionId=$id;keys=@('ShiftKey');mode='Press'}
$eof=Close-AllPhoneSessions
Assert ($eof.unreleasedKeys.Count -eq 0) 'EOF did not release owned key'
# A changed VM identity never receives key-up from the previous session.
$session=Invoke @{operation='open';processId=12345;expectedStartTimeUtc='2026-11-18T00:00:00.0000000Z'}
$id=$session.sessionId
$null=Invoke @{operation='key';sessionId=$id;keys=@('Menu');mode='Press'}
& $core {$script:Target.vmName='Different fake VM'}
try{Invoke @{operation='status';sessionId=$id};throw 'Changed identity accepted'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_TARGET_CHANGED') 'Unexpected identity failure'}
& $core {$script:Target.vmName='Owned fake VM';$script:VmId='00000000-0000-0000-0000-000000000002'}
try{Invoke @{operation='status';sessionId=$id};throw 'Same name changed GUID accepted'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_TARGET_CHANGED') 'Unexpected same-name GUID failure'}
$changed=Invoke @{operation='close';sessionId=$id}
Assert ($changed.unreleasedKeys -contains 'Menu') 'Unknown cleanup was reported as released'
$log=& $core {return @($script:Log.ToArray())}
Assert ($log -notcontains 'key:Menu:Release') 'Release was sent to a different target identity'
& $core {$script:Target.vmName='Owned fake VM';$script:VmId='00000000-0000-0000-0000-000000000001'}
# One bridge remains bound to one target even after a normal close.
& $core {$script:Target.directory='C:\other-sdk';$script:Target.executable='C:\other-sdk\XDE.exe'}
try{Invoke @{operation='open';processId=12345;expectedStartTimeUtc='2026-11-18T00:00:00.0000000Z'};throw 'Mixed SDK opened'}catch{Assert ($_.Exception.Data['code'] -eq 'PHONE_BRIDGE_TARGET_BOUND') 'Unexpected SDK scope failure'}
@{passed=$true;checks=11;firstSession=$counts;close=$closed;eof=$eof} | ConvertTo-Json -Depth 8 -Compress

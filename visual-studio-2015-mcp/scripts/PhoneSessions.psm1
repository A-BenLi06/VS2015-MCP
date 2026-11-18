# Persistent XDE session lifecycle; SDK primitives live in PhoneCore.psm1.
Import-Module (Join-Path $PSScriptRoot 'PhoneCore.psm1') -Force -DisableNameChecking
$script:Session=$null
$script:BoundTarget=$null

function New-PhoneSessionError([string]$Code,[string]$Message) {
    $exception=New-Object InvalidOperationException($Message)
    $exception.Data['code']=$Code
    return $exception
}
function Get-PhoneSessionIdentity($Process) {
    return [pscustomobject]@{processId=[int]$Process.processId;startTimeUtc=[string]$Process.startTimeUtc;vmId=(Get-XdeVmIdentity $Process);vmName=[string]$Process.vmName;executable=[string]$Process.executable;directory=[IO.Path]::GetFullPath([string]$Process.directory)}
}
function Test-PhoneSessionIdentity($Expected,$Actual) {
    return $Expected.processId -eq $Actual.processId -and $Expected.startTimeUtc -eq $Actual.startTimeUtc -and
        [string]::Equals($Expected.vmId,$Actual.vmId,[StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($Expected.vmName,$Actual.vmName,[StringComparison]::Ordinal) -and
        [string]::Equals($Expected.executable,$Actual.executable,[StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($Expected.directory,$Actual.directory,[StringComparison]::OrdinalIgnoreCase)
}
function Confirm-PhoneSessionTarget($Session) {
    $current=@(Get-XdeProcesses | Where-Object { $_.processId -eq $Session.identity.processId })
    if($current.Count -ne 1 -or -not (Test-PhoneSessionIdentity $Session.identity (Get-PhoneSessionIdentity $current[0]))) {
        throw (New-PhoneSessionError 'PHONE_TARGET_CHANGED' 'The selected XDE process, start time, VM or SDK changed. Close this session and use a new bridge for another target.')
    }
    return $current[0]
}
function ConvertTo-PhoneIp([string]$Value) {
    $address=$null
    if(-not [Net.IPAddress]::TryParse($Value,[ref]$address)){throw (New-PhoneSessionError 'PHONE_ENDPOINT_UNAVAILABLE' 'A channel returned an invalid IP address.')}
    if($address.IsIPv4MappedToIPv6){$address=$address.MapToIPv4()}
    if($address.Equals([Net.IPAddress]::Any) -or $address.Equals([Net.IPAddress]::IPv6Any) -or [Net.IPAddress]::IsLoopback($address)){
        throw (New-PhoneSessionError 'PHONE_ENDPOINT_UNAVAILABLE' 'An unspecified or loopback address does not identify an emulator guest channel.')
    }
    return $address
}
function Confirm-PhoneCoreConMapping($Session) {
    $binding=$Session.coreCon
    if(-not $binding){return $null}
    if(-not $binding.device.IsConnected()){throw (New-PhoneSessionError 'PHONE_CORECON_DISCONNECTED' 'The bound CoreCon device is no longer connected.')}
    $xdeHost='';$xdeGuest='';$Session.client.GetEndPoint([ref]$xdeHost,[ref]$xdeGuest)
    $source='';$destination='';$destinationPort=0
    $binding.device.GetEndPoints($binding.servicePort,[ref]$source,[ref]$destination,[ref]$destinationPort)
    if(-not (ConvertTo-PhoneIp $xdeHost).Equals((ConvertTo-PhoneIp $source)) -or -not (ConvertTo-PhoneIp $xdeGuest).Equals((ConvertTo-PhoneIp $destination))){
        throw (New-PhoneSessionError 'PHONE_CHANNEL_TARGET_MISMATCH' 'The selected CoreCon profile endpoints do not match both host and guest addresses observed by the selected XDE client.')
    }
    $binding.evidence=@{method='sdk-endpoint-pair';matched=$true;observedUtc=[DateTime]::UtcNow.ToString('o');deviceId=$binding.deviceId;localeId=$binding.localeId;servicePort=$binding.servicePort;destinationPort=$destinationPort;hostAddress=(ConvertTo-PhoneIp $source).ToString();guestAddress=(ConvertTo-PhoneIp $destination).ToString();vmId=$Session.identity.vmId;processId=$Session.identity.processId}
    return $binding.evidence
}
function Open-PhoneCoreConBinding($Session,$Request) {
    $deviceId=Get-Value $Request 'coreConDeviceId';$locale=Get-Value $Request 'localeId'
    if($null -eq $deviceId -and $null -eq $locale){return}
    $parsed=[guid]::Empty;$localeValue=0;$port=0
    if($null -eq $deviceId -or $null -eq $locale -or -not [guid]::TryParse([string]$deviceId,[ref]$parsed) -or -not [int]::TryParse([string]$locale,[ref]$localeValue) -or $localeValue -lt 1){throw (New-PhoneSessionError 'PHONE_INVALID_CORECON_BINDING' 'coreConDeviceId and localeId must be supplied together as an exact GUID and positive locale ID.')}
    if(-not [int]::TryParse([string](Get-Value $Request 'coreConServicePort' 0),[ref]$port) -or $port -lt 0 -or $port -gt 65535){throw (New-PhoneSessionError 'PHONE_INVALID_CORECON_BINDING' 'coreConServicePort must be 0..65535.')}
    $devices=@(Get-CoreConDevices $localeValue | Where-Object {$_.deviceId -ieq $parsed.ToString('D') -and $_.emulator})
    if($devices.Count -ne 1){throw (New-PhoneSessionError 'PHONE_CORECON_PROFILE_NOT_FOUND' 'The exact emulator profile GUID was not discovered for the selected CoreCon locale.')}
    $device=$devices[0].device
    $binding=@{device=$device;deviceId=$parsed.ToString('D');localeId=$localeValue;servicePort=$port;ownsConnection=$false;evidence=$null}
    $Session.coreCon=$binding
    if(-not $device.IsConnected()){$binding.ownsConnection=$true;$device.Connect()}
    # Connection can bootstrap an emulator. Revalidate the explicit XDE identity
    # before accepting the independent address-pair evidence.
    $null=Confirm-PhoneSessionTarget $Session
    $null=Confirm-PhoneCoreConMapping $Session
}
function Close-PhoneCoreConBinding($Session) {
    if($Session.coreCon -and $Session.coreCon.ownsConnection){$Session.coreCon.device.Disconnect()}
}
function Open-PhoneSession($Request) {
    if($null -ne $script:Session){throw (New-PhoneSessionError 'PHONE_SESSION_ALREADY_OPEN' 'This bridge already has an active emulator session.')}
    Initialize-PhoneCore $Request
    $process=Get-SelectedProcess $Request
    $identity=Get-PhoneSessionIdentity $process
    $expectedVmId=[guid]::Empty
    if(-not [guid]::TryParse([string](Require-Value $Request 'expectedVmId'),[ref]$expectedVmId) -or $expectedVmId.ToString('D') -ine $identity.vmId){
        throw (New-PhoneSessionError 'PHONE_TARGET_CHANGED' 'expectedVmId does not match the unique Hyper-V VM GUID observed for the selected XDE process.')
    }
    $expected=[string](Require-Value $Request 'expectedStartTimeUtc')
    $stamp=[DateTime]::MinValue
    if(-not [DateTime]::TryParse($expected,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$stamp) -or
        $stamp.ToUniversalTime().Ticks -ne [DateTime]::Parse($identity.startTimeUtc,$null,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks) {
        throw (New-PhoneSessionError 'PHONE_TARGET_CHANGED' 'expectedStartTimeUtc does not match the selected installed XDE process.')
    }
    if($script:BoundTarget -and -not (Test-PhoneSessionIdentity $script:BoundTarget $identity)){
        throw (New-PhoneSessionError 'PHONE_BRIDGE_TARGET_BOUND' 'Use a new bridge process for a different XDE target or SDK. Loaded SDK assemblies are not mixed.')
    }
    $lease=$null;$client=$null;$session=$null
    try {
        $lease=Enter-XdeLease $process
        $client=Get-Client $process
        $session=@{id=[guid]::NewGuid().ToString();identity=$identity;process=$process;client=$client;coreCon=$null;inputObject=$null;heldKeys=(New-Object 'System.Collections.Generic.Dictionary[string,int]' ([StringComparer]::OrdinalIgnoreCase));lease=$lease}
        $null=Confirm-PhoneSessionTarget $session
        Open-PhoneCoreConBinding $session $Request
        $script:BoundTarget=$identity;$script:Session=$session
        return @{sessionId=$session.id;identity=$identity;crossChannelMapping=$(if($session.coreCon){$session.coreCon.evidence}else{$null});inputClientCreated=$false;heldKeys=@();sdkScope='one-target-per-bridge';vmClosed=$false}
    } catch {
        $failure=$_;$cleanupWarnings=New-Object 'Collections.Generic.List[string]'
        if($session){try{Close-PhoneCoreConBinding $session}catch{$cleanupWarnings.Add($_.Exception.Message)}}
        if($client){try{$client.Dispose()}catch{$cleanupWarnings.Add($_.Exception.Message)}}
        if($lease){try{Exit-XdeLease $lease}catch{$cleanupWarnings.Add($_.Exception.Message)}}
        if($cleanupWarnings.Count){$failure.Exception.Data['cleanupWarnings']=@($cleanupWarnings.ToArray())}
        throw $failure
    }
}
function Get-RequiredPhoneSession($Request) {
    $id=[string](Require-Value $Request 'sessionId')
    if($null -eq $script:Session -or $id -cne $script:Session.id){throw (New-PhoneSessionError 'PHONE_SESSION_NOT_FOUND' 'No matching session exists in this bridge.')}
    return $script:Session
}
function ConvertTo-PhoneSessionKeys($Names) {
    $names=@($Names)
    if($names.Count -lt 1 -or $names.Count -gt 64){throw (New-PhoneSessionError 'PHONE_INVALID_KEYS' 'keys must contain 1..64 named virtual keys.')}
    $validNames=[Enum]::GetNames([Windows.Forms.Keys]);$values=@();$seen=New-Object 'System.Collections.Generic.HashSet[int]'
    foreach($name in $names){
        if($name -isnot [string] -or $validNames -notcontains $name){throw (New-PhoneSessionError 'PHONE_INVALID_KEYS' 'Only named virtual keys are accepted.')}
        $value=[int][Enum]::Parse([Windows.Forms.Keys],$name,$true)
        if($value -lt 1 -or $value -gt 255 -or -not $seen.Add($value)){throw (New-PhoneSessionError 'PHONE_INVALID_KEYS' 'Keys must be distinct virtual-key values 1..255; use ControlKey, ShiftKey or Menu for modifiers.')}
        $values+=,@{name=([Windows.Forms.Keys]$value).ToString();value=$value}
    }
    return $values
}
function Get-SessionInput($Session) {
    if($null -eq $Session.inputObject){
        if(-not $Session.client.IsShellReady){throw (New-PhoneSessionError 'PHONE_SHELL_NOT_READY' 'The emulator shell is not ready for input.')}
        $Session.inputObject=Get-InputClient $Session.client $Session.process
    }
    return $Session.inputObject
}
function Send-PhoneSessionKeys($Session,$Request) {
    $keys=@(ConvertTo-PhoneSessionKeys (Require-Value $Request 'keys'))
    $mode=[string](Get-Value $Request 'mode' 'Type')
    if($mode -notin @('Type','Press','Release')){throw (New-PhoneSessionError 'PHONE_INVALID_KEYS' 'mode must be Type, Press or Release.')}
    foreach($key in $keys){
        if($mode -eq 'Type' -and $Session.heldKeys.ContainsValue($key.value)){throw (New-PhoneSessionError 'PHONE_KEY_ALREADY_HELD' 'Type cannot release a key held by this session; use Release first.')}
        if($mode -eq 'Release' -and -not $Session.heldKeys.ContainsValue($key.value)){throw (New-PhoneSessionError 'PHONE_KEY_NOT_HELD' 'Release is limited to keys pressed by this session.')}
    }
    $inputObject=Get-SessionInput $Session
    foreach($key in $keys){
        if($mode -eq 'Press' -and $Session.heldKeys.ContainsValue($key.value)){continue}
        # Track a Press before dispatch, because a thrown SDK call can have issued
        # the key-down already. Cleanup then attempts its matching key-up.
        if($mode -eq 'Press'){$Session.heldKeys[$key.name]=$key.value}
        $request=[pscustomobject]@{action='key';keys=@($key.name);mode=$mode}
        $null=Invoke-XdeOperation $request $Session.process $Session.client $inputObject
        if($mode -eq 'Release'){$null=$Session.heldKeys.Remove($key.name)}
    }
    return @{action='key';mode=$mode;issued=$true;heldKeys=@($Session.heldKeys.Keys);sessionId=$Session.id;verification='Verify actual guest state; SDK input can return without a visible effect.'}
}
function Close-PhoneSession($Request) {
    $session=Get-RequiredPhoneSession $Request
    $warnings=New-Object 'System.Collections.Generic.List[string]'
    $unreleased=@()
    try {
        $identityValid=$false
        try{$null=Confirm-PhoneSessionTarget $session;$identityValid=$true}catch{$warnings.Add($_.Exception.Message)}
        if($identityValid -and $session.inputObject){
            foreach($name in @($session.heldKeys.Keys)){
                try{$null=Invoke-XdeOperation ([pscustomobject]@{action='key';keys=@($name);mode='Release'}) $session.process $session.client $session.inputObject;$null=$session.heldKeys.Remove($name)}
                catch{$warnings.Add($_.Exception.Message)}
            }
        }
        $unreleased=@($session.heldKeys.Keys)
    } finally {
        if($session.inputObject -and $session.inputObject.feature){try{$session.inputObject.feature.Dispose()}catch{$warnings.Add($_.Exception.Message)}}
        try{Close-PhoneCoreConBinding $session}catch{$warnings.Add($_.Exception.Message)}
        try{$session.client.Dispose()}catch{$warnings.Add($_.Exception.Message)}
        try{Exit-XdeLease $session.lease}catch{$warnings.Add($_.Exception.Message)}
        $script:Session=$null
    }
    return @{sessionId=$session.id;closed=$true;vmClosed=$false;unreleasedKeys=$unreleased;cleanupWarnings=@($warnings.ToArray())}
}
function Close-AllPhoneSessions {
    if($script:Session){return Close-PhoneSession ([pscustomobject]@{sessionId=$script:Session.id})}
}
function Invoke-PhoneSessionRequest($Request) {
    Reset-PhoneCleanupWarnings
    $operation=[string](Require-Value $Request 'operation')
    if($operation -eq 'open'){return Open-PhoneSession $Request}
    if($operation -eq 'close'){return Close-PhoneSession $Request}
    $session=Get-RequiredPhoneSession $Request
    $session.process=Confirm-PhoneSessionTarget $session
    $mapping=Confirm-PhoneCoreConMapping $session
    if($operation -eq 'identity'){return @{sessionId=$session.id;identity=$session.identity;crossChannelMapping=$mapping;inputClientCreated=($null -ne $session.inputObject);heldKeys=@($session.heldKeys.Keys)}}
    if($operation -notin @('status','endpoint','capture','tap','swipe','key','text','button')){throw (New-PhoneSessionError 'PHONE_UNKNOWN_OPERATION' 'Unsupported persistent emulator operation.')}
    if($operation -eq 'key'){return Send-PhoneSessionKeys $session $Request}
    $inputObject=$null
    if($operation -in @('tap','swipe','text','button')){$inputObject=Get-SessionInput $session}
    $Request | Add-Member -NotePropertyName action -NotePropertyValue $operation -Force
    $result=Invoke-XdeOperation $Request $session.process $session.client $inputObject
    $warnings=@(Get-PhoneCleanupWarnings)
    if($result -is [Collections.IDictionary]){$result.sessionId=$session.id;$result.heldKeys=@($session.heldKeys.Keys);$result.cleanupWarnings=$warnings}
    else{$result | Add-Member -NotePropertyName sessionId -NotePropertyValue $session.id -Force;$result | Add-Member -NotePropertyName heldKeys -NotePropertyValue @($session.heldKeys.Keys) -Force;$result | Add-Member -NotePropertyName cleanupWarnings -NotePropertyValue $warnings -Force}
    return $result
}
Export-ModuleMember -Function Invoke-PhoneSessionRequest,Close-AllPhoneSessions

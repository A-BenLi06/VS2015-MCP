#requires -Version 5.1
# Internal x86/.NET Framework adapter for a validated persistent PhoneSession.
# The MCP surface supplies typed operations, never a command line or script block.
Set-StrictMode -Version 2.0
$script:WprProfiles=@{cpu='CPU.Verbose.Memory'}
$script:WprOutputPath='\DATA\SharedData\PhoneTools\PwTools\log\wpr_output.txt'
$script:WprTempPath='\data\shareddata\phonetools\pwtools\temp'
$script:WprLogPath='\data\shareddata\phonetools\pwtools\log'

function Get-GuestWprValue($Object,[string]$Name,$Default=$null) {
    if($null -eq $Object){return $Default}
    if($Object -is [Collections.IDictionary]){if($Object.Contains($Name)){return $Object[$Name]};return $Default}
    if($null -ne $Object.PSObject.Properties[$Name]){return $Object.$Name};return $Default
}
function New-GuestWprError([string]$Code,[string]$Message,$Details=$null,[bool]$MayContinue=$false) {
    $e=New-Object InvalidOperationException($Message);$e.Data['code']=$Code
    if($null -ne $Details){$e.Data['details']=$Details}
    if($MayContinue){$e.Data['operationMayContinue']=$true}
    return $e
}
function Get-GuestWprUtc {return [DateTimeOffset]::UtcNow.ToString('o')}
function Get-GuestWprHash([byte[]]$Bytes) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Write-GuestWprJson([string]$Path,$Value) {
    $directory=[IO.Path]::GetDirectoryName($Path);[void][IO.Directory]::CreateDirectory($directory)
    $temp=Join-Path $directory ('.pending-'+[guid]::NewGuid().ToString('N')+'.json')
    try {
        $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($Value|ConvertTo-Json -Depth 32))
        $file=New-Object IO.FileStream($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
        # A unique previous receipt also preserves the lifecycle audit trail.
        # Passing a real backup path avoids Windows PowerShell5.1's null-to-empty
        # string conversion for File.Replace's optional backup filename.
        if([IO.File]::Exists($Path)){[IO.File]::Replace($temp,$Path,(Join-Path $directory ('.previous-'+[guid]::NewGuid().ToString('N')+'.json')))}else{[IO.File]::Move($temp,$Path)}
    } finally {if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
function Assert-GuestWprBinding($Controller) {
    if($Controller.transportInvalid){throw (New-GuestWprError 'GUEST_WPR_TRANSPORT_INVALID' 'The previous packet exchange is unconfirmed. Close this phone session before reconnecting. Preserve the capture receipt for recovery.')} 
    if($Controller.closed){throw (New-GuestWprError 'GUEST_WPR_CONTROLLER_CLOSED' 'Create a new controller for this phone session.')}
    $null=& $Controller.assertBinding $Controller.phoneSession
    $identity=$Controller.phoneSession.identity;$binding=$Controller.phoneSession.coreCon
    if($null -eq $binding -or $null -eq $binding.device -or
       [string]$identity.vmId -ine $Controller.target.vmId -or
       [string]$identity.startTimeUtc -cne $Controller.target.xdeStartTimeUtc -or
       [int]$identity.processId -ne $Controller.target.xdeProcessId -or
       [string]$binding.deviceId -ine $Controller.target.coreConDeviceId -or
       [int]$binding.localeId -ne $Controller.target.localeId){
        throw (New-GuestWprError 'GUEST_WPR_TARGET_CHANGED' 'The validated VM or CoreCon binding changed.')
    }
}
function Get-GuestWprCaptureView($Record) {
    return [ordered]@{captureId=$Record.captureId;state=$Record.state;target=$Record.target;profiles=@($Record.profiles);
        profileIds=@($Record.profileIds);receiptPath=$Record.receiptPath;outputDirectory=$Record.outputDirectory;
        startInterval=$Record.startInterval;stopInterval=$Record.stopInterval;trace=$Record.trace;metadata=$Record.metadata;
        lastStatus=$Record.lastStatus;operationMayContinue=$Record.operationMayContinue;traceAnalysis=$Record.traceAnalysis}
}
function Save-GuestWprCapture($Controller,$Record,[string]$EventName) {
    $Record.updatedAtUtc=Get-GuestWprUtc
    $Record.events.Add(@{kind=$EventName;timestampUtc=$Record.updatedAtUtc;state=$Record.state})
    Write-GuestWprJson $Record.receiptPath $Record
    if($null -ne $Controller.onEvent){$null=& $Controller.onEvent (Get-GuestWprCaptureView $Record) $EventName}
}
function New-Wp81GuestWprController {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$PhoneSession,[Parameter(Mandatory)][scriptblock]$AssertBinding,
        [Parameter(Mandatory)][string]$ArtifactRoot,[scriptblock]$OnEvent,
        [scriptblock]$TransportFactory)
    if($ArtifactRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])'){throw (New-GuestWprError 'GUEST_WPR_INVALID_PATH' 'ArtifactRoot must be an absolute drive or UNC path.')}
    if($null -eq $PhoneSession.coreCon){throw (New-GuestWprError 'GUEST_WPR_BINDING_REQUIRED' 'Open the phone session with an exact CoreCon GUID, locale and validated endpoint mapping first.')}
    $identity=$PhoneSession.identity;$binding=$PhoneSession.coreCon
    # The injected transport is an INTERNAL test seam, never accepted from MCP JSON.
    if($null -eq $TransportFactory){
        $version=[Diagnostics.FileVersionInfo]::GetVersionInfo([string]$identity.executable)
        if($version.FileMajorPart -ne 8 -or $version.FileMinorPart -ne 1){throw (New-GuestWprError 'GUEST_WPR_PLATFORM_UNSUPPORTED' 'This adapter requires the installed WP8.1 XDE target. Win10M uses its own feature-probed backend.')}
    }
    $target=[ordered]@{vmId=[string]$identity.vmId;xdeProcessId=[int]$identity.processId;xdeStartTimeUtc=[string]$identity.startTimeUtc;
        coreConDeviceId=[string]$binding.deviceId;localeId=[int]$binding.localeId}
    $controller=@{phoneSession=$PhoneSession;assertBinding=$AssertBinding;target=$target;artifactRoot=[IO.Path]::GetFullPath($ArtifactRoot);
        transportInvalid=$false;onEvent=$OnEvent;transportFactory=$TransportFactory;transport=$null;
        captures=@{};activeCaptureId=$null;sequence=0;closed=$false;controllerId=[guid]::NewGuid().ToString('D')}
    Assert-GuestWprBinding $controller
    return $controller
}
function Get-Wp81GuestWprCapabilities {
    return @{platform='wp81';profiles=@(@{profile='cpu';sdkProfileId=$script:WprProfiles.cpu;validated=$true;metrics=@('guest CPU samples','native/module stacks');managedGcSupported=$false;managedHeapSupported=$false});
        firstStatusStartsDeveloperAgent=$true;nativeStatusCanBeUnknown=$true;automaticCancel=$false;
        ownership='Requires exclusiveGuest and an unchanged observed native status fingerprint. Unknown status requires explicit allowUnknownStatus. External WPR clients are outside the session lock.'}
}
function Wait-GuestWprPacket($Stream,[int]$TimeoutMs) {
    $watch=[Diagnostics.Stopwatch]::StartNew()
    while(-not $Stream.IsPacketAvailable()) {
        if(-not $Stream.IsConnected()){throw (New-GuestWprError 'GUEST_WPR_STREAM_DISCONNECTED' 'The developer service disconnected.')}
        if($watch.ElapsedMilliseconds -ge $TimeoutMs){throw (New-GuestWprError 'GUEST_WPR_COMMAND_TIMEOUT' 'The developer service did not respond within its command budget.')}
        Start-Sleep -Milliseconds 25
    }
    return $Stream.Read()
}
function Initialize-GuestWprTransport($Controller) {
    if($null -ne $Controller.transport){return}
    Assert-GuestWprBinding $Controller
    if($null -ne $Controller.transportFactory){$Controller.transport=& $Controller.transportFactory $Controller;return}
    $device=$Controller.phoneSession.coreCon.device;$deployer=$device.GetFileDeployer();$stream=$null
    try {
        foreach($id in @('37211F72-FDB4-431B-AAAA-EBAC8F5C6BCB','280D7035-D88D-47CF-A90C-2B19717B5C34')){
            $objectId=New-Object Microsoft.SmartDevice.Connectivity.ObjectId([guid]$id);$deployer.DownloadPackage($objectId)
        }
        Assert-GuestWprBinding $Controller
        $agent=$device.GetRemoteAgent((New-Object Microsoft.SmartDevice.Connectivity.ObjectId([guid]'280D7035-D88D-47CF-A90C-2B19717B5C34')))
        $agent.Start('');$stream=$agent.CreatePacketStream((New-Object Microsoft.SmartDevice.Connectivity.ObjectId([guid]'C48B1B43-A833-41F7-9E76-47AC1513E7F6')))
        $hello=Wait-GuestWprPacket $stream 30000;$version=$hello.ReadString();$features=$hello.ReadString();$parsed=$null
        if(-not [Version]::TryParse($version,[ref]$parsed) -or $parsed.Major -ne 8 -or $parsed.Minor -ne 1){throw (New-GuestWprError 'GUEST_WPR_AGENT_VERSION_UNSUPPORTED' 'The selected developer service is not the verified WP8.1 protocol.' @{version=$version;features=$features})}
        Assert-GuestWprBinding $Controller
        $Controller.transport=@{stream=$stream;deployer=$deployer;agent=$agent;version=$version;features=$features;exchange=$null;receive=$null;close=$null}
    } catch {if($stream){try{$stream.Close()}catch{}};throw}
}
function Invoke-GuestWprCommand($Controller,[ValidateSet('status','start','stop')][string]$Operation,$Record,[int]$TimeoutMs=60000) {
    Assert-GuestWprBinding $Controller;Initialize-GuestWprTransport $Controller
    $argument=switch($Operation){'status'{'-status'}'start'{'-start '+($Record.profileIds -join ' ')+' -temppath '+$script:WprTempPath}'stop'{'-stop '+$Record.guestEtlPath+' '+$script:WprTempPath}}
    $Controller.sequence++;$commandId=[guid]::NewGuid().ToString('N')
    $directory=if($null -ne $Record){Join-Path $Record.outputDirectory 'commands'}else{Join-Path $Controller.artifactRoot ('status-'+$Controller.controllerId)}
    [void][IO.Directory]::CreateDirectory($directory);$path=Join-Path $directory ($Controller.sequence.ToString('D6')+'-'+$commandId+'.txt')
    $dispatchUtc=Get-GuestWprUtc;$dispatchTicks=[Diagnostics.Stopwatch]::GetTimestamp();$dispatched=$false
    try {
        $dispatched=$true
        if($null -ne $Controller.transport.exchange){$reply=& $Controller.transport.exchange $Controller $Operation @($argument) $TimeoutMs}
        else {
            $packet=New-Object Microsoft.SmartDevice.Connectivity.Packet;$packet.WriteString('startWpr');$packet.WriteString($argument)
            $Controller.transport.stream.Write($packet);$response=Wait-GuestWprPacket $Controller.transport.stream $TimeoutMs
            $code=$response.ReadInt32();$count=$response.ReadInt32();if($count -lt 0 -or $count -gt 1024){throw (New-GuestWprError 'GUEST_WPR_RESPONSE_INVALID' 'Invalid service response payload count.')}
            $payload=@();for($i=0;$i -lt $count;$i++){$payload+=,$response.ReadString()};$reply=@{code=$code;payload=$payload}
        }
        Assert-GuestWprBinding $Controller
        if([int]$reply.code -ne 0){throw (New-GuestWprError 'GUEST_WPR_TRANSPORT_ERROR' 'The developer service rejected the command.' @{transportCode=$reply.code;payload=@($reply.payload)})}
        $payload=@($reply.payload)
        if($payload.Count -ne 1 -or [string]$payload[0] -ine $script:WprOutputPath){throw (New-GuestWprError 'GUEST_WPR_RESPONSE_INVALID' 'The service did not return the expected developer log path.')}
        if($null -ne $Controller.transport.receive){$null=& $Controller.transport.receive $Controller $script:WprOutputPath $path}
        else{$Controller.transport.deployer.ReceiveFile($script:WprOutputPath,$path,$true)}
        Assert-GuestWprBinding $Controller
        $bytes=[IO.File]::ReadAllBytes($path);if($bytes.Length -gt 1048576){throw (New-GuestWprError 'GUEST_WPR_OUTPUT_TOO_LARGE' 'Native command output exceeded one megabyte.')}
        $text=[IO.File]::ReadAllText($path);$hresults=@([regex]::Matches($text,'0x[0-9A-Fa-f]{8}')|ForEach-Object{$_.Value})
        $failed=@($hresults|Where-Object{[Convert]::ToUInt32($_.Substring(2),16) -ge 2147483648})
        return [ordered]@{operation=$Operation;transportCode=[int]$reply.code;argument=$argument;nativeOutputPath=$path;nativeOutput=$text;
            nativeOutputFingerprint=(Get-GuestWprHash $bytes);nativeHresults=$hresults;failingNativeHresults=$failed;
            dispatchedAtUtc=$dispatchUtc;dispatchStopwatchTicks=$dispatchTicks;stopwatchFrequency=[Diagnostics.Stopwatch]::Frequency;completedAtUtc=(Get-GuestWprUtc)}
    } catch {
        if(-not $dispatched){throw}
        $Controller.transportInvalid=$true
        throw (New-GuestWprError 'GUEST_WPR_COMMAND_UNCONFIRMED' 'The command may have executed; inspect its receipt and guest status before another mutation.' @{operation=$Operation;argument=$argument;dispatchedAtUtc=$dispatchUtc;nativeOutputPath=$path;cause=$_.Exception.Message} $true)
    }
}
function ConvertFrom-GuestWprStatus($Command) {
    $lines=@([regex]::Split([string]$Command.nativeOutput,'[\r\n]+')|ForEach-Object{$_.Trim()}|Where-Object{$_})
    $state='unknown';$profiles=@()
    # This is the verified, unlocalized protocol signature embedded in WpWpr8.1,
    # not a locale guess. No failure text is classified as an idle recording.
    if(@($Command.failingNativeHresults).Count -eq 0 -and $lines.Count -gt 0 -and $lines[0] -ceq 'Logging is active') {
        $state='recording'
        if($lines.Count -gt 1){$profiles=@($lines[1..($lines.Count-1)]|ForEach-Object{($_ -split ',')[0].Trim()})}
    }
    return @{state=$state;profileIds=$profiles;fingerprint=$Command.nativeOutputFingerprint;native=$Command}
}
function Get-Wp81GuestWprStatus {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Controller,[int]$CommandTimeoutMs=60000)
    if($CommandTimeoutMs -lt 1000 -or $CommandTimeoutMs -gt 180000){throw (New-GuestWprError 'GUEST_WPR_INVALID_TIMEOUT' 'commandTimeoutMs must be1000..180000.')}
    $record=$null;if($Controller.activeCaptureId){$record=$Controller.captures[$Controller.activeCaptureId]}
    $status=ConvertFrom-GuestWprStatus (Invoke-GuestWprCommand $Controller 'status' $record $CommandTimeoutMs)
    if($record){$record.lastStatus=$status;Save-GuestWprCapture $Controller $record 'guestWprStatus'}
    return @{target=$Controller.target;activeCaptureId=$Controller.activeCaptureId;status=$status;capture=$(if($record){Get-GuestWprCaptureView $record}else{$null})}
}
function Test-GuestWprProfileSet($First,$Second) {
    $a=@($First|Sort-Object -Unique);$b=@($Second|Sort-Object -Unique)
    if($a.Count -ne $b.Count){return $false}
    for($i=0;$i -lt $a.Count;$i++){if([string]$a[$i] -cne [string]$b[$i]){return $false}}
    return $true
}
function Start-Wp81GuestWprCapture {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Controller,[Parameter(Mandatory)]$Request)
    Assert-GuestWprBinding $Controller
    if($Controller.activeCaptureId){throw (New-GuestWprError 'GUEST_WPR_CAPTURE_ACTIVE' 'Inspect or stop this controller''s existing capture first.')}
    if((Get-GuestWprValue $Request 'exclusiveGuest') -isnot [bool] -or (Get-GuestWprValue $Request 'exclusiveGuest') -ne $true){throw (New-GuestWprError 'GUEST_WPR_EXCLUSIVE_REQUIRED' 'An explicitly exclusive guest session is required.')}
    $profiles=@(Get-GuestWprValue $Request 'profiles' @('cpu'))
    if($profiles.Count -lt 1 -or $profiles.Count -gt 1){throw (New-GuestWprError 'GUEST_WPR_PROFILE_UNSUPPORTED' 'This validated adapter currently captures the cpu profile only.')}
    $profileIds=@();foreach($profile in $profiles){if($profile -isnot [string] -or -not $script:WprProfiles.ContainsKey($profile)){throw (New-GuestWprError 'GUEST_WPR_PROFILE_UNSUPPORTED' 'Select a validated profile from capabilities.')};$profileIds+=,$script:WprProfiles[$profile]}
    $expected=[string](Get-GuestWprValue $Request 'observedStatusFingerprint')
    if($expected -cnotmatch '^[a-f0-9]{64}$'){throw (New-GuestWprError 'GUEST_WPR_STATUS_FINGERPRINT_REQUIRED' 'Supply the exact fingerprint from the last native status observation.')}
    $status=(Get-Wp81GuestWprStatus $Controller).status
    if($status.state -eq 'recording'){throw (New-GuestWprError 'GUEST_WPR_FOREIGN_RECORDING' 'An existing recording is active. No start, stop or cancel was issued.' $status)}
    if($status.fingerprint -cne $expected){throw (New-GuestWprError 'GUEST_WPR_STATUS_CHANGED' 'The native status changed after observation; inspect it again.' $status)}
    if(@($status.native.failingNativeHresults).Count){throw (New-GuestWprError 'GUEST_WPR_STATUS_FAILED' 'Native status returned a failing HRESULT.' $status)}
    if($status.state -eq 'unknown' -and (Get-GuestWprValue $Request 'allowUnknownStatus' $false) -cne $true){
        throw (New-GuestWprError 'GUEST_WPR_STATUS_UNKNOWN' 'Inspect the native output. Set allowUnknownStatus only when explicitly starting on this exclusively controlled guest despite its unchanged unknown status.' $status)
    }
    if($Controller.captures.Count -ge 32){throw (New-GuestWprError 'GUEST_WPR_CAPTURE_LIMIT' 'Open a new phone session after 32 completed captures.')}
    $id=[guid]::NewGuid().ToString('D');$directory=Join-Path $Controller.artifactRoot ('capture-'+$id)
    $record=[ordered]@{schemaVersion=1;captureId=$id;controllerId=$Controller.controllerId;state='starting';target=$Controller.target;
        profiles=$profiles;profileIds=$profileIds;guestEtlPath=(Join-Path $script:WprLogPath ($id+'.etl'));outputDirectory=$directory;
        receiptPath=(Join-Path $directory 'capture.json');startInterval=$null;stopInterval=$null;startCommand=$null;stopCommand=$null;trace=$null;lastStatus=$status;
        metadata=(Get-GuestWprValue $Request 'metadata' @{});operationMayContinue=$true;events=(New-Object 'Collections.Generic.List[object]');
        traceAnalysis=@{state='not-analyzed';managedGc='not-enabled';managedHeap='not-enabled';symbols='not-verified'};updatedAtUtc=(Get-GuestWprUtc)}
    $Controller.captures[$id]=$record;$Controller.activeCaptureId=$id;Save-GuestWprCapture $Controller $record 'guestWprStarting'
    try {
        $command=Invoke-GuestWprCommand $Controller 'start' $record
        $record.startInterval=@{earliestUtc=$command.dispatchedAtUtc;latestUtc=$null;dispatchStopwatchTicks=$command.dispatchStopwatchTicks;stopwatchFrequency=$command.stopwatchFrequency}
        $record.startCommand=$command
        if(@($command.failingNativeHresults).Count){throw (New-GuestWprError 'GUEST_WPR_NATIVE_START_FAILED' 'WpWpr reported a failing native HRESULT.' $command $true)}
        $running=(Get-Wp81GuestWprStatus $Controller).status;$record.lastStatus=$running
        if($running.state -ne 'recording' -or -not (Test-GuestWprProfileSet $running.profileIds $profileIds)){throw (New-GuestWprError 'GUEST_WPR_START_UNCONFIRMED' 'The native status did not confirm exactly the requested profile set.' $running $true)}
        $record.startInterval.latestUtc=$running.native.completedAtUtc;$record.state='recording';$record.operationMayContinue=$false
        Save-GuestWprCapture $Controller $record 'guestWprRecording';return Get-GuestWprCaptureView $record
    } catch {$cause=$_.Exception;$record.state='start-unconfirmed';$record.operationMayContinue=$true;try{Save-GuestWprCapture $Controller $record 'guestWprStartUnconfirmed'}catch{};throw (New-GuestWprError 'GUEST_WPR_START_UNCONFIRMED' 'The recording may have started. Inspect the durable receipt and native status; do not replay Start.' @{capture=(Get-GuestWprCaptureView $record);cause=$cause.Message;causeHresult=$cause.HResult} $true)}
}
function Stop-Wp81GuestWprCapture {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Controller,[Parameter(Mandatory)]$Request)
    Assert-GuestWprBinding $Controller
    $id=[string](Get-GuestWprValue $Request 'captureId')
    if(-not $id -or $id -cne $Controller.activeCaptureId -or -not $Controller.captures.ContainsKey($id)){throw (New-GuestWprError 'GUEST_WPR_CAPTURE_NOT_OWNED' 'Stop requires this controller''s active capture ID.')}
    if((Get-GuestWprValue $Request 'exclusiveGuest') -isnot [bool] -or (Get-GuestWprValue $Request 'exclusiveGuest') -ne $true){throw (New-GuestWprError 'GUEST_WPR_EXCLUSIVE_REQUIRED' 'Confirm the same exclusive guest session before stopping.')}
    $record=$Controller.captures[$id]
    if($record.state -notin @('recording','start-unconfirmed')){
        throw (New-GuestWprError 'GUEST_WPR_STOP_ALREADY_DISPATCHED' 'Stop was already dispatched. Inspect the receipt and native status before manual recovery.' (Get-GuestWprCaptureView $record) $true)
    }
    $status=(Get-Wp81GuestWprStatus $Controller).status
    if($status.state -ne 'recording' -or -not (Test-GuestWprProfileSet $status.profileIds $record.profileIds)){throw (New-GuestWprError 'GUEST_WPR_RECORDING_CHANGED' 'Active profiles no longer exactly match the owned capture; no stop or cancel was issued.' $status)}
    $record.state='stopping';$record.operationMayContinue=$true;Save-GuestWprCapture $Controller $record 'guestWprStopping'
    try {
        $command=Invoke-GuestWprCommand $Controller 'stop' $record 180000;$record.stopCommand=$command
        $record.stopInterval=@{earliestUtc=$command.dispatchedAtUtc;latestUtc=$command.completedAtUtc;dispatchStopwatchTicks=$command.dispatchStopwatchTicks;stopwatchFrequency=$command.stopwatchFrequency}
        if(@($command.failingNativeHresults).Count){throw (New-GuestWprError 'GUEST_WPR_NATIVE_STOP_FAILED' 'WpWpr reported a failing native HRESULT.' $command $true)}
        $path=Join-Path $record.outputDirectory 'trace.etl'
        if($null -ne $Controller.transport.receive){$null=& $Controller.transport.receive $Controller $record.guestEtlPath $path}
        else{$Controller.transport.deployer.ReceiveFile($record.guestEtlPath,$path,$true)}
        Assert-GuestWprBinding $Controller
        $file=Get-Item -LiteralPath $path
        if($file.Length -lt 4096){throw (New-GuestWprError 'GUEST_WPR_ETL_INVALID' 'The unique guest trace is absent or too small.')}
        $stream=[IO.File]::OpenRead($path);$header=New-Object byte[] 4
        try{if($stream.Read($header,0,4) -ne 4){throw (New-GuestWprError 'GUEST_WPR_ETL_INVALID' 'Missing ETL buffer header.')}}finally{$stream.Dispose()}
        $buffer=[BitConverter]::ToUInt32($header,0)
        if($buffer -lt 4096 -or $buffer -gt 16777216 -or $buffer%1024 -ne 0 -or $file.Length -lt $buffer){throw (New-GuestWprError 'GUEST_WPR_ETL_INVALID' 'The downloaded file does not have a plausible ETL buffer header.')}
        $record.trace=@{path=$path;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();bufferSize=$buffer;headerPlausible=$true;eventContentValidated=$false}
        $record.state='stopped-artifact-verified';$record.operationMayContinue=$false
        $record.lastStatus=(Get-Wp81GuestWprStatus $Controller).status
        if($record.lastStatus.state -eq 'recording'){throw (New-GuestWprError 'GUEST_WPR_STOP_UNCONFIRMED' 'The native status still reports an active recording after Stop.' $record.lastStatus $true)}
        Save-GuestWprCapture $Controller $record 'guestWprStopped';$Controller.activeCaptureId=$null
        return Get-GuestWprCaptureView $record
    } catch {$cause=$_.Exception;$record.state='stop-unconfirmed';$record.operationMayContinue=$true;try{Save-GuestWprCapture $Controller $record 'guestWprStopUnconfirmed'}catch{};throw (New-GuestWprError 'GUEST_WPR_STOP_UNCONFIRMED' 'Stop may have executed. Inspect the durable receipt, artifact and native status before another mutation.' @{capture=(Get-GuestWprCaptureView $record);cause=$cause.Message;causeHresult=$cause.HResult} $true)}
}
function Close-Wp81GuestWprController {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Controller)
    $warnings=@()
    if($Controller.activeCaptureId){$record=$Controller.captures[$Controller.activeCaptureId];$warnings+=,@{code='GUEST_WPR_CAPTURE_MAY_CONTINUE';captureId=$record.captureId;receiptPath=$record.receiptPath};try{Save-GuestWprCapture $Controller $record 'guestWprControllerClosing'}catch{$warnings+=,@{code='GUEST_WPR_RECEIPT_WRITE_FAILED';message=$_.Exception.Message}}}
    if($Controller.transport){try{if($null -ne $Controller.transport.close){$null=& $Controller.transport.close $Controller}else{$Controller.transport.stream.Close()}}catch{$warnings+=,@{code='GUEST_WPR_STREAM_CLOSE_FAILED';message=$_.Exception.Message}}}
    $Controller.closed=$true;return @{closed=$true;recordingCancelled=$false;coreConDisconnected=$false;warnings=$warnings}
}
Export-ModuleMember -Function New-Wp81GuestWprController,Get-Wp81GuestWprCapabilities,Get-Wp81GuestWprStatus,Start-Wp81GuestWprCapture,Stop-Wp81GuestWprCapture,Close-Wp81GuestWprController

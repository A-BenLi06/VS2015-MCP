param([Parameter(Mandatory=$true)][string]$ScriptsDirectory,[string]$OutputRoot)
#requires -Version 5.1
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Import-Module (Join-Path $ScriptsDirectory 'GuestWpr.psm1') -Force -DisableNameChecking
trap { [Console]::Error.WriteLine(($_.Exception.Data|ConvertTo-Json -Depth 20 -Compress));throw }
$root=if($OutputRoot){$OutputRoot}else{Join-Path ([IO.Path]::GetTempPath()) ('wpr-unit-'+[guid]::NewGuid().ToString('N'))}
$tests=New-Object 'Collections.Generic.List[object]'
function Assert-Test($Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Expect-Code([scriptblock]$Body,[string]$Code,[bool]$MayContinue=$false){
    $caught=$null;try{$null=& $Body}catch{$caught=$_.Exception}
    Assert-Test ($null -ne $caught) ('Expected '+$Code)
    Assert-Test ($caught.Data['code'] -eq $Code) ('Wrong error: '+$caught.Message+' / '+$caught.Data['code'])
    Assert-Test (([bool]$caught.Data['operationMayContinue']) -eq $MayContinue) 'Wrong replay/continuation flag'
}
function New-Fixture([string]$Name){
    $vm=[guid]::NewGuid().ToString('D');$device=[guid]::NewGuid().ToString('D');$start='2026-11-18T03:55:26.9186964Z'
    $session=@{identity=@{vmId=$vm;processId=42368;startTimeUtc=$start;executable='not-used-by-fake'};coreCon=@{device=@{};deviceId=$device;localeId=1033}}
    $factory={param($controller)
        return @{version='8.1.0.1';features='test';
            exchange={param($c,$operation,$arguments,$timeout)
                $s=$c.testState;[void]$s.operations.Add(@{operation=$operation;arguments=$arguments})
                switch($operation){
                    'status' {if($s.activeProfiles.Count){$s.output='Logging is active'+"`r`r`n"+($s.activeProfiles -join "`r`r`n")+"`r`r`n"}else{$s.output='Failed to query active profiles'+"`r`r`n"}}
                    'start' {if($s.failStart){$s.output='Failed to add profile: 0x80070716'+"`r`n"}else{$s.activeProfiles=@('CPU.Verbose.Memory');$s.output=''}}
                    'stop' {$s.activeProfiles=@();$s.output='';$s.etlCreated=$true}
                }
                return @{code=0;payload=@('\DATA\SharedData\PhoneTools\PwTools\log\wpr_output.txt')}
            };
            receive={param($c,$remote,$local)
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($local))
                if($remote.EndsWith('.txt',[StringComparison]::OrdinalIgnoreCase)) {[IO.File]::WriteAllText($local,$c.testState.output,(New-Object Text.UTF8Encoding($false)))}
                else {
                    if(-not $c.testState.etlCreated){throw 'Fake ETL not created'}
                    if($c.testState.badEtl){[IO.File]::WriteAllBytes($local,(New-Object byte[] 2))}
                    else{$data=New-Object byte[] 4096;[Array]::Copy([BitConverter]::GetBytes([uint32]4096),$data,4);[IO.File]::WriteAllBytes($local,$data)}
                }
            };
            close={param($c)$c.testState.closed=$true}
        }
    }
    $controller=New-Wp81GuestWprController -PhoneSession $session -AssertBinding {param($s)if(-not $s.coreCon){throw 'Binding missing'}} -ArtifactRoot (Join-Path $root $Name) -TransportFactory $factory
    $controller.testState=@{operations=(New-Object 'Collections.Generic.List[object]');activeProfiles=@();output='';failStart=$false;badEtl=$false;etlCreated=$false;closed=$false}
    return $controller
}
function Start-Fixture($Controller){
    $status=Get-Wp81GuestWprStatus $Controller
    return Start-Wp81GuestWprCapture $Controller @{exclusiveGuest=$true;allowUnknownStatus=$true;observedStatusFingerprint=$status.status.fingerprint;profiles=@('cpu');metadata=@{operationId='test-span';scenario='owned-fixture'}}
}

$c=New-Fixture 'happy';$s=Get-Wp81GuestWprStatus $c
Assert-Test ($s.status.state -eq 'unknown') 'Unknown native status was mislabeled idle'
$capture=Start-Wp81GuestWprCapture $c @{exclusiveGuest=$true;allowUnknownStatus=$true;observedStatusFingerprint=$s.status.fingerprint;profiles=@('cpu');metadata=@{operationId='test-span'}}
Assert-Test ($capture.state -eq 'recording' -and $capture.profileIds[0] -eq 'CPU.Verbose.Memory') 'Wrong SDK profile identifier'
$done=Stop-Wp81GuestWprCapture $c @{captureId=$capture.captureId;exclusiveGuest=$true}
Assert-Test ($done.state -eq 'stopped-artifact-verified' -and $done.trace.bytes -eq 4096 -and $done.trace.sha256.Length -eq 64) 'No verified trace receipt'
Assert-Test (-not $done.trace.eventContentValidated -and $done.traceAnalysis.state -eq 'not-analyzed') 'Fake header validation claimed actual trace analysis'
Assert-Test ($done.lastStatus.state -eq 'unknown') 'Post-stop unknown was mislabeled idle'
Assert-Test (Test-Path -LiteralPath $done.receiptPath) 'No durable history receipt'
$receipt=Get-Content -LiteralPath $done.receiptPath -Raw|ConvertFrom-Json
Assert-Test (@($receipt.events|Where-Object kind -eq 'guestWprRecording').Count -eq 1 -and @($receipt.events|Where-Object kind -eq 'guestWprStopped').Count -eq 1) 'Missing lifecycle history'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='separate lifecycle and durable artifact receipt';passed=$true})

$c=New-Fixture 'foreign';$c.testState.activeProfiles=@('Other.Verbose.Memory');$s=Get-Wp81GuestWprStatus $c
Expect-Code {Start-Wp81GuestWprCapture $c @{exclusiveGuest=$true;allowUnknownStatus=$true;observedStatusFingerprint=$s.status.fingerprint;profiles=@('cpu')}} 'GUEST_WPR_FOREIGN_RECORDING'
Assert-Test (@($c.testState.operations|Where-Object operation -ne 'status').Count -eq 0) 'Foreign recording was mutated'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='foreign recording refuses every mutation';passed=$true})

$c=New-Fixture 'unknown-status';$s=Get-Wp81GuestWprStatus $c
Expect-Code {Start-Wp81GuestWprCapture $c @{exclusiveGuest=$true;observedStatusFingerprint=$s.status.fingerprint;profiles=@('cpu')}} 'GUEST_WPR_STATUS_UNKNOWN'
Assert-Test (@($c.testState.operations|Where-Object operation -eq 'start').Count -eq 0) 'Unknown status started without explicit acknowledgement'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='unknown status needs explicit acknowledgement';passed=$true})

$c=New-Fixture 'fingerprint'
Expect-Code {Start-Wp81GuestWprCapture $c @{exclusiveGuest=$true;allowUnknownStatus=$true;observedStatusFingerprint=('0'*64);profiles=@('cpu')}} 'GUEST_WPR_STATUS_CHANGED'
Assert-Test (@($c.testState.operations|Where-Object operation -eq 'start').Count -eq 0) 'Changed status was ignored'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='stale status observation refuses start';passed=$true})

$c=New-Fixture 'native-failure';$c.testState.failStart=$true
Expect-Code {Start-Fixture $c} 'GUEST_WPR_START_UNCONFIRMED' $true
Assert-Test (@($c.testState.operations|Where-Object operation -eq 'stop').Count -eq 0) 'Transport Code0 masked failing native HRESULT'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='native failure despite transport Code0 never auto-stops';passed=$true})

$c=New-Fixture 'profile-changed';$capture=Start-Fixture $c;$c.testState.activeProfiles=@('CPU.Verbose.Memory','Other.Verbose.Memory')
Expect-Code {Stop-Wp81GuestWprCapture $c @{captureId=$capture.captureId;exclusiveGuest=$true}} 'GUEST_WPR_RECORDING_CHANGED'
Assert-Test (@($c.testState.operations|Where-Object operation -eq 'stop').Count -eq 0) 'Changed active profile set was stopped'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='profile changes refuse stop';passed=$true})

$c=New-Fixture 'unowned-stop';$capture=Start-Fixture $c
Expect-Code {Stop-Wp81GuestWprCapture $c @{captureId=[guid]::NewGuid().ToString('D');exclusiveGuest=$true}} 'GUEST_WPR_CAPTURE_NOT_OWNED'
Assert-Test (@($c.testState.operations|Where-Object operation -eq 'stop').Count -eq 0) 'Unowned capture was stopped'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='unowned capture ID refuses stop';passed=$true})

$c=New-Fixture 'bad-etl';$capture=Start-Fixture $c;$c.testState.badEtl=$true
Expect-Code {Stop-Wp81GuestWprCapture $c @{captureId=$capture.captureId;exclusiveGuest=$true}} 'GUEST_WPR_STOP_UNCONFIRMED' $true
Assert-Test ($c.captures[$capture.captureId].state -eq 'stop-unconfirmed') 'Invalid ETL was accepted'
$c.testState.activeProfiles=@('CPU.Verbose.Memory')
Expect-Code {Stop-Wp81GuestWprCapture $c @{captureId=$capture.captureId;exclusiveGuest=$true}} 'GUEST_WPR_STOP_ALREADY_DISPATCHED' $true
Assert-Test (@($c.testState.operations|Where-Object operation -eq 'stop').Count -eq 1) 'Unconfirmed Stop was replayed'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='invalid downloaded ETL remains unconfirmed';passed=$true})

$c=New-Fixture 'close-recording';$capture=Start-Fixture $c;$closed=Close-Wp81GuestWprController $c
Assert-Test ($closed.warnings.Count -eq 1 -and $closed.recordingCancelled -eq $false -and $closed.coreConDisconnected -eq $false) 'Close hid a live recording'
Assert-Test ($c.testState.activeProfiles.Count -eq 1 -and @($c.testState.operations|Where-Object operation -eq 'stop').Count -eq 0) 'Close stopped a recording'
$tests.Add(@{name='EOF-style close preserves recording and receipt';passed=$true})

$c=New-Fixture 'typed-profile'
Expect-Code {Start-Wp81GuestWprCapture $c @{exclusiveGuest=$true;allowUnknownStatus=$true;observedStatusFingerprint=('0'*64);profiles=@('cpu -cancel')}} 'GUEST_WPR_PROFILE_UNSUPPORTED'
Assert-Test ($c.testState.operations.Count -eq 0) 'Caller command text reached the SDK'
$null=Close-Wp81GuestWprController $c;$tests.Add(@{name='typed profiles reject caller command text';passed=$true})

[pscustomobject]@{passed=$tests.Count;tests=@($tests.ToArray());artifactRoot=$root;liveGuestUsed=$false}|ConvertTo-Json -Compress -Depth 8

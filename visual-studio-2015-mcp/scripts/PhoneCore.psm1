# Shared XDE/CoreCon functions. Importing does not connect to devices or read stdin.
$script:CleanupWarnings=New-Object 'System.Collections.Generic.List[string]'
$script:PhoneRequest=$null
$script:LoadedXdeDirectory=$null
function Initialize-PhoneCore($Request) {
    $script:PhoneRequest=$Request
    $script:CleanupWarnings=New-Object 'System.Collections.Generic.List[string]'
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
}
function Get-PhoneCleanupWarnings { return @($script:CleanupWarnings.ToArray()) }
function Reset-PhoneCleanupWarnings { $script:CleanupWarnings.Clear() }
function Get-ProcessStartTimeUtc([int]$ProcessId) { $process=[Diagnostics.Process]::GetProcessById($ProcessId);try{return $process.StartTime.ToUniversalTime().ToString('o')}finally{$process.Dispose()} }
function Get-PhoneFileSha256([string]$Path) {
    $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','')}finally{$sha.Dispose();$stream.Dispose()}
}
function Get-XdeVmIdentity($Process) {
    $machines=@(Get-CimInstance -Namespace 'root/virtualization/v2' -ClassName Msvm_ComputerSystem -ErrorAction Stop |
        Where-Object {[string]::Equals([string]$_.ElementName,[string]$Process.vmName,[StringComparison]::Ordinal)})
    $vmId=[guid]::Empty
    if($machines.Count -ne 1 -or -not [guid]::TryParse([string]$machines[0].Name,[ref]$vmId)){
        $exception=New-Object InvalidOperationException('The XDE VM name did not resolve to exactly one Hyper-V VM GUID.');$exception.Data['code']='PHONE_VM_IDENTITY_UNAVAILABLE';throw $exception
    }
    return $vmId.ToString('D')
}
function Enter-XdeLease($Process) {
    # Two controllers for the same VM must not acquire independent input leases.
    $vmId=Get-XdeVmIdentity $Process
    $mutex=New-Object Threading.Mutex($false,('Local\VS2015Mcp_XDEVM_'+$vmId))
    $held=$false
    try {try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){$exception=New-Object InvalidOperationException('Another automation session owns this emulator.');$exception.Data['code']='PHONE_SESSION_BUSY';throw $exception};return $mutex}
    catch {$mutex.Dispose();throw}
}
function Exit-XdeLease($Mutex) { try {$Mutex.ReleaseMutex()} finally {$Mutex.Dispose()} }
function Get-Value($Object, [string]$Name, $Default = $null) {
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}
function Require-Value($Object, [string]$Name) {
    $value = Get-Value $Object $Name
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { throw "Missing parameter: $Name" }
    return $value
}
function Get-PhoneSystemPath([Environment+SpecialFolder]$Folder) {
    $path=[Environment]::GetFolderPath($Folder)
    if([string]::IsNullOrWhiteSpace($path)){
        $exception=New-Object InvalidOperationException(('Windows did not expose the known folder: '+$Folder));$exception.Data['code']='PHONE_OS_PATH_UNAVAILABLE';throw $exception
    }
    return [IO.Path]::GetFullPath($path)
}
function Get-XdeInstallations {
    $roots = @((Join-Path (Get-PhoneSystemPath ([Environment+SpecialFolder]::ProgramFilesX86)) 'Microsoft XDE')) + @(Get-Value $script:PhoneRequest 'xdeRoots' @()); foreach ($root in $roots | Select-Object -Unique) {
    if (!(Test-Path -LiteralPath $root)) { continue }
    foreach ($dir in Get-ChildItem -LiteralPath $root -Directory) {
        $exe = Join-Path $dir.FullName 'XDE.exe'
        if (Test-Path -LiteralPath $exe) {
            [pscustomobject]@{ directory=$dir.FullName; executable=$exe; version=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileVersion; automation=(Test-Path -LiteralPath (Join-Path $dir.FullName 'Microsoft.Xde.Interface.dll')) }
        }
    }
}
}
function Get-PhoneTools {
    $paths = @(
        (Join-Path (Get-PhoneSystemPath ([Environment+SpecialFolder]::ProgramFilesX86)) 'Microsoft SDKs\Windows Phone\v8.1\Tools\AppDeploy\AppDeployCmd.exe'),
        (Join-Path (Get-PhoneSystemPath ([Environment+SpecialFolder]::ProgramFilesX86)) 'Microsoft SDKs\Windows Phone\v8.0\Tools\XAP Deployment\XapDeployCmd.exe')
    )
    $kitBin = Join-Path (Get-PhoneSystemPath ([Environment+SpecialFolder]::ProgramFilesX86)) 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitBin) {
        $paths += Join-Path $kitBin 'x86\WinAppDeployCmd.exe'
        foreach ($dir in Get-ChildItem -LiteralPath $kitBin -Directory) { $paths += Join-Path $dir.FullName 'x86\WinAppDeployCmd.exe' }
    }
    foreach ($path in $paths | Select-Object -Unique) {
        if (Test-Path -LiteralPath $path) { [pscustomobject]@{name=[IO.Path]::GetFileName($path);path=$path;version=[Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion} }
    }
}
function Get-XdeProcesses {
    if (-not ('PhoneCommandLine' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PhoneCommandLine {
 [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string s, out int n);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static string[] Split(string s) {int n; IntPtr p=CommandLineToArgvW(s,out n); if(p==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(); try {var a=new string[n]; for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;} finally {LocalFree(p);}}
}
"@
    }
    $installed = @(Get-XdeInstallations | ForEach-Object {$_.executable})
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name = 'XDE.exe'") {
        if (!$p.ExecutablePath -or $installed -notcontains $p.ExecutablePath) { continue }
        $argv = [PhoneCommandLine]::Split($p.CommandLine)
        $parameters = @{}
        for ($i=1; $i -lt $argv.Length; $i++) {
            if ($argv[$i].StartsWith('/') -and $i+1 -lt $argv.Length -and !$argv[$i+1].StartsWith('/')) { $parameterName=$argv[$i].Substring(1); $parameters[$parameterName] = $argv[$i+1]; $i++ }
        }
        if (!$parameters.ContainsKey('name')) { continue }
        [pscustomobject]@{startTimeUtc=(Get-ProcessStartTimeUtc ([int]$p.ProcessId));processId=[int]$p.ProcessId;vmName=$parameters['name'];displayName=$parameters['displayName'];executable=$p.ExecutablePath;directory=[IO.Path]::GetDirectoryName($p.ExecutablePath);video=$parameters['video'];vhd=$parameters['vhd']}
    }
}
function Get-CoreConDevices([int]$LocaleId) {
    $gac = Join-Path (Get-PhoneSystemPath ([Environment+SpecialFolder]::Windows)) 'Microsoft.NET\assembly\GAC_MSIL\Microsoft.SmartDevice.Connectivity'
    $assembly = Get-ChildItem -LiteralPath $gac -Directory | Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'Microsoft.Smartdevice.Connectivity.dll'} | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
    if (!$assembly) { throw 'CoreCon Microsoft.SmartDevice.Connectivity is not installed.' }
    [void][Reflection.Assembly]::LoadFrom($assembly)
    $manager = New-Object Microsoft.SmartDevice.Connectivity.DatastoreManager($LocaleId)
    foreach ($platform in $manager.GetPlatforms()) {
        foreach ($device in $platform.GetDevices()) {
            [pscustomobject]@{deviceId=$device.Id.ToString();name=$device.Name;platformId=$platform.Id.ToString();platform=$platform.Name;emulator=$device.IsEmulator();device=$device}
        }
    }
}
function Get-SelectedProcess($Request) {
    $pidValue = [int](Require-Value $Request 'processId')
    $matches = @(Get-XdeProcesses | Where-Object {$_.processId -eq $pidValue})
    if ($matches.Count -ne 1) { throw "No installed XDE process with id $pidValue. Refresh the running emulator list." }
    return $matches[0]
}
function Get-Client($Process) {
    $directory=[IO.Path]::GetFullPath([string]$Process.directory)
    $path=Join-Path $directory 'Microsoft.Xde.Interface.dll'
    if($script:LoadedXdeDirectory -and -not [string]::Equals($script:LoadedXdeDirectory,$directory,[StringComparison]::OrdinalIgnoreCase)){
        $exception=New-Object InvalidOperationException('Use a new bridge process for a different XDE SDK.');$exception.Data['code']='PHONE_SDK_MISMATCH';throw $exception
    }
    $expectedName=[Reflection.AssemblyName]::GetAssemblyName($path).FullName
    $expectedHash=Get-PhoneFileSha256 $path
    $loaded=@([AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'Microsoft.Xde.Interface' })
    foreach($assembly in $loaded){
        if($assembly.FullName -ne $expectedName -or (Get-PhoneFileSha256 $assembly.Location) -ne $expectedHash){
            $exception=New-Object InvalidOperationException('The already-loaded XDE SDK does not match the selected installed SDK.');$exception.Data['code']='PHONE_SDK_MISMATCH';throw $exception
        }
    }
    $assembly=[Reflection.Assembly]::LoadFrom($path)
    # The CLR can legitimately resolve the exact same signed assembly from GAC.
    # Compare identity and bytes, then pin the selected installation directory.
    if($assembly.FullName -ne $expectedName -or (Get-PhoneFileSha256 $assembly.Location) -ne $expectedHash){throw 'The resolved XDE assembly differs from the selected SDK.'}
    $script:LoadedXdeDirectory=$directory
    return [Microsoft.Xde.Interface.AutomationClient]::CreateAutomationClient($Process.vmName)
}
function Get-InputClient($Client, $Process) {
    if ($Client.GetType().GetMethod('SendKeyboardKeys')) { return [pscustomobject]@{input=$Client;feature=$null;legacy=$true} }
    $assembly=$Client.GetType().Assembly
    $contract=[Microsoft.Xde.Common.IXdeAutomationInput]
    $generic=$assembly.GetType('Microsoft.Xde.Interface.XdeFeatureAutomationClient`1').MakeGenericType(@($contract))
    $method=$generic.GetMethod('ConnectToFeature',[type[]]@([string]))
    $feature=$method.Invoke($null,@($Process.vmName))
    return [pscustomobject]@{input=$feature.FeatureProxy;feature=$feature;legacy=$false}
}
function Get-State($Client,$Process) {
    $bounds=$Client.DisplayWindowBounds
    $resolution=Get-Resolution $Process $Client
    [pscustomobject]@{processId=$Process.processId;vmName=$Process.vmName;state=$Client.VmState.ToString();shellReady=$Client.IsShellReady;toolsReady=$Client.IsToolsPipeReady();display=@{width=$resolution.width;height=$resolution.height;coordinateSpace='guest-pixels'};hostDisplayBounds=@{x=$bounds.X;y=$bounds.Y;width=$bounds.Width;height=$bounds.Height};zoomPercent=$Client.ScreenZoomPercent;orientation=$Client.DisplayOrientation.ToString();buttons=@($Client.GetSkinButtonInfos() | ForEach-Object {$_.ButtonType.ToString()})}
}
function Get-Resolution($Process,$Client) {
    # Mouse input is in guest pixel coordinates, independent of the host window position or zoom.
    if ($Process.video -match '^(\d+)x(\d+)$') {
        $width=[int]$Matches[1]; $height=[int]$Matches[2]
        if ($Client.DisplayOrientation.ToString() -match 'Landscape') { $swap=$width;$width=$height;$height=$swap }
    }
    else { $b=$Client.DisplayWindowBounds; $z=$Client.ScreenZoomPercent; if($z -le 0){throw 'XDE reported an invalid screen zoom.'}; $width=[int]($b.Width*100/$z); $height=[int]($b.Height*100/$z) }
    return @{width=$width;height=$height}
}
function Send-Point($InputObject,[int]$X,[int]$Y,[bool]$Down) {
    $button=if($Down){[Windows.Forms.MouseButtons]::Left}else{[Windows.Forms.MouseButtons]::None}
    if ($InputObject.legacy) { $mouse=New-Object Windows.Forms.MouseEventArgs($button,1,$X,$Y,0) }
    else { $mouse=New-Object Microsoft.Xde.Common.MouseArgsInfo; $mouse.Location=New-Object Drawing.Point($X,$Y); $mouse.Button=$button }
    $InputObject.input.SendMouseEvent($mouse)
}
function Invoke-PhoneRequest($Request) {
    $action=[string](Require-Value $Request 'action')
    if ($action -eq 'discover') { return @{bridge=@{architecture='x86';runtime=$PSVersionTable.PSVersion.ToString()};xde=@(Get-XdeInstallations);tools=@(Get-PhoneTools);running=@(Get-XdeProcesses)} }
    if ($action -eq 'running') { return @{emulators=@(Get-XdeProcesses)} }
    if ($action -in @('devices','start','applications','appLaunch','appStop','appUninstall')) {
        $locale=[int](Get-Value $Request 'localeId' ([Globalization.CultureInfo]::CurrentUICulture.LCID))
        $devices=@(Get-CoreConDevices $locale)
        if ($action -eq 'devices') { return @{devices=@($devices | Select-Object deviceId,name,platformId,platform,emulator);localeId=$locale} }
        $id=[guid](Require-Value $Request 'deviceId')
        $selected=@($devices | Where-Object {[guid]$_.deviceId -eq $id})
        if ($selected.Count -ne 1) { throw 'Unknown or ambiguous CoreCon device id.' }
        $device=$selected[0].device
        if ($action -eq 'start' -and !$selected[0].emulator) { throw 'The start action requires an emulator device id.' }
        try {
            $device.Connect()
            if ($action -eq 'start') { return @{connected=$device.IsConnected();deviceId=$id.ToString();running=@(Get-XdeProcesses)} }
            if ($action -eq 'applications') { return @{applications=@($device.GetInstalledApplications() | ForEach-Object {@{productId=$_.ProductID.ToString();title=$_.Title;instanceId=$_.InstanceID.ToString();running=$_.IsRunning()}})} }
            $product=[guid](Require-Value $Request 'productId');$app=$device.GetApplication($product)
            switch($action){ 'appLaunch' {$app.Launch()} 'appStop' {$app.TerminateRunningInstances()} 'appUninstall' {$app.Uninstall()} }
            return @{action=$action;productId=$product.ToString();deviceId=$id.ToString()}
        } finally { try {$device.Disconnect()} catch {$script:CleanupWarnings.Add($_.Exception.Message)} }
    }
    $allowed=@('status','endpoint','capture','tap','swipe','key','text','button','stop')
    if ($action -notin $allowed) { throw "Unknown action: $action" }
    $process=Get-SelectedProcess $Request
    $client=$null;$inputObject=$null;$lease=$null
    try {
        if ($action -in @('tap','swipe','key','text','button','stop')) { $lease=Enter-XdeLease $process }
        $client=Get-Client $process
        if ($action -in @('tap','swipe','key','text','button')) {
            if (!$client.IsShellReady) { throw 'The emulator shell is not ready for input.' }
            $inputObject=Get-InputClient $client $process
        }
        return Invoke-XdeOperation $Request $process $client $inputObject
    } finally {
        if ($inputObject -and $inputObject.feature) {try {$inputObject.feature.Dispose()} catch {$script:CleanupWarnings.Add($_.Exception.Message)}}
        if ($client) {try {$client.Dispose()} catch {$script:CleanupWarnings.Add($_.Exception.Message)}}
        if ($lease) {Exit-XdeLease $lease}
    }
}

function Invoke-XdeOperation($Request,$Process,$Client,$InputObject) {
    $action=[string](Require-Value $Request 'action')
        if ($action -eq 'status') { return Get-State $client $process }
        if ($action -eq 'endpoint') {
            $hostAddress='';$guestAddress=''
            $client.GetEndPoint([ref]$hostAddress,[ref]$guestAddress)
            return @{processId=$process.processId;vmName=$process.vmName;hostAddress=$hostAddress;guestAddress=$guestAddress}
        }
        if ($action -eq 'stop') { $client.Close(); return @{closeRequested=$true;processId=$process.processId;vmName=$process.vmName} }
        if ($action -eq 'capture') {
            $path=[string](Require-Value $Request 'path')
            if ($path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])' -or [IO.Path]::GetExtension($path) -ne '.png') { throw 'Capture path must be a fully qualified drive or UNC .png path.' }
            $path=[IO.Path]::GetFullPath($path)
            $directory=[IO.Path]::GetDirectoryName($path)
            [void][IO.Directory]::CreateDirectory($directory)
            $temporary=Join-Path $directory ('.vs2015-capture-'+[guid]::NewGuid().ToString('N')+'.png')
            $backup=Join-Path $directory ('.vs2015-capture-backup-'+[guid]::NewGuid().ToString('N')+'.png')
            try {
                $client.CaptureImage($temporary)
                if (![IO.File]::Exists($temporary)) { throw 'XDE did not produce a screenshot. Check shell readiness and emulator state.' }
                $image=[Drawing.Image]::FromFile($temporary)
                try { $width=$image.Width; $height=$image.Height } finally {$image.Dispose()}
                $bytes=(Get-Item -LiteralPath $temporary).Length
                if ([IO.File]::Exists($path)) {[IO.File]::Replace($temporary,$path,$backup)} else {[IO.File]::Move($temporary,$path)}
                return @{path=$path;width=$width;height=$height;bytes=$bytes;processId=$process.processId}
            } finally {
                try {if ([IO.File]::Exists($temporary)) {[IO.File]::Delete($temporary)}} catch {$script:CleanupWarnings.Add($_.Exception.Message)}
                try {if ([IO.File]::Exists($backup)) {[IO.File]::Delete($backup)}} catch {$script:CleanupWarnings.Add($_.Exception.Message)}
            }
        }
        if (!$client.IsShellReady -and -not ($action -eq 'key' -and (Get-Value $Request 'mode' 'Type') -eq 'Release')) { throw 'The emulator shell is not ready for input.' }
        if ($null -eq $inputObject) { throw 'An input client is required for this action.' }
        switch ($action) {
            'button' {
                $button=[Enum]::Parse([Microsoft.Xde.Common.SkinButtonType],[string](Require-Value $Request 'button'),$true)
                if (@($client.GetSkinButtonInfos() | Where-Object {$_.ButtonType -eq $button}).Count -eq 0) {throw 'This emulator skin does not expose that button.'}
                $inputObject.input.PressSkinButton($button)
            }
            'key' {
                $keyNames=@(Require-Value $Request 'keys')
                $validNames=[Enum]::GetNames([Windows.Forms.Keys])
                $keys=[Windows.Forms.Keys[]]@($keyNames | ForEach-Object {
                    if($validNames -notcontains [string]$_){throw 'keys must contain named virtual keys, not numeric values or combined modifier flags.'}
                    $parsed=[Enum]::Parse([Windows.Forms.Keys],[string]$_,$true)
                    if([int]$parsed -lt 1 -or [int]$parsed -gt 255){throw 'Only virtual-key values 1..255 are accepted. Use ControlKey, ShiftKey, or Menu for modifiers.'}
                    $parsed
                })
                $modeName=[string](Get-Value $Request 'mode' 'Type')
                if($modeName -notin @('Type','Press','Release')){throw 'mode must be Type, Press, or Release.'}
                $mode=[Enum]::Parse([Microsoft.Xde.Common.KeyboardKeyOption],$modeName,$true)
                $inputObject.input.SendKeyboardKeys($keys,$mode)
            }
            'text' {
                $text=[string](Require-Value $Request 'text')
                if ($inputObject.legacy) {$client.InputPipe.SendText($text)} else {$inputObject.input.SendText($text)}
            }
            {$_ -in @('tap','swipe')} {
                $x=[int](Require-Value $Request 'x');$y=[int](Require-Value $Request 'y')
                $toX=$x;$toY=$y
                if($action -eq 'swipe'){$toX=[int](Require-Value $Request 'toX');$toY=[int](Require-Value $Request 'toY')}
                $size=Get-Resolution $process $client
                foreach($point in @(@($x,$y),@($toX,$toY))){if($point[0] -lt 0 -or $point[0] -ge $size.width -or $point[1] -lt 0 -or $point[1] -ge $size.height){throw 'Coordinates must be inside the guest display.'}}
                $duration=[int](Get-Value $Request 'durationMs' $(if($action -eq 'tap'){80}else{400}))
                if($duration -lt 1 -or $duration -gt 10000){throw 'durationMs must be 1..10000.'}
                $steps=if($action -eq 'tap'){1}else{[Math]::Max(2,[Math]::Min(100,[Math]::Ceiling($duration/25)))}
                try {
                    Send-Point $inputObject $x $y $true
                    for($i=1;$i -le $steps;$i++){Start-Sleep -Milliseconds ([int]($duration/$steps));if($action -eq 'swipe'){Send-Point $inputObject ([int]($x+($toX-$x)*$i/$steps)) ([int]($y+($toY-$y)*$i/$steps)) $true}}
                } finally {Send-Point $inputObject $toX $toY $false}
            }
        }
        return @{action=$action;processId=$process.processId;vmName=$process.vmName;issued=$true;verification='Capture the screen to verify guest state; XDE may swallow input errors.'}
}

Export-ModuleMember -Function *

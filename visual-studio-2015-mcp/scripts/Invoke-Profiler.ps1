#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:RequestJson=[Console]::In.ReadToEnd()
Import-Module (Join-Path $PSScriptRoot 'NativeProcess.psm1')
Import-Module (Join-Path $PSScriptRoot 'WindowsPaths.psm1')
Import-Module (Join-Path $PSScriptRoot 'TraceEventSummary.psm1')

function Fail([string]$Code, [string]$Message) {
    $exception = [InvalidOperationException]::new($Message)
    $exception.Data['code'] = $Code
    throw $exception
}
function Read-Int($Object, [string]$Name, [long]$Default, [long]$Min, [long]$Max) {
    $value = Get-Value $Object $Name $Default
    if ($value -isnot [int] -and $value -isnot [long]) { Fail 'INVALID_REQUEST' "$Name must be an integer." }
    if ($value -lt $Min -or $value -gt $Max) { Fail 'INVALID_REQUEST' "$Name is outside its supported range." }
    return [long]$value
}
function Read-Text($Object, [string]$Name, $Default = $null) {
    $value = Get-Value $Object $Name $Default
    if ($null -ne $value -and ($value -isnot [string] -or $value.Contains([char]0))) { Fail 'INVALID_REQUEST' "$Name must be text without NUL." }
    return $value
}
function Read-Bool($Object, [string]$Name, [bool]$Default) {
    $value = Get-Value $Object $Name $Default
    if ($value -isnot [bool]) { Fail 'INVALID_REQUEST' "$Name must be boolean." }
    return $value
}
function Read-Registry([string]$Path, [string]$Name) {
    try { Get-ItemPropertyValue -LiteralPath $Path -Name $Name -ErrorAction Stop } catch { $null }
}
function Resolve-FullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { Fail 'INVALID_REQUEST' 'A nonempty path is required.' }
    return [IO.Path]::GetFullPath($Path)
}
function Get-InstallRoots($Request) {
    $roots = [Collections.Generic.List[string]]::new()
    $explicit = Read-Text $Request 'vsRoot' $env:VS2015_MCP_ROOT
    if ($explicit) { $roots.Add((Resolve-FullPath $explicit)) }
    else {
        foreach ($hive in @('HKLM:/SOFTWARE/WOW6432Node/Microsoft', 'HKLM:/SOFTWARE/Microsoft', 'HKCU:/SOFTWARE/Microsoft')) {
            foreach ($p in @((Read-Registry "$hive/VisualStudio/14.0/Setup/VS" 'ProductDir'), (Read-Registry "$hive/VisualStudio/SxS/VS7" '14.0'))) { if ($p) { $roots.Add((Resolve-FullPath $p)) } }
        }
        if ($env:VS140COMNTOOLS) { $roots.Add((Resolve-FullPath (Join-Path $env:VS140COMNTOOLS '../..'))) }
        foreach ($p in @(Get-WindowsProgramDirectoryPaths)) { $roots.Add((Join-Path $p 'Microsoft Visual Studio 14.0')) }
    }
    $perfRoots = [Collections.Generic.List[string]]::new()
    $standalone = Read-Text $Request 'performanceRoot'
    if ($standalone) { $perfRoots.Add((Resolve-FullPath $standalone)) }
    foreach ($p in @($roots | Select-Object -Unique)) { $perfRoots.Add((Join-Path $p 'Team Tools/Performance Tools')) }
    return @($perfRoots | Select-Object -Unique)
}
$script:ToolFiles = @{ vsperf='VSPerf.exe'; vsperfcmd='VSPerfCmd.exe'; vsperfreport='VSPerfReport.exe'; vsinstr='VSInstr.exe'; perfview='PerfView.exe' }
function Get-Tools($Request) {
    $tools = [Collections.Generic.List[object]]::new()
    foreach ($root in @(Get-InstallRoots $Request)) {
        foreach ($architecture in @('x86', 'x64')) {
            $dir = if ($architecture -eq 'x64') { Join-Path $root 'x64' } else { $root }
            foreach ($name in @('vsperf','vsperfcmd','vsperfreport','vsinstr')) {
                $p = Join-Path $dir $script:ToolFiles[$name]
                if (Test-Path -LiteralPath $p -PathType Leaf) {
                    $v = [Diagnostics.FileVersionInfo]::GetVersionInfo($p)
                    if ($v.FileMajorPart -eq 14) { $tools.Add([ordered]@{ tool=$name; path=$p; version=$v.FileVersion; architecture=$architecture; source='vs2015-performance-root' }) }
                }
            }
        }
    }
    $perfViewPath = Read-Text $Request 'perfViewPath' $env:VS2015_MCP_PERFVIEW
    if (-not $perfViewPath) { $command = Get-Command 'PerfView.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($command) { $perfViewPath = $command.Source } }
    if ($perfViewPath) {
        $p = Resolve-FullPath $perfViewPath
        if (-not (Test-Path -LiteralPath $p -PathType Leaf) -or [IO.Path]::GetFileName($p) -ine 'PerfView.exe') { Fail 'TOOL_NOT_FOUND' 'perfViewPath must point to PerfView.exe.' }
        $tools.Add([ordered]@{ tool='perfview'; path=$p; version=([Diagnostics.FileVersionInfo]::GetVersionInfo($p)).FileVersion; architecture='tool-defined'; source='explicit-or-path' })
    }
    return @($tools)
}
function Resolve-Tool($Request, [string]$Name) {
    if (-not $script:ToolFiles.ContainsKey($Name)) { Fail 'INVALID_REQUEST' 'Unknown profiler tool.' }
    $explicit = Read-Text $Request 'toolPath'
    if ($explicit) {
        $p = Resolve-FullPath $explicit
        if ([IO.Path]::GetFileName($p) -ine $script:ToolFiles[$Name] -or -not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail 'TOOL_NOT_FOUND' 'toolPath must name the selected profiler executable.' }
        $v = [Diagnostics.FileVersionInfo]::GetVersionInfo($p)
        if ($Name -ne 'perfview' -and $v.FileMajorPart -ne 14) { Fail 'TOOL_VERSION_MISMATCH' 'The selected VS profiler tool is not version 14.' }
        return [ordered]@{ tool=$Name; path=$p; version=$v.FileVersion; source='explicit' }
    }
    $architecture = Read-Text $Request 'architecture' 'x86'
    if ($architecture -notin @('x86','x64')) { Fail 'INVALID_REQUEST' 'architecture must be x86 or x64.' }
    $matches = @(Get-Tools $Request | Where-Object { $_.tool -eq $Name })
    if ($Name -in @('vsperfcmd','vsinstr')) { $matches = @($matches | Where-Object { $_.architecture -eq $architecture }) }
    if (-not $matches.Count) { Fail 'TOOL_NOT_FOUND' "The selected profiler tool ($Name) was not found. Supply toolPath or a supported installation root." }
    return $matches[0]
}
function New-Plan($Tool, [string[]]$Arguments, [int]$TimeoutMs) {
    return [ordered]@{ executable=$Tool.path; arguments=@($Arguments); workingDirectory=$script:Directory; timeoutMs=$TimeoutMs }
}
function Invoke-Plan($Plan) {
    $enc = $script:Encoding
    if ($Plan.arguments.Count -gt 0 -and $Plan.arguments[0] -ieq '/U') { $enc = [Text.Encoding]::Unicode }
    return Invoke-CapturedProcess -Executable $Plan.executable -Arguments $Plan.arguments -Directory $Plan.workingDirectory -TimeoutMs $Plan.timeoutMs -Limit $script:Limit -Encoding $enc
}
function Assert-Success($Result, [string]$Step) {
    if ($Result.timedOut -or $Result.exitCode -ne 0) { Fail 'PROFILER_COMMAND_FAILED' "$Step failed (exit $($Result.exitCode), timeout $($Result.timedOut)). See steps for raw output." }
}
function Test-StopRequested { return $script:StopFile -and (Test-Path -LiteralPath $script:StopFile -PathType Leaf) }
function Get-Target([int]$ProcessId) {
    $p = [Diagnostics.Process]::GetProcessById($ProcessId)
    try { return [ordered]@{ processId=$p.Id; name=$p.ProcessName; startTimeUtc=$p.StartTime.ToUniversalTime().ToString('O'); startTimeTicks=$p.StartTime.ToUniversalTime().Ticks } }
    finally { $p.Dispose() }
}
function Test-SameTarget($Target) {
    try { $current = Get-Target $Target.processId; return $current.startTimeTicks -eq $Target.startTimeTicks } catch { return $false }
}
function Initialize-EtwQuery {
    if ('Vs2015ProfilerEtw' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class Vs2015TraceInfo { public string Name; public string File; public ulong Id; public Guid Guid; }
public static class Vs2015ProfilerEtw {
 [StructLayout(LayoutKind.Sequential)] struct Wnode { public uint BufferSize, ProviderId; public ulong HistoricalContext, TimeStamp; public Guid Guid; public uint ClientContext, Flags; }
 [StructLayout(LayoutKind.Sequential)] struct Props { public Wnode Wnode; public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize, LogFileMode, FlushTimer, EnableFlags; public int AgeLimit; public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost; public IntPtr LoggerThreadId; public uint LogFileNameOffset, LoggerNameOffset; }
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint QueryAllTracesW([In,Out] IntPtr[] properties, uint count, out uint found);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint ControlTraceW(ulong handle, string name, IntPtr properties, uint controlCode);
 public static uint Stop(ulong id, Guid guid) {
  if(id==0) return 87;
  int header=Marshal.SizeOf<Props>(), size=header+131072;
  IntPtr memory=Marshal.AllocHGlobal(size);
  try { Marshal.Copy(new byte[size],0,memory,size); var p=new Props(); p.Wnode.BufferSize=(uint)size; p.Wnode.Guid=guid; p.Wnode.Flags=0x00020000; p.LoggerNameOffset=(uint)header; p.LogFileNameOffset=(uint)(header+65536); Marshal.StructureToPtr(p,memory,false); return ControlTraceW(id,null,memory,1); }
  finally { Marshal.FreeHGlobal(memory); }
 }
 public static Vs2015TraceInfo[] Query() {
  const int count=256, chars=32768;
  int header=Marshal.SizeOf<Props>(), size=header+4*chars;
  var pointers=new IntPtr[count];
  try {
   for(int i=0;i<count;i++) { pointers[i]=Marshal.AllocHGlobal(size); var p=new Props(); p.Wnode.BufferSize=(uint)size; p.LoggerNameOffset=(uint)header; p.LogFileNameOffset=(uint)(header+2*chars); Marshal.StructureToPtr(p,pointers[i],false); Marshal.WriteInt16(pointers[i],header,0); Marshal.WriteInt16(pointers[i],header+2*chars,0); }
   uint found; uint error=QueryAllTracesW(pointers,count,out found); if(error!=0) throw new Win32Exception((int)error);
   var result=new List<Vs2015TraceInfo>();
   for(int i=0;i<Math.Min(found,count);i++) { var p=Marshal.PtrToStructure<Props>(pointers[i]); result.Add(new Vs2015TraceInfo {Name=Marshal.PtrToStringUni(IntPtr.Add(pointers[i],(int)p.LoggerNameOffset)), File=p.LogFileNameOffset==0 ? "" : Marshal.PtrToStringUni(IntPtr.Add(pointers[i],(int)p.LogFileNameOffset)), Id=p.Wnode.HistoricalContext, Guid=p.Wnode.Guid}); }
   return result.ToArray();
  } finally { foreach(var p in pointers) if(p!=IntPtr.Zero) Marshal.FreeHGlobal(p); }
 }
}
'@
}
function Get-VsPerfSessions {
    Initialize-EtwQuery
    # These internal names are verified from VS2015's installed EtwMon assembly.
    return @([Vs2015ProfilerEtw]::Query() | Where-Object { $_.Name -match 'Microsoft\.PerformanceTools\.EtwMon\.VSPerfEtw(System)?Collection$' })
}
function Test-OwnedVsPerfSessions($Sessions, [string]$RunDirectory, $Original = $null) {
    if (-not $Sessions.Count) { return $false }
    $prefix = $RunDirectory.TrimEnd('\') + '\'
    foreach ($session in $Sessions) {
        if (-not $session.File -or -not $session.File.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { return $false }
        if ($null -ne $Original) {
            $same = @($Original | Where-Object { $_.Name -eq $session.Name -and $_.Id -eq $session.Id -and $_.File -eq $session.File })
            if (-not $same.Count) { return $false }
        }
    }
    return $true
}
$script:CaptureState=$null
try {
    if (-not $IsWindows) { Fail 'PLATFORM_UNSUPPORTED' 'The profiler backend requires Windows.' }
    $text=$script:RequestJson
    if ($text.Length -gt 2097152) { Fail 'INVALID_REQUEST' 'Request exceeds 2 MiB.' }
    $request=$text | ConvertFrom-Json -AsHashtable
    if ($request -isnot [Collections.IDictionary]) { Fail 'INVALID_REQUEST' 'Request must be a JSON object.' }
    $operation=Read-Text $request 'operation' 'discover'
    $script:Directory=Resolve-FullPath (Read-Text $request 'workingDirectory' (Get-Location).Path)
    if (-not (Test-Path -LiteralPath $script:Directory -PathType Container)) { Fail 'INVALID_REQUEST' 'workingDirectory must exist.' }
    $script:Limit=[int](Read-Int $request 'maxOutputChars' 64000 256 1048576)
    $timeout=[int](Read-Int $request 'timeoutMs' 120000 100 3600000)
    $dryRun=Read-Bool $request 'dryRun' $true
    $script:StopFile=Read-Text $request 'stopFile'
    if ($script:StopFile) { $script:StopFile=Resolve-FullPath $script:StopFile }
    [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
    $encodingName=Read-Text $request 'encoding'
    $script:Encoding=if ($encodingName) { [Text.Encoding]::GetEncoding($encodingName) } else { [Text.Encoding]::GetEncoding([int][Vs2015Capture]::GetOEMCP()) }
    $elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    switch ($operation) {
        'discover' {
            $result=[ordered]@{ operation=$operation; isElevated=$elevated; tools=@(Get-Tools $request); captureRequiresElevation=$true; cpuSamplingBackend='vsperf';liveCaptureRuntimeVerified=$false;exclusiveVsProfilerRequired=$true;perfViewLiveCaptureSupported=$false; vsperfCmdSamplingSupportedOnCurrentWindows=$false; notes=@('No environment variables, profiling sessions, drivers, or services were changed.','VSPerfCmd sampling is not the Windows 8+ CPU backend.','Raw CLI plans do not provide managed capture lifecycle.') }
        }
        'runKnown' {
            $name=Read-Text $request 'tool'
            $tool=Resolve-Tool $request $name
            $arguments=Get-Value $request 'arguments' @()
            if ($arguments -isnot [Array] -or $arguments.Count -gt 512) { Fail 'INVALID_REQUEST' 'arguments must be an array of at most 512 strings.' }
            foreach ($arg in $arguments) { if ($arg -isnot [string] -or $arg.Contains([char]0)) { Fail 'INVALID_REQUEST' 'arguments must contain strings without NUL.' } }
            $helpOnly=$arguments.Count -eq 1 -and $arguments[0] -in @('/?','/help','-?','-help')
            $readOnly=($arguments.Count -eq 1 -and (($name -in @('vsperf','vsperfcmd') -and $arguments[0] -ieq '/status') -or ($name -eq 'vsperfcmd' -and $arguments[0] -ieq '/querycounters')))
            $report=$name -eq 'vsperfreport'
            if($report) { foreach($arg in $arguments) { if($arg.StartsWith('@') -or ($arg -match '^[-/]' -and $arg -notmatch '^/(U|Summary(?::.+)?|Xml|CallTrace|SymbolPath:.+|DebugSymPath|SummaryFile|PrintMarks|Output:.+|JustMyCode(?::.+)?|StartTime:.+|EndTime:.+|MsFilter:.+|Process:.+|Thread:.+|Diff|DiffThreshold:.+|DiffTable:.+|DiffColumn:.+|QueryDiffTables|NoLogo|\?|Help)$')) { $report=$false } } }
            $instrument=$false
            if($name -eq 'vsinstr' -and @($arguments | Where-Object {$_ -ieq '/DumpFuncs'}).Count -eq 1) {
                $inputs=@($arguments | Where-Object {$_ -notmatch '^[-/@]'})
                $unexpected=@($arguments | Where-Object {$_ -match '^[-/@]' -and $_ -notmatch '^/(U|DumpFuncs|Verbose)$'})
                $instrument=($inputs.Count -eq 1 -and $unexpected.Count -eq 0)
            }
            $perfViewOffline=$name -eq 'perfview' -and $arguments.Count -eq 1 -and $arguments[0] -ieq 'UserCommandHelp'
            if (-not ($helpOnly -or $readOnly -or $report -or $instrument -or $perfViewOffline)) { Fail 'UNMANAGED_COMMAND_REJECTED' 'runKnown permits help/status, offline reports and read-only VSInstr DumpFuncs with one input. Instrumentation and arbitrary start/stop/global commands are not supported.' }
            if ($name -eq 'perfview') { $arguments=@('/AcceptEULA',('/LogFile:'+(Join-Path ([IO.Path]::GetTempPath()) ('vs2015-perf-help-'+[Guid]::NewGuid().ToString('N')+'.log'))))+@($arguments) }
            $plan=New-Plan $tool $arguments $timeout
            $result=[ordered]@{operation=$operation;dryRun=$dryRun;plan=$plan;isElevated=$elevated;lifecycleManaged=$false}
            if (-not $dryRun) { $result['execution']=Invoke-Plan $plan; $result['exitCode']=$result.execution.exitCode; $result['timedOut']=$result.execution.timedOut }
        }
        'report' {
            $tool=Resolve-Tool $request 'vsperfreport'
            $reportInput=Resolve-FullPath (Read-Text $request 'inputPath')
            if (-not (Test-Path -LiteralPath $reportInput -PathType Leaf) -or [IO.Path]::GetExtension($reportInput) -notin @('.vsp','.vsps')) { Fail 'INVALID_REQUEST' 'inputPath must be an existing .vsp or .vsps file. Other capture formats are not assumed compatible.' }
            $types=Get-Value $request 'summaryTypes' @('Header','Process','Function')
            if ($types -isnot [Array] -or -not $types.Count) { Fail 'INVALID_REQUEST' 'summaryTypes must be a nonempty array.' }
            $allowed=@('All','CallerCallee','CallTree','Counter','Function','Ip','Life','Line','Header','Mark','Module','Process','Thread','Type','Contention','RuleWarnings')
            foreach($type in $types) { if ($type -isnot [string] -or $type -notin $allowed) { Fail 'INVALID_REQUEST' 'Unsupported summary type.' } }
            $format=Read-Text $request 'format' 'csv'
            if ($format -notin @('csv','xml')) { Fail 'INVALID_REQUEST' 'format must be csv or xml.' }
            $parent=Resolve-FullPath (Read-Text $request 'outputDirectory' ([IO.Path]::GetTempPath()))
            $runDirectory=Join-Path $parent ('vs2015-report-'+[Guid]::NewGuid().ToString('N'))
            $args=[Collections.Generic.List[string]]::new(); $args.Add('/U'); $args.Add($reportInput); $args.Add('/Summary:'+($types -join ',')); $args.Add('/Output:'+(Join-Path $runDirectory 'report'))
            if ($format -eq 'xml') { $args.Add('/Xml') }
            if ($request.Contains('processId')) { $args.Add('/Process:'+(Read-Int $request 'processId' 0 1 ([int]::MaxValue))) }
            if ($request.Contains('startMs') -or $request.Contains('durationMs')) { $start=Read-Int $request 'startMs' 0 0 ([int]::MaxValue); $duration=Read-Int $request 'durationMs' 0 1 ([int]::MaxValue); $args.Add('/MsFilter:'+ $start + ',' + $duration) }
            $symbols=Read-Text $request 'symbolPath'; if($symbols) { $args.Add('/SymbolPath:'+$symbols) }
            $plan=New-Plan $tool @($args) $timeout
            $result=[ordered]@{operation=$operation;dryRun=$dryRun;plan=$plan;outputDirectory=$runDirectory;format=$format}
            if (-not $dryRun) { $null=[IO.Directory]::CreateDirectory($runDirectory); $result['execution']=Invoke-Plan $plan; $result['exitCode']=$result.execution.exitCode; $result['timedOut']=$result.execution.timedOut; $result['files']=@(Get-ChildItem -LiteralPath $runDirectory -File | Select-Object @{n='path';e={$_.FullName}},Length) }
        }
        'offlineReport' {
            $tool=Resolve-Tool $request 'perfview'
            $analysis=Read-Text $request 'analysis'
            if($analysis -notin @('cpuStacks','cpuCsv','gcStats','eventsXml')){Fail 'INVALID_REQUEST' 'analysis must be cpuStacks, cpuCsv, gcStats or eventsXml.'}
            $inputPath=Resolve-FullPath (Read-Text $request 'inputPath')
            if(-not (Test-Path -LiteralPath $inputPath -PathType Leaf) -or $inputPath -notmatch '(?i)\.etl(?:\.zip)?$'){Fail 'INVALID_REQUEST' 'inputPath must be an existing .etl or .etl.zip file.'}
            $processName=Read-Text $request 'processName'
            if($analysis -in @('cpuStacks','cpuCsv') -and [string]::IsNullOrWhiteSpace($processName)){Fail 'INVALID_REQUEST' 'CPU exports require processName; the last matching process instance is selected by PerfView.'}
            $maxTraceBytes=Read-Int $request 'maxTraceBytes' 1073741824 1 4294967296
            if(-not $inputPath.EndsWith('.zip',[StringComparison]::OrdinalIgnoreCase) -and (Get-Item -LiteralPath $inputPath).Length -gt $maxTraceBytes){Fail 'TRACE_TOO_LARGE' 'Source ETL exceeds maxTraceBytes.'}
            $parent=Resolve-FullPath (Read-Text $request 'outputDirectory' ([IO.Path]::GetTempPath()))
            $runDirectory=Join-Path $parent ('vs2015-offline-'+[Guid]::NewGuid().ToString('N'))
            $inputCopy=Join-Path $runDirectory 'trace.etl'
            $extraction=$null
            if($inputPath.EndsWith('.etl.zip',[StringComparison]::OrdinalIgnoreCase)) {
                $extractRequest=@{operation='extract';inputPath=$inputPath;outputDirectory=$parent;dryRun=$dryRun;maxBytes=(Read-Int $request 'maxTraceBytes' 1073741824 1 4294967296)}
                if($request.ContainsKey('entryName')){$extractRequest.entryName=Read-Text $request 'entryName'}
                $extraction = (& (Join-Path $PSScriptRoot 'Extract-ProfileTrace.ps1') -RequestJson ($extractRequest|ConvertTo-Json -Compress)) | ConvertFrom-Json -AsHashtable
                if($extraction.ContainsKey('error')){Fail 'TRACE_EXTRACTION_FAILED' ($extraction.error.message+' Available ETL entries: '+((Get-Value $extraction 'etlEntries' @()) -join ', '))}
                $inputCopy=$extraction.path
                $runDirectory=$extraction.outputDirectory
            }
            if($inputCopy.Length -gt 220){Fail 'ANALYSIS_PATH_TOO_LONG' 'The legacy analyzer needs room for report suffixes within MAX_PATH. Use a shorter VS2015_MCP_HISTORY directory.'}
            $args=[Collections.Generic.List[string]]::new()
            $args.Add('/AcceptEULA');$args.Add('/LogFile:'+(Join-Path $runDirectory 'analysis.log'));$args.Add('/NoGui');$args.Add('/NoView');$args.Add('UserCommand')
            $notes=[Collections.Generic.List[string]]::new()
            $notes.Add('The source trace is copied into a unique output directory before analysis; the source directory is not used for generated reports or ETLX files.')
            switch($analysis){
                'cpuStacks' {$args.Add('SaveCPUStacks');$args.Add($inputCopy);$args.Add($processName);$pattern='*.perfView.xml.zip'}
                'cpuCsv' {$args.Add('SaveCPUStacksAsCsv');$args.Add($inputCopy);$args.Add($processName);$args.Add('10');$args.Add('LastProcess');$pattern='*.perfView.csv';$notes.Add('PerfView CSV replaces commas in names, its Inc column is count rather than InclusiveMetric, and numeric formatting is culture-dependent; retain raw CSV and do not infer milliseconds from Inc.')}
                'gcStats' {$args.Add('GCStats');$args.Add($inputCopy);$pattern='*.gcStats.html';$notes.Add('GCStats contains all CLR processes, does not filter by processId/processName, and PID reuse may overwrite a per-PID CSV.')}
                'eventsXml' {$args.Add('DumpEventsAsXml');$args.Add($inputCopy);$args.Add((Join-Path $runDirectory 'events.xml'));$pattern='events.xml';$notes.Add('Full trace events are exported without a process filter. The bounded XML summary does not prove app attribution or symbol completeness.')}
            }
            if($analysis -in @('cpuStacks','cpuCsv')){$notes.Add('CPU selection uses the last matching process name, not PID plus start time. Same-name instances require explicit review before attributing results to a selected live process.')}
            $plan=New-Plan $tool @($args) $timeout
            $result=[ordered]@{operation=$operation;dryRun=$dryRun;analysis=$analysis;inputPath=$inputPath;inputCopy=$inputCopy;extraction=$extraction;outputDirectory=$runDirectory;plan=$plan;notes=@($notes);collectorVersion=$tool.version}
            if(-not $dryRun){
                $null=[IO.Directory]::CreateDirectory($runDirectory)
                if($null -eq $extraction){[IO.File]::Copy($inputPath,$inputCopy,$false)}
                if((Get-Item -LiteralPath $inputCopy).Length -gt $maxTraceBytes){Fail 'TRACE_TOO_LARGE' 'Copied ETL exceeds maxTraceBytes.'}
                $result['execution']=Invoke-Plan $plan
                $result['exitCode']=$result.execution.exitCode;$result['timedOut']=$result.execution.timedOut
                $result['files']=@(Get-ChildItem -LiteralPath $runDirectory -Recurse -File | Select-Object @{n='path';e={$_.FullName}},Length)
                $outputs=@(Get-ChildItem -LiteralPath $runDirectory -Recurse -File -Filter $pattern | Where-Object {$_.Length -gt 0})
                $result['reportFiles']=@($outputs | ForEach-Object {$_.FullName})
                if($result.execution.exitCode -eq 0 -and -not $result.execution.timedOut -and -not $outputs.Count){$result['error']=@{code='NO_OFFLINE_REPORT';message='PerfView returned without a nonempty expected report. Inspect analysis.log; the copied trace is not a report.'}}
                if($analysis -eq 'eventsXml' -and $outputs.Count -eq 1 -and $result.execution.exitCode -eq 0 -and -not $result.execution.timedOut){
                    try{$result['eventSummary']=Read-TraceEventSummary -Path $outputs[0].FullName}
                    catch{$result['error']=@{code='EVENT_SUMMARY_FAILED';message=$_.Exception.Message};$result['eventSummary']=@{eventContentValidated=$false}}
                }
            }
        }
        'capture' {
            $backend=Read-Text $request 'backend' 'vsperf'
            if ($backend -ne 'vsperf') { Fail 'BACKEND_UNSUPPORTED' 'Live capture supports VSPerf only. PerfView collect internally invokes global Abort on failure; use its offline reporting operation.' }
            $tool=Resolve-Tool $request $backend
            $processId=[int](Read-Int $request 'processId' 0 1 ([int]::MaxValue))
            $target=Get-Target $processId
            $expected=Read-Text $request 'expectedStartTimeUtc'; if($expected -and $expected -ne $target.startTimeUtc) { Fail 'TARGET_CHANGED' 'The process start time no longer matches the selected process.' }
            $duration=[int](Read-Int $request 'durationMs' 10000 1000 600000)
            $startupTimeout=[int](Read-Int $request 'startupTimeoutMs' 10000 1000 30000)
            $cleanupTimeout=[int](Read-Int $request 'cleanupTimeoutMs' 10000 1000 15000)
            $mode=Read-Text $request 'mode' 'cpu'
            if ($mode -notin @('cpu','gc','gcCollect')) { Fail 'INVALID_REQUEST' 'mode must be cpu, gc or gcCollect.' }
            if ($mode -ne 'cpu') { Fail 'BACKEND_UNSUPPORTED' 'VSPerf.exe capture supports CPU sampling, not the VSPerfCmd GC switch.' }
            $parent=Resolve-FullPath (Read-Text $request 'outputDirectory' ([IO.Path]::GetTempPath()))
            $runId=[Guid]::NewGuid().ToString('N'); $runDirectory=Join-Path $parent ('vs2015-capture-'+$runId)
            $sessionName='VS2015Mcp_'+$runId
            $plan=New-Plan $tool @(('/attach:'+$processId),('/file:'+(Join-Path $runDirectory 'capture.vspx'))) $startupTimeout
            $cleanupPlan=New-Plan $tool @('/detach') $cleanupTimeout
            $script:CaptureState=[ordered]@{operation=$operation;dryRun=$dryRun;backend=$backend;mode=$mode;isElevated=$elevated;permissionRequired=(-not $elevated);target=$target;durationMs=$duration;runId=$runId;sessionName=$null;exclusiveVsProfilerRequired=$true;liveCaptureRuntimeVerified=$false;maximumPlannedDurationMs=($startupTimeout+$duration+$cleanupTimeout+10000);outputDirectory=$runDirectory;plan=$plan;recoveryPlan=$cleanupPlan;recoveryRequiresOwnership=($backend -eq 'vsperf');steps=@();cleanupVerified=$null;cancelled=$false;hardTerminationCanLeaveSession=$true}
            if (-not $dryRun) {
                if (-not $elevated) { Fail 'PERMISSION_REQUIRED' 'Capture requires an already elevated process. No automatic elevation was attempted.' }
                if (Test-StopRequested) { Fail 'CANCELLED' 'Capture was cancelled before it started.' }
                $null=[IO.Directory]::CreateDirectory($runDirectory)
                $manifest=Join-Path $runDirectory 'session.json'
                [IO.File]::WriteAllText($manifest,($script:CaptureState|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
                if ($backend -eq 'vsperf') {
                    $mutex=[Threading.Mutex]::new($false,'Local\VS2015Mcp_VSPerf_Capture'); $locked=$false; $started=$false; $owned=@()
                    try {
                        try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
                        if (-not $locked) { Fail 'PROFILER_BUSY' 'Another MCP VSPerf capture owns the capture lock.' }
                        $before=@(Get-VsPerfSessions)
                        if ($before.Count) { Fail 'PROFILER_BUSY' 'An existing VSPerf ETW session is active. No attach or detach was attempted.' }
                        if (-not (Test-SameTarget $target)) { Fail 'TARGET_CHANGED' 'The selected process exited or its PID was reused.' }
                        $started=$true
                        $execution=Invoke-Plan $plan; $script:CaptureState.steps+=@($execution)
                        $current=@(Get-VsPerfSessions)
                        if (Test-OwnedVsPerfSessions $current $runDirectory) { $owned=$current; $script:CaptureState['ownedSessions']=$owned }
                        Assert-Success $execution 'VSPerf attach'
                        if (-not $owned.Count) { Fail 'SESSION_OWNERSHIP_UNVERIFIED' 'No VSPerf sessions with log paths inside this unique capture directory were found. An unknown session will not be detached.' }
                        if(-not (Test-SameTarget $target)){Fail 'TARGET_CHANGED' 'The selected process changed while the profiler attached.'}
                        $watch=[Diagnostics.Stopwatch]::StartNew()
                        while ($watch.ElapsedMilliseconds -lt $duration -and (Test-SameTarget $target)) {
                            if (Test-StopRequested) { $script:CaptureState.cancelled=$true; break }
                            Start-Sleep -Milliseconds 100
                        }
                    } finally {
                        if ($started) {
                            try {
                                $remaining=@(Get-VsPerfSessions)
                                if ($remaining.Count) {
                                    if (Test-OwnedVsPerfSessions $remaining $runDirectory $(if($owned.Count){$owned}else{$null})) {
                                        if(-not $owned.Count){$owned=$remaining;$script:CaptureState['ownedSessions']=$owned}
                                        $script:CaptureState['cleanup']=Invoke-Plan $cleanupPlan
                                        if($script:CaptureState.cleanup.timedOut -or $script:CaptureState.cleanup.exitCode -ne 0){$script:CaptureState['cleanupCommandFailed']=$true;$script:CaptureState['partialTrace']=$true}
                                    }
                                    else { $script:CaptureState['cleanupWarning']='VSPerf session ownership changed or could not be verified; no global detach was sent.' }
                                }
                                $after=@(Get-VsPerfSessions)
                                if ($after.Count -and (Test-OwnedVsPerfSessions $after $runDirectory $(if($owned.Count){$owned}else{$null}))) {
                                    $fallback=[Collections.Generic.List[object]]::new()
                                    foreach($session in $after) { $code=[Vs2015ProfilerEtw]::Stop($session.Id,$session.Guid); $fallback.Add(@{sessionName=$session.Name;win32Code=$code;stopped=($code -in @(0,4201))}) }
                                    $script:CaptureState['nativeCleanup']=@($fallback); $script:CaptureState['partialTrace']=$true
                                }
                                $script:CaptureState.cleanupVerified=($owned.Count -gt 0 -and @(Get-VsPerfSessions).Count -eq 0)
                                if(-not $owned.Count){$script:CaptureState['cleanupWarning']='No owned session was observed; absence of recognized names does not verify cleanup.'}
                            } catch { $script:CaptureState['cleanupWarning']=$_.Exception.Message; $script:CaptureState.cleanupVerified=$false }
                        }
                        if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose()
                    }
                }
                $script:CaptureState['files']=@(Get-ChildItem -LiteralPath $runDirectory -File | Select-Object @{n='path';e={$_.FullName}},Length)
                $script:CaptureState['status']=if($script:CaptureState.cancelled){'cancelled'}elseif(-not $script:CaptureState.cleanupVerified){'cleanup-unverified'}elseif($script:CaptureState.Contains('partialTrace') -and $script:CaptureState.partialTrace){'partial'}else{'completed'}
                $artifacts=@(Get-ChildItem -LiteralPath $runDirectory -File | Where-Object { $_.Length -gt 0 -and $_.Extension -in @('.etl','.zip','.vspx','.vsp') })
                if(-not $artifacts.Count -and -not $script:CaptureState.cancelled) { $script:CaptureState.status='no-artifact'; Fail 'NO_CAPTURE_ARTIFACT' 'The collector returned without a nonempty trace artifact. Check steps and logs; this is not a successful profile.' }
                if($script:CaptureState.Contains('cleanupCommandFailed') -and $script:CaptureState.cleanupCommandFailed){Fail 'PROFILER_DETACH_FAILED' 'The detach command failed or timed out; remaining files are partial even if ETW sessions are now gone.'}
                if(-not $script:CaptureState.cleanupVerified) { Fail 'PROFILER_CLEANUP_INCOMPLETE' 'Capture cleanup could not be verified. Inspect capture.cleanupWarning and the ownership-constrained recovery plan.' }
                [IO.File]::WriteAllText($manifest,($script:CaptureState|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
            }
            $result=$script:CaptureState
        }
        default { Fail 'INVALID_REQUEST' 'operation must be discover, runKnown, report, offlineReport or capture.' }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 16 -Compress))
} catch {
    $code=if($_.Exception.Data.Contains('code')){[string]$_.Exception.Data['code']}else{'PROFILER_BACKEND_ERROR'}
    $result=[ordered]@{error=@{code=$code;message=$_.Exception.Message}}
    if($null -ne $script:CaptureState){
        $result['capture']=$script:CaptureState
        if(-not $script:CaptureState.dryRun -and (Test-Path -LiteralPath $script:CaptureState.outputDirectory -PathType Container)) {
            try { [IO.File]::WriteAllText((Join-Path $script:CaptureState.outputDirectory 'session.json'),($result|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false)) } catch { $result['manifestWriteWarning']=$_.Exception.Message }
        }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 16 -Compress))
    exit 1
}

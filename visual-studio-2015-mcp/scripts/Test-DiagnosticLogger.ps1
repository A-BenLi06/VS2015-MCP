#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$run = Join-Path ([IO.Path]::GetTempPath()) ('vs2015-logger-test-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($run)
$utf8 = [Text.UTF8Encoding]::new($false)
$builder = Join-Path $PSScriptRoot 'Build-DiagnosticLogger.ps1'
$compiled = (& (Get-Command pwsh).Source -NoProfile -File $builder -OutputDirectory (Join-Path $run 'compiled')) | ConvertFrom-Json -AsHashtable
if ($compiled.ContainsKey('error')) { throw $compiled.error.message }
$msbuild = Join-Path ([IO.Path]::GetDirectoryName($compiled.frameworkPath)) 'MSBuild.exe'
$projects = @()
for ($i=1; $i -le 4; $i++) {
    $name = "child $i.proj"
    $projects += "<Child Include=`"$name`" />"
    $body = @'
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Target Name="Build">
    <Exec Command="ping -n 2 127.0.0.1 &gt;nul" />
    <Warning Code="DXW{0}" File="源 文件.cs" Text="中文警告 &quot;引用&quot; \ 路径&#xA;第二行" />
  </Target>
</Project>
'@ -f $i
    [IO.File]::WriteAllText((Join-Path $run $name), $body, $utf8)
}
$main = @'
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>{0}</ItemGroup>
  <Target Name="Build">
    <MSBuild Projects="@(Child)" Targets="Build" BuildInParallel="true" />
    <Error Code="DXE001" File="错误 源.cs" Text="故意错误 &quot;测试&quot; \ 路径&#xA;错误第二行" />
  </Target>
</Project>
'@ -f ($projects -join '')
$mainPath = Join-Path $run 'main.proj'
[IO.File]::WriteAllText($mainPath, $main, $utf8)
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Run-Build([string]$Log, [int]$MaxEvents=100000, [int]$MaxMessageChars=32768) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Log))
    $logger = '/logger:Vs2015.Diagnostics.DiagnosticLogger,' + $compiled.assemblyPath + ';output=' + $encoded + ';timings=true;maxEvents=' + $MaxEvents + ';maxMessageChars=' + $MaxMessageChars
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $msbuild
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = $run
    foreach ($value in @($mainPath, '/nologo', '/nr:false', '/m:2', '/v:quiet', $logger)) { $info.ArgumentList.Add($value) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { $process.Kill($true); throw 'MSBuild validation timed out.' }
        return @{exitCode=$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult()}
    } finally { $process.Dispose() }
}
$log = Join-Path $run 'logs with spaces;中文/events.jsonl'
$result = Run-Build $log
Assert ($result.exitCode -ne 0) 'Intentional build error was not reflected in process exit.'
$events = @(Get-Content -LiteralPath $log -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json -AsHashtable })
Assert ($events[0].kind -eq 'sessionStarted') 'Missing opening record.'
Assert ($events[-1].kind -eq 'sessionFinished') 'Missing closing record.'
Assert ($events[-1].diagnosticsComplete) 'Expected complete diagnostic collection.'
Assert (-not $events[-1].succeeded) 'Intentional build error was not reflected in completion.'
Assert ($events[-1].errorCount -eq 1 -and $events[-1].warningCount -eq 4) 'Diagnostic counts do not match the project tasks.'
$errors = @($events | Where-Object kind -eq error)
$warnings = @($events | Where-Object kind -eq warning)
Assert ($errors.Count -eq 1 -and $errors[0].code -eq 'DXE001') 'Error code was not preserved.'
Assert ($errors[0].file -eq '错误 源.cs') 'Unicode source filename was not preserved.'
Assert ($errors[0].message.Contains('"测试"') -and $errors[0].message.Contains('\') -and $errors[0].message.Contains("`n")) 'Diagnostic JSON escaping lost message data.'
Assert ($errors[0].ContainsKey('line') -and $errors[0].ContainsKey('column') -and $errors[0].ContainsKey('context')) 'Structured source/context fields are absent.'
Assert ($warnings.Count -eq 4) 'Warnings were lost during the multi-node build.'
$nodes = @($warnings | ForEach-Object { $_.context.nodeId } | Select-Object -Unique)
Assert ($nodes.Count -ge 2) 'Parallel build did not exercise multiple MSBuild nodes.'
for ($i=0; $i -lt $events.Count; $i++) { Assert ($events[$i].sequence -eq $i+1) 'JSONL records have a duplicate or missing sequence number.' }
Assert ($events[-1].eventsWritten -eq $events.Count) 'Footer record count is inconsistent.'
'PASS MSBuild 14: Chinese warning/error fields, JSON escaping, /m:2 node contexts, ordered JSONL, timing, completion.'

$smallLog = Join-Path $run 'capped/events.jsonl'
$null = Run-Build $smallLog 2
$small = @(Get-Content -LiteralPath $smallLog -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json -AsHashtable })
Assert (-not $small[-1].diagnosticsComplete) 'A truncated log incorrectly claims complete diagnostics.'
Assert ($small[-1].droppedDiagnostics -eq 5 -and $small[-1].errorCount -eq 1 -and $small[-1].warningCount -eq 4) 'Capped collection lost the true diagnostic counts.'
'PASS event cap explicitly reports dropped diagnostics and preserves error/warning counts.'

$before = [IO.File]::ReadAllBytes($log)
$collision = Run-Build $log
Assert ($collision.exitCode -ne 0) 'Reusing a log path must fail.'
Assert ([Convert]::ToBase64String($before) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($log))) 'Existing log was overwritten.'
'PASS CreateNew rejects reused log paths without overwriting evidence.'

$locationProject = @'
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <UsingTask TaskName="EmitLocations" TaskFactory="CodeTaskFactory" AssemblyFile="{0}">
    <Task><Code Type="Fragment" Language="cs"><![CDATA[
      BuildEngine.LogWarningEvent(new Microsoft.Build.Framework.BuildWarningEventArgs("custom", "DXWLOC", "定位.cs", 12, 7, 12, 18, new string('警', 100) + "尾部", null, "fixture"));
      BuildEngine.LogErrorEvent(new Microsoft.Build.Framework.BuildErrorEventArgs("custom", "DXELOC", "定位.cs", 24, 3, 25, 9, "精确位置错误", null, "fixture"));
      return false;
    ]]></Code></Task>
  </UsingTask>
  <Target Name="Build"><EmitLocations /></Target>
</Project>
'@ -f [Security.SecurityElement]::Escape((Join-Path ([IO.Path]::GetDirectoryName($compiled.frameworkPath)) 'Microsoft.Build.Tasks.Core.dll'))
$mainPath = Join-Path $run 'locations.proj'
[IO.File]::WriteAllText($mainPath, $locationProject, $utf8)
$locationLog = Join-Path $run 'locations/events.jsonl'
$null = Run-Build $locationLog 100000 64
$locations = @(Get-Content -LiteralPath $locationLog -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json -AsHashtable })
$preciseError = @($locations | Where-Object { $_.kind -eq 'error' -and $_.code -eq 'DXELOC' })
Assert ($preciseError.Count -eq 1) 'Typed task error event was not captured.'
Assert ($preciseError[0].line -eq 24 -and $preciseError[0].column -eq 3 -and $preciseError[0].endLine -eq 25 -and $preciseError[0].endColumn -eq 9) 'Exact source locations were not preserved.'
$longWarning = @($locations | Where-Object { $_.kind -eq 'warning' -and $_.code -eq 'DXWLOC' })
Assert ($longWarning.Count -eq 1 -and $longWarning[0].messageTruncated -and $longWarning[0].message.Length -eq 64) 'Message limit did not mark truncated diagnostic text.'
Assert (-not $locations[-1].diagnosticsComplete -and $locations[-1].errorCount -eq 1 -and $locations[-1].warningCount -eq 1) 'Message truncation was not reflected in completion status.'
'PASS typed BuildErrorEventArgs preserves exact start/end coordinates; clipped warning is explicitly incomplete.'

$specialDirectory = Join-Path $run 'assembly with spaces'
$null = [IO.Directory]::CreateDirectory($specialDirectory)
$specialAssembly = Join-Path $specialDirectory 'Vs2015.DiagnosticLogger.dll'
[IO.File]::Copy($compiled.assemblyPath, $specialAssembly)
$compiled.assemblyPath = $specialAssembly
$specialLog = Join-Path $run 'assembly grammar/events.jsonl'
$null = Run-Build $specialLog
$specialEvents = @(Get-Content -LiteralPath $specialLog -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json -AsHashtable })
Assert ($specialEvents[-1].diagnosticsComplete -and $specialEvents[-1].errorCount -eq 1) 'Literal DLL logger path did not preserve spaces.'
'PASS literal logger assembly path supports spaces; base64 protects output parameters.'
@{runDirectory=$run;assemblyPath=$compiled.assemblyPath;events=$events.Count;warningNodes=$nodes;logPath=$log} | ConvertTo-Json -Compress

#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$writer = $null
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    $targetProcessId = [int]$request.processId
    $duration = [int]$request.durationMs
    $interval = [int]$request.intervalMs
    if ($targetProcessId -le 0 -or $duration -lt 1000 -or $duration -gt 300000 -or $interval -lt 250 -or $interval -gt 30000) { throw 'Invalid process ID, duration, or sample interval.' }
    $outputPath = [IO.Path]::GetFullPath([string]$request.outputPath)
    $process = [Diagnostics.Process]::GetProcessById($targetProcessId)
    $startTicks = $process.StartTime.ToUniversalTime().Ticks
    $identity = @{ processId = $targetProcessId; processName = $process.ProcessName; startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o') }
    $process.Dispose()
    $stream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
    $startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $writer.WriteLine((@{kind='start';schemaVersion=1;identity=$identity;startedAt=$startedAt;intervalMs=$interval;requestedDurationMs=$duration;logicalProcessors=[Environment]::ProcessorCount} | ConvertTo-Json -Depth 5 -Compress))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $count = 0; $reason = 'duration'; $warnings = [Collections.Generic.HashSet[string]]::new()
    do {
        $sample = @{ kind='sample'; timestampUtc=[DateTimeOffset]::UtcNow.ToString('o'); elapsedMs=$timer.Elapsed.TotalMilliseconds; clr=$null }
        $process = $null
        try {
            $process = [Diagnostics.Process]::GetProcessById($targetProcessId)
            if ($process.StartTime.ToUniversalTime().Ticks -ne $startTicks) { $reason='pid-reused'; break }
            $process.Refresh()
            $sample.cpuTotalMs = $process.TotalProcessorTime.TotalMilliseconds
            $sample.privateBytes = $process.PrivateMemorySize64
            $sample.workingSetBytes = $process.WorkingSet64
            $sample.threadCount = $process.Threads.Count
        } catch [ArgumentException] { $reason='process-exited'; break }
        catch [InvalidOperationException] { $reason='process-exited'; break }
        finally { if ($process) { $process.Dispose() } }
        if ($request.includeClr) {
            try {
                $counters = @(Get-CimInstance -ClassName Win32_PerfRawData_NETFramework_NETCLRMemory -Filter "ProcessID = $targetProcessId" -OperationTimeoutSec 2 -ErrorAction Stop)
                if ($counters.Count -eq 1) {
                    $counter = $counters[0]
                    $sample.clr = @{
                        instance=$counter.Name; timestampUtc=[DateTimeOffset]::UtcNow.ToString('o')
                        allocatedBytesCounter=[double]$counter.AllocatedBytesPersec
                        gen0Collections=[double]$counter.NumberGen0Collections; gen1Collections=[double]$counter.NumberGen1Collections; gen2Collections=[double]$counter.NumberGen2Collections
                        heapBytes=[double]$counter.NumberBytesinallHeaps; largeObjectHeapBytes=[double]$counter.LargeObjectHeapsize
                        committedBytes=[double]$counter.NumberTotalcommittedBytes
                        gcTimeNumerator=[double]$counter.PercentTimeinGC; gcTimeDenominator=[double]$counter.PercentTimeinGC_Base
                    }
                } elseif ($counters.Count -gt 1) { $null=$warnings.Add('Multiple CLR counter instances matched this PID; counters are omitted rather than merged.') }
                else { $null=$warnings.Add('No .NET Framework CLR counter instance for this PID. Native, modern .NET and guest processes do not expose these counters here.') }
            } catch { $null=$warnings.Add('CLR counters unavailable: '+$_.Exception.Message) }
        }
        $writer.WriteLine(($sample | ConvertTo-Json -Depth 6 -Compress)); $count++
        $remaining = $duration - $timer.ElapsedMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min($interval, $remaining)) }
    } while ($timer.ElapsedMilliseconds -lt $duration)
    $footer = @{kind='end';timestampUtc=[DateTimeOffset]::UtcNow.ToString('o');elapsedMs=$timer.Elapsed.TotalMilliseconds;samples=$count;reason=$reason;complete=($reason -eq 'duration');warnings=@($warnings)}
    $writer.WriteLine(($footer | ConvertTo-Json -Depth 5 -Compress)); $writer.Dispose(); $writer=$null
    [Console]::Out.WriteLine((@{path=$outputPath;identity=$identity;startedAt=$startedAt;durationMs=$timer.Elapsed.TotalMilliseconds;samples=$count;complete=$footer.complete;reason=$reason;warnings=@($warnings)} | ConvertTo-Json -Depth 6 -Compress))
} catch {
    [Console]::Out.WriteLine((@{error=@{code='PROCESS_SAMPLE_ERROR';message=$_.Exception.Message}} | ConvertTo-Json -Compress))
    exit 1
} finally { if ($writer) { $writer.Dispose() } }

#requires -Version 7.0
# Readers drain both pipes concurrently, retaining at most the requested amount.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
public sealed class Vs2015Capture {
    public string Text { get; private set; }
    public bool Truncated { get; private set; }
    public async Task ReadAsync(StreamReader reader, int limit) {
        var buffer = new char[4096];
        var result = new StringBuilder();
        int count;
        while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
            int keep = Math.Min(count, Math.Max(0, limit - result.Length));
            result.Append(buffer, 0, keep);
            if (keep < count) Truncated = true;
        }
        Text = result.ToString();
    }
    [DllImport("kernel32.dll")] public static extern uint GetOEMCP();
}
'@

function Get-Value($Object, [string]$Name, $Default = $null) {
    if ($Object.Contains($Name)) { return ,$Object[$Name] }
    return ,$Default
}

function Invoke-CapturedProcess {
    param([string]$Executable, [string[]]$Arguments, [string]$Directory,
        [Collections.IDictionary]$Environment, [int]$TimeoutMs = 120000,
        [int]$Limit = 64000, [Text.Encoding]$Encoding, [string]$InternalCommandLine)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.WorkingDirectory = $Directory
    $info.StandardOutputEncoding = $Encoding
    $info.StandardErrorEncoding = $Encoding
    if ($InternalCommandLine) { $info.Arguments = $InternalCommandLine }
    else { foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) } }
    if ($null -ne $Environment) {
        $info.Environment.Clear()
        foreach ($entry in $Environment.GetEnumerator()) { $info.Environment[$entry.Key] = [string]$entry.Value }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $null = $process.Start()
        $process.StandardInput.Close()
        $stdout = [Vs2015Capture]::new()
        $stderr = [Vs2015Capture]::new()
        $readOut = $stdout.ReadAsync($process.StandardOutput, $Limit)
        $readErr = $stderr.ReadAsync($process.StandardError, $Limit)
        $timedOut = -not $process.WaitForExit($TimeoutMs)
        if ($timedOut) {
            try { $process.Kill($true) } catch [InvalidOperationException] { }
            if (-not $process.WaitForExit(10000)) { throw 'Timed-out process did not terminate.' }
        }
        $reads = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($readOut, $readErr))
        if (-not $reads.Wait(10000)) { throw 'Output streams remained open after process exit.' }
        $timer.Stop()
        return [ordered]@{
            executable = $Executable; arguments = @($Arguments); workingDirectory = $Directory
            exitCode = $process.ExitCode; timedOut = $timedOut; durationMs = $timer.ElapsedMilliseconds
            stdout = $stdout.Text; stderr = $stderr.Text
            truncated = [ordered]@{ stdout = $stdout.Truncated; stderr = $stderr.Truncated }
        }
    } finally { $process.Dispose() }
}

Export-ModuleMember -Function Get-Value, Invoke-CapturedProcess

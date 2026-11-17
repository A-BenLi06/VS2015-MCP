#requires -Version 7.0
[CmdletBinding()]
param([string]$MsBuildDirectory, [string]$OutputDirectory, [string]$CompilerPath, [string]$VsRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    if (-not $IsWindows) { throw 'The diagnostic logger must be compiled against Windows .NET Framework and MSBuild 14.' }
    if ($PSBoundParameters.Count -eq 0 -and [Console]::IsInputRedirected) {
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        $raw = [Console]::In.ReadToEnd()
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $request = $raw | ConvertFrom-Json -AsHashtable
            if ($request -isnot [Collections.IDictionary]) { throw 'Compilation request must be a JSON object.' }
            $MsBuildDirectory = $request['msBuildDirectory']
            $OutputDirectory = $request['outputDirectory']
            $CompilerPath = $request['compilerPath']
            $VsRoot = $request['vsRoot']
        }
    }
    if ($VsRoot) {
        $VsRoot = [IO.Path]::GetFullPath($VsRoot)
        $marker = Join-Path $VsRoot 'Common7/IDE/devenv.exe'
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { $marker = Join-Path $VsRoot 'Common7/IDE/msenv.dll' }
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or [Diagnostics.FileVersionInfo]::GetVersionInfo($marker).FileMajorPart -ne 14) {
            throw 'vsRoot is not a verified Visual Studio 2015 installation.'
        }
    }
    if (-not $MsBuildDirectory) {
        $MsBuildDirectory = Get-ItemPropertyValue 'HKLM:/SOFTWARE/WOW6432Node/Microsoft/MSBuild/ToolsVersions/14.0' 'MSBuildToolsPath'
    }
    $MsBuildDirectory = [IO.Path]::GetFullPath($MsBuildDirectory)
    $framework = Join-Path $MsBuildDirectory 'Microsoft.Build.Framework.dll'
    if (-not (Test-Path -LiteralPath $framework -PathType Leaf)) { throw 'Microsoft.Build.Framework.dll is missing from the selected MSBuild directory.' }
    $frameworkVersion = [Reflection.AssemblyName]::GetAssemblyName($framework).Version
    if ($frameworkVersion.Major -ne 14) { throw 'The diagnostic logger requires Microsoft.Build.Framework assembly version 14.' }
    if (-not $CompilerPath) { $CompilerPath = Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
    $CompilerPath = [IO.Path]::GetFullPath($CompilerPath)
    if (-not (Test-Path -LiteralPath $CompilerPath -PathType Leaf)) { throw 'The .NET Framework C# compiler is not installed.' }
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path ([IO.Path]::GetTempPath()) ('vs2015-mcp-logger/' + [Guid]::NewGuid().ToString('N')) }
    $OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    $null = [IO.Directory]::CreateDirectory($OutputDirectory)
    $assembly = Join-Path $OutputDirectory 'Vs2015.DiagnosticLogger.dll'
    if (Test-Path -LiteralPath $assembly) { throw 'Output assembly already exists. Compile into a new build/cache directory.' }
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../logger/DiagnosticLogger.cs'))
    $compilerDirectory = [IO.Path]::GetDirectoryName($CompilerPath)
    $arguments = @('/nologo', '/target:library', '/platform:anycpu', '/optimize+', '/debug-', '/utf8output', "/out:$assembly",
        "/reference:$framework", "/reference:$(Join-Path $compilerDirectory 'System.Runtime.Serialization.dll')", $source)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $CompilerPath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
    $compiler = [Diagnostics.Process]::new()
    $compiler.StartInfo = $start
    try {
        $null = $compiler.Start()
        $stdout = $compiler.StandardOutput.ReadToEndAsync()
        $stderr = $compiler.StandardError.ReadToEndAsync()
        if (-not $compiler.WaitForExit(60000)) { $compiler.Kill($true); $compiler.WaitForExit(); throw 'Diagnostic logger compilation timed out.' }
        $compilerOutput = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        if ($compiler.ExitCode -ne 0) { throw "Diagnostic logger compilation failed ($($compiler.ExitCode)): $compilerOutput" }
    } finally { $compiler.Dispose() }
    [Console]::Out.WriteLine((@{assemblyPath=$assembly;frameworkAssemblyPath=$framework;frameworkPath=$framework;frameworkVersion=$frameworkVersion.ToString();compilerPath=$CompilerPath} | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.WriteLine((@{error=@{code='DIAGNOSTIC_LOGGER_BUILD_ERROR';message=$_.Exception.Message}} | ConvertTo-Json -Compress))
    exit 1
}

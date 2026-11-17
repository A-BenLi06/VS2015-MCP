#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    $root = if ($request.ContainsKey('vsRoot') -and $request.vsRoot) { $request.vsRoot } else { $env:VS2015_MCP_ROOT }
    if (-not $root) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
            $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
            try {
                $key = $hive.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\SxS\VS7')
                if ($key) { try { $root = $key.GetValue('14.0') } finally { $key.Dispose() } }
            } finally { $hive.Dispose() }
            if ($root) { break }
        }
    }
    if (-not $root) { throw 'Visual Studio 2015 installation was not found. Set VS2015_MCP_ROOT.' }
    $root = [IO.Path]::GetFullPath($root)
    $ide = Join-Path $root 'Common7/IDE'
    $marker = Join-Path $ide 'devenv.exe'
    if (-not [IO.File]::Exists($marker) -or [Diagnostics.FileVersionInfo]::GetVersionInfo($marker).FileMajorPart -ne 14) { throw 'The selected installation is not Visual Studio 2015.' }
    $references = @()
    foreach ($name in @('EnvDTE.dll', 'EnvDTE80.dll')) {
        $candidates = @((Join-Path $ide "PublicAssemblies/$name"), (Join-Path $ide "PrivateAssemblies/$name"))
        $found = @($candidates | Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1)
        if (-not $found.Count) {
            $found = @(Get-ChildItem -LiteralPath (Join-Path $ide 'Extensions') -Filter $name -File -Recurse | Select-Object -First 1 -ExpandProperty FullName)
        }
        if (-not $found.Count) { throw "The installed IDE has no $name interop assembly." }
        $identity = [Reflection.AssemblyName]::GetAssemblyName($found[0])
        if ($identity.Name -ine [IO.Path]::GetFileNameWithoutExtension($name) -or $identity.Version.Major -ne 8) { throw "Unexpected IDE interop identity: $identity" }
        $references += $found[0]
    }
    $compilerDirectory = Join-Path $env:SystemRoot 'Microsoft.NET/Framework/v4.0.30319'
    $compiler = Join-Path $compilerDirectory 'csc.exe'
    if (-not [IO.File]::Exists($compiler)) { throw '.NET Framework 4 compiler is missing.' }
    $sourceDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../ide-bridge'))
    $sources = @(Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.cs' -File | Select-Object -ExpandProperty FullName)
    if (-not $sources.Count) { throw 'IDE bridge sources are missing.' }
    $output = Join-Path ([IO.Path]::GetTempPath()) ('vs2015-ide-bridge-' + [guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($output)
    foreach ($reference in $references) { [IO.File]::Copy($reference, (Join-Path $output ([IO.Path]::GetFileName($reference))), $false) }
    $executable = Join-Path $output 'Vs2015.IdeBridge.exe'
    $arguments = @('/nologo', '/target:exe', '/platform:x86', '/optimize+', '/utf8output', "/out:$executable")
    foreach ($reference in $references) { $arguments += "/reference:$reference" }
    foreach ($name in @('System.dll', 'System.Core.dll', 'Microsoft.CSharp.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll')) {
        $arguments += '/reference:' + (Join-Path $compilerDirectory $name)
    }
    $arguments += $sources
    $start = [Diagnostics.ProcessStartInfo]::new($compiler)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8; $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start)
    try {
        $outTask = $process.StandardOutput.ReadToEndAsync(); $errTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { $process.Kill($true); $process.WaitForExit(); throw 'IDE bridge compilation timed out.' }
        $outputText = $outTask.GetAwaiter().GetResult() + $errTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "IDE bridge compilation failed: $outputText" }
    } finally { $process.Dispose() }
    [Console]::Out.WriteLine((@{ executablePath=$executable; references=$references; vsRoot=$root } | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.WriteLine((@{ error=@{ code='IDE_BRIDGE_BUILD_FAILED'; message=$_.Exception.Message } } | ConvertTo-Json -Compress))
    exit 1
}

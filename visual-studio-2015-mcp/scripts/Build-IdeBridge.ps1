#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsPaths.psm1')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$lease = $null
$locked = $false

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Fail([string]$Code, [string]$Message) {
    $failure = [InvalidOperationException]::new($Message)
    $failure.Data['code'] = $Code
    throw $failure
}
function Test-CachedBuild([string]$Directory, [string]$Key, [string[]]$ExpectedNames) {
    if (([IO.DirectoryInfo]::new($Directory)).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache key directory is a reparse point: $Directory" }
    $manifestPath = Join-Path $Directory 'build-manifest.json'
    if (-not [IO.File]::Exists($manifestPath)) { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache manifest is missing: $Directory" }
    try { $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json -AsHashtable }
    catch { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache manifest is unreadable: $Directory" }
    if ($manifest -isnot [Collections.IDictionary] -or -not $manifest.ContainsKey('schemaVersion') -or -not $manifest.ContainsKey('cacheKey') -or -not $manifest.ContainsKey('artifacts') -or $manifest.schemaVersion -ne 1 -or $manifest.cacheKey -cne $Key -or $manifest.artifacts -isnot [array]) { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache manifest identity is invalid: $Directory" }
    $entries = @(Get-ChildItem -LiteralPath $Directory -Force)
    if ($entries.Count -ne ($ExpectedNames.Count + 1) -or @($entries | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }).Count) { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache contains unexpected entries: $Directory" }
    if ($manifest.artifacts.Count -ne $ExpectedNames.Count) { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache artifact count is invalid: $Directory" }
    foreach ($name in $ExpectedNames) {
        $records = @($manifest.artifacts | Where-Object { $_ -is [Collections.IDictionary] -and $_.ContainsKey('name') -and $_.name -ceq $name })
        if ($records.Count -ne 1 -or -not $records[0].ContainsKey('bytes') -or -not $records[0].ContainsKey('sha256') -or $records[0].sha256 -notmatch '^[a-f0-9]{64}$') { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache artifact metadata is invalid: $name" }
        $file = Join-Path $Directory $name
        if (-not [IO.File]::Exists($file) -or ([IO.FileInfo]::new($file)).Length -ne $records[0].bytes -or (Get-Sha256 $file) -cne $records[0].sha256) { Fail 'IDE_CACHE_INTEGRITY_FAILED' "Cache artifact changed: $file. Use a new VS2015_MCP_IDE_CACHE_ROOT or explicitly repair this cache." }
    }
    return $manifest
}

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    if ($request -isnot [Collections.IDictionary]) { throw 'Compilation request must be an object.' }
    $root = if ($request.ContainsKey('vsRoot') -and $request.vsRoot) { $request.vsRoot } else { $env:VS2015_MCP_ROOT }
    if (-not $root) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
            $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
            try { $key = $hive.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\SxS\VS7'); if ($key) { try { $root = $key.GetValue('14.0') } finally { $key.Dispose() } } }
            finally { $hive.Dispose() }
            if ($root) { break }
        }
    }
    if (-not $root) { throw 'Visual Studio 2015 installation was not found. Set VS2015_MCP_ROOT.' }
    $root = [IO.Path]::GetFullPath($root)
    $ide = Join-Path $root 'Common7/IDE'
    $marker = Join-Path $ide 'devenv.exe'
    if (-not [IO.File]::Exists($marker) -or [Diagnostics.FileVersionInfo]::GetVersionInfo($marker).FileMajorPart -ne 14) { throw 'The selected installation is not Visual Studio 2015.' }
    $references = [Collections.Generic.List[string]]::new()
    $referenceInputs = [Collections.Generic.List[object]]::new()
    foreach ($name in @('EnvDTE.dll', 'EnvDTE80.dll', 'EnvDTE90a.dll')) {
        $candidates = @((Join-Path $ide "PublicAssemblies/$name"), (Join-Path $ide "PrivateAssemblies/$name"))
        $found = @($candidates | Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1)
        if (-not $found.Count) { $found = @(Get-ChildItem -LiteralPath (Join-Path $ide 'Extensions') -Filter $name -File -Recurse | Sort-Object FullName | Select-Object -First 1 -ExpandProperty FullName) }
        if (-not $found.Count) { throw "The installed IDE has no $name interop assembly." }
        $identity = [Reflection.AssemblyName]::GetAssemblyName($found[0])
        $expectedMajor = if ($name -ieq 'EnvDTE90a.dll') { 9 } else { 8 }
        if ($identity.Name -ine [IO.Path]::GetFileNameWithoutExtension($name) -or $identity.Version.Major -ne $expectedMajor) { throw "Unexpected IDE interop identity: $identity" }
        $references.Add($found[0]); $referenceInputs.Add([ordered]@{ name=$name; identity=$identity.FullName; sha256=Get-Sha256 $found[0] })
    }
    $compilerDirectory = Join-Path (Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::Windows)) 'Microsoft.NET/Framework/v4.0.30319'
    $compiler = Join-Path $compilerDirectory 'csc.exe'
    if (-not [IO.File]::Exists($compiler)) { throw '.NET Framework 4 compiler is missing.' }
    $sourceDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../ide-bridge'))
    [string[]]$sources = @(Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.cs' -File | Select-Object -ExpandProperty FullName)
    [Array]::Sort($sources, [StringComparer]::Ordinal)
    if (-not $sources.Count) { throw 'IDE bridge sources are missing.' }
    $sourceInputs = @($sources | ForEach-Object { [ordered]@{name=[IO.Path]::GetFileName($_);sha256=Get-Sha256 $_} })
    $frameworkNames = @('System.dll', 'System.Core.dll', 'System.Xml.dll', 'Microsoft.CSharp.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll')
    $compilerInputs = @(@('csc.exe', 'mscorlib.dll') + $frameworkNames + @('csc.exe.config', 'csc.rsp') | ForEach-Object { $file = Join-Path $compilerDirectory $_; if ([IO.File]::Exists($file)) { [ordered]@{name=$_;sha256=Get-Sha256 $file} } })
    $keyInput = [ordered]@{ schemaVersion=1; platform='x86'; target='exe'; optimize=$true; debug=$false; compiler=$compilerInputs; sources=$sourceInputs; references=@($referenceInputs.ToArray()) }
    $keyBytes = [Text.Encoding]::UTF8.GetBytes(($keyInput | ConvertTo-Json -Depth 12 -Compress))
    $cacheKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($keyBytes)).ToLowerInvariant()
    $cacheRoot = if ($request.ContainsKey('cacheRoot') -and $request.cacheRoot) { $request.cacheRoot } elseif ($env:VS2015_MCP_IDE_CACHE_ROOT) { $env:VS2015_MCP_IDE_CACHE_ROOT } else { Join-Path $env:LOCALAPPDATA 'VS2015Mcp/Cache/IdeBridge' }
    $cacheRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($cacheRoot))
    $null = [IO.Directory]::CreateDirectory($cacheRoot)
    $output = Join-Path $cacheRoot $cacheKey
    $expectedNames = @('Vs2015.IdeBridge.exe') + @($references | ForEach-Object { [IO.Path]::GetFileName($_) })
    $lockTimeout = if ($request.ContainsKey('cacheLockTimeoutMs')) { $request.cacheLockTimeoutMs } else { 90000 }
    if ($lockTimeout -isnot [int] -and $lockTimeout -isnot [long]) { throw 'cacheLockTimeoutMs must be an integer.' }
    if ($lockTimeout -lt 1 -or $lockTimeout -gt 600000) { throw 'cacheLockTimeoutMs is outside 1..600000.' }
    $lockIdentity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($cacheRoot.ToUpperInvariant()+'|'+$cacheKey)))
    $lease = [Threading.Mutex]::new($false, ('Local\VS2015Mcp_IdeCache_'+$lockIdentity))
    try { $locked = $lease.WaitOne([int]$lockTimeout) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (-not $locked) { Fail 'IDE_CACHE_BUSY' 'Another process is still compiling this IDE bridge cache key.' }
    $cacheHit = [IO.Directory]::Exists($output)
    if ($cacheHit) { $manifest = Test-CachedBuild $output $cacheKey $expectedNames }
    else {
        if ([IO.File]::Exists($output)) { Fail 'IDE_CACHE_INTEGRITY_FAILED' "The cache key path is a file: $output" }
        $staging = Join-Path $cacheRoot ('.pending-'+$cacheKey+'-'+[guid]::NewGuid().ToString('N'))
        $null = [IO.Directory]::CreateDirectory($staging)
        foreach ($reference in $references) { [IO.File]::Copy($reference, (Join-Path $staging ([IO.Path]::GetFileName($reference))), $false) }
        $executable = Join-Path $staging 'Vs2015.IdeBridge.exe'
        $arguments = @('/nologo', '/target:exe', '/platform:x86', '/optimize+', '/debug-', '/utf8output', "/out:$executable")
        foreach ($reference in $references) { $arguments += '/reference:' + (Join-Path $staging ([IO.Path]::GetFileName($reference))) }
        foreach ($name in $frameworkNames) { $arguments += '/reference:' + (Join-Path $compilerDirectory $name) }
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
        # Publish only when the bytes used to compute the key remain unchanged.
        foreach ($source in $sourceInputs) { if ((Get-Sha256 (Join-Path $sourceDirectory $source.name)) -cne $source.sha256) { Fail 'IDE_SOURCE_CHANGED' 'IDE sources changed during compilation; retry after the edit completes.' } }
        $sourceNamesNow = @(Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.cs' -File | Select-Object -ExpandProperty Name)
        if ($sourceNamesNow.Count -ne $sourceInputs.Count -or @($sourceInputs | Where-Object { $_.name -cnotin $sourceNamesNow }).Count) { Fail 'IDE_SOURCE_CHANGED' 'IDE source files changed during compilation; retry after the edit completes.' }
        foreach ($reference in $referenceInputs) { if ((Get-Sha256 (Join-Path $staging $reference.name)) -cne $reference.sha256) { Fail 'IDE_REFERENCE_CHANGED' 'An interop assembly changed while preparing the build.' } }
        foreach ($inputFile in $compilerInputs) { if ((Get-Sha256 (Join-Path $compilerDirectory $inputFile.name)) -cne $inputFile.sha256) { Fail 'IDE_COMPILER_CHANGED' 'The Framework compiler or reference files changed during compilation.' } }
        $artifacts = @($expectedNames | ForEach-Object { $file=Join-Path $staging $_; [ordered]@{name=$_;bytes=([IO.FileInfo]::new($file)).Length;sha256=Get-Sha256 $file} })
        $manifest = [ordered]@{schemaVersion=1;cacheKey=$cacheKey;createdAtUtc=[DateTimeOffset]::UtcNow.ToString('o');inputs=$keyInput;artifacts=$artifacts}
        [IO.File]::WriteAllText((Join-Path $staging 'build-manifest.json'), ($manifest | ConvertTo-Json -Depth 14), [Text.UTF8Encoding]::new($false))
        $prefix = $cacheRoot + [IO.Path]::DirectorySeparatorChar
        if (-not $staging.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or -not $output.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Cache publication escaped its root.' }
        [IO.Directory]::Move($staging,$output)
        $manifest = Test-CachedBuild $output $cacheKey $expectedNames
    }
    $result = @{ executablePath=(Join-Path $output 'Vs2015.IdeBridge.exe'); references=@($references.ToArray()); vsRoot=$root; cacheRoot=$cacheRoot; cacheKey=$cacheKey; cacheHit=$cacheHit; manifestPath=(Join-Path $output 'build-manifest.json') }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
} catch {
    $code = if ($_.Exception.Data.Contains('code')) { [string]$_.Exception.Data['code'] } else { 'IDE_BRIDGE_BUILD_FAILED' }
    [Console]::Out.WriteLine((@{ error=@{ code=$code; message=$_.Exception.Message } } | ConvertTo-Json -Compress))
    exit 1
} finally {
    if ($lease) { if ($locked) { $lease.ReleaseMutex() }; $lease.Dispose() }
}

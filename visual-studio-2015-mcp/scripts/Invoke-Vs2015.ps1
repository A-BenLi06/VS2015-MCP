#requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

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

function Read-RegistryValue([string]$Path, [string]$Name) {
    try { return Get-ItemPropertyValue -LiteralPath $Path -Name $Name -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return $null }
    catch [System.Management.Automation.PSArgumentException] { return $null }
}

function Get-Installation([string]$ExplicitRoot) {
    $candidates = [Collections.Generic.List[object]]::new()
    if ($ExplicitRoot) {
        $candidates.Add(@{ path = $ExplicitRoot; source = 'explicit' })
    } else {
        foreach ($hive in @('HKLM:/SOFTWARE/WOW6432Node/Microsoft', 'HKLM:/SOFTWARE/Microsoft', 'HKCU:/SOFTWARE/Microsoft')) {
            $setup = Read-RegistryValue "$hive/VisualStudio/14.0/Setup/VS" 'ProductDir'
            if ($setup) { $candidates.Add(@{ path = $setup; source = "$hive/VisualStudio/14.0/Setup/VS" }) }
            $sxs = Read-RegistryValue "$hive/VisualStudio/SxS/VS7" '14.0'
            if ($sxs) { $candidates.Add(@{ path = $sxs; source = "$hive/VisualStudio/SxS/VS7" }) }
        }
        if ($env:VS140COMNTOOLS) { $candidates.Add(@{ path = (Join-Path $env:VS140COMNTOOLS '../..'); source = 'VS140COMNTOOLS' }) }
        foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
            if ($base) { $candidates.Add(@{ path = (Join-Path $base 'Microsoft Visual Studio 14.0'); source = 'known-folder' }) }
        }
    }
    foreach ($candidate in $candidates) {
        $root = [IO.Path]::GetFullPath([string]$candidate.path).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $marker = Join-Path $root 'Common7/IDE/devenv.exe'
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { $marker = Join-Path $root 'Common7/IDE/msenv.dll' }
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
            $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($marker)
            if ($version.FileMajorPart -eq 14) { return [ordered]@{ root = $root; source = $candidate.source; version = $version.FileVersion } }
        }
    }
    if ($ExplicitRoot) { throw "The explicit root is not a verified Visual Studio 2015 installation: $ExplicitRoot" }
    throw 'Visual Studio 2015 was not found through registry, VS140COMNTOOLS, or known installation folders. Supply vsRoot explicitly.'
}

function Get-DeveloperEnvironment($Installation, [string]$Architecture, [string]$SdkVersion, [bool]$Store, [int]$SetupTimeoutMs) {
    $setup = Join-Path $Installation.root 'VC/vcvarsall.bat'
    $setupArgument = $Architecture
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
        if ($Architecture -ne 'x86' -or $SdkVersion -or $Store) { throw 'vcvarsall.bat is required for non-x86 architecture or an explicit SDK/Store environment.' }
        $setup = Join-Path $Installation.root 'Common7/Tools/VsDevCmd.bat'
        $setupArgument = ''
    }
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'No VS2015 developer environment batch file is installed.' }
    # CALL performs a second expansion. Reject CMD metacharacters in the setup
    # path instead of accidentally executing or expanding a user-selected root.
    if ($setup -match '[%!^"&|<>\r\n]') {
        throw 'The VS setup path contains CMD expansion characters that cannot be safely passed to CALL.'
    }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $environment[$entry.Key] = [string]$entry.Value }
    $environment['VS2015_MCP_SETUP_SCRIPT'] = $setup
    $environment['VS2015_MCP_ARCH'] = $setupArgument
    $environment['VS2015_MCP_SDK'] = $SdkVersion
    $environment['VS2015_MCP_STORE'] = $(if ($Store) { 'store' } else { '' })
    $marker = '__VS2015_MCP_ENV_' + [Guid]::NewGuid().ToString('N') + '__'
    $wrapper = Join-Path ([IO.Path]::GetTempPath()) ('vs2015-mcp-' + [Guid]::NewGuid().ToString('N') + '.cmd')
    [IO.File]::WriteAllText($wrapper, "@echo off`r`ncall `"%VS2015_MCP_SETUP_SCRIPT%`" %VS2015_MCP_ARCH% %VS2015_MCP_STORE% %VS2015_MCP_SDK%`r`nif errorlevel 1 exit /b %errorlevel%`r`necho $marker`r`nset`r`n", [Text.Encoding]::ASCII)
    try {
        $environment['VS2015_MCP_ENV_WRAPPER'] = $wrapper
        $cmd = Join-Path $env:SystemRoot 'System32/cmd.exe'
        # CMD has its own quote grammar; the only raw command line is this
        # constant bootstrap. Native tool arguments always use ArgumentList.
        $result = Invoke-CapturedProcess -Executable $cmd -Arguments @() -InternalCommandLine '/d /u /s /c ""%VS2015_MCP_ENV_WRAPPER%""' -Directory $Installation.root -Environment $environment -Encoding ([Text.Encoding]::Unicode) -TimeoutMs $SetupTimeoutMs -Limit 1048576
        if ($result.timedOut -or $result.exitCode -ne 0) { throw "Developer environment setup failed (exit $($result.exitCode), timeout $($result.timedOut)). Run the installation's vcvarsall.bat manually for setup diagnostics." }
        if ($result.truncated.stdout) { throw 'Developer environment exceeds the capture limit.' }
        $lines = $result.stdout -split '\r?\n'
        $start = [Array]::IndexOf($lines, $marker)
        if ($start -lt 0) { throw 'Developer environment output marker was not found.' }
        $captured = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        for ($i = $start + 1; $i -lt $lines.Length; $i++) {
            $separator = $lines[$i].IndexOf('=')
            if ($separator -gt 0) { $captured[$lines[$i].Substring(0, $separator)] = $lines[$i].Substring($separator + 1) }
        }
        foreach ($key in @('VS2015_MCP_SETUP_SCRIPT', 'VS2015_MCP_ARCH', 'VS2015_MCP_ENV_WRAPPER', 'VS2015_MCP_SDK', 'VS2015_MCP_STORE')) { $null = $captured.Remove($key) }
        if (-not $captured.ContainsKey('VSINSTALLDIR') -or [IO.Path]::GetFullPath($captured['VSINSTALLDIR']).TrimEnd('\') -ne $Installation.root) {
            throw 'Developer setup did not select the requested VS2015 installation. Its registry configuration may refer to another root.'
        }
        if ($SdkVersion) {
            if (-not $captured.ContainsKey('WindowsSdkDir') -or -not $captured['WindowsSdkDir']) { throw 'The requested Windows SDK was not configured.' }
            $headerDirectory = if ($SdkVersion -eq '8.1') { Join-Path $captured['WindowsSdkDir'] 'include/um' } else { Join-Path $captured['WindowsSdkDir'] "include/$SdkVersion/um" }
            if (-not (Test-Path -LiteralPath (Join-Path $headerDirectory 'Windows.h') -PathType Leaf)) { throw "The requested Windows SDK headers are missing: $SdkVersion" }
            if ($SdkVersion -ne '8.1' -and (-not $captured.ContainsKey('WindowsSDKVersion') -or $captured['WindowsSDKVersion'].TrimEnd('\') -ne $SdkVersion)) { throw 'Developer setup selected a different Windows SDK version.' }
            if ($SdkVersion -eq '8.1' -and (-not $captured.ContainsKey('WindowsSDKLibVersion') -or $captured['WindowsSDKLibVersion'].TrimEnd('\') -ne 'winv6.3')) { throw 'Developer setup did not select Windows SDK 8.1 libraries.' }
        }
        return ,$captured
    } finally { Remove-Item -LiteralPath $wrapper -Force -ErrorAction SilentlyContinue }
}

function Add-Tool($Map, [string]$Name, [string]$Path, [int]$Major = -1) {
    if ($Map.Contains($Name) -or -not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    if ($Major -ge 0 -and $version.FileMajorPart -ne $Major) { return }
    $Map[$Name] = [ordered]@{ path = [IO.Path]::GetFullPath($Path); version = $version.FileVersion }
}

function Find-ToolOnPath([string]$FileName, $Environment) {
    if ($null -eq $Environment -or -not $Environment.ContainsKey('PATH')) { return $null }
    foreach ($directory in ($Environment['PATH'] -split ';')) {
        if (-not [string]::IsNullOrWhiteSpace($directory)) {
            $path = Join-Path $directory.Trim('"') $FileName
            if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
        }
    }
    return $null
}

function Get-Tools($Installation, $Environment, [string]$Architecture) {
    $map = [ordered]@{}
    Add-Tool $map 'devenv' (Join-Path $Installation.root 'Common7/IDE/devenv.com') 14
    Add-Tool $map 'vstest' (Join-Path $Installation.root 'Common7/IDE/CommonExtensions/Microsoft/TestWindow/vstest.console.exe') 14
    Add-Tool $map 'mstest' (Join-Path $Installation.root 'Common7/IDE/MSTest.exe') 14
    foreach ($item in @(
        @{ key = 'HKLM:/SOFTWARE/WOW6432Node/Microsoft/MSBuild/ToolsVersions/14.0'; name = 'msbuild' },
        @{ key = 'HKLM:/SOFTWARE/Microsoft/MSBuild/ToolsVersions/14.0'; name = 'msbuild64' }
    )) {
        $directory = Read-RegistryValue $item.key 'MSBuildToolsPath'
        if ($directory) { Add-Tool $map $item.name (Join-Path $directory 'MSBuild.exe') 14 }
    }
    $fromPath = Find-ToolOnPath 'MSBuild.exe' $Environment
    if ($fromPath) {
        if ((Split-Path (Split-Path $fromPath) -Leaf) -eq 'amd64') { Add-Tool $map 'msbuild64' $fromPath 14 }
        else { Add-Tool $map 'msbuild' $fromPath 14 }
    }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if ($base) {
            Add-Tool $map 'msbuild' (Join-Path $base 'MSBuild/14.0/Bin/MSBuild.exe') 14
            Add-Tool $map 'msbuild64' (Join-Path $base 'MSBuild/14.0/Bin/amd64/MSBuild.exe') 14
        }
    }
    $nativeDirectory = switch ($Architecture) {
        'x86' { 'VC/bin' }
        'x86_amd64' { 'VC/bin/x86_amd64' }
        'x86_arm' { 'VC/bin/x86_arm' }
        'amd64' { 'VC/bin/amd64' }
        'amd64_x86' { 'VC/bin/amd64_x86' }
        'amd64_arm' { 'VC/bin/amd64_arm' }
    }
    foreach ($name in @('cl', 'link', 'lib', 'dumpbin', 'nmake')) {
        Add-Tool $map $name (Join-Path $Installation.root "$nativeDirectory/$name.exe")
    }
    # SDK tools may be shared installations. Resolve only inside the SDK roots
    # selected by the VS2015 developer environment, never arbitrary PATH tools.
    foreach ($name in @('rc', 'mt', 'makeappx', 'signtool')) {
        $path = Find-ToolOnPath "$name.exe" $Environment
        if ($path -and $Environment) {
            foreach ($key in @('WindowsSdkDir', 'WindowsSdkDir_81', 'WindowsSdkDir_10')) {
                if ($Environment.ContainsKey($key) -and $Environment[$key]) {
                    $prefix = [IO.Path]::GetFullPath($Environment[$key]).TrimEnd('\') + '\'
                    if ($path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { Add-Tool $map $name $path }
                }
            }
        }
    }
    Add-Tool $map 'nuget' (Join-Path $Installation.root 'Common7/IDE/CommonExtensions/Microsoft/NuGet/NuGet.exe')
    return $map
}

try {
    if (-not $IsWindows) { throw 'The Visual Studio 2015 backend requires Windows and PowerShell 7.' }
    $text = [Console]::In.ReadToEnd()
    if ($text.Length -gt 2097152) { throw 'Request exceeds the 2 MiB limit.' }
    $request = ConvertFrom-Json -InputObject $text -AsHashtable
    if ($request -isnot [Collections.IDictionary]) { throw 'Request must be a JSON object.' }
    $operation = Get-Value $request 'operation'
    if ($operation -notin @('discover', 'run')) { throw 'operation must be discover or run.' }
    $architecture = Get-Value $request 'architecture' 'x86'
    if ($architecture -notin @('x86', 'amd64', 'x86_amd64', 'x86_arm', 'amd64_x86', 'amd64_arm')) { throw 'Unsupported VS2015 architecture.' }
    $sdkVersion = Get-Value $request 'sdkVersion' ''
    if ($sdkVersion -and $sdkVersion -notmatch '^(8\.1|10\.\d+\.\d+\.\d+)$') { throw 'sdkVersion must be 8.1 or a full Windows 10 SDK version.' }
    $storeEnvironment = Get-Value $request 'store' $false
    if ($storeEnvironment -isnot [bool]) { throw 'store must be a boolean.' }
    $setupTimeout = Get-Value $request 'setupTimeoutMs' 60000
    if ($setupTimeout -isnot [ValueType] -or $setupTimeout -lt 1000 -or $setupTimeout -gt 300000) { throw 'setupTimeoutMs must be between 1000 and 300000.' }
    $installation = Get-Installation (Get-Value $request 'vsRoot')
    $warnings = [Collections.Generic.List[string]]::new()
    $environment = $null
    try { $environment = Get-DeveloperEnvironment $installation $architecture $sdkVersion $storeEnvironment $setupTimeout }
    catch { $warnings.Add($_.Exception.Message) }
    $tools = Get-Tools $installation $environment $architecture
    if ($operation -eq 'discover') {
        $response = [ordered]@{
            installation = $installation; architecture = $architecture; sdkVersion = $sdkVersion; store = $storeEnvironment; tools = $tools
            capabilities = [ordered]@{ developerEnvironment = ($null -ne $environment); availableTools = @($tools.Keys) }
            warnings = @($warnings.ToArray())
        }
    } else {
        $tool = Get-Value $request 'tool'
        if (-not $tool -or -not $tools.Contains($tool)) { throw "Tool is not available in the selected installation: $tool" }
        if ($null -eq $environment) { throw "Developer environment is unavailable: $($warnings -join '; ')" }
        $arguments = Get-Value $request 'arguments' @()
        if ($arguments -isnot [Array]) { throw 'arguments must be an array of strings.' }
        foreach ($argument in $arguments) {
            if ($argument -isnot [string] -or $argument.Contains([char]0)) { throw 'Each argument must be a string without NUL.' }
        }
        $directory = [IO.Path]::GetFullPath((Get-Value $request 'workingDirectory' (Get-Location).Path))
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'workingDirectory must be an existing directory.' }
        $timeout = Get-Value $request 'timeoutMs' 120000
        $limit = Get-Value $request 'maxOutputChars' 64000
        if ($timeout -isnot [ValueType] -or $timeout -lt 100 -or $timeout -gt 3600000) { throw 'timeoutMs must be between 100 and 3600000.' }
        if ($limit -isnot [ValueType] -or $limit -lt 256 -or $limit -gt 1048576) { throw 'maxOutputChars must be between 256 and 1048576.' }
        [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
        $encodingName = Get-Value $request 'encoding'
        $encoding = if ($encodingName) { [Text.Encoding]::GetEncoding([string]$encodingName) } else { [Text.Encoding]::GetEncoding([int][Vs2015Capture]::GetOEMCP()) }
        $dryRun = Get-Value $request 'dryRun' $false
        if ($dryRun -isnot [bool]) { throw 'dryRun must be a boolean.' }
        if ($dryRun) {
            $response = [ordered]@{
                dryRun = $true; executable = $tools[$tool].path; arguments = @($arguments)
                workingDirectory = $directory; architecture = $architecture; sdkVersion = $sdkVersion; store = $storeEnvironment
                timeoutMs = $timeout; maxOutputChars = $limit; encoding = $encoding.WebName
            }
        } else {
            $response = Invoke-CapturedProcess -Executable $tools[$tool].path -Arguments $arguments -Directory $directory -Environment $environment -TimeoutMs $timeout -Limit $limit -Encoding $encoding
            $response['architecture'] = $architecture
            $response['sdkVersion'] = $sdkVersion
            $response['store'] = $storeEnvironment
            $response['encoding'] = $encoding.WebName
        }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 20 -Compress))
} catch {
    [Console]::Out.WriteLine((@{ error = @{ code = 'VS2015_BACKEND_ERROR'; message = $_.Exception.Message } } | ConvertTo-Json -Depth 5 -Compress))
    exit 1
}

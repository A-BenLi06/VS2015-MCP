#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSScriptRoot 'NativeProcess.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'WindowsPaths.psm1')

function Get-PeArchitecture([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { return 'unknown' }
        $stream.Position = 0x3c
        $offset = $reader.ReadInt32()
        if ($offset -lt 0 -or $offset -gt ($stream.Length - 6)) { return 'unknown' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550) { return 'unknown' }
        switch ($reader.ReadUInt16()) { 0x14c { return 'x86' }; 0x8664 { return 'x64' }; 0xaa64 { return 'arm64' }; default { return 'unknown' } }
    } finally { $reader.Dispose() }
}

function Add-Candidate($List, [string]$Name, [string]$Path, [string]$Source, [bool]$UiOnly = $false) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.File]::Exists($Path)) { return }
    $full = [IO.Path]::GetFullPath($Path)
    if (@($List | Where-Object { $_.path -ieq $full }).Count -gt 0) { return }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($full)
    $List.Add([ordered]@{ name = $Name; path = $full; architecture = Get-PeArchitecture $full
        version = $version.FileVersion; source = $Source; uiOnly = $UiOnly })
}

function Get-RegistryValues([string]$Key, [string[]]$Names) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
        $opened = $null
        try {
            $opened = $base.OpenSubKey($Key)
            if ($null -ne $opened) {
                foreach ($name in $Names) { $value = $opened.GetValue($name); if ($value -is [string] -and $value) { $value } }
            }
        } finally { if ($opened) { $opened.Dispose() }; $base.Dispose() }
    }
}

function Get-DebugTools($Request) {
    $tools = [Collections.Generic.List[object]]::new()
    $roots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($root in @(Get-RegistryValues 'SOFTWARE\Microsoft\Windows Kits\Installed Roots' @('KitsRoot', 'KitsRoot81', 'KitsRoot10'))) {
        $null = $roots.Add($root)
    }
    foreach ($programs in @(Get-WindowsProgramDirectoryPaths)) {
        if ($programs) { foreach ($kit in @('8.0', '8.1', '10')) { $null = $roots.Add((Join-Path $programs "Windows Kits/$kit")) } }
    }
    $explicitRoot = Get-Value $Request 'debuggerRoot'
    if ($explicitRoot) {
        if (-not [IO.Directory]::Exists($explicitRoot)) { throw 'debuggerRoot does not exist.' }
        $found = $false
        foreach ($relative in @('cdb.exe', 'x86/cdb.exe', 'x64/cdb.exe', 'Debuggers/x86/cdb.exe', 'Debuggers/x64/cdb.exe')) {
            $candidate = Join-Path $explicitRoot $relative
            if ([IO.File]::Exists($candidate)) { Add-Candidate $tools 'cdb' $candidate 'explicit-root'; $found = $true }
        }
        if (-not $found) { throw 'debuggerRoot contains no cdb.exe in the root, architecture folders or Debuggers folders.' }
    } else {
        foreach ($root in $roots) {
            foreach ($architecture in @('x86', 'x64')) {
                foreach ($name in @('cdb', 'windbg')) {
                    Add-Candidate $tools $name (Join-Path $root "Debuggers/$architecture/$name.exe") 'windows-kit' ($name -eq 'windbg')
                }
            }
        }
        foreach ($name in @('cdb', 'windbg', 'mdbg')) {
            foreach ($command in @(Get-Command "$name.exe" -CommandType Application -All -ErrorAction SilentlyContinue)) {
                Add-Candidate $tools $name $command.Source 'path' ($name -eq 'windbg')
            }
        }
    }

    $vsRoots = [Collections.Generic.List[string]]::new()
    $explicitVs = Get-Value $Request 'vsRoot'
    if ($explicitVs) { $vsRoots.Add($explicitVs) }
    else {
        if ($env:VS140COMNTOOLS) { $vsRoots.Add([IO.Path]::GetFullPath((Join-Path $env:VS140COMNTOOLS '../..'))) }
        foreach ($root in @(Get-RegistryValues 'SOFTWARE\Microsoft\VisualStudio\SxS\VS7' @('14.0'))) { $vsRoots.Add($root) }
        foreach ($root in @(Get-RegistryValues 'SOFTWARE\Microsoft\VisualStudio\14.0\Setup\VS' @('ProductDir'))) { $vsRoots.Add($root) }
        foreach ($programs in @(Get-WindowsProgramDirectoryPaths)) { $vsRoots.Add((Join-Path $programs 'Microsoft Visual Studio 14.0')) }
    }
    foreach ($root in $vsRoots) {
        $devenv = Join-Path $root 'Common7/IDE/devenv.exe'
        if ([IO.File]::Exists($devenv) -and [Diagnostics.FileVersionInfo]::GetVersionInfo($devenv).FileMajorPart -eq 14) {
            Add-Candidate $tools 'devenv' $devenv 'vs2015' $true
            foreach ($arch in @('x86', 'x64')) { Add-Candidate $tools 'msvsmon' (Join-Path $root "Common7/IDE/Remote Debugger/$arch/msvsmon.exe") 'vs2015' $true }
            break
        }
        if ($explicitVs) { throw 'vsRoot is not a Visual Studio 2015 installation (devenv.exe 14.x required).' }
    }
    foreach ($system in @('System32', 'SysWOW64')) {
        Add-Candidate $tools 'vsjitdebugger' (Join-Path (Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::Windows)) "$system/vsjitdebugger.exe") 'windows-system' $true
    }
    $cdb = @($tools | Where-Object { $_.name -eq 'cdb' })
    return [ordered]@{
        tools = @($tools.ToArray())
        capabilities = [ordered]@{
            cdbBatchDiagnostics = $cdb.Count -gt 0
            ideExecutableHandoff = @($tools | Where-Object { $_.name -eq 'devenv' }).Count -gt 0
            interactiveBreakpoints = $false
            interactiveStepping = $false
            persistentSessions = $false
        }
        missing = @(if ($cdb.Count -eq 0) { 'Debugging Tools for Windows (cdb.exe) is not installed/discovered.' })
        notes = @('msvsmon is a remote-debugging listener, not a local CLI debugger. No listener is started.',
            'devenv /DebugExe and vsjitdebugger hand off to interactive Visual Studio; they do not provide CLI stack/step/breakpoint control.',
            'MDbg is managed-only and is reported when on PATH; this backend does not implement its interactive protocol.')
    }
}

function Resolve-File([string]$Value, [string]$Directory, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.IndexOf([char]0) -ge 0) { throw "$Label is required." }
    $path = [IO.Path]::GetFullPath($Value, $Directory)
    if (-not [IO.File]::Exists($path)) { throw "$Label does not exist: $path" }
    return $path
}

function Invoke-DebugRequest($Request) {
    $operation = Get-Value $Request 'operation' 'discover'
    if ($operation -notin @('discover', 'dump', 'snapshot', 'launchSnapshot', 'ideLaunch')) { throw 'Unsupported debug operation.' }
    $inventory = Get-DebugTools $Request
    if ($operation -eq 'discover') { return $inventory }
    $directory = [IO.Path]::GetFullPath([string](Get-Value $Request 'workingDirectory' ([Environment]::CurrentDirectory)))
    if (-not [IO.Directory]::Exists($directory)) { throw 'workingDirectory does not exist.' }
    $dryRun = Get-Value $Request 'dryRun' $false
    if ($dryRun -isnot [bool]) { throw 'dryRun must be a boolean.' }

    if ($operation -eq 'ideLaunch') {
        $target = Resolve-File (Get-Value $Request 'executable') $directory 'executable'
        if ([IO.Path]::GetExtension($target) -ine '.exe') { throw 'IDE handoff requires an .exe file.' }
        $ideArguments = Get-Value $Request 'arguments' @()
        if ($ideArguments.Count -gt 0) { throw 'IDE handoff supports the executable path only. Configure application arguments in Visual Studio.' }
        $ide = @($inventory.tools | Where-Object { $_.name -eq 'devenv' } | Select-Object -First 1)
        if ($ide.Count -eq 0) { throw 'Visual Studio 2015 devenv.exe was not found.' }
        $plan = [ordered]@{ operation = $operation; executable = $ide[0].path; arguments = @('/DebugExe', $target)
            workingDirectory = $directory; dryRun = $dryRun; interactive = $true; debugSessionConfirmed = $false
            note = 'Opens the executable in the VS2015 interactive debugger. No breakpoint or stepping control is exposed by this handoff.' }
        if (-not $dryRun) {
            $start = [Diagnostics.ProcessStartInfo]::new()
            # This explicit UI handoff must not keep the bridge's redirected pipes open.
            $start.FileName = $plan.executable; $start.UseShellExecute = $true
            $start.WorkingDirectory = $directory
            foreach ($argument in $plan.arguments) { $start.ArgumentList.Add($argument) }
            $process = [Diagnostics.Process]::Start($start)
            try { $plan.processId = $process.Id; $plan.launched = $true } finally { $process.Dispose() }
        }
        return $plan
    }

    $architecture = Get-Value $Request 'architecture' $(if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' })
    if ($architecture -notin @('x86', 'x64')) { throw 'architecture must be x86 or x64.' }
    $runtime = Get-Value $Request 'managedRuntime' 'none'
    if ($runtime -notin @('none', 'clr', 'mscorwks')) { throw 'managedRuntime must be none, clr (.NET Framework 4) or mscorwks (.NET Framework 2/3.5).' }
    $heapSummary = Get-Value $Request 'heapSummary' $false
    if ($heapSummary -isnot [bool]) { throw 'heapSummary must be a boolean.' }
    if ($heapSummary -and ($operation -ne 'dump' -or $runtime -eq 'none')) { throw 'heapSummary requires an offline dump and an explicit managedRuntime.' }
    $candidate = @($inventory.tools | Where-Object { $_.name -eq 'cdb' -and $_.architecture -eq $architecture } |
        Sort-Object -Property @{ Expression = { [version](($_.version -split ' ')[0]) }; Descending = $true } | Select-Object -First 1)
    $cdbPath = if ($candidate.Count) { $candidate[0].path } else { $null }
    $nativeArguments = [Collections.Generic.List[string]]::new()
    foreach ($flag in @('-noshell', '-noinh', '-sins', '-lines')) { $nativeArguments.Add($flag) }
    foreach ($mapping in @(@('symbolPath', '-y'), @('imagePath', '-i'), @('sourcePath', '-srcpath'))) {
        $value = Get-Value $Request $mapping[0]
        if ($null -ne $value) {
            if ($value -isnot [string] -or $value.IndexOf([char]0) -ge 0) { throw "$($mapping[0]) must be a string without NUL." }
            $nativeArguments.Add($mapping[1]); $nativeArguments.Add($value)
        }
    }
    $marker = 'VS2015_MCP_END_' + [guid]::NewGuid().ToString('N')
    $commands = [Collections.Generic.List[string]]::new()
    $commands.Add('.lastevent')
    if ($operation -eq 'dump') {
        $target = Resolve-File (Get-Value $Request 'dumpPath') $directory 'dumpPath'
        $nativeArguments.Add('-z'); $nativeArguments.Add($target)
        foreach ($command in @('.exr -1', '.ecxr', '~* kb', 'lm', '!analyze -v')) { $commands.Add($command) }
    } elseif ($operation -eq 'snapshot') {
        $processId = Get-Value $Request 'processId'
        if ($processId -isnot [ValueType] -or $processId -lt 1 -or $processId -gt [int]::MaxValue -or [math]::Floor($processId) -ne $processId) { throw 'processId must be a positive integer.' }
        $targetProcess = [Diagnostics.Process]::GetProcessById([int]$processId)
        $targetProcess.Dispose()
        # Noninvasive -pvr does not acquire a debug port. Detach-on-exit is
        # unnecessary here and current CDB rejects -pd before target access.
        foreach ($part in @('-pvr', '-p', [string]$processId)) { $nativeArguments.Add($part) }
        foreach ($command in @('~* kb', 'lm', '!runaway')) { $commands.Add($command) }
    } else {
        $target = Resolve-File (Get-Value $Request 'executable') $directory 'executable'
        if ([IO.Path]::GetExtension($target) -ine '.exe') { throw 'launchSnapshot requires an .exe file.' }
        if ($runtime -ne 'none') { throw 'The initial loader breakpoint precedes CLR startup; managedRuntime is not supported for launchSnapshot.' }
        foreach ($command in @('r', '~* kb', 'lm')) { $commands.Add($command) }
    }
    if ($runtime -ne 'none') {
        foreach ($command in @(".loadby sos $runtime", '!threads', '~*e !clrstack', '!pe')) { $commands.Add($command) }
    }
    if ($heapSummary) {
        foreach ($command in @('!eeheap -gc', '!dumpheap -stat')) { $commands.Add($command) }
    }
    $commands.Add(".echo $marker")
    $commands.Add($(if ($operation -eq 'snapshot') { 'qd' } else { 'q' }))
    $nativeArguments.Add('-c'); $nativeArguments.Add(($commands -join ';'))
    if ($operation -eq 'launchSnapshot') {
        $nativeArguments.Add($target)
        $programArguments = Get-Value $Request 'arguments' @()
        if ($programArguments -isnot [array] -or $programArguments.Count -gt 512) { throw 'arguments must be an array with at most 512 items.' }
        foreach ($argument in $programArguments) {
            if ($argument -isnot [string] -or $argument.IndexOf([char]0) -ge 0) { throw 'Each program argument must be a string without NUL.' }
            $nativeArguments.Add($argument)
        }
    }
    $plan = [ordered]@{ operation = $operation; executable = $cdbPath; arguments = @($nativeArguments.ToArray())
        architecture = $architecture; available = $null -ne $cdbPath; dryRun = $dryRun; commands = @($commands.ToArray())
        inheritedSymbolPathsIgnored = $true; startupScript = 'An empty temporary -cf script overrides implicit ntsd.ini.'
        snapshotConsistency = $(if ($operation -eq 'snapshot') { 'Noninvasive, threads remain running; registers and stacks may be inconsistent.' } else { 'Recorded dump or initial debugger breakpoint.' })
        targetLifecycle = $(if ($operation -eq 'launchSnapshot') { 'Launches a new target, captures its initial loader breakpoint, then terminates it. Does not run to Main or step source.' } elseif ($operation -eq 'snapshot') { 'Existing target remains running; no breakpoints or stepping.' } else { 'Offline dump only.' })
        note = 'Debugger command errors and missing symbols/DAC remain in the transcript. A zero exit status does not prove every requested diagnostic succeeded.' }
    if ($dryRun) { return $plan }
    if (-not $cdbPath) { throw "CDB_NOT_FOUND: No $architecture cdb.exe discovered. Install Debugging Tools for Windows separately or provide debuggerRoot." }
    $timeout = Get-Value $Request 'timeoutMs' 120000
    $limit = Get-Value $Request 'maxOutputChars' 128000
    if ($timeout -isnot [ValueType] -or $timeout -lt 100 -or $timeout -gt 3600000) { throw 'timeoutMs must be 100..3600000.' }
    if ($limit -isnot [ValueType] -or $limit -lt 256 -or $limit -gt 1048576) { throw 'maxOutputChars must be 256..1048576.' }
    $encodingName = Get-Value $Request 'encoding'
    $encoding = if ($encodingName) { [Text.Encoding]::GetEncoding([string]$encodingName) } else { [Text.Encoding]::GetEncoding([int][Vs2015Capture]::GetOEMCP()) }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $scratch = [IO.Path]::GetFullPath((Join-Path $tempRoot ('vs2015-cdb-' + [guid]::NewGuid().ToString('N'))))
    $null = [IO.Directory]::CreateDirectory($scratch)
    try {
        $initFile = Join-Path $scratch 'empty.ini'
        [IO.File]::WriteAllText($initFile, '', [Text.UTF8Encoding]::new($false))
        $allArgs = @('-cf', $initFile) + @($nativeArguments.ToArray())
        $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $environment[[string]$entry.Key] = [string]$entry.Value }
        $environment['INIT'] = $scratch
        $result = Invoke-CapturedProcess -Executable $cdbPath -Arguments $allArgs -Directory $directory -Environment $environment -TimeoutMs $timeout -Limit $limit -Encoding $encoding
        $result.operation = $operation
        $result.commands = @($commands.ToArray())
        $result.snapshotConsistency = $plan.snapshotConsistency
        $result.targetLifecycle = $plan.targetLifecycle
        $result.note = $plan.note
        $result.reportCompletion = if ($result.timedOut) { 'timed-out' } elseif ($result.truncated.stdout) { 'unknown-output-truncated' } elseif ($result.stdout -match "(?m)^$marker\r?`$") { 'completed' } else { 'not-confirmed' }
        return $result
    } finally {
        # The generated path is verified before any recursive cleanup.
        if ($scratch.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($scratch) -like 'vs2015-cdb-*')) {
            Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    if (-not $IsWindows) { throw 'The debugger backend requires Windows.' }
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    if ($request -isnot [Collections.IDictionary]) { throw 'Expected a JSON request object.' }
    $result = Invoke-DebugRequest $request
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
} catch {
    [Console]::Out.WriteLine((@{ error = @{ code = 'VS2015_DEBUG_ERROR'; message = $_.Exception.Message } } | ConvertTo-Json -Compress))
    exit 1
}

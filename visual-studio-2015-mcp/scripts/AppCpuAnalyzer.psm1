Import-Module (Join-Path $PSScriptRoot 'NativeProcess.psm1')
Import-Module (Join-Path $PSScriptRoot 'WindowsPaths.psm1')

function Build-AppCpuAnalyzer([string]$PerfView, [string]$Directory, [int]$TimeoutMs) {
    $windows = Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::Windows)
    $framework = Join-Path $windows 'Microsoft.NET/Framework64/v4.0.30319'
    $compiler = Join-Path $framework 'csc.exe'
    $http = Get-ChildItem -LiteralPath (Join-Path $windows 'Microsoft.NET/assembly/GAC_MSIL/System.Net.Http') -Filter 'System.Net.Http.dll' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $http) { throw 'The .NET Framework System.Net.Http assembly is unavailable.' }
    $runtimeReferences = @((Join-Path $framework 'netstandard.dll'), (Join-Path $framework 'System.Web.Extensions.dll'), $http.FullName)
    if (-not [IO.File]::Exists($compiler) -or @($runtimeReferences | Where-Object { -not [IO.File]::Exists($_) }).Count) {
        throw 'App CPU analysis requires the x64 .NET Framework 4.8 compiler and runtime.'
    }
    $bundle = [Reflection.Assembly]::LoadFile($PerfView)
    foreach ($name in $bundle.GetManifestResourceNames()) {
        if ($name -cnotmatch '^\x2e\\(?:[A-Za-z0-9_.-]+\.dll|amd64\\msdia140\.dll)$') { continue }
        $target = Join-Path $Directory $name.Substring(2)
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        $inputStream = $bundle.GetManifestResourceStream($name)
        try {
            $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
    }
    $references = $runtimeReferences + @('Microsoft.Diagnostics.Tracing.TraceEvent.dll', 'Microsoft.Diagnostics.FastSerialization.dll' | ForEach-Object { Join-Path $Directory $_ })
    if (@($references | Where-Object { -not [IO.File]::Exists($_) }).Count) { throw 'This PerfView bundle does not expose the required TraceEvent libraries.' }
    $redirects = foreach ($dll in Get-ChildItem -LiteralPath $Directory -Filter '*.dll' -File) {
        $identity = [Reflection.AssemblyName]::GetAssemblyName($dll.FullName)
        $token = [Convert]::ToHexString($identity.GetPublicKeyToken()).ToLowerInvariant()
        if ($token) {
            $name = [Security.SecurityElement]::Escape($identity.Name)
            $version = $identity.Version
            "<dependentAssembly><assemblyIdentity name='$name' publicKeyToken='$token' culture='neutral'/><bindingRedirect oldVersion='0.0.0.0-$version' newVersion='$version'/></dependentAssembly>"
        }
    }
    $executable = Join-Path $Directory 'AppCpuAnalyzer.exe'
    $arguments = @('/nologo', '/platform:x64', '/utf8output', "/out:$executable") + @($references | ForEach-Object { "/reference:$_" }) + (Join-Path $PSScriptRoot 'AppCpuAnalyzer.cs')
    $build = Invoke-CapturedProcess -Executable $compiler -Arguments $arguments -Directory $Directory -TimeoutMs $TimeoutMs -Limit 16000 -Encoding ([Text.Encoding]::UTF8)
    if ($build.exitCode -ne 0 -or $build.timedOut) { throw ('App CPU analyzer compilation failed. ' + $build.stdout + $build.stderr) }
    [IO.File]::WriteAllText("$executable.config", "<configuration><runtime><assemblyBinding xmlns='urn:schemas-microsoft-com:asm.v1'>$($redirects -join '')</assemblyBinding></runtime></configuration>")
}

Export-ModuleMember -Function Build-AppCpuAnalyzer

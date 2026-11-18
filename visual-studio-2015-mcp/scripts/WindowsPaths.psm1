# Read OS-known installation directories without requiring inherited directory
# variables. Custom tool/root inputs remain the responsibility of each caller.
function Get-WindowsKnownFolderPath([Environment+SpecialFolder]$Folder,[switch]$AllowMissing) {
    $path=[Environment]::GetFolderPath($Folder)
    if([string]::IsNullOrWhiteSpace($path)) {
        if($AllowMissing){return $null}
        throw ('Windows did not expose the known folder: '+$Folder)
    }
    return [IO.Path]::GetFullPath($path)
}
function Get-WindowsNativeProgramDirectoryPath {
    if(-not [Environment]::Is64BitOperatingSystem -or [Environment]::Is64BitProcess){return Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::ProgramFiles)}
    # A32-bit process sees redirected ProgramFiles. Query the native registry
    # view instead of relying on optional ProgramW6432 inherited from a client.
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
    $key=$null
    try {
        $key=$base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion')
        $path=if($key){$key.GetValue('ProgramFilesDir')}else{$null}
        if($path -isnot [string] -or [string]::IsNullOrWhiteSpace($path)){throw 'Windows did not expose its native Program Files directory.'}
        return [IO.Path]::GetFullPath($path)
    }finally{if($key){$key.Dispose()};$base.Dispose()}
}
function Get-WindowsProgramDirectoryPaths {
    $seen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($path in @((Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::ProgramFilesX86) -AllowMissing),(Get-WindowsNativeProgramDirectoryPath))) {
        if($path -and $seen.Add($path)){$path}
    }
}
function Add-WindowsSetupEnvironmentDefaults([Collections.IDictionary]$Environment) {
    # Only the explicit child SDK-setup dictionary is changed. Native vendor
    # batch files consume these standard names; never overwrite a supplied
    # value or fabricate global environment state for the MCP host.
    $windows=Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::Windows)
    $defaults=@{
        windir=$windows;SystemRoot=$windows
        ProgramFiles=(Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::ProgramFiles))
        'ProgramFiles(x86)'=(Get-WindowsKnownFolderPath ([Environment+SpecialFolder]::ProgramFilesX86) -AllowMissing)
        ComSpec=(Join-Path $windows 'System32/cmd.exe')
    }
    if([Environment]::Is64BitOperatingSystem){$defaults.ProgramW6432=Get-WindowsNativeProgramDirectoryPath}
    foreach($name in $defaults.Keys) {
        if(-not $defaults[$name]){continue}
        $existing=$null
        foreach($key in $Environment.Keys){if([string]::Equals([string]$key,$name,[StringComparison]::OrdinalIgnoreCase)){$existing=$key;break}}
        if($null -eq $existing){$Environment[$name]=[string]$defaults[$name]}
        elseif([string]::IsNullOrWhiteSpace([string]$Environment[$existing])){$Environment[$existing]=[string]$defaults[$name]}
    }
}
Export-ModuleMember -Function Get-WindowsKnownFolderPath,Get-WindowsProgramDirectoryPaths,Add-WindowsSetupEnvironmentDefaults

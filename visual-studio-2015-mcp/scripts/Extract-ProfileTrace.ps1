#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Get-FullFileSystemPath([object]$Value, [string]$Label) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw "$Label must be a nonempty path string." }
    if (-not [IO.Path]::IsPathFullyQualified($Value)) { throw "$Label must be a fully qualified filesystem path." }
    return [IO.Path]::GetFullPath($Value)
}
function Write-Result([object]$Value) { [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 12 -Compress)) }
$archive = $null
$sourceStream = $null
$entryStream = $null
$outputStream = $null
$createdDirectory = $null
$outputFile = $null
$success = $false
$result = [ordered]@{}
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    if ($request -isnot [Collections.IDictionary]) { throw 'A JSON object is required.' }
    if ($request.ContainsKey('operation') -and $request.operation -cne 'extract') { throw 'operation must be extract.' }
    $dryRun = $true
    if ($request.ContainsKey('dryRun')) {
        if ($request.dryRun -isnot [bool]) { throw 'dryRun must be a JSON boolean.' }
        $dryRun = $request.dryRun
    }
    $maxBytes = [long]1073741824
    if ($request.ContainsKey('maxBytes')) {
        $v = $request.maxBytes
        if ($v -isnot [long] -and $v -isnot [int] -and $v -isnot [Numerics.BigInteger]) { throw 'maxBytes must be an integer.' }
        if ($v -lt 1 -or $v -gt 4294967296) { throw 'maxBytes must be between 1 and 4294967296.' }
        $maxBytes = [long]$v
    }
    $sourcePath = Get-FullFileSystemPath $request.inputPath 'inputPath'
    if (-not ($sourcePath.EndsWith('.vspx', [StringComparison]::OrdinalIgnoreCase) -or $sourcePath.EndsWith('.etl.zip', [StringComparison]::OrdinalIgnoreCase))) {
        throw 'inputPath must have .vspx or .etl.zip extension; its content must also be a readable ZIP archive.'
    }
    if (-not [IO.File]::Exists($sourcePath)) { throw 'inputPath does not exist as a file.' }
    $sourceStream = [IO.File]::Open($sourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $archive = [IO.Compression.ZipArchive]::new($sourceStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    if ($archive.Entries.Count -gt 10000) { throw 'Archive has more than 10000 entries; refusing an unbounded inventory.' }
    $entries = @($archive.Entries | ForEach-Object { [ordered]@{ name = $_.FullName; length = $_.Length; compressedLength = $_.CompressedLength } })
    $etlEntries = @($archive.Entries | Where-Object {
        $_.FullName.EndsWith('.etl', [StringComparison]::OrdinalIgnoreCase) -and -not $_.FullName.EndsWith('/') -and -not $_.FullName.EndsWith('\')
    })
    $sourceInfo = [IO.FileInfo]::new($sourcePath)
    $result = [ordered]@{
        operation = 'extract'; dryRun = $dryRun; sourceArchive = $sourcePath
        archive = [ordered]@{ length = $sourceStream.Length; lastWriteTimeUtc = $sourceInfo.LastWriteTimeUtc.ToString('O'); entryCount = $entries.Count }
        entries = $entries; etlEntries = @($etlEntries | ForEach-Object { $_.FullName })
        maxBytes = $maxBytes; traceValidated = $false; executed = $false
    }
    $selected = $null
    if ($request.ContainsKey('entryName')) {
        if ($request.entryName -isnot [string] -or [string]::IsNullOrEmpty($request.entryName)) { throw 'entryName must be a nonempty exact archive entry name.' }
        $matches = @($etlEntries | Where-Object { [string]::Equals($_.FullName, $request.entryName, [StringComparison]::Ordinal) })
        if ($matches.Count -ne 1) { throw 'entryName must uniquely and exactly identify one .etl entry (matching is case-sensitive).' }
        $selected = $matches[0]
    } elseif ($etlEntries.Count -eq 1) { $selected = $etlEntries[0] }
    if ($etlEntries.Count -eq 0) { throw 'No .etl entry exists in this archive.' }
    if ($null -eq $selected) { throw 'Multiple ETL entries exist; resubmit with one exact entryName from etlEntries.' }
    $result.selectedEntry = [ordered]@{ name = $selected.FullName; length = $selected.Length; compressedLength = $selected.CompressedLength }
    if ($selected.Length -gt $maxBytes) { throw "Selected entry exceeds maxBytes ($maxBytes)." }
    $outRoot = if ($request.ContainsKey('outputDirectory')) { Get-FullFileSystemPath $request.outputDirectory 'outputDirectory' } else { [IO.Path]::GetTempPath() }
    $runDirectory = Join-Path $outRoot ('profile-trace-' + [guid]::NewGuid().ToString('N'))
    $plannedFile = Join-Path $runDirectory ('trace-' + [guid]::NewGuid().ToString('N') + '.etl')
    $result.outputDirectory = $runDirectory
    $result.path = $plannedFile
    if (-not $dryRun) {
        if ([IO.Directory]::Exists($runDirectory) -or [IO.File]::Exists($runDirectory)) { throw 'Generated output directory already exists.' }
        [void][IO.Directory]::CreateDirectory($runDirectory)
        $createdDirectory = $runDirectory
        $outputFile = $plannedFile
        $outputStream = [IO.FileStream]::new($outputFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $entryStream = $selected.Open()
        $buffer = [byte[]]::new(1048576)
        $written = [long]0
        while (($count = $entryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($written -gt ($maxBytes - $count)) { throw "Extracted bytes exceed maxBytes ($maxBytes)." }
            $outputStream.Write($buffer, 0, $count)
            $written += $count
        }
        $outputStream.Flush($true)
        $outputStream.Dispose()
        $outputStream = $null
        $entryStream.Dispose()
        $entryStream = $null
        if ($written -ne $selected.Length) { throw 'Extracted byte count does not match the archive entry length.' }
        $result.executed = $true
        $result.bytesWritten = $written
    }
    Write-Result $result
    $success = $true
} catch {
    $result.error = @{ code = 'PROFILE_ARCHIVE_ERROR'; message = $_.Exception.Message }
    Write-Result $result
} finally {
    foreach ($resource in @($outputStream, $entryStream, $archive, $sourceStream)) { if ($null -ne $resource) { try { $resource.Dispose() } catch {} } }
    if (-not $success -and $null -ne $outputFile) { try { if ([IO.File]::Exists($outputFile)) { [IO.File]::Delete($outputFile) } } catch {} }
    if (-not $success -and $null -ne $createdDirectory) { try { [IO.Directory]::Delete($createdDirectory, $false) } catch {} }
}

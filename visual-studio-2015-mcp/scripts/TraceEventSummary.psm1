#requires -Version 7.0
Set-StrictMode -Version Latest

function Read-TraceEventSummary {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [long]$MaxBytes=268435456, [int]$MaxGroups=4096, [int]$MaxProcessObservations=4096)
    if($MaxBytes -lt 1 -or $MaxGroups -lt 1 -or $MaxProcessObservations -lt 1){throw 'Summary limits must be positive.'}
    if((Get-Item -LiteralPath $Path).Length -gt $MaxBytes){throw 'Event XML exceeds the summary byte limit.'}
    $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
    $settings.MaxCharactersInDocument=$MaxBytes;$settings.IgnoreComments=$true;$settings.IgnoreWhitespace=$true
    $reader=[Xml.XmlReader]::Create($Path,$settings)
    $events=[Collections.Generic.Dictionary[string,long]]::new([StringComparer]::Ordinal)
    $samples=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $headers=[Collections.Generic.List[object]]::new();$processes=[Collections.Generic.List[object]]::new()
    $total=0L;$cpu=0L;$unresolved=0L;$omittedGroups=0L;$omittedProcesses=0L;$rootSeen=$false;$rootClosed=$false
    try {
        while($reader.Read()) {
            if($reader.NodeType -eq [Xml.XmlNodeType]::Element -and $reader.Depth -eq 0){
                if($reader.LocalName -cne 'Events' -or $reader.NamespaceURI){throw 'Expected a PerfView Events document.'}
                $rootSeen=$true;if($reader.IsEmptyElement){$rootClosed=$true};continue
            }
            if($reader.NodeType -eq [Xml.XmlNodeType]::EndElement -and $reader.Depth -eq 0){$rootClosed=$true;continue}
            if($reader.NodeType -ne [Xml.XmlNodeType]::Element -or $reader.Depth -ne 1){continue}
            if($reader.LocalName -cne 'Event' -or $reader.NamespaceURI){throw 'Unexpected element in Events.'}
            $name=$reader.GetAttribute('EventName')
            if([string]::IsNullOrWhiteSpace($name)){
                if($null -eq $reader.GetAttribute('TaskName') -or $null -eq $reader.GetAttribute('OpcodeNum')){throw 'Event requires a name or an unresolved task/opcode identity.'}
                # TraceEvent retains undecoded classic/provider events as task and
                # opcode records. Count them without inventing a decoded name.
                $total++;$unresolved++;continue
            }
            $total++
            if($events.ContainsKey($name)){$events[$name]++}elseif($events.Count -lt $MaxGroups){$events.Add($name,1L)}else{$omittedGroups++}
            if($name -ceq 'PerfInfo/Sample'){
                $cpu++;$pidText=$reader.GetAttribute('PID');$processName=$reader.GetAttribute('PName')
                $key=(@($pidText,$processName)|ConvertTo-Json -Compress)
                if($samples.ContainsKey($key)){$samples[$key].sampleEvents++}
                elseif($samples.Count -lt $MaxGroups){$samples.Add($key,@{processIdText=$pidText;processName=$processName;sampleEvents=1L})}
                else{$omittedGroups++}
            }
            if($name -ceq 'EventTrace' -or $name -cin @('Process/Start','Process/Stop','Process/DCStart','Process/DCStop','Process/DCStartGroup','Process/DCEnd')) {
                if($processes.Count -ge $MaxProcessObservations -or $headers.Count -ge $MaxProcessObservations){$omittedProcesses++;continue}
                $attributes=[ordered]@{}
                if($reader.MoveToFirstAttribute()){do{$attributes[$reader.Name]=$reader.Value}while($reader.MoveToNextAttribute());$null=$reader.MoveToElement()}
                if($name -ceq 'EventTrace'){$headers.Add($attributes)}else{$processes.Add($attributes)}
            }
        }
        if(-not $rootSeen -or -not $rootClosed){throw 'Incomplete PerfView Events document.'}
    } finally {$reader.Dispose()}
    return [ordered]@{eventContentValidated=$true;eventCount=$total;unresolvedEventCount=$unresolved;cpuSampleEvents=$cpu;
        eventCounts=@($events.GetEnumerator()|Sort-Object Key -CaseSensitive|ForEach-Object{@{eventName=$_.Key;count=$_.Value}});
        samplesByObservedPidAndName=@($samples.Values|Sort-Object sampleEvents -Descending);traceHeaders=@($headers.ToArray());processObservations=@($processes.ToArray());
        summaryTruncated=($omittedGroups -gt 0 -or $omittedProcesses -gt 0);omittedGroupEvents=$omittedGroups;omittedProcessObservations=$omittedProcesses;
        applicationAttributionVerified=$false;symbolCompletenessVerified=$false;managedHeapVerified=$false;
        notes=@('Sample totals count PerfInfo/Sample events, not CPU milliseconds. PID/name groups can include reused PIDs; inspect raw process lifetime observations before application attribution.',
            'Trace header attributes retain original numeric/date formatting, including EventsLost/BuffersLost. Missing loss attributes are unknown, not zero.',
            'Absent GC/allocation event types do not establish zero GC or allocations. Event parsing does not establish complete symbols or heap coverage.')}
}
Export-ModuleMember -Function Read-TraceEventSummary

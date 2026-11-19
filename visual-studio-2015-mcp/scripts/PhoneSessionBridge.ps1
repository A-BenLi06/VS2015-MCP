# Persistent XDE controller. Run using SysWOW64 Windows PowerShell 5.1 -STA.
param()
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
if([IntPtr]::Size -ne 4 -or $PSVersionTable.PSEdition -ne 'Desktop' -or [Threading.Thread]::CurrentThread.ApartmentState -ne 'STA'){
    [Console]::Out.WriteLine('{"kind":"fatal","error":{"code":"PHONE_BRIDGE_RUNTIME","message":"Use x86 Windows PowerShell 5.1 in STA mode."}}')
    exit 1
}
Import-Module (Join-Path $PSScriptRoot 'PhoneSessions.psm1') -Force -DisableNameChecking
Add-Type -AssemblyName System.Windows.Forms
[Console]::Out.WriteLine('{"kind":"ready","protocolVersion":1,"backend":"xde-session"}')
[Console]::Out.Flush()
try {
    while($true){
        $task=[Console]::In.ReadLineAsync()
        while(-not $task.IsCompleted){[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 10}
        $line=$task.GetAwaiter().GetResult()
        if($null -eq $line){break}
        $id=$null
        try {
            if($line.Length -gt 1048576){throw 'The phone request exceeds 1 Mi characters.'}
            $request=$line | ConvertFrom-Json
            if($null -eq $request -or $request -isnot [pscustomobject]){throw 'Expected a JSON request object.'}
            $id=$request.id
            $result=Invoke-PhoneSessionRequest $request
            $response=@{id=$id;result=$result}
        }catch{
            $code=if($_.Exception.Data.Contains('code')){[string]$_.Exception.Data['code']}else{'PHONE_SESSION_ERROR'}
            $response=@{id=$id;error=@{code=$code;message=$_.Exception.Message}}
            if($_.Exception.Data.Contains('cleanupWarnings')){$response.error.cleanupWarnings=@($_.Exception.Data['cleanupWarnings'])}
            foreach($field in @('operationMayContinue','details')){
                if($_.Exception.Data.Contains($field)){$response.error[$field]=$_.Exception.Data[$field]}
            }
        }
        [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 20 -Compress));[Console]::Out.Flush()
    }
}finally{
    $cleanup=Close-AllPhoneSessions
    if($cleanup -and ($cleanup.cleanupWarnings.Count -or $cleanup.unreleasedKeys.Count)){
        [Console]::Error.WriteLine(($cleanup | ConvertTo-Json -Depth 8 -Compress))
    }
}

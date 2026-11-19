param([Parameter(Mandatory=$true)][string]$BridgePath)
$ErrorActionPreference='Stop'
$asm=[Reflection.Assembly]::LoadFrom($BridgePath)
$type=$asm.GetType('Program',$true)
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$decode=$type.GetMethod('DecodeXamlString',$flags)
$encode=$type.GetMethod('XamlLiteral',$flags)
$path=$type.GetMethod('XamlPath',$flags)
$b64=$type.GetMethod('DecodeXamlBase64',$flags)
$dint=$type.GetMethod('DecodeXamlInt',$flags)
$zh=[string]([char]0x4E2D)+[string]([char]0x6587)
$emoji=[char]::ConvertFromUtf32(0x1F4F1)
$count=0
foreach($value in @('', 'plain', 'quote" slash\', "line`r`n`tend", "a$([char]0)b", $zh, $emoji)) {
  $encoded=$encode.Invoke($null,@($value))
  $decoded=$decode.Invoke($null,@($encoded))
  if($decoded -cne $value){throw 'Round trip failed'}
  $count++
}
foreach($pair in @(
  @('"\a\v\b\f\t\r\n\0"', ("`a`v`b`f`t`r`n"+[char]0)),
  @('"\x41\u4e2d\U0001F4F1"', ('A'+[char]0x4E2D+$emoji)),
  @('@"a""b"', 'a"b')
)) {
  if($decode.Invoke($null,@($pair[0])) -cne $pair[1]){throw 'Escape decode failed'}
  $count++
}
foreach($invalid in @('"missing', 'plain', '"\q"', '"\u12"', '"\x"', '"\U00110000"', '"\U0000D800"', '"a"b"', "`"a`n`"")) {
  $failed=$false
  try{[void]$decode.Invoke($null,@($invalid))}catch{if($_.Exception.InnerException.Data['code'] -ne 'XAML_VALUE_FORMAT'){throw};$failed=$true}
  if(!$failed){throw ('Accepted invalid literal: '+$invalid)}
  $count++
}
$failed=$false
try{[void]$path.Invoke($null,(,[int[]]@(-1)))}catch{if($_.Exception.InnerException.Data['code'] -ne 'INVALID_REQUEST'){throw};$failed=$true}
if(!$failed){throw 'Accepted negative child index'}
$count++
if($path.Invoke($null,(,[int[]]@(0,2))) -cne 'Windows.UI.Xaml.Media.VisualTreeHelper.GetChild(Windows.UI.Xaml.Media.VisualTreeHelper.GetChild(Windows.UI.Xaml.Window.Current.Content, 0), 2)'){throw 'Visual path mismatch'}
$count++
$b64text=$zh+' | : "ok"'
$b64raw=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($b64text))
if($b64.Invoke($null,@($b64raw)) -cne $b64text){throw 'Base64 decode failed'}
$count++
$failed=$false
try{[void]$b64.Invoke($null,@('not!base64'))}catch{if($_.Exception.InnerException.Data['code'] -ne 'XAML_VALUE_FORMAT'){throw};$failed=$true}
if(!$failed){throw 'Accepted invalid base64'}
$count++
$failed=$false
try{[void]$b64.Invoke($null,@([Convert]::ToBase64String([byte[]]@(0xff,0xfe))))}catch{if($_.Exception.InnerException.Data['code'] -ne 'XAML_VALUE_FORMAT'){throw};$failed=$true}
if(!$failed){throw 'Accepted invalid UTF8 base64'}
$count++
if($dint.Invoke($null,@('0x7fffffff')) -ne 2147483647 -or $dint.Invoke($null,@('-42')) -ne -42){throw 'Int decode failed'}
$count++
$failed=$false
try{[void]$dint.Invoke($null,@('nan'))}catch{if($_.Exception.InnerException.Data['code'] -ne 'XAML_VALUE_FORMAT'){throw};$failed=$true}
if(!$failed){throw 'Accepted invalid int'}
$count++
@{passed=$count} | ConvertTo-Json -Compress

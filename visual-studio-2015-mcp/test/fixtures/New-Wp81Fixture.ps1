#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('vs2015-wp81-' + [Guid]::NewGuid().ToString('N'))),
    [string]$TemplateDirectory,
    [string]$VisualStudioRoot = $(if ($env:VS140COMNTOOLS) { [IO.Path]::GetFullPath((Join-Path $env:VS140COMNTOOLS '../..')) } else { Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio 14.0' }),
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')][string]$ProjectName = 'McpPhoneFixture',
    [string]$DefaultLanguage = [Globalization.CultureInfo]::CurrentUICulture.Name,
    [switch]$XamlAutomation,
    [switch]$Build,
    [string]$MSBuildPath = (Join-Path ${env:ProgramFiles(x86)} 'MSBuild/14.0/Bin/MSBuild.exe')
)
$ErrorActionPreference = 'Stop'
if (-not $DefaultLanguage) { throw 'DefaultLanguage is required when the current UI culture is invariant.' }
[void][Globalization.CultureInfo]::GetCultureInfo($DefaultLanguage)
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'OutputDirectory must not exist; this generator never reuses another fixture.' }
if (-not $TemplateDirectory) {
    $cache = Join-Path $VisualStudioRoot 'Common7/IDE/ProjectTemplatesCache'
    $matches = @(Get-ChildItem -LiteralPath $cache -Filter 'BlankApplication.vstemplate' -File -Recurse | Where-Object {
        [xml]$candidateTemplate = Get-Content -Raw -LiteralPath $_.FullName
        $candidateTemplate.VSTemplate.TemplateData.TemplateID -eq 'Microsoft.CS.WindowsPhoneApp.BlankApplication'
    })
    if (-not $matches.Count) { throw 'Installed Windows Phone 8.1 C# Blank Application template was not found.' }
    $TemplateDirectory = ($matches | Sort-Object FullName | Select-Object -First 1).DirectoryName
}
$template = [IO.Path]::GetFullPath($TemplateDirectory)
[xml]$definition = Get-Content -Raw -LiteralPath (Join-Path $template 'BlankApplication.vstemplate')
if ($definition.VSTemplate.TemplateData.TemplateID -ne 'Microsoft.CS.WindowsPhoneApp.BlankApplication') { throw 'Template is not Windows Phone 8.1 WinRT C#.' }
$productId = [Guid]::NewGuid().ToString()
$projectGuid = [Guid]::NewGuid().ToString().ToUpperInvariant()
$replacements = [ordered]@{
    '$guid1$'=$projectGuid; '$guid9$'=$productId; '$safeprojectname$'=$ProjectName; '$projectname$'=$ProjectName
    '$currentuiculturename$'=$DefaultLanguage; '$registeredorganization$'=''; '$year$'=[DateTime]::Now.Year.ToString()
    '$XmlEscapedPublisherDistinguishedName$'="CN=$ProjectName"; '$XmlEscapedPublisher$'=$ProjectName
}
function Expand-TemplateText([string]$Value) {
    foreach ($item in $replacements.GetEnumerator()) { $Value = $Value.Replace($item.Key, [Security.SecurityElement]::Escape([string]$item.Value)) }
    return $Value
}
function Copy-TemplateNodes($Parent, [string]$RelativeDirectory) {
    foreach ($node in $Parent.ChildNodes) {
        if ($node.LocalName -eq 'Folder') { Copy-TemplateNodes $node ([IO.Path]::Combine($RelativeDirectory, [string]$node.GetAttribute("Name"))); continue }
        if ($node.LocalName -ne 'ProjectItem') { continue }
        $targetName = [string]$node.TargetFileName
        if (-not $targetName) { $targetName = $node.InnerText }
        $target = Join-Path $destination ([IO.Path]::Combine($RelativeDirectory, $targetName))
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        $inputFile = Join-Path $template $node.InnerText
        if ($node.ReplaceParameters -eq 'true') { [IO.File]::WriteAllText($target, (Expand-TemplateText ([IO.File]::ReadAllText($inputFile))), [Text.UTF8Encoding]::new($false)) }
        else { [IO.File]::Copy($inputFile, $target, $false) }
    }
}
[void][IO.Directory]::CreateDirectory($destination)
$project = Join-Path $destination "$ProjectName.csproj"
$templateProject = $definition.VSTemplate.TemplateContent.Project
[IO.File]::WriteAllText($project, (Expand-TemplateText ([IO.File]::ReadAllText((Join-Path $template $templateProject.File)))), [Text.UTF8Encoding]::new($false))
Copy-TemplateNodes $templateProject ''
[xml]$projectXml = Get-Content -Raw -LiteralPath $project
$properties = $projectXml.Project.PropertyGroup[0]
foreach ($pair in @(@('AppxPackageSigningEnabled','false'), @('AppxBundle','Never'))) {
    $element = $projectXml.CreateElement($pair[0], $projectXml.DocumentElement.NamespaceURI); $element.InnerText=$pair[1]; [void]$properties.AppendChild($element)
}
$projectXml.Save($project)
$mainXaml = @"
<Page x:Class="$ProjectName.MainPage" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Background="#101820">
<Grid><StackPanel VerticalAlignment="Center" HorizontalAlignment="Center" Width="340">
<TextBlock Text="MCP phone fixture" FontSize="30" TextWrapping="Wrap"/>
<TextBlock x:Name="StatusText" AutomationProperties.AutomationId="StatusValue" Text="Ready: 21" FontSize="42" Margin="0,24,0,24"/>
<Button x:Name="IncrementButton" AutomationProperties.AutomationId="IncrementButton" Content="Compute next" HorizontalAlignment="Stretch" Height="100" Click="OnIncrement"/>
</StackPanel></Grid></Page>
"@
if ($XamlAutomation) {
    $mainXaml = $mainXaml.Replace('<Page ', '<Page RequestedTheme="Dark" ')
    $mainXaml = $mainXaml.Replace('</StackPanel>', '<TextBox x:Name="EditableValue" AutomationProperties.AutomationId="EditableValue" Text="" Margin="0,16,0,0" FontSize="24"/></StackPanel>')
}
$mainSource = @"
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
namespace $ProjectName
{
    public sealed partial class MainPage : Page
    {
        private int counter = 21;
        public MainPage() { InitializeComponent(); }
        private void OnIncrement(object sender, RoutedEventArgs e)
        {
            int input = counter;
            int doubled = input * 2;
            StatusText.Text = "Result: " + doubled; // MCP_BREAKPOINT
            counter++;
        }
    }
}
"@
[IO.File]::WriteAllText((Join-Path $destination 'MainPage.xaml'),$mainXaml,[Text.UTF8Encoding]::new($false))
$source = Join-Path $destination 'MainPage.xaml.cs'
[IO.File]::WriteAllText($source,$mainSource,[Text.UTF8Encoding]::new($false))
$breakpointLine = [Array]::FindIndex([string[]]($mainSource -split '\r?\n'), [Predicate[string]]{ param($line) $line.Contains('MCP_BREAKPOINT') }) + 1
$solution = Join-Path $destination "$ProjectName.sln"
$solutionText = @"
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio 14
VisualStudioVersion = 14.0.25420.1
MinimumVisualStudioVersion = 10.0.40219.1
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "$ProjectName", "$ProjectName.csproj", "{$projectGuid}"
EndProject
Global
    GlobalSection(SolutionConfigurationPlatforms) = preSolution
        Debug|x86 = Debug|x86
    EndGlobalSection
    GlobalSection(ProjectConfigurationPlatforms) = postSolution
        {$projectGuid}.Debug|x86.ActiveCfg = Debug|x86
        {$projectGuid}.Debug|x86.Build.0 = Debug|x86
        {$projectGuid}.Debug|x86.Deploy.0 = Debug|x86
    EndGlobalSection
EndGlobal
"@
[IO.File]::WriteAllText($solution,$solutionText,[Text.UTF8Encoding]::new($false))
$manifest = [ordered]@{ root=$destination; solution=$solution; project=$project; projectName=$ProjectName; source=$source; breakpointLine=$breakpointLine; projectGuid=$projectGuid; productId=$productId; initialCounter=21; expectedDoubled=42; templateDirectory=$template; defaultLanguage=$DefaultLanguage; createdAtUtc=[DateTimeOffset]::UtcNow.ToString('o') }
if ($XamlAutomation) { $manifest.invokePauseLine = $breakpointLine + 2 }
if ($Build) {
    if (-not (Test-Path -LiteralPath $MSBuildPath -PathType Leaf)) { throw 'MSBuild 14 was not found; specify MSBuildPath.' }
    $log = Join-Path $destination 'build.log'
    & $MSBuildPath $project /nologo /nr:false /m:1 /p:VisualStudioVersion=14.0 /p:Configuration=Debug /p:Platform=x86 2>&1 | Tee-Object -FilePath $log | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "MSBuild failed ($LASTEXITCODE); see $log" }
    $manifest.package = @(Get-ChildItem -LiteralPath (Join-Path $destination 'AppPackages') -Filter '*.appx' -File -Recurse | Where-Object Name -NotMatch 'Dependencies' | Select-Object -ExpandProperty FullName)
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'fixture.json') -Encoding utf8
$manifest | ConvertTo-Json -Depth 8



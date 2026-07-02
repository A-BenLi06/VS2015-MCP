# XAML/C# And C++/XAML Patterns

Use this for Windows 8.1 Store apps built with XAML. Most C# patterns also apply to C++/XAML after adapting syntax and async helpers. For Windows Phone 8.1 UI, use the `references/windowsphone81/` files first and reuse only shared view-model/service patterns from this file.

## Table Of Contents

- Project shape and target checks
- App lifecycle and navigation
- AppBar and CommandBar
- Collections and SemanticZoom
- Async services and local state
- Charms contracts
- Tiles
- Windows Phone 8.1 notes
- C++/XAML notes

## Project Shape And Target Checks

Typical C#/XAML Store app files:

```text
App.xaml
App.xaml.cs
Package.appxmanifest
MainPage.xaml
MainPage.xaml.cs
Views/
ViewModels/
Models/
Services/
Assets/
Common/
```

Before adding APIs, inspect:

- `.csproj` or `.vcxproj` target platform and imported Store app targets.
- `Package.appxmanifest` capabilities, declarations, logos, tile sizes, and app entry point.
- Existing helper classes such as `NavigationHelper`, `SuspensionManager`, `RelayCommand`, service locators, or Prism/Kona infrastructure.

## App Lifecycle And Navigation

Use a root `Frame` and keep activation explicit:

```csharp
protected override void OnLaunched(LaunchActivatedEventArgs args)
{
    var rootFrame = Window.Current.Content as Frame;
    if (rootFrame == null)
    {
        rootFrame = new Frame();
        Window.Current.Content = rootFrame;
    }

    if (rootFrame.Content == null)
    {
        rootFrame.Navigate(typeof(MainPage), args.Arguments);
    }

    Window.Current.Activate();
}
```

Handle suspend/resume near app startup:

```csharp
public App()
{
    InitializeComponent();
    Suspending += OnSuspending;
    Resuming += OnResuming;
}

private async void OnSuspending(object sender, SuspendingEventArgs e)
{
    var deferral = e.SuspendingOperation.GetDeferral();
    try
    {
        await _stateService.SaveAsync();
    }
    finally
    {
        deferral.Complete();
    }
}
```

Navigation rules:

- Pass item IDs, query strings, or simple DTOs; reload large state from services.
- Restore selected item and scroll/group context when returning to collection pages.
- Keep activation paths for normal launch, tile launch, search activation, share target activation, file/protocol activation, and secondary-tile activation separate enough to test.

## AppBar And CommandBar

Prefer `CommandBar` with XAML 8.1 app bar buttons when the project supports it:

```xml
<Page.BottomAppBar>
    <CommandBar>
        <AppBarButton Icon="Refresh"
                      Label="Refresh"
                      Command="{Binding RefreshCommand}" />
        <AppBarButton Icon="Add"
                      Label="Add"
                      Command="{Binding AddCommand}" />
        <CommandBar.SecondaryCommands>
            <AppBarButton Label="Settings"
                          Command="{Binding OpenSettingsCommand}" />
        </CommandBar.SecondaryCommands>
    </CommandBar>
</Page.BottomAppBar>
```

Use classic `AppBar` content if the repository uses Windows 8.0 style markup. Keep commands at the page edge, not as dense desktop toolbars embedded in content.

## Collections And SemanticZoom

For grouped data, bind through a grouped `CollectionViewSource`:

```xml
<Page.Resources>
    <CollectionViewSource x:Name="GroupedItems"
                          IsSourceGrouped="True"
                          Source="{Binding Groups}" />
</Page.Resources>

<GridView ItemsSource="{Binding Source={StaticResource GroupedItems}}"
          SelectionMode="None"
          IsItemClickEnabled="True"
          ItemClick="OnItemClick">
    <GridView.GroupStyle>
        <GroupStyle>
            <GroupStyle.HeaderTemplate>
                <DataTemplate>
                    <TextBlock Text="{Binding Key}" Style="{StaticResource HeaderTextBlockStyle}" />
                </DataTemplate>
            </GroupStyle.HeaderTemplate>
        </GroupStyle>
    </GridView.GroupStyle>
</GridView>
```

Use `SemanticZoom` when there are enough groups that zoomed-out navigation saves real effort:

```xml
<SemanticZoom>
    <SemanticZoom.ZoomedInView>
        <GridView ItemsSource="{Binding Source={StaticResource GroupedItems}}" />
    </SemanticZoom.ZoomedInView>
    <SemanticZoom.ZoomedOutView>
        <GridView ItemsSource="{Binding GroupHeaders}" />
    </SemanticZoom.ZoomedOutView>
</SemanticZoom>
```

Add visual states for `Loading`, `Empty`, `Error`, and content. Remote data collection pages should never render as a blank grid.

## Async Services And Local State

Service shape:

```csharp
public interface ILineStatusService
{
    Task<IReadOnlyList<LineStatus>> GetLatestAsync();
}

public sealed class LineStatusService : ILineStatusService
{
    private readonly HttpClient _httpClient;

    public LineStatusService(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<IReadOnlyList<LineStatus>> GetLatestAsync()
    {
        var json = await _httpClient.GetStringAsync(_endpoint);
        return LineStatusParser.Parse(json);
    }
}
```

Use the app's existing `HttpClient` type. Some Windows 8.1 apps use `System.Net.Http.HttpClient`; others use `Windows.Web.Http.HttpClient` or a wrapper.

Local settings and files:

```csharp
var settings = ApplicationData.Current.LocalSettings;
settings.Values["lastRefreshUtc"] = DateTimeOffset.UtcNow.ToString("o");

var folder = ApplicationData.Current.LocalFolder;
var file = await folder.CreateFileAsync("cache.json", CreationCollisionOption.ReplaceExisting);
await FileIO.WriteTextAsync(file, json);
```

## Charms Contracts

Share:

```csharp
DataTransferManager.GetForCurrentView().DataRequested += (sender, args) =>
{
    var request = args.Request;
    request.Data.Properties.Title = "Status";
    request.Data.SetText(_viewModel.ShareText);
};
```

Search:

- Use `SearchPane` and search activation for classic Windows 8.1 charm search when the app integrates with system search.
- Use an in-app `SearchBox` when the experience is local to the current page or the codebase already migrated to visible search UI.
- Keep query parsing and result loading in a service or view model.

Settings:

- Use `SettingsPane` for settings charm integration in legacy Store apps.
- Keep account, permissions, privacy, and about panes lightweight and keyboard accessible.

## Tiles

Live tile update:

```csharp
var xml = TileUpdateManager.GetTemplateContent(TileTemplateType.TileSquare150x150Text04);
var text = xml.GetElementsByTagName("text");
text[0].InnerText = "Updated";

var notification = new TileNotification(xml);
TileUpdateManager.CreateTileUpdaterForApplication().Update(notification);
```

Secondary tile creation:

```csharp
var tile = new SecondaryTile(
    tileId,
    "Short name",
    "Display name",
    activationArguments,
    TileOptions.ShowNameOnLogo,
    new Uri("ms-appx:///Assets/Logo.png"));

var created = await tile.RequestCreateAsync();
```

Use stable IDs and activation arguments that can restore the pinned page after app launch.

## Windows Phone 8.1 Notes

- Do not reuse Windows 8.1 Store page XAML as the phone page.
- Bind shared view models to Pivot, Panorama, ListPage, and DetailPage surfaces.
- Map AppBar commands to ApplicationBar icons or ellipsis menu items.
- Treat hardware/system Back as the primary return mechanism.
- Prefer one-column phone layouts and reduced metadata.
- Keep phone settings/search as phone pages unless the existing project has a different established convention.

## C++/XAML Notes

- Use C++/CX or the existing project style; do not introduce C++/WinRT into a legacy project unless the user is migrating.
- Convert WinRT async operations with PPL `create_task` when that is the local pattern.
- Keep `ref new`, `Platform::String^`, event tokens, and `CoreDispatcher` usage consistent with the codebase.
- Explicitly release or recreate DirectX resources on device lost, suspend, and resume paths.

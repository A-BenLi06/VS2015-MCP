# Architecture, State, Caching, And Tests

Use this when designing business apps, service layers, testability, caching, settings, or local state.

## MVVM Shape

Prefer the repository's existing architecture. For new C#/XAML business features, use:

```text
Views/          XAML pages and controls
ViewModels/     page state, commands, validation, loading/error state
Models/         DTOs and domain objects
Services/       WinRT, HTTP, storage, auth, tile, and contract adapters
Common/         RelayCommand, property change base, navigation/state helpers
Tests/          view model and service tests when the repo has a test project
```

Keep pages responsible for view concerns and view models responsible for state transitions.

## View Model Base

Use the app's existing base class when present. Otherwise keep it minimal:

```csharp
public abstract class ViewModelBase : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler PropertyChanged;

    protected bool SetProperty<T>(ref T storage, T value, string propertyName)
    {
        if (EqualityComparer<T>.Default.Equals(storage, value))
        {
            return false;
        }

        storage = value;
        var handler = PropertyChanged;
        if (handler != null)
        {
            handler(this, new PropertyChangedEventArgs(propertyName));
        }

        return true;
    }
}
```

For Windows 8.1 C#, avoid relying on `CallerMemberName` if the project language version or profile does not support it.

## Commands

Use an existing `RelayCommand`/`DelegateCommand` first. For async commands, prevent double-submit and expose busy state:

```csharp
public async Task RefreshAsync()
{
    if (IsBusy)
    {
        return;
    }

    IsBusy = true;
    ErrorMessage = null;
    try
    {
        Items = await _service.GetLatestAsync();
    }
    catch (Exception ex)
    {
        ErrorMessage = _errorMapper.ToUserMessage(ex);
    }
    finally
    {
        IsBusy = false;
    }
}
```

## Service Boundaries

Hide platform APIs behind small interfaces when they touch:

- HTTP, OAuth, and tokens.
- `ApplicationData`, file pickers, libraries, and settings.
- Tiles, badges, secondary tiles, share/search/settings contracts.
- Sensors, media capture, pointer streams, and DirectX device resources.

This keeps view models testable and makes design-time data easier.

## Caching And Local Storage

Cache deliberately:

- API response cache: store JSON plus timestamp and schema version.
- Image cache: key by stable URI or content hash; clean old files opportunistically.
- Settings: small values in `LocalSettings`; never store large JSON there.
- Auth: follow the app's existing secure token storage pattern; do not invent plaintext token storage.

Use stale data if it improves offline startup, but surface the stale timestamp and refresh failures.

## Error And Empty States

Every remote or file-backed view should represent:

- Loading.
- Loaded with content.
- Loaded empty.
- Recoverable error with retry.
- Authentication/permission needed.
- Offline or service unavailable.

Do not let a blank `GridView` or `ListView` be the only error signal.

## Tests

Prioritize fast tests around:

- View-model state transitions: idle, loading, success, empty, error.
- Service response mapping: success, HTTP error, invalid JSON, timeout, auth expiry.
- Cache: hit, miss, stale, corrupt, version mismatch.
- Navigation: parameter parsing, secondary-tile activation arguments, search/share activation routing.
- Commands: disabled/enabled state and double-submit prevention.

Use UI automation only when the repo already has it or the behavior cannot be validated below the UI.

## Verification Commands

Use existing repository commands first. If none exist and the Windows 8.1 tooling is installed, likely commands are:

```powershell
msbuild .\App.sln /p:Configuration=Debug /p:Platform=x86
vstest.console.exe .\Tests\bin\x86\Debug\Tests.dll
```

Legacy Store app builds often fail on modern machines without Visual Studio 2013/2015 and the Windows 8.1 SDK. If tooling is missing, record that limitation and run static checks for project references, namespaces, manifest declarations, and API availability.

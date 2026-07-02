# Capability Recipes

Use this as the implementation checklist for the fixed modules expected from this skill. For UI generation, apply `references/mapping/platform-decision-matrix.md` before this file.

## Dual-Target Rule

- Share models, view models, services, command intent names, navigation intent names, and semantic resources.
- Keep Windows 8.1 and WP8.1 pages, navigation controls, command surfaces, visual density, settings/search placement, and back behavior separate.
- Do not create a single page and rely only on scaling.

## Windows 8.1 Store App Scaffold

- Prefer the user's existing Visual Studio template or repository structure when present.
- For new C#/XAML work, create or describe `App.xaml`, `App.xaml.cs`, `Package.appxmanifest`, `MainPage.xaml`, `Views/`, `ViewModels/`, `Models/`, `Services/`, `Assets/`, and `Common/` or equivalent local conventions.
- For new WinJS work, create or describe `default.html`, `package.appxmanifest`, `css/`, `js/default.js`, `pages/`, `images/`, and `WinJS` references.
- Include manifest capabilities and declarations for network, pictures library, webcam, microphone, search, share target, file type associations, protocol activation, and tiles only when used.
- Do not promise buildability without the Windows 8.1 SDK and Visual Studio project system.

## Windows Phone 8.1 App Scaffold

- Prefer the repository's existing phone project type and template.
- For new WP8.1 XAML work, create or describe `App.xaml`, phone manifest, `MainPage.xaml`, `Views/`, `ViewModels/`, `Models/`, `Services/`, `Assets/`, and platform resources.
- Use Pivot, Panorama, ListPage, DetailPage, SearchPage, and SettingsPage as phone page patterns.
- Use ApplicationBar for page commands and hardware/system Back for return behavior.
- Do not promise buildability without the Windows Phone 8.1 tooling.

## XAML Page Navigation

- Use a root `Frame` and `Frame.Navigate(typeof(Page), parameter)` for page transitions.
- Serialize only primitive, stable navigation parameters; reload large objects from services or caches.
- Save page state on suspend and restore on resume through the app's existing suspension helper, `ApplicationData`, or page navigation state.
- Keep page constructors light; load data in navigation or view-model activation methods.

## AppBar And ApplicationBar Commanding

- Put global page commands in `TopAppBar`, `BottomAppBar`, or `CommandBar`; put item-specific commands near the selected content when the app already follows that pattern.
- Use `AppBarButton`, `AppBarToggleButton`, and `AppBarSeparator` in XAML 8.1 when available; use older `AppBar` content only when the codebase already does.
- On WP8.1, put primary actions in bottom ApplicationBar icons and secondary actions under the ellipsis menu.
- Keep commands short, icon-led, and touch-friendly. Disable unavailable commands instead of hiding core workflow actions unpredictably.
- Wire commands to view-model `ICommand` or page handlers according to the existing architecture.

## GridView/ListView/SemanticZoom Layout

- Use `GridView` for visual tile collections and `ListView` for vertical scan/comparison flows.
- Use `CollectionViewSource` with grouped data for grouped XAML views; use WinJS `Binding.List.createGrouped` for WinJS.
- Use `SemanticZoom` for large grouped collections where zoomed-out group navigation materially improves scanning.
- For WP8.1, default to one-column lists, Pivot, or Panorama instead of direct GridView/SemanticZoom ports.
- Provide `Empty`, `Loading`, and `Error` visual states for remote or filtered data.
- Verify narrow, snapped, portrait, and high-DPI layouts with `VisualStateManager` or existing responsive helpers.

## Local Settings And App State

- Store small preferences and tokens metadata in `ApplicationData.Current.LocalSettings`; use `RoamingSettings` only when the app already supports account roaming.
- On phone projects, use the repository's existing phone settings and app state helper when `ApplicationData` is not the local convention.
- Store files, caches, and downloaded JSON in `LocalFolder`, `TemporaryFolder`, or `RoamingFolder` according to data lifetime.
- Version stored settings and handle missing, stale, or malformed values.
- Save navigation stack, selected item, scroll position, and in-progress input during suspend if user loss would be noticeable.

## REST API Plus Async WinRT Service Layer

- Put network calls behind service interfaces. Return `Task<T>` in C#/XAML and `Promise` in WinJS.
- Use the app's existing HTTP stack: `System.Net.Http.HttpClient`, `Windows.Web.Http.HttpClient`, WinJS `xhr`, or a local wrapper.
- Keep JSON parsing and DTO mapping outside pages. Use Json.NET only if already present or acceptable for the target.
- Handle timeout, offline, HTTP error status, authentication expiry, and invalid JSON explicitly.
- Marshal UI updates back to the UI thread only where required; never block on async work.

## Live Tile And Secondary Tile

- Use `TileUpdateManager`, `BadgeUpdateManager`, and tile XML templates compatible with Windows 8.1.
- For WP8.1, use phone tile APIs/templates that match the phone project type.
- Keep tile content concise and resilient to missing images or stale data.
- For secondary tiles, use stable tile IDs and activation arguments that can restore the target item.
- Check pinned state before update/delete and handle user cancellation from `RequestCreateAsync`.

## Touch And Pointer Input

- Prefer XAML/WinJS control events for normal UI. Use pointer/manipulation events for drawing, games, maps, custom controls, or gestures.
- Set `ManipulationMode` deliberately for XAML gesture scenarios.
- Keep hit targets comfortably finger-sized and avoid hover-only affordances.
- Handle mouse, touch, pen, keyboard, and game/controller input when the app category implies it.

## MVVM Service/Test Structure

- Put state and commands in view models when the app already uses MVVM or the feature is business/data-heavy.
- Hide WinRT-only services behind small interfaces to keep view models testable.
- Provide mock/fake services for offline examples, unit tests, and design-time data.
- Test view-model state transitions, service error mapping, cache expiry, and navigation parameter handling before UI automation.

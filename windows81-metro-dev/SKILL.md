---
name: windows81-metro-dev
description: Build, port, repair, scaffold, review, or generate UI for Windows 8.1 Store/Metro apps, Windows Phone 8.1 apps, and Visual Studio 2013 Universal Projects. Use for C#/XAML, C++/XAML, WinJS/HTML, WinRT async APIs, AppBar/ApplicationBar commanding, GridView/ListView/SemanticZoom, Pivot/Panorama, Share/Search/Settings, Live Tiles, Secondary Tiles, MVVM/navigation, local state, REST services, touch/pointer input, and DirectX/XAML interop. Prefer this over UWP, WinUI, Fluent, or Windows App SDK guidance when the target is Windows 8.1, Windows Phone 8.1, legacy Metro, or pre-UWP Universal apps.
---

# Windows 8.1 And Windows Phone 8.1 Metro Development

## Non-Negotiables

Treat Metro UI rules as harder constraints than code sample habits. The goal is not "flat UI"; it is content before chrome, strong typography, low persistent controls, touch-first command surfaces, fast and fluid transitions, and clear page structure.

Preserve the platform boundary:

- Windows 8.1 Store: large horizontal canvas, Hub/Grid/Split/Detail patterns, AppBar, GridView/ListView, SemanticZoom, variable-width views.
- Windows Phone 8.1: one-hand vertical task flow, Pivot/Panorama, page stack, hardware/system Back, bottom ApplicationBar, single-column lists.
- Universal Projects: share models, view models, services, async loading, commands, resource keys, and navigation intents; keep XAML pages, layout containers, command surfaces, density, settings/search placement, and back behavior platform-specific.

Do not scale a Windows 8.1 Store UI down to phone. Recompose it.

Avoid defaulting to Windows 10+ APIs, `Microsoft.UI.Xaml`, WinUI 3, Windows App SDK, .NET Core/.NET 5+, `NavigationView`, Fluent/Acrylic/Mica styling, or modern Store packaging unless the user asks for migration. Windows 8.1/WP8.1 Universal Projects are not UWP.

## Workflow

1. Make the UI decision first:
   - Determine target: `windows81`, `windowsphone81`, or `shared-universal`.
   - Determine content type: feed, gallery, detail/article, form, dashboard, map/transport, media, settings, or search.
   - Choose page pattern and command surface from `references/mapping/platform-decision-matrix.md`.
   - Apply `references/mapping/win81-to-wp81-ui-map.md` for dual-target work.
   - Reject patterns listed in `references/mapping/anti-patterns.md`.

2. Load UI references before code references:
   - Use `references/design/metro-principles.md`, `typography.md`, `layout-grid.md`, and `accessibility-and-touch.md` for every UI generation or review.
   - Use `references/design/page-patterns.md`, `collection-patterns.md`, `appbar-commanding.md`, `tile-design.md`, `semantic-zoom.md`, and `snapped-and-adaptive-layout.md` when the feature touches those surfaces.
   - Use `references/windows81/*` for Windows Store UI.
   - Use `references/windowsphone81/*` for Windows Phone UI.
   - Use `references/shared/*` for cross-target resource, XAML style, view-model, and naming decisions.

3. Identify the codebase shape:
   - Search for `Package.appxmanifest`, `.sln`, `.csproj`, `.vcxproj`, `.shproj`, `App.xaml`, `MainPage.xaml`, `default.html`, `js/default.js`, `WinJS`, `Windows.UI.Xaml`, `Microsoft.Phone`, and `TargetPlatformVersion`.
   - Confirm whether the app is C#/XAML, C++/XAML, WinJS/HTML, DirectX, Windows Phone Silverlight/XAML, Windows Runtime phone, or a Universal Project.
   - Check manifest capabilities and declarations before adding file, camera, network, search, share, protocol, tile, or phone capabilities.

4. Implement Metro-first behavior:
   - Put Windows 8.1 commands in `TopAppBar`, `BottomAppBar`, `CommandBar`, or WinJS `AppBar`; keep page chrome low.
   - Put Windows Phone 8.1 primary actions in bottom `ApplicationBar` icons and secondary actions under the ellipsis menu.
   - Use `GridView`, `ListView`, grouping, and `SemanticZoom` for Windows 8.1 collections; use phone single-column lists, Pivot, or Panorama for WP8.1.
   - Use async WinRT APIs end to end; never block the UI thread on `.Result`, `.Wait()`, busy loops, or synchronous file/network calls.
   - Persist settings and app state through the platform's existing `ApplicationData`, phone settings, or app state helper.
   - Keep services behind interfaces so shared view models can be tested with mock data.

5. Verify against the target environment:
   - Prefer the repository's existing build and test commands.
   - When Visual Studio 2013/2015, Windows 8.1 SDK, or Windows Phone 8.1 tooling is unavailable, do static validation and state that build verification could not be run.
   - Check that no Windows 10+/WinUI-only APIs slipped into legacy targets.
   - For UI work, check content hierarchy, command placement, touch hit targets, 320/500/wide Windows views, phone portrait, empty/error/loading states, and back behavior.

## Code References

Use code references only after the UI target is settled:

- `references/capability-recipes.md`: fixed Metro capability modules and acceptance checks.
- `references/xaml-csharp-patterns.md`: Windows 8.1 XAML and C++/XAML app structure, navigation, collections, contracts, tiles, and async service patterns.
- `references/winjs-html-patterns.md`: WinJS/HTML Windows Store apps.
- `references/architecture-testing.md`: MVVM, service interfaces, caching, local settings, state restore, and tests.
- `references/directx-input-media.md`: touch/pointer input, games, DirectX interop, media, and sensors.
- `references/source-corpus.md`: source-proven sample families and anti-corpus.

## Output Bar

When producing code, plans, or UI:

- State the target platform and page pattern before giving markup.
- For dual-target output, produce platform-specific UI pages and shared business artifacts separately.
- Name exact APIs, manifest capabilities, pages, services, view models, resource keys, and assets that must change.
- Include XAML or WinJS snippets only when they match the detected app stack.
- Prefer compact, idiomatic Metro UI over web, desktop, Fluent, or phone-scaled tablet layouts.
- Distinguish "source scaffold" from "build-verified project"; legacy Store and Phone apps often require old SDKs and Visual Studio templates.

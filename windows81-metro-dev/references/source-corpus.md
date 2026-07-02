# Source Corpus And Pattern Map

Use this reference when selecting examples to inspect, explaining pattern provenance, or deciding whether a modern sample is appropriate. Prefer pattern extraction over direct copying; respect each repository's license.

UI references are more binding than code samples for visual generation. Code samples can show API order and project structure; UI references decide whether a page is Metro-correct.

## Selection Rule

Use three complementary source groups:

- UI rules: Metro design principles, AppBar/commanding, Grid/Split templates, ListView/GridView/SemanticZoom guidance, Windows Store controls/settings, Segoe UI typography, Windows 8.1 variable view updates, and WP8.1 Pivot/Panorama/ApplicationBar conventions.
- Real project structure: end-to-end apps that show folders, lifecycle, services, navigation, data flow, assets, tests, and packaging.
- Metro/WinRT normative actions: focused samples that demonstrate AppBar, GridView/ListView, SemanticZoom, tiles, charms, async WinRT APIs, touch input, DirectX, and media.

Do not require every source to be an app that was shipped in the Store. Windows 8.1 open source has decayed, so narrowly filtering for published apps makes the corpus too small.

## UI Reference Corpus

| Reference point | Mine it for |
| --- | --- |
| Microsoft Design Principles for Windows Store apps | Pride in craftsmanship, fast and fluid, authentically digital, do more with less, win as one. |
| Windows 8 AppBar and commanding guidance | Hidden/minimal command surfaces, bottom AppBar actions, top AppBar navigation, semantic command grouping. |
| Visual Studio Grid/Split templates | Hub/Grid, Section, Detail, and Split page patterns as visual scaffolding. |
| ListView/GridView/SemanticZoom guidance | Grouped collections, tile rhythm, zoomed-out group navigation, empty states. |
| Windows Store controls/settings guidance | Full-screen and variable-width app behavior, Settings/Search/Share placement, low chrome. |
| Segoe UI typography guidance | Large title hierarchy, section headers, body and metadata scale. |
| Windows 8.1 developer updates | Variable app widths, multiple app views, in-app search expectations, tile size changes. |
| Windows Phone Pivot/Panorama/ApplicationBar guidance | Phone navigation grammar, bottom commands, hardware Back, one-column density. |

## Code And Project Corpus

| Priority | Project | Stack | Mine it for |
| --- | --- | --- | --- |
| A | Hilo C++ sample | C++/XAML/WinRT | End-to-end Store app skeleton, lifecycle, navigation, photo library, async, performance, C++/CX idioms. |
| A | codeShow | HTML/CSS/JavaScript/WinJS | WinJS task recipes, camera, asymmetric ListView, error handling, discrete API demos. |
| A | TokyoSubwayView | C#/XAML/WinRT | Windows 8.1 real-time REST data, refresh state, Json.NET/Rx usage, dense Metro visualization. |
| A- | ItineraryHunter-Win8 | C#/XAML, Kona/Prism style | Business app layering: views, UI logic, services, interfaces, mocks, tests. |
| A- | Office 365 REST API Explorer | C#/Store app/Office 365 | OAuth/token flow, SharePoint REST CRUD, request construction, service errors. |
| B+ | Q42.WinRT | C#/XAML/WinRT support library | API data caching, image caching, local storage, settings, reusable data-layer helpers. |
| B+ | WinRT XAML Toolkit | C#/XAML controls | Calendar, data visualization, gauges, debugging, and control gaps in old XAML. |
| B | Chess | C#/XAML | Board layout, click/touch interaction, small game state machine, simple page state. |
| B | DirectX Marble Maze and Windows 8 samples | C++/DirectX/XAML | Game loop, sensors, touch, media, AppBar, secondary tiles, DirectX/XAML interop. |

## Anti-Corpus

Avoid using these as primary sources for Windows 8.1 Metro guidance:

- Windows 10 UWP apps unless explicitly backporting concepts and verifying API availability.
- WinUI 3, Windows App SDK, .NET 6+, .NET 10, or Fluent-first apps.
- Baconit, Fluent Store, Raven, and similar modern Windows 10/11 projects when the user needs Windows 8.1 behavior.
- Modern Microsoft Learn Fluent design pages as a visual baseline. Use them only for durable basics such as layout, input, typography, and accessibility after checking legacy applicability.

## Learning Order

1. Start with Hilo plus codeShow to learn the full app shape and WinJS recipe library.
2. Add TokyoSubwayView plus Office 365 REST API Explorer for real services, OAuth, REST, refresh/error states, and dense data presentation.
3. Add ItineraryHunter, Q42.WinRT, and WinRT XAML Toolkit for architecture, service interfaces, tests, caching, storage, settings, and control supplementation.
4. Add Chess plus DirectX/Marble Maze samples for touch, board/game state, media, sensors, and DirectX interop.

## Practical Mining Tactics

- Clone or download samples only when needed for the task; keep them in temporary research folders unless the user asks to vendor code.
- Search sample code for API names rather than browsing manually: `AppBar`, `CommandBar`, `SemanticZoom`, `DataTransferManager`, `SearchPane`, `SettingsPane`, `TileUpdateManager`, `SecondaryTile`, `ApplicationData`, `Suspending`, `Resuming`, `WinJS.UI.ListView`, `WinJS.UI.AppBar`.
- Extract project structure, API order, lifecycle handling, and failure-state patterns. Reimplement in the user's code style instead of pasting sample code.
- When a sample targets Windows 8.0, adapt to Windows 8.1 only after confirming the API still exists.
- For dual-target work, inspect shared code patterns separately from UI pages. Treat Win8.1 and WP8.1 XAML as two outputs from one product requirement.

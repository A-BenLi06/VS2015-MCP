# ViewModel Sharing

Use this for Universal Projects and other dual-target code.

## Share

- Models and DTOs.
- View models.
- Validation rules.
- Async service interfaces.
- Command names and intent names.
- Converters when platform APIs are not embedded.
- REST request/response mapping.
- Cache policy and data refresh rules.
- Navigation intent names such as `OpenItem`, `OpenSearch`, `OpenSettings`, `PinItem`.

## Keep Platform-Specific

- XAML pages and controls.
- Navigation containers.
- Command surfaces.
- Back behavior.
- Settings/search/share placement.
- Tile visual payloads when templates differ.
- Visual density and page composition.

## Command Intent Pattern

Use shared command intent names, then bind to platform surfaces:

```text
RefreshCommand
AddCommand
SearchCommand
PinCommand
DeleteCommand
OpenSettingsCommand
```

Windows 8.1 maps these to AppBar or contracts. WP8.1 maps them to ApplicationBar icons, ApplicationBar menu items, or page navigation.

## Navigation Intent Pattern

Use shared intent names but platform-specific routes:

```text
OpenHub
OpenSection(sectionId)
OpenItem(itemId)
OpenSearch(query)
OpenSettings
```

Windows 8.1 may route to Hub/Grid/Split pages. WP8.1 may route to Panorama/Pivot/List/Detail pages.

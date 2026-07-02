# Windows 8.1 Settings, Search, And Share

Use this for system contracts and in-app equivalents.

## Settings

- Use Settings charm or SettingsFlyout for preferences, account, privacy, permissions, and about.
- Keep SettingsFlyout narrow and focused.
- Do not place core business workflows inside settings.
- Provide clear save/apply behavior according to the app's existing convention.

## Search

Windows 8.1 often favors visible in-app search compared with Windows 8's stronger global search emphasis.

- Use app-in-canvas search when discoverability matters.
- Use SearchPane/system activation when the app already integrates with system search.
- Show results with ListView/GridView and clear empty/error states.
- Keep filters in AppBar or a lightweight in-page region, not a permanent desktop sidebar unless required.

## Share

- Use `DataTransferManager` for Share source behavior.
- Validate share content before opening the pane.
- Provide title and appropriate data formats.
- Handle no-shareable-content state clearly.

## Manifest

Check declarations and capabilities before adding contract behavior.

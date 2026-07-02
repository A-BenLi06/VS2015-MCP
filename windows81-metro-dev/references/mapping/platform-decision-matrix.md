# Platform Decision Matrix

Use this before generating UI. State the chosen row values in the plan or reasoning before markup when the user asks for a new UI.

## 1. Target Platform

Choose one:

- `windows81`: Windows 8.1 Store app.
- `windowsphone81`: Windows Phone 8.1 app.
- `shared-universal`: Visual Studio 2013 Universal Project targeting both.

If `shared-universal`, produce shared business artifacts and platform-specific UI artifacts.

## 2. Primary Content Type

Choose the closest primary type:

- feed.
- gallery.
- article/detail.
- form.
- dashboard.
- map/transport.
- media.
- settings.
- search.

## 3. Navigation Pattern

Windows 8.1:

- HubPage.
- GridPage.
- SectionPage.
- SplitPage.
- DetailPage.
- SearchPage.
- SettingsFlyout.

Windows Phone 8.1:

- PanoramaPage.
- PivotPage.
- ListPage.
- DetailPage.
- SearchPage.
- SettingsPage.

## 4. Command Surface

- Windows 8.1: AppBar, CommandBar, context menu, or contract.
- WP8.1: ApplicationBar icon, ApplicationBar ellipsis menu, page navigation, or context menu.

## 5. Density

- Windows 8.1: multi-column allowed when it improves scanning.
- WP8.1: one-column default, low metadata density.

## 6. Required Adaptation

Windows 8.1:

- 320px narrow.
- 500px minimum practical app view.
- wide landscape.
- portrait tablet.

WP8.1:

- phone portrait.
- phone landscape if relevant.
- hardware/system Back behavior.

## Output Template

For UI generation, include:

```text
Target:
Content type:
Navigation pattern:
Command surface:
Density:
Adaptation:
Shared artifacts:
Platform-specific artifacts:
```

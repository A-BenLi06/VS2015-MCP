# Windows Phone 8.1 Layout Patterns

Use this for Windows Phone 8.1 UI, not Windows Store tablet UI.

## Default Mental Model

WP8.1 is a one-hand vertical task flow. The user sees one focused slice at a time and navigates with page stack, Pivot/Panorama, ApplicationBar, and hardware/system Back.

## Core Patterns

- PanoramaPage: broad home or scenic multi-section entry.
- PivotPage: peer sections of similar importance.
- ListPage: single-column list of content or tasks.
- DetailPage: vertical detail reading/acting flow.
- SettingsPage: normal page or in-context settings.
- SearchPage: focused query and single-column results.

## Layout Rules

- Use one primary column by default.
- Keep secondary metadata selective.
- Keep actions reachable near the bottom through ApplicationBar.
- Use Pivot/Panorama headers for section movement.
- Avoid split panes, sidebars, desktop tables, and dense toolbar rows.

## Do Not

- Do not direct-port Windows 8.1 GridView pages.
- Do not force Hub/Grid/Split structures onto phone.
- Do not depend on edge gestures or right click.

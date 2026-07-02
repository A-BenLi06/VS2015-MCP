# Windows 8.1 Layout Patterns

Use this for Windows Store 8.1 UI, not Windows Phone.

## Default Mental Model

Windows 8.1 Store apps are large content canvases. Prefer horizontal information architecture, grouped sections, and visible content breadth.

## Core Patterns

- HubPage: home/channel page with large title and horizontal sections.
- GridPage: grouped tile or visual collection.
- SectionPage: one category or filtered list.
- DetailPage: wide content with related material nearby.
- SplitPage: master-detail when width is sufficient.
- SearchPage: app-in-canvas search results, often grouped.
- SettingsFlyout: preferences, account, privacy, about.

## Layout Rules

- Use a large page title.
- Use section headers to create hierarchy.
- Use GridView/ListView instead of desktop tables for primary content.
- Use horizontal grouping where it reveals breadth.
- Use VisualStateManager for narrow, 500px, wide, and portrait states.
- Collapse SplitPage to list/detail navigation at narrow widths.

## Anti-Fit

Do not use Pivot/Panorama as the default Windows Store navigation model. Those are phone-first patterns.

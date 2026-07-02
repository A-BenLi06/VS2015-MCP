# Page Patterns

Choose one pattern before writing page markup.

## HubPage

Use for home and channel pages.

Windows 8.1:

- Large title.
- Horizontal grouped sections.
- Each section shows 3 to 8 representative tiles or list items.
- No complex forms or dense button clusters.
- Link to SectionPage for full lists.

Windows Phone 8.1:

- Convert broad content areas to Panorama.
- Convert peer tabs with similar weight to Pivot.
- Show one primary section at a time.
- Avoid dense multi-column tiles unless the app is image-heavy.

## SectionPage

Use for a category or filtered list.

Windows 8.1:

- Use GridView for visual collections.
- Use ListView for textual or task-oriented collections.
- Put sort, filter, select, and refresh in AppBar.

Windows Phone 8.1:

- Use single-column ListView-style layout.
- Put primary actions in ApplicationBar icons.
- Put secondary actions under ellipsis.
- Avoid persistent filter panels.

## DetailPage

Use for article, image, product, message, task, route, or record detail.

Windows 8.1:

- Use a wide reading or inspection area.
- Related content can sit beside or below primary content.
- Commands go to AppBar unless always required.

Windows Phone 8.1:

- Use vertical reading flow.
- Put metadata below title or in collapsed sections.
- Primary action goes to ApplicationBar.
- Use hardware/system Back as the main return path.

## SplitPage

Use for mail, contacts, files, settings, or master-detail apps.

Windows 8.1:

- Use list-detail split layout when width is sufficient.
- Keep master list and detail visible together.

Windows Phone 8.1:

- Never force split view.
- Convert to list page plus detail page.
- Preserve selected item when returning.

## SearchPage

Windows 8.1:

- Prefer app-in-canvas search for Windows 8.1 when it improves discoverability.
- Use system search integration only when the app already follows that model.
- Show results in grouped ListView/GridView.

Windows Phone 8.1:

- Prefer a dedicated search page or focused search box.
- Results should be single-column.
- Keep query editing reachable with one hand.

## SettingsFlyout Or SettingsPage

Windows 8.1:

- Use Settings charm or SettingsFlyout for preferences, account, privacy, permissions, and about.
- Do not put primary business workflows in settings.

Windows Phone 8.1:

- Use a normal Settings page or in-context settings screen.
- Do not copy Windows SettingsFlyout behavior to phone.

# Windows 8.1 To Windows Phone 8.1 UI Mapping Rules

## Principle

Do not scale a Windows 8.1 Store app UI down to Windows Phone 8.1. Recompose the experience around the target form factor.

## Shared

Share:

- ViewModels.
- Models.
- Services.
- Async data loading.
- Converters where possible.
- Resource names and semantic color tokens.
- Command names.
- Navigation intent names.

## Platform-Specific

Keep platform-specific:

- XAML pages.
- Layout containers.
- Navigation controls.
- Command surfaces.
- Visual density.
- Back behavior.
- Settings/search placement.

## Page Mapping

### HubPage

Windows 8.1:

- Use Hub/Grid-style layout.
- Use large title, horizontal sections, and GridView/ListView per section.
- Show multiple content groups at once.
- Use SemanticZoom for large grouped collections.

Windows Phone 8.1:

- Convert to Panorama when sections are broad content areas.
- Convert to Pivot when sections are peer tabs with similar weight.
- Show one primary section at a time.
- Avoid dense multi-column tiles unless content is image-heavy.

### SectionPage

Windows 8.1:

- Use GridView for visual collections.
- Use ListView for textual or task-oriented collections.
- Put sort, filter, select, and refresh commands in AppBar.

Windows Phone 8.1:

- Use a single-column ListView-style layout.
- Put primary actions in ApplicationBar icons.
- Put secondary actions under ellipsis.
- Avoid persistent filter panels.

### DetailPage

Windows 8.1:

- Allow wide reading or inspection area.
- Related content can sit beside or below primary content.
- Commands go to AppBar unless always required.

Windows Phone 8.1:

- Use vertical reading flow.
- Put metadata below title or in collapsed sections.
- Primary action goes to ApplicationBar.
- Secondary actions go to ellipsis.
- Use hardware/system Back as the main return path.

### SplitPage

Windows 8.1:

- Use list-detail split layout when width is sufficient.
- Keep master list and detail visible together.

Windows Phone 8.1:

- Never force split view.
- Convert to list page plus detail page.
- Preserve selected item state when returning.

## Command Mapping

Windows 8.1 AppBar:

- Bottom AppBar: add, delete, refresh, select, sort, filter.
- Top AppBar: navigation or section switching when needed.
- Hide commands until invoked when they are not constantly needed.

Windows Phone 8.1 ApplicationBar:

- Primary icon buttons: add, save, search, refresh, accept.
- Ellipsis menu: delete, sort, filter, pin, share, settings.
- Destructive actions usually belong under ellipsis or require confirmation.
- Do not create custom bottom toolbars by default.

## Layout Density

Windows 8.1:

- Prefer large tiles, grouped content, and horizontal breathing room.
- Use multi-column layouts when width allows.
- Show metadata when it improves scanning.

Windows Phone 8.1:

- Prefer one-column flow.
- Show title, primary value, and one or two secondary fields.
- Hide heavy metadata behind details or collapsed sections.
- Avoid tables, sidebars, and multi-pane layouts.

## Navigation Rules

Windows 8.1:

- Use explicit back affordance where appropriate.
- Support variable view widths.
- Preserve layout at 320, 500, and wide breakpoints.

Windows Phone 8.1:

- Hardware/system Back is part of navigation.
- Do not duplicate every back action with a large visible button.
- Back should close transient UI before navigating away.
- Pivot/Panorama swipe should not conflict with horizontal item gestures.

## Visual Rules

Both:

- Use typography as the main hierarchy.
- Avoid glossy gradients, skeuomorphic decoration, heavy borders, and complex shadows.
- Use accent color sparingly.
- Prefer content over chrome.

Windows 8.1:

- Big page title.
- Section headers.
- Wide tiles.
- More whitespace.
- Horizontal grouping.

Windows Phone 8.1:

- Big app/page title.
- Pivot/Panorama headers.
- Vertical rhythm.
- Tighter spacing, but not cramped.
- Readable with one hand and short glance time.

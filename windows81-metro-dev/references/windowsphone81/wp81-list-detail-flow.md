# Windows Phone 8.1 List Detail Flow

Use this when adapting Windows 8.1 Grid/Split pages to phone.

## Flow

Use two pages:

1. ListPage: scan and choose.
2. DetailPage: read, inspect, or act.

## ListPage

- Single-column list.
- Strong primary text.
- One or two secondary fields.
- Optional thumbnail when it materially helps recognition.
- ApplicationBar for add, search, refresh, or filter.

## DetailPage

- Large title.
- Vertical content flow.
- Metadata below title or in sections.
- Primary action in ApplicationBar.
- Secondary actions in ellipsis.

## State Preservation

- Keep selected item highlighted or restored on return when useful.
- Keep scroll offset.
- Keep filters and search query.
- Reload stale data without jarring the user.

## Adaptation

Windows 8.1 SplitPage becomes phone ListPage plus DetailPage. Do not show master and detail side by side on phone.

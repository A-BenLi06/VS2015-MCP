# Collection Patterns

Use this before implementing GridView, ListView, LongListSelector, Pivot sections, or SemanticZoom.

## Windows 8.1

- Use GridView for images, products, albums, destinations, courses, files, and visual tiles.
- Use ListView for messages, tasks, routes, settings, logs, and comparison-oriented text.
- Use grouped data for large collections.
- Use horizontal grouping when it reveals content breadth.
- Use SemanticZoom when group-level jumping reduces navigation effort.

Tile guidance:

- Tiles should expose meaningful content, not just decorative blocks.
- Use a small number of tile sizes within one page.
- Avoid card-like borders, shadows, and rounded web-card styling.
- Prefer photo, title, status, and one useful metadata line.

## Windows Phone 8.1

- Default to one-column lists.
- Use Pivot items for peer sections.
- Use Panorama for broad, scenic, home-level content areas.
- Avoid multi-column grids unless image density is the point.
- Hide heavy metadata behind details.

## States

Every data-backed collection needs:

- Loading.
- Loaded with content.
- Loaded empty.
- Recoverable error.
- Offline or stale data if applicable.

Do not render a blank grid as the only error state.

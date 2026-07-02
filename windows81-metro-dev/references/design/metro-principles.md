# Metro Principles

Use this before generating or reviewing any Windows 8.1 or Windows Phone 8.1 UI. Treat these as hard constraints.

## Design Spine

Apply the Windows Store design principles:

- Pride in craftsmanship: precise alignment, clean edges, intentional spacing, no accidental decoration.
- Fast and fluid: interactions feel direct, responsive, and spatially continuous.
- Authentically digital: use type, motion, color, and content instead of skeuomorphic surfaces.
- Do more with less: remove persistent chrome, redundant labels, ornamental frames, and toolbar clutter.
- Win as one: use platform command surfaces, contracts, typography, and navigation expectations.

## Content Before Chrome

- Put primary content directly on the canvas.
- Hide commands until invoked when commands are not constantly needed.
- Use page titles, section headers, grouping, and content rhythm as the main navigation aids.
- Do not build a desktop shell with permanent menu bars, toolbars, sidebars, breadcrumb rows, and tab strips unless the app category truly requires it.

## Metro Is Not Just Flat

Reject UI that is only visually flat but structurally wrong:

- Flat cards arranged like a modern responsive web page.
- Always-visible toolbar rows.
- Centered mobile-width columns on a wide Windows 8.1 canvas.
- Decorative tile grids with no information hierarchy.
- Fluent, glass, blur, gradients, and heavy elevation.

## Motion

Use motion to explain continuity:

- Page entrance and exit.
- List item appearance or reordering.
- Selection state changes.
- SemanticZoom transitions.
- Pivot/Panorama swipes on phone.

Do not use motion for spectacle. Prefer simple, quick transitions that help users understand where content came from and where it went.

## Preflight Check

Before outputting UI, confirm:

- The page has one obvious content hierarchy.
- Commands are on platform command surfaces, not scattered everywhere.
- The design works with touch first and keyboard/mouse second.
- Typography carries structure without excessive borders.
- Color is sparse, strong, and semantic.
- Windows 8.1 and WP8.1 layouts are recomposed, not scaled copies.

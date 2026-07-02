# Typography

Metro UI depends on type hierarchy more than boxes, borders, or shadows.

## Font

- Use Segoe UI for Windows 8.1 Store and Windows Phone 8.1 UI unless the app has an established brand font.
- Keep text crisp, left-aligned, and readable.
- Prefer type weight, size, and spacing over decorative framing.

## Hierarchy

Use these as practical legacy Metro scale anchors, adapting to existing app styles:

- Page title: very large, around 42pt on Windows 8.1; phone title should still feel large but fit portrait width.
- Section title: around 20pt.
- Body/list primary: around 11pt to 15pt depending on platform and template.
- Secondary metadata and labels: around 9pt to 11pt.

Do not scale font size with viewport width. Use visual states and layout changes instead.

## Text Roles

- Page title: current place or product area.
- Section header: content group, not marketing copy.
- Item primary text: the thing users scan first.
- Item secondary text: date, status, count, location, or source.
- Command labels: short verbs, visible on AppBar/ApplicationBar menu surfaces as platform expects.

## Constraints

- Avoid long all-caps strings except where the existing app template uses them.
- Avoid negative letter spacing.
- Keep button and command labels short enough for localization.
- Let text wrap in content areas, but avoid wrapping command labels into awkward multi-line UI.

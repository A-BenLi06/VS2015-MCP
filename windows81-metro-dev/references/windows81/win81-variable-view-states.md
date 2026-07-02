# Windows 8.1 Variable View States

Use this for Windows 8.1 width adaptation.

## Required Widths

Check layout behavior for:

- 320px narrow.
- 500px minimum practical app view.
- Wide landscape.
- Portrait tablet.

## Recomposition Rules

- Wide: show grouped content and optional split detail.
- Medium: reduce columns and metadata.
- Narrow: use list-first or detail-first page flow.
- Never shrink every tile and font uniformly.

## VisualStateManager

Use named states such as:

```text
Narrow
Medium
Wide
Portrait
```

Keep state changes focused on:

- Grid/list item dimensions.
- Group visibility.
- Split versus stacked layout.
- Metadata visibility.
- Margins and section spacing.

## Verify

- AppBar remains reachable.
- Text does not overlap.
- Selection and scroll context survive width changes.
- Empty/error/loading states fit all widths.

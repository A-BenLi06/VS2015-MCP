# Snapped And Adaptive Layout

Use this for Windows 8.1 variable-width app views and phone portrait adaptation.

## Windows 8.1

Windows 8.1 is not only full-screen. Support variable widths.

Check at least:

- 320px narrow.
- 500px minimum practical Windows Store view.
- Wide landscape.
- Portrait tablet.

Rules:

- Reflow groups; do not only scale.
- Collapse SplitPage into list/detail navigation at narrow widths.
- Reduce visible metadata before reducing readability.
- Keep AppBar commands reachable.
- Preserve selection and scroll position across width changes.

## Windows Phone 8.1

- Use phone portrait as the default.
- Support landscape if the app category needs it.
- Avoid side-by-side panes.
- Let Pivot/Panorama handle horizontal section movement, not dense grids.

## VisualStateManager

- Use named visual states for width and orientation.
- Keep state transitions simple and testable.
- Avoid creating many tiny breakpoints that make behavior unpredictable.

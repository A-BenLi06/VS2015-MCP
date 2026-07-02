# Naming And Resource Rules

Use this when naming files, resources, commands, and navigation across Windows 8.1 and WP8.1.

## Project Structure

Universal Project intent:

```text
Shared/
  Models/
  ViewModels/
  Services/
  Resources/SemanticNames
Windows/
  Views/
  Resources/WindowsValues
WindowsPhone/
  Views/
  Resources/PhoneValues
```

Match the repository's real project structure if it differs.

## Names

- Use semantic names for shared concepts: `RouteStatus`, `TripSummary`, `RefreshCommand`.
- Avoid platform names in shared classes unless the behavior is truly platform-specific.
- Use platform suffixes for page/control implementations only when needed: `HubPage`, `PhoneHubPage`, `WindowsHubPage`.

## Resource Keys

- Prefer purpose-based keys over color names: `AccentBrush`, `WarningBrush`, `SubtleTextBrush`.
- Use shared keys for semantic intent and platform dictionaries for concrete values.
- Keep string resource names shared when text is identical.
- Keep command labels short for localization.

## Asset Rules

- Do not reuse one bitmap size for all tiles and phone assets.
- Keep `ms-appx:///` paths valid for the target project.
- Provide fallback imagery for live tiles and secondary tiles.

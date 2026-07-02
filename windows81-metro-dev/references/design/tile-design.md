# Tile Design

Use this for app tiles, live tiles, secondary tiles, and in-app visual tiles.

## In-App Tiles

- Tiles are content containers, not generic cards.
- Use strong image or color blocks only when they carry information.
- Keep text short and hierarchy clear.
- Prefer square and wide tile rhythm on Windows 8.1.
- Avoid borders, shadows, gradients, glass, and rounded card chrome.

## Live Tiles

- Use Windows 8.1 tile templates compatible with the target.
- Show glanceable content: count, status, latest item, or next action.
- Keep stale or missing data graceful.
- Do not show sensitive data unless the app's privacy model supports it.

## Secondary Tiles

- Use stable tile IDs.
- Use activation arguments that restore a specific item or page.
- Keep logo and display name clear at small sizes.
- Handle create cancellation and unpin/update failures.

## Phone Tiles

- Treat phone tiles as glance surfaces, not miniature dashboards.
- Use readable text and simple imagery.
- Avoid assuming a Windows 8.1 wide tile layout maps to phone.

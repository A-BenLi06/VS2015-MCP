# Windows Phone 8.1 Back Navigation

Use this for phone navigation behavior.

## Principle

Hardware/system Back is part of the phone navigation model. Do not design the phone app as if it were a tablet page with a visible back button everywhere.

## Back Order

Back should close transient UI before leaving the page:

1. Open menu or popup.
2. Selection mode.
3. Search overlay or edit mode.
4. Current page.
5. App exit only from the root page when appropriate.

## Page Stack

- Preserve selected item when returning from detail.
- Preserve scroll position on list pages.
- Preserve query text and filters on search pages.
- Avoid clearing state unless the user explicitly resets it.

## Do Not

- Do not duplicate every Back behavior with a large visible top button.
- Do not let Pivot/Panorama swipes conflict with item gestures.
- Do not make Back perform destructive actions without confirmation.

# Windows 8.1 Semantic Zoom

Use this when a large grouped collection needs group-level navigation.

## Required Shape

- Zoomed-in view: full GridView/ListView content.
- Zoomed-out view: compact group map.
- Group keys: stable, meaningful, and readable.
- Transition: fast and spatially continuous.

## Good Uses

- Photo libraries by date/event.
- Catalogs by category.
- Transport lines by region.
- Courses by department.
- Documents by folder or type.

## Poor Uses

- Small lists.
- Forms.
- Settings pages.
- Phone pages.
- Decorative section overviews with no navigation value.

## Implementation Checks

- Preserve scroll or selected group after zooming.
- Keep item templates lighter in the zoomed-out view.
- Test keyboard, mouse wheel, touch pinch, and accessibility names where the stack supports them.

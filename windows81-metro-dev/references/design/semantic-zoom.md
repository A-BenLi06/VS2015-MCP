# Semantic Zoom

Use SemanticZoom for large grouped Windows 8.1 collections when group-level navigation is a real user need.

## Use When

- The collection has many groups.
- Users need to jump across distant groups.
- A zoomed-out group map is faster than scrolling.
- The group labels are meaningful.

## Do Not Use When

- There are only a few groups.
- The phone target is primary.
- It replaces a clearer Pivot/Panorama phone structure.
- It is only decorative.

## Windows 8.1 Design

- Zoomed-in view: normal GridView/ListView with grouped content.
- Zoomed-out view: compact group tiles or labels.
- Preserve selected group and scroll context when zooming.
- Keep animation simple and spatially explanatory.

## Phone Adaptation

Do not directly port SemanticZoom to WP8.1. Use:

- Pivot for peer categories.
- Panorama for broad home sections.
- Jump list or alphabet grouping when the control stack supports it.
- Search/filter for very large lists.

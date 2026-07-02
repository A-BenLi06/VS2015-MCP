# Anti-Patterns

Use this as a rejection list during UI generation and review.

## Cross-Platform Anti-Patterns

- Do not create a single XAML page and rely only on scaling.
- Do not use desktop-style menus.
- Do not use persistent toolbar rows unless the platform expects them.
- Do not use excessive borders, gradients, shadows, glass, or card chrome.
- Do not put every command directly on the page surface.
- Do not replace platform command surfaces with custom controls without reason.
- Do not mistake flat visual style for correct Metro information architecture.
- Do not use Fluent, WinUI, UWP, or Windows App SDK patterns as defaults for Windows 8.1/WP8.1.

## Windows 8.1 Anti-Patterns

- Do not make every page a narrow phone-style vertical feed.
- Do not waste large landscape space with centered mobile layouts.
- Do not hide high-level content groups behind too many page transitions.
- Do not ignore variable-width app views.
- Do not use Pivot/Panorama as the default Windows Store navigation model.
- Do not replace AppBar with a permanent web toolbar.
- Do not default to dense tables for Metro main views.

## Windows Phone 8.1 Anti-Patterns

- Do not port Windows 8.1 GridView pages directly to phone.
- Do not use multi-pane SplitPage layouts.
- Do not place many small buttons across the content area.
- Do not depend on hover, right click, or edge gestures.
- Do not put dense tables on the main screen.
- Do not make Panorama contain heavy interactive controls in every section.
- Do not copy Windows 8.1 SettingsFlyout behavior to phone.

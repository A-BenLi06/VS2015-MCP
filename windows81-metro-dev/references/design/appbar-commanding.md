# AppBar And Commanding Design

Use this for command placement before choosing XAML or WinJS APIs.

## Principle

Metro does not make toolbars permanently dominate the page. Commands appear through platform command surfaces, selection states, context menus, or contracts.

## Windows 8.1 AppBar

- Bottom AppBar: add, delete, refresh, select, clear, sort, filter, share, pin.
- Top AppBar: navigation, section switching, or app-level context when needed.
- Selection commands should appear when selection mode is active.
- Global commands should sit apart from selection-specific commands.
- Dangerous actions should not sit visually adjacent to the main happy-path action without confirmation.

Suggested grouping:

```text
bottom appbar left:  Select all | Clear | Delete
bottom appbar right: Add | Refresh | Sort | Filter | Share
```

## Windows Phone 8.1 ApplicationBar

- Put the top few primary actions in bottom icon buttons.
- Put secondary actions in the ellipsis menu.
- Use short verbs: add, save, search, refresh, accept.
- Put destructive actions in the menu or behind confirmation.
- Do not replace the ApplicationBar with a custom bottom toolbar unless the app has a strong existing reason.

## Command Design Checklist

- Is this command primary, secondary, contextual, destructive, or global?
- Does the platform surface match the target?
- Can the command be disabled instead of hidden when unavailable?
- Is the command discoverable without polluting the content canvas?
- Does the command placement preserve one-hand use on phone?

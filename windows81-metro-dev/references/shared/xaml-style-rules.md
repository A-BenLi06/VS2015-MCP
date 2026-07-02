# Shared XAML Style Rules

Use this when creating XAML resources for a dual-target Windows 8.1/WP8.1 app.

## Share Semantics, Not Layout

Share resource keys and meaning:

```text
AccentBrush
PageTitleTextStyle
SectionHeaderTextStyle
PrimaryItemTextStyle
SecondaryItemTextStyle
ContentMargin
ItemSpacing
```

Let each platform define the values differently.

## Resource Strategy

- Put semantic names in shared documentation or shared resource dictionaries when the project supports it.
- Put actual measurements, visual states, and control templates in platform projects when they differ.
- Keep image asset names stable across projects when possible.
- Use platform-specific asset sizes for logos, tiles, and app icons.

## Do Not

- Do not share one page-level Grid that only changes width.
- Do not use phone margins and font sizes on Windows 8.1.
- Do not use Windows 8.1 tile grids as phone defaults.
- Do not introduce WinUI or UWP resource names into legacy XAML.

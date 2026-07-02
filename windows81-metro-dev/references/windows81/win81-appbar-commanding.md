# Windows 8.1 AppBar Commanding

Use this for Windows Store AppBar and CommandBar behavior.

## Placement

- Bottom AppBar: most page commands.
- Top AppBar: navigation, section switching, or rare app-level context.
- Context menus: local item actions when AppBar would be too heavy.
- Contracts: Share, Search, and Settings when appropriate.

## Command Groups

Selection commands:

- Select all.
- Clear selection.
- Delete.
- Move.
- Pin selected.

Global commands:

- Add.
- Refresh.
- Sort.
- Filter.
- Search.
- Share.

Keep selection and global commands visually separated.

## Behavior

- Hide AppBar by default when commands are not constantly needed.
- Show relevant commands during selection mode.
- Disable commands when unavailable.
- Confirm destructive operations.
- Keep labels short and icon-led.

## Do Not

- Do not place a permanent toolbar row at the top of every page.
- Do not scatter small command buttons across tiles.
- Do not put destructive actions beside primary create/save actions without separation.

# WinJS/HTML Patterns

Use this for Windows 8/8.1 Store apps built with HTML, CSS, JavaScript, and WinJS.

## Project Shape

Typical WinJS app files:

```text
default.html
package.appxmanifest
css/default.css
js/default.js
pages/home/home.html
pages/home/home.js
pages/home/home.css
images/
```

Preserve local conventions. Many WinJS apps organize each page as an HTML/CSS/JS triplet under `pages/`.

## Lifecycle

Initialize through `WinJS.Application` and process controls after activation:

```javascript
(function () {
    "use strict";

    var app = WinJS.Application;
    var activation = Windows.ApplicationModel.Activation;

    app.onactivated = function (args) {
        if (args.detail.kind === activation.ActivationKind.launch) {
            args.setPromise(WinJS.UI.processAll().then(function () {
                return WinJS.Navigation.navigate("/pages/home/home.html");
            }));
        }
    };

    app.oncheckpoint = function () {
        app.sessionState.navigation = WinJS.Navigation.history;
    };

    app.start();
}());
```

Restore `app.sessionState` during activation for navigation, selection, filters, and in-progress form state.

## Page Controls And Navigation

Define pages with `WinJS.UI.Pages.define`:

```javascript
WinJS.UI.Pages.define("/pages/home/home.html", {
    ready: function (element, options) {
        return viewModel.loadAsync(options).then(function () {
            WinJS.Binding.processAll(element, viewModel);
        });
    },
    unload: function () {
        viewModel.dispose();
    }
});
```

Keep DOM querying local to the page root and dispose event handlers in `unload`.

## AppBar

Use WinJS `AppBar` and `AppBarCommand` for page commands:

```html
<div id="appbar" data-win-control="WinJS.UI.AppBar">
  <button data-win-control="WinJS.UI.AppBarCommand"
          data-win-options="{ id: 'cmdRefresh', label: 'Refresh', icon: 'refresh', section: 'global' }">
  </button>
  <button data-win-control="WinJS.UI.AppBarCommand"
          data-win-options="{ id: 'cmdPin', label: 'Pin', icon: 'pin', section: 'selection' }">
  </button>
</div>
```

```javascript
document.getElementById("cmdRefresh").addEventListener("click", function () {
    viewModel.refreshAsync();
});
```

Keep command labels short and place destructive or rare commands in overflow or secondary command groups where the app pattern supports it.

## ListView, Grouping, And SemanticZoom

Use `WinJS.Binding.List` for observable collections:

```javascript
var items = new WinJS.Binding.List(rawItems);
var grouped = items.createGrouped(
    function (item) { return item.groupKey; },
    function (item) { return { title: item.groupTitle }; },
    function (left, right) { return left.localeCompare(right); }
);

listView.winControl.itemDataSource = grouped.dataSource;
listView.winControl.groupDataSource = grouped.groups.dataSource;
```

Use `WinJS.UI.SemanticZoom` when users need group-level navigation across large collections. Provide item, group header, empty, loading, and error templates.

## Async And Services

Use promises end to end:

```javascript
function getJsonAsync(url) {
    return WinJS.xhr({ url: url }).then(function (response) {
        if (response.status < 200 || response.status >= 300) {
            return WinJS.Promise.wrapError(new Error("HTTP " + response.status));
        }
        return JSON.parse(response.responseText);
    });
}
```

Rules:

- Return promises from page `ready` when loading data.
- Chain errors into visible states, not console-only logs.
- Keep service modules separate from page DOM code.
- Use `Windows.Storage.ApplicationData.current.localSettings` for small settings and `localFolder` for cached payloads.

## Contracts And Tiles

Share:

```javascript
var dataTransferManager = Windows.ApplicationModel.DataTransfer.DataTransferManager.getForCurrentView();
dataTransferManager.addEventListener("datarequested", function (eventArgs) {
    var request = eventArgs.request;
    request.data.properties.title = "Share";
    request.data.setText(viewModel.shareText);
});
```

Tiles:

- Use `Windows.UI.Notifications.TileUpdateManager`.
- Use `Windows.UI.StartScreen.SecondaryTile` for pinning page/item shortcuts.
- Keep activation arguments parseable and versioned.

Settings/search:

- Use `Windows.UI.ApplicationSettings.SettingsPane` for settings charm panes.
- Use `Windows.ApplicationModel.Search.SearchPane` for system search integration in classic WinJS apps.

## Guardrails

- Do not introduce React, bundlers, TypeScript, JSX, or npm-based pipelines unless the repo already uses them or the user asks for a migration.
- Do not replace WinJS navigation with browser SPA routing.
- Keep CSS aligned with Windows 8 typography, edge-to-edge layout, and touch-first command placement.

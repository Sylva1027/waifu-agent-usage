# Getting started

[简体中文](01-getting-started.md) · English

Both v1.0a ZIPs were verified on Windows x64, Ubuntu 24.04 x64, and macOS 15 on Apple Silicon. The package version is `1.0.1`.

- **[Waifu](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0a/1.0a-waifu.zip):** usage and trends, cost estimates, light and dark themes, character skins, sharing, and achievements.
- **[Lite](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0a/1.0a-lite.zip):** usage and trends, source management, quota windows, and history management in a simple dark interface.

[View the v1.0a release](https://github.com/Sylva1027/waifu-agent-usage/releases/tag/v1.0a).

## Install and start

1. Install [Node.js](https://nodejs.org/en/download) 23.8 or newer.
2. Extract your chosen package to a permanent folder. If upgrading, follow the [upgrade guide](15-delivery-upgrade.en.md) to back up your data first.
3. Open a terminal in the extracted package root. Both editions are ready to run with the command below.

```sh
node src/cli.js dashboard
```

The `dashboard` command starts the service in the background and opens its actual URL in your browser. It tries port 3765 first and tries 3766–3770 if that port is in use. On later launches, it tries the last successful fallback port first. To choose a specific port, use `--port` or set `PORT`.

Run `node src/cli.js stop` to stop the background service. If you used `--state-file` to start it, pass the same path when stopping it.

To run in the foreground, use `node src/cli.js run` and open the URL it prints. Press `Ctrl+C` to stop.

## Windows desktop shortcut

Open PowerShell 7 (`pwsh`) in the permanent installation folder. Both runtime packages use `src/cli.js` for `$entryFile`. For Lite from source, use `src/cli-lite.js`. For Lite, set `$shortcutName` to `Agent Usage Lite.lnk`.

```powershell
$entryFile = 'src/cli.js'
$shortcutName = 'Waifu Agent Usage.lnk'
$appDir = (Resolve-Path -LiteralPath .).ProviderPath
$cliEntry = (Resolve-Path -LiteralPath (Join-Path $appDir $entryFile) -ErrorAction Stop).ProviderPath
$nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $desktop $shortcutName))
$shortcut.TargetPath = $nodePath
$shortcut.Arguments = '"{0}" dashboard' -f $cliEntry
$shortcut.WorkingDirectory = $appDir
$shortcut.Save()
```

Double-click the desktop shortcut to open the dashboard. If you move the installation folder, recreate the shortcut from its new location.

## Import sources

Open source management and scan common directories. Select the sources found and choose “Import selected”; if a source is missing, use “Add another location” to select its data directory. Select a directory, rather than an individual log or database file.

Import reads records, builds statistics, verifies them, and updates the dashboard. Closing the dialog does not cancel the import; refresh the page to reconnect to its progress. Choose Today, Week, Month, or another range when it finishes. Both editions interpret dates in the server machine's local timezone.

The dashboard counts confirmed sources only. It checks for new records every 60 seconds by default. Pause auto-refresh to freeze the current data while continuing to change ranges. See [data sources](10-data-sources.en.md) for directories and the [dashboard guide](12-dashboard.en.md) for interface details.

## Data and edition switching

The default data directory is `~/.codex-usage/`, where `~` is your user home. Closing the page or updating program files does not erase usage.

Waifu and Lite use the same usage data and source configuration. Lite preserves existing Waifu prices, skin preferences, and the separate achievement profile, which are available again when you return to Waifu. Stop the old instance before starting the other edition; see [upgrading](15-delivery-upgrade.en.md).

For long-term storage or a new computer, see [backup and transfer](history-retention.en.md). Preserve the Waifu achievement profile as well; see [achievements](achievements.en.md).

## Run from source

The default source entry runs Waifu; Lite has a separate entry:

```sh
node src/cli.js dashboard
node src/cli-lite.js dashboard --port 3766 --home-dir ./output/lite-home --state-file ./output/lite-services.json
```

The second command uses a separate data directory and service registration file for development alongside the default instance. Stop that instance with `node src/cli-lite.js stop --state-file ./output/lite-services.json`. [Development guide](03-development.en.md)

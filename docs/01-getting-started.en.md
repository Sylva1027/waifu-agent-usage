# Getting started

[简体中文](01-getting-started.md) · English

Version 1.0 offers two Windows x64 packages, both with package version `1.0.0`:

- **[Waifu](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0/1.0-waifu.zip):** usage and trends, cost estimates, light and dark themes, character skins, sharing, and achievements.
- **[Lite](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0/1.0-lite.zip):** usage and trends, source management, quota windows, and history management in a simple dark interface.

[View the v1.0 release](https://github.com/Sylva1027/waifu-agent-usage/releases/tag/v1.0).

## Install and start

1. Install [Node.js](https://nodejs.org/en/download) 23.8 or newer.
2. Extract your chosen package to a permanent folder. If upgrading, follow the [upgrade guide](15-delivery-upgrade.en.md) to back up your data first.
3. Open a terminal in the extracted package root and run:

```sh
node src/cli.js run
```

Open [http://127.0.0.1:3765/](http://127.0.0.1:3765/) or the address printed in the terminal. Both packages use the same command and require no `npm install` or compilation. Keep the terminal open and press `Ctrl+C` to stop; run the same command from the same folder to start again.

If the port is in use, specify another one:

```sh
node src/cli.js run --port 3766
```

Windows command examples use PowerShell 7 (`pwsh`).

## Import sources

Open source management and scan common directories. Select the sources found and choose “Import selected”; if a source is missing, use “Add other location” to select its data directory. Select a directory, rather than an individual log or database file.

Import reads records, builds statistics, verifies them, and updates the dashboard. Closing the dialog does not cancel the import; refresh the page to reconnect to its progress. Choose Today, This Week, This Month, or another range when it finishes. Both editions interpret dates in the server machine's local timezone.

The dashboard counts confirmed sources only. It checks for new records every 60 seconds by default. Pause auto-refresh to freeze the current data while continuing to change ranges. See [data sources](10-data-sources.en.md) for directories and the [dashboard guide](12-dashboard.en.md) for interface details.

## Data and edition switching

The default data directory is `~/.codex-usage/`, where `~` is your user home. Closing the page or updating program files does not erase usage.

Waifu and Lite use the same usage data and source configuration. Lite preserves existing Waifu prices, skin preferences, and the separate achievement profile, which are available again when you return to Waifu. Stop the old instance before starting the other edition; see [upgrading](15-delivery-upgrade.en.md).

For long-term storage or a new computer, see [backup and transfer](history-retention.en.md). Preserve the Waifu achievement profile as well; see [achievements](achievements.en.md).

## Run from source

The default source entry runs Waifu; Lite has a separate entry:

```sh
node src/cli.js run
node src/cli-lite.js run --port 3766 --home-dir ./output/lite-home --state-file ./output/lite-services.json
```

The second command uses a separate data directory and service registration file, suitable for development alongside the default instance. See the [development guide](03-development.en.md) for dependencies, tests, and packaging.

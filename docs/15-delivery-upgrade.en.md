# Upgrading and rollback

[简体中文](15-delivery-upgrade.md) · English

Version 1.0b offers **Waifu Usage** (full) and **Agent Usage** (Lite), both with package version `1.0.2`. Both continue to use the existing usage data directory and source configuration.

To switch from v1.0a, stop the current instance, replace the program files using the new ZIP for the same edition, and restart with your existing options.

- [Download 1.0b-waifu.zip](https://github.com/Sylva1027/waifu-usage/releases/download/v1.0b/1.0b-waifu.zip)
- [Download 1.0b-lite.zip](https://github.com/Sylva1027/waifu-usage/releases/download/v1.0b/1.0b-lite.zip)
- [v1.0b release](https://github.com/Sylva1027/waifu-usage/releases/tag/v1.0b)

Both ZIPs are ready to run with Node.js `>=23.8`. See [getting started](01-getting-started.en.md) for first-time setup and verified platforms.

## Upgrade while preserving data

1. **Extract the new package to a new program directory.** Keep the old program for now; do not overwrite files in use.
2. **Stop the old instance.** For a foreground process, press `Ctrl+C` in its terminal. For a background instance, run `node src/cli.js stop` from the old directory; if it was started with `--state-file`, use the same argument when stopping. This command stops all instances in that registration file, so ensure they can all be stopped first.
3. **Back up after it stops.** Copy the entire `~/.codex-usage/` directory to a new backup location. Also preserve custom locations and external history as described below.
4. **Start from the new directory using the original options.** Both packages use `node src/cli.js run`; retain any custom home, port, or service registration file arguments. The existing index migrates automatically; initial preparation may take longer.
5. **Check before continuing.** Review the All range, older months, sources, and new records; in Waifu also check pricing and achievements. Keep the old program and the complete pre-upgrade backup until the new installation is stable.

Default startup:

```sh
node src/cli.js run --host 127.0.0.1 --port 3765
```

`~` is the current user's home. `--home-dir` affects default data and configuration locations; retain its previous value rather than pointing it at an empty directory for the upgrade. Do not delete the usage index or manually change the database version as a substitute for migration.

## What to preserve

The default `~/.codex-usage/` contains the usage index, source configuration, service registration, and Waifu pricing and achievement profiles. Stop the service before copying the entire directory, including any remaining SQLite `-wal` and `-shm` files.

Also back up custom usage databases, configuration files, and external history:

- **Main usage database:** it can contain indexed history already removed upstream; raw session logs alone are insufficient.
- **External cold packages and adjacent manifests:** retain the complete directories; the main SQLite file alone omits archived history.
- **Achievement profile:** `achievements.sqlite` by default; with a custom usage database, the program names the profile beside that database. It is not a rebuildable cache.
- **Compaction mapping and old and new packages:** after compaction, keep `compaction.json` and its referenced files until the rollback window ends.

History commands can create verifiable usage backups or complete bundles, but source configuration and other local files must still be preserved separately. See [backup and transfer](history-retention.en.md).

## Switch between Waifu and Lite

Stop the current instance, then start the other edition using the same data location.

Lite preserves existing usage, source configuration, price files, browser skin preferences, and achievement profiles. Achievement evaluation pauses while you use Lite. On return to Waifu, the original profile identity, activation time, earned dates and read state carry forward. Verifiable usage from the Lite period counts toward achievements. Share and character achievements use actions recorded in the profile.

Both dashboards use the server machine's local timezone; the old UTC selection no longer affects dates. Lite uses a fixed dark theme. Waifu resumes its light/dark and character preferences. Raw timestamps and an achievement profile's fixed calendar retain their original values.

New Lite history packages use v3 without pricing; both editions continue to read v1, v2, and v3. Full achievement restoration is explicitly available in Waifu; see [history formats](history-retention.en.md#history-format-compatibility) and [achievement backups](achievements.en.md).

## Restore and roll back the program

History restore writes to a new target file or directory and does not switch a running service. To restore backed-up achievements with Waifu, explicitly add `--with-achievements`; ordinary restore only restores usage.

To return to an older program, stop the new instance and preserve its complete data first. Restore the **old program and complete pre-upgrade data copy** to a separate location. Do not let the old program open the upgraded active database directly. The old copy lacks records added or revised since upgrading, so retain the complete upgraded state too.

Archive compaction rollback switches references back using the current main database and original `compaction.json`; it is distinct from program rollback. See [compaction and rollback](history-retention.en.md#archive-compaction-and-rollback).

## Build from source

See [development](03-development.en.md#packaging) for dependencies, the Windows helper, and both packages. Release packages include the matching helper and build receipt; source developers can [build and check it](03-development.en.md#windows-helper).

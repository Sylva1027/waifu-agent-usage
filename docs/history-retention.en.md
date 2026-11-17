# History backup and transfer

[简体中文](history-retention.md) · English

Successfully indexed usage remains queryable even if its source files disappear. For long-term storage or a new computer, back up the usage database; use a complete bundle if external cold history is registered. Preserve source configuration and other local settings separately as described in [upgrading](15-delivery-upgrade.en.md).

## Backup and ordinary restore

Run these commands from the extracted package root; use PowerShell 7 on Windows. The examples read the default usage database. Backup and restore targets must be new paths:

```powershell
$usageDB = Join-Path $env:USERPROFILE '.codex-usage/usage-index.sqlite'
node src/cli.js history backup $usageDB ./usage-backup.sqlite
node src/cli.js history verify ./usage-backup.sqlite
node src/cli.js history restore ./usage-backup.sqlite ./usage-restored.sqlite
```

The backup includes committed WAL contents. Keep the resulting database, adjacent manifest, and all attachments together. Ordinary restore only restores usage, does not overwrite an existing target, and does not automatically switch the active service.

If external cold segments are registered, a single-database backup refuses to omit them; use a complete bundle instead. Waifu backups also include an existing achievement profile; restoring it requires an explicit full restore. See [achievements](achievements.en.md).

## Export and import a complete bundle

```powershell
$usageDB = Join-Path $env:USERPROFILE '.codex-usage/usage-index.sqlite'
node src/cli.js history export $usageDB ./usage-bundle
node src/cli.js history import ./usage-bundle ./usage-imported
```

A bundle contains the main database, registered cold segments, and each package's declared context and attachments. Import verifies it and produces a new query instance directory. Keep the entire bundle when moving it; the main SQLite file alone is insufficient. If using a custom configuration location, export can take the original `--home-dir` argument.

To view imported data, use the import server factory to load its frozen context. Run this from the package root and open `http://127.0.0.1:3766/`; press `Ctrl+C` to stop:

```powershell
node --input-type=module -e 'import { createHistoryArchiveImportServer } from "./src/server.js"; const server = await createHistoryArchiveImportServer("./usage-imported"); server.listen(3766, "127.0.0.1");'
```

Both release packages import this factory from `src/server.js`; when developing Lite from source, use `src/server-lite.js`. Do not merely point a normal server's database path at the imported runtime.

A Waifu import instance uses the package's frozen pricing and service-tier context. It does not start price updates or achievements and does not allow price changes. For a v3 package without pricing, available pricing is captured once during initialization and then frozen. Ordinary hot/cold history queries still use the current query pricing context, rather than pricing each cold segment separately.

## History format compatibility

- **v1:** a usage package that must contain a complete pricing snapshot.
- **v2:** a usage package with an achievement attachment; pricing is still required and the attachment is validated according to its own format.
- **v3:** supports the absence of pricing. New Lite backups, exports, and archives use this format with pricing, pricing version, and check time explicitly null; the achievement field is null or a valid attachment record.

Both editions can verify, import, and compact v1, v2, and v3. A damaged v1/v2 missing pricing must not be treated as a Lite package. Ordinary Waifu backups with pricing use v1, or v2 when achievements are included.

Lite does not include an adjacent active achievement profile in its new backups. When transferring an older package it still validates and preserves declared pricing, service tiers, and achievement attachments, without activating those profiles. Full restore with `--with-achievements` is available only in Waifu.

The history commands below use `src/cli.js` in both release packages; Lite source uses `src/cli-lite.js`. Existing `~/.codex-usage/`, indexes, and source configuration remain compatible without manual renaming or deletion.

## History files and retention

- **Main database:** recent facts, source identities, quota, cold-segment registration, and revision overlays.
- **Cold packages and adjacent manifests:** archived facts, summaries, declared context, and attachments.
- **`.history-cache/`:** rebuildable query projections, not a substitute for the main database or cold packages.
- **`compaction.json` and old and new packages:** recovery from interrupted compaction and rollback.

Automatic archiving is disabled by default. Full queries fail if a cold package is missing or damaged; retry after restoring the original file. Archive details preserve their original values, while the main summary applies effective revisions. Hermes cumulative-row revisions and deletions update the current summary; if the entire database becomes unreadable or disappears, previously indexed history is retained.

## Manual archiving

`dry-run` only checks and reports whether archiving conditions are met. Default thresholds are 400,000 events and a 180-day boundary:

```powershell
node src/cli.js history archive ./history/source.sqlite --dry-run
```

<details>
<summary>Create and commit an archive candidate</summary>

Back up first and work on a separate copy. Use [history-archive.js](../src/history-archive.js) to create and verify a candidate with an explicit half-open interval `[startMs, endMs)`:

```js
import { DatabaseSync } from "node:sqlite";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "./src/history-archive.js";

const source = new DatabaseSync("./history/source.sqlite", { readOnly: true });
try {
  await createHistoryArchiveCandidate(source, "./history/cold.sqlite", {
    startMs: Date.parse("2026-01-01T00:00:00Z"),
    endMs: Date.parse("2026-02-01T00:00:00Z"),
  });
  await verifyHistoryArchiveCandidate("./history/cold.sqlite");
} finally {
  source.close();
}
```

After running that code as ESM from the package root, commit the candidate. The backup target must also be a new directory:

```powershell
node src/cli.js history archive ./history/source.sqlite --commit ./history/cold.sqlite --backup ./history/precommit-bundle
```

Before committing, the candidate is rechecked and a complete pre-commit backup is created and verified. The cold segment is then registered and its hot facts removed. Events without valid times or outside the interval remain in the main database. The cold package and adjacent manifest are now part of the history and must be retained together.

</details>

## Archive compaction and rollback

Compaction reclaims unused pages inside cold packages while preserving logical facts, IDs, each package's original pricing or no-pricing marker, and attachments. Normal startup and refresh do not compact automatically.

First stop writes and queries for the instance and back up the complete history. The initial target directory must not exist:

```powershell
node src/cli.js history compact ./history/source.sqlite ./history/compacted

# Roll back with the current main database and the same mapping,
# retaining additions and revisions made after compaction.
node src/cli.js history compact ./history/source.sqlite ./history/compacted --rollback
```

Explicit switching requires the matching Windows helper and available file leases; see [development](03-development.en.md#windows-helper) for building and checking it. If protection is unavailable or verification fails, registration is not switched and old history remains intact.

The command creates new packages and `compaction.json`, then updates query projections after switching references. If interrupted with a complete mapping, rerun the same command to resume recovery. Preserve incomplete residual directories for investigation and use a new directory to start over.

Compaction creates additional packages and does not delete old ones. Reclaim old packages only after confirming the result, allowing the rollback window to end, and ensuring no other main database, bundle, or frozen snapshot references the old paths. Compaction rollback uses the current main database and original mapping; do not overwrite the current main database with an old one.

## Developer interfaces

<details>
<summary>History query and import HTTP endpoints</summary>

- `GET /api/history/archives`: cold-segment listing and availability.
- `GET /api/history/archives/<segmentId>/days`: original archived daily data.
- `GET /api/history/archives/<segmentId>/events?startMs=<ms>&endMs=<ms>&limit=100&afterId=0`: detail pages by original ID; `limit` is 1–500 and the returned `nextAfterId` continues pagination.
- GET requests can add `snapshot=<id>` to use an existing frozen snapshot; an expired snapshot returns 410.
- `POST /api/history/imports`: JSON supplies `sourceDirectory` and a new `importDirectory`; success returns 201, an existing target returns 409, and the current service is not switched.

Import instances do not provide full detail (400) or allow pricing changes (405). Manage history through the CLI; there is no separate archive maintenance panel on the dashboard.

</details>

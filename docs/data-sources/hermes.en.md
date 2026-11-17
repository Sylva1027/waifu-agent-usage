# Hermes data source

[简体中文](hermes.md) · English

Cumulative usage is read from `state.db` in each home. Defaults are `%LOCALAPPDATA%/hermes` on Windows and `~/.hermes` on macOS/Linux. `HERMES_HOME` and named profiles under the default root are also discovered.

`CODEX_USAGE_HERMES_HOMES` adds directories and `CODEX_USAGE_HERMES=0` disables automatic discovery. Import the home containing the database; it is read after scan and confirmation. See [data sources](../10-data-sources.en.md).

## Values and time

Each `session_model_usage` row is a cumulative ledger for a session, model, route, and task, including main-loop and auxiliary calls:

- Input is ordinary input plus cache reads and cache writes.
- Output includes reasoning; cache reads belong to input.
- A session without model-usage rows uses session totals under Unknown model. When model rows exist, session totals are not added again.

The cumulative row's last activity time is used. As a long session continues, the date to which its entire row is attributed may move. Ledger row count is not the number of underlying HTTP requests. Database default zeroes do not prove a provider reported every detail completely.

The difference between session totals and the model ledger is a source diagnostic, not extra usage or cost. Channels are identified by source as Hermes/Hermes Subagent; repositories use the recorded Git root or working directory, or Unknown if absent. Hermes does not enter Codex quota windows.

Waifu estimates cost using the lowest feasible scenario: cumulative totals and last activity time cannot establish per-request context or time windows. A native Codex path in Hermes may overlap separately imported Codex logs; source filtering can avoid selecting duplicates.

## Updates and history

The adapter queries usage and required metadata read-only, without reading message bodies, system prompts, model configuration, or credentials. Sync reads a consistent cumulative-ledger snapshot, retries source changes, and retains the last successful result.

Row revisions or deletions within the database update current statistics; old facts retain recovery evidence. If the database becomes unreadable or disappears, indexed history remains. Later cold-history revisions use the existing revision mechanism; complete bundles include cold segments and revisions, and frozen snapshots are independent of later changes. See [history retention](../history-retention.en.md).

Development: [hermes-usage.js](../../src/hermes-usage.js) and [Hermes tests](../../test/hermes-usage.test.js).

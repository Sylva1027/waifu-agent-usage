# Codex data source

[简体中文](codex.md) · English

Select the Codex home in source management; the default is `~/.codex`. Local JetBrains integration directories are also scanned. Add directories with `CODEX_USAGE_HOMES`. See [data sources](../10-data-sources.en.md) for import.

## Logs and usage

The adapter reads `.jsonl` and `.jsonl.zst` under `sessions/` and `archived_sessions/`. When both formats with the same name exist, `.jsonl` takes precedence. Compressed logs are streamed.

Session headers supply IDs, working directories, and client sources; the model comes from request context. Token records may contain cumulative or most-recent-request usage. When a session continues across files, cumulative values are converted to increments rather than summed line by line. Cache hits belong to input; reasoning belongs to output.

Trustworthy most-recent-request input is used for context decisions; cumulative input cannot substitute for a single request's context. Missing cache-write or service-tier details remain unknown rather than being filled with zero or a definite tier.

## Quota windows

Local quota records provide five-hour/weekly windows and reset boundaries. Only eligible native Codex usage enters quota windows; other tools using the same model do not qualify. See [dashboard quotas](../12-dashboard.en.md#time-ranges-and-quotas) for authentication and routing filters and optional account boundary recovery.

Ordinary date ranges retain all selected Codex usage. Costs and quota percentages follow their own rules; filtered tokens do not rewrite account percentages.

## Index and updates

The initial import builds the index. Later reads use checkpoints after verifying source continuity; truncation, rewriting, or format changes trigger revalidation. Normal filters query the committed index and do not display partial background syncs.

Reader upgrades may rescan older logs while preserving existing history and original files. There is no need to delete the index; see [history backup](../history-retention.en.md).

Development: [usage-core.js](../../src/usage-core.js), [usage-fact-store.js](../../src/usage-fact-store.js), and [Codex tests](../../test/usage-core.test.js).

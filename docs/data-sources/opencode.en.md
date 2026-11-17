# OpenCode data source

[简体中文](opencode.md) · English

The adapter scans `opencode*.db` in these data directories. Import the directory, not the database file:

- `~/.local/share/opencode`
- `%APPDATA%/opencode`
- `%LOCALAPPDATA%/opencode`
- `~/Library/Application Support/opencode`

`CODEX_USAGE_OPENCODE_HOMES` adds directories and `CODEX_USAGE_OPENCODE=0` disables automatic discovery. See [data sources](../10-data-sources.en.md).

## Format compatibility

V2 message databases with `session_v2` and `session_message` are supported. Earlier `session / message / part` and JSON-tree layouts are not integrated.

Required message-table columns are checked before parsing; databases missing them are skipped with a reason. Sessions with a major version below 2 are skipped to avoid double-counting reasoning under older output semantics. Missing or unrecognized versions are attempted with a notice.

Events are extracted only from assistant-message `data.tokens`, without adding session aggregates again. Messages without tokens are skipped. All currently display as OpenCode, without splitting subagents by parent session or agent; they do not enter Codex quota windows.

## Token mapping

V2 ordinary input, cache, and reasoning are separate counts:

```text
total input = tokens.input + tokens.cache.read + tokens.cache.write
cache hit = tokens.cache.read
total output = tokens.output + tokens.reasoning
reasoning = tokens.reasoning
total = total input + total output
```

Missing cache writes remain unknown. Reasoning is already included in total output and is not added again in statistics or pricing. Single-message total input is used for context decisions.

Message completion time takes precedence, falling back to creation time. The model comes from `data.model.id`, provider from `providerID`, and working directory and title from `session_v2`.

`cost: 0` in a log does not prove the model is free. Waifu uses effective model prices and explicit free rules; see [pricing](../11-pricing.en.md#model-resolution-and-free-rules).

## Updates and reading

A data directory may contain multiple databases, each registered as a source. Change detection checks both the main database and WAL. Stability is verified before and after reads; data is rescanned when it cannot be reused.

Message bodies may enter memory while parsing `data`, but normalized events retain only usage, model, time, and required metadata, not content, snapshots, or provider state. SQLite is opened read-only first; a normal open is attempted on failure and may involve recovery or auxiliary files.

Development: [opencode-usage.js](../../src/opencode-usage.js) and [OpenCode tests](../../test/opencode-usage.test.js).

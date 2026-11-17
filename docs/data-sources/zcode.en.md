# ZCode data source

[简体中文](zcode.md) · English

The default home is `~/.zcode`; the adapter probes `cli/db/db.sqlite`, then `db/db.sqlite`. Select the home on import. `CODEX_USAGE_ZCODE_HOMES` adds directories and `CODEX_USAGE_ZCODE=0` disables automatic discovery. See [data sources](../10-data-sources.en.md).

## Field mapping

Usage is read from `model_usage`; the session table supplies working directory, title, and parent-session attribution. Usage is still attempted when session metadata is missing.

- Input: `input_tokens`.
- Cache reads: `cache_read_input_tokens`.
- Cache writes: `cache_creation_input_tokens`.
- Output: `output_tokens`; reasoning: `reasoning_tokens`.
- Total: `computed_total_tokens` first, then `provider_total_tokens`, then input plus output.
- Time: `completed_at` first, then `started_at`; records without valid time are skipped.

Missing fields are distinct from actual zeroes; conflicting details are not treated as reliable. There is not enough upstream database-write evidence to establish the complete inclusion relationship between input and cache reads/writes. The mapping above is retained, without adding cache just because a model is called Claude. See [pricing](../11-pricing.en.md) for Waifu estimates.

## Channels and reading

`query_source` of `subagent` or `task_type` of `subagent_child` is labeled ZCode Subagent and grouped under ZCode in ordinary ranges. Repository attribution comes from the session or parent-session directory, not model name. ZCode does not enter Codex quota windows.

Change detection checks the main database and WAL. SQLite is opened read-only first; a normal open is attempted on failure and may involve recovery or auxiliary files. Upstream usage records are not intentionally rewritten.

Development: [zcode-usage.js](../../src/zcode-usage.js), [ZCode tests](../../test/zcode-usage.test.js), and [three-path parity tests](../../test/three-path-parity.test.js).

# Claude Code data source

[简体中文](claude-code.md) · English

The default home is `~/.claude`; the directory specified by `CLAUDE_CONFIG_DIR` is also scanned. `CODEX_USAGE_CLAUDE_HOMES` adds locations and `CODEX_USAGE_CLAUDE=0` disables automatic discovery. Select the home directory when importing; see [data sources](../10-data-sources.en.md).

## Main sessions and subagents

The adapter reads:

- `projects/<encoded-cwd>/<sessionId>.jsonl`
- `projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl`

Subagent usage contributes to totals and is grouped under Claude Code, using the parent session ID to avoid inflating session counts. `tool-results/`, `memory/`, and non-JSONL files are skipped. This source does not enter Codex quota windows.

## Deduplication and fields

Only assistant records with `message.usage` are processed. A message may be written as several content-block rows: deduplicate by `message.id` and keep the record with the largest token sum. If the ID is missing, fall back to the record `uuid` and report a hint.

Claude's ordinary input, cache reads, and cache writes are separate counts:

```text
total input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
cache hit = cache_read_input_tokens
output = output_tokens
reasoning = output_tokens_details.thinking_tokens (when present)
total = total input + output
```

Single-request total input determines context. `usage.speed: "fast"` or the corresponding service-tier field identifies Fast; missing details remain unknown.

The response's `message.model` takes precedence; only missing or placeholder values fall back to `requestedModel`. The latter may be a request routing or tier alias rather than the actual serving model. Unknown Claude versions remain unpriced; see [model resolution](../11-pricing.en.md#model-resolution-and-free-rules).

Cache-write TTL is not yet persisted to the event. Nonzero writes are estimated with the 5-minute scenario and explained in cost details; this is not an exact 1-hour cache bill.

## Updates and retention

Main sessions and subagents are indexed. Source verification determines whether appended, revised, or replaced records are handled incrementally or reread. Invalid JSON lines are reported while other records continue.

Upstream retention may remove transcripts; indexed history is preserved and a later rescan should not be relied on to restore all records. Upgrades migrate the existing index; see [history retention](../history-retention.en.md).

Only usage, model, session, and necessary metadata enter normalized events, not message bodies or tool content. See [file reading](../10-data-sources.en.md#how-files-are-read).

Development: [claude-code-usage.js](../../src/claude-code-usage.js), [Claude Code tests](../../test/claude-code-usage.test.js), and [three-path parity tests](../../test/three-path-parity.test.js).

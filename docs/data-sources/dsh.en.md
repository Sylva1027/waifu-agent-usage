# DSH (DeepSeek Harness) data source

[简体中文](dsh.md) · English

The default home is `~/.dsh`, with logs at `sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`. Select the home on import. `CODEX_USAGE_DSH_HOMES` adds directories and `CODEX_USAGE_DSH=0` disables automatic discovery. See [data sources](../10-data-sources.en.md).

## Supported records

Multi-frame zstd logs with `formatVersion: 4` are supported; other versions are skipped with a reason. Subagents have separate session directories. `delegationDepth > 0` is labeled DSH Subagent and grouped under DSH in ordinary ranges.

- `session`: session ID, working directory, and subagent depth.
- `request/header`: model and provider for the request; `request/context` is the fallback.
- `session/title`: most recent session title.
- `assistant/message` `data.usage`: usage source.

Tool calls and results are not usage events. DSH does not enter Codex quota windows.

## Token mapping

Ordinary input, cache reads, and cache writes are separate, so total input is reconstructed:

```text
total input = inputTokens + cacheReadTokens + cacheWriteTokens
cache hit = cacheReadTokens
output = outputTokens
total = totalTokens (or total input + output when missing)
```

Nonzero cache writes are included in total and single-request input; do not omit them or add them to total a second time. For example, ordinary input 1,000, cache reads 8,000, cache writes 1,000, and output 500 yield total input 10,000 and total 10,500.

DSH does not separately report reasoning or service tier, which remain unknown. Reconstructed per-request input is used for context tiers. See [pricing](../11-pricing.en.md) for Waifu cache-write scenarios.

## Updates and parsing

Logs are indexed per file and compressed records are processed frame by frame; bad frames produce warnings. Parser checkpoints can be reused after continuity is verified. Truncation, rewriting, or unproven continuity triggers rereading. Upgrades migrate the index without deleting history.

Parsing writes only usage, model, and necessary metadata to normalized events; message bodies and tool content are not statistics fields.

Node.js `>=23.8` is required. Development: [dsh-usage.js](../../src/dsh-usage.js) and [DSH tests](../../test/dsh-usage.test.js).

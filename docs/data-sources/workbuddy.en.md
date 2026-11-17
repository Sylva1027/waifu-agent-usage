# WorkBuddy data source

[简体中文](workbuddy.md) · English

The default home is `~/.workbuddy-ai`; transcripts are read from `projects/<cwd-slug>/<sessionId>.jsonl`. Select the home directory on import. `tool-results/` and non-JSONL files are skipped.

`CODEX_USAGE_WORKBUDDY_HOMES` adds directories and `CODEX_USAGE_WORKBUDDY=0` disables automatic discovery. WorkBuddy and Claude Code directories have similar shapes, so scanning also distinguishes their content markers. See [data sources](../10-data-sources.en.md).

## Records and deduplication

Only `function_call` or `message` records with `providerData.usage` and `providerData.messageId` are read. A response may be written on multiple lines; deduplication by `providerData.messageId` within the file produces one event.

Records with model `default-model` or request model Auto are excluded entirely from usage and costs; other records in the file remain. WorkBuddy does not enter Codex quota windows.

## Token mapping

In supported transcripts, ordinary input and output fields are already totals:

- Input: `providerData.usage.inputTokens`, already including cache hits.
- Cache hits: `inputTokensDetails[0].cached_tokens`.
- Output: `providerData.usage.outputTokens`, already including reasoning.
- Reasoning: `outputTokensDetails[0].reasoning_tokens`.
- Total: `usage.totalTokens`.
- Cache writes: `providerData.rawUsage.cache_creation_input_tokens`, retaining actual value and known state.

Do not add `message.usage` or other duplicate counts. The model is the actual routed model; single-request input determines context. Missing fields remain unknown.

## Notes

Deduplication is per file; copying the same session into multiple source files may count it more than once. Missing service tier remains unknown. `ai-title` is excluded, and the session title is empty.

Development: [workbuddy-usage.js](../../src/workbuddy-usage.js) and [WorkBuddy tests](../../test/workbuddy-usage.test.js). See [pricing](../11-pricing.en.md) for Waifu cost rules.

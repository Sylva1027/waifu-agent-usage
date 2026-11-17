# Data sources and usage accounting

[简体中文](10-data-sources.md) · English

Waifu and Lite use the same source and token accounting rules. Cost estimates are available in Waifu; see the [pricing guide](11-pricing.en.md).

## Scan and import

Open source management to scan common local directories, select sources, and choose “Import selected”. You can also choose another directory. Import accepts a tool's home, data directory, or project directory, rather than individual database or JSONL files.

Dashboard refresh and background watching read only confirmed sources. Import them on a new installation; retain confirmed directories and source identities when upgrading. Import reads records, builds statistics, verifies them, and updates the dashboard. Closing the dialog does not cancel it; refresh to reconnect. A failed import can be retried without counting confirmed events twice.

Supported sources:

- [Codex](data-sources/codex.en.md): session logs in `~/.codex`, including JetBrains integration directories.
- [ZCode](data-sources/zcode.en.md): SQLite usage databases under `~/.zcode`.
- [DSH](data-sources/dsh.en.md): compressed session logs under `~/.dsh`.
- [OpenCode](data-sources/opencode.en.md): `opencode*.db` in its data directory; v2 message databases are supported.
- [Claude Code](data-sources/claude-code.en.md): main and subagent transcripts under `~/.claude/projects/`.
- [WorkBuddy](data-sources/workbuddy.en.md): transcripts under `~/.workbuddy-ai/projects/`; Auto records are excluded.
- [Hermes](data-sources/hermes.en.md): cumulative usage ledgers in each home's `state.db`.
- **Project usage logs:** import a project directory containing `.codex-usage/usage.jsonl` to read recorded usage.

`~` is the current user's home. Scan candidates also include locations specified by `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_DATA_HOME`, and `HERMES_HOME`.

<details>
<summary>Additional directories and environment variables</summary>

Use these variables to add source directories:

- Codex: `CODEX_USAGE_HOMES`
- ZCode: `CODEX_USAGE_ZCODE_HOMES`
- DSH: `CODEX_USAGE_DSH_HOMES`
- OpenCode: `CODEX_USAGE_OPENCODE_HOMES`
- Claude Code: `CODEX_USAGE_CLAUDE_HOMES`
- WorkBuddy: `CODEX_USAGE_WORKBUDDY_HOMES`
- Hermes: `CODEX_USAGE_HERMES_HOMES`
- Other import directories: `CODEX_USAGE_IMPORT_DIRS`

Separate multiple paths with the system separator: `;` on Windows, `:` on macOS/Linux. Explicitly configured sources are treated as confirmed. CLI summaries automatically discover default sources.

Set `CODEX_USAGE_ZCODE=0`, `CODEX_USAGE_DSH=0`, `CODEX_USAGE_OPENCODE=0`, `CODEX_USAGE_CLAUDE=0`, `CODEX_USAGE_WORKBUDDY=0`, or `CODEX_USAGE_HERMES=0` to disable automatic discovery for the corresponding source; manual import remains available.

Existing `imports.json` files migrate to v2 automatically; the previous list is retained as `.v1-backup`.

</details>

## Token details

Normalized events record time, session, source, channel, model, repository attribution, and token usage. Missing details are distinguished from actual zeroes; tokens are not estimated from message text.

- **Input** includes cached input; do not add cache hits to input again.
- **Output** includes reasoning; do not add reasoning to output again.
- **Cache writes** are stored as separate pricing details; adapters include them in input according to source semantics.
- **Total** uses a trustworthy source total or is constructed by the adapter from known fields.

Raw input from Claude Code, DSH, and OpenCode excludes cache, so the adapter combines it first. OpenCode's visible output also needs its separate reasoning added. WorkBuddy already supplies totals including cache and reasoning; these are not added twice.

When details conflict with a usable total, the total is retained and untrustworthy details are discarded; Waifu explains the resulting estimate in cost details. Hermes is a cumulative ledger: event time is the last activity time, not a per-request timeline.

## Ranges and quota windows

Today, This Week, This Month, All, and custom ranges cover all selected sources. Dates use the server machine's local timezone.

The current and previous Codex 5-hour and weekly quota windows include only eligible Codex usage; boundaries come from actual quota records. Eligibility is determined by source type: other tools do not qualify by using GPT models or naming a channel Codex. See the [dashboard guide](12-dashboard.en.md#time-ranges-and-quotas) for filtering and optional completion.

## Channel grouping

For ordinary ranges, Codex Desktop, editor integrations, CLI, Exec, and Work Desktop are grouped under Codex. ZCode, DSH, Claude Code, and Hermes subagents are grouped with their respective parent channels; WorkBuddy and OpenCode remain separate. Codex quota views retain detailed channels. Custom channels without source evidence retain their names.

Grouping changes presentation, not raw event channels. Sessions are deduplicated by source home and session ID; counts across channels cannot simply be added. Model display identity is separate from pricing catalog coverage, and Lite can also merge known model aliases.

## Index and history

The default index is `~/.codex-usage/usage-index.sqlite`. Later syncs update changed sources. Codex and DSH can reuse parser checkpoints after continuity verification; database sources check both the main database and WAL. Changes, truncation, or rewrites are revalidated according to source rules.

Indexed history remains available if source files disappear. Revisions or deletions of cumulative rows within a Hermes database update the current summary. Normal upgrades migrate the index automatically; there is no need to delete it. See [history backup and transfer](history-retention.en.md).

## How files are read

Normalized usage events store usage and required metadata, not message bodies, tool arguments, or secrets. Automatic price requests do not upload local usage.

<details>
<summary>Raw files and SQLite access</summary>

JSONL and OpenCode JSON data may bring message bodies into memory during parsing; only usage and metadata fields are extracted afterwards. ZCode and OpenCode attempt to open SQLite read-only first. If that fails, a normal open may trigger SQLite recovery or auxiliary-file operations; the application does not intentionally modify upstream business records.

</details>

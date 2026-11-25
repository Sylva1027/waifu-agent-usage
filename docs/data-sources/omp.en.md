# Oh My Pi usage source

[简体中文](omp.md) · English

Source management can discover `~/.omp/agent`. You can also select the OMP home, the agent directory, `sessions`, `archive/sessions`, or an individual project directory. Selecting an active or project directory limits scanning to that subtree. For a custom session location, choose its containing directory under **Add another location**.

Use `CODEX_USAGE_OMP_HOMES` to add confirmed directories with the separators described in [Data sources](../10-data-sources.en.md). Set `CODEX_USAGE_OMP=0` to disable automatic discovery. Manual import remains available. Discovery also checks OMP's agent and session directory environment variables and existing profile and XDG data layouts.

## Usage and costs

The dashboard reads metered model replies and separate usage records, including subagents, advisors, and auxiliary calls for tasks such as titling and compaction. The same rules apply to active and archived sessions.

- Input includes cache reads, cache writes, and server-side orchestration input. Cache hits are a subset of input.
- Output already includes reasoning. Reasoning is marked unknown when orchestration output has no reasoning breakdown.
- A valid source total takes precedence. Complete components can supply a missing total, and missing details remain unknown.

Waifu estimates API costs using the recorded model, recognized per-call service tiers, and the existing price catalog. Normal date ranges include Oh My Pi. Codex quota windows count eligible Codex usage only.

## Sync and history

Forks, discarded turns, and archived copies count once when their call identity can be verified. Confirmed usage stays in the dashboard after a session file disappears or old content is removed. A confirmed correction from the original session updates the existing fact. Backups and cold history use the [standard history workflow](../history-retention.en.md).

<details>
<summary>Log coverage and reading behavior</summary>

The adapter supports v2 and v3 sessions with stable entry IDs. V1 logs require stable IDs from upstream. Reattached calls without a reliable response ID may still count twice. Usage must be present in the source log. Parsing loads log lines briefly into memory and retains only the fields needed for usage and attribution. Source details report damaged archives and unresolved identities.

</details>

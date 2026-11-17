# Pricing and automatic updates

[简体中文](11-pricing.md) · English

Cost features are available in **Waifu**. Usage is estimated at model API rates and can be displayed in USD or CNY. Cost details show price sources, service tiers, and estimate reasons.

## View and edit prices

Open the pricing dialog, choose a provider, then a model. The list includes models used throughout local history, including an editor for missing prices. Search accepts provider names in Chinese or English and model names.

Models within a provider are sorted by release date, newest first; unknown dates appear last. Newly used models show an unread state, cleared for displayed entries when their provider dialog is opened.

Price and exchange-rate changes take effect on Save; Cancel discards the draft. Restoring the automatic exchange rate also requires saving to remove the manual override. Background updates do not overwrite unsaved edits; concurrent save conflicts preserve the draft.

## Cost accounting

Costs are API-equivalent estimates, not subscription charges or provider invoices. Total input is priced as ordinary input, cache reads, and cache writes. Reasoning is included in total output and is not charged twice.

Known models use effective prices and available evidence to select short/long context and Standard/Fast tiers. Details explain missing or conflicting breakdowns and unknown context. Unknown paid models are estimated using the lowest applicable rate scenario in the relevant currency; portions that cannot be priced reliably remain unpriced.

Ordinary historical costs are recalculated using current effective prices without changing original tokens. Paused snapshots and history import instances use frozen prices; see [history import](history-retention.en.md#export-and-import-a-complete-bundle).

## Model resolution and free rules

Display uses canonical model identity, removes routing prefixes, and combines known aliases; raw logs and the index retain original names. Price matching proceeds by exact key, explicit alias, an unlisted `-free` suffix, then the longest known prefix with a boundary. Unknown Claude versions remain unpriced instead of borrowing another version's price.

- `codex-auto-review` and `hy4free` have dedicated zero-cost rules; manually entered rates with the same names do not override them.
- Actual `codex-auto-review` tokens, sessions, and eligible quota-window usage are still counted, and actual quota percentages remain unchanged. See the [Codex plan information](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).
- Unlisted `-free` models are estimated at zero; an explicit price entry takes precedence. OpenCode log entries with `cost: 0` do not prove a model is free.

Renames, route grouping, and free rules share the [pricing model mapping](../public/pricing-models.js). Actual rates are in the effective catalog in the application.

<details>
<summary>Context, Claude cache writes, and cumulative sources</summary>

`gpt-6.1-sol` and `gpt-6-sol` have separate pricing entries. GPT-6.1 Sol from native Codex/ChatGPT Work sources uses short-context pricing, or the Fast short-context rate for Fast. Its 500K context capability is not a price threshold. Other sources follow their applicable context rules; model or channel name alone does not establish Codex source eligibility.

Claude cache writes use the 5-minute scenario. When a nonzero write has no recorded TTL, cost details explain this assumption; an explicit 1-hour or other unsupported TTL leaves the write portion unpriced while pricing other known portions normally. Cache read prices are stored per model, not as a universal fraction of input. See [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [model IDs](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions).

Hermes cumulative input/output and last activity time cannot establish per-request context or time window, so the lowest feasible scenario is used and explained in details. ZCode cache relationships follow the current mapping and detail validation; cache is not added again just because a model is named Claude.

</details>

## Automatic updates

The service checks whether prices are due at startup and roughly hourly thereafter. Successful updates are at least 24 hours apart; failures have a cooldown of at least one hour. You can also update immediately in the pricing dialog. Prices and exchange rates update independently; a failure on one side does not erase the other's valid value.

Automatic sources include:

- Models.dev: matching first-party model catalogs.
- LiteLLM: fallback OpenAI prices.
- OpenRouter: reference prices for exact model matches beyond existing official adapters.
- StepFun, MiMo, Kimi, and GLM: CNY prices from their official pages.
- Frankfurter: USD/CNY display exchange rate.

Newly used models first match the local catalog archive; public catalogs are downloaded when needed. Only actually used, reliably matched entries join the effective catalog. When fields are missing or rules cannot be represented, valid existing values are retained and model details show the source and inherited values.

Network requests fetch only public prices and exchange rates, without sending local model names, usage, paths, or message text. Cached or built-in prices remain available offline. See the OpenRouter [FAQ](https://openrouter.ai/docs/faq) for its reference-price provider semantics.

## Local configuration and compatibility

Effective precedence is built-in values → automatic sources/cache → manual field overrides; dedicated free rules take precedence over rates of the same name.

- `~/.codex-usage/pricing.json`: manual model price and exchange-rate overrides.
- `~/.codex-usage/pricing-auto.json`: automatic catalog and refresh state.
- `~/.codex-usage/pricing-sources.sqlite`: public catalog archive, not a usage database.

Older full-configuration and field-override formats remain compatible. Updating prices does not require clearing the usage index. Lite does not calculate costs and preserves existing pricing files for a return to Waifu.

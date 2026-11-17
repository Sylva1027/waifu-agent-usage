These fixtures contain only data consumed by the public tests:

- `achievements/`: hand-calculated rule boundaries, an empty synthetic API snapshot, approved bilingual product copy, and fixed badge hashes and byte counts. The copy modules contain only the tested constants and formatting functions. Badge digests were recorded independently of the runtime files; tests do not regenerate them.
- `skins/ink-bounds.json`: fixed numeric measurements used to verify runtime character framing, without source artwork.
- `source-adapters/digests.json`: fixed outputs of independent earlier adapters on the synthetic JSONL and SQLite inputs built by the tests. Canonical hashes preserve every field, array order, missing values, negative zero and non-finite numbers; only disposable fixture paths are replaced. The earlier implementations are not shipped.

No personal usage logs, preview application, authoring artwork or historical acceptance reports are included.

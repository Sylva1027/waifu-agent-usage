# Development guide

[简体中文](03-development.md) · English

The project uses Node.js ESM, SQLite, and native browser JavaScript. For v1.0, package version is `1.0.0`, `releaseVersion` is `1.0`, and the download tag is `v1.0`.

## Environment and startup

Node.js `>=23.8` is required. There are no production npm dependencies; development dependencies support type checking, formatting, and palette tools.

On Windows, use PowerShell 7 (`pwsh`) from the repository root:

```powershell
npm.cmd ci
node src/cli.js run
```

The `src/cli.js` source entry runs Waifu by default; `npm run serve` uses the same entry. To develop Lite:

```powershell
node src/cli-lite.js run --port 3766 --home-dir ./output/lite-home --state-file ./output/lite-services.json
```

Parallel instances need separate ports, data roots, and service registration files. `--home-dir` affects default data and configuration locations, not just source selection. Both release packages use `node src/cli.js run`.

The primary command is `waifu-agent-usage`; `codex-usage` and `cud` remain compatible aliases. Existing `.codex-usage` data, `CODEX_USAGE_*` environment variables, and browser preferences continue to work.

## Code entry points

- [src/cli-core.js](../src/cli-core.js) and [src/server-core.js](../src/server-core.js): shared CLI, HTTP, refresh, and history operations; edition entries assemble their own features.
- [src/usage-core.js](../src/usage-core.js) and `*-usage.js`: discovery, parsing, and normalized events.
- [src/usage-fact-store.js](../src/usage-fact-store.js): facts, migrations, sources, and indexes; [src/usage-reader.js](../src/usage-reader.js) queries published views.
- [src/usage-executor-client.js](../src/usage-executor-client.js): separate computation process; [src/waifu/](../src/waifu/) provides Waifu extensions.
- [src/history-archive.js](../src/history-archive.js) and [src/history-backup.js](../src/history-backup.js): history packages and backups; see [formats and operations](history-retention.en.md).
- [src/pricing.js](../src/pricing.js) and [public/pricing-models.js](../public/pricing-models.js): Waifu pricing and model mapping.
- [public/app.js](../public/app.js) and [public/lite/](../public/lite/): the edition interfaces; [public/dashboard-runtime.js](../public/dashboard-runtime.js) provides shared interaction.
- [test/](../test/) and [test-support/](../test-support/): tests and independent reference data.

See [data sources](10-data-sources.en.md) for usage semantics and [skin maintenance](13-skins.en.md) for artwork and palettes. A new source must be connected to discovery, parsing, indexing, import labels, channel grouping, quota filtering, and both language dictionaries, with source and three-path consistency tests.

Lite's page, styles, and usage backend are assembled independently; shared modules do not depend on Waifu's pricing, sharing, or achievement runtimes. History format validation must still preserve attachments declared in older packages. Frozen and import readers query fixed views; source acquisition and projection preparation are performed by their respective owners.

## Checks and tests

```powershell
npm.cmd run typecheck
npm.cmd run lint -- --error-on-warnings
npm.cmd run format:check
npm.cmd run skins:check

# Run affected tests
node scripts/test.mjs test/usage-core.test.js test/usage-store.test.js

# Full suite
npm.cmd test -- --test-reporter=spec --test-concurrency=4 --test-timeout=720000
```

Tests use Node's built-in `node:test`. Check the exit code and pass, failure, and skip counts. Use isolated homes and fixtures to avoid reading or writing everyday usage data.

For browser tests, set `AGENT_USAGE_PLAYWRIGHT_MODULE` to an installed Playwright `index.mjs`; `AGENT_USAGE_EDGE_PATH` can specify Edge. Browser dependencies are for development only. Native behavior tests can use `Q6_TEST_HELPER` to select the helper; `AGENT_USAGE_TEST_NATIVE_BUILD=1` enables build tests. See [CI](../.github/workflows/ci.yml) for commands and environment.

A new push to a PR cancels its older CI run. Docs-only changes check new local links and image paths, as well as references to removed files.

Code PRs run static and core checks on Windows with Node 24. Changes that affect data sources, storage, or the Windows helper also run native acceptance. Code changes on `main` run the full Windows suite on Node 24. Ubuntu x64 and Apple Silicon macOS run the Node 24 core tests and Playwright Chromium checks for code PRs and changes on `main`. Weekly, manual, and release-candidate compatibility checks use Node 26.

Pull requests targeting `main` must pass the GitHub Actions check `test (24)`. A docs-only PR satisfies this requirement after its lightweight check succeeds.

Before publishing, run [Release candidate](../.github/workflows/release.yml) in Actions for the candidate branch, or use `gh workflow run release.yml --ref <tag>` for a tag. After the Node 26 compatibility checks pass, Windows checks the source archive fixtures, then builds and verifies the Waifu and Lite ZIPs. Ubuntu and Apple Silicon macOS download those same ZIPs from the run, verify the SHA-256 hashes and package contents, and run CLI, HTTP, and Playwright checks on Node 24. Download the ZIPs and SHA-256 manifest from the successful run and publish those files.

The interface primarily targets desktop mouse and keyboard use. Check large screens, side-by-side windows, and narrow windows, retaining keyboard navigation, focus restoration, and reduced-motion support. Place explanations of mechanisms and costs in details users choose to open.

## Windows helper

Building requires PowerShell 7, Rust/Cargo, and the Windows host toolchain's linker:

```powershell
npm.cmd run native:build
npm.cmd run native:check
```

The outputs are `native/windows-source-proof/bin/windows-source-proof.exe` and the adjacent `windows-source-proof.build.json`; distribute them together. `native:check` verifies source and binary hashes read-only and does not require Rust. Normal operation does not invoke a compiler.

The helper uses an existing NTFS change journal to accelerate source verification and provides archive read leases. Without source proof, verification falls back to content checks; explicit archive compaction requires available file leases. The helper does not enable the system journal. See the [helper guide](../native/windows-source-proof/README.md) for build options.

## Package v1.0

After checks pass and the matching Windows helper is ready:

```powershell
npm.cmd run native:check
npm.cmd run package:release -- output/releases-v1.0
npm.cmd run package:check -- output/releases-v1.0 --browser
```

The output must be a new directory under `output/`. Names come from `releaseVersion: "1.0"`: `1.0-waifu.zip` and `1.0-lite.zip`; the package `version` is `1.0.0`.

The packager collects actual dependencies, edition assets, the license, and the Windows helper; it excludes user data, development dependencies, and authoring PNGs. `release-manifest.json` records ZIP and per-file SHA-256 hashes. `package:check` verifies the extracted packages and runs isolated HTTP checks; `--browser` adds browser checks.

Use `skins:check` to verify release assets. Additional PNGs are only needed to regenerate authoring materials; see [skin maintenance](13-skins.en.md). For installation and data migration, see [upgrading](15-delivery-upgrade.en.md).

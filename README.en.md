# Waifu Agent Usage

[简体中文](README.md) · English

Waifu Agent Usage is a local AI coding usage dashboard independently maintained by Sylva1027. Bring usage from your AI coding tools into one place, see where your tokens go, follow usage trends, and make it your own with character skins, share cards, and achievements.

![Claude light dashboard in English and ChatGPT light dashboard in Chinese, sample data](docs/images/dashboard-bilingual.png)

## Supported harnesses

<table>
  <tr>
    <td width="50%"><a href="docs/data-sources/codex.en.md"><img src="docs/images/harnesses/codex.png" width="20" height="20" align="absmiddle" alt="">&nbsp;Codex</a></td>
    <td width="50%"><a href="docs/data-sources/claude-code.en.md"><img src="docs/images/harnesses/claude-code.png" width="20" height="20" align="absmiddle" alt="">&nbsp;Claude Code</a></td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/data-sources/opencode.en.md"><img src="docs/images/harnesses/opencode.png" width="20" height="20" align="absmiddle" alt="">&nbsp;OpenCode</a></td>
    <td width="50%"><a href="docs/data-sources/zcode.en.md"><img src="docs/images/harnesses/zcode.png" width="20" height="20" align="absmiddle" alt="">&nbsp;ZCode</a></td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/data-sources/dsh.en.md"><img src="docs/images/harnesses/dsh.svg" width="20" height="20" align="absmiddle" alt="">&nbsp;DSH</a></td>
    <td width="50%"><a href="docs/data-sources/workbuddy.en.md"><img src="docs/images/harnesses/workbuddy.svg" width="20" height="20" align="absmiddle" alt="">&nbsp;WorkBuddy</a></td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/data-sources/hermes.en.md"><img src="docs/images/harnesses/hermes.png" width="20" height="20" align="absmiddle" alt="">&nbsp;Hermes</a></td>
    <td></td>
  </tr>
</table>

Planned integrations are [Google Antigravity](https://antigravity.google/) and [(Oh My) Pi](https://github.com/can1357/oh-my-pi).

## Let your agent install it

```text
Please install and start Waifu Agent Usage on my computer:
https://github.com/Sylva1027/waifu-agent-usage

1. Ask whether I want the full Waifu experience or Lite for focused usage tracking. Download the latest stable ZIP for that edition from Releases.
2. Check that Node.js meets engines.node in package.json. If installation is needed, get it from https://nodejs.org/.
3. Put the program in a permanent folder. If an installation already exists, follow the repository's upgrade guide to preserve usage data, source settings, and achievement profiles before updating program files.
4. Run node src/cli.js dashboard from the installation folder. For Lite from source, run node src/cli-lite.js dashboard.
5. On Windows, follow docs/01-getting-started.en.md to create a local desktop shortcut for the selected edition using PowerShell 7. Double-click it to verify that the correct dashboard opens. Tell me the installation folder, shortcut name, actual dashboard URL, and how to stop the service.
```

## Manual installation

Install [Node.js](https://nodejs.org/en/download) 23.8 or newer, then download and extract your chosen edition. Both ZIPs were verified on Windows x64, Ubuntu 24.04 x64, and macOS 15 on Apple Silicon. Open a terminal in the extracted folder and run the command below.

```bash
node src/cli.js dashboard
```

The command starts the service in the background and opens your browser. Use source management to scan and import your logs. The ZIP is ready to run without installing npm packages or compiling. Stop the service with `node src/cli.js stop`. [Getting started](docs/01-getting-started.en.md)

### Windows desktop shortcut

Use PowerShell 7 to create a desktop shortcut for Waifu or Lite, then double-click it to open the dashboard. [Create a desktop shortcut](docs/01-getting-started.en.md#windows-desktop-shortcut)

## Features

**Usage at a glance.** Track input, output, reasoning, cached input, and cache hit rate. Search and explore details by model or repository to see where your tokens go.

**Trends and quota windows.** Explore daily, weekly, monthly, or custom ranges and compare them with the previous period. See usage within the current and previous Codex 5-hour and weekly quota windows.

**Cost estimates.** Estimate usage costs at model API rates in USD or CNY. Prices and exchange rates update automatically and can also be adjusted manually.

![Cost estimate and model pricing settings](docs/images/pricing.png)

**Characters and themes.** Choose from ten character skins with light and dark palettes, plus visibility and opacity controls. The interface supports English and Chinese.

![Character skins and themes](docs/images/themes.png)

**Share cards.** Turn your usage into a 3:4 portrait or 4:3 landscape image. Pick the metrics and charts, then copy or save it with one click.

![Landscape share card preview](docs/images/share-landscape.png)

**Achievement badges.** Mark your milestones with 42 achievements: follow your progress, collect badges, and look back at when you earned them. See the [achievement guide](docs/achievements.en.md).

![Achievements and badges](docs/images/achievements.png)

**Sources and history.** Scan local logs or import another directory, refresh automatically, or pause the current view. Back up, import, and restore history to keep your records over time and move them between machines.

![Data source management](docs/images/sources.png)


## Download

| Edition | What to expect | Download |
| --- | --- | --- |
| **Waifu** | The full experience, including cost estimates, character skins, sharing, and achievements. | [Download Waifu](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0a/1.0a-waifu.zip) |
| **Lite** | Focused usage tracking and trends in a simple dark interface, with history management. | [Download Lite](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0a/1.0a-lite.zip) |

[All releases](https://github.com/Sylva1027/waifu-agent-usage/releases) · [Getting started](docs/01-getting-started.en.md) · [Data sources](docs/10-data-sources.en.md) · [Backup and transfer](docs/history-retention.en.md) · [Upgrading](docs/15-delivery-upgrade.en.md) · [Development](docs/03-development.en.md) · [Documentation index](docs/00-index.en.md)

## Credits and license

This project began with [Codex Usage](https://github.com/DhWU-coder/codex-usage) and has since been independently developed around support for multiple agents, usage architecture, history retention, and personalization. Thank you to the original author for the foundation.

Some character artwork is by [ZipZipPipe](https://space.bilibili.com/4168597). Thank you for the artwork. See [CREDITS.md](CREDITS.md) for project origins, contributions, and artwork credits.

The project code is licensed under the [MIT License](LICENSE), retaining copyright notices for the original author and this project's contributions.

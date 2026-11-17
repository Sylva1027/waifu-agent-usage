# Waifu Agent Usage

简体中文 · [English](README.en.md)

把多个 AI 编程工具的用量汇总到一个本地看板，看清 Token 消耗、模型分布和使用趋势。角色皮肤、分享卡片与成就，让每天的使用记录也能有自己的风格。

支持的 harness：Codex、Claude Code、OpenCode、ZCode、DSH、WorkBuddy 和 Hermes。

![Claude 浅色英文与 ChatGPT 浅色中文看板，示例数据](docs/images/dashboard-bilingual.png)

## 让 Agent 帮你安装

```text
请在我的电脑上安装并启动 Waifu Agent Usage：
https://github.com/Sylva1027/waifu-agent-usage

1. 询问我想要完整体验的 Waifu，还是专注用量统计的 Lite，从 Releases 下载最新正式版对应的 ZIP 运行包。
2. 检查 Node.js 是否满足包内 package.json 的 engines.node 要求；需要安装时从 https://nodejs.org/ 获取。
3. 解压到固定目录。如果已有安装，先按仓库升级文档保留用量数据、来源配置和成就档案，再更新程序文件。
4. 在包根目录运行 node src/cli.js run，无需 npm install 或编译。
5. 启动后告诉我访问地址、安装目录，以及之后如何启动和停止。
```

## 手动安装

准备好 [Node.js](https://nodejs.org/en/download) 23.8 或更高版本，下载[下方的 Windows x64 运行包](#下载)，解压后在目录中打开终端：

```bash
node src/cli.js run
```

打开 [http://127.0.0.1:3765/](http://127.0.0.1:3765/)，在来源管理中扫描并导入日志，即可开始查看。运行包无需 `npm install` 或编译；按 `Ctrl+C` 停止服务。

## 功能一览

**用量统计。** 查看输入、输出、推理、缓存读取与命中率，按模型或仓库搜索和查看明细，了解 Token 都花在哪里。

**趋势与额度。** 按日、周、月或自定义日期查看趋势，与上一周期比较。支持查看 Codex 当前和上一轮 5 小时／每周额度窗口内的用量。

**费用估算。** 按模型 API 单价估算用量对应的费用，以美元或人民币查看。价目与汇率自动更新，也可手动调整。

![费用估算与模型价格设置](docs/images/pricing.png)

**角色与主题。** 十款角色皮肤搭配深浅配色，可调整角色显示与透明度，选择自己喜欢的看板风格。界面支持中英文。

![角色皮肤与主题选择](docs/images/themes.png)

**分享卡片。** 将当前用量生成 3:4 竖版或 4:3 横版图片，自选指标与图形，一键复制或保存。

![横版分享卡片预览](docs/images/share-landscape.png)

**成就徽章。** 42 项成就记录你的使用里程碑，查看进度、收集徽章，回顾每次达成的日期。详见[成就说明](docs/achievements.md)。

![成就与徽章](docs/images/achievements.png)

**来源与历史。** 扫描本机日志或导入其他目录，自动刷新，也可暂停当前视图。支持历史备份、导入与恢复，方便长期保留和转移使用记录。

![数据来源管理](docs/images/sources.png)


## 下载

| 版本 | 简介 | 下载 |
| --- | --- | --- |
| **Waifu 完整版** | 完整体验，包含费用估算、角色皮肤、分享与成就。 | [下载 Waifu](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0/1.0-waifu.zip) |
| **Lite 轻量版** | 专注用量统计与趋势，简洁的深色界面，保留历史管理。 | [下载 Lite](https://github.com/Sylva1027/waifu-agent-usage/releases/download/v1.0/1.0-lite.zip) |

[查看所有版本](https://github.com/Sylva1027/waifu-agent-usage/releases) · [使用指南](docs/01-getting-started.md) · [数据来源](docs/10-data-sources.md) · [备份与转移](docs/history-retention.md) · [升级说明](docs/15-delivery-upgrade.md) · [开发文档](docs/03-development.md)

## 致谢与许可

基于 [DhWU-coder/codex-usage](https://github.com/DhWU-coder/codex-usage) 开发。部分角色形象来自 [ZipZipPipe](https://space.bilibili.com/4168597)，感谢其创作。

项目采用 [MIT License](LICENSE)。

# 数据来源与统计口径

简体中文 · [English](10-data-sources.en.md)

Waifu 与 Lite 使用相同的来源和 Token 统计规则。费用估算由 Waifu 提供，见[计价说明](11-pricing.md)。

## 扫描与导入

打开来源管理扫描本机常见目录，勾选后点击“导入所选”；也可用“添加其他位置”选择目录。导入接受工具的 home、数据目录或项目目录，不接受单个数据库或 JSONL 文件。

网页刷新和后台监听只读取已确认的来源。新安装先导入；升级保留已确认目录和来源身份。导入经过读取、统计、校验和看板更新，关闭弹窗不会取消，刷新页面会重新接入任务。失败后可重试，已确认事件不会重复累计。

支持的来源：

- [Codex](data-sources/codex.md)：`~/.codex` 的会话日志，也扫描 JetBrains 集成目录。
- [ZCode](data-sources/zcode.md)：`~/.zcode` 下的 SQLite 用量库。
- [DSH](data-sources/dsh.md)：`~/.dsh` 下的压缩会话日志。
- [OpenCode](data-sources/opencode.md)：数据目录下的 `opencode*.db`，支持 v2 消息库。
- [Claude Code](data-sources/claude-code.md)：`~/.claude/projects/` 的主会话和子代理转录。
- [WorkBuddy](data-sources/workbuddy.md)：`~/.workbuddy-ai/projects/` 的转录；Auto 记录不计入统计。
- [Hermes](data-sources/hermes.md)：各 home 的 `state.db` 累计用量账本。
- 项目用量日志：可导入含 `.codex-usage/usage.jsonl` 的项目目录，读取其中已记录的真实用量。

`~` 表示当前用户主目录。扫描候选还包括 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`HERMES_HOME` 指向的位置。

<details>
<summary>额外目录与环境变量</summary>

可通过以下变量追加来源目录：

- Codex：`CODEX_USAGE_HOMES`
- ZCode：`CODEX_USAGE_ZCODE_HOMES`
- DSH：`CODEX_USAGE_DSH_HOMES`
- OpenCode：`CODEX_USAGE_OPENCODE_HOMES`
- Claude Code：`CODEX_USAGE_CLAUDE_HOMES`
- WorkBuddy：`CODEX_USAGE_WORKBUDDY_HOMES`
- Hermes：`CODEX_USAGE_HERMES_HOMES`
- 其他导入目录：`CODEX_USAGE_IMPORT_DIRS`

多个路径使用系统分隔符：Windows 为 `;`，macOS/Linux 为 `:`。这些显式配置视为已确认来源。CLI 汇总会自动发现默认来源。

设置 `CODEX_USAGE_ZCODE=0`、`CODEX_USAGE_DSH=0`、`CODEX_USAGE_OPENCODE=0`、`CODEX_USAGE_CLAUDE=0`、`CODEX_USAGE_WORKBUDDY=0` 或 `CODEX_USAGE_HERMES=0` 可关闭对应自动发现，仍可手动导入。

既有 `imports.json` 自动迁为 v2，旧清单保留为 `.v1-backup`。

</details>

## Token 明细

标准事件记录时间、会话、来源、渠道、模型、仓库归属和 Token 用量。缺失明细与真实零值分开处理，不从正文估算 Token。

- **输入**包括缓存命中的输入；缓存命中不能再加到总输入上。
- **输出**包括推理；推理不能再加到总输出上。
- **缓存写入**另存计价明细，各适配器按来源语义计入输入。
- **总量**使用来源的可信总量，或由适配器按已知字段构造。

Claude Code、DSH 和 OpenCode 的原始输入字段不含缓存，适配器先合并；OpenCode 的可见输出还需加上独立推理。WorkBuddy 已提供包含缓存和推理的总量，不重复相加。字段映射见各来源专题。

明细与总量冲突时保留可用总量，撤销不可信明细；Waifu 在费用详情中说明相应估算场景。Hermes 是累计账本，事件时间取最后活动时间，不能当作逐请求时间线。

## 统计范围与额度

今日、本周、本月、全部及自定义日期统计所有选中来源。日期按服务机器的本地时区解释。

当前与上一轮 Codex 5 小时／每周额度窗口只统计符合条件的 Codex 用量，边界来自真实额度记录。来源类型决定资格，其他工具使用 GPT 模型或把渠道命名为 Codex，也不会获得 Codex 额度资格。额度筛选及可选补齐方式见[看板说明](12-dashboard.md#时间范围与额度)。

## 渠道展示与归组

普通范围将 Codex Desktop、编辑器集成、CLI、Exec 和 Work Desktop 归入 Codex；ZCode、DSH、Claude Code、Hermes 的子代理各归入对应主渠道，WorkBuddy 和 OpenCode 保持独立。Codex 额度范围保留细分渠道。没有来源证据的自定义渠道保留原名。

归组只影响展示，不改写原始事件渠道。会话按来源 home 与会话 ID 的组合去重，不能直接累加不同渠道的会话数。模型展示身份与是否收录价格分开处理，Lite 也可合并已知模型别名。

## 索引与历史

默认索引为 `~/.codex-usage/usage-index.sqlite`。后续同步更新变化的来源；Codex、DSH 可在验证连续性后复用解析检查点，数据库来源同时检查主库和 WAL。变化、截断或重写按来源规则重新校验。

来源文件消失后，已索引历史继续保留；Hermes 数据库内的累计行修订或删除会更新当前汇总。正常升级自动迁移，无需删除索引。长期备份与迁移见[历史保留](history-retention.md)。

## 读取说明

统计只保存用量和必要元数据，不把消息正文、工具参数或密钥写入标准用量事件。自动价格请求也不上传本地用量。

<details>
<summary>原始文件读取与 SQLite 打开方式</summary>

JSONL 和 OpenCode JSON 数据在解析时可能将正文读入内存，随后只提取用量及元数据字段。ZCode、OpenCode 优先只读打开 SQLite，失败时会尝试普通打开，可能触发 SQLite 恢复或辅助文件操作；应用不主动修改上游业务记录。

</details>

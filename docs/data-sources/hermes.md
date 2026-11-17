# Hermes 数据源

从各 home 的 `state.db` 读取累计用量。Windows 默认目录为 `%LOCALAPPDATA%/hermes`，macOS/Linux 为 `~/.hermes`；同时发现 `HERMES_HOME` 与默认根目录下的命名 profiles。

`CODEX_USAGE_HERMES_HOMES` 可追加目录，`CODEX_USAGE_HERMES=0` 关闭自动发现。导入选择包含数据库的 home，扫描确认后才读取，操作见[数据来源](../10-data-sources.md)。

## 数值与时间

`session_model_usage` 每行是 session、模型、路由和 task 的累计账本，包含主循环与辅助调用：

- 输入为普通输入、缓存读取和缓存写入之和。
- 输出已包含推理，缓存读取属于输入。
- 没有模型用量行的会话使用 session 总量，归入 Unknown model；已有模型行时不重复叠加 session 总量。

时间取累计行最后活动时间，长会话继续更新时，整行用量的归属日期可能移动。记录行数不是底层 HTTP 请求数。数据库默认零值也不证明提供方完整上报所有明细。

session 总量与模型账本的差额作为来源诊断，不补入用量或费用。渠道按来源识别 Hermes／Hermes Subagent；仓库使用记录的 Git 根目录或工作目录，缺失时为未知。不参与 Codex 额度窗口。

Waifu 按可行的最低场景估算费用：累计量与最后活动时间不足以确定逐请求上下文或时段。Hermes 原生 Codex 路径可能和另行导入的 Codex 日志重叠，可通过来源筛选避免重复选择。

## 更新与历史

适配器只读查询用量及必要元数据，不读取消息正文、system prompt、模型配置或凭据。同步读取一致的累计账本快照，来源变化时重试并保留上次成功结果。

数据库内的行修订或删除会更新当前统计，旧事实保留恢复证据；数据库不可读或消失时保留已索引历史。冷历史的后续修订由现有修订机制处理，完整包包含冷段与修订，冻结快照独立于后续变化，见[历史保留](../history-retention.md)。

开发入口：[hermes-usage.js](../../src/hermes-usage.js)、[Hermes 测试](../../test/hermes-usage.test.js)。

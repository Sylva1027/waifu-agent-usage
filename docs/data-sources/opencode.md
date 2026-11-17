# OpenCode 数据源

扫描以下数据目录中的 `opencode*.db`，导入时选择目录而非数据库文件：

- `~/.local/share/opencode`
- `%APPDATA%/opencode`
- `%LOCALAPPDATA%/opencode`
- `~/Library/Application Support/opencode`

`CODEX_USAGE_OPENCODE_HOMES` 可追加目录，`CODEX_USAGE_OPENCODE=0` 关闭自动发现。共同操作见[数据来源](../10-data-sources.md)。

## 格式兼容

支持 `session_v2` 与 `session_message` 的 v2 消息库。早期 `session / message / part` 或 JSON 树布局未接入。

解析前检查消息表所需列，缺列时跳过并报告原因。会话版本主版本小于 2 时跳过，避免旧输出语义重复计算推理；缺少或无法识别版本时尝试读取并提示。

只从 assistant 消息的 `data.tokens` 提取事件，不重复叠加会话聚合值。没有 tokens 的消息跳过。当前统一展示为 OpenCode，不按父会话或 agent 拆分子代理；不参与 Codex 额度窗口。

## Token 映射

v2 的普通输入、缓存与推理为独立计数：

```text
总输入 = tokens.input + tokens.cache.read + tokens.cache.write
缓存命中 = tokens.cache.read
总输出 = tokens.output + tokens.reasoning
推理 = tokens.reasoning
总量 = 总输入 + 总输出
```

缓存写入缺失时保留未知。推理已计入总输出，后续统计与计价不再重复增加。单消息总输入用于上下文判断。

时间优先使用消息完成时间，回退创建时间。模型取 `data.model.id`，provider 取 `providerID`，工作目录与标题取 `session_v2`。

日志中的 `cost: 0` 不证明免费。Waifu 使用有效模型价目和明确免费规则，见[计价说明](../11-pricing.md#模型解析与免费规则)。

## 更新与读取

一个数据目录可包含多个库，逐库纳入来源清单；变化检测同时检查主库和 WAL。读取前后校验稳定性，不能复用时重新扫描。

解析 `data` 时正文可能进入内存，但只提取用量、模型、时间及必要元数据，不将内容、快照或 provider 状态写入标准用量事件。数据库优先只读打开，失败时尝试普通打开，可能涉及 SQLite 恢复或辅助文件操作。

开发入口：[opencode-usage.js](../../src/opencode-usage.js)、[OpenCode 测试](../../test/opencode-usage.test.js)。

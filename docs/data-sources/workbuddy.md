# WorkBuddy 数据源

默认 home 为 `~/.workbuddy-ai`，读取 `projects/<cwd-slug>/<sessionId>.jsonl`。导入选择 home 目录，跳过 `tool-results/` 和非 JSONL 文件。

`CODEX_USAGE_WORKBUDDY_HOMES` 可追加目录，`CODEX_USAGE_WORKBUDDY=0` 关闭自动发现。WorkBuddy 与 Claude Code 目录形状相似，扫描还会按内容标记区分；共同操作见[数据来源](../10-data-sources.md)。

## 记录与去重

只读取 `function_call` 或 `message` 中带 `providerData.usage` 与 `providerData.messageId` 的记录。同一响应可能写成多行，按 `providerData.messageId` 在文件内去重，只产生一个事件。

模型为 `default-model` 或请求模型名为 Auto 的记录整条排除，不计入用量与费用；同文件其他记录继续统计。WorkBuddy 不参与 Codex 额度窗口。

## Token 映射

支持的转录口径中，普通输入与输出字段已经是总量：

- 输入：`providerData.usage.inputTokens`，已含缓存命中，不再相加。
- 缓存命中：`inputTokensDetails[0].cached_tokens`。
- 输出：`providerData.usage.outputTokens`，已含推理。
- 推理：`outputTokensDetails[0].reasoning_tokens`。
- 总量：`usage.totalTokens`。
- 缓存写入：`providerData.rawUsage.cache_creation_input_tokens`，保留实际值与已知状态。

不叠加 `message.usage` 或其他重复计数。模型取实际线路模型，单次输入用于上下文判断；缺失字段保留未知。

## 使用时留意

去重范围是单个文件，同一份会话复制成多个来源文件可能重复计入。服务档位未提供时为未知；`ai-title` 不参与统计，会话标题为空。

开发入口：[workbuddy-usage.js](../../src/workbuddy-usage.js)、[WorkBuddy 测试](../../test/workbuddy-usage.test.js)。Waifu 费用规则见[计价说明](../11-pricing.md)。

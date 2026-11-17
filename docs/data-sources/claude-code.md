# Claude Code 数据源

默认 home 为 `~/.claude`，同时扫描 `CLAUDE_CONFIG_DIR` 指向的目录。`CODEX_USAGE_CLAUDE_HOMES` 可追加位置，`CODEX_USAGE_CLAUDE=0` 关闭自动发现。导入选择 home 目录，操作见[数据来源](../10-data-sources.md)。

## 主会话与子代理

读取：

- `projects/<encoded-cwd>/<sessionId>.jsonl`
- `projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl`

子代理用量计入总量并合并到 Claude Code 主渠道，使用父会话 ID，避免虚增会话数。跳过 `tool-results/`、`memory/` 及非 JSONL 文件，不参与 Codex 额度窗口。

## 去重与字段

只处理带 `message.usage` 的 assistant 记录。同一消息可能按内容块写成多行，按 `message.id` 去重并保留 Token 总和最大的记录；缺失时回退到记录 `uuid` 并报告提示。

Claude 的普通输入与缓存读写是并列计数：

```text
总输入 = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
缓存命中 = cache_read_input_tokens
输出 = output_tokens
推理 = output_tokens_details.thinking_tokens（存在时）
总量 = 总输入 + 输出
```

单次总输入用于上下文判断。`usage.speed: "fast"` 或相应服务档位字段用于识别 Fast；缺失明细保留未知。

模型优先使用响应的 `message.model`，缺失或占位时才回退 `requestedModel`。后者可能只是请求侧路由或层级别名，不代表实际服务模型。未知 Claude 版本保留缺价，见[模型解析](../11-pricing.md#模型解析与免费规则)。

缓存写入 TTL 尚未持久化到事件，非零写入按 5 分钟场景估算并在费用详情说明，不能当作精确的 1 小时缓存账单。

## 更新与保留

主会话与子代理均纳入索引，追加、修订或替换按来源校验决定增量处理或重读。坏 JSON 行报告后继续读取其他记录。

上游可能按保留期清理转录，已经索引的历史继续保留，不应依赖以后重扫恢复全部记录。升级自动迁移既有索引，长期转移见[历史保留](../history-retention.md)。

读取日志时只将用量、模型、会话和必要元数据选入标准事件，不把消息正文和工具内容写入用量索引。共同读取说明见[数据来源](../10-data-sources.md#读取说明)。

开发入口：[claude-code-usage.js](../../src/claude-code-usage.js)、[Claude Code 测试](../../test/claude-code-usage.test.js)、[三路一致性测试](../../test/three-path-parity.test.js)。

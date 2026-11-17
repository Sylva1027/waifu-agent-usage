# DSH（DeepSeek Harness）数据源

简体中文 · [English](dsh.en.md)

默认 home 为 `~/.dsh`，日志位于 `sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`。导入选择 home 目录；`CODEX_USAGE_DSH_HOMES` 追加目录，`CODEX_USAGE_DSH=0` 关闭自动发现。共同操作见[数据来源](../10-data-sources.md)。

## 支持的记录

适配 `formatVersion: 4` 的多帧 zstd 日志，其他格式版本跳过并报告原因。子代理有独立会话目录；`delegationDepth > 0` 标为 DSH Subagent，普通范围合并至 DSH。

- `session`：会话 ID、工作目录与子代理深度。
- `request/header`：本次模型和 provider；`request/context` 作为兜底。
- `session/title`：最近会话标题。
- `assistant/message` 的 `data.usage`：用量来源。

工具调用和工具结果不作为用量事件，DSH 不参与 Codex 额度窗口。

## Token 映射

DSH 的普通输入、缓存读、缓存写彼此独立，需要重构总输入：

```text
总输入 = inputTokens + cacheReadTokens + cacheWriteTokens
缓存命中 = cacheReadTokens
输出 = outputTokens
总量 = totalTokens（缺失时用总输入 + 输出）
```

非零缓存写入同样计入总输入与单次请求输入，不能遗漏，也不能在总量中再加一次。例如普通输入 1,000、缓存读 8,000、缓存写 1,000、输出 500，对应总输入 10,000、总量 10,500。

DSH 未单列推理与服务档位，保留未知。单次重构输入用于上下文分级；Waifu 的缓存写入场景见[计价说明](../11-pricing.md)。

## 更新与解析

按日志文件建立索引，逐帧处理压缩记录，坏帧记录警告。验证连续性后可复用解析检查点；截断、改写或无法证明连续时重新读取。升级自动迁移既有索引，不需删除历史。

读取时解析日志，只将用量、模型和必要元数据写入标准事件；正文或工具内容不成为统计字段。

运行要求为 Node.js `>=23.8`。开发入口：[dsh-usage.js](../../src/dsh-usage.js)、[DSH 测试](../../test/dsh-usage.test.js)。

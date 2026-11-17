# ZCode 数据源

简体中文 · [English](zcode.en.md)

默认 home 为 `~/.zcode`，按顺序探测 `cli/db/db.sqlite`、`db/db.sqlite`。导入选择 home 目录；`CODEX_USAGE_ZCODE_HOMES` 追加目录，`CODEX_USAGE_ZCODE=0` 关闭自动发现。操作见[数据来源](../10-data-sources.md)。

## 字段映射

用量读取 `model_usage`，会话表提供工作目录、标题和父会话归属。会话元数据缺失时仍尝试读取用量。

- 输入：`input_tokens`。
- 缓存读取：`cache_read_input_tokens`。
- 缓存写入：`cache_creation_input_tokens`。
- 输出：`output_tokens`；推理：`reasoning_tokens`。
- 总量：优先 `computed_total_tokens`，其次 `provider_total_tokens`，缺失时为输入加输出。
- 时间：优先 `completed_at`，其次 `started_at`；无有效时间时跳过。

缺失字段与真实零值分开处理，冲突明细不当作可靠数据。当前没有足够上游写库证据确认输入与缓存读写的完整包含关系，保持上述映射，不因模型名称为 Claude 而额外累加缓存。Waifu 的适用估算见[计价说明](../11-pricing.md)。

## 渠道与读取

`query_source` 为 `subagent` 或 `task_type` 为 `subagent_child` 时标为 ZCode Subagent，普通范围合并至 ZCode。仓库取会话记录的目录或父会话目录，不从模型名称推测。ZCode 不参与 Codex 额度窗口。

变化检测同时检查主库与 WAL。优先只读打开，失败时尝试普通 SQLite 打开，可能涉及恢复或辅助文件操作，不主动改写上游用量记录。

开发入口：[zcode-usage.js](../../src/zcode-usage.js)、[ZCode 测试](../../test/zcode-usage.test.js)、[三路一致性测试](../../test/three-path-parity.test.js)。

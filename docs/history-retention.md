# 历史保留与转移

简体中文 · [English](history-retention.en.md)

已成功索引的用量在来源文件消失后仍可查询。长期保留或换电脑时，备份用量数据库；有外置冷历史时使用完整包。来源配置和其他本地设置另按[升级说明](15-delivery-upgrade.md)保留。

## 备份与普通恢复

以下命令在解压后的运行包根目录执行，Windows 使用 PowerShell 7。示例读取默认用量库，备份与恢复目标须为新路径：

```powershell
$usageDB = Join-Path $env:USERPROFILE '.codex-usage/usage-index.sqlite'
node src/cli.js history backup $usageDB ./usage-backup.sqlite
node src/cli.js history verify ./usage-backup.sqlite
node src/cli.js history restore ./usage-backup.sqlite ./usage-restored.sqlite
```

备份包含已提交 WAL。保留生成的数据库、相邻 manifest 和全部附件；普通恢复只恢复用量，不覆盖已有目标，也不自动切换活动服务。

主库已登记外置冷段时，单库备份会拒绝遗漏它们，改用完整包。Waifu 备份在存在成就档案时一并保存，完整恢复需显式指定，见[成就说明](achievements.md)。

## 完整包导出与导入

```powershell
$usageDB = Join-Path $env:USERPROFILE '.codex-usage/usage-index.sqlite'
node src/cli.js history export $usageDB ./usage-bundle
node src/cli.js history import ./usage-bundle ./usage-imported
```

完整包包含主库、已登记冷段、各包声明的上下文和附件。导入验证后生成新的查询实例目录。移动时保留整个包，不能只留下主 SQLite。自定义配置位置时，导出可添加原 `--home-dir` 参数。

查看导入数据须使用导入服务工厂，以载入包的固定上下文。在包根目录运行以下命令，再打开 `http://127.0.0.1:3766/`；按 `Ctrl+C` 停止：

```powershell
node --input-type=module -e 'import { createHistoryArchiveImportServer } from "./src/server.js"; const server = await createHistoryArchiveImportServer("./usage-imported"); server.listen(3766, "127.0.0.1");'
```

两版运行包均从 `src/server.js` 导入该工厂；源码开发 Lite 时改用 `src/server-lite.js`。不要只把普通服务的数据库路径指向导入目录里的 runtime。

Waifu 导入实例使用包内固定价目与服务档位上下文，不启动价格更新或成就，也不允许修改价目。无价目的 v3 包在初始化时捕获一次可用价目，随后固定。普通冷热历史查询仍使用当前查询价目，不按各冷段分别计费。

## 历史格式兼容

- **v1**：用量包，必须包含完整价目快照。
- **v2**：带成就附件的用量包，仍必须包含价目；成就附件按自己的格式验证。
- **v3**：支持无价目。Lite 新备份／导出／封存使用此格式，价目、价目版本和核对时间明确为 null；成就字段为 null 或有效附件记录。

两版均可校验、导入和压实 v1／v2／v3。不能把缺价目的损坏 v1／v2 当作 Lite 包。Waifu 普通有价目备份沿用 v1，带成就时使用 v2。

Lite 不为活动库附带旁边的成就档案；转移旧包时仍校验并保留包中已声明的价目、服务档位和成就附件。它不激活这些档案，`--with-achievements` 完整恢复仅由 Waifu 提供。

下列历史命令在两版运行包中都使用 `src/cli.js`；源码 Lite 使用 `src/cli-lite.js`。`~/.codex-usage/`、旧索引及来源配置继续兼容，无需手工更名或删除。

## 历史文件与保留

- **主库**保存近期事实、来源身份、额度、冷段登记和修订覆盖。
- **冷包与相邻 manifest**保存封存事实、摘要及声明的上下文和附件。
- **`.history-cache/`**保存可重建的查询投影，不能替代主库或冷包。
- **`compaction.json` 和新旧包**支持压实中断恢复及回滚。

自动封存默认关闭。冷包丢失或损坏时，完整查询会报错；恢复原文件后可重试。封存明细保留当时原值，主汇总采用有效修订。Hermes 累计行修订或删除会更新当前汇总，整库不可读或消失则保留上次已索引历史。

## 手动封存

`dry-run` 只检查并报告封存条件，默认门槛为 400,000 条事件和 180 天边界：

```powershell
node src/cli.js history archive ./history/source.sqlite --dry-run
```

<details>
<summary>创建封存候选并提交</summary>

先备份并在独立数据副本操作。通过 [history-archive.js](../src/history-archive.js) 创建明确半开区间 `[startMs, endMs)` 的候选，并验证：

```js
import { DatabaseSync } from "node:sqlite";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "./src/history-archive.js";

const source = new DatabaseSync("./history/source.sqlite", { readOnly: true });
try {
  await createHistoryArchiveCandidate(source, "./history/cold.sqlite", {
    startMs: Date.parse("2026-01-01T00:00:00Z"),
    endMs: Date.parse("2026-02-01T00:00:00Z"),
  });
  await verifyHistoryArchiveCandidate("./history/cold.sqlite");
} finally {
  source.close();
}
```

在包根目录以 ESM 执行上述代码后提交，备份目标仍须为新目录：

```powershell
node src/cli.js history archive ./history/source.sqlite --commit ./history/cold.sqlite --backup ./history/precommit-bundle
```

提交前重新核对候选并生成、验证完整前置备份，再登记冷段并移出对应热事实。无有效时间或范围外事件留在主库。冷包及相邻 manifest 从此也是历史的一部分，需要一起保留。

</details>

## 归档压实与回滚

压实回收冷包内部空闲页，保留逻辑事实、ID、各包原有价目／无价目标记及附件。普通启动或刷新不自动压实。

先停止对应实例的写入与查询，备份完整历史，再执行；首次目标目录必须不存在：

```powershell
node src/cli.js history compact ./history/source.sqlite ./history/compacted

# 用当前主库和同一映射回滚，保留压实后新增与修订
node src/cli.js history compact ./history/source.sqlite ./history/compacted --rollback
```

显式切换需要匹配的 Windows 助手及可用文件租约，构建与校验见[开发指南](03-development.md#windows-助手)。保护不可用或验证失败时不会切换登记，旧历史继续保留。

命令生成新包与 `compaction.json`，切换引用后更新查询投影。中断且已有完整映射时，重跑同一命令可继续恢复；不完整的残留目录需保留排查，重新开始使用新目录。

压实会额外保存新包，不自动删除旧包。确认正常、回滚窗口结束，且没有其他主库、完整包或冻结快照引用旧路径后，再回收旧包。压实回滚使用当前主库与原映射，不用旧主库覆盖当前主库。

## 开发接口

<details>
<summary>历史查询与导入 HTTP 接口</summary>

- `GET /api/history/archives`：冷段目录与可用状态。
- `GET /api/history/archives/<segmentId>/days`：原封存日线。
- `GET /api/history/archives/<segmentId>/events?startMs=<ms>&endMs=<ms>&limit=100&afterId=0`：按原始 ID 分页读取明细；`limit` 为 1–500，使用返回的 `nextAfterId` 继续。
- GET 可追加 `snapshot=<id>` 使用已有冻结快照，过期返回 410。
- `POST /api/history/imports`：JSON 提供 `sourceDirectory` 与新的 `importDirectory`；成功 201，目标存在 409，不切换当前服务。

导入实例不提供 full detail（400），不允许修改价目（405）。历史管理通过 CLI 进行，主页不另设归档维护面板。

</details>

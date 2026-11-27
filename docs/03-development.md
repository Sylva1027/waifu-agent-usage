# 开发指南

简体中文 · [English](03-development.en.md)

项目使用 Node.js ESM、SQLite 和浏览器原生 JavaScript。v1.0a 的包版本为 `1.0.1`，发布标识 `releaseVersion` 为 `1.0a`，下载标签为 `v1.0a`。

## 环境与启动

运行要求为 Node.js `>=23.8`。运行时没有生产 npm 依赖；开发依赖用于类型检查、格式检查和配色工具。

Windows 使用 PowerShell 7（`pwsh`），在仓库根目录执行：

```powershell
npm.cmd ci
node src/cli.js run
```

源码 `src/cli.js` 默认运行 Waifu，`npm run serve` 使用同一入口。开发 Lite 可运行：

```powershell
node src/cli-lite.js run --port 3766 --home-dir ./output/lite-home --state-file ./output/lite-services.json
```

并行实例使用独立端口、用户数据根目录和服务注册文件。`--home-dir` 会影响默认数据与配置位置，不只是筛选来源。正式运行包的两版入口均为 `node src/cli.js run`。

`--host` 或 `HOST` 可以绑定局域网地址或主机名。通配绑定时，CLI 打印本机访问地址，局域网客户端使用服务机器的实际地址和监听端口。局域网直连没有账户认证，开放绑定限于受信任网络。反向代理需先校验浏览器端来源，再按后端监听地址和端口转发 Host 与 Origin。

主命令为 `waifu-agent-usage`，`codex-usage` 和 `cud` 保留兼容别名。既有 `.codex-usage` 数据目录、`CODEX_USAGE_*` 环境变量与浏览器偏好继续沿用。

## 代码入口

- [src/cli-core.js](../src/cli-core.js)、[src/server-core.js](../src/server-core.js)：共享 CLI、HTTP、刷新与历史操作；各版入口组合自己的功能。
- [src/usage-core.js](../src/usage-core.js)和各 `*-usage.js`：来源发现、解析和标准事件。
- [src/usage-fact-store.js](../src/usage-fact-store.js)：事实、迁移、来源与索引；[src/usage-reader.js](../src/usage-reader.js)负责已提交视图的查询。
- [src/usage-executor-client.js](../src/usage-executor-client.js)：独立计算进程；[src/waifu/](../src/waifu/)提供 Waifu 扩展。
- [src/history-archive.js](../src/history-archive.js)、[src/history-backup.js](../src/history-backup.js)：历史包和备份；[格式与操作](history-retention.md)。
- [src/pricing.js](../src/pricing.js)、[public/pricing-models.js](../public/pricing-models.js)：Waifu 计价与价格模型映射。
- [public/app.js](../public/app.js)、[public/lite/](../public/lite/)：两版页面；[public/dashboard-runtime.js](../public/dashboard-runtime.js)提供共享交互。
- [test/](../test/)与 [test-support/](../test-support/)：测试和独立参考数据。

用量口径见[数据来源](10-data-sources.md)，角色资源与配色见[皮肤维护](13-skins.md)。新增来源需同时接入发现、解析、索引、导入标签、渠道归组、额度筛选和中英文字典，并补来源及三路一致性测试。

Lite 的页面、样式和用量后端独立组合；公共模块不依赖 Waifu 的计价、分享或成就运行时。历史格式验证仍须保留旧包声明的附件。冻结与导入 reader 查询固定视图，来源采集和投影准备由相应 owner 执行。

## 检查与测试

```powershell
npm.cmd run typecheck
npm.cmd run lint -- --error-on-warnings
npm.cmd run format:check
npm.cmd run skins:check

# 选择受影响的测试
node scripts/test.mjs test/usage-core.test.js test/usage-store.test.js

# 完整测试
npm.cmd test -- --test-reporter=spec --test-concurrency=4 --test-timeout=720000
```

测试使用 Node 内置 `node:test`。以退出码及通过、失败、跳过汇总判断结果。使用隔离 home 和 fixture，避免读写日常用量数据库。

浏览器测试通过 `AGENT_USAGE_PLAYWRIGHT_MODULE` 指定已安装 Playwright 的 `index.mjs`，可用 `AGENT_USAGE_EDGE_PATH` 指定 Edge。浏览器依赖只用于开发。原生行为测试可用 `Q6_TEST_HELPER` 指定助手，构建测试由 `AGENT_USAGE_TEST_NATIVE_BUILD=1` 启用。完整命令与环境见 [CI](../.github/workflows/ci.yml)。

PR 的新推送会取消同一 PR 的旧 CI。纯文档更改检查新增的本地链接、插图路径，以及删除文件后留下的引用。

代码 PR 在 Windows / Node 24 运行静态检查和核心测试，涉及来源、存储或 Windows 助手时加跑原生验收。代码进入 `main` 后跑 Windows / Node 24 全量。Ubuntu x64 和 Apple Silicon macOS 在代码 PR 和 `main` 上运行 Node 24 核心测试与 Playwright Chromium 验收。每周定时、手动和发布候选的兼容性检查使用 Node 26。

合并到 `main` 的 PR 必须通过 GitHub Actions 的 `test (24)`。纯文档 PR 通过轻量检查即可满足这项要求。

正式发布前，在 Actions 中对候选分支运行 [Release candidate](../.github/workflows/release.yml)，也可以用 `gh workflow run release.yml --ref <tag>` 指定标签。Node 26 兼容性检查与 Windows 打包并行。Windows 检查源码归档夹具，生成并验收 Waifu 和 Lite ZIP。两项通过后，Ubuntu 和 Apple Silicon macOS 下载同一次运行的这两份 ZIP，核对 SHA-256 和包内文件，然后用 Node 24 验收 CLI、HTTP 和 Playwright。下载成功运行上传的 ZIP 和 SHA-256 清单，用这批文件发布。

界面以桌面鼠标键盘操作为主，检查大屏、并排窗口和窄窗口，保留键盘导航、焦点恢复及减少动态效果支持。机制和费用解释放在用户展开的详情中。

## Windows 助手

构建需要 PowerShell 7、Rust/Cargo 和 Windows 主机工具链所需的链接器：

```powershell
npm.cmd run native:build
npm.cmd run native:check
```

产物为 `native/windows-source-proof/bin/windows-source-proof.exe` 和相邻的 `windows-source-proof.build.json`，两者一起分发。`native:check` 只读校验源码与二进制摘要，不需要 Rust；普通运行也不调用编译器。

助手利用已有 NTFS 变更日志加速来源核验，并提供归档读取租约。缺少来源证明时回退到内容核验；显式归档压实需要可用的文件租约。助手不会启用系统 journal。更多构建参数见[助手说明](../native/windows-source-proof/README.md)。

## 打包 v1.0a

在完成检查并准备好匹配的 Windows 助手后执行：

```powershell
npm.cmd run native:check
npm.cmd run package:release -- output/releases-v1.0a
npm.cmd run package:check -- output/releases-v1.0a --browser
```

输出目录须为 `output/` 下尚不存在的新目录。`releaseVersion: "1.0a"` 对应 `1.0a-waifu.zip` 和 `1.0a-lite.zip`。包内 `version` 为 `1.0.1`。

打包脚本收集实际依赖、各版页面资源、许可和 Windows 助手，不包含用户数据、开发依赖或作者 PNG。生成的 `release-manifest.json` 保存 ZIP 与逐文件 SHA-256。`package:check` 校验实际解包内容并运行隔离 HTTP 检查，`--browser` 追加浏览器检查；省略该参数只运行包与 HTTP 检查。

发布资源检查用 `skins:check`；只有重生成作者素材时才需要额外 PNG，见[皮肤维护](13-skins.md)。用户安装与数据迁移见[升级说明](15-delivery-upgrade.md)。

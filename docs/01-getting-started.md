# 开始使用

简体中文 · [English](01-getting-started.en.md)

两个版本均提供适用于 Windows x64、Ubuntu 24.04 x64 和 macOS 15（Apple Silicon）的 ZIP 运行包。包内 `version` 为 `1.0.2`。

- **[Waifu Usage（完整版）](https://github.com/Sylva1027/waifu-usage/releases/download/v1.0b/1.0b-waifu.zip)**：用量、趋势、费用估算、深浅主题、角色皮肤、分享和成就。
- **[Agent Usage（轻量版）](https://github.com/Sylva1027/waifu-usage/releases/download/v1.0b/1.0b-lite.zip)**：用量与趋势、来源管理、额度窗口和历史管理，采用简洁的深色界面。

[查看 v1.0b Release](https://github.com/Sylva1027/waifu-usage/releases/tag/v1.0b)。

## 安装与启动

1. 安装 [Node.js](https://nodejs.org/en/download) 23.8 或更高版本。
2. 将所选运行包解压到固定目录；已有安装先按[升级说明](15-delivery-upgrade.md)备份。
3. 在解压后的包根目录打开终端。两版运行包均直接运行下列命令，无需 `npm install` 或编译。

```sh
node src/cli.js dashboard
```

`dashboard` 在后台启动服务并用浏览器打开实际访问地址。首次默认尝试 3765，端口占用时尝试 3766–3770。下次启动优先尝试上次成功使用的备用端口。通过 `--port` 或 `PORT` 指定端口时，服务使用指定值。

用 `node src/cli.js stop` 停止后台服务。启动时若指定了 `--state-file`，停止时也传入同一路径。

亦可用 `node src/cli.js run` 在前台运行，打开终端打印的地址，按 `Ctrl+C` 停止。

## Windows 桌面快捷方式

在固定安装目录打开 PowerShell 7（`pwsh`）。两版运行包的 `$entryFile` 都是 `src/cli.js`，使用 Lite 源码时改为 `src/cli-lite.js`。为 Lite 创建快捷方式时，将 `$shortcutName` 改为 `Agent Usage.lnk`。

```powershell
$entryFile = 'src/cli.js'
$shortcutName = 'Waifu Usage.lnk'
$appDir = (Resolve-Path -LiteralPath .).ProviderPath
$cliEntry = (Resolve-Path -LiteralPath (Join-Path $appDir $entryFile) -ErrorAction Stop).ProviderPath
$nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $desktop $shortcutName))
$shortcut.TargetPath = $nodePath
$shortcut.Arguments = '"{0}" dashboard' -f $cliEntry
$shortcut.WorkingDirectory = $appDir
$shortcut.Save()
```

双击桌面快捷方式打开看板。移动安装目录后，从新目录重新创建快捷方式。

## 首次导入

打开来源管理，扫描常见目录，勾选找到的来源并点击“导入所选”。未找到时，使用“添加其他位置”选择工具的数据目录。导入选择目录，不选择单个日志或数据库文件。

导入依次读取记录、建立统计、校验并更新看板。关闭弹窗不会取消导入，刷新页面可以继续查看进度。完成后选择今日、本周、本月或其他日期范围；两版日期均按服务机器的本地时区解释。

网页只统计已确认的来源。默认每 60 秒检查新记录，暂停自动刷新可固定当前数据并继续切换范围。具体目录见[数据来源](10-data-sources.md)，界面操作见[看板使用](12-dashboard.md)。

## 数据保存与版本切换

默认数据目录为 `~/.codex-usage/`，其中 `~` 表示当前用户主目录。关闭网页或更新程序文件不会清空用量。

Waifu 与 Lite 沿用相同用量数据和来源配置。Lite 保留已有 Waifu 价格、皮肤偏好和独立成就档案；切回 Waifu 可继续使用。切换前停止旧实例，再启动另一版，步骤见[升级说明](15-delivery-upgrade.md)。

长期保留或换电脑时，使用[备份与转移](history-retention.md)。Waifu 成就档案需要一并保留，详见[成就说明](achievements.md)。

## 从源码运行

源码默认入口为 Waifu，Lite 使用独立入口：

```sh
node src/cli.js dashboard
node src/cli-lite.js dashboard --port 3766 --home-dir ./output/lite-home --state-file ./output/lite-services.json
```

第二条命令使用独立的数据目录与服务注册文件，适合与默认实例并行开发。用 `node src/cli-lite.js stop --state-file ./output/lite-services.json` 停止这个实例。 [开发指南](03-development.md)

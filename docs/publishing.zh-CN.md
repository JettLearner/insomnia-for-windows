# GitHub 发布清单（维护者）

> 维护者文档。以下命令尚未执行；创建公开仓库或 Release 前，请先获得明确授权。
> English: [publishing.md](publishing.md)

当前目标版本：**1.2.0**（含 Autopilot）。

## 1. 发布物

| 文件 | 是否入仓库 | 是否作为 Release 资产 |
|---|---|---|
| 源码、`resources/`、`scripts/`、`docs/`（不含构建产物与本地侦察素材） | 是 | 否（GitHub 自动生成源码包） |
| `LICENSE`、`README.md`、`README.zh-CN.md`、`SECURITY.md`、`SECURITY.zh-CN.md`、`.gitignore` | 是 | 否 |
| `design-archive/`（历史设计、评审、验收记录与旧发布说明） | 是 | 否 |
| `release/InsomniaZ-Windows-1.2.0-x64.exe` | 否（`release/` 已忽略） | 是 |
| `release/InsomniaZ-Windows-1.2.0-portable.exe` | 否 | 是 |
| `release/InsomniaZ-Windows-1.2.0-screenshots.zip` | 否 | 是 |
| `release/SHA256SUMS.txt` | 否 | 是 |
| `release/README.md` | 否 | 是 |
| `docs/release-notes-v1.2.0.md`（或中文版） | 是 | 作为 Release 正文 |

不要上传 `InsomniaZ-Windows-1.2.0-x64.exe.blockmap`：本项目没有自动更新。

`design-archive/probes/` 与 `design-archive/winrt-scratch/` 是原始桌面侦察 dump，含个人窗口标题与本机路径，已在 `.gitignore` 中，**永远不发布**。

## 2. 发布前检查

### 2.1 自动化验证

- [ ] `npm run typecheck` 通过（当前基线：0 错误）。
- [ ] `npm test` 通过（当前基线：**22 个文件 302 测试**）。
- [ ] `npm run build` 通过（主进程、渲染层、`InsomniaZHelper.exe`、`InsomniaZAuto.exe`）。
- [ ] `npx electron . --smoke` 全部通过，`docs/smoke.json` 无失败项。
  - 注意：`--smoke` 与 `npm run capture` 会改动**真实系统电源策略**。合盖保护生效期间不要跑。
- [ ] 冒烟结果写回 `docs/release-notes-v1.2.0.md` 的验证表。

### 2.2 实机验证（尚未完成，不得跳过）

- [ ] ZCode 有人值守端到端投递：模型同步 → 选模型 → 设思考强度 → 发送 → 落盘回读一致。
- [ ] WorkBuddy 有人值守端到端投递（PrintWindow + WinRT OCR 路径）。
- [ ] 压测：调度并发、长时间运行、负载下的保存节流、掉电/休眠前落盘。
- [ ] 三项完成后才允许打包二进制。

### 2.3 隐私与配置

- [ ] 仓库不含用户名、主机名、个人路径、日志、API Key、提示词正文或原应用商店素材。
- [ ] `docs/assets/`、`docs/appstore.json`、`.scratch/`、`build-out*/`、`release-*/` 均已在 `.gitignore` 中。
- [ ] 发布用二进制来自本次构建的 `win-unpacked`（不要复用 `release/win-unpacked`，那是仍在运行的旧版本）。
- [ ] `%APPDATA%\InsomniaZ\` 下的软叫停与 Autopilot 数据（profile、审计、目录、密钥）不得进仓库。

### 2.4 产物一致性

- [ ] `release/SHA256SUMS.txt` 与实际文件一致（在 `release/` 目录内执行 `sha256sum -c SHA256SUMS.txt`）。
- [ ] `release/README.md` 与 `docs/release-notes-v1.2.0.md` 说的是同一件事：文件清单、校验方法、限制说明。
- [ ] 安装包与便携版的版本资源为 1.2.0（`rcedit` 写入后回读确认）。
- [ ] README 中的截图路径存在；截图 zip 收录最新面板、引导、设置与 Autopilot 截图。

### 2.5 对用户的说明

- [ ] 明确告知：未签名、SmartScreen 会提示未知发布者。
- [ ] 明确告知：物理合盖行为未实测、保护性休眠未在真机执行。
- [ ] 明确告知：Autopilot **没有 dry-run / 白名单 / 确认闸门**，会真的点击发送。
- [ ] 明确告知：便携版不支持开机启动。

### 2.6 法务与元信息

- [ ] `LICENSE`（MIT）与 `SECURITY.md` / `SECURITY.zh-CN.md` 存在且内容正确。
- [ ] 所有文档都有中英双版本且互相链接。
- [ ] 声明中保留「与原作者无关联、不含原应用受版权保护素材」。

## 3. 打包（需用户确认后再执行）

```bash
npm run build
npx electron-builder --win --dir --x64 \
  --config.directories.output=build-out --config.win.signAndEditExecutable=false
.tools/winCodeSign/rcedit-x64.exe build-out/win-unpacked/InsomniaZ.exe \
  --set-icon release/.icon-ico/icon.ico \
  --set-version-string FileDescription InsomniaZ \
  --set-version-string ProductName InsomniaZ \
  --set-version-string CompanyName "Independent Windows port" \
  --set-version-string LegalCopyright "Copyright (c) 2026 Independent Windows port" \
  --set-file-version 1.2.0 --set-product-version 1.2.0.0
npx electron-builder --win nsis portable --x64 --prepackaged build-out/win-unpacked \
  --config.directories.output=build-out-installers --config.win.signAndEditExecutable=false
```

- 输出目录不要复用上次失败留下的死句柄目录（`EBUSY`）。
- 打包结束后把两个 exe 复制到 `release/`，改名 `InsomniaZ-Windows-1.2.0-*`。
- 生成 `release/SHA256SUMS.txt`：

```bash
cd release && sha256sum InsomniaZ-Windows-1.2.0-x64.exe InsomniaZ-Windows-1.2.0-portable.exe > SHA256SUMS.txt
```

## 4. 提交与推送

仓库已有本地提交历史（`git init` 已完成，**没有配置 remote**）。当前工作区有大量改动，提交前先自查：

```bash
git status --short
git add -A
git status --short          # 确认没有 release/、node_modules/、docs/assets/、build-out*/、design-archive/probes/
git commit -m "InsomniaZ for Windows 1.2.0"
```

建议仓库名：`insomniaz-windows`。描述：`Keep your Windows PC awake, even with the lid closed.`

首次推送（会创建公开仓库，需明确授权）：

```bash
gh repo create <owner>/insomniaz-windows --public --source=. --remote=origin --push
```

建议 topics：`windows`、`electron`、`tray`、`keep-awake`、`lid-close`、`power-management`、`automation`。

## 5. 创建 v1.2.0 Release

```bash
gh release create v1.2.0 \
  release/InsomniaZ-Windows-1.2.0-x64.exe \
  release/InsomniaZ-Windows-1.2.0-portable.exe \
  release/InsomniaZ-Windows-1.2.0-screenshots.zip \
  release/SHA256SUMS.txt \
  release/README.md \
  --title "InsomniaZ for Windows 1.2.0" \
  --notes-file docs/release-notes-v1.2.0.md
```

发布后检查：

- [ ] Release 页面显示 5 个资产，文件名与正文一致。
- [ ] 从 Release 下载安装版/便携版，`Get-FileHash` 与 `SHA256SUMS.txt` 一致。
- [ ] 安装版可启动、可退出；便携版可启动。
- [ ] Release 正文中的限制说明未被截断。

## 6. 后续版本

1. 修改 `package.json` 版本号（同时改 `package-lock.json` 的 `version` 与根包 `version`），重新构建 helper、渲染层与安装包。
2. 更新 `docs/release-notes-vX.Y.Z.md`（中英两版）与 `release/SHA256SUMS.txt`。
3. 用相同流程创建新 tag，不上传旧版本资产。
4. 若未来接入代码签名或自动更新，再评估 `blockmap` 与更新服务器；当前版本均不需要。

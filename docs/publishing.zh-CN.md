# GitHub 发布清单（维护者）

> 维护者文档。代码仓库已由维护者于 2026-11-09 推送并公开；v1.2.0 Release **尚未**创建，
> 建 Release 前请先获得明确授权。
> English: [publishing.md](publishing.md)

当前目标版本：**1.2.0**（维护版本）。

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

- [x] `npm run typecheck` 通过（当前基线：0 错误）。
- [x] `npm test` 通过（当前基线：**24 个文件 307 测试**）。
- [x] `npm run build` 通过（主进程、渲染层、`InsomniaZHelper.exe`、`InsomniaZAuto.exe`）。
- [x] `npx electron . --smoke` 全部通过，`docs/smoke.json` 无失败项——**2026-11-09 实测 44/44**。
  - 注意：`--smoke` 与 `npm run capture` 会改动**真实系统电源策略**。合盖保护生效期间不要跑。
- [x] 冒烟结果已写回 `docs/release-notes-v1.2.0.md` 的验证表（44/44 冒烟与 12/12 压测两行）。

### 2.2 实机验证

- [x] 压测：**2026-11-09 实测 12/12 通过**（`STRESS_MINUTES=3 npx electron . --stress`）。防休眠会话在两个满载
      CPU 进程下跑满 3 分钟窗口；36 次采样，最大间隔 5.0 秒；36 次设置写入期间文件始终可解析；
      提权 helper 全程在线；停用后会话文件被清除。进程树内存峰值 176.1 MB，应用 CPU 峰值 0%。
      报告见 `docs/stress.json`。
- [x] 冒烟与压测均为绿，可以打包二进制。
- [x] 安装包已于 2026-11-09 改名 *Insomnia for Windows* 后重新构建：`build-out10/win-unpacked` →
      `rcedit` 写入 1.2.0 图标/版本 → `build-out10-installers`，再 staging 到 `release/`，校验和与
      截图 zip 均已重新生成。便携版已于 2026-11-09 在真实桌面启动抽查（启动日志 `packaged:true`、
      helper 1.2.0 在线、面板以新品牌渲染正常）。
- [x] 公开仓库已建立且 `main` 已推送：`origin` 指向
      <https://github.com/JettLearner/insomnia-for-windows>，由维护者于 2026-11-09 创建并推送。
- [ ] 创建 v1.2.0 Release 及其附件仍需你明确放行。

### 2.3 隐私与配置

- [x] 仓库不含用户名、主机名、个人路径、日志、API Key、提示词正文或原应用商店素材。2026-11-08 对工作区
      **与全部历史提交**（`git rev-list --all` 上跑 `git grep`）扫描：零命中；历史中最大 blob 为 0.28 MB
      的截图，二进制与 dump 从未进入历史。
- [x] `docs/assets/`、`docs/appstore.json`、`.scratch/`、`build-out*/`、`release-*/` 均已在 `.gitignore` 中；
      `git status --short --ignored` 列出的正是预期的本地目录。
- [x] 发布用二进制来自本次构建的 `win-unpacked`（`build-out8/win-unpacked`），未复用 `release/win-unpacked`
      （那是 1.0.0 的旧目录）。
- [x] `%APPDATA%\InsomniaZ\` 下的软叫停数据（profile、审计、已存密钥）不进仓库；截图在隔离的
      `docs/.capture-profile` profile 中采集。

### 2.4 产物一致性

- [x] `release/SHA256SUMS.txt` 与实际文件一致（2026-11-09 在 `release/` 内执行 `sha256sum -c`，两项均 OK）。
- [x] `release/README.md` 与 `docs/release-notes-v1.2.0.md` 说的是同一件事：文件清单、校验方法、限制说明；
      发布说明已写入真实大小与 SHA-256。
- [x] 安装包与便携版的版本资源为 1.2.0（`rcedit` 后用 `VersionInfo.FileVersion/ProductVersion` 回读）；
      `Get-AuthenticodeSignature` 两者均为 `NotSigned`，与文档口径一致。
- [x] README 中的截图路径存在；截图已于 2026-11-09 刷新到 v1.2.0（capture 模式不再强制启用未发布的
      调度器），zip 收录 21 张最新面板、引导与设置截图。

### 2.5 对用户的说明

- [x] 明确告知：未签名、SmartScreen 会提示未知发布者。中英 README、中英发布说明与 `release/README.md` 均已写明。
- [x] 明确告知：物理合盖行为未实测、保护性休眠未在真机执行。同上四份文档均已写明。
- [x] 明确告知：便携版不支持开机启动。同上四份文档均已写明。

### 2.6 法务与元信息

- [x] `LICENSE`（MIT）与 `SECURITY.md` / `SECURITY.zh-CN.md` 存在且内容正确。
- [x] 所有文档都有中英双版本且互相链接（2026-11-08 逐对核对）。
- [x] 声明中保留「与原作者无关联、不含原应用受版权保护素材」。

## 3. 打包（需用户确认后再执行）

已于 2026-11-09 执行，输出目录为 `build-out10` 与 `build-out10-installers`，产物已 staging 到 `release/`。
以下为可复用命令：

```bash
npm run build
npx electron-builder --win --dir --x64 \
  --config.directories.output=build-out --config.win.signAndEditExecutable=false
.tools/winCodeSign/rcedit-x64.exe "build-out/win-unpacked/Insomnia for Windows.exe" \
  --set-icon release/.icon-ico/icon.ico \
  --set-version-string FileDescription "Insomnia for Windows" \
  --set-version-string ProductName "Insomnia for Windows" \
  --set-version-string CompanyName "JettLearner" \
  --set-version-string LegalCopyright "Copyright (c) 2026 JettLearner" \
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

仓库已有本地提交历史，`origin` 已配置，`main` 已由维护者于 2026-11-09 推送。验证提交之后工作区是
干净的。再有新改动时提交前先自查：

```bash
git status --short
git add -A
git status --short          # 确认没有 release/、node_modules/、docs/assets/、build-out*/、design-archive/probes/
git commit -m "Insomnia for Windows 1.2.0"
```

仓库地址：<https://github.com/JettLearner/insomnia-for-windows>（公开）。描述：`Keep your Windows PC
awake, even with the lid closed.`

首次推送已由维护者执行，用到的形式是：

```bash
gh repo create JettLearner/insomnia-for-windows --public --source=. --remote=origin --push
```

topics：`windows`、`electron`、`tray`、`keep-awake`、`lid-close`、`power-management`、`automation`。

## 5. 创建 v1.2.0 Release

```bash
gh release create v1.2.0 \
  release/InsomniaZ-Windows-1.2.0-x64.exe \
  release/InsomniaZ-Windows-1.2.0-portable.exe \
  release/InsomniaZ-Windows-1.2.0-screenshots.zip \
  release/SHA256SUMS.txt \
  release/README.md \
  --title "Insomnia for Windows 1.2.0" \
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

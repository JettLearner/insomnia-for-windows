# GitHub 发布清单

> 维护者文档。以下命令尚未执行；创建公开仓库或 Release 前，请先获得明确授权。

## 1. 发布物

| 文件 | 是否入仓库 | 是否作为 Release 资产 |
|---|---|---|
| 源码、`resources/`、`scripts/`、`docs/`（不含研究素材与构建产物） | 是 | 否（GitHub 自动生成源码包） |
| `LICENSE`、`README.md`、`SECURITY.md`、`.gitignore` | 是 | 否 |
| `release/InsomniaZ-Windows-1.0.0-x64.exe` | 否（`release/` 已忽略） | 是 |
| `release/InsomniaZ-Windows-1.0.0-portable.exe` | 否 | 是 |
| `release/InsomniaZ-Windows-1.0.0-screenshots.zip` | 否 | 是 |
| `release/SHA256SUMS.txt` | 否 | 是 |
| `release/README.md` | 否 | 是 |
| `docs/release-notes-v1.0.0.md` | 是 | 作为 Release 正文 |

不要上传 `InsomniaZ-Windows-1.0.0-x64.exe.blockmap`：本项目没有自动更新。

## 2. 发布前检查

- [ ] `npm run typecheck` 与 `npm test` 通过。
- [ ] `release/` 中二进制来自当前源码；本轮已确认源码没有晚于 `release/win-unpacked/resources/app.asar` 的改动。
- [ ] `release/SHA256SUMS.txt` 与实际文件一致（`sha256sum -c release/SHA256SUMS.txt`，在 `release/` 目录内执行）。
- [ ] 仓库不包含用户名、主机名、个人路径、日志和原应用商店素材；`docs/assets/` 与 `docs/appstore.json` 已在 `.gitignore` 中。
- [ ] `README.md` 中的截图路径存在，Release 正文与 `docs/release-notes-v1.0.0.md` 一致。
- [ ] 明确告知用户：未签名、合盖物理行为未实测、便携版不支持开机启动。
- [ ] 已确认 `LICENSE` 与 `SECURITY.md` 的存在与内容。

## 3. 创建仓库

```bash
git init -b main
git add .
git status --short          # 确认没有 release/、node_modules/、docs/assets/、.scratch/
git commit -m "InsomniaZ for Windows 1.0.0"
```

建议仓库名：`insomniaz-windows`。描述：`Keep your Windows PC awake, even with the lid closed.`

首次推送（会创建公开仓库，需明确授权）：

```bash
gh repo create <owner>/insomniaz-windows --public --source=. --remote=origin --push
```

建议 topics：`windows`、`electron`、`tray`、`keep-awake`、`lid-close`、`power-management`。

## 4. 创建 v1.0.0 Release

```bash
gh release create v1.0.0 \
  release/InsomniaZ-Windows-1.0.0-x64.exe \
  release/InsomniaZ-Windows-1.0.0-portable.exe \
  release/InsomniaZ-Windows-1.0.0-screenshots.zip \
  release/SHA256SUMS.txt \
  release/README.md \
  --title "InsomniaZ for Windows 1.0.0" \
  --notes-file docs/release-notes-v1.0.0.md
```

发布后检查：

- [ ] Release 页面显示 5 个资产，文件名与正文一致。
- [ ] 从 Release 下载安装版/便携版，`Get-FileHash` 与 `SHA256SUMS.txt` 一致。
- [ ] 安装版可启动、可退出；便携版可启动。
- [ ] Release 正文中的限制说明未被截断。

## 5. 后续版本

1. 修改 `package.json` 版本号，重新构建 helper、渲染层与安装包。
2. 更新 `docs/release-notes-vX.Y.Z.md` 与 `release/SHA256SUMS.txt`。
3. 用相同流程创建新 tag，不上传旧版本资产。
4. 若未来接入代码签名或自动更新，再评估 `blockmap` 与更新服务器；当前版本均不需要。

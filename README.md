# InsomniaZ for Windows

> 合盖也不睡，任务不停。  
> 对 macOS 菜单栏应用 **InsomniaZ – Never Sleep** 的独立 Windows 移植版，与原作者无关联。

<p align="center">
  <img src="docs/captures/panel-active-on-zh.png" alt="InsomniaZ 主面板" width="300">
  <img src="docs/captures/packaged-onboarding-final.png" alt="首次启动引导" width="300">
</p>

纯托盘应用：所有窗口都不占任务栏，关闭窗口只隐藏，退出由托盘菜单控制。原菜单栏图标的点击、长按与右键能力，全部收进托盘交互：左键打开控制面板，右键打开完整原生菜单，长按面板状态环打开设置。

## 下载

安装包与便携版发布在 [GitHub Releases](../../releases/latest)。

| 文件 | 说明 |
|---|---|
| `InsomniaZ-Windows-1.0.0-x64.exe` | 安装版（推荐）。按用户安装，可选择安装目录，创建开始菜单与桌面快捷方式。 |
| `InsomniaZ-Windows-1.0.0-portable.exe` | 便携版。单个 exe 直接运行，不写安装目录；设置仍保存在 `%APPDATA%\InsomniaZ\`。 |
| `SHA256SUMS.txt` | 两个二进制文件的 SHA-256，下载后请核对。 |

- 系统要求：Windows 10 22H2 或 Windows 11，x64。
- 安装包未做代码签名，SmartScreen 可能提示“未知发布者”。可先核对 SHA-256，再选择“更多信息 → 仍要运行”。
- 合盖保护需要管理员授权；拒绝 UAC 不影响其余防睡眠功能，界面会明确标注合盖保护不可用。
- 应用本身不联网、不检查更新；新版本需要手动下载。

## 功能

- **防睡眠**：激活时通过 Electron `powerSaveBlocker` 与提权助手的 `SetThreadExecutionState` 双层保持系统唤醒。
- **合盖继续运行**：把当前电源方案的合盖动作临时改为“不采取任何操作”（AC/DC 同时生效）。写入前备份原值，写入后回读校验；退出或崩溃时自动还原，异常重启后会在下次启动时提示恢复。
- **显示模式**：`On` 屏幕常亮；`Auto` 屏幕可关闭、系统继续运行。
- **定时会话**：15 分钟 / 30 分钟 / 1 小时 / 2 小时 / 4 小时 / 8 小时 / ∞；到点自动结束。异常退出后可恢复未到期会话（不会静默恢复合盖权限）。
- **高级模式**：按 30–300 秒间隔发送无害的 F15 按键，避免 Teams、Slack 等把电脑判定为空闲。
- **低电量保护**：默认 20%，可配置 5–95%；可选“使用电池时停止”。
- **全局快捷键**：默认 `Ctrl+Alt+I`，可在设置中录制、恢复默认，冲突时明确提示。
- **托盘右键菜单全集**：开关、时长、显示模式、合盖保护、活动模拟、打开面板、设置、关于、兼容性检查、退出。
- **外观与语言**：中英双语、深色/浅色/跟随系统、紧凑布局、系统通知开关。
- **零网络、零遥测**：无分析 SDK、无自动更新、无后台下载；主进程安装网络守卫，渲染层使用严格 CSP。

## 交互映射

| macOS 菜单栏 | Windows |
|---|---|
| 左键图标打开 popover | 左键托盘图标打开控制面板（可在设置关闭） |
| 右键菜单 | 右键托盘图标打开完整原生菜单 |
| 菜单栏图标着色/灰显 | `tray-active.png` / `tray-idle.png`，Tooltip 显示剩余时间 |
| 无 Dock 图标 | 所有窗口 `skipTaskbar`，主面板使用工具窗口样式 |
| 长按状态环 | 面板内按住状态环 550 ms 打开设置 |
| 全局快捷键 | `Ctrl+Alt+I` 切换会话 |

## 使用

1. 运行安装包，或直接运行便携版。
2. 首次启动显示三步引导；完成后应用只在托盘运行。
3. 左键托盘图标打开面板；右键打开完整菜单。
4. 点按状态环或状态胶囊开始/停止；选择时长会立即开始计时。
5. 需要合盖继续运行时，在面板或右键菜单打开“合盖后保持运行”，按提示授予管理员权限。
6. 关闭面板只是隐藏；要彻底退出，使用面板右下角“退出”或托盘菜单“退出”。

## 为什么需要管理员权限

Windows 没有面向普通应用的“合盖不睡眠”开关，只能修改当前电源方案中的 `LIDACTION`（合盖动作），这需要管理员权限。本项目不安装服务、不写计划任务；提权助手只在开启合盖保护时运行：

- 只有开启“合盖后保持运行”时才通过 UAC 启动助手；
- 助手只接受固定命令集，使用随机命名管道、随机 token 和父进程监视；
- 父进程退出或崩溃时，助手会还原原合盖策略并退出；
- 异常重启后，下次启动会提示恢复未还原的策略，需再次确认 UAC；
- 正常退出会删除 `%APPDATA%\InsomniaZ\lid-recovery.json`。

如果拒绝 UAC，防睡眠、显示模式、定时、快捷键等功能仍然可用，只有合盖保护不可用。

## 隐私与安全

- 设置、会话与日志保存在 `%APPDATA%\InsomniaZ\`；不写入其他注册表位置（用户主动开启的开机启动除外）。
- 合盖原值备份在 `%APPDATA%\InsomniaZ\lid-recovery.json`，正常退出即删除。
- 诊断导出只包含版本、电源能力、状态与日志，由用户主动触发。
- 应用不发起远程请求；渲染层启用 `contextIsolation`、`sandbox`，禁用 `nodeIntegration`，使用严格 CSP；生产构建禁用 DevTools。
- 完整设计与威胁模型见 [架构设计](docs/02-architecture.md) 与 [安全评审](docs/05-review.md)。

## 验证状态

本次 1.0.0 在 Windows 10 22H2（19045，x64）上完成：

| 项目 | 结果 |
|---|---|
| 类型检查 | 通过 |
| Vitest 单元/集成 | **58/58 通过**（含真实 helper 进程集成） |
| 真实 Electron 冒烟 | **37/37 通过** |
| 全新用户目录首启冒烟 | **8/8 通过** |
| 最终二进制端到端 | 引导 → 跳过 → 面板 → 设置 → 退出；helper 正常回收，无残留恢复文件 |
| 合盖策略真实写入/恢复 | 提权、写入、退出还原已在真机走通；物理合盖未测 |

证据与限制见 [验收报告](docs/04-acceptance.md) 和 [设计、代码与安全评审](docs/05-review.md)。

## 已知限制

- **物理合盖未实测**：提权、策略写入与退出恢复已在真机走通，但未真正合上盖子验证任务不中断，也未测试合盖状态下拔插电源。建议首次使用在有管理员权限的机器上按验收报告 8.2 节手工确认。
- **未做代码签名**：SmartScreen 会提示未知发布者；请用 `SHA256SUMS.txt` 校验。
- **Windows 11 / OEM 电源方案未逐一覆盖**：仅在 Windows 10 22H2 的平衡方案上实测；其他方案走同一 Power API 路径。
- **通知视觉未人工确认**：Windows 通知中心是否展示、是否被专注助手拦截，需要按机器策略确认。
- **安装版开机启动未做重启验证**：设置项已实现；便携版按设计不支持开机启动。
- **NSIS 安装/卸载流程未在全新系统实测**：安装包由已验收的 `win-unpacked` 目录生成；建议首次部署时按验收报告 8.2 节同时确认安装、卸载与开机启动。
- **内存高于设计目标**：空闲实测约 213 MB（应用 186 MB + helper 27 MB），高于 160 MB 目标；空闲 CPU 0–0.16%。这是 Electron 38 三进程基线的代价。
- **多显示器 / Modern Standby 为尽力适配**：面板按光标所在显示器工作区定位，仅在单显示器 150% 缩放下实测。
- **UI 复刻边界**：官方仅提供 5 张商店截图，设置页、引导页与部分状态属于同设计语言的合理推断，不是逐像素复制。

## 开发与构建

要求 Node.js 22+、npm 10+。Windows 构建还需要系统自带的 .NET Framework 4.8 编译器（`csc.exe`）来编译提权助手。

```bash
npm install
npm run dev        # Vite + Electron 热更新
npm run typecheck  # 主进程 + 渲染进程 + 测试类型检查
npm test           # Vitest 单元/集成测试
npm run build      # 主进程 + 渲染进程 + helper
npm start          # 生产构建后启动
npm run capture    # 生成 docs/captures 界面截图
npx electron . --smoke        # 37 项真实交互冒烟（需先 npm run build）
npx electron . --smoke-fresh  # 全新用户目录首启冒烟（8 项）
npm run dist       # NSIS + 便携版，输出 release/
```

<details>
<summary>离线/镜像环境打包与资源写入说明</summary>

`electron-builder` 默认从 GitHub 下载 Electron 与 NSIS 资源。受限网络下可设置镜像，并按“目录包 → 写入图标/版本信息 → 生成安装包”的顺序执行：

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run build
npx electron-builder --win --dir --x64 \
  --config.directories.output=build-out --config.win.signAndEditExecutable=false
.tools/winCodeSign/rcedit-x64.exe build-out/win-unpacked/InsomniaZ.exe \
  --set-icon release/.icon-ico/icon.ico \
  --set-version-string FileDescription InsomniaZ \
  --set-version-string ProductName InsomniaZ \
  --set-version-string CompanyName "Independent Windows port" \
  --set-version-string LegalCopyright "Copyright (c) 2026 Independent Windows port" \
  --set-file-version 1.0.0 --set-product-version 1.0.0.0
npx electron-builder --win nsis portable --x64 --prepackaged build-out/win-unpacked \
  --config.directories.output=build-out-installers --config.win.signAndEditExecutable=false
```

若 `release/` 被上次失败留下的句柄锁住，换一个 `--config.directories.output` 即可；不要复用死句柄目录。`rcedit-x64.exe` 来自 electron-builder 下载的 winCodeSign 包，不随仓库分发。

</details>

## 文档

- [需求规格与功能基线](docs/01-requirements.md)
- [架构设计](docs/02-architecture.md)
- [UI 规范](docs/03-ui-spec.md)
- [验收报告](docs/04-acceptance.md)
- [设计、代码与安全评审](docs/05-review.md)
- [v1.0.0 发布说明](docs/release-notes-v1.0.0.md)
- [发布清单（维护者）](docs/06-publishing.md)
- [安全策略](SECURITY.md)
- 界面截图：[docs/captures](docs/captures)

## 许可与声明

代码以 [MIT](LICENSE) 许可发布。**InsomniaZ** 名称与相关商标归原作者所有，本项目仅用于说明移植目标，与原作者无关联。界面采用相同设计语言，图标与素材为自绘，不包含原应用受版权保护的资源。

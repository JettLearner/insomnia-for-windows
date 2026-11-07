# InsomniaZ for Windows 1.1.0

> 2026-10-31 · Windows 10 22H2 / Windows 11 · x64

这是 macOS 菜单栏应用 **InsomniaZ – Never Sleep** 的独立 Windows 移植版。1.1.0 在 1.0.0 的防休眠、显示模式、定时、低电量保护、托盘与双语界面上，加入 **Soft Stop 软叫停**：电量降到阈值 A 时向正在运行的 AI 发送一段固定提示词，降到更低的阈值 B 时结束会话并执行保护性休眠。

**与原作者无关联，未包含原应用受版权保护的素材。**

## 下载

| 文件 | 大小 | 用途 |
|---|---:|---|
| `InsomniaZ-Windows-1.1.0-x64.exe` | 96,617,266 字节（约 92.1 MiB） | NSIS 安装版（推荐），按用户安装，可改目录 |
| `InsomniaZ-Windows-1.1.0-portable.exe` | 96,385,143 字节（约 91.9 MiB） | 便携版，单文件运行 |
| `InsomniaZ-Windows-1.1.0-screenshots.zip` | 2,927,469 字节（20 张） | 面板、引导、设置（含软叫停）截图 |
| `SHA256SUMS.txt` | — | 二进制校验和 |
| `README.md` | — | 下载与使用说明 |

### SHA-256

```text
b155e9177b8bf7d224891fdfcd839cf8e5ec1d0b7c896ccd7ed5f4500e3ff75b  InsomniaZ-Windows-1.1.0-x64.exe
cd6289bfdf2b0ef1aaf24b74030204dca27f08d878795ebb3539da9ddd8e34ec  InsomniaZ-Windows-1.1.0-portable.exe
```

PowerShell 校验：

```powershell
Get-FileHash .\InsomniaZ-Windows-1.1.0-x64.exe -Algorithm SHA256
Get-FileHash .\InsomniaZ-Windows-1.1.0-portable.exe -Algorithm SHA256
```

## 1.1.0 新增

- **两级电量软叫停**：阈值 A 发送提示词，阈值 B 结束会话并调用 helper 执行保护性休眠；仅在使用电池且会话进行中触发。
- **AI 活动判定**：无线/蜂窝网络的持续流式传输、本地 AI 运行时进程、以及配置的端点；无活动时不打扰，B 点仍无条件保护。
- **多种投递目标**：OpenAI 兼容 HTTP、Webhook、本地 CLI、内置知识库命令，以及 GUI Agent 回退。未知 CLI/TUI 不会被盲目注入按键。
- **通用 GUI 识别器**：基于 Windows UI Automation / MSAA，识别输入框、侧边栏与发送键；支持多语言词典、几何评分、Chromium 惰性无障碍重试，动作后回读校验。
- **示教录制**：只记录鼠标点击与悬停，**不记录键盘输入、文字、顺序或时长**；自动推断 input/send 标签，用户可确认或修改；profile 保存控件指纹而非屏幕坐标。
- **安全默认**：dry-run 默认开启；远程端点默认关闭，需显式允许；API 密钥用 Windows DPAPI 保存；GUI 动作受白名单、首次确认与提示词长度限制。
- **可靠性**：A 点每次电量周期最多尝试 2 次、间隔 5 分钟；配置错误不消耗尝试次数；充电或电量回到 A+5 以上后重置。
- **界面**：设置新增 Soft Stop 页（5 张卡片、双阈值滑杆、相位芯片、检测结果、发送测试、示教与验证、审计记录）；中英文案对齐。
- **修复**：About 页系统信息中的 Windows port 版本号改为跟随应用版本，不再硬编码 1.0.0。

## 安装与升级

1. 优先选择安装版；不想安装时直接运行便携版。可直接覆盖安装 1.0.0，设置与会话数据保留。
2. 校验 SHA-256。安装包未签名，SmartScreen 可能提示未知发布者；确认校验和后可选择“更多信息 → 仍要运行”。
3. 首次启动完成三步引导，应用转入托盘。
4. 软叫停默认关闭；开启后建议先用 dry-run 与 “Send a test prompt” 验证目标，再启用真实发送。
5. 开启“合盖后保持运行”时会出现一次 UAC；拒绝后其余防睡眠功能仍可用。

本版没有自动更新，请手动下载新版本覆盖安装。安装版会创建开始菜单与桌面快捷方式；卸载后 `%APPDATA%\InsomniaZ\` 中的设置、日志与软叫停配置会保留，需要彻底清理时手动删除该目录。

## 验证

- TypeScript 类型检查通过。
- Vitest 单元/集成 **149/149**（12 个文件，含真实 helper 进程、真实 HTTP socket 的 OpenAI 兼容发送、鉴权头、提示词渲染、HTTP 500 与 dry-run 零连接）。
- 真实 Electron 冒烟 **44/44**（最终源码，含 Soft Stop 页面、5 卡片、双阈值、开关、相位芯片与 AI 活动探测）。
- 真实 WinForms 窗口：输入框 0.95、发送键 0.97；中文提示词完整写入并点击发送，落盘内容与提示词一致；示教录制 3 个鼠标事件，`leakedPrompt=false`；profile 重扫命中正确。
- 成品 `app.asar` 已核对版本 1.1.0 与软叫停代码；安装包版本资源为 1.1.0，未签名。
- 合盖策略的提权、写入与退出还原已在真机走通。

## 已知限制

- **B 点保护性休眠未在真机执行**：为避免中断验收会话，只验证了状态机与 helper `suspend` 链路；请在有人值守时用设置页 “Sleep now” 首次确认。
- **物理合盖未实测**：包括合盖状态下拔插电源；请按 `docs/04-acceptance.md` 8.2 节在目标机器上确认。
- **GUI 自动化边界**：依赖目标应用的 UI Automation 可访问性；纯 Canvas 界面、以管理员运行的目标应用可能无法识别。GUI 点击存在误点风险，默认需要白名单与确认。
- **远程端点隐私**：只有显式启用远程 Soft Stop 后，提示词才会发往你配置的地址；本应用本身不收集遥测。
- **未签名**：SmartScreen 会提示未知发布者。
- **安装/卸载流程未在全新系统实测**：安装包由已验收的 `win-unpacked` 目录生成；便携版不支持开机启动。
- **Windows 11、不同 OEM 电源方案、通知视觉与安装版开机启动**仍需在目标机器上按需确认。

完整证据、复核步骤与评审结论见仓库中的 `docs/04-acceptance.md`、`docs/07-soft-stop.md` 与 `docs/05-review.md`。

## 许可

代码以 MIT 许可发布；`InsomniaZ` 名称与相关商标归原作者所有。本项目与原作者无关联，不包含原应用的图标、截图或其他受版权保护的资源。

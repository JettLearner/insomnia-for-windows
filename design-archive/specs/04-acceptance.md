# InsomniaZ for Windows — 验收报告

> **已归档 / Archived** — 历史设计记录，不代表当前行为。现行文档见 [`docs/`](../../docs) 与 [README](../../README.zh-CN.md)。
> Historical design record, not current behaviour. See [`docs/`](../../docs) and the [README](../../README.md).

> 版本：1.0.0  
> 验收日期：2026-10-31  
> 判定：**通过（附带 6 项环境限制，见第 8 节）**

---

## 0. 结论摘要

| 项目 | 结果 |
|---|---|
| 单元 / 集成测试 | 5 个文件，**58/58 通过**（含真实 helper 进程集成） |
| 真实 Electron 冒烟 | **37/37 通过**（`docs/smoke.json`，2026-10-31 16:57:41） |
| 全新用户目录首启冒烟 | **8/8 通过**（`docs/smoke-fresh.json`，2026-10-31 16:57:44） |
| 最终打包产物端到端 | 通过：引导 → 跳过 → 面板 → 设置 → 退出；helper 正常回收，无残留恢复文件 |
| 安装包 | NSIS + 便携版均生成，SHA-256 已记录；未签名 |
| 合盖策略真实写入 / UAC | **提权、写入与恢复流程已在真机走通**（17:13–17:14，见 4.2）；物理合盖行为未测 |
| 空闲内存目标 < 160 MB | **未达成**：实测 212.9 MB（应用 186.1 + helper 26.8） |

“通过”指：除第 8 节明确列出的限制外，需求矩阵中的 P0 项均具备可复核证据；所有自动化检查零失败。

---

## 1. 验收环境

| 项 | 值 |
|---|---|
| 操作系统 | Microsoft Windows 10 专业版，10.0.19045（22H2），x64 |
| 设备 | 12th Gen Intel Core i7-1260P，约 32 GB RAM |
| 显示 | 物理 1920×1200，缩放 150%（144 DPI），Electron 工作区 1280×760 DIP |
| 账户 | 标准用户，**非管理员**（合盖写入经 UAC 提权） |
| Node / npm | v24.21.0 / 11.19.0 |
| Electron | 38.8.6（Chromium 140.0.7339.249） |
| 构建工具 | Vite 7.3.7、TypeScript 5.9.3、electron-builder 26.0.12、Vitest 3.2.4 |
| Helper | .NET Framework 4.8，`csc.exe` 编译，26,624 字节 |

---

## 2. 验收方法与判定规则

1. **自动化优先**：能用断言证明的，不靠截图目测。
2. **真实进程**：helper 测试启动真实 `InsomniaZHelper.exe`，不走 mock；冒烟测试启动真实 Electron、真实托盘、真实窗口、真实计时器。
3. **最终产物验证**：不只验证开发模式；对 `release/win-unpacked` 的最终二进制做启动、窗口、退出与进程回收验证。
4. **失败即失败**：任一检查项返回 `ok:false` 即整体不通过；不使用“部分通过”掩盖。
5. **不能测的必须写出来**：物理合盖、通知视觉、Win11 兼容性、签名，均在限制章节列明，不声称已验证。

---

## 3. 自动化测试

### 3.1 Vitest（58/58）

命令：`npx vitest run`

| 文件 | 数量 | 覆盖内容 |
|---|---:|---|
| `tests/format.test.ts` | 12 | 倒计时格式、时长标签、本地化数字与边界 |
| `tests/shortcut.test.ts` | 10 | 加速键规范化、非法输入、冲突语义、空格键别名 |
| `tests/settings.test.ts` | 20 | 脏数据清洗、枚举回退、阈值钳制、时长范围、会话恢复规则、原型污染键 |
| `tests/i18n.test.ts` | 9 | 中英 key 对齐、占位符一致、真实翻译、插值、未知 key 回退 |
| `tests/helper.integration.test.ts` | 7 | 真实 helper：握手、PID 上报、执行状态开关、F15 jiggle、提权守卫、恢复查询、退出重连、日志落盘 |
| **合计** | **58** | 全部通过，0 失败 |

关键断言：

- helper 返回的 `parentPid` 等于测试进程 PID，`helperPid` 是另一个真实进程。
- 非提权时 `applyLid` 返回 `ELEVATION_REQUIRED`，**不会**写入真实电源策略。
- `recoverLid` 在无备份时返回 `RECOVERY_NONE`。
- helper 停止后可重新连接，日志文件存在。

### 3.2 真实交互冒烟（37/37）

命令：`npx electron . --smoke`  
证据：`docs/smoke.json`（`ok: true`，37 项，0 失败）

| 类别 | 检查项 | 结果 / 关键证据 |
|---|---|---|
| 面板 | `panel.render` | 无 bootError，文本长度 406 |
| 面板 | `panel.bounds` | 416×724（392×700 表面 + 12px 阴影边） |
| 面板 | `panel.skip-taskbar` | 原生 exStyle=524424（0x80088：TOOLWINDOW+LAYERED+TOPMOST） |
| 面板 | `panel.placement` | 1280×760 工作区内 x=856,y=28，未越界 |
| 交互 | `panel.toggle-on` | active=true |
| 交互 | `panel.ring-reflects-state` | aria-checked=true |
| 时长 | `panel.duration-1h` | durationMs=3,600,000 |
| 时长 | `panel.duration-presets` | 15m/30m/1h/2h/4h/8h 全部正确，∞ → null |
| 显示 | `panel.display-on` | display=on，随后可切回 auto |
| 计时 | `session.auto-expire` | 1.2s 会话在 2.6s 后自动结束，before=true after=false |
| 手势 | `panel.long-press-settings` | 长按状态环打开设置 |
| 设置 | `settings.render` | 无 bootError |
| 设置 | `settings.nav-count` | 7 个分区 |
| 设置 | `settings.section-0..6` | General/Shortcuts/Power/Battery/Appearance/Privacy/About 全部存在 |
| 主题 | `settings.toggles-dark` | 选中底色 rgb(142,99,236)，滑块位移 17px |
| 主题 | `settings.toggles-light` | 选中底色 rgb(122,79,224)，未选中 rgb(218,213,229) |
| 主题 | `settings.theme-ui-light` / `-system` | 浅色与跟随系统均生效 |
| 密度 | `settings.density-compact` | compact 生效 |
| 语言 | `settings.language-zh` | 导航显示“通用” |
| 窗口 | `settings.close-hides` | 关闭后窗口未销毁、不可见（托盘应用语义） |
| 引导 | `onboarding.render` / `step1..3` | 3 步，英文文案正确 |
| 引导 | `onboarding.finish` | 完成后隐藏且 onboardingComplete=true |
| 引导 | `onboarding.panel-after` | 完成后自动打开面板 |
| 托盘 | `tray.menu` | 21 个标签，缺失=none |
| 托盘 | `tray.tooltip` | `InsomniaZ — READY · indefinite` |
| 快捷键 | `shortcut.registered` | Ctrl+Alt+I 已注册 |

### 3.3 全新用户目录首启（8/8）

命令：`npx electron . --smoke-fresh`  
证据：`docs/smoke-fresh.json`（`ok: true`，8 项，0 失败）

| 检查 | 证据 |
|---|---|
| `fresh.onboarding-auto-open` | 首启自动显示引导 |
| `fresh.onboarding-render` | 中文“第 1 步”，有“下一步”，无 bootError |
| `fresh.onboarding-onscreen` | 窗口位于可见工作区 |
| `fresh.default-settings` | onboardingComplete=false，快捷键 Ctrl+Alt+I |
| `fresh.panel-hidden` | 未完成引导前不显示面板 |
| `fresh.tray-ready` | 托盘就绪，中文 Tooltip“就绪 · 无限期”，21 项菜单 |
| `fresh.shortcut-registered` | Ctrl+Alt+I 注册成功 |
| `fresh.helper-connected` | helper 1.0.0 已连接，elevated=false，lidPolicySupported=true，无恢复残留 |

### 3.4 单实例验证

- 先启动最终 `release/win-unpacked/InsomniaZ.exe`，再启动第二个同程序。
- 第二次启动进程立即退出（exit 0），日志中没有第二条 `InsomniaZ starting`。
- Win32 进程查询显示顶层实例始终为 **1 个**；第二次启动只触发了首个实例显示面板。
- 结果：单实例有效，不会产生第二个托盘图标。

---

## 4. 最终打包产物端到端验收

对象：`release/win-unpacked/InsomniaZ.exe`（2026-10-31 16:56 打包，SHA-256 见第 5 节）。  
方法：真实鼠标点击（DPI-aware `SendMouse`），`PrintWindow` 抓取真实窗口，读取 `%APPDATA%\InsomniaZ` 日志、设置与 Windows 电源策略。

### 4.1 真实交互与退出（最终二进制）

| 时间（CST） | 动作 | 观察结果 |
|---|---|---|
| 17:16:02 | 启动最终产物 | 日志 `packaged:true`，Electron 38.8.6，中文 locale |
| 17:16:02 | helper 启动 | 1.0.0 连接成功，`elevated:false`，`lidSupported:true` |
| 17:16:02 | 引导窗口 | 584×704 DIP（876×1056 物理），三步中文引导完整显示 |
| 17:16 | 点击“跳过” | 引导关闭，`onboardingComplete:true` 写盘，面板自动打开 |
| 17:16 | 面板窗口 | 416×724 DIP（624×1086 物理），内容完整无裁切 |
| 17:32:20 | 点击“退出” | 日志 `controller shutting down`，helper `exited code=0`；所有 InsomniaZ / InsomniaZHelper 进程消失 |
| 17:32:20 | 退出后检查 | `lid-recovery.json` 不存在；WMI 复核 LIDACTION AC=1、DC=1（未留下“合盖不睡眠”） |

17:32:38 再次启动同一产物，为干净状态重拍引导、面板与设置截图（测试期间临时关闭“失焦隐藏”与合盖偏好）；退出方式为强制结束，helper 随父进程消失。引导/面板 PNG 与 16:48 首轮截图 **SHA-256 完全相同**，说明重建前后渲染无差异。

### 4.2 真机提权与合盖写入 / 恢复（偶发，已复原）

自动化期间一次会话启动触发了合盖偏好流程，日志完整记录了提权与恢复（同一最终产物的 17:13 会话，早于 4.1 的 17:16 干净启动）：

| 时间（CST） | 日志 / 证据 | 结果 |
|---|---|---|
| 17:13:33 | `requesting elevated helper` → `starting elevated power helper` | 发起 UAC |
| 17:13:36 | `elevation prompt accepted`，helper `elevated:true` | 提权成功 |
| 17:13:36 | `lid applied; scheme=381b4222-… original=1/1` | 备份原值后写入 Do nothing |
| 17:14:49 | `lid restored; scheme=381b4222-… values=1/1` | 父进程退出，helper 还原原值 |
| 17:32 / 17:35 | WMI `Win32_PowerSettingDataIndex`：AC=1、DC=1；无 `lid-recovery.json` | 全局策略已复原 |

这证明提权、真实策略写入、备份与退出恢复链路在本机可用；**物理合盖后的不休眠行为仍未实测**（见 8.1）。整个过程未留下电源策略或恢复文件残留。

截图证据：

- [packaged-onboarding-final.png](../../docs/captures/packaged-onboarding-final.png) — 最终产物引导页（中文，第 1 步，真实窗口）
- [packaged-panel-final.png](../../docs/captures/packaged-panel-final.png) — 最终产物面板（中文，就绪，15 分钟选中）
- [packaged-settings-final.png](../../docs/captures/packaged-settings-final.png) — 最终产物设置页（通用分区，7 项导航完整）

补充：正常退出与异常父进程退出两条回收路径均验证；异常退出后 helper 自行退出，不留进程。

---

## 5. 构建产物与完整性

| 产物 | 大小（字节） | SHA-256 |
|---|---:|---|
| `release/InsomniaZ-Windows-1.0.0-x64.exe`（NSIS） | 96,569,838 | `3ba5b84e3f34adb3b73ec2fd0e2ef1ac7e5fbaa53f725c3ee1b16cd39666c23c` |
| `release/InsomniaZ-Windows-1.0.0-portable.exe` | 96,337,716 | `0400ec143af7a42ffd2282fdbccc687ea4374a162e19884d59ce4a53c29ab323` |
| `release/win-unpacked/InsomniaZ.exe` | 210,175,488 | `38150a70443d8da30a13d2dc55c540fbf6b7e0aaaf04f28077837d482b6e4672` |
| `release/win-unpacked/resources/helper/InsomniaZHelper.exe` | 26,624 | `dacb61f6d63242125f7f2288a3a17e9eb02be6b3499c61626063e5b2ba4409ab` |
| `release/InsomniaZ-Windows-1.0.0-x64.exe.blockmap` | 102,586 | `911867ccfa214c4627217dc8be99d1f51f3653c237fb279a1d57638a9241a925` |

- `app.asar` 8,801,399 字节、99 个文件，包含 `dist/main/main.cjs`、`dist/renderer/assets/index-BPEbx0bf.js`，与最终源码构建一致。
- `release/win-unpacked` 与临时输出目录 `build-out7` 的可执行文件、helper 与 `app.asar` SHA-256 全部相同。
- exe 版本信息：FileVersion 1.0.0，ProductVersion 1.0.0.0，CompanyName “Independent Windows port”，图标已写入。
- 签名状态：三个 exe 均为 **NotSigned**。这是计划内限制，不冒充已签名。
- 打包路径：镜像下载 electron-builder 依赖 → `--dir` + `signAndEditExecutable:false` → 手工 rcedit → `--prepackaged` 生成 NSIS/便携版。可复现命令见 README。

---

## 6. 需求覆盖矩阵

状态说明：**已验证** = 有自动化或最终产物证据；**部分验证** = 代码与守卫已验证，但受环境限制缺少真机证据；**未达成** = 目标未满足。

| ID | 状态 | 证据 |
|---|---|---|
| FR-01 一键开关 | 已验证 | 冒烟 `panel.toggle-on`；托盘与快捷键共用 `Controller.toggle`；三入口状态一致 |
| FR-02 预设时长 | 已验证 | 冒烟 `panel.duration-presets` 覆盖 15m–8h |
| FR-03 无限时长 | 已验证 | 冒烟 ∞ → `durationMs:null`；`sanitizeSession` 无限会话单测 |
| FR-04 倒计时 | 已验证 | 12 项格式化单测；冒烟 `session.auto-expire` |
| FR-05 到点自动关闭 | 已验证（自动关闭） | 冒烟 before=true → after=false；通知仅代码评审 |
| FR-06 活动中切换时长 | 已验证（路径） | 冒烟在激活态逐项点选并断言时长；`activate()` 活动分支立即重计时 |
| FR-07 记住上次时长 | 已验证 | `lastDurationMs` 持久化单测；最终设置文件值为 900000 |
| FR-08 会话跨重启恢复 | 已验证 | `sanitizeSession` 单测；最终产物日志出现 `restored session after restart`，面板恢复倒计时 |
| FR-09 不静默恢复合盖 | 部分验证 | `sanitizeSession` 强制 `lid:false`；helper `recover` 返回 `RECOVERY_NONE` 集成测试；残留横幅/托盘项代码 |
| FR-10 阻止空闲睡眠 | 已验证 | helper 集成 `setExecution(true/false)`；powerSaveBlocker 双层 |
| FR-11 显示 On | 已验证 | 冒烟 `panel.display-on`；helper 执行状态切 display 标志 |
| FR-12 显示 Auto | 已验证 | 默认 auto；冒烟与截图 |
| FR-13 合盖不休眠 | 部分验证 | 真机已走通 `applyLid`（原值 1/1 → Do nothing）与恢复（1/1），见 4.2；物理合盖未测 |
| FR-14 拔插电源仍有效 | 部分验证 | 代码同时写 AC/DC；`on-ac/on-battery` 重放；未真机拔插 |
| FR-15 睡眠恢复后重保护 | 部分验证 | `resume` 重放执行状态 + 重申请合盖；20s 心跳；未真机睡眠 |
| FR-16 权限说明与降级 | 已验证（成功路径） | 真机 UAC 被接受并连接提权 helper；拒绝/重试分支由代码与文案覆盖，未逐一实测 |
| FR-17 退出/崩溃恢复 | 已验证 | 最终产物 17:32:20 点“退出” → helper exit 0、无恢复文件；强杀后 helper 自退 |
| FR-18 低电量保护 | 部分验证 | 阈值 5–95 钳制单测；控制器阈值逻辑；无真实低电量场景 |
| FR-19 电池时自动停止 | 部分验证 | `stopOnBattery` 逻辑与 UI 存在；无真实拔电测试 |
| FR-20 电源方案变化检测 | 部分验证 | 新增 20s 心跳 `reassertLidIfNeeded`；helper 检测方案 GUID 变化并迁移；未真机切换方案 |
| FR-21 兼容性探测 | 已验证（信息面） | 设置电源页与托盘“运行兼容性检查”；最终产读取到 lidSupported=true、helper 1.0.0 |
| FR-22 高级模式 | 已验证 | helper 集成 `jiggle` 返回 true；间隔钳制单测 |
| FR-23 全局快捷键 | 已验证 | 冒烟 `shortcut.registered`；快捷键单测 10 项 |
| FR-24 恢复默认快捷键 | 已验证（单测） | 规范化/非法输入/回退默认；设置页重置路径 |
| FR-25 高级模式独立配置 | 已实现（静态） | `advancedDefault` 与 `setAdvanced` 解耦于会话开关；未单独 E2E |
| FR-26 纯托盘 | 已验证 | 原生 TOOLWINDOW 样式；所有窗口 `skipTaskbar`；单实例 |
| FR-27 右键菜单全集 | 已验证 | 冒烟 21 项标签 missing=none；中文首启同 |
| FR-28 图标/Tooltip 随状态 | 已验证（路径） | 冒烟 Tooltip；active/idle 资源存在；切换代码审查 |
| FR-29 面板视觉复刻 | 已验证 | 22 张截图，含最终产物引导、面板、设置页 |
| FR-30 失焦隐藏 | 已验证 | 开关为开时失焦自动隐藏、为关时保持可见，两种状态均在最终产物上观察到 |
| FR-31 首次引导 | 已验证 | 冒烟 3 步 + 首启自动打开 + 中文 |
| FR-32 设置窗口 | 已验证 | 7 分区冒烟；9 张设置截图 |
| FR-33 单实例 | 已验证 | 第二次启动退出，顶层进程恒为 1 |
| FR-34 开机启动 | 部分验证 | `setLoginItemSettings` 实现；便携版明确不支持；未在安装版验证开机项 |
| FR-35 通知 | 已实现（静态） | 开启/结束/低电量/权限失败调用点齐全；未做通知视觉断言 |
| FR-36 语言 | 已验证 | 冒烟中英切换；i18n 9 项单测 |
| FR-37 主题 | 已验证 | 深/浅/系统 + 开关实际颜色与滑块位置断言 |
| FR-38 零遥测/默认零网络 | 已验证（审计） | 网络守卫默认拦截、严格 CSP、无分析依赖；运行日志无外联记录；未抓包。v1.1.0 远程 Soft Stop 默认关闭，仅显式启用后放行配置端点 |
| FR-39 本地持久化 | 已验证 | 设置/会话/日志/恢复文件均在 `%APPDATA%\InsomniaZ` |
| FR-40 外链白名单 | 已验证（静态） | 仅 `apps.apple.com` 与 `pawandixit.com` 的 https 链接 |
| FR-41 IPC 最小暴露 | 已验证（审计） | contextIsolation+sandbox+无 nodeIntegration；sender 校验；命令逐字段校验 |
| FR-42 helper 最小权限 | 已验证 | 随机管道+token+父 PID；7 项真实 helper 集成；真机提权写入与恢复见 4.2 |
| FR-43 诊断导出 | 已实现（静态） | 仅版本/系统/状态/日志；未在最终产物触发导出 |

---

## 7. 非功能指标实测

| 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 空闲 CPU | < 0.3% | 0%（10s 采样）/ 0.16%（前一次采样） | 达成 |
| 常驻内存 | < 160 MB | 应用 186.1 MB + helper 26.8 MB = **212.9 MB** | **未达成** |
| 托盘菜单重建 | ≤ 4 次/秒 | 状态签名按 5 秒分桶，最多 0.2 次/秒 | 达成 |
| 冷启动到托盘 | < 2.5 s | 日志显示启动到 helper 连接约 0.25 s；托盘创建更早，但未独立打点 | 未严格测量 |
| 可访问性 | 键盘可达/焦点/aria-live | 代码具备 aria-checked、aria-live、减少动效；未做屏幕阅读器实测 | 部分验证 |
| 兼容性 | Win10 22H2 / Win11 | 本机 Win10 19045 通过；Win11 未测 | 部分验证 |

内存未达标的处理：不通过隐藏进程数或改口径来“达标”。Electron 38 的最小三进程基线（主进程 + GPU + 渲染）已接近该数值；若必须压到 160 MB，需要牺牲功能（例如移除 GPU 进程/改为纯 Win32 重写），超出本次移植范围。

---

## 8. 未验证项与手工验收步骤

### 8.1 明确未验证

1. **物理合盖行为**：提权、真实策略写入与退出恢复已在 17:13–17:14 走通（见 4.2），但未真正合上盖子验证“任务不中断”；也未测试合盖状态下拔插电源。
2. **通知的视觉呈现**：Windows 通知中心是否展示、是否被专注助手拦截，需要人工确认。
3. **Windows 11 / 其他 OEM 电源方案**：未在本机覆盖。
4. **安装版开机启动**：便携版按设计不支持，安装版未做重启验证。
5. **代码签名**：未签名，SmartScreen 会提示未知发布者。
6. **NSIS 安装/卸载流程**：安装包由已验收的 `win-unpacked` 目录生成，但未在全新系统上实测安装向导、卸载与数据保留。

### 8.2 有管理员权限机器上的手工验收步骤

1. 安装 `InsomniaZ-Windows-1.0.0-x64.exe`，启动，完成引导。
2. 打开面板，选择 30 分钟，开启会话；确认电源与合盖状态。
3. 打开“合盖后保持运行”，在 UAC 中选“是”。
4. 以管理员终端执行 `powercfg /q`，找到 `LIDACTION`（`5ca83367-...`），确认当前方案 AC/DC 均为 `0x00000000`。
5. 合上盖子，保持一个下载/计时任务运行 2 分钟；确认任务未中断。
6. 在合盖状态下拔掉电源、再插回；确认仍不休眠。
7. 打开面板点“退出”；再次 `powercfg /q`，确认 LIDACTION 恢复原值；确认 `%APPDATA%\InsomniaZ\lid-recovery.json` 已删除。
8. 重新开启合盖保护，然后用任务管理器“结束任务”强杀 InsomniaZ；确认 helper 在数秒内退出，且 LIDACTION 恢复原值。
9. 再次开启合盖保护，直接重启电脑；登录后确认托盘提示“检测到上次未恢复的合盖设置”，点击恢复并完成 UAC，确认策略还原。
10. 验证通知：开始/结束/低电量/权限失败各触发一次；确认通知内容与语言。
11. 安装版验证开机启动：设置中开启，注销/重启，确认静默启动到托盘且无任务栏按钮。

以上步骤全部通过后，可将 FR-13/14/15/18/19/20/34/35 从“部分验证”升级为“已验证”（FR-16 的成功路径已在本机验证）。

---

## 9. 交付判定

- 功能移植完整度：面板、设置、引导、托盘右键全集、双语、主题、时长、显示模式、低电量、快捷键、高级模式、恢复机制均已落地。
- 工程质量：类型检查通过；58 项单测/集成、37 项真实冒烟、8 项首启冒烟零失败；最终二进制完成端到端点击验收。
- 安全基线：严格 CSP、contextIsolation+sandbox、网络拦截、IPC sender/参数校验、随机管道+token+父 PID 的 helper。
- 已知缺口：物理合盖/拔插电源、通知视觉、Win11、安装版开机启动、安装/卸载流程、代码签名、内存目标。
- **判定：在明确披露上述限制的前提下，验收通过。**

---

## 10. v1.1.0 软叫停验收增量（2026-10-31）

### 10.1 自动化

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | **12 文件 / 149 测试通过** |
| `npx electron . --smoke` | **44/44 通过**（`docs/smoke.json`，2026-10-31 22:29；最终源码含 About 版本号修复） |
| Soft Stop 冒烟子项 | 页面渲染、5 卡片、双阈值、启用/停用、相位芯片、真实 AI 活动探测全部通过 |
| 真实 HTTP socket | 模型发现 → 提示词渲染 → `Authorization: Bearer` → 200；HTTP 500 不泄露提示词；已知模型 dry-run 零连接 |

新增测试文件：`soft-stop.test.ts`、`soft-stop-engine.test.ts`、`soft-stop-sender.test.ts`、`soft-stop-http.test.ts`、`ai-detect.test.ts`、`gui.test.ts`、`knowledge.test.ts`。

### 10.2 真实窗口（原生 WinForms 测试应用）

| 项目 | 证据 |
|---|---|
| 扫描 | 输入框 `PromptInput` 0.95；发送键 `Send message` 0.97；侧边栏 0.75；忙碌对话 “Generating answer” 0.75 |
| 真实发送 | 选择忙碌对话 → 写入完整中文提示词 → 点击发送；落盘 `Generating answer|软叫停测试：…` 与提示词完全一致 |
| 示教录制 | 3 个鼠标事件（click 输入框、hover 输入框、hover 发送键），自动标签 input/send；`leakedPrompt=false` |
| profile | 保存后重扫命中 `profile-uia-test-window`，识别结果保持正确 |
| 测试进程 | 验收后已关闭，无残留测试窗口 |

### 10.3 界面

截图：`docs/captures/settings-softstop-en.png`（总览）、`settings-softstop-target-en.png`（投递目标）、`settings-softstop-teaching-en.png`（示教与验证）。深色/浅色、双语 key 对齐由 i18n 测试覆盖。

### 10.4 未验证项

- **B 点保护性休眠未实际执行**：执行会立即中断当前会话，留待用户在有人值守时用 “Sleep now” 验证。
- 物理合盖状态下的两级触发、不同厂商电源方案、以管理员运行的目标应用、纯 Canvas 聊天界面未覆盖。
- 录制/识别只在原生 WinForms 测试窗口与 MiniMax Code 上实测；其他应用依赖其 UIA 可访问性。
- **1.1.0 未重跑全新用户目录首启冒烟（8 项）**：本机运行中的 v1.0.0 占用 `Ctrl+Alt+I`，fresh 模式会在快捷键子项误报；1.1.0 的 44 项冒烟使用专用 `Ctrl+Alt+Shift+F9`。首启路径沿用 v1.0.0 的 8/8 记录，引导页截图已由 1.1.0 重新生成。
- **1.1.0 安装包未在运行中的 v1.0.0 旁启动**：同时运行会争抢快捷键、托盘与 helper 管道。已核对成品 `app.asar` 的版本号、软叫停代码与安装包元数据（1.1.0、未签名），安装包由该 `win-unpacked` 目录生成。

### 10.5 判定

在披露上述限制的前提下，v1.1.0 软叫停功能验收通过；默认安全姿态为 dry-run + 白名单 + 首次确认，远程端点默认关闭。

### 10.6 打包产物（2026-10-31）

| 产物 | 大小 | SHA-256 |
|---|---:|---|
| `release/InsomniaZ-Windows-1.1.0-x64.exe` | 96,617,266 字节 | `b155e9177b8bf7d224891fdfcd839cf8e5ec1d0b7c896ccd7ed5f4500e3ff75b` |
| `release/InsomniaZ-Windows-1.1.0-portable.exe` | 96,385,143 字节 | `cd6289bfdf2b0ef1aaf24b74030204dca27f08d878795ebb3539da9ddd8e34ec` |
| `release/InsomniaZ-Windows-1.1.0-screenshots.zip` | 2,927,469 字节 | —（20 张 PNG） |

- 主程序版本资源：FileVersion `1.1.0`、ProductVersion `1.1.0.0`、ProductName `InsomniaZ`、CompanyName `Independent Windows port`。
- Helper：59,392 字节，版本 `1.1.0.0`；`app.asar` 内 `package.json` 版本 `1.1.0`，渲染层不含 `1.0.0` 残留。
- 两个安装包均为 `NotSigned`；`release/SHA256SUMS.txt` 已在 `release/` 内用 `sha256sum -c` 校验通过。
- 生成流程：`npm run build` → `electron-builder --win --dir`（`signAndEditExecutable=false`）→ 本地 rcedit 写入图标与版本 → `--prepackaged` 生成 NSIS/portable。
- 安装包未与运行中的 v1.0.0 并行启动，原因见 10.4；`release/` 中已有的 1.0.0 二进制保持原样未覆盖。

# InsomniaZ for Windows — 架构设计

> **已归档 / Archived** — 历史设计记录，不代表当前行为。现行文档见 [`docs/`](../../docs) 与 [README](../../README.zh-CN.md)。
> Historical design record, not current behaviour. See [`docs/`](../../docs) and the [README](../../README.md).

> 状态：Approved for implementation  
> 对应需求：`01-requirements.md`  
> 平台：Windows 10 22H2 / Windows 11，x64  
> 技术栈：Electron 38 + React 19 + TypeScript + Vite；C# (.NET Framework 4.8) 提权助手

---

## 1. 设计目标

1. **功能等价**：睡眠阻止、合盖保持、显示模式、定时/无限、全局快捷键、高级空闲规避、电源切换重放、异常恢复。
2. **系统安全**：任何路径都不遗留“合盖不睡眠”的全局电源设置。
3. **交互等价**：macOS 菜单栏 popover 的视觉与信息密度在 Windows 托盘面板中复刻；右键菜单功能全集。
4. **默认零网络**：不请求任何远程资源，不上报数据；仅用户显式启用的 Soft Stop 远程端点例外。
5. **可验证**：核心状态机可单测，电源 helper 可独立探测，UI 可自动截图验收。

---

## 2. 进程与模块

```
┌────────────────────────────────────────────────────────────┐
│ Renderer (React 19, sandboxed, contextIsolation)           │
│  Panel / Settings / Onboarding / About                     │
│  - 纯展示与表单，不直接访问 Node/系统                          │
└──────────────────────────▲─────────────────────────────────┘
                           │ typed IPC (contextBridge)
┌──────────────────────────┴─────────────────────────────────┐
│ Preload (sandbox: true)                                     │
│  window.insomniaz: getBootstrap / invoke / subscribe        │
└──────────────────────────▲─────────────────────────────────┘
                           │ ipcMain.handle + validated payload
┌──────────────────────────┴─────────────────────────────────┐
│ Main (Electron, Node)                                       │
│  ├─ AppController      单实例、窗口生命周期、退出编排           │
│  ├─ SessionEngine      状态机、计时、恢复                      │
│  ├─ SettingsStore      JSON 原子写、迁移、默认值               │
│  ├─ PowerController    Electron powerSaveBlocker + helper 编排│
│  ├─ HelperClient       命名管道 JSON-RPC、重连、提权           │
│  ├─ TrayController     原生右键菜单、图标/提示                 │
│  ├─ WindowController   面板定位、失焦隐藏、设置/引导            │
│  ├─ ShortcutController globalShortcut 注册/冲突检测            │
│  ├─ Logger             本地滚动日志、诊断导出                  │
│  └─ NetGuard           阻止所有非本地网络                     │
└──────────────────────────▲─────────────────────────────────┘
                           │ named pipe (random, same-user, token)
┌──────────────────────────┴─────────────────────────────────┐
│ InsomniaZHelper.exe (C# / .NET Framework 4.8)               │
│  ├─ 电源策略读写（PowerRead/WriteAC/DCValueIndex）             │
│  ├─ 执行状态保持（SetThreadExecutionState）                   │
│  ├─ 输入模拟（SendInput F15）                                │
│  ├─ 电池/AC 状态（GetSystemPowerStatus）                     │
│  ├─ 原值备份/恢复/残留恢复文件                                 │
│  └─ 父进程死亡 → 自动恢复 → 退出                              │
└────────────────────────────────────────────────────────────┘
```

### 2.1 为什么需要独立 helper

- Electron/Node 没有修改 Windows 电源方案的原生 API；
- 修改 `LIDACTION` 需要管理员权限，不能让主程序整体提权；
- helper 只在用户显式开启“合盖保护”时通过 UAC 启动，之后常驻，一次授权覆盖本次运行；
- 独立进程可以在主程序崩溃时监测父进程退出并恢复电源设置。

### 2.2 为什么主程序不整体提权

- 整体提权会导致拖放、外部链接、通知等行为受完整性级别限制；
- 每次启动弹 UAC 不可接受；
- 最小权限原则：只有电源写入跨进程。

---

## 3. 会话状态机

```
                  activate(duration, displayMode)
        ┌──────────────────────────────────────────┐
        │                                          ▼
     ┌──────┐                                 ┌────────┐
     │ IDLE │                                 │ ACTIVE │
     └──────┘                                 └────────┘
        ▲    ▲                                  │  │  │
        │    │ deactivate / expiry /            │  │  │ setDuration → 重新计时
        │    │ low battery / stop-on-battery     │  │  └──────────────┐
        │    └───────────────────────────────────┘  │                 │
        │                                           │ setDisplayMode  │
        │                                           └→ 更新 blocker   │
        └───────────────────────────────────────────┘
```

### 3.1 正交特性

| 特性 | 作用域 | 激活时应用 | 关闭时撤销 | 备注 |
|---|---|---|---|---|
| display mode | 会话 | powerSaveBlocker 类型 | 停止 blocker | On=prevent-display-sleep；Auto=prevent-app-suspension |
| advanced idle | 会话 | 启动 F15 心跳 | 停止心跳 | 依赖 helper；失败不阻塞会话 |
| lid guard | 会话 + 偏好 | helper `applyLid` | helper `restoreLid` | 申请 UAC；失败降级并提示 |
| battery guard | 全局 | 1s 心跳检查 | — | 默认 20% |
| stop on battery | 全局 | 电源事件 | — | 默认关闭 |

### 3.2 计时模型

- 激活时计算 `endsAt = now + durationMs`（无限为 `null`）；
- 主进程 250ms tick，向渲染进程推送剩余时间（节流到 1s 变化）；
- 到点：先停 blocker / 恢复 lid / 停 advanced，再置 IDLE，最后发通知；
- 系统休眠导致定时器漂移：以 `Date.now()` 与 `endsAt` 对比，不依赖 tick 次数；
- 恢复：若 `endsAt` 已过期则直接清理；未过期且 `restoreSession=true` 则恢复保护（lid 需要已提权 helper，否则标记需处理）。

---

## 4. 电源管理

### 4.1 第一层：Electron powerSaveBlocker

| 显示模式 | blocker 类型 | 效果 |
|---|---|---|
| Display On | `prevent-display-sleep` | 系统与显示器都不睡 |
| Display Auto | `prevent-app-suspension` | 系统不睡，显示器可睡 |

启动时记录 blocker id；切换模式先 stop 再 start；退出/停用时 stop。Electron 内部调用 `SetThreadExecutionState`，属于第一层保护。

### 4.2 第二层：helper 执行状态

helper 在专用线程调用：

```
ES_CONTINUOUS | ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED]
```

该线程保持存活，状态持续；模式切换时更新 flags。它作为 powerSaveBlocker 的冗余层，覆盖 Electron 主进程短时阻塞/异常。

### 4.3 第三层：合盖动作

Power API（powrprof.dll）：

| API | 用途 |
|---|---|
| `PowerGetActiveScheme` | 取得当前方案 GUID |
| `PowerReadACValueIndex` / `PowerReadDCValueIndex` | 读取 `LIDACTION` 原值 |
| `PowerWriteACValueIndex` / `PowerWriteDCValueIndex` | 写入 0（Do nothing）或恢复原值 |
| `PowerSetActiveScheme` | 使修改生效 |

- 子组：`4f971e89-eebd-4455-a8de-9e59040e7347`（SUB_BUTTONS）
- 设置：`5ca83367-6e45-459f-a27b-476b1d01c936`（LIDACTION）
- 值：0=Do nothing，1=Sleep，2=Hibernate，3=Shut down
- **AC 与 DC 同时写入 0**，因此合盖状态下拔插电源不会改变行为。
- **先落盘恢复文件，再改策略**：原值（方案 GUID、AC/DC）在写入前原子写入 `lid-recovery.json`。即使 helper 在写入与备份之间崩溃，下次启动也能检测并恢复；写入失败时尝试回滚原值，回滚不成功则保留恢复文件供用户显式恢复。
- 写入后回读校验；失败返回 Win32 错误码与原因。
- 兼容性：优先 Power API；若失败再尝试 `powercfg /setacvalueindex` 回退；仍失败则报告 `LID_WRITE_UNSUPPORTED`，不静默假装成功。

### 4.4 恢复矩阵（必须全部覆盖）

| 场景 | 恢复者 | 动作 |
|---|---|---|
| 用户关闭会话 | Main | `restoreLid` → `powerSaveBlocker.stop` |
| 用户退出应用 | Main → helper | `restoreLid` → `shutdown` |
| 主进程崩溃 | Helper | 检测父 PID 消失 → restore → exit |
| Helper 崩溃 | Main | 重新拉起；若无法恢复，提示并写日志 |
| 系统关机/重启 | Main `powerMonitor shutdown` / helper SessionEnding | restore |
| 助手异常留下的 recovery 文件 | Main 启动检查 | 面板横幅 + “立即恢复”按钮（提权） |
| 显示模式切换 | Main | 只改 blocker，不影响 lid |
| 电源方案被外部切换 | Main 20s 心跳 | `helper.applyLid` 重新断言；helper 发现方案 GUID 变化时先恢复旧方案、再把 Do nothing 迁移到新方案 |

### 4.5 提权流程

```
用户开启 “Keep awake with lid closed”
  → Main 请求 helper.applyLid
  → helper 返回 ELEVATION_REQUIRED（未提权）
  → 原生对话框说明 Windows 权限要求
  → 用户确认
  → PowerShell Start-Process -Verb RunAs helper --pipe <random> --parent-pid <pid> --token <random>
  → UAC 安全桌面
  → 新 helper 连接同一命名管道
  → applyLid 成功，更新 capabilities
失败/取消 → 回滚 toggle，显示可操作错误，“仅空闲防睡眠仍生效”
```

- UAC 每次应用运行最多一次；helper 常驻复用。
- helper 管道名 128-bit 随机；消息带 token；仅接受本机、同用户连接。
- helper 不暴露任意命令执行，只支持固定命令集。

---

## 5. IPC 契约

所有请求由 preload 封装，渲染层不接触 `ipcRenderer`。主进程校验 sender 与参数。

| 通道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `app:bootstrap` | R→M | — | `Bootstrap {settings, session, status, locale, version}` |
| `app:state` | M→R | 事件 | `RuntimeState` |
| `session:toggle` | R→M | — | `RuntimeState` |
| `session:activate` | R→M | `{durationMs:number\|null}` | `RuntimeState` |
| `session:deactivate` | R→M | — | `RuntimeState` |
| `session:set-display` | R→M | `{mode:'on'\|'auto'}` | `RuntimeState` |
| `session:set-advanced` | R→M | `{enabled:boolean, persist:boolean}` | `RuntimeState` |
| `session:set-lid` | R→M | `{enabled:boolean}` | `RuntimeState` + `capabilities` |
| `settings:update` | R→M | `Partial<Settings>` | `RuntimeState` |
| `settings:reset` | R→M | — | `RuntimeState` |
| `system:check` | R→M | — | `Capabilities` |
| `window:open-settings` | R→M | `{section?:string}` | void |
| `window:close` | R→M | `{window:'panel'\|'settings'\|'onboarding'}` | void |
| `window:hide-panel` | R→M | — | void |
| `window:minimize` | R→M | — | void |
| `app:quit` | R→M | — | void |
| `shell:open` | R→M | `{url:string}` | void（白名单校验） |
| `diagnostics:export` | R→M | — | `{path:string}` |
| `debug:fixture` | M→R | 事件 | 仅 `--capture` / `--test-mode` |

参数校验：

- durationMs ∈ 允许集合或 `null`；mode ∈ ['on','auto']；settings 字段白名单与范围；
- URL 必须 `https:`/`mailto:`，长度 ≤ 2048；
- 所有 handler 捕获异常并返回结构化错误，不把堆栈暴露到渲染层。

---

## 6. 数据与持久化

目录：`app.getPath('userData')`，例如 `%APPDATA%/InsomniaZ/`。

```
settings.json      用户设置（schemaVersion, 原子写, 迁移）
session.json       会话恢复数据（active, startedAt, endsAt, durationMs, displayMode, advanced, lid）
lid-recovery.json  helper 写入的合盖策略备份（scheme, ac, dc, appliedAt, pid）
logs/main.log      滚动日志（≤ 2 MB × 3）
diagnostics.json   用户主动导出的诊断快照
```

设置默认值（节选）：

| 键 | 默认 | 范围 |
|---|---|---|
| language | `system` | system / zh-CN / en-US |
| theme | `dark` | dark / light / system |
| shortcut | `Ctrl+Alt+I` | 合法组合 |
| defaultDisplayMode | `auto` | on / auto |
| lastDurationMs | 900000（15m） | 预设或 null |
| lidGuardPreferred | false | boolean |
| advancedDefault | false | boolean |
| batteryGuardEnabled | true | boolean |
| batteryThreshold | 20 | 5–50 |
| stopOnBattery | false | boolean |
| activityIntervalSec | 60 | 30–300 |
| launchAtLogin | false | boolean |
| restoreSession | true | boolean |
| closePanelOnBlur | true | boolean |
| leftClickOpensPanel | true | boolean |
| showNotifications | true | boolean |
| animations | true | boolean |

原子写：临时文件 → `fs.renameSync`；损坏 JSON 回退默认值并备份 `.corrupt-<timestamp>`。

---

## 7. 托盘与窗口策略

### 7.1 托盘右键菜单（一级入口）

```
InsomniaZ — ACTIVE · 8m 38s remaining   [disabled]
────────────────────────────────────────
Turn Off InsomniaZ                     Ctrl+Alt+I
Duration          ▸  15m / 30m / 1h / 2h / 4h / 8h / ∞
Display           ▸  On / Auto
Keep awake with lid closed             ✓
Prevent apps from seeing you idle      ✓
────────────────────────────────────────
Open Control Panel
Settings…
About InsomniaZ
────────────────────────────────────────
Quit InsomniaZ
```

菜单在状态变化后重建；最多 250ms 一次；所有标签本地化。

### 7.2 左键

默认打开控制面板；设置中可关闭。右键始终打开原生菜单。Windows 不支持有意义的“长按托盘图标”，因此 long-press 的操作语义并入右键菜单；面板上的状态环支持 550ms 长按打开设置（补充手势，不替代菜单）。

### 7.3 窗口

| 窗口 | 尺寸 | 任务栏 | 行为 |
|---|---|---|---|
| Panel | 392×748 | 隐藏 | 无边框、透明、置顶、失焦隐藏、Esc 关闭、可拖动 |
| Settings | 860×660 | 隐藏 | 无边框自定义标题栏、居中、单实例 |
| Onboarding | 560×680 | 隐藏 | 首次启动、三步、可跳过 |

- 多显示器：使用托盘所在显示器的工作区定位，边界内 clamp；托盘坐标不可用时右下角。
- 动画：120–220ms；`prefers-reduced-motion` 时禁用位移与脉冲。
- 所有窗口 `show:false` 直到 ready-to-show，避免白屏。

---

## 8. 安全与隐私

1. `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`webSecurity:true`。
2. 生产环境 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`。
3. 禁用 `webview`、`webContents.setWindowOpenHandler` 一律 deny；`will-navigate` 仅允许应用自身 URL。
4. 生产环境拦截所有 `http/https/ws` 请求；开发环境白名单仅 `127.0.0.1:5173`。
5. 无遥测 SDK、无远程字体、无自动更新。
6. 外部链接仅 `https`/`mailto`，用户显式点击；关于页声明非官方移植。
7. helper 固定命令集 + 随机管道 + token + 父 PID；退出即恢复。
8. 日志脱敏；诊断导出需用户显式操作。

---

## 9. 错误处理与降级

| 错误 | 用户可见 | 降级 |
|---|---|---|
| UAC 取消 | “未授予管理员权限，合盖保护未开启” | 空闲防睡眠继续有效 |
| LIDACTION 不可读写 | “此设备/电源方案不支持合盖策略” | 禁用选项并说明 |
| helper 未连接 | 状态栏黄点 + 面板提示 | 重试；仅 blocker |
| 高级模式失败 | 高级行提示 | 不影响会话 |
| 低电量 | 通知并自动关闭 | — |
| recovery 残留 | 顶部横幅“检测到上次未恢复的合盖设置” | 一键恢复 |
| 设置损坏 | 通知并重置默认 | 备份 corrupt 文件 |

---

## 10. 构建与发布

```
npm run dev       Vite + Electron 热更新（helper 先编译）
npm run build     typecheck + main(preload) + renderer + helper
npm test          Vitest
npm run capture   Electron 离屏截图（验收证据）
npm run dist      electron-builder：NSIS + portable（x64）
```

- electron-builder 使用本地 `node_modules/electron/dist`，避免二次下载。
- helper 通过 `extraResources` 放在 `resources/helper/`，主进程按打包/开发路径解析。
- 不签名；README 说明 SmartScreen 提示与 SHA-256 校验。

---

## 11. 关键设计决策（ADR）

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| ADR-01 | 用 Electron 而非 Tauri/WinUI | 现有工具链成熟、UI 复刻自由度高、开发环境已有 Electron | 包体较大（~200 MB 级） |
| ADR-02 | 电源写入放独立 C# helper | 最小权限 + 可独立恢复 + 不整体提权 | 多一个进程与 IPC |
| ADR-03 | 托盘右键菜单承载全部功能 | 用户明确要求；Windows 原生可达性最好 | 面板不是唯一入口，需要双向同步 |
| ADR-04 | 保留左键打开面板 | Windows 用户预期；可由设置关闭 | 与“全部放右键”略有重叠 |
| ADR-05 | 合盖写入 AC+DC 同时为 0 | 覆盖拔插电源场景 | 影响所有电源模式，需严格恢复 |
| ADR-06 | 不安装驱动/服务 | 安全、可卸载、无内核风险 | 依赖系统电源策略；部分厂商机型可能不支持 |
| ADR-07 | 自动截图代替 Playwright | 减少依赖与下载；直接验证真实 Electron 渲染 | 交互流程测试需额外 smoke harness |
| ADR-08 | 中英双语而非 33 语言 | 保证质量；字典结构可扩展 | 与官方语言数量不等价，文档注明 |

---

## 12. 验收策略

1. **静态**：`tsc --noEmit` 零错误；无 `any` 滥用；关键模块注释。
2. **单元**：状态机、计时、设置迁移、i18n key 对齐、快捷键校验、电源结果映射。
3. **集成**：helper 管道 ping/status/jiggle/apply 权限错误/restore 幂等；父进程退出恢复（模拟）。
4. **UI**：自动截图 panel active/idle、settings、onboarding；逐项视觉核对官方截图；键盘导航与焦点抽查。
5. **端到端 smoke**：启动 → 开启 → 计时（测试时长）→ 到时关闭 → 退出 → 设置文件与恢复文件正确。
6. **电源真实写入**：本机无管理员权限且为 Modern Standby，无法自动验证；提供 `compatibility` 界面与手工验收步骤，在报告中如实标注未验证项。
7. **评审**：代码走查、安全清单、失败矩阵、打包产物校验（哈希、启动、托盘、无任务栏）。

---

## 13. 软叫停子系统（v1.1.0 增量）

```
BatteryMonitor (controller tick, 5s)
   │  power: ac / percent
   ▼
SoftStopEngine ── planSoftStopTick() ── shared/soft-stop.ts（纯函数状态机）
   │        │
   │        ├── AiActivityDetector (ai-detect.ts)
   │        │      tasklist + netstat + Get-NetAdapter + loopback probes
   │        │      → 进程/端口/吞吐量；不读内容
   │        │
   │        ├── SoftStopSender (soft-stop-sender.ts)
   │        │      HTTP / Webhook / CLI；远程闸门、dry-run、DPAPI key
   │        │
   │        └── GuiAgent (gui-agent.ts)
   │               helper uia.scan / uia.act / uia.record.*
   │               shared/gui.ts 负责分类、评分、profile 匹配
   ▼
Protective sleep: controller.deactivate('soft-stop') → helper.suspend()
```

- **纯函数边界**：阈值决策、周期重置、模板渲染、GUI 分类都在 `shared/`，可用 Vitest 覆盖； Electron 层只做 I/O。
- **周期持久化**：`soft-stop-cycle.json` 绑定 `session.startedAt`，会话重启不会误触发；审计 `soft-stop-audit.json` 最多保留 50 条。
- **发送密钥**：`soft-stop/secret.bin` 使用 `safeStorage`（DPAPI）加密；未存储时返回空。
- **GUI profile**：`soft-stop/gui-profiles.json` 保存进程、标题匹配与控件指纹；不保存坐标、时长或键盘输入。
- **helper 协议**：新增 `uia.scan`、`uia.act`、`uia.record.start/stop/status`、`suspend`；沿用随机命名管道 + token + 父进程监视。
- **DPI / STA**：UIA 调用在 STA 线程，进程声明 Per-Monitor DPI awareness，避免物理坐标与逻辑坐标错位。
- **故障隔离**：检测/发送失败写入审计并进入 error 相位，不阻塞 1 秒主 tick；下次 tick 按冷却策略重试。

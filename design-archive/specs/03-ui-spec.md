# InsomniaZ for Windows — UI 设计规范

> **已归档 / Archived** — 历史设计记录，不代表当前行为。现行文档见 [`docs/`](../../docs) 与 [README](../../README.zh-CN.md)。
> Historical design record, not current behaviour. See [`docs/`](../../docs) and the [README](../../README.md).

> 视觉基线：App Store 官方 InsomniaZ 5.3 主面板截图（研究用，未随仓库分发）  
> 原则：**复刻信息层级与气质，不复用受版权保护的图标/字体/素材**

---

## 1. 设计语言

官方面板的气质是「深色、克制、带一点夜间科技感的紫」。它不是大面积高饱和紫，而是：

- 近黑紫底色 + 局部紫色光晕；
- 同心圆是唯一的大型视觉元素；
- 金色只用于“剩余时间/进度”，形成冷暖对比；
- 段落标签是小号、大字距、全大写；
- 选中项用低饱和紫色填充，不用刺眼亮紫。

Windows 版完整继承这套语言，并将 Windows 的 1px 边框、焦点框、右键菜单做成同一家族。

---

## 2. 色彩 Token（从截图取样）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-panel` | `#191924` | 面板主背景 |
| `--bg-panel-elevated` | `#20202B` | 分段控件、列表行 |
| `--bg-panel-raised` | `#22222D` | 控件底、卡片 |
| `--bg-pill` | `#2E254A` | 选中时长胶囊 |
| `--bg-pill-hover` | `#3A2E5C` | 悬停 |
| `--bg-on` | `#362A57` | ON 徽标底 |
| `--border-subtle` | `rgba(255,255,255,0.07)` | 分隔线/描边 |
| `--border-strong` | `rgba(255,255,255,0.12)` | 选中描边 |
| `--text-primary` | `#FFFFFF` | 标题、数值 |
| `--text-secondary` | `#A6A3B2` | 说明文字 |
| `--text-tertiary` | `#6F6B7C` | 段落标签、占位 |
| `--accent` | `#8E63EC` | 主紫 |
| `--accent-soft` | `#A381EA` | 次级紫 |
| `--accent-bright` | `#B79CFF` | 高亮文字/焦点 |
| `--gold` | `#F6B62E` | 剩余时间、进度弧 |
| `--gold-soft` | `rgba(246,182,46,0.20)` | 光晕 |
| `--success` | `#5BD6A2` | 已连接/成功 |
| `--warning` | `#F3B24A` | 权限/兼容性警告 |
| `--danger` | `#FF6B7A` | 错误、退出确认 |
| `--focus` | `#C9B4FF` | 键盘焦点环（2px） |

浅色主题（仅设置/引导可选；主面板保持品牌深色）：

| Token | 值 |
|---|---|
| `--bg-panel` | `#F7F5FB` |
| `--bg-panel-raised` | `#FFFFFF` |
| `--text-primary` | `#1C1A24` |
| `--text-secondary` | `#625E70` |
| `--border-subtle` | `rgba(28,26,36,0.10)` |
| `--accent` | `#7C4DE8` |

### 圆环渐变

```
外圈轨道   rgba(255,255,255,0.08)
进度弧     #F6B62E → #FFD37A（圆头，4px）
外圆       rgba(163,129,234,0.10)
中圆       radial-gradient(#A381EA, #8E63EC)
内圆       radial-gradient(#C7B2F5, #A381EA)
中心       radial-gradient(#D9C9FF, #B79CFF)
光晕       rgba(142,99,236,0.35) blur 40px
```

---

## 3. 字体与排版

- 字体栈：`"Segoe UI Variable Display", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif`
- 品牌标题：22px / 700 / -0.02em
- 状态标签（ACTIVE/READY）：10px / 700 / 0.18em / 大写
- 段落标签（DISPLAY/DURATION/ADVANCED）：10px / 700 / 0.16em / 大写 / `--text-tertiary`
- 数值/倒计时：13px，金色时间数字，500；`remaining` 使用次级色
- 分段主文案：12px/600；副文案：10px/400
- 胶囊：12px/600
- 设置正文：13px/400；标题：14px/600；说明：12px/400。
- 最小可读字号 10px，仅用于全大写标签与副说明；正文不低于 12px。

---

## 4. 主面板布局（392 × 700）

```
┌─────────────────────────────────────────────┐  padding 20
│ InsomniaZ                          [● ON]   │  品牌 / 状态胶囊
│ ACTIVE                                      │
│                                             │
│              ╭─────────────╮                │
│           ╭──┤  concentric ├──╮             │  圆环 200×200
│           │  │    rings    │  │             │  金色进度弧
│           ╰──┤             ├──╯             │
│              ╰─────────────╯                │
│           ⏱ 8m 38s remaining                │
│                                             │
│ DISPLAY  [NEW]                              │
│ ┌─────────────────┬─────────────────────┐   │
│ │ ☀ On            │ ☾ Auto       (选中) │   │  分段 56px
│ │ Screen stays on │ Screen can sleep    │   │
│ └─────────────────┴─────────────────────┘   │
│                                             │
│ DURATION                                    │
│ [15m] [30m] [1h] [2h] [4h] [8h] [∞]          │  胶囊 32px
│                                             │
│ ADVANCED                                    │
│ ┌─────────────────────────────────────────┐ │
│ │ 合盖保持唤醒            管理员   [Toggle] │ │
│ │ 屏幕可睡眠，系统继续运行                   │ │
│ ├─────────────────────────────────────────┤ │
│ │ 防止应用判定空闲                 [Toggle] │ │
│ │ 每 60 秒模拟一次键盘活动                   │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ ⚙ Settings        Ctrl Alt I     ⏻ Quit      │  页脚
└─────────────────────────────────────────────┘
```

- 面板内容区 392 × 700，四周额外留 12px 透明阴影边距（实际窗口 416 × 724）。窗口高度会按当前显示器工作区动态收紧（`workAreaSize.height - 32`，下限 620），避免 Windows 静默裁掉透明窗口的阴影边距。
- 面板顶部无标题栏；整块区域可拖动，交互控件除外。
- 关闭按钮不做红绿灯；Esc 隐藏面板。
- 状态环是按钮：单击切换开关；长按 550ms 打开设置；聚焦时 Enter/Space 切换。
- 倒计时结束后环弧归零，状态变 READY，ON→OFF，环光晕减弱。
- 未激活时圆环仍显示，只是低饱和（`opacity: 0.55`），无脉冲。
- 权限未授予时，合盖行右侧显示 `Admin` 警告徽标；点击行展开原因与重试按钮。
- 低电量时顶部出现 32px 琥珀色横幅（不遮挡品牌）。
- 面板相对托盘图标定位；若图标在溢出区，则停在任务栏右上方 12px，距边缘 12px。
- 阴影：`0 24px 64px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)`；1px `rgba(255,255,255,0.08)` 内描边。

### 4.1 动效

| 元素 | 动画 | 时长 |
|---|---|---|
| 面板出现 | opacity 0→1 + translateY(8px)→0 + scale .98→1 | 180ms cubic-bezier(.2,.8,.2,1) |
| 状态环激活 | 光晕 opacity .25→.55 + 1.2s 呼吸（仅激活时） | 1.2s loop |
| 进度弧 | stroke-dashoffset 线性变化 | 每 tick |
| 胶囊切换 | 背景 120ms | 120ms |
| 状态点 | 颜色过渡 | 160ms |
| 低电量横幅 | height 0→32 | 160ms |

`prefers-reduced-motion` 或设置关闭动画：全部时长 0，禁用呼吸与位移。

---

## 5. 设置窗口（860 × 660）

### 5.1 结构

- 自定义标题栏 52px：左侧品牌小圆环 + “InsomniaZ”，中间空白可拖动，右侧最小化/关闭。
- 左侧导航 216px：General / Shortcuts / Power / Battery / Soft Stop / Appearance / Privacy / About。
- 右侧内容 644px，最大宽度 560px，左对齐；底部留白 24px。
- 窗口背景 `--bg-panel`，导航背景略深（`#15151E`），内容卡片 `--bg-panel-raised`，圆角 14px，1px 描边。
- 无“保存”按钮；所有变更即时生效，右上角出现 1.2s “Saved” 微提示（aria-live polite）。

### 5.2 General

| 控件 | 说明 |
|---|---|
| Launch at login | 开机静默启动到托盘；开发模式禁用并说明 |
| Start active on launch | 启动即按上次时长开启 |
| Restore session | 崩溃/重启后恢复未到期会话 |
| Language | 跟随系统 / 简体中文 / English |
| Theme | 深色 / 浅色 / 跟随系统 |
| Left-click opens panel | 关闭后左键无动作，仅右键菜单 |
| Close panel when clicking outside | 默认开 |
| Animations | 默认开 |

### 5.3 Shortcuts

- 快捷键录制器：点击后进入录制态，按下组合键；Esc 取消；Backspace 清除。
- 校验：至少一个修饰键 + 非修饰键；拒绝系统保留组合；检测 `globalShortcut.isRegistered` 冲突；保存失败给出内联错误。
- 显示当前组合的系统格式化文本；提供 “Reset to Ctrl+Alt+I”。

### 5.4 Power

- Compatibility 卡片：
  - Idle prevention: Ready
  - Lid policy: Available / Hidden / Unsupported
  - Administrator: Granted / Required
  - Helper: Connected / Not connected
  - “Run check” 按钮；状态点（绿/琥珀/红）。
- Keep awake with lid closed：开关；未提权时点击触发 UAC 说明对话框。
- Activity simulation：开关 + 间隔下拉（30/60/120/300s）；说明“可能唤醒显示器”。
- Display mode default：On / Auto。
- “Test for 10 seconds” 按钮：开启短会话，用于验证（测试模式/高级选项）。
- 若检测到 recovery 残留：红色横幅 + “Restore now”。

### 5.5 Battery

- Battery guard 开关；阈值滑块 5–50%，默认 20%；显示当前电量（来自 helper）。
- Stop when unplugged 开关；说明“适合移动办公，合盖保护将随拔电结束”。
- 当前电源状态行：AC / Battery 82% / Charging。
- 软叫停开启时，本页低电量 guard 自动让位，并显示说明。

### 5.6 Soft Stop

五张卡片，右上角为相位芯片（Off / Idle / Monitoring / Detected / Sending / Sent / Cooldown / Sleeping / Error）：

| 卡片 | 内容 |
|---|---|
| Battery handoff | 总开关、固定提示词（2000 字符上限、变量提示）、A/B 双滑块（A 10–95%，B 5–A−5，5% 步进）；提示词与阈值即时保存 |
| Delivery target | Send through 下拉（自动/适配器/generic-gui）、端点、模型、API Key（DPAPI，显示已存/未存）、Allow remote endpoints、Dry run（默认开）、Send without confirmation |
| GUI fallback | GUI 兜底开关、允许的进程白名单、扫描窗口（可选截取目标窗口）、候选标签预览与保存为 profile |
| Teaching mode | 开始/停止录制（最长 5 分钟）、事件列表（点击/悬停、控件名、进程、建议标签下拉）、填写名称与标题匹配后保存 profile；已保存 profile 列表可删除 |
| Verification | 发送测试提示词、检查 AI 活动（流式等级/本地运行时/吞吐量）、最近 50 条审计与刷新、Sleep now（两步确认） |

- 录制时显示脉冲状态条与剩余时间；未开始录制时不轮询助手，避免无谓的提权。
- 所有危险操作（休眠、删除 profile）都需要二次确认。

### 5.7 Appearance

- Theme 三选一；Accent 固定品牌紫（不开放色盘，保持识别度）。
- Density：Comfortable / Compact（影响设置列表行高）。
- 动画开关；语言快捷入口。

### 5.8 Privacy

- 明确声明：零收集、零遥测、无账号、无分析；网络默认只留在本机，软叫停远程端点需显式开启。
- “Open data folder” / “Export diagnostics” 按钮。
- 说明日志内容与保留策略；软叫停审计不记录提示词正文与 API Key。
- 关于权限：为什么会请求管理员、何时请求、如何撤销。

### 5.9 About

- 品牌圆环 + InsomniaZ 版本 1.1.0 (Windows port)。
- “Inspired by InsomniaZ for macOS by Pawan Dixit. This is an independent, unaffiliated port.”
- 链接：原应用 App Store 页、开发者网站、许可（MIT）。
- 系统信息：Electron / Chromium / Node 版本。
- 检查更新：不提供（离线原则），显示 “Updates are manual.”。

---

## 6. 首次启动引导（560 × 680，三步）

1. **Welcome**：大圆环 + “Never sleep. Even with the lid closed.” + 三个要点（合盖保持 / 屏幕模式 / 隐私离线）。
2. **Choose your defaults**：Display On/Auto 卡片二选一；默认时长胶囊；高级模式开关（说明）。
3. **Lid permission**：解释 Windows 需要管理员权限修改合盖策略；两个按钮 “Enable lid protection” / “Not now”；下方说明拒绝后仍能防止空闲睡眠；显示快捷键 `Ctrl+Alt+I`。
4. 完成：进入主面板，首次会话不自动开启（避免惊讶），但保留用户选择。

- 步骤指示点 3 个；Back / Continue；右上角 Skip。
- 引导可随时在设置 → General 重新打开。

---

## 7. 托盘交互规范

| 交互 | 行为 |
|---|---|
| 右键托盘图标 | 打开完整原生菜单（所有功能） |
| 左键托盘图标 | 打开/收起控制面板（可关闭） |
| 双击（可选） | 不绑定，避免误触 |
| 悬停 | Tooltip：`InsomniaZ — Active · 8m 38s remaining` / `InsomniaZ — Ready` |
| 托盘图标 | 激活：紫色同心圆 + 金色点；空闲：灰紫同心圆 |
| 面板失焦 | 默认 180ms 后隐藏；打开原生菜单/UAC/设置时不隐藏 |
| 快捷键 | `Ctrl+Alt+I` 全局切换；冲突时保留旧值并提示 |
| 长按 | Windows 托盘不支持可靠长按；其语义（打开更多操作）由右键菜单承担。面板状态环长按 550ms = 打开设置。 |

菜单项状态：

- 顶部两行 disabled：`InsomniaZ — ACTIVE` / `8m 38s remaining`。
- Toggle 文案随状态：`Turn Off InsomniaZ` / `Turn On InsomniaZ`。
- Duration 单选；∞ 显示 `Indefinitely`。
- Display 单选；Auto 后缀 `(New)`。
- Lid / Advanced 复选；不可用时 disabled + 原因后缀。
- “Settings…” 与 “Open Control Panel” 始终可用。
- Quit 放在最后，与上方分隔 8px。

---

## 8. 可访问性

- 全键盘可达：Tab 顺序 = 品牌区 → 开关 → 圆环 → 显示分段 → 时长 → 高级 → 页脚。
- 可见焦点：2px `--focus` + 2px offset；不依赖颜色。
- 语义：面板 `role="dialog" aria-label="InsomniaZ control panel"`；开关 `role="switch" aria-checked`；分段 `role="radiogroup"`；胶囊 `role="radio"`；倒计时 `aria-live="polite"`（每 30s 或状态变化播报，避免每秒刷屏）。
- 对比度：正文 ≥ 4.5:1；10px 标签为装饰性/辅助，重要信息另有正文。
- 减少动态：尊重 `prefers-reduced-motion` 和设置开关。
- 高对比度：使用 `forced-colors` 媒体查询，保留边框与焦点。
- 触摸/高 DPI：最小点击区 32×32；100%–200% 缩放下不裁切；窗口尺寸按 DPI 自动缩放。

---

## 9. 文案原则

- 品牌名保留 `InsomniaZ`；Windows 版副标题在设置/关于中出现。
- 英文标语保留官方气质：`Never sleep.` / `Screen stays on.` / `Screen can sleep.` / `Mac keeps running.` 在 Windows 改为 `PC keeps running.`。
- 中文文案避免直译腔：
  - “Keep awake with lid closed” → “合盖后保持运行”
  - “Prevent apps from seeing you idle” → “防止应用判定你离开”
  - “Screen can sleep” → “屏幕可休眠，系统继续运行”
- 不在正文使用感叹号；不使用营销夸张词。
- 所有动态文案通过 i18n 字典；数字与单位按 locale 格式化。

---

## 10. 禁止事项

- 不使用原应用的图标文件、App Store 截图作为应用内素材（截图仅作设计与验收参考，存放于 docs）。
- 不使用 “macOS 专属” 的窗口红绿灯控件伪装；Windows 版使用 Windows 语义的关闭/最小化。
- 不把“隐藏图标”做成无法访问：托盘图标始终存在，右键菜单功能完整。
- 不用颜色作为唯一状态信号。

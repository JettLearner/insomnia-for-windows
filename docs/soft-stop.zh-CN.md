# 软叫停（Soft Stop）

> 适用于 InsomniaZ for Windows 1.1.0 及以后版本（当前 1.2.0）  
> English: [soft-stop.md](soft-stop.md)  
> 相关源码：`shared/soft-stop.ts`、`shared/gui.ts`、`electron/core/{ai-detect,soft-stop-engine,soft-stop-sender,gui-agent}.ts`、`resources/helper/InsomniaZHelper.cs`  
> 设置界面：`src/routes/settings/SoftStopSection.tsx`

## 1. 它解决什么问题

合盖保持让电脑整夜运行 AI 任务，但任务可能在无人看守时持续烧电。软叫停提供两个电量阈值：

| 阈值 | 默认值 | 行为 |
|---|---:|---|
| **A：发送提示词** | 30% | 用一段固定提示词让正在运行的 AI 停下手上的工作、保存状态并简短汇报 |
| **B：保护性休眠** | 10% | 结束会话、还原合盖策略，然后让 Windows 立即休眠 |

两个阈值只在**使用电池**且会话处于激活状态时生效。插上电源，或电量回升到 A 以上 5 个百分点，本轮触发记录会自动重置。

## 2. 状态机

```
会话激活 + 使用电池 + 软叫停开启
        │
        ├── 电量 > A ───────────────► 等待（monitoring）
        │
        ├── 电量 ≤ A ──► 检测 AI 活动
        │                   ├── 没有活动 ──► 不发送，继续观察
        │                   └── 有活动 ────► 发送一次（dry-run / 真实）
        │                                        │
        │                                        └── 成功后本轮标记 triggered
        │
        └── 电量 ≤ B ───────────────► 结束会话 + 还原合盖 + 休眠
```

- **A 点只对“确实在跑的 AI”发送**。检测结果未知时先检测再决定；没有 AI 活动不会把提示词发进空气。
- **B 点无条件保护**：即使 A 点没检测到活动，也会结束会话并休眠。
- **每轮最多 2 次尝试**，两次尝试之间至少间隔 5 分钟；发送成功后本轮不再重复。
- 配置类阻塞（未加入白名单、需要人工确认、助手离线）不计入尝试次数，但同样受 5 分钟冷却限制。
- 会话结束、重新开始、插电或电量回升都会重置本轮计数；周期状态写入 `soft-stop-cycle.json`，崩溃重启后与当前会话对齐。
- 软叫停开启时，Battery 页原有的低电量保护自动让位（界面会明确提示），避免两套逻辑同时结束会话。

## 3. AI 活动检测

检测由状态机按需触发：状态机每 5 秒检查一次，只有到达 A 点且当前样本超过 45 秒才会重新采样；检测器自身缓存 12 秒。它只读取**进程名、监听端口、网络适配器类型、连接主机与吞吐量**，不读取任何内容：

1. **远程流式传输**：检查无线/蜂窝等适配器上的 AI 服务连接与吞吐量。已连接且有持续流量（≥15 KB/s）判定为 `likely`；仅连接判定为 `suspected`。
2. **本地 AI 运行时**：通过 `tasklist` 与端口探测识别内置知识库中的运行时（Ollama、LM Studio、vLLM、llama.cpp、Text Generation WebUI 等），并调用只读接口（如 Ollama `/api/ps`）判断是否空闲。
3. 检测结果连同证据（`process:`、`port:`、`api:`、`model:`、`remote:`、`throughput:`）写入审计；设置页的“Check AI activity”可随时查看当前判断。

判定为“有活动”的条件：任一本地运行时非空闲，**或**远程流式等级为 `likely`/`suspected`。

## 4. 发送目标

“Send through”有三种选择：

| 选项 | 说明 |
|---|---|
| **Auto-detect** | 依次尝试：正在运行的本地运行时 → 设置中的兼容 OpenAI 端点 → GUI 兜底（若开启） |
| **具体适配器** | 指定内置运行时或端点，例如 Ollama、LM Studio、OpenAI-compatible endpoint、Agent webhook、Codex/Claude Code CLI |
| **generic-gui** | 只走 GUI 识别与点击 |

内置知识库覆盖 HTTP（OpenAI 兼容、Ollama 原生）、Webhook、CLI（codex / claude / gemini / aider 等非交互式新进程）以及 GUI。用户也可通过 `%APPDATA%\InsomniaZ\soft-stop\knowledge.json` 覆盖或扩展。

### 4.1 提示词模板

提示词长度上限 2000 字符，支持变量：

- `{percent}`：当前电量
- `{threshold}`：A 点阈值
- `{sleepThreshold}`：B 点阈值
- `{model}`：本次发送使用的模型（若已知）

每次发送前渲染；空提示词会拒绝发送并在界面提示。提示词内容不写入日志或审计，审计只记录目标、结果与电量。

### 4.2 HTTP / Webhook

- 默认端点 `http://127.0.0.1:11434`（占位提示），实际以填入的 API base 为准；请求路径由适配器决定，例如 `/v1/chat/completions`。
- 模型留空时先请求 `/v1/models`（或运行时对应的只读接口）自动发现；发现失败会返回 `NO_MODEL`，不会带空模型硬发。
- **远程端点默认禁止**。只有打开 “Allow remote endpoints” 才会访问非回环地址；开启时界面明确标注请求会离开本机。
- API Key 通过 Windows DPAPI（`safeStorage`）加密保存在用户数据目录；日志只记录是否已存储，不记录内容。请求头与鉴权方式由适配器声明。
- **Dry run 默认开启**：只组装、渲染并写入审计，不建立发送请求；用于确认目标与提示词，关闭后才会真正投递。

### 4.3 CLI

CLI 适配器以**新进程**方式运行（例如 `codex exec ...`、`claude -p ...`），不会向已有终端注入按键。部分 CLI 仅支持新会话，界面的适配器说明会标注 `spawnOnly`。

## 5. GUI 兜底（无 API 的聊天应用）

GUI 兜底使用 Windows UI Automation（UIA）+ MSAA 桥，不依赖截图 OCR：

1. 扫描可见窗口，按进程、标题、焦点与候选控件打分，选出目标窗口。
2. 在窗口内识别：输入框、发送键、侧边栏/折叠键、对话列表项，以及“生成中”等忙碌状态。分类由多语言词典 + 几何位置 + 控件类型共同评分（`shared/gui.ts`）。
3. 优先选择带忙碌标记的对话（例如 “Generating answer”），点击该对话，再写入提示词、点击发送。
4. 每一步重新扫描并刷新控件引用，避免窗口重排导致误点。

安全闸门：

- **白名单**：只有进程名或窗口标题命中 “Allowed apps” 的窗口才会被操作。
- **首次确认**：默认需要用户在预览中确认；只有打开 “Send without confirmation” 才会无人值守点击。
- **Dry run**：默认只显示识别结果与计划步骤，不实际点击。
- 富文本编辑器（ProseMirror/TipTap 等以 UIA `Group` 暴露、没有 `ValuePattern`）按可编辑控件处理；写入后回读校验，防止中文提示词被截断。
- 识别只读取控件树；截图仅在用户勾选 “Capture the selected window” 时对目标窗口截取，用于预览。

**已知边界**：纯 Canvas 绘制、未暴露 UIA/MSAA 的应用无法识别；最小化的窗口需要先恢复；部分应用需要管理员权限才能被自动化；UIA 树在 3 分钟后可能失效，程序会在每次动作前重扫。真实应用的效果取决于其无障碍实现，建议首次使用一律先 dry-run 预览。

## 6. 示教录制

当内置词典认不准某个应用时，可以用鼠标“示范”一次：

1. 点击 **Start recording**（最长 5 分钟，可随时停止）。
2. 在目标应用中点击聊天输入框，再把鼠标停在发送键上；无需输入文字，也无需标记顺序或时长。
3. 程序只记录**左键点击与悬停**；渲染层收到的事件包含命中坐标与控件信息，但保存 profile 时只提取控件指纹与标签，不写入坐标、时长或顺序。
4. 停止后显示事件列表，每个事件给出建议标签（input / send / sidebar / conversation / busy / ignore），可逐条修改。
5. 填写配置名称与窗口标题匹配串，保存为 GUI profile。

隐私保证：

- 录制使用低级鼠标钩子，**没有键盘钩子**，不会记录键入内容、剪贴板或屏幕文字。
- 事件中不包含时间顺序约束与悬停时长语义；录制只用于提取“哪些控件是输入/发送”。
- 保存的 profile 仅含进程名、标题匹配与控件指纹/标签，可在设置中随时删除。

GUI profile 按进程与窗口标题自动匹配，保存在 `%APPDATA%\InsomniaZ\soft-stop\gui-profiles.json`；它不会覆盖 “Send through” 中的适配器选择。

## 7. 验证与通知

设置页提供：

- **Send a test prompt**：走一次当前目标的发送流程（遵循 dry-run），不影响电量周期。
- **Check AI activity**：立即采样一次检测结果。
- **Recent decisions**：最近 50 条审计（检测、发送、dry-run、跳过、休眠、错误、重置、profile、录制），不包含提示词正文。
- **Sleep now**：两步确认后立即结束会话并休眠，用于验证保护链路。

系统通知：A 点发送成功/失败、B 点休眠都会发送通知（可在 General 关闭通知）。通知只包含目标与电量。

## 8. 验收记录（v1.1.0 基线，2026-10-31）

以下是软叫停子系统当时的历史证据；当前总数见 [v1.2.0 发布说明](release-notes-v1.2.0.zh-CN.md)。

| 项目 | 结果 |
|---|---|
| 类型检查 | 通过 |
| Vitest | **12 文件 149 测试通过**，含真实 HTTP socket 的 OpenAI 兼容发送、鉴权头、提示词渲染、HTTP 500 与 dry-run 不发包 |
| Electron 冒烟 | **44/44 通过**，含 Soft Stop 页面渲染、5 张卡片、双阈值、开关状态、相位芯片与真实 AI 活动探测 |
| 原生测试窗口扫描 | 输入框 0.95、发送键 0.97、侧边栏 0.75、忙碌对话 0.75 |
| 真实 GUI 发送 | 选择 “Generating answer” → 写入完整中文提示词 → 点击发送；落盘 payload 与提示词**完全一致** |
| 示教录制 | 3 个鼠标事件（点击输入框、悬停输入框、悬停发送键），建议标签正确；`leakedPrompt=false` |
| Profile 应用 | 保存 `input`/`send` 后重扫命中 `profile-uia-test-window`，识别结果保持正确 |
| 保护性休眠 | 代码路径与 helper `suspend` 已实现；**未在真机上执行**，以免中断当前会话 |

仍未验证：物理合盖下的 B 点休眠、不同厂商电源方案、Elevated 应用自动化、纯 Canvas UI。首次使用请在有人值守时用 “Sleep now” 验证本机链路。

## 9. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 相位一直是 Monitoring | 未使用电池 / 电量高于 A | 正常；插电不触发 |
| A 点未发送，审计显示 `no AI activity` | 检测没有发现运行中的 AI | 用 “Check AI activity” 确认；本地运行时需被知识库识别 |
| `NO_TARGET` | Auto 模式没有可用目标，且 GUI 兜底未开启 | 指定适配器、填写端点，或开启 GUI 兜底并加入白名单 |
| `REMOTE_NOT_ALLOWED` | 端点非回环，且未允许远程 | 改用本机端点，或显式打开 “Allow remote endpoints” |
| `NEEDS_CONFIRMATION` | GUI 兜底未开启“无需确认” | 先 dry-run 核对，再打开 “Send without confirmation” |
| `NO_MODEL` | 端点未返回模型且未手填模型 | 填写模型名，或确认端点支持模型发现 |
| `HELPER_OFFLINE` | 保护性休眠需要电源助手 | 打开一次合盖保护并允许 UAC，或运行兼容性检查 |
| `SUSPEND_FAILED` | 系统拒绝休眠请求 | 检查电源策略/驱动；查看审计与 helper 日志 |

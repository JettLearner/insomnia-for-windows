# InsomniaZ for Windows — Autopilot 定时提示词投递（v1.2.0 设计）

> **已归档 / Archived.** 本文是 v1.2.0 实施前的设计定稿，保留作历史依据，不再随代码更新。
> 当前行为以 [用户指南](../../docs/autopilot.zh-CN.md) 与代码为准；控件比例锚点与思考强度环的
> 唯一事实来源是 `shared/autopilot-ui.ts`。文件名与落盘路径若与实现不一致，以实现为准
> （例如设置文件实际为 `autopilot-settings.json`，模型目录为 `autopilot-catalog.json`）。
>
> This is the pre-implementation design record for v1.2.0, kept for history only.
> Current behaviour: [user guide](../../docs/autopilot.md); source of truth for control
> anchors: `shared/autopilot-ui.ts`.

状态：设计定稿，已实施。本文只描述 v1.2.0 新增的 Autopilot 子系统；v1.0.0/v1.1.0 的行为与契约
（同目录 `01-requirements.md`–`05-review.md` 与 `../../docs/soft-stop.zh-CN.md`）不因此改变。

---

## 0. 目标与非协商底线

**目标**：做一个可后台常驻的轻量调度器。到点后把一段完整提示词连同附件、模型与参数、目标会话/
工作区、能力开关，自动投递到 ZCode 或 WorkBuddy。不要求目标应用在前台，不要求预先选中会话，
不要求模型预选，也不需要额度当时可见。投递失败时按内置知识库自愈重试；重试耗尽后可兜底到本地
Ollama 或用户显式开启的应急 API。

**底线（写进代码约束）**：

1. 不可逆或涉及账号/权限/费用的问题不自动决策，一律回到用户：额度过期、工作区丢失、目标应用
   出现更新/登录/付费弹窗、需要删除原文件。
2. 自动化一旦确认，窗口被隐藏、最小化、关闭、跨屏、DPI 或分辨率变化都不构成失败理由。调度器在
   主进程，界面只是投影。
3. 每个失败都有确定的自动恢复动作与重试预算；预算耗尽才降级，降级失败才 `failed` 并通知。
4. 提示词正文、附件路径、密钥不进日志明文（§12）。
5. 应急 API 默认关闭，必须用户显式开启并保存过密钥才允许出站。
6. 检测到第三方屏幕采集、远程接管或高负载时，本应用主动彻底隐藏，不干扰对方的画面采集与操控（§13）。

---

## 1. 需求与验收映射

| # | 用户要求 | 设计落点 | 验收 |
|---|---|---|---|
| Q1 | 定时把提示词发给 WorkBuddy / ZCode，后台可运行 | §4 引擎 + 托盘常驻 | 全部窗口关闭后仍准点触发 |
| Q2 | 不预选模型；目标不必在前台；不必预选会话 | §7 S1/S4、§8 | 三种缺省状态下均能投递 |
| Q3 | 每条提示词可设任意时间、模型、详细参数、目标会话/工作区会话 | §5 `Job` | 5 条异构任务混合排队全部正确 |
| Q4 | 目标运行时自动采集并同步会话列表与模型列表 | §7 S2、§5 catalog/conversations | 发现目标后 60s 内两份列表可搜 |
| Q5 | ZCode 无额度时不显示模型 → 从网上收集可能支持的模型并内置同步 | §9 三层目录 | 无额度时仍可选定模型 |
| Q6 | ZCode 定时任务先去模型设置刷新，再选模型再发送 | §7 S3 | 人为置为未就绪后能自动恢复并发送 |
| Q7 | 用复杂脚本智能识别模型选项并正确切换 | §7 S4 + §9 打分匹配 | 10 个近似名切换 10/10 |
| Q8 | 内置所有已知错误与对应的重试/刷新策略 | §12 错误目录 | 每条码有单测或集成用例 |
| Q9 | 原生壳窗口、可自由缩放；像完整 AI 聊天窗口：附件、技能、MCP、连接器、专家、模式、工作区、长文本、拖拽 | §14 UI + §7 S5 | 逐项手工验收表 |
| Q10 | 发送时自动转发附件并同步技能/扩展 | §10、§7 S5/S8 | 附件真实出现在目标输入区 |
| Q11 | 出错可用本地 Ollama 或应急 API key | §11 兜底链 | GUI 通道断开后 30s 内由 Ollama 完成 |
| Q12 | 优先按写死的知识多试几次 | §12 每条码的 attempts/backoff | 日志可数出重试次数与动作序列 |
| Q13 | 发送前校验附件存在；缺失先搜索；仍缺失则把缺失说明写进提示词 | §10.1–§10.2 | 三种情形各有用例 |
| Q14 | 可选自动备份附件；手动删除 / 立即删除 / 保留天数 | §10.3 | 开关、保留期、三种删除动作均可用 |
| Q15 | 文件还在且开了备份 → 让模型读原文件；只有备份 → 先复原到原目录，再让模型读原目录那个文件 | §10.4 | 四象限用例全过 |
| Q16 | 按性能资源占用自适应频率实时保存；采集/操控/高负载时窗口彻底隐藏 | §5.4、§13 | 高负载下保存间隔拉长且不丢数据；录屏启动 3s 内隐藏 |

---

## 2. 实测可行性结论

三条通道在真实窗口上的结论（不是推断）：

| 通道 | ZCode | WorkBuddy / WorkBuddy AI | 用途 |
|---|---|---|---|
| UIA（`AutomationElement.FromHandle` + `FindAll(Descendants)`） | 0 个后代 | 0 个后代 | 不可用 |
| MSAA（`oleacc!AccessibleObjectFromWindow`，`OBJID_CLIENT = 0xFFFFFFFC`） | 完整 DOM，实测 455 个节点，含 role/name/default action/物理屏幕矩形 | 仅空 document（10–12 个节点） | ZCode 主通道 |
| PrintWindow(`PW_RENDERFULLCONTENT = 2`) + `Windows.Media.Ocr`（zh-Hans-CN） | 可截 1942×1162 完整画面 | 可截完整画面且不激活窗口 | WorkBuddy 主通道 |

UIA 的不可用不是探针问题：同一探针在 WinForms 夹具窗口上能拿到 6 个命名子节点；自定义最小
Electron 应用显式调用 `app.setAccessibilitySupportEnabled(true)` 后仍为 0；ZCode 是单实例应用，
用 `--force-renderer-accessibility` 二次启动会被既有实例吞掉，不会产生新进程，因此无法给已运行
的目标补开可访问性。结论：**只能走 MSAA + OCR，不能要求目标配合。**

### 2.1 坐标与 DPI 契约

实测机器：物理 1920×1200，系统缩放 150%，目标窗口 `GetDpiForWindow = 144`。

- MSAA `accLocation` 返回物理像素；
- `PrintWindow` 位图为物理像素；
- `SetCursorPos` 在调用线程执行 `SetProcessDPIAware()` 后为物理像素。

统一约定：**helper 内部全程使用物理像素，跨层不换算**。渲染进程只负责显示，不参与坐标。

### 2.2 ZCode 控件地图（1942×1162 最大化，物理像素）

| 语义 | role | name | rect | 备注 |
|---|---|---|---|---|
| 输入框 | 42 TEXT | `提出后续修改要求` | `[527,967,1259,60]` | default action = 激活 |
| 发送 | 43 PUSHBUTTON | `发送` | `[1744,1045,42,42]` | 输入为空时 `state & 1`（UNAVAILABLE），可作为「文本已被接受」的免费校验 |
| 模型触发器 | 57 BUTTONMENU | `GLM-5.3-Flash 最高` | `[1494,1045,244,42]` | `HASPOPUP`；`accDoDefaultAction` 无效，需真实点击其尖端区域 |
| 模式 | 57 BUTTONMENU | `切换模式` → 子项 `完全访问` | `[575,1045,167,42]` | |
| 添加上下文 | 43 PUSHBUTTON | `添加上下文` | `[527,1045,42,42]` | 附件入口 |
| 上下文用量 | 43 | `上下文已用 398,057 / 总量 1,000,000` | — | 额度健康度探针 |
| 模型弹层 | 11 MENUPOPUP | — | `[1342,731,432,311]` | 子项 role=12：`供应商: Start Plan`、模型条目（当前项 CHECKED）、`思考强度 最高 Ctrl+T`（内部含 role=51 SLIDER） |
| 供应商子菜单 | 12 | `Start Plan 免费`、`新供应商 API`、`阿里云百炼（中国） API`、`管理模型` | — | |
| 模型设置页 | — | `加载中…` → `刷新` `[1562,184,42,42]`；`添加供应商` `[1616,184,155,42]`；`返回工作区` `[80,96,366,48]` | — | `加载中…` 变 `刷新` 即就绪，是 Q6 的判定条件 |
| Start Plan 页 | — | 今日余额、过期时间、`添加模型` `[1600,755,134,43]`、模型行（`上下文窗口`、`测试模型`、`编辑模型配置`、`禁用`） | — | 额度与「未就绪」判据 |
| 设置导航 | — | `插件`、`MCP 服务器`、`技能`、`命令`、`钩子`、`电脑控制`、`浏览器控制` | — | Q9 的能力开关落点 |

注意：管理模型弹层底部视觉上的「选择模型」不在可访问性树中，所以模型全集不能只依赖运行时弹层，
必须有 §9 的内置目录。

### 2.3 侦察时踩到、产品代码必须避免的副作用

- `ShowWindow(SW_RESTORE)` 会把用户最大化的目标窗口还原。helper 永不主动 restore/maximize，
  只在必要时按侦察前记录的 show state 复原。
- 输入框中心点击会切换当前会话。点击必须落在输入框 rect 内的安全偏移（右侧留出按钮区），
  点击后先回读会话名未变再继续。
- 误触会打开浏览器侧边面板。每次执行前记录面板存在性，执行后对比并调用 `收起侧边面板` 复原。

以上三点写进 §12 的 `auto_restore` 动作，并在每次 `deliver` 的 `RunStep` 里留痕。

---

## 3. 进程与模块拓扑

```
Electron 主进程（非提权）
 ├─ AutopilotEngine        调度与状态机（§6）
 ├─ AutopilotStore         jobs / runs / catalog / conversations / attachments（§5）
 ├─ AttachmentService      存在性校验、搜索、备份、复原（§10）
 ├─ AutoBridge             ↔ InsomniaZAuto.exe（stdio JSON-lines）
 ├─ FallbackSender         Ollama / OpenAI 兼容（复用 SoftStopSender 的 fetch 路径）
 └─ ProtectionGate         采集 / 接管 / 负载检测（§13）

InsomniaZAuto.exe          C# .NET Framework 4.8，**非提权**，STA 线程
  win.list / win.capture / perf.sample
  msaa.dump / msaa.find / msaa.act / msaa.value
  clip.read / clip.write / clip.writeFiles
  input.click / input.keys
  ocr.recognize

InsomniaZHelper.exe        C# .NET Framework 4.8，提权，本增量零改动
  合盖 / 执行状态 / jiggle / UIA（v1.1.0 软叫停使用）
```

### 3.1 为什么另建非提权 helper

1. UIPI：提权进程对中等完整性目标做 MSAA 读取与输入注入存在不确定行为，自动化必须与目标同完整性。
2. 风险隔离：提权 helper 正在保护这台机器，且线上稳定；新功能不得有机会打断既有电源控制，
   也避免触碰「不改动已生效合盖保护」的约束。
3. 失败半径：自动化 helper 崩了只是任务延迟；提权 helper 崩了会留下电源状态不一致。

### 3.2 协议

stdio 行分隔 JSON，父进程独占句柄，天然单用户、无跨会话暴露面：

```
→ {"id":1,"cmd":"msaa.find","token":"<24B hex>","args":{...}}
← {"id":1,"ok":true,"data":{...}}
← {"id":1,"ok":false,"error":{"code":"TARGET_NOT_FOUND","message":"...","retryable":true}}
```

- 启动参数 `--token <hex> --parent-pid <pid> --log <path>`；父进程消失即退出。
- 每个命令带超时，超时映射为 `TIMEOUT`。
- 进程退出由 `AutoBridge` 检测并重建，从状态机安全点重入（`AUTO_HELPER_DEAD`）。

### 3.3 源码与构建

- `resources/helper/InsomniaZAuto.cs`，内嵌 manifest 声明 `asInvoker`（不得 `requireAdministrator`）。
- 新增 `scripts/build-auto-helper.ps1`，沿用现有 csc 参数（`v4.0.30319`、`-platform:x64`、
  `-r:System.Web.Extensions.dll`、`Accessibility.dll`），额外引用 WinRT 投影
  （`System.Runtime.WindowsRuntime.dll`、`Windows.winmd`）供 OCR 使用。
- `package.json`：`build` 串联两个 helper；`extraResources` 增加 `InsomniaZAuto.exe`。

---

## 4. 交付形态

- 新增一个原生壳窗口（§14）作为任务编辑与观测界面，`frame: true`、`resizable: true`。
- 托盘菜单新增入口（现有 `tray.ts` 一级菜单追加，不改既有项语义）。
- 默认不驻留任务栏（`skipTaskbar` 沿用现有窗口策略）；窗口关闭为隐藏，引擎继续运行。
- 版本号进入 v1.2.0 分支；打包须在功能验证通过并经用户确认后进行。

---

## 5. 数据模型与持久化

类型集中在新增的 `shared/autopilot.ts`，主进程与渲染进程共用。时间一律 ISO-8601 字符串，
坐标一律物理像素。

### 5.1 Job

```ts
type ScheduleKind = 'once' | 'daily' | 'weekly' | 'interval' | 'manual';

interface Schedule {
  kind: ScheduleKind;
  at?: string;          // once
  timeOfDay?: string;   // 'HH:mm'
  weekdays?: number[];  // 0 = 周日
  everyMinutes?: number;
  catchUp: 'run_once' | 'skip' | 'ask';
}

interface ModelSpec {
  provider?: string;    // 'Start Plan' | 'Z.ai' | '阿里云百炼（中国）' | '新供应商'
  name?: string;        // 缺省 = 不预选，沿用目标当前模型
  thinking?: 'low' | 'medium' | 'high' | 'max';
  params?: Record<string, string | number | boolean>;
}

interface Capabilities {
  mode?: string;
  skills?: string[];
  mcp?: string[];
  plugins?: string[];
  experts?: string[];
  workspace?: string;
}

interface Attachment {
  id: string;
  originalPath: string;
  displayName: string;
  backup: boolean;
  retention: 'delete_now' | 'keep' | 'expire';
  retentionDays?: number;
}

interface Job {
  id: string;
  schemaVersion: 1;
  title: string;
  target: 'zcode' | 'workbuddy' | 'workbuddy-ai' | 'generic' | 'fallback-only';
  conversation?: { kind: 'named' | 'current' | 'new'; name?: string; workspace?: string };
  prompt: string;              // 不写日志
  model?: ModelSpec;
  capabilities?: Capabilities;
  attachments: Attachment[];
  schedule: Schedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: 'idle' | 'queued' | 'running' | 'sent' | 'failed' | 'skipped' | 'deferred' | 'blocked';
  attemptsBudget: number;      // 默认 12
}
```

### 5.2 Run

```ts
interface RunStep {
  t: string;
  step: string;       // resolve_target | sync | ensure_model | place_text | attach | send | verify | restore
  ok: boolean;
  code?: string;
  ms: number;
  detail?: string;    // 落盘前强制脱敏
}

interface Run {
  id: string;
  jobId: string;
  startedAt: string;
  endedAt?: string;
  state: 'running' | 'sent' | 'failed' | 'skipped' | 'deferred' | 'interrupted';
  route: 'gui-zcode' | 'gui-workbuddy' | 'fallback-ollama' | 'fallback-api' | 'cli';
  attempts: number;
  steps: RunStep[];
  error?: { code: string; message: string };
  promptDigest: string;   // sha256 前 16 位，不含明文
}
```

### 5.3 文件

全部位于 `app.getPath('userData')`，复用 `store.ts` 的 tmp+rename 原子写：

| 文件 | 内容 | 写策略 |
|---|---|---|
| `autopilot-jobs.json` | `Job[]` | 变更即时写 |
| `autopilot-runs.json` | `Run[]`，上限 500 条 | 节流追加，退出强制 flush |
| `autopilot-catalog.json` | 模型目录 | 每小时最多一次 |
| `autopilot-conversations.json` | 按目标分组的会话列表 | 每小时最多一次 |
| `autopilot-attachments.json` | 附件台账（原路径 ↔ 备份路径 ↔ 状态） | 动作后即时写 |
| `settings.json` 的 `autopilot` 段 | 子系统设置 | 与既有 `sanitizeSettings` 同层 |

不在 `shared/types.ts` 里另开 store，避免与既有 `SettingsStore` 形成双写；`schemaVersion` 递增并提供
迁移（缺字段补默认值，未知字段丢弃）。

### 5.4 自适应实时保存

`AutosaveController`：

```
load     = max(cpuBusy, memoryPressure, diskQueue)
interval = clamp(500ms × (1 + 4 × load), 500ms, 15s)
```

- 采样源 `perf.sample`（`GetSystemTimes`、`GlobalMemoryStatusEx`、进程 CPU 增量）。
- 任何状态迁移（`running → sent/failed/deferred`）无视节流立即 flush，崩溃最多丢一段步骤时间线。
- `before-quit`、`powerMonitor` 的 `suspend`/`shutdown` 强制 flush。
- 单测用假时钟断言曲线与「状态迁移绕过节流」。

---

## 6. 调度器

```
IDLE ─due→ RESOLVE_TARGET → SYNC → PREPARE_ATTACH → ENSURE_CAPABILITY → ENSURE_MODEL
                                                                          ↓
DONE ← VERIFY ← SEND ← ATTACH ← PLACE_TEXT ←──────────────────────────────┘
```

1. **时间**：`setTimeout` 只负责唤醒到下一分钟，到期判定用 `Date.now()` 对 `nextDueAt`，每次唤醒重算，
   避免长定时器漂移。
2. **补发**：启动或 `resume` 时若 `now − scheduledAt > 600s`：`run_once` 合并补跑一次、`skip` 标
   `skipped`、`ask` 进 `blocked`。休眠期间绝不执行 GUI 自动化。
3. **串行化**：同一时刻只允许一个 GUI 投递（全局 `dispatchLock`）；GUI 自动化并发会互相抢焦点，
   属绝对性风险。Ollama/API 兜底可并行，上限 2。
4. **幂等**：`runId = hash(jobId + scheduledAt)`。重启后发现 `running` 且心跳超过 30s → 标
   `interrupted`，先做 `verify`：目标 transcript 末尾已含本次提示词前 60 字符则判 `sent`，否则重投。
5. **取消**：置 `cancelled`，执行体在步骤边界检查，最多一步后停止。已输入目标的内容不撤回
   （撤回属绝对性风险），改为提示用户确认。
6. **窗口无关**：引擎不持有 `BrowserWindow` 引用，窗口隐藏/关闭不影响调度；引擎异常由主进程
   watchdog 5s 内重建并从磁盘状态恢复队列。
7. **与软叫停仲裁**：软叫停进入 L1/L2 时 Autopilot 立即停止 GUI 自动化并把待发转 `deferred`；
   两者共用 `dispatchLock`，软叫停优先。

---

## 7. ZCode 投递流程（MSAA）

每步都写 `RunStep`；每步失败按 §12 的码进入恢复。

- **S0 定位**：`win.list(pid)` 取主窗口，排除 `Intermediate D3D Window` 子窗口；记录 show state、
  rect、当前会话名、侧边面板存在性，供 S11 复原。不 restore/maximize。
- **S1 会话**：`msaa.find` 在 outline 中精确匹配 `conversation.name` 后点击；`new` 走新建；
  `current` 跳过。未指定且检测到无选中项时，选 outline 首项或不新建。点击后回读会话名，
  不符则 `SESSION_DRIFT` 复原并重试。
- **S2 模型同步**：点击模型触发器尖端 → 读 role=11 弹层 → 收集 role=12 条目（含 CHECKED）→ `Esc` 关闭。
  弹层只有当前项或全部灰显 → 视为 `MODEL_UNAVAILABLE_NO_QUOTA`，进 S3。
- **S3 额度自救**：`管理模型` → 模型设置页 → 轮询至 `加载中…` 变 `刷新` → 点 `刷新` → 轮询供应商
  行出现余额信息且状态非 `未就绪` → `返回工作区` → 重跑 S2。最多 3 轮，退避 2s/5s/10s。
  过期时间已过或余额 0% → `QUOTA_EXPIRED`，不自动处理，通知用户。
- **S4 切换模型**：目标名在 S2 列表内则按 §9 打分点击并回读 CHECKED；不在列表内则依目录里的
  provider 切供应商后重试；仍失败按 `besteffort`（默认）沿用当前模型并在 run 标注 `model_mismatch`，
  或按 `strict` 进兜底。
- **S5 能力开关**：`切换模式` 匹配 `capabilities.mode`；技能/MCP/插件/专家在设置页对应导航项内按
  名称匹配，读 `CHECKED` 状态后才点（幂等，避免把已开启点成关闭）。
- **S6 工作区**：按 `conversation.workspace` 名称匹配工作区选择器；不存在 → `WORKSPACE_MISSING`，
  不自动创建目录。
- **S7 输入**：不用逐字符模拟键入（长文本、中文、输入法风险高）。`clip.write(text)` → 点击输入框
  安全偏移 → `Ctrl+V` → 回读输入框 value 校验。失败重试一次，再失败进兜底。写入前保存用户剪贴板，
  结束后恢复。
- **S8 附件**：优先 `clip.writeFiles(paths)` + `Ctrl+V`（CF_HDROP 直接成附件）；不支持时点
  `添加上下文` → 文件对话框内粘贴路径 + `Enter`。
- **S9 发送前校验**：`发送` 的 `state & 1` 必须为 0，否则 `SEND_DISABLED`。
- **S10 发送与验证**：点击发送 → 轮询 ≤8s，条件为输入框清空 **且** transcript 出现提示词摘要。
  未确认 → `SEND_UNCONFIRMED`；任何恢复路径都先做幂等检查，确认未投递才允许再次点击，
  最多再点 1 次。
- **S11 复原**：恢复 show state、关闭误开的侧边面板、恢复剪贴板。

---

## 8. WorkBuddy 投递流程（PrintWindow + OCR）

MSAA 只暴露空 document，所以以图像为准：

1. `win.capture(hwnd, 2)` 不激活取整窗位图（实测 1942×1162 完整）。
2. `ocr.recognize` 得词级文本与物理坐标。
3. 控件发现启发式：
   - 输入区：底部最宽的空区域，加上方占位文案（`请输入`/`提问`/`Message` 等）；
   - 发送键：输入区右侧小方块，文字命中 `发送`/`Send`/`↑`，或「无文字但孤立在右下」；
   - 模型名：工具条上命中模型家族关键词（`GLM`/`DeepSeek`/`Kimi`/`Qwen`/`GPT`/`Claude`/`MiniMax`/`Doubao`）；
   - 会话列表：左侧 28% 宽度区域内按行切分、y 递增的文本块。
4. 点击前用 `WindowFromPoint` 确认命中目标 hwnd；被遮挡时先 `SetWindowPos` 抬一层（不带激活），
   仍不命中则改走兜底。这是该路径唯一的真实限制，必须写进 run 的失败原因。
5. 输入同样走剪贴板 + `Ctrl+V`；用 OCR 回读输入区做校验，置信度低于 0.6 时退化为长度一致校验。
6. 发送验证：对比发送前后 transcript 区域文本增量是否包含提示词前缀。

---

## 9. 模型目录与名称匹配

### 9.1 三层来源

1. **内置种子**（随包发布，离线可用）：按公开资料与实测整理，每条含 `provider`、`aliases`、
   `contextWindow`、`vision`、`thinkingLevels`：
   - Z.ai / Start Plan：`GLM-5.3`、`GLM-5.3-Flash`（1M 上下文、原生多模态、仅思考模式）、
     `GLM-5.3-FlashX`、`GLM-5.2`；思考强度档位 低/中/高/最高；
   - 阿里云百炼（中国）：`Qwen3-Coder`、`Qwen3-Max`、`Qwen3-VL`；
   - 本地 Ollama 常见项：`qwen2.5-coder`、`glm4` 等（可用 `/api/tags` 覆盖）；
   - `新供应商`：用户自定义 OpenAI 兼容条目。
2. **实测回写**：S2/S3 每次成功读取的弹层与模型设置页条目写回，带 `observedAt`。
3. **在线刷新**（默认关闭）：用户配置 URL 才启用，失败静默降级到 1+2。

冲突解决：`observed` > `seed` > `remote`；唯一键为 `(provider, name)`。

### 9.2 打分匹配

```
100 归一化后完全相等（含 aliases）
 80 前缀/后缀包含（"GLM-5.3-Flash 视觉" ⊃ "GLM-5.3-Flash"）
 55 token 集合 Jaccard ≥ 0.6
 30 编辑距离 ≤ 2，且候选唯一
  0 不匹配
```

归一化：全半角、大小写、空白、括注（如 `（中国）`）、版本分隔符。≥80 直接点击；55–79 需唯一候选
且点击后回读 CHECKED 确认；<55 视为不匹配。

---

## 10. 附件子系统

### 10.1 发送前解析

```
1. stat(originalPath) 存在且 size > 0 → 用原路径
2. 不存在 → 搜索（§10.2）→ 唯一命中且可校验 → 自动重绑定；多命中 → 取 size+mtime 最接近台账者，
   记 ambiguous_search_picked；无命中 → 3
3. 有备份 → §10.4 复原；否则把「缺失说明」附加到提示词尾部
```

缺失说明固定格式（便于检索与脱敏对齐）：

```
【附件缺失说明】以下附件在计划发送时不可读，已跳过：
- 报告.pdf（原始路径已失效；备份：无）
```

### 10.2 搜索

台账维护 `displayName + size + mtimeMs + sha256(前 64KB) + knownPaths[]`。搜索顺序：已知路径 →
备份台账 → 用户目录限深遍历 → 回收站。硬预算：≤3s、≤50k 条目，跳过网络盘与系统目录。

### 10.3 备份与保留

- 备份根 `userData/autopilot/attachments/<jobId>/<attachmentId>/<sha8>-<name>`；`copy + fsync + 复核 stat`，
  失败只记 `BACKUP_FAILED`，不阻断投递。
- 三种保留：`delete_now`（发送成功后删）、`keep`（手动删）、`expire`（到期由每日清理任务删）。
  **清理只删备份，永不删原件。**
- 全局配额默认 2 GiB，超限按 LRU 淘汰备份并通知。

### 10.4 原件优先规则（逐字实现 Q15）

| 原文件 | 开了备份 | 备份存在 | 行为 |
|---|---|---|---|
| 在 | 任意 | 任意 | 让模型读原文件，绝不喂备份路径 |
| 不在 | 是 | 在 | 先把备份复制回原目录（保留原文件名），再让模型读原目录那个文件 |
| 不在 | 是 | 不在 | 缺失说明 |
| 不在 | 否 | 在（历史遗留） | 同第二行：仍先复原再读原路径 |

复原时原目录不存在则 `mkdir` 补建；目录在离线可移动盘则 `RESTORE_TARGET_UNAVAILABLE`，
不改写到其它盘（会违背「读原目录」语义），直接走缺失说明。

---

## 11. 兜底链

顺序，逐级失败才进下一级，整体受 `attemptsBudget` 约束：

1. GUI 主路径（§7 / §8）；
2. CLI 路径（复用 `knowledge.ts` 的 `cli-*` 适配器，`spawn` 一次性投递，无 GUI）；
3. 本地 Ollama：`127.0.0.1:11434`，进程与端口用 `knowledge.ts` 的 `ollama` 匹配；
4. 应急 API：OpenAI 兼容 `POST <base>/v1/chat/completions`，默认关闭，必须显式开启并保存密钥；
5. 全部失败 → `failed` + 系统通知 + 托盘标记，并按下一次计划重试。

实现复用 `SoftStopSender` 的 `fetchImpl` 注入与模板渲染，`FallbackSender` 只做编排。
主进程 `fetch` 不经过 `installNetGuard` 的 `session.webRequest`，所以出站门禁在
`AutopilotSettings.fallback.remoteEnabled` 里独立实现（§12）。

---

## 12. 错误目录

格式：`code / 判定依据 / 自动动作 / 重试上限 / 退避 / 耗尽后`。判定一律基于可回读证据
（MSAA 节点、OCR 文本、按钮 state、剪贴板回读），不基于「看起来成功」。

**目标与窗口**

| code | 判定 | 自动动作 | 上限 | 耗尽后 |
|---|---|---|---|---|
| TARGET_NOT_RUNNING | 无进程 | 启动已登记的可执行路径 → 等主窗口 60s | 2 | 兜底 |
| TARGET_NO_WINDOW | 有进程无主窗口 | 轮询 `EnumWindows` | 3 | 兜底 |
| WINDOW_MINIMIZED | show state 最小化 | 纯 MSAA 优先；必要时 `SW_SHOWNOACTIVATE` | 1 | deferred |
| WINDOW_OCCLUDED | `WindowFromPoint` 不命中 | `SetWindowPos` 抬层（不激活） | 2 | 兜底 |
| DPI_CHANGED | `GetDpiForWindow` 变 | 重扫树、重算全部 rect | 1 | SEND_UNCONFIRMED |
| RESOLUTION_CHANGED | 屏幕数/尺寸变 | 重新定位窗口与 rect | 1 | deferred |
| TARGET_BUSY | `state & 0x800` 连续 3 次不变 | 等 30s；不结束目标进程 | 2 | 兜底 |
| TREE_EMPTY | 节点 < 20 | 重建 `AccessibleObjectFromWindow`；再空转 OCR | 2 | §8 |

**会话与工作区**

| code | 判定 | 自动动作 | 上限 | 耗尽后 |
|---|---|---|---|---|
| CONVERSATION_NOT_FOUND | outline 无精确名 | 前缀 → 模糊 → 新建 | 2 | deferred + 通知 |
| CONVERSATION_AMBIGUOUS | 多个同名 | 取列表首个并记录 | 1 | 通知 |
| SESSION_DRIFT | 点击后会话名不符 | 点回原会话，重跑 S1 | 2 | deferred |
| WORKSPACE_MISSING | 工作区名不存在 | 仅名称匹配搜索，不建目录 | 1 | 通知 |
| WORKSPACE_UNWRITABLE | 无写权限 | 不改权限 | 0 | 通知 |

**模型与额度**

| code | 判定 | 自动动作 | 上限 | 耗尽后 |
|---|---|---|---|---|
| MODEL_POPUP_NOT_OPENED | 点后无 role=11 | 截图 OCR 定位尖端，重算点击点 | 3 | 当前模型 |
| MODEL_UNAVAILABLE_NO_QUOTA | 弹层仅当前项 / 全灰 / 文案含额度 | S3 刷新流程 | 3 | 兜底 |
| MODEL_LOADING | 页面含 `加载中…` | 轮询至变 `刷新`（≤20s） | 1 | MODEL_UNAVAILABLE_NO_QUOTA |
| MODEL_REFRESH_FAILED | 刷新后仍 `未就绪` | 重进供应商页、切 provider 再回 | 2 | 兜底 |
| QUOTA_EXPIRED | 过期时间已过 / 余额 0% | 不自动处理（账号问题） | 0 | blocked + 通知 |
| PROVIDER_NOT_READY | 供应商行含 `未就绪` | 点 `测试模型`/`刷新`；否则换候选 | 2 | model_mismatch |
| MODEL_NOT_IN_CATALOG | 目录无此名 | 阈值放宽到 55 的唯一候选 | 1 | strict → 兜底 |
| MODEL_SWITCH_UNCONFIRMED | 点击后 CHECKED 未变 | 重开弹层再点同 rect | 2 | model_mismatch |
| THINKING_LEVEL_NOT_SET | role=51 值不符 | `accSetValue` 或方向键微调 | 2 | param_mismatch |

**输入与发送**

| code | 判定 | 自动动作 | 上限 | 耗尽后 |
|---|---|---|---|---|
| CLIPBOARD_OCCUPIED | 写入失败 | `OpenClipboard` 50ms×10 → 逐字符注入 | 2 | 兜底 |
| PASTE_UNCONFIRMED | 输入框长度差 > 2% | 再粘一次 → `WM_IME_CHAR` | 2 | 兜底 |
| INPUT_NOT_FOUND | 无 role=42 | OCR 定位输入区 → 仍无则 TREE_EMPTY | 2 | 兜底 |
| SEND_DISABLED | `发送` `state & 1` | 检查输入非空、重新聚焦、点输入框末尾 | 3 | 兜底 |
| SEND_UNCONFIRMED | 点击后输入未清空 | **先幂等检查**：transcript 已含摘要则判 sent | 1 | 兜底 |
| DUPLICATE_RISK | 幂等无法判定 | **停止重试**（重复投递属绝对性风险） | 0 | blocked + 通知 |
| RATE_LIMITED | 页面含繁忙/429/限流 | 指数退避 | 4 | 兜底 |
| NETWORK_DOWN | 连接检测失败 | 等 60s，期间不点发送 | 5 | 兜底 |
| APP_UPDATING | 出现更新弹窗 | 只点「稍后/取消」 | 1 | deferred |
| MODAL_INTERCEPTED | 焦点被弹层占用 | 匹配关闭类文案；匹配不到则 deferred | 2 | deferred |
| GUI_BUSY_BY_AI | `ai-detect` 或 `state & 0x800` | 排队等待 ≤10 分钟 | 3 | deferred |

**附件**

| code | 判定 | 自动动作 | 上限 | 耗尽后 |
|---|---|---|---|---|
| ATTACHMENT_MISSING | `stat` 失败 | §10.1 搜索 → 复原 → 缺失说明 | 1 | 缺失说明 |
| RESTORE_TARGET_UNAVAILABLE | 原目录不可写 / 盘离线 | 不改写到别处 | 0 | 缺失说明 |
| BACKUP_FAILED | 备份写失败 | 重试一次 | 1 | 继续投递 |
| BACKUP_QUOTA_EXCEEDED | 超配额 | LRU 淘汰备份 | 1 | 关闭本条备份 |
| DROP_UNSUPPORTED | CF_HDROP 粘贴无效 | `添加上下文` → 对话框路径 + Enter | 2 | 缺失说明 |
| ATTACHMENT_TOO_LARGE | 超 `maxAttachmentBytes` | 不裁剪，跳过并说明 | 0 | 说明 |

**运行时与自身**

| code | 判定 | 自动动作 | 上限 | 耗尽后 |
|---|---|---|---|---|
| AUTO_HELPER_DEAD | 子进程退出/无响应 | 重启（新 token）→ 安全点重入 | 3 | 兜底 |
| AUTO_HELPER_DENIED | `ERROR_ACCESS_DENIED` | 记录完整性级别，降级为 OCR + 坐标 | 1 | 兜底 |
| OCR_ENGINE_MISSING | `TryCreateFromUserProfileLanguages` 返回空 | 回退 `en-US` → 提示安装中文语言包 | 1 | 仅 MSAA |
| SAVE_FAILED | 原子写失败 | 重试 → 落 `.bak` 并标记 | 3 | 暂停新任务 |
| PROTECTION_DEFERRED | §13 闸门 | 转 deferred，解除后自动续 | ∞ | — |
| SOFT_STOP_INTERCEPT | 软叫停触发 | 让路并转 deferred | ∞ | — |
| SHUTDOWN_IMMINENT | `before-quit` / `shutdown` | flush 并转 deferred，不半途强投 | 1 | — |
| SUSPEND | `powerMonitor.suspend` | flush 并暂停，resume 后补发 | ∞ | — |
| UNEXPECTED_EXCEPTION | 未捕获异常 | 记栈，job 回 `queued` | 2 | failed + 通知 |

统一约束：**「点击发送」最多执行 2 次**，第二次前必须有幂等证据；`DUPLICATE_RISK` 永远优先于
「再试一次」。

---

## 13. 保护闸门

每 4s 采样（高负载时 15s）：

| 信号 | 采样方式 | 判定 |
|---|---|---|
| 屏幕采集 | 已知录屏/截图工具进程与窗口类、GDI 抓取句柄、屏幕捕获会话 | `capturing` |
| 远程接管 | `WTSQuerySessionInformation` 取客户端名非空、已知远控进程（RDP/ToDesk/向日葵/TeamViewer/Parsec/rustdesk） | `taken_over` |
| 资源 | `perf.sample` 的 CPU/内存/磁盘队列 | `hot` |

动作：

- `capturing || taken_over` → 隐藏本应用全部窗口，停止 GUI 自动化（跑到安全点），降低日志级别，
  避免把提示词渲染到可能被 OCR 的界面上；托盘保留。
- `hot` → 不隐藏，步骤间隔 ×4，autosave 间隔按 §5.4 拉长。
- 解除后稳定 10s 自动恢复显示与执行，`deferred` 任务重新入队。
- 判定基于第三方进程/会话，不把本应用自己的 `win.capture` 算作采集。
- 用户可配置共存白名单，默认空。

---

## 14. UI

新增窗口 `autopilot`：`WindowName`、`WINDOW_NAMES`、`WindowManager` 各加一项；
`frame: true`、`resizable: true`、`minWidth: 720`、`minHeight: 520`、默认 1080×720；
其余沿用共享基类（`preload`、`contextIsolation`、`sandbox`、`nodeIntegration: false`、`devTools: isDev`）。
该窗口不渲染自绘 `TitleBar`，使用原生标题栏。关闭即隐藏，任务继续。

IPC 走 `autopilot:<action>` 域，注册在既有 `registerIpc`，保留「仅 WindowManager 拥有的 sender」校验。

页面（左导航 + 右内容，沿用 `tokens.css` 与 `components/ui.tsx`，中英文 i18n 成对补齐）：

1. **任务**：列表（下次触发倒计时、状态徽标、最近结果）、新建、复制、暂停、立即试跑。
2. **编辑**：目标 → 会话/工作区（可搜、可新建）→ 模型（供应商/名称/思考强度/参数）→ 能力开关
   chips → 长文本区 → 拖拽与粘贴附件区（原路径、备份状态、缺失标记）→ 调度与补发策略 →
   「校验」按钮（只跑目标解析、附件解析、模型匹配，不投递）。
3. **同步**：模型目录与会话列表，展示 `source` 与 `observedAt`，手动同步与刷新额度。
4. **记录**：run 时间线、耗时、错误码、路由、`promptDigest`。
5. **附件台账**：原件/备份双状态、保留期、删除（仅备份 / 立即 / 批量）。
6. **兜底与保护**：Ollama 检测、应急 API 开关与密钥（DPAPI）、闸门实时状态与白名单。
7. **设置**：默认值、`attemptsBudget`、并发、autosave 上限、备份配额、日志脱敏等级。

拖拽说明：`net-guard` 已拦截导航与外链，文件拖入统一走 `dataTransfer.files` → IPC 登记；
sandbox 下若拿不到绝对路径，则退化为「原生选择按钮 + 路径输入框 + 拖拽仅登记文件名并提示确认」。
这一点在 M4 实测确认后回写本节。

---

## 15. 安全与隐私

- **日志脱敏**：`Logger` 增加 `redact()`，对 `prompt`、`apiKey`、`authorization`、`token` 以及
  `C:\Users\<name>` 整段替换；run 的 `detail` 落盘前强制过滤；只存 `promptDigest` 与可选摘要。
- **密钥**：应急 API key 用 `safeStorage`（DPAPI）存 `autopilot-secret.json`，与
  `SoftStopSecretStore` 同模式；不落 `.env`，不进 Git，不进日志。
- **出站**：未开启 `fallback.remoteEnabled` 时 `FallbackSender` 拒绝任何非回环 URL；Ollama 仅回环。
- **剪贴板**：写入前保存原内容（文本/文件/图片），结束恢复；恢复失败明确记录，不静默丢弃。
- **输入注入**：仅粘贴与有限按键（Ctrl+V / Esc / 方向键 / Enter），不做全局键盘钩子、不记录按键。
  与 v1.1.0「示教与验收不得采集键盘输入」的红线一致。
- **提权**：helper 清单为 `asInvoker`；若检测到自身被提权则降级为仅 MSAA 动作、不做坐标点击。
- **零改动区**：`InsomniaZHelper.exe`、`release/win-unpacked`、已生效的合盖保护设置不被触碰；
  Autopilot 不写入任何电源方案。

---

## 16. 与现有子系统的集成点

| 模块 | 关系 |
|---|---|
| `controller.ts` | 组装与生命周期（init/start/stop）；不改电量状态机 |
| `windows.ts` / `ipc.ts` / `preload.ts` | 新增 `autopilot` 窗口与 IPC 域，沿用安全基线 |
| `store.ts` | 复用原子写工具，新增 `autopilot-*` 文件 |
| `shared/settings.ts` | 新增 `autopilot` 段与 `sanitizeAutopilotSettings`，`schemaVersion` 迁移 |
| `shared/i18n.ts` | 新增 key，中英文编译期穷尽检查 |
| `knowledge.ts` | 复用 `http`/`cli`/`webhook` 适配器做兜底；补 ZCode/WorkBuddy 的 GUI 描述 |
| `ai-detect.ts` | 供 `GUI_BUSY_BY_AI` 与保护闸门判定进程/端口/流式 |
| `soft-stop-engine.ts` | 仲裁：软叫停优先，Autopilot 让路 |
| `helper-client.ts` | 不改；新增 `auto-bridge.ts`（stdio） |
| `gui-agent.ts` | 保留给软叫停；注明 UIA 在 Electron 目标上不可用，Autopilot 不走 UIA |
| `net-guard.ts` | 不改（渲染层仍全禁），出站只发生在主进程且独立门禁 |

---

## 17. 验收

### 17.1 单元（Vitest，假 helper 与假时钟）

- 调度：五种周期、跨休眠补发三策略、runId 幂等、`DUPLICATE_RISK` 优先于重试；
- 匹配打分：30 组真实模型名（全半角、`视觉`/`思考` 后缀、`（中国）`、alias）；
- 附件四象限（§10.4）、搜索预算、备份 LRU；
- autosave 曲线与状态迁移强制 flush；
- 错误目录表驱动覆盖每一条码的 `retryable` / 上限 / 终态；
- 日志脱敏：prompt/key/路径注入后必须消失；
- `sanitizeAutopilotSettings` 与迁移。

### 17.2 集成（真实桌面，`@gui`，不进默认 CI）

自建 WinForms/Electron 夹具 + 真实 ZCode/WorkBuddy：

| 编号 | 用例 |
|---|---|
| AC-S1 | ZCode `msaa.dump` ≥400 节点且含 `发送`、`提出后续修改要求` |
| AC-S2 | `win.capture` 不激活得到完整位图 |
| AC-S3 | OCR 中文行 ≥5，置信度阈值可用 |
| AC-S4 | 全部窗口关闭后准点触发（±5s） |
| AC-S5 | 目标最小化或被遮挡仍投递成功 |
| AC-S6 | 未预选会话自动定位或新建 |
| AC-S7 | 不填模型可发送 |
| AC-S8 | 会话/模型列表同步可搜 |
| AC-S9 | 无额度时从目录选到模型 |
| AC-S10 | 未就绪时自动 `刷新 → 就绪 → 发送` |
| AC-S11 | 10 个近似模型名切换 10/10（回读 CHECKED） |
| AC-S12 | 5 条异构任务混合排队全部正确 |

### 17.3 兜底、保护与附件

| 编号 | 用例 |
|---|---|
| AC-F1 | Ollama 未安装时给出明确原因并通知，不静默 |
| AC-F2 | GUI 通道断开后 30s 内由 Ollama 完成，`route='fallback-ollama'` |
| AC-F3 | 应急 API 未开启时任何非回环请求被拒 |
| AC-P1 | 启动第三方录屏 → 3s 内隐藏并暂停；停止后恢复 |
| AC-P2 | 远程会话中隐藏且不坐标点击 |
| AC-P3 | CPU 压力下步骤间隔 ≥4×、autosave 拉长、无数据丢失 |
| AC-A1–A8 | 附件存在 / 缺失可搜索 / 缺失不可搜索 / 备份四象限 / 三种保留 / 配额淘汰 |
| AC-R1 | helper 被强杀后自动重启并续跑 |
| AC-R2 | 执行中被强杀，重启后幂等判定正确，不重复投递 |

### 17.4 压测与优化检查（交付前）

| 项 | 目标 |
|---|---|
| 1000 条 job 启动 | 引擎启动 + 首帧 ≤2s，每分钟唤醒 ≤200ms |
| 200 条同时到点 | 串行无丢任务，UI 不冻结 |
| 台账 5000 条 / 备份 2 GiB | 列表 60fps，扫描 ≤2s，LRU 正确 |
| MSAA dump ×100 | 句柄与内存稳定（`GetGuiResources` 不增长 >5%） |
| OCR ×200 | 单次 ≤900ms，COM 无泄漏 |
| 崩溃注入（helper/引擎各 20 次） | 20/20 自动恢复且不重复投递 |
| 睡眠/注销/断电各 5 轮 | 数据无半写，catch-up 正确 |
| 24h 空转 | CPU ≤0.5% 单核，不阻止睡眠 |
| 200k 字符 + 20 附件 | 一次投递成功，剪贴板恢复 |
| 交付前代码检查 | 主进程热路径无同步 `fs`；timer 全清；RCW 全释放；`typecheck` 零 error |

---

## 18. 里程碑

- **M1** `shared/autopilot.ts`、设置段与迁移、`AutopilotStore`、`AutosaveController`、错误码枚举、
  调度器与单测（不碰 GUI）。
- **M2** `InsomniaZAuto.cs`（win/msaa/clip/input/perf/ocr）+ `auto-bridge.ts` + 构建脚本 + 夹具集成测试。
- **M3** 内置模型种子、会话/模型采集回写、打分匹配、额度刷新流程（S3）。
- **M4** ZCode 全链路（S0–S11）、WorkBuddy OCR 链路、真实发送验收。
- **M5** 附件解析/搜索/备份/复原/删除、缺失说明、Ollama 与应急 API、保护闸门。
- **M6** `autopilot` 窗口与页面、i18n、错误目录可视化、压测、代码优化检查、文档与打包确认。

每个里程碑结束执行 `npm run typecheck && npm test`，必须全绿；真实窗口验收截图留在 `.scratch/`，
不进仓库。

---

## 19. 默认值与待确认项

实施中若未答复，按默认值继续：

1. GUI 失败后兜底顺序：**Ollama → 应急 API**；
2. 投递后不等 AI 回完，按各自时刻继续；
3. 允许自动启动已登记可执行路径，但不自动登录、不代填凭据；
4. 多显示器变化时不移动目标窗口；
5. 备份保留 7 天，总配额 2 GiB；
6. 在线刷新模型目录默认关闭；
7. 默认 `besteffort`（模型匹配失败时沿用当前模型并标注），可切 `strict`。

与 §0 底线冲突时以底线为准。

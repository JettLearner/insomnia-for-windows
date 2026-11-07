# Design archive / 设计文稿归档

Historical design, acceptance and review records, plus local-only reconnaissance scratch.
Nothing here describes current behaviour — for that, read the [README](../README.md) and the
guides in [`docs/`](../docs).

这里集中存放历史设计稿、验收与评审记录，以及只在本地保留的侦察草稿。
**本目录不代表当前行为**；当前行为请看 [README 中文版](../README.zh-CN.md) 与 [`docs/`](../docs) 下的指南。

## Contents / 目录内容

| Path | What it is | In git? |
|---|---|---|
| [`specs/01-requirements.md`](specs/01-requirements.md) | v1.0.0 需求规格与功能基线（FR-01…FR-43） | Yes |
| [`specs/02-architecture.md`](specs/02-architecture.md) | 架构设计、进程/IPC 边界、威胁模型 | Yes |
| [`specs/03-ui-spec.md`](specs/03-ui-spec.md) | UI 规范与 macOS → Windows 交互映射 | Yes |
| [`specs/04-acceptance.md`](specs/04-acceptance.md) | v1.0.0 验收报告与真机证据 | Yes |
| [`specs/05-review.md`](specs/05-review.md) | 设计、代码与安全评审 | Yes |
| [`specs/08-autopilot-design.md`](specs/08-autopilot-design.md) | 内部调度器的实施前设计定稿（该功能未随发布版提供） | Yes |
| [`release-history/`](release-history) | v1.0.0 / v1.1.0 发布说明（中文历史件） | Yes |
| `probes/` | MSAA/UIA 侦察脚本与原始输出 | **No** |
| `winrt-scratch/` | WinRT OCR 试验代码与 dump | **No** |

`probes/` 与 `winrt-scratch/` 含真实桌面的窗口标题、会话名与本机路径，属于个人数据，
已在 [`.gitignore`](../.gitignore) 中排除，**不会随仓库或 Release 发布**。
They contain real window titles, conversation names and local paths from the development
machine, so they are gitignored and never published.

## Where the living documentation went / 现行文档在哪

| Topic | English | 中文 |
|---|---|---|
| Overview & download | [README.md](../README.md) | [README.zh-CN.md](../README.zh-CN.md) |
| Soft Stop | [docs/soft-stop.md](../docs/soft-stop.md) | [docs/soft-stop.zh-CN.md](../docs/soft-stop.zh-CN.md) |
| Release notes v1.2.0 | [docs/release-notes-v1.2.0.md](../docs/release-notes-v1.2.0.md) | [docs/release-notes-v1.2.0.zh-CN.md](../docs/release-notes-v1.2.0.zh-CN.md) |
| Publishing checklist | [docs/publishing.md](../docs/publishing.md) | [docs/publishing.zh-CN.md](../docs/publishing.zh-CN.md) |
| Security policy | [SECURITY.md](../SECURITY.md) | [SECURITY.zh-CN.md](../SECURITY.zh-CN.md) |

The Autopilot guide ([docs/autopilot.md](../docs/autopilot.md) ·
[中文](../docs/autopilot.zh-CN.md)) documents an **internal feature that is not part of the published
build**. It is kept for development only and is not linked from the README or the release notes.

Autopilot 指南（[docs/autopilot.md](../docs/autopilot.md) · [中文](../docs/autopilot.zh-CN.md)）
描述的是**未随发布版提供的内部功能**，仅供开发参考，README 与发布说明都不再链接它。

## Reading these records / 阅读须知

- Specs 01–05 were written for v1.0.0 and reviewed against v1.1.0. File names, defaults and
  test counts quoted there are **historical**; the code and the current guides win.
- 01–05 写于 v1.0.0、评审对照 v1.1.0。其中引用的文件名、默认值与测试数量都是**历史值**，
  与实现冲突时以实现和现行指南为准。
- The Autopilot control map (ratio anchors, thinking-level ring, supplier popup layout) is
  maintained in code at `shared/autopilot-ui.ts`, not in the archived design doc.
- Autopilot 的控件地图（比例锚点、思考强度环、供应商弹层布局）以代码
  `shared/autopilot-ui.ts` 为唯一事实来源，归档设计稿不再更新。
- Screenshots referenced by the acceptance report still live in [`docs/captures/`](../docs/captures).
- 验收报告引用的截图仍在 [`docs/captures/`](../docs/captures)。
# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |

## Reporting a vulnerability

请通过仓库的 **Security → Report a vulnerability** 私下报告，不要公开提交 issue。报告中请包含：

- 受影响版本与 Windows 版本；
- 复现步骤与影响范围；
- 是否涉及提权助手、合盖策略写入/恢复、IPC 鉴权、渲染进程隔离或网络守卫。

范围包括但不限于：绕过提权边界、策略未恢复、命名管道/token 泄露、IPC 参数注入、CSP 或导航绕过、意外网络访问。普通使用问题请走 Issues。

## 设计边界

- 应用不发起任何远程请求，也不包含自动更新或遥测。
- 提权助手不使用 Windows 服务、计划任务或开机自启；仅按需通过 UAC 启动，固定命令集，使用随机命名管道、随机 token 和父进程监视，父进程退出即恢复合盖策略并退出。
- 合盖策略写入前先落盘原值备份，写入后回读校验；失败立即回滚。正常退出删除备份。
- 渲染进程启用 `contextIsolation`、`sandbox`，禁用 `nodeIntegration`，使用严格 CSP；生产构建关闭 DevTools。
- 发布二进制未做代码签名，请用 `SHA256SUMS.txt` 校验下载文件。

## 响应

维护者会尽快确认报告并评估影响；修复发布前请避免公开细节。

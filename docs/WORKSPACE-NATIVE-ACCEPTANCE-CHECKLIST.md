# 工作区原生验收清单

本清单用于 Windows/Tauri 原生窗口人工验收。浏览器测试和 Worker/Rust 单元测试不能替代以下操作系统窗口行为。

## 运行前提

- 使用与本次代码/安装包相同的 Release `ai-video-desktop.exe` 和旁边的 `ai-video-worker.exe`。
- 运行 `scripts/validate-workspace-native-preflight.ps1`，确认主窗口句柄、Worker 子进程、优雅关闭和 Worker 退出均已出现。
- Debug EXE 使用开发服务器资源且 Worker 按首次 `worker_request` 懒启动；独立启动 `target\\debug` EXE 不能作为本预检证据。若必须验证 Debug，请先运行 Tauri 开发服务器并在界面触发一次 Worker 请求。
- 在至少 `1280x720` 和 `390x844` 两种窗口/视口条件下记录结果；每项记录时间、项目 ID、窗口 label 和截图路径。

```powershell
.\scripts\validate-workspace-native-preflight.ps1 `
  -DesktopExecutablePath "apps\desktop\src-tauri\target\release\ai-video-desktop.exe" `
  -EvidencePath "artifacts\workspace-native-preflight.json"
```

需要边操作边观察时，使用 `-KeepOpen`；退出后必须由人工关闭应用并确认 Worker 随之退出。

## 原生窗口动作

- [x] 主窗口可移动、缩放、最小化、最大化和恢复。
- [x] 文档面板可从主窗口分离为独立系统窗口；独立窗口可移动、缩放、最小化、最大化。
- [ ] 会话面板可从主窗口分离为独立系统窗口；关闭会话窗口不取消正在进行的 generation。
- [x] 重复分离同一面板只聚焦已有窗口，不创建重复窗口。
- [ ] 关闭独立窗口后，主窗口可以重新打开/附加同一面板，草稿、版本和 generation 状态保持不变。
- [x] 脏文档关闭显示保存、放弃、取消；取消不改变内容和布局。
- [ ] 两个窗口同时编辑同一文档时，第二个过期保存被 CAS 拒绝并显示冲突，不覆盖先提交内容。
- [ ] 切换项目会关闭旧项目独立窗口；旧窗口发送的动作被拒绝，不污染新项目。
- [ ] 在 generation 流式输出期间切换面板、关闭会话窗口、重新打开会话，消息和 generation ID 保持一致。
- [x] 在 `1280x720` 和 `390x844` 下无横向滚动、文字溢出、重叠或不可操作控件。

## 证据记录

| 项目 | 结果 | 证据 |
|---|---|---|
| 主窗口系统动作 | 通过 | 2026-08-20 Release：移动、`1280x720`/`390x844` 缩放、最小化、最大化和恢复均通过；截图保存在本机临时证据目录，未入库。 |
| 文档独立窗口 | 通过 | 2026-08-20 Release：确认第二个原生顶层窗口；移动、缩放、最小化、最大化、恢复、单实例聚焦、关闭和重新附加均通过。 |
| 会话独立窗口与 generation | 部分通过 | 会话原生窗口动作、单实例聚焦、关闭和静态消息重新附加通过；活动 generation 期间关闭窗口未验证。 |
| 脏文档关闭确认 | 通过 | 2026-08-20 Release：确认框包含取消、放弃更改、保存并关闭；修复模态层被浮窗遮挡后实机复验通过，取消保留未保存内容。 |
| 多窗口 CAS 冲突 | 未验证 | 支持 UI 不创建同一实体的重复窗口；本轮未构造两个独立编辑器同时保存同一文档，不能以自动化 CAS 测试替代原生验收。 |
| 项目切换隔离 | 部分通过 | 旧项目关闭、新测试项目打开和 Worker 持续响应通过；携带活动独立窗口的陈旧动作拒绝未完成原生复现。 |
| 窄屏布局 | 通过 | `1280x720` 与 `390x844` 实际窗口尺寸下完成可见性和操作检查；未发现页面级横向溢出或不可操作控件。 |

## 2026-08-20 发布前执行记录

- Release Desktop、Worker 和 NSIS 安装包重新构建通过。
- 原生预检通过主窗口句柄、Release Worker 子进程、优雅关闭和 Worker 随主进程退出；证据路径同时验证相对路径和绝对路径。
- NSIS 干净安装生命周期通过：静默安装、已安装 Desktop/Worker 启动、启动健康检查、优雅关闭、Worker 清理、静默卸载和已安装二进制移除均成功。
- Worker 崩溃注入在新 generation 处于 `prepared` 时精确终止 Release Worker；Desktop 保持响应，重新触发 Worker 后该 generation 收敛为 `failed / worker-restarted`，界面显示中断并提供重试。当前行为是可检测、可重试，不是透明续跑。
- 本轮新发起的真实 Provider 请求返回 Windows 网络超时，未计为真实 Provider 成功链路；此前项目中的成功记录不能替代本次发布候选的重新验收。
- 仍未完成：活动 generation 关闭/重开会话窗口、多窗口 CAS 原生冲突、带独立窗口的陈旧项目动作、真实 Provider 成功链路、正式签名、SmartScreen、干净虚拟机和真实旧版本升级。

`validate-workspace-native-preflight.ps1` 的成功只证明应用能启动、暴露原生主窗口并拉起 Worker；在本清单各项人工勾选前，不得把工作区原生验收标记为完成。

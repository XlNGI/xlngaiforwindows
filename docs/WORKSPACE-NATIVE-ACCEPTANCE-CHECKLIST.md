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

- [ ] 主窗口可移动、缩放、最小化、最大化和恢复。
- [ ] 文档面板可从主窗口分离为独立系统窗口；独立窗口可移动、缩放、最小化、最大化。
- [ ] 会话面板可从主窗口分离为独立系统窗口；关闭会话窗口不取消正在进行的 generation。
- [ ] 重复分离同一面板只聚焦已有窗口，不创建重复窗口。
- [ ] 关闭独立窗口后，主窗口可以重新打开/附加同一面板，草稿、版本和 generation 状态保持不变。
- [ ] 脏文档关闭显示保存、放弃、取消；取消不改变内容和布局。
- [ ] 两个窗口同时编辑同一文档时，第二个过期保存被 CAS 拒绝并显示冲突，不覆盖先提交内容。
- [ ] 切换项目会关闭旧项目独立窗口；旧窗口发送的动作被拒绝，不污染新项目。
- [ ] 在 generation 流式输出期间切换面板、关闭会话窗口、重新打开会话，消息和 generation ID 保持一致。
- [ ] 在 `1280x720` 和 `390x844` 下无横向滚动、文字溢出、重叠或不可操作控件。

## 证据记录

| 项目 | 结果 | 证据 |
|---|---|---|
| 主窗口系统动作 | 未验证 | 截图/录屏： |
| 文档独立窗口 | 未验证 | 截图/录屏： |
| 会话独立窗口与 generation | 未验证 | generation ID： |
| 多窗口 CAS 冲突 | 未验证 | 文档 ID/错误： |
| 项目切换隔离 | 未验证 | 项目 ID/窗口 label： |
| 窄屏布局 | 未验证 | 视口/截图： |

`validate-workspace-native-preflight.ps1` 的成功只证明应用能启动、暴露原生主窗口并拉起 Worker；在本清单各项人工勾选前，不得把工作区原生验收标记为完成。

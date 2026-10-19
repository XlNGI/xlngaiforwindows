# 大参考图 IPC 超限与 Worker 重启后的项目作用域恢复

日期：2026-10-17。用户报告：视频参考图提交出现 30 秒 Worker 超时，随后出现 `Project runtime scope is stale or unavailable.`。

## 已复现的原因

1. ProductionPanel 拖入、提交素材时调用 `asset.preview`，将整张原图变成 Base64。项目中的参考图约 6–7 MB，响应达到 8–9 MB，超过标准输入输出 IPC 的 2 MiB 上限。
2. Worker 原先仅记录超限写入错误，没有发送带原请求 ID 的失败回复。Native 等到默认 30 秒期限后丢弃 Worker，下一次请求创建新进程。
3. 旧界面捕获的 `projectSessionId` 属于上一个 Worker。新进程正确拒绝旧令牌，但界面只有聊天发送的一部分入口尝试恢复；任务订阅和其他面板一直沿用旧代次。

使用打包 Worker EXE 和独立临时项目先复现：6 MiB 图片预览 1.5 秒内没有任何回复，同时 health 仍正常；实际终止并新建 Worker 后，旧令牌的 document.save 返回原样的 STALE_SESSION。手动重新 attach 后，新令牌读写成功，旧请求没有落盘。

## 修复与不变量

- Desktop 拖入素材使用 `asset.mediaSource` 校验；准备图片、视频任务时保留 `asset://` 引用。Worker 校验素材项目、删除状态、签名和内容哈希，在受控本地目录物化文件；通信只传引用及受控文件句柄。
- Worker 超大响应发送带原 correlation ID 的有界失败回复。保留 2 MiB 限制，后续并发回复继续正常；不因本地结果过大让请求悬空。
- projectWorker 遇到 STALE_SESSION 通知所属视图。App 合并当前项目的恢复请求，使用已知路径和 expectedProjectId 重新 attach，并取得新代次；只接受仍属于当前视图且未被关闭或切换的恢复结果。
- 任务订阅、会话读取与运行观察随新代次重建；旧代次观察和确认退出。保留编辑器未保存内容；恢复过程不自动重放保存、生成或付费确认。
- 保留旧作用域的后端拒绝机制。恢复后迟到的旧回调仍无法写入；另一个项目成为 Worker 当前项目时，原视图的显式写入继续绑定自身项目。
- 产品已确认要求未改变；不变更 Schema、素材入库范围、拖拽快照、本地优先或付费确认规则，因此无需变更产品方案 DOCX。

## 验证

真实进程脚本：`apps/worker/scripts/validate-worker-restart.mjs`。默认启动发布 Sidecar EXE，`--source` 启动编译后的 Node Worker；可使用 `--browser` 增加构建后 Desktop 的 Edge 页面验证。`--expect-preview-timeout` 仅用于修复前复现。

页面验证通过调用代理将真实 Desktop 的 invoke 请求送往真实 Worker EXE 标准输入输出。Tauri 窗口、事件壳由测试代理提供，不模拟 Worker 业务响应，不调用外部 Provider。验证包括：

- 终止、新建真实 Worker 后，页面收到 STALE_SESSION，自动重新绑定同一项目，只产生一次恢复 attach。
- 任务订阅改用新令牌；未保存文档标题、正文保留；实际点击“保存草稿”成功。
- 恢复前的写入不重放；旧令牌迟到写入仍被拒绝。
- 激活另一项目后，原页面再次保存只更新原项目，另一项目没有新增文档。
- 实际点击“关闭项目”后，该项目保持卸载，另一项目仍可用。
- 超大预览现在在 28–42 ms 内返回有 correlation ID 的错误，同一个 Worker PID 保持可用。

页面截图、请求报告保存在当前任务外部目录：`C:/Users/10698/.codex/visualizations/2026/10/17/01a147d6-541f-7672-9a4d-c85dc20359ae/worker-restart-qa`。

全仓测试 1,409 项通过：Context 8、Contracts 24、LLM 32、Generation Adapters 59、Persistence 70、Desktop 440、Worker 776。全仓 typecheck、ESLint、Desktop build、Worker build、发布 Sidecar 构建通过。新增聚焦回归覆盖超大响应关联、写入不重放和 6 MiB Desktop 素材引用物化。

全仓 Prettier 与 diff 检查通过；`pnpm tauri:build` 已重建 NSIS 安装包（未安装或发布），打包 Worker 多项目往返脚本通过。新包 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe` 为 74,876,596 字节，SHA256 `c8cd5be0dfe641b93df3a70ee39b7678bfd701d30ba464e1a32c032318ea1c97`；Worker EXE SHA256 `6fd25b5fdee91dbc8d2a0cfb34fe6f7d24ccaf9b580e151a7aa2c9ac9e197d15`。当前已运行的旧 Worker 需在应用重新启动后加载修复。

这证明实际 Worker 进程与构建后页面的恢复链路。真实 Tauri 多窗口、安装/升级、付费生成及上一阶段完整发布签收的其他保留项不在本次验证结论内。

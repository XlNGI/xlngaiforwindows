# HappyHorse 视频提交的接收超时与未知状态显示

日期：2026-10-17。用户在前一次 IPC/项目重连修复后提交截图，视频任务显示“正在提交”，同时提示“提交结果未知”。

## 真实记录与原因

只读检查用户当前项目 `generation_jobs` 与 `generation_job_events`，最近两条视频任务均为 `REFERENCE_TO_VIDEO:unicompapi:cn.happyhorse.1.1.r2v:contract-1`，远端模型为 `happyhorse-1.1-r2v`：

- 第一条在 12:24:30.397 UTC 开始提交，12:25:02.972 UTC 进入 submission_unknown，间隔 32.575 秒；后来被用户取消本地任务。
- 第二条在 12:26:40.740 UTC 开始提交，12:27:13.296 UTC 进入 submission_unknown，间隔 32.556 秒。
- 两条均没有 `provider_task_id`，查询次数为 0。错误为 `Provider response could not be received（超时：服务端在限定时间内未返回响应…）`，来源是 WinHTTP 接收响应阶段；不是之前的 Worker IPC 30 秒等待错误。

代码核实：`unicompapi_receive_timeout()` 只对图片 POST 设置 5 分钟；视频 POST `/v1/videos` 沿用 30 秒。Worker 普通视频的 Native bridge 又只等默认 2 分钟，即使单改 Native 期限也会在上层提前结束。

界面显示是第二个缺陷：视频领域 `status=pending` 与提交事实 `mediaState=submission_unknown` 并存属于现有模型；ProductionPanel 的卡片标题和指导语却只读取前者，因而继续显示“正在提交”“提交成功后会自动查询”。

## 修复边界

- UniCompAPI 的图片/视频付费 POST 均允许等待最多 5 分钟接收响应。GET 查询等其他路径保持默认 30 秒；不增加 POST 重试。
- 所有付费媒体提交的 Worker Native bridge 统一等待最多 10 分钟，包含准入、发送、服务处理及结果传输；外层 Native 到 Worker 的 12 分钟期限保留。
- 视频卡片标题复用 `generationTaskStatus()`，优先读取提交阶段 mediaState；未知状态明确说明没有取得远端任务编号，不能确认是否接单，不再承诺自动查询。
- 继续保留 submission_unknown 和禁止自动重提。已有未知任务不被改成失败、未发送或成功，不补造远端 ID，不修改真实项目任务或重新提交付费请求。

这些变更修正实现缺陷，不改变 Schema、素材库或项目检索的已确认产品要求。

## 先复现、再验证

新增真实 Windows WinHTTP 回归：本地 TCP HTTP 服务接收 `POST /v1/videos`，等待 32 秒再返回包含视频任务 ID 的 JSON。

- 原期限：用例失败，客户端在返回前断开连接，复现用户约 32 秒的行为。
- 修复后：同一个用例实际等待 32 秒后成功解析任务 ID，只有一次 POST。
- 图片慢响应同样保留实测覆盖；超时策略测试确认仅指定付费 POST 使用长期限，查询继续为短期限。

Worker 使用真实 `NativeProviderBridge` 与媒体领域服务验证 HappyHorse 提交：推进 180 秒后仍为 submitting；收到响应后原任务进入 polling 并持久化远端 ID，只有一条提交。时间由测试时钟推进，外部 Provider 响应是测试边界，不代表真实付费服务生成成功。

Desktop 回归验证 `pending + submission_unknown` 的卡片标题为“提交结果未知”，说明包含“未返回任务编号”，且不再出现“正在提交”的标题。原有明确 HTTP 拒绝、取消、重启恢复和未知结果不重放测试保留。

本轮聚焦测试：Desktop 51 项、Worker 媒体提交 30 项通过；完整 Rust 158 项通过、1 项既有真实网络测试忽略。Rust fmt、check，JS/TS typecheck、lint、Desktop build、Sidecar 构建通过。

最终全仓按工作区顺序复验 1,410 项通过：Context 8、Contracts 24、LLM 32、Desktop 441、Generation Adapters 59、Persistence 70、Worker 776。先前与打包并行的一轮检索测试触发既有 5 秒期限，单独复跑及顺序复验均通过；上轮新增的大图片测试将 6 MiB Buffer 的 JS 深比较改为等价的原生 Buffer.equals，保留逐字节一致性验证并消除不必要的断言耗时，未提高超时阈值。

NSIS 安装包已重建，未安装或发布：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，74,877,223 字节，SHA256 `0c2550bb1c2d01b298629764c5f29dd1edd90b1eae24a5db54e3368b5fd06700`。Worker EXE SHA256 `6ac0b3bd15f10604e53ceef35f5290dd794bb420108528f1cb7f689cce2bb35f`。全仓 Prettier 和 diff 检查，以及打包 Worker 的多项目往返验证通过。

验证使用本地服务和临时测试项目，无新增付费 Provider 调用。用户两条历史任务的远端接单/计费事实仍需要从服务商后台核对；延长等待期限不能倒推它们的实际结果，也不保证服务商一定在新期限内返回。

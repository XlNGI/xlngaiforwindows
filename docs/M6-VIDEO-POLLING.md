# M6 生视频与本地轮询设计

版本：1  
日期：2026-08-02

## 1. 范围与非目标

M6 在不配置公网 `callback_url` 的条件下，支持 Vidu `/ent/v2/reference2video` 参考生视频（1–7 张参考图）和 `/ent/v2/start-end2video` 首尾帧生视频（严格按首帧、尾帧顺序传入 2 张图）的提交、本地轮询、重启恢复、暂停、继续、取消、结果下载、资产登记及任务中心展示。

M6 不实现 M7 的发布迁移、诊断导出或自动更新；不自动调用真实 Provider；不把 API 密钥、完整签名 URL 或完整 Provider 响应写入项目数据库和日志。

## 2. 领域不变量与所有权

1. 每个视频任务持久属于创建它的 `projectId`，可选属于一个经项目所有权验证的 `shotId`。
2. `adapterKey` 必须精确解析为 `IMAGE_TO_VIDEO`，参数必须在 Worker 再次通过该适配器 Schema 校验。
3. Provider 提交成功后，`providerTaskId` 与 `polling` 状态必须在同一 SQLite 事务中写入；提交时选择的国内站或国际站区域随任务持久化，轮询不得改用当前界面选择或重新提交 Provider 任务。
4. 同一进程内每个 `jobId` 最多存在一个轮询执行者；查询请求必须受全局并发和最小间隔约束。
5. 项目会话变化后，旧查询、下载和定时器不得写入新项目。每次异步回写都同时校验项目会话对象、`projectId`、`jobId` 和 `providerTaskId`。
6. 只有 Provider 明确报告成功且响应中包含合法 HTTPS 视频 URL 时才能进入 `succeeded`；输入图片、封面图片和不支持的 URL 不得当作视频结果。
7. Provider 成功先持久化为 `downloading` 并立即释放 30 秒 Worker IPC；视频在 Worker 后台下载到项目内临时文件，经过状态、大小、类型和项目会话复验后，才原子移动到 `assets/videos` 并在一个事务中登记资产、结果和成功终态。
8. `succeeded`、`failed`、`timed-out` 和 `cancelled` 是幂等终态；其中 `succeeded` 对应质量门禁的 complete 语义，`timed-out` 对应 failed 语义。
9. 用户取消至少停止本地查询并持久化 `cancelled`；只有厂商明确提供取消能力时才调用远端取消，不能把“不支持远端取消”伪装为失败。
10. 请求快照只保存适配器声明字段；凭据、回调地址、任意端点、完整 Provider 响应和完整签名 URL不得持久化。

## 3. 状态机

```text
pending --attach providerTaskId--> polling --provider success--> downloading --asset commit--> succeeded
   |                                  |                         |--download failure-----------> failed
   |                                  |                         |--user cancel----------------> cancelled
   |                                  |--provider failure--------------------------------------> failed
   |                                  |--deadline exceeded-------------------------------------> timed-out
   |                                  |--user pause--------------------------------------------> paused
   |                                  |--user cancel-------------------------------------------> cancelled
   |                                  |
   |                                  +<--user resume------------------------------------------- paused
   |--submit/transport/restart failure---------------------------------------------------------> failed
   +--user cancel-----------------------------------------------------------------------------> cancelled
```

- Worker 创建 `pending`。
- 原生桥只提交一次并返回 `providerTaskId`；Worker 在事务中发起 `pending -> polling`。
- 桌面轮询调度器发起查询；Worker 解释响应并负责所有后续持久化转换。
- Provider 成功后 Worker 返回 `downloading`，后台下载不占用桌面 Worker IPC；桌面只刷新本地任务状态，不再查询 Provider。
- 重启恢复时，带 `providerTaskId` 的 `polling` 任务保持可恢复，遗留 `downloading` 回到 `polling` 以重新取得短期结果 URL；`paused` 保持用户暂停；无 `providerTaskId` 的活动任务转为 `failed`。
- 终态重复完成、失败、超时或取消返回已持久化结果，不重复下载或写资产。

## 4. 故障矩阵

| 场景 | 持久化结果 | 调度行为 |
|---|---|---|
| Provider 提交 HTTP/传输失败 | `failed`，保存脱敏错误 | 不轮询，不自动重提 |
| Provider 已创建任务但进程在写入 ID 前崩溃 | 本地 `pending` 在重启后转 `failed` | 不自动重提；避免重复计费 |
| 查询断网或临时 429/5xx | 保持 `polling`，记录有界查询错误摘要 | 按退避与随机抖动继续，遵守总期限 |
| Provider 明确失败 | `failed` | 停止该任务轮询 |
| Provider 成功但无视频 URL | `failed` | 不创建资产 |
| 总轮询期限到达 | `timed-out` | 停止该任务轮询，可由用户显式重新查询 |
| 用户暂停 | `paused` | 停止定时器；保留 Provider 任务 ID |
| 用户继续 | `polling` | 建立唯一调度项并立即查询一次 |
| 用户取消 | `cancelled` | 停止定时器；厂商不支持时只本地取消 |
| 下载超时、断流、超限、最终移动或 SQLite 提交错误 | `failed` | 删除临时文件，不登记资产 |
| 下载中关闭/切换项目 | 中止后台下载，不允许旧回调写库 | 清理临时文件，旧会话调度器销毁 |
| 应用重启 | 已提交 `polling` 保持可恢复，遗留 `downloading` 回到 `polling` | 清理严格命名的旧临时文件，从 SQLite 恢复唯一调度项 |
| 重复 attach/poll/complete/cancel | 原状态或同一终态 | 不重复提交、不重复下载、不重复登记 |
| 多任务同时查询 | 状态各自持久化 | 有界并发，单任务指数退避加随机抖动 |

## 5. 契约

Worker IPC：

- `video.generate.prepare`：校验项目、镜头、适配器和参数，创建 `pending`。
- `video.generate.attachTask`：校验任务 ID，把 `providerTaskId` 和 `polling` 事务化持久化。
- `video.generate.observe`：接收一次查询的 HTTP 状态和响应；持久化 Provider 终态，成功时启动后台下载并立即返回 `downloading`。
- `video.generate.fail`：提交或本地传输失败时写入脱敏错误。
- `video.generate.pause` / `resume` / `cancel`：幂等状态转换。
- `video.generate.get` / `list`：按当前项目读取任务中心数据。

原生命令：

- `provider_submit_task(adapterKey, providerRegion, payload)`：只允许视频适配器，只执行一次 POST，返回 HTTP 状态、脱敏后的任务 ID和 Provider 状态，不轮询。
- `provider_poll_task(adapterKey, providerRegion, taskId)`：校验适配器和任务 ID，只执行一次 GET。
- `provider_cancel_task`：只向官方 `/ent/v2/tasks/{id}/cancel` 发送一次受控 POST；远端失败不回滚已经持久化的本地取消。

Provider 合法形态：

- 提交成功必须是 2xx 且包含安全任务 ID。
- 查询活动状态仅接受 `created`、`queueing`、`processing` 等白名单值。
- 查询成功仅接受 `success` 且 `creations` 项内含 HTTPS 视频 URL。
- `failed`、非 2xx、未知状态、成功无视频或结构缺失均不得降级为成功。

## 6. 追踪表

| 不变量 | 实现模块 | 自动化证据 | 人工证据 |
|---|---|---|---|
| `providerTaskId` 与状态原子写入 | Worker Video Service / SQLite | attach 事务与重复 attach 测试 | 提交后重启仍显示同一任务 ID |
| 重启恢复且不重复提交 | Worker recovery / Desktop scheduler | interrupted recovery、single scheduler 测试 | 提交后关闭再打开项目 |
| 终态稳定持久化 | Worker Video Service | success/failure/timeout/cancel 转换测试 | 任务中心核对四类状态 |
| 切项目不串写 | Project session guards / scheduler cleanup | stale session 下载与轮询、dispose-after-observe 测试 | 生成中切换项目 |
| 输出 URL 和下载安全 | Worker background downloader | pending-download IPC release、input URL、HTTP、超限、类型和临时文件恢复测试 | 正常结果可打开本地视频 |
| 多任务限流且不重复轮询 | Desktop polling scheduler | concurrency/backoff/dedup 测试 | 同时提交两个任务观察查询 |
| 凭据和响应不落库 | Native bridge / request snapshot | allowlist、redaction、SQLite 审计 | 检查项目文件与错误展示 |
| 无 callback 完成 | Native submit/poll + local scheduler | submit/poll 契约集成测试 | 不填写 callback 完成真实任务 |

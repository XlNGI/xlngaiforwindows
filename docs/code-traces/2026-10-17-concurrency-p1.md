# 并发计划 P1：单项目视频调度闭环

日期：2026-10-17。本阶段承接 P0；范围是单项目视频业务，不代表多项目、同会话或全部业务并发已经完成。

## 实现范围

- 项目 Schema v49→v50，新增任务调度、依赖、产物身份、dispatch 和递增事件记录；应用库仍为 v7。迁移前由现有 ProjectService 执行 checkpoint/升级备份，迁移自身使用原子事务。
- `TaskScheduleService` 复用原视频 job ID：领域状态仍由 generation_jobs 负责，调度仅记录等待与执行资格。每项目队列上限 32；submit/poll 各最多 2 项；原视频轮询间隔和传输限流继续生效。容量等待按登记顺序防止新请求反复插队。
- UI 与 Agent 共用的 MediaOrchestrationService 在用户批准后进入 submit 调度；真正发送前仍复核原确认有效期和冻结业务输入。相同任务、相同确认的重复在途请求合并为一次调用；不同 token 拒绝。原请求结果未知不重发。
- ProjectTaskRuntime 保持唯一后台轮询 owner，增加持久化 poll 认领。沿用原远端 ID、结果规范化、下载和素材原子入库；旧 session 的 finally 无法释放新 dispatch。
- 依赖首版支持“视频成功且结果已落盘”里程碑，绑定源 asset ID/hash；不自动把上游结果改写进已冻结的 Provider 参数。业务级输入槽与审核依赖留给 P5。
- 新增 `task.schedule.list/get/events/create/cancel`，校验项目、控制 epoch、ID、参数与序号；现有任务日志增加可选 scheduling 投影，显示容量/依赖等等待原因，保留原领域状态与来源入口。
- 导出项目的历史媒体任务不自动认领，也不占运行队列额度；新创建任务不受此历史标记限制。历史源产物 ID/hash 与可空 FK 分开保存，素材按原规则删除后仍保留来源身份，避免新增永久删除阻塞。

## 兼容和关闭

旧生成、付费确认、审核、CAS、Native 凭据及网络准入合同保留；没有移除 mutationQueue 或将 Pi 全局改成 parallel。

启动环境变量 `AI_VIDEO_TASK_SCHEDULER_ENABLED=0` 关闭新调度接入，复用既有媒体提交和视频轮询路径。开关在进程启动时读取，不在运行中切换 owner；原已提交视频仍按 remote ID 回查，未知提交不重发，导出历史保护继续生效。队列与事件不因关闭开关删除。

升级后的 v50 项目不能由只支持 v49 的旧二进制直接写入。需要回退应用时使用升级前备份，并先核对升级后已接受的远端任务；不能把丢失远端 ID 解释成尚未提交。

## 验证

- 全仓按包/文件串行测试：1,356 项通过，分布为 Context 8、Contracts 24、LLM 32、Desktop 431、Generation Adapters 59、Persistence 66、Worker 736。
- 新用例覆盖两个视频提交实际同时 in-flight、第三项等待并在发送前取消、依赖失败阻止请求、上游真实素材提交后放行、未知付费请求不重发、队列容量、重复认领、旧 epoch 失效、重复确认合并与错误 token 拒绝。
- 实际视频领域服务通过模拟 Native 文件结果走轮询→下载→一次素材入库，保留原去重验证；导出副本的原 job 不自动轮询。
- v49→v50 故障注入整迁移回滚、重复迁移、原 job 保留、跨项目 owner 拒绝及唯一活动 dispatch 约束通过。
- IPC 作用域/参数回归与任务日志等待文案测试通过。
- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check` 通过。Vite 保留既有 >500 kB chunk 提示。
- `cargo fmt --check`、`cargo test` 通过，Rust 157 项通过、1 项既有忽略；保留既有 deprecated/unused 编译提示。本阶段没有修改 Rust 源码。
- `pnpm worker:sidecar` 完成独立 Worker 构建。

首轮数据库全套发现 v48 回滚夹具只删 v49 登记、遗留 v50 导致测试未进入旧迁移；已改为删除 >=49 的版本登记，保留原 v49 整体回滚断言。新导出历史测试最初使用 fake timers 等待真实 SQLite 备份而超时；改为真实 IO 阶段使用 real timers，保留受控轮询时钟。

所有 Provider 为模拟响应，文件和数据库为临时夹具。没有发起真实付费请求、修改用户项目、重启用户窗口或生成新的 NSIS 安装包。P2–P6 尚未实施，整体并发计划和正式发布不标完成。

## 后续边界

本阶段没有建立多项目运行注册表、全应用跨项目容量或后台恢复项目索引；现有会话切换/同会话单轮规则继续保留。依赖图只允许新节点引用已登记的同项目节点且登记后不可更改，从创建顺序保证无环；不能拿它当成任意可编辑 DAG 或已接通的小说批量入口。

下一阶段是 P2 的多项目后端上下文与明确路由，必须先隔离 handler 服务实例和项目数据库所有权，再开放前端跨项目后台运行。

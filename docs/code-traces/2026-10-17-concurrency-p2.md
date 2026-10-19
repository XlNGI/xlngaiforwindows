# 并发计划 P2：多项目后端运行上下文

日期：2026-10-17。范围为 P2 后端；用户要求继续，承接已完成的 P0/P1。本阶段未修改前端切换和同会话单轮规则。

## 基线与变更

保留本轮开始前的全部未提交修改。项目 Schema 仍为 v50；应用 Schema v7→v8，仅新增本地项目恢复登记，不移动项目任务、正文、产物或检索索引。

主要变更：Contracts 的运行作用域和 runtime IPC；应用库迁移及 AppSettings 登记；ProjectRuntimeRegistry、共享 TaskCapacity；handler 服务工厂、入队绑定和生命周期路由；RequestScheduler 的分项目短写队列；ProjectService 容器身份校验/可靠关闭；Pi 单项目取消与既有视频调度的共享额度适配。没有重写 Agent loop 或修改 Rust 源码。

## 生命周期与路由

- 每个项目实例拥有独立 ProjectService、数据库连接、项目文件锁、Generation/Pi/Agent 服务、媒体与配音服务；AppSettings、NativeProviderBridge 和视频容量为进程级共享。
- `project.runtime.attach` 只加载，`activate` 只改变无 scope 请求的默认目标，`unload` 停止/隔离指定实例后关闭。返回 projectSessionId 作为运行代次；重开同项目产生新代次。
- 请求 envelope 可携带 `scope: { projectId, projectSessionId }`。stdio/HTTP RPC 在进入短写队列之前绑定服务对象与代次；不同项目不共享长 Promise 尾链，同项目短写仍序列化。
- 新请求不得进入 draining/closed 运行；已排队请求持有引用，卸载后执行会收到 STALE_SESSION。Native 回调继续使用原项目实例和项目/attempt/request ID，不在回调中查全局当前项目。
- 旧 project.open/create/restore 通过新服务组替换原选中实例，继续保留旧“停止该项目后替换”行为；不会关闭其他新 runtime。旧 project.close 关闭绑定时的项目。

## 容器、资源和恢复

- 路径必须绝对且无链接段；只读探针核对真实 project ID，根目录及 SQLite 文件设备/inode 身份作为容器指纹。相同 project ID 从另一目录同时加载被拒绝；expectedProjectId 不符在打开运行之前拒绝。
- 可写/只读继续使用原项目进程锁。只读运行不执行恢复写入或远端任务。
- 默认最多 4 项运行；只有非当前、无排队/在途引用且无活动生成、媒体提交/确认、视频远端任务或配音任务的实例可在容量压力下释放。没有空闲项时明确拒绝，不取消活动任务腾位置。
- 视频提交与轮询分别共享进程总并发 2；轮询保留 500 ms 最小间隔，项目之间轮转。旧 dispatch 的释放只处理原 token；卸载撤销排队资格，不提前释放仍在等待 Native 结果的物理执行名额。
- 应用登记只保存 project ID、规范路径、目录/数据库身份、恢复选择、错误类别和更新时间。新登记默认不自动恢复；明确启用后在 Native Bridge 配置完成时逐项核对容器并恢复。缺失/变化/无法写入的项目记录不可用或只读，不重提未知付费请求。
- 显式卸载关闭该登记的启动恢复；空闲回收保留用户选择。进程内恢复和生命周期操作共用控制序列，避免启动恢复覆盖用户后续选择。
- 应用库升级前创建一致性备份并检查完整性；v8 迁移失败原子回滚，初始化失败释放数据库连接。ProjectService 即使 checkpoint 失败也会关闭句柄并尝试释放原锁。

## 关闭与兼容

默认启用后端能力，现有 UI 继续走兼容入口。`AI_VIDEO_TASK_SCHEDULER_ENABLED=0` 在启动时将运行上限收紧为 1，并保留旧媒体提交/轮询路径；不会在同一进程中硬切已有运行 owner。应用 v8 不能承诺由只支持 v7 的旧应用直接写入，降级须使用升级前备份并先核对未完成任务。

本阶段没有向模型注册项目 attach/unload 工具；本地路径和恢复选择仍通过可信 IPC 操作，任务中的模型不能任意打开本地目录。

## 验证

- 全仓按包/文件串行 1,370 项通过：Context 8、Contracts 24、LLM 32、Desktop 431、Generation Adapters 59、Persistence 67、Worker 749。
- 新增 Worker 13 项：真实 handler 的双项目 Pi/视频并行；关闭 A 后 B 继续；A 排队后激活 B；旧代次/作用域/目录克隆拒绝；只读与容器身份；显式恢复与恢复关闭；容量、空闲释放、排队引用、项目轮转和升级备份。
- 新增 Persistence 1 项：v7→v8 迁移回滚、重放、旧 Provider 保留及仅包含元数据的表结构；既有应用库测试改用当前版本常量，保留旧 v1 升级数据断言。
- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check` 通过；Vite 保留既有大 chunk 提示。
- 独立 Worker 构建完成；`node apps/worker/scripts/validate-project-runtimes.mjs` 使用打包 EXE 和隔离 app/project 目录，通过 attach A/B、并发文档保存、各自读取、激活 B、卸载/重开 A 和旧 epoch 拒绝的 stdio 回合。
- `node apps/worker/scripts/validate-project-runtimes.mjs --single-project` 验证关闭调度后的单项目兼容模式：激活 A 后，加载 B 因运行容量而被拒绝，A 保持可用。

目录移动用例在当前 Windows 因打开 SQLite 句柄被系统以 EPERM 阻止，验证 B 仍可写；没有将其宣称为 Windows 下实际成功移动后再检测。容器指纹变化的启动恢复拒绝有独立测试。Provider 全部使用模拟 Native 事件，无真实付费请求。

末次注册表错误路径整理后，13 项聚焦用例与打包 stdio 回合再次通过。没有执行新的 NSIS 构建、真实原生多窗口、休眠/断网、旧版本升级或真实 Provider 验收；Rust 本轮无改动，未重复 P1 已通过的 Rust 全套。

## 下一阶段

P3 接前端按项目/任务管理观察器、确认队列和独立取消；需让前端在新操作中传 scope，并停止把离开会话解释为取消。P4 的同会话分支、P5 的业务扩展及 P6 的组合故障/发布门禁仍未完成。

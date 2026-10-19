# 并发计划 P3：前端运行归属与独立确认

日期：2026-10-17。保留 P2 及用户已有未提交改动；项目 Schema v50、应用 Schema v8 不变。

## 实施

- Desktop 使用捕获项目 ID 与运行代次的 Worker client；启动的流、轮询、后续文件读取不重新解析活动项目。开发媒体 URL 同样携带 scope，Worker 校验后路由。
- 打开另一项目改为 attach + activate；新建/示例/恢复提供独立 runtime control，不卸载已有项目。显式关闭仅卸载指定 runtime。
- App 用 generation ID 管理运行集合，当前会话只是观察视图。切换不取消；后台最终回调不会停止另一个任务的可见事件轮询。重新进入从 Worker 的活动 Pi 列表恢复观察，不重启 Provider 请求。
- 确认以 owner + kind + token 排队，重放复用同一 Promise，决策只解析对应项。工具、模型和付费确认都显示任务归属及冻结参数；制作面板接入同一队列。取消只移除对应 owner，过期只处理本卡片。
- Pi 观察断线或超时仅结束本次观察，不 fail/cancel Worker 运行。重连走观察入口；显式取消仍持久化该 generation 的取消。
- 项目视图按 runtime epoch 重建；文档、素材和维护操作的 UI setter 检查原 scope，旧 save/finally 不覆盖新项目。素材标签在布局阶段清除旧选择的输入，避免延迟 effect 清空用户刚输入的标签。
- 同会话接纳互斥保留至 P4；本阶段没有开放所有工具并行。

## 验证

- Desktop 全量 46 个文件、434 项通过；随后增加文档异步保存回归并调整内容加载为新视图 effect，App / LLM client / Document workspace 107 项通过。
- Worker runtime / Pi / handler / scheduler 61 项通过，含从 runtime control 创建第三项目后原 A/B 仍可写。
- 新交错回归证明两个项目同时开始并各自等待确认；取消 A 后 B 仍等待，批准 B 后独立完成。RPC 始终携带原 epoch。
- 新文档回归在 A 保存未返回时切换 B；A 后续读取仍路由 A，A finally 不清 B busy，A 完成不关闭 B 编辑页。
- 全仓 Typecheck、Desktop/Worker/Contracts ESLint、diff 检查通过（末次文档视图改动另由聚焦测试和 Desktop Typecheck 验证）；最终全仓门禁在 P6 重跑。

全量测试过程中复现的标签输入晚清空、启动按钮未就绪、重建视图后测试持有旧 DOM 引用均已针对原因修复，未放宽超时。真实 Windows 多窗口、休眠和付费 Provider 尚未验证，不作为本阶段自动化通过证据。

## 兼容与限制

旧 project.open/close IPC 保留；Desktop 使用新入口。同一项目的 SQLite 写锁、授权、CAS、付费确认和未知提交不重发规则不变。窗口关闭只撤销观察；项目显式卸载或应用退出仍由 Worker 安全停止/保留远端事实。已加载项目上限仍为 4，关闭调度能力时为 1。

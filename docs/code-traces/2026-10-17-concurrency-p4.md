# 并发计划 P4：同会话分支及只读工具

日期：2026-10-17。开始时保留 P0–P3 与用户已有修改；项目 Schema v50→v51，应用 Schema v8 保持。

## 入口与边界

- `agent.run` 普通发送采用 ordered；显式 parallel 创建独立分支。原始 LLM/旧 Agent prepare 的同会话 busy 保护保留。禁用 Pi 或设置 `AI_VIDEO_CONVERSATION_PARALLEL_ENABLED=0` 时不放开旧接纳保护。
- v51 保存单调消息序号、generation 分支、输入消息、历史截止、创建时活动 generation 排除集合和指定前置任务。旧记录保留兼容历史，不伪造分支关联。
- 普通上下文只编译截止边界内的完整历史；library 内容/结构检索在排序和截断之前执行相同边界，read 再校验。其他活动分支后续完成、其临时草稿入库，均不会扩大本任务已冻结的可见范围。
- ordered 在依赖完成之前等待且不占执行槽。完成后持久化指定上游消息快照；失败/取消的前置任务阻断下游并要求显式重试，不盲目执行。
- 共享 ExecutionPool 限制文本实际执行 4/app、2/project，等待队列最多 128/app、32/project；项目 generation 接纳同样限制为 32。项目间轮转，取消排队项不调用 Provider。
- `conversation.runtime.supplement` 持久化到指定 generation，并校验幂等键/目标/输入容量。只在下一轮边界消费，不改已经发出的请求；继续轮次获得新的 Provider step 及授权，原正文、目标和审核规则保持。
- Desktop 显示运行任务和选择按钮；发送方式默认有序跟进，另有显式并行及补充目标选择。停止只作用当前选中的 generation。不同分支回调分别合并对应消息，不接管其他任务的确认或 finally。

## 工具执行

Pi 按 Registry 区分 parallel-readonly 和 sequential；含写工具的响应仍整体顺序执行。只读响应先冻结完整调用 ID/授权集合，最多 8 项、同时执行最多 4 项；整个批次结束后由 Worker 当前预算与授权统一刷新 definitions，回调不会各自覆盖共享定义。外网研究的直接批次入口也限制为 4。现有预算预留、一次性确认、Provider call 去重和审计均保留。

运行卸载会取消并等待 Pi 释放槽位后再关闭数据库；空闲运行可重新绑定 Native bridge，活动运行不会被替换。

## 验证

- Worker Generation / Pi / Gateway / Loop / Runtime IPC：169 项通过，另有 ExecutionPool 容量/排队取消屏障用例通过。
- 真实 `agent.run → conversation.runtime.start → NativeProviderBridge` 模拟链证明：同会话两次 Provider 调用同时在途；第三项 ordered 为零调用直到指定上游完成；取消第一项不影响第二项；补充输入在后续一轮进入该任务，前一轮完整结果仍保留。
- 历史/检索回归证明活动 A 的输入、片段与补充不能进入 B；A 完成入库后 B 仍搜不到，之后新建任务可正常读取已完成历史。
- Desktop App / ChatPanel：106 项通过，覆盖默认跟进、显式并行、补充目标选择与独立停止。
- Persistence 全量：68 项通过；v50→v51 故障注入回滚、等时序消息稳定排序、重复迁移和完整性校验通过。
- 全仓 Typecheck 通过；修改文件格式、ESLint 与最终全仓门禁在继续实施及 P6 复验。

未执行真实付费 Provider、Windows 休眠与发布升级；模拟重叠不代表这些人工发布门禁已通过。

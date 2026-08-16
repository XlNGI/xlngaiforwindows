# M3 上下文与 LLM

版本：2  
日期：2026-08-01

## 数据与作用域

SQLite Schema v2 为正式文档增加 `scope_type` 和 `scope_id`。从 Schema v1 升级时，已有文档全部迁移为项目作用域，文档内容、版本记录和当前版本指针保持不变。

风险加固阶段增加 Schema v3：`chat_messages.reply_to_message_id` 将助手回复直接关联到原始用户消息。重试只读取该持久化关联，不再依赖时间戳或随机 ID 排序；已有 Schema v2 消息保持不变，新生成消息自动建立关联。

会话企业级加固阶段升级到 Schema v11：新增 `llm_generations` 作为 generation 聚合事实源，记录项目会话、上下文快照、输入/回复消息、执行模式、幂等键、终态错误和 CAS 版本。`llm_generation_attempts` 保留为 Provider 尝试明细。Worker 重启后可按 generation ID 从 SQLite 重建终态，重复 prepare/retry、完成和取消不会重复写入业务输入或把终态改回活动态。

文档工作流阶段升级到 Schema v12：`documents.current_version_id` 表示当前工作版本，`documents.published_version_id` 是唯一默认权威版本。草稿、审核和发布记录保存在项目 SQLite；未发布草稿默认不进入其他会话的 LLM 上下文。

审计加固阶段升级到 Schema v13：新增项目级不可变 `document_audit_events`，记录草稿保存/恢复、审核提交/退回/拒绝和发布动作。审计事件只保存有界元数据，不保存 Markdown 正文或完整审核评论，并与任务事件保持分离。

当前运行基线为 Schema v13；后续上下文草稿显式引用、模型动态预算和结构化 Agent 提案应从 v14 起增量设计。

`ProductionContext` 按会话作用域选择资料：

- 项目会话只读取项目级资料。
- 场次会话读取项目级资料和当前场次资料。
- 镜头会话读取项目级资料、所属场次资料和当前镜头资料。
- 其他场次和镜头的资料不会进入上下文。

生产约束优先级最高，其后按已发布状态、作用域、显式关联和相关性选择正式文档、项目记忆和最近会话。文档标题、文件名和兼容期 `kind` 字段不改变权威等级或默认排序。每个正式文档来源保留文档 ID、版本号和发布版本 ID，供界面展示和生成快照追踪。生产约束必须完整进入上下文；约束本身超过预算时请求会明确失败，不会发送缺少约束的上下文。

默认预算为 24,000 tokens，可用范围为 1,000 至 200,000 tokens。预算、裁剪和界面估算共用同一估算器：ASCII 按约 4 字符/token，中文及其他非 ASCII 按 1 字符/token 保守计算。超过 8,000 字符的来源生成确定性抽取摘要；摘要键由来源 ID、版本 ID 和内容计算，缓存写入 `context_snapshots`。实际生成使用的完整上下文也会保存为不可变快照。

## OpenAI Provider

首个 Provider 使用 OpenAI Responses API 和 SSE 流式响应：

- 默认模型：`gpt-5.6-sol`
- 推理配置：`reasoning.effort = none`
- 请求存储：`store = false`
- 密钥来源：仅 `OPENAI_API_KEY`
- 可选覆盖：`OPENAI_BASE_URL`、`OPENAI_MODEL`
- 默认超时：总时限 120 秒、首字节 30 秒、流空闲 30 秒

凭据不会写入项目数据库、上下文快照或日志。没有密钥时，界面仍可保存本地会话，但生成入口显示 Provider 未配置，IPC 返回 `LLM_NOT_CONFIGURED`。

PowerShell 启动示例：

```powershell
$env:OPENAI_API_KEY = "your-key"
# 可选：$env:OPENAI_MODEL = "gpt-5.6-sol"
# 可选：$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
pnpm dev:desktop
```

## 生成生命周期

Tauri 与 Worker 继续使用请求/响应式 IPC。Worker 在后台读取 SSE，桌面端轮询生成状态：

```text
context.preview
llm.status
llm.generate
llm.generation.get
llm.generation.cancel
llm.generation.retry
```

生成开始时保存用户消息、流式助手消息和上下文快照。文本增量先在内存合并，按 250 ms 或 512 字符批量更新同一助手消息；完成、失败和取消前强制落盘。只有收到 `response.completed` 后才标记为 `complete`；首字节、总时限或流空闲超时，以及 `response.failed`、`response.incomplete` 和缺少成功终止事件的截断流均标记失败。失败或取消保留已接收文本和可重试状态。

重试通过 `reply_to_message_id` 复用原始用户消息，不重复插入用户消息。创建、打开、恢复或关闭项目之前，Worker 会取消并等待所有活动生成进入终态；即使 Provider 忽略 Abort，取消等待也会在 5 秒内结束并持久化终态。每次回写同时校验项目 ID；打开可写项目时，遗留的 `streaming` 消息自动修复为 `failed`。

## 桌面端

会话栏显示 Provider、模型、配置状态、上下文作用域、估算 tokens、来源名称和正式文档版本。生成时提供停止按钮，失败消息提供重试入口。切换会话时先取消原会话生成，轮询结果仅合并到 ID 匹配的会话。项目、场次、镜头和会话加载使用请求序号，过期响应及其错误不能覆盖当前选择。未配置 Provider 时发送操作只保存为本地聊天，不发起网络请求。

## 验证

已通过：

- 自动化测试包括 Schema v1/v2 到 v3 迁移、作用域隔离、中文预算、文档版本引用、摘要缓存、约束预算、SSE 成功/失败/未完成/截断/超时事件、批量流式持久化、有界关闭取消、重启修复、稳定重试关联和异步跨会话隔离。
- `pnpm lint`
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm build`

当前环境未配置 `OPENAI_API_KEY`，且 2026-08-02 对 `api.openai.com:443` 的连接测试和无凭据请求均超时，因此未执行会产生外部请求的真实模型调用；Provider 使用固定 SSE 响应完成契约测试。

实现参考 OpenAI 官方文档：

- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Create a response](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [GPT-5.6 prompting guide](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)

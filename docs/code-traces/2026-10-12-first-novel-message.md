# 首次会话小说请求被章节校验拦截

日期：2026-10-12

## 用户现象和本地证据

首次发送“帮我生成一个小说”，空会话提示“请补充要操作的小说章节或新章节标题，助手会继续当前任务”。所选会话模型为 kimi-k3 / UniCompAPI。

只读检查用户项目 SQLite：对应会话消息数量为 0，`agent_tasks` 为空，12:06 左右产生的 `agent_pending_intents` 为 `create_chapter / TARGET_REQUIRED`，快照仅含 `{"action":"create_chapter"}`。本次错误发生在本地章节预编排，尚未创建模型生成任务，和之前的图片下载故障无关。

## 原因与修复

Worker 已对开放式小说目标使用普通 System Agent，但 Desktop `inferNovelWritingIntent` 仍将包含“小说”与“生成”的宽泛请求发送为可信 `create_chapter` hint。Worker 优先采用该 hint，缺失章名和章序时立即返回 pending，模型没有机会理解需求。

Desktop 只在明确章节信号（章节、本章、小说正文、第 X 章或小说续写/重写）出现时发送章节 hint。小说页已选章节的“修改正文”等明确正文操作仍绑定所选章节。一般小说目标、大纲、人物设定请求不因小说页或已选章节而冻结写入目标，正常进入助手；明确章节请求的 Worker 目标、锁、CAS 与审核规则保持有效。

没有修改检索、正文注入、项目数据或产品要求。

## 验证

- Desktop 全套 281 项通过，含实际 App 首次发送“帮我生成一个小说”、缺目标续写提示以及从提示后发送普通请求的回归。
- Worker 全套 531 项通过。
- 全仓 typecheck、变更文件 ESLint/Prettier、`git diff --check` 通过。
- 全仓 lint 仍因既有 `.m2-ui-novel-open-goal/validate.cjs` 的 9 个 Node 全局 `no-undef` 报错失败；此次修改文件 ESLint 通过。
- 隔离项目使用真实打包 Worker 和当前运行 Vite 服务提供的 `inferNovelWritingIntent`，旧 HEAD 前端参数复现 `pending_intent / TARGET_REQUIRED`，当前代码对“帮我生成一个小说”“请创作一部悬疑小说”“请生成小说大纲”“生成小说人物设定”均返回 `started / document`，用户消息正常落库，没有章节或待补充意图；明确“生成小说章节”仍返回 `TARGET_REQUIRED`。脚本与报告位于本地 `.m2-ui-novel-first-message/`。
- `pnpm.cmd tauri:build` 成功，Release 和 x64 NSIS 安装包更新于 12:17:45。

隔离验证未启动 Provider 生成，没有付费模型请求。未对用户当前项目写入诊断数据。当前开发版从 Vite 提供修复；安装包包含编译后的同一修复。

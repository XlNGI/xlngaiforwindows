# 小说多章请求超时与章节页面路由

日期：2026-10-12

## 用户项目证据（只读）

请求“生成第四章和第五章”对应任务 `31fe5996-d311-49af-afa6-fb91a4c93ed1`，在本地时间 13:38:54 启动，13:44:13 失败，错误为 `LLM stream exceeded the total timeout.`。13:39:04 执行两次 `library.search`，13:39:09 执行两次 `library.read`，成功读取第三章 3128 字和小说大纲 2331 字。后续没有 `novel.chapter.submit_draft` 审计，没有 partial artifact，助手仅保存了准备创作的说明。现有记录不能证明上游完整正文到达了客户端。

任务只冻结第四章目标，原始提示词却同时要求第四、第五章，违反既定“一任务一个主要章节草稿，多章拆任务”的要求。第三章的数据库章节关联正确，但一般 `document.list` 包含其底层 note 文档，Desktop 只在文档不在列表时检查章节关系，因此可以把小说正文打开到剧本页。

## 修复

- Native 在 WinHTTP 读取前查询当前可读字节数，避免固定 8 KiB 读取继续等待填满缓冲；收到 Chat Completions `[DONE]` 或 Responses `response.completed` 后立即结束响应，不等待 HTTP final chunk/EOF。仍要求协议成功事件，截断响应不能误判成功。
- 总超时错误增加接收字节数、耗时、工具调用数、工具参数字节数；不记录正文或凭据。没有延长原来的超时上限。
- Desktop 将明确的“生成第四章和第五章”列表拆为顺序执行的独立章节任务，保留原始用户消息和各章写作要求。下一章只在前一章成功落稿且任务进入 `waiting_review`/`completed` 后启动。失败、取消或项目切换停止剩余章节；准备中取消会取消刚创建的 generation。
- Worker 对没有拆开的多章目标返回 `TARGET_NOT_UNIQUE`，不再静默冻结第一个目标；继续保留已有章节审核锁。
- 一般文档列表按 `novel_chapters.document_id` 排除章节底层文档；打开文档、任务产物和旧文档类型引用时优先查询真实章节关联。检索和读取草稿仍经过 `library.search/read`，不自动注入正文。

## 验证

- 本地 HTTP 模拟 Provider 故意发送完整工具参数与协议结束事件后保持 chunked 连接打开，不发送 HTTP final chunk 或 EOF。原先固定读取行为等待连接结束并失败；修复后两种协议均在约 0.02 秒内返回完整工具调用和 usage。Native 全套 129 项通过、1 项既有 ignored；流相关 36 项通过。
- Desktop 全套 289 项、Worker 全套 542 项、Contracts 全套 19 项通过。覆盖顺序启动、失败中止、运行中取消、准备中项目切换、原始多章消息保留和旧列表中的章节导航。
- 当前打包 Worker 隔离项目 RPC 验证共 8 条路径：两种协议、两个首章入口、有无 hint；先保存第一、第二章，再使用实际 Desktop 分章执行函数保存第四、第五章。第五章通过检索读取第四章草稿；4 个任务均保留 `waiting_review`；旧版本不变；一般文档列表排除章节。模拟第六章失败后，第七章未创建。报告：`.m2-ui-novel-chapter/report-batch-chapter.json`。
- 全仓 typecheck、Prettier、修改文件 ESLint 和 `git diff --check` 通过。全仓 lint 仍因既有 `.m2-ui-novel-open-goal/validate.cjs` 的 9 个 `no-undef` 失败；全仓 Rust 格式检查仍有既有 `lib.rs` 格式差异，修改的 `llm_stream.rs` 单独格式检查通过。
- `pnpm.cmd tauri:build` 已成功生成 Release/x64 NSIS，时间 14:20:49，安装包 SHA256：`5A3A7421A3099E3836D7253EE5ED4CE8017DD9573D213C64D5961C4DFC38FA6F`。

隔离测试没有真实 Provider 请求，没有直接写入用户项目。完整小说计划仍未完成。当前批次后续启动由主窗口中的执行序列持有，关闭停靠面板不会停止；应用退出后未启动章节不会自动重放，原始请求及已启动任务保留在本地。此处只支持明确的新建章节列表；范围和多章改写保持澄清，不擅自扩大修改范围。

当前 Vite 1420 端口未运行；没有声称开发应用已自动加载新构建。用户需要使用本次安装包更新后重新打开应用。

# 小说第一章主操作误选与准备失败清理

日期：2026-10-12

## 现象

已保存《时间典当行》大纲后，发送“现在生成小说第一章”，本地提示：

`Novel chapter tasks must authorize novel.chapter.submit_draft as their primary operation.`

上游模型尚未收到请求。用户数据库中可见多条 `queued` 章节任务、空助手消息和空章节占位。

## 根因

章节任务同时授权系统、资料检索和媒体工具。工具清单冻结时按名称排序，并只排除了媒体 `prepare` 工具，没有排除 `media.generation.submit` 与 `media.task.cancel`。媒体提交工具因此被选作 primary operation，章节任务校验失败。

## 修复

- 冻结工具清单和 continuation 的 primary authorization 都排除媒体提交/取消操作。
- 统一 `prepareAgentGeneration` 启动路径；generation、Agent manifest 或工具配置失败时同步结束 generation 和助手消息，标记任务失败，释放锁并归档无版本占位。
- 项目重开回收上一会话中没有 generation 关联的遗留 queued 章节任务；已有正文的章节保留。
- 统一助手保存章节后按任务目标打开小说编辑器。

## 验证

- Worker 全套 539 项通过；Desktop 全套 282 项通过。
- 全仓 typecheck、修改文件 ESLint/Prettier、`git diff --check` 通过。
- 使用当前打包 Worker 的隔离 RPC，未调用 Provider：Responses 和 Chat Completions、`agent.run` 和 `agent.generation.prepare`、有无 Desktop hint 共 8 条路径均验证 `project.get_context`、`library.search`、`library.read` 和 `novel.chapter.submit_draft`，章节正文落库，任务状态为 `waiting_review`，primary operation 始终为 `novel.chapter.submit_draft`。
- `pnpm.cmd tauri:build` 已重新构建 Release/x64 应用和 NSIS 安装包，产物时间为 13:16:22。
- 运行中的开发应用由 Tauri watcher 自动重载，Worker 进程创建于 13:15:11，晚于 `dist` 编译时间 13:15:00，已加载本次修复。
- 用户项目的 4 条遗留 queued 准备任务在正式项目恢复流程中于 13:13:46 标记失败；只读复核确认空占位全部归档、章节锁为 0。
- 全仓 lint 仍因已有 `.m2-ui-novel-open-goal/validate.cjs` 的 9 个 `no-undef` 失败；本次修改文件 ESLint 通过。

RPC 验证使用隔离临时项目，未产生付费 Provider 请求。诊断仅只读查询用户数据库；遗留任务由应用正式恢复流程处理，没有直接写入用户数据库。

## 后续发现：第二章被误判为重写第一章

第一章保存后任务为 `waiting_review`，同章锁继续保留。现有计划明确要求保留审核锁，以防未审核正文被覆盖。用户在第一章编辑器输入“现在生成第二章”，Desktop 却把当前选中的第一章作为所有章节请求的目标，发送 `rewrite_chapter(chapterId=第一章)`，因此 Worker 返回“该章节已有活动写作任务”。

Desktop 现在对“现在生成第二章”“请创作第十二章”等明确编号创建请求发送 `create_chapter + displayLabel/chapterTitle`，不携带当前章节 ID；续写本章、重写和修改正文仍使用当前章节目标。

验证：

- 修复前，3 个意图测试与 App 首章保存后二次发送回归均复现错误；修复后 Desktop 全套 285 项通过。
- Worker 编排及 Provider loop 109 项通过，包含第一章保持 `waiting_review` 和同章锁时创建第二章的回归。
- 当前运行 Vite 提供的真实前端意图函数配合打包 Worker，在两种协议、两个入口、有无 hint 共 8 条路径先保存第一章，再检索读取第一章草稿并保存第二章；第一章版本不变、第二章独立落库，两个任务均进入 `waiting_review`。脚本与报告在本地 `.m2-ui-novel-chapter/validate.mjs` 和 `report-second-chapter.json`。
- 全仓 typecheck、修改文件 ESLint/Prettier、`git diff --check` 通过。

本次未修改章节锁或审核规则，没有付费 Provider 请求，也未直接写入用户项目。

本轮 `pnpm.cmd tauri:build` 于 13:31:44 成功更新 Release 和 x64 NSIS 安装包。开发应用自动重载于 13:30:40；最后隔离验证读取当前 Vite 源码并确认编号创建意图已生效。

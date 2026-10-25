# 章节目录元数据编辑工具

## 审计

截图对应任务调用 `novel.chapter.write_draft(action=rewrite_chapter)`，正文不变却传入 `displayLabel`，被 `Existing chapter submissions cannot move or relabel chapters` 校验拒绝。`conversation.ask` 已成功保存表单；这次不是表单渲染失败。

底层 `NovelService.saveChapter` 已支持标题和显示标签，但 Agent 只暴露章节正文写入、列表及归档/恢复，没有元数据编辑入口。重写工具的共用 schema 又包含仅供创建的 `displayLabel` / `volumeId`，声明没有清楚指出其适用范围。不能以放开重写工具的结构变更限制来修正，也不能让模型通过重建章节或改正文首行代替目录编辑。

## 实施清单

- [x] 增加 `novel.chapter.update_metadata` 工具声明和 R1 顺序执行策略，按需加载，复用现有系统工具网关、任务审计和调用 ID 重放保护。
- [x] 仅接受真实章节 ID、章节/文档两个行版本、可选标题和显示标签；至少改一项。不接受正文、移动、归档或发布字段，不规定章节命名风格。
- [x] 在现有小说服务中校验当前项目、活动状态与 CAS，再复用 `saveChapter`。同值为无写入操作；错误不产生正文版本或部分修改。
- [x] 现有章节保存事务同步重建目录和检索标题，保留正文、内容版本指针、RAG 正文切片、发布快照和位置。元数据工具不创建假正文产物或审核任务。
- [x] 工具说明明确 `displayLabel` / `volumeId` 仅供新建章节；修改已有目录应使用元数据工具。误用重写时返回具体可用工具。
- [x] 成功任务返回元数据刷新标记，桌面刷新同一小说目录；保留本地未保存文字，不把并发正文修改冒充仅元数据修改以绕过 CAS。
- [x] 完成聚焦回归、全仓类型/Lint/格式/构建门禁并记录结果。

## 验证记录

- Worker 5 个文件、200 项测试通过，覆盖小说保存、系统工具、真实 Pi 工具循环（Responses / Chat Completions）、任务读取及工具网关。
- Desktop 2 个文件、115 项测试通过，覆盖目录刷新、本地未保存标题/正文保留、并发正文版本保护，以及既有 App 集成。
- 双 CAS 冲突、归档与跨项目拒绝、同值无写入、索引失败事务回滚、正文/RAG 切片不变及已发布结构快照不变均通过。元数据写入不误标为只读任务。
- 全仓 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check` 通过。最后补充的任务结果标记与测试调整已定向复测；Worker 重新构建。Vite 保留既有主包超过 500 kB 提示。
- 当前桌面 Worker 仍为旧 stdio 进程；重启应用后新工具与桌面代码生效。未强杀运行进程。

## 验证边界

使用临时 SQLite 项目、模拟 Provider 和桌面测试。真实项目只读审计，不修改原标签，不重新提交正文或调用付费 Provider。模拟 Provider 验证真实 Pi 的按需加载与执行路径，不能证明真实模型一定自主选择正确工具。已有会话表单和失败记录不改写。

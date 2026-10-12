# 多章请求在未选择前端模型时被拦截

日期：2026-10-12

## 现场证据

最新截图输入为“生成第四章和第五章”，小说页选中第一章，模型摘要显示“未选择模型 UniCompAPI”，提示“当前小说任务需要补充说明后才能继续”。

只读检查用户项目确认，14:27:21–14:27:27 新增的记录是 `TARGET_NOT_UNIQUE` 的 pending intent；没有对应的新 generation 或 Agent task。请求快照携带 `rewrite_chapter` 和第一章 ID `f0b15a08-d49f-47bb-94f2-1edaaaddade9`，同时会话 `4fc3c33a-fee8-4297-a4da-5e701c121ec9` 已保存 text 模型偏好。

运行中的应用于 14:25 启动，Worker 与上一份 14:20 安装包中的 Worker 哈希一致。这次是当前版本的本地启动问题，不是旧版本，也没有到达上游接收阶段。

## 原因与修复

- Desktop 原先只有在前端同时选中供应商和模型时才拆分多章请求。Worker 能恢复会话模型，因此未选前端模型的请求绕过拆分，随后被单章目标校验拒绝。现在拆分不依赖前端模型选择，各子请求保留 Worker 的会话偏好恢复与可用模型校验。
- “生成本章正文”的提示绑定原始输入、项目 ID 和会话 ID。主窗口或分离窗口修改输入时清除快捷目标；发送时再次核对绑定，防止新的创建请求仍携带第一章重写目标。
- 首个子请求返回 `needs_model_selection` 时，保留完整原始多章请求并显示已有模型选择界面。重新选择模型后再次拆分完整请求；不把单独的第四章请求当作全部用户要求。
- 原始多章消息在子任务启动前保存。模型选择重试复用同一条原始消息，防止重复保存。没有可用模型时允许保存用户消息，但不创建章节、Agent task、generation 或 pending intent。
- 快捷目标在合法的重新选模型流程中继续保留；实际启动后清除。附件仍从原始输入重新构造，避免重试输入和目标校验不一致。
- 下一章仍须等待上一章成功落稿并进入 `waiting_review`/`completed`；失败、取消或项目切换停止后续任务。运行中模型变为不可用时停在对应剩余章节，不自动重跑已经保存的章节。

## 验证

- 修改前，新增 Desktop 回归复现四个失败：快捷目标污染第二章创建、会话保存模型下漏走多章拆分，以及缺失/不可用模型后只保留错误的单章路径。
- 修改后，Desktop 全套 297 项、Worker 542 项、Contracts 19 项，以及 Context/LLM/Adapters/Persistence 全套均通过，全仓共 973 项 JS/TS 测试。最后消息保存调整的 App/分章执行专项 61 项通过；最终 Desktop 全套 297 项、typecheck、修改文件 ESLint 与全仓格式检查也通过。
- 打包 Worker 的隔离 RPC 共 8 条路径，覆盖 Responses/Chat Completions、两个首章入口和有无 hint。实际 Desktop 分章执行函数在未传前端模型、仅保存会话模型偏好的情况下生成第四、第五章；带入第一章旧 hint 也不会覆盖独立创建目标。第五章按需读取第四章草稿，第一章版本和已有审核锁不变。
- 缺少模型偏好、保存模型被停用的 RPC 均返回模型选择。只读数据库计数确认章节、任务、generation、pending intent 和子请求消息没有新增；模型恢复后只保留一条原始多章消息。第六章模拟失败时第七章未创建。报告：`.m2-ui-novel-chapter/report-batch-chapter.json`。
- 全仓 typecheck、修改文件 ESLint、Prettier 和 `git diff --check` 通过。全仓 lint 的既有 `.m2-ui-novel-open-goal/validate.cjs` 仍有 9 项 `no-undef`；本次未修改该脚本。
- 最终 `pnpm.cmd tauri:build` 成功生成 Release/x64 NSIS，时间 15:04:13，安装包 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，大小 22,323,241 字节，SHA256：`7AB4BCD97FFF3DF8FD7C62909BB982F4A9F39AAE3758A3A57C592EE65C380A6D`。构建后的前端包含模型选择消息复用字段，构建后的 Worker 再次通过同一套 8 条隔离 RPC。

未调用真实或付费 Provider，未直接修改用户项目数据库。小说计划整体仍未完成；没有停止运行中的用户应用或自动安装覆盖。

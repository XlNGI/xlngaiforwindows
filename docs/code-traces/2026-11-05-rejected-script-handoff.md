# 新建剧本保存失败、交接丢稿与旧 Worker 运行版本审计

日期：2026-11-05。承接用户“没有解决问题”和“为什么保留旧逻辑”的反馈。用户项目只读核查，流程回归使用临时 SQLite 与模拟 Native Provider；未重放用户任务、调用付费模型或修改用户项目。

## 现场证据

- 项目：供奉的是，SQLite 位于 `C:/Users/MSI/Desktop/iphoneshare/发生的哥特人/project.sqlite`，以 readonly／fileMustExist 打开。
- 新任务：`177721cd-7fef-4508-baaa-71659ce311fc`；Generation：`70b24d4d-ec81-4951-8d4f-1d1bd1307d37`。不是前次 `7bdc47c8-88a3-4a3a-96f9-83f3b24b380e`。
- 20:16:08–20:28:07（UTC+8）共 22 条真实工具审计，20:28:11 任务变为 failed。`document.submit_draft` 两次失败，没有真实剧本保存回执；成功 `library.read` 两次分别读取源章节和小说大纲，不能称作重复读取章节。
- 20:21:34 第一次新建提交被拒绝：`New documents cannot specify CAS for an existing target.` 参数摘要含 baseVersionId、expectedRevision、resourceId、title、documentKind、contentMarkdown、contentIR，但没有持久化原值，不能断言 baseVersionId 是 null 还是源版本。
- 20:21:50 成功交接后，Agent 按 evidenceOffset 逐页读取 checkpoint，试图恢复完整生成稿件与 IR。审计只保存脱敏摘要，不能从这些页取回被拒绝的稿件正文。20:25:44 第二次保存仍失败，之后连续 checkpoint 错误直至任务失败。
- Desktop PID 143384、其 Node Worker PID 141320 的启动时间分别为 18:55:53、18:55:54。前次修复构建晚于启动时间；20:16 的 `production.skill.read` 仍返回源码已移除的旧工具声明，直接证明当时运行实例没有加载新版模块。debug 启动器执行 `node dist/index.js`，不是热重载的 `tsx watch`。

原始只读抽取保存在本机临时目录 `p22-agent-cas-audit-1793881413842/raw.json`。本文不复制项目正文、Provider 配置或完整请求。

## 代码原因与修复

1. 前次只确认源码与构建，没有验证当前进程加载状态。重新构建不会替换已在 Node 内存中的模块；历史工具执行日志也不会随新代码改写。
2. 阶段交接保留了源读取和保存错误，却遗漏失败的 assistant toolCall 参数；生成稿件不属于可从源章节重新取得的同一正文。现在以 `AgentPendingWrites` 保留当前任务中失败本地草稿的完整参数及错误，作为未保存工作数据继续交接。当前阶段仍可见的调用不重复发送；后续错误修复缺正文时保留完整原稿；仅匹配的真实业务保存回执才能清理。失败数据不作为已保存证据，不自动重放，不新增审计正文存储。
3. 保存 schema 原先允许新建传入目标 CAS，业务服务却拒绝；现在 schema 表达新建／更新条件，并给出明确纠错信息。CAS 保护继续执行，不把源章节版本视为输出目标版本。
4. schema 对 contentIR 适用种类描述不准确。既有项目内容 IR 合同仅支持 character／scene／prop；现在提前拒绝其他种类，并要求剧本的全部结构与创作细节保存在 Markdown。没有新增领域类型或静默剥离 IR 来伪造成功。

旧文档工具定义还承担其他结构化授权入口，共享注册表中存在旧名称不能证明这次新建调用执行了两套保存逻辑。本次移除了当前章节技能中不可用的旧工具声明，替换不一致的执行规则；没有为了“清旧代码”删除项目版本、迁移、历史审计或仍被授权入口使用的处理器。

## 验证边界

新增正文交接／schema 回归首先确认旧实现失败，再实施修复。两种协议均验证完整失败参数跨交接、修正后一次真实保存、原文一致、无审计翻页扫描；另覆盖空正文／漏正文修复不覆盖稿件、可见正文不重复注入、修正非法分类后清理暂存。

定向 5 文件 203 项通过；随后一次 Worker 全量 88 文件 1314 项通过，类型检查、构建、8 文件定向 ESLint、Prettier 和差异检查通过。32k 窗口压力回归使用真实预算，保留所有未保存正文。运行时激活状态记录在[实施计划 D5–D9](../AGENT-CHECKPOINT-DEADLOCK-REPAIR-PLAN.md)：当前进程仍加载旧模块，已提出关闭编辑窗口并重启应用的确认，尚未激活。

用户原任务已失败，脱敏审计没有原始失败正文；离线通过不表示该历史稿件已恢复，也不表示已进行真实模型重试。

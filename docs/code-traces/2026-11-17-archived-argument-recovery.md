# 归档指针被当作提交参数的现场修复

日期：2026-11-17。对应用户截图中的 `BUNDLE_NO_PROGRESS_LIMIT` 与 `archivedArguments/resultId/read` 不支持字段错误。

## 现场结论

只读核查当前项目 SQLite，任务 `3998a5ec-9bff-40b6-becd-6895ed8e355c` 在北京时间 2026-11-17 00:21:30 开始、00:39:13 失败。运行 Worker SHA256 为 `b76773b05e025587b1123def2cda0a1bf5111a8dd930cdde53bcbe4d217de5ab`，与上一轮交付的用户模板修复包一致；不能归因于尚未加载上一版代码。

最后候选 revision=14，仍有 17 项候选：3 个角色、4 个地点、4 个道具、1 个场次、5 个镜头；统一业务提交回执为 0。因此界面的“0 份正文”是尚未完成整包提交，不表示所有候选正文丢失。

实际失败链：

1. 模型发送 `{archivedArguments:true,resultId,read}`，没有 partKey、expectedRevision 或 prompts。该对象采用历史归档定位格式，其 resultId 实际指向 `production.bundle.submission` 保存回执；回执 `arguments={}`，不是可重放的原始提交。
2. schema 正确拒绝，但通用参数恢复又把这个定位对象保留成 `preparedArguments` 候选，并让模型重试。
3. 模型随后两次按返回的 preparedArguments 引用重试；恢复器仍取出同一个定位对象，连续三次相同错误触发原有无进展保护。

这次报错属于历史投影与参数恢复的缺陷，不是模板正文缺失或数据库删掉提示词。先前的提前封包、混合用途和 partKey 冲突也保留在现场日志中，不能用本次修复宣称所有模型行为都已合格。

## 实施内容

- 支持参数复用的写工具，历史投影改用正式 `preparedArguments` 引用，引用同任务、同工具的完整原始参数；不再生成形似工具参数的归档占位对象。小型普通读取参数继续保留。
- 旧快照仍可恢复：按原 callId 找到原参数记录后投影为正式引用；已经是 preparedArguments 的调用保留其显式修正，避免引用再套引用。原始正文与完整审计不改写。
- 恢复入口明确识别纯归档指针，返回 `ARCHIVED_ARGUMENTS_NOT_EXECUTABLE`；没有业务写入，也不把指针再次存成可重试候选。旧版本已存下的此类坏引用也在展开时识别。
- 指向保存回执时，明确使用 checkpoint `resultView=content` 读取回执，或 production.bundle `operation=state` 读取当前状态；指向真正失败参数时，给出正式引用。不会将保存回执自动转换成提交，不刷新 CAS、不改 partKey，不自动重放已完成写入。
- 原有三次相同错误保护保留；不通过增加重试次数掩盖失败。没有新增语义门禁、内容规则或审查模型。

项目正文按需、draft/published 同库、附件不自动入索引、Task State / Result Store、本地 SQLite 与整包单事务规则不变。本轮没有产品决策变更，也没有对应需同步的 DOCX。

## 验证清单

- [x] F0 只读核对现场任务、错误顺序、候选及运行 Worker 指纹。
- [x] F1 修复前四项回归失败，复现旧投影和坏参数反复保留的问题。
- [x] F2 聚焦回归覆盖两协议、原文/重复字/CRLF、重启、旧快照、坏引用、项目/任务范围和 CAS；125 项通过。
- [x] F3 最终全仓测试、类型、Lint、格式、NSIS 和打包 Worker 两协议实际进程闭环。

最终全仓单次命令通过 2,805 项：Worker 103 文件 / 1,647 项、Desktop 99 文件 / 881 项，其余工作区 277 项。全仓 typecheck、Lint、format:check、NSIS 构建通过；两协议整包及两协议普通模板入口实际进程验证通过。没有修改 Native 生产代码，本次没有把上一轮 Rust 测试冒充为新增执行。

首次 Lint 发现新增测试直接返回校验器 any 值，改为不返回值的测试块后复跑。首次打包进程验证发现新增恢复说明误写不存在的 `operation=get`，已修正为合法 `operation=state`；该失败记录保留，不将它计为通过。

打包 Worker 的两协议整包验证通过：实际注入指向保存回执的旧归档指针，确认明确拒绝、prepared 记录数不增加，随后同一任务继续并自然完成；实际强杀重启、用途/冻结模板恢复、候选返修、幂等提交与 SQLite 独立重开读回也通过。两协议普通 agent.run / agent.generation.prepare 入口验证通过，保留模板全文、清空、版本冻结和用途隔离。供应商响应为离线脚本，没有真实模型费用。

最终安装包 `unicomp_0.1.0_x64-setup-archive-reference-repair-20261117.exe` 为 77,312,188 字节，SHA256 为 `c8bba4241e51a065e4ae28a7493c293b1ec6082f4c28895109fe7e0152aaaa9a`。打包 Worker SHA256 为 `022db80bc281973ff8a70c1ef46a5f701bfad2e8c7a9cca01e472023d1cb2bd7`，与两类打包进程验证使用的 exe 相同。

现场、指纹和进程验证结果见[机器证据](./2026-11-17-archived-argument-recovery.json)。本轮没有安装替换运行实例、改写用户项目、重跑原任务、生成媒体或发起新的真实供应商调用；离线脚本通过不等于原失败任务已恢复完成。

上一轮用户模板机制的真实内容连续性和普通返修收尾限制，仍以[原验收记录](./2026-11-16-user-template-generation-repair.md)为准，不因本次修复被标为通过。

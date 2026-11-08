# Agent 执行效率优化交付

日期：2026-11-08。按[实施计划](../AGENT-EXECUTION-EFFICIENCY-PLAN.md)顺序完成 E1–E5。复用现有 Pi Runtime、ContextManager、完整 Result Store、项目 SQLite 和统一业务提交边界；没有新增另一套 Runtime、存储服务或预算限制。

## 实现与根因

| 阶段 | 原有开销                                                                       | 已实现及专项测试                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | Rust 全部工具统一关闭 parallel_tool_calls，Worker 只读调度能力无法被供应商使用 | Registry 的可信 executionLane 经内部合同传入 Rust；两协议可请求多读。Pi 在任何执行前检查完整回复，多写、混合读写、loader 混合回复整批拒绝，逐调用授权不变；最多八个独立调用、读取并发沿用原门禁                                               |
| E2   | 失败后复制全部正文，目录 revision 混淆，计划 outputId 手抄容易出错             | 完整参数保存在既有 Result Store；preparedArguments 引用按项目、任务、工具和 hash 校验，合并更正后重新校验。新增 outputKey 解析已有计划绑定，未知或与 outputId 冲突时拒绝。resourceMap.revision 与 structure.revision 合同明确；不自动刷新 CAS |
| E3   | 已知产物仍逐个 search→read，普通参数错误也减少批次                             | library.read 支持显式 documentId＋expectedVersionId，签发内部 handle 后复用原读取、分页、IR、草稿标记和分支可见性校验。仅同任务已保存、计划登记或此前实际读取的资料可直接读回。schema、ID 和 JSON syntax 错误保留批次，明确输出截断才缩批     |
| E4   | 当前任务合同、待办、历史 state 回执和保存回执重复展示                          | 仅在请求投影中去掉与合同完全相同的字段，历史 state 待办指向当前 pendingSteps，保存产物使用 metadata 回执。完整原文、正文、历史记录和早期要求不改写，已被 Evidence／产物表示的结果引用不再重复列出                                             |

E1–E4 专项：Gateway／Pi／ProviderLoop／prepared 参数四文件 233 项；ContextManager／投影／审查三文件 85 项；恢复回归 105 项，均通过，重叠范围不相加为总数。覆盖 SQLite 重开、新服务直接读取、跨任务／项目拒绝、未登记目标、过期版本、hash 损坏、未知更正字段、原候选不变、真实 CAS 冲突及幂等重放。原 schema 权限及业务验证继续生效，失败结果仍回传 Agent。

全仓首轮出现两个旧测试失败：断言 schema 错误必须缩批。修正测试后进一步明确 JSON syntax 也不能冒充输出体积问题；两协议恢复测试保留已保存场次、全部镜头和原始提示词。首轮失败日志 `%TEMP%/agent-efficiency-all-tests.log` 保留，没有删除失败事实。

## 相同真实业务对比

基线与本轮均为同一个六镜／60 秒需求、`ergou-gpt-chat`／远端 `gpt-5.6-terra`、Chat Completions、空隔离项目。要求读取小说、人物、场景，保存三份计划及人物／场景／道具资料、一个真实场次和六个真实镜头，最后读回语义审查。剧情分析保存后强杀真实 Node Worker，重开原项目继续；没有人工编辑正文、修正 ID、发送继续消息或重新发起任务。

本轮目录：`C:/Users/MSI/AppData/Local/Temp/p22-agent-efficiency-20261108-Vaiw9I`。

任务：`f7dbeac1-15ff-4316-acf0-a561cde0fa00`。基线完整证据及首次失败／20分钟观察超时见[上一轮验收](./2026-11-07-agent-final-acceptance.md)，不改写其记录。

| 指标                          |      基线 |      本轮 |                                     变化 |
| ----------------------------- | --------: | --------: | ---------------------------------------: |
| 有供应商 usage 的请求         |        74 |        43 |                               减少 41.9% |
| 另有中断、未取得 usage 的请求 |         2 |         1 |                    不计入下方 Token 总量 |
| 业务审计调用                  |        70 |        40 |                               减少 42.9% |
| 业务失败                      |        10 |         3 |               执行前失败与此重叠，不相加 |
| 文档提交                      |        13 |         7 |                 6 次成功、1 次目的地错误 |
| library.search/read           |        18 |        12 | 3 次源搜索、3 次源读取、6 次产物直接读取 |
| production.read               |        14 |         6 |                             六镜分别读回 |
| 实际输入 Token                | 4,349,837 | 2,453,495 |                               减少 43.6% |
| 实际输出 Token                |    26,195 |    16,089 |                               减少 38.6% |
| 净观察时间                    |  1,267 秒 |    587 秒 |                               减少 53.7% |

本轮 Rust opt-in 实际 `1 passed`、exit 0，宿主精确计时 587.95 秒（9分48秒）。在一个观察段内完成，未达到20分钟观察期限。Agent 和持久 Task State 均 completed、pendingSteps 为空；正式文档与镜头在任务结束前已落盘且重开可见。

本轮 ledger 46 行：43 次有 usage 的模型请求、1 次强杀中断、2 条仅 firstSeen 的调度记录。按 responseId 去重为 42 次单工具回复与 1 次最终答复。模型真实使用了 outputKey 和六次 artifact 读回；**没有提出多读批次，也没有使用 preparedArguments 引用**。两项已有自动测试，不能将本轮收益归因于并行读取或正文引用复用。

三次业务错误为 decision 未引用原要求、人物资料目的地错误、reviewedTargetIds 范围错误；另有一次 review 缺 issues 的执行前 schema 拒绝。全部真实回传后由模型修正，无人工改库或放松门禁。原失败和审查记录保留。

单次实际输入峰值 89,908 Token，基线为 87,278；本地最终 wire 估算峰值 100,009，基线为 94,506。**本轮减少了总往返和累计输入，没有证明每轮峰值下降**。最后一次 wire 估算为 system 18,350、schema 27,698、message 44,967，共91,015；分段值是本地估算，供应商没有给出分段实际计费值。512000 仍是用户设置的 fallback 规划参考，未修改，不能当成供应商真实窗口证明。无完整价格快照，不推算费用。

这是一组同需求实际对比，存在模型随机性和供应商时延变化，不能据此承诺任意长任务均提速53.7%。

## 独立产物核对

实际读取三份源资料、六份生成文档及六镜 IR 的完整正文；不只接受 Agent 的 passed 审查回执。

| 镜  | 景别／动作／运镜                                     | 对白                   | 时长 |
| --- | ---------------------------------------------------- | ---------------------- | ---- |
| 1   | 空镜远景，雨夜湿木板、灯塔、海面，缓慢轻推           | 无                     | 10秒 |
| 2   | 中远景，蓝衣林澈握票沿码头走近，平稳跟拍并停步       | 无                     | 10秒 |
| 3   | 中景，灰风衣周岚灯塔下等待并看见林澈，移焦与视线确认 | 无                     | 10秒 |
| 4   | 林澈近景，蓝衣持票看向周岚，缓推后停稳               | 林澈：“我回来了。”     | 10秒 |
| 5   | 周岚近景，克制回应，轻推与停顿                       | 周岚：“我一直在等你。” | 10秒 |
| 6   | 双人中远景，并肩望海，缓移后停稳，远处汽笛           | 无                     | 10秒 |

六镜 beats 连续覆盖0至10秒，共60秒；两句对白在实际镜头权威 prompt 中各出现一次，字句、说话者及顺序正确。蓝衣、灰风衣、仅两名角色、雨夜码头／灯塔和结尾汽笛与来源及计划一致。镜2末尾停步与镜3“停住”有相邻动作描述重叠，未发现改变核心剧情或位置的矛盾。

所有实际引用 ID／类型有效。镜1为空镜，人物与道具引用为空；镜5为周岚近景，道具引用为空；不能写成每镜三类引用均非空。六份任务文档各一份／一个版本，三份源资料仍为原版本，剧情分析强杀前后保留原ID。313条完整 Result hash 全匹配，86个检查点；原始要求完整保留。最终审查显式覆盖全部12个目标、无未完成项。

独立结果 `independent-content-verification.json`；只读全文导出 `verified-episode-artifacts.md`；对比 `comparison.json`；完整业务导出 `business-verification.json`；冻结345文件终态 hash 全匹配。

## 最终构建与真实验证边界

真实任务使用冻结 JS bundle、当轮 Rust 测试宿主和同版本 SQLite 绑定，运行中未改变冻结代码。真实任务开始后，全仓回归又促成两处调整：`pi-conversation-runtime.ts` 明确区分未截断 JSON syntax 与输出截断，及对应 `agent-pipeline-remediation.test.ts` 断言。本轮真实任务没有走 JSON syntax／截断恢复分支；该最终分支经双协议105项恢复回归和最终全仓检查验证，**没有再付费重跑整集**。冻结源码与当前两文件差异记于独立核对结果，不把冻结构建冒充逐字等同于最终源码。

尚未真实覆盖：多读批次、prepared参数复用、第二 API 协议、主动压缩、模型切换、供应商限流／余额不足。相应自动测试与真实覆盖明确区分。没有安装、替换或重启用户客户端。

## 兼容与文件清单

无 DDL 或数据迁移。新增 executionLane 只在内部合同传输，不发送为供应商工具 schema 字段；preparedArguments、outputKey、artifact 均为可选协议扩展。旧完整参数、outputId 和 search→sourceHandle→read 保持兼容。旧数据、审计、正式正文不删除；持久候选复用原 Result Store，无第二份产物存储。CAS 冲突须先读取、由 Agent 据实决定，不能自动覆盖用户编辑。

相对本轮独立源码基线，23个源码／测试文件，新增1,028行、删除74行。基线仅包含 Worker 顶层文件，既有 experiments／fixtures 等子目录未计为本轮新增。不用当前整个 dirty 工作区冒充本轮改动；完整清单 `%TEMP%/agent-efficiency-source-changes.json`。

- 调度及协议：`packages/contracts/src/index.ts`、`apps/desktop/src-tauri/src/llm_stream.rs`、`apps/worker/src/agent-tool-registry.ts`、`agent-provider-tool-gateway.ts`、`pi-conversation-runtime.ts`。
- 候选与统一提交：新增 `agent-prepared-arguments.ts`；调整 `agent-provider-loop-service.ts`、`agent-business-execution.ts`、`agent-tool-definitions.ts`、`agent-task-deliverables.ts`。
- 直接读回与版本：`library-search-service.ts`、`production-skill-validation.ts`、`project-resource-map.ts`、`agent-system-tool-service.ts`。
- 请求投影：`agent-context-results.ts`、`agent-context-manager.ts`。
- 回归：新增 `agent-prepared-arguments.test.ts`、`agent-context-results.test.ts`；更新 Gateway、ProviderLoop、Pi、pipeline remediation、production skill validation 的测试及 Rust 协议测试。

旧的产物审查搜索前置、重复任务元信息投影、schema错误无条件缩批已替换；没有保留第二套等价执行服务。本轮增加的是参数持久引用与协议边界测试，不能为了代码净减少而删除必需保护或兼容接口。

## 最终门禁

最终 `pnpm test` exit 0，2,594 项通过：Worker 93文件／1,521项、Desktop 804、Persistence 101、Contracts 48、Context 32、Domain 8、Adapters 80。LLM包无测试文件，未编造通过项。完整日志 `%TEMP%/agent-efficiency-all-tests-final.log`；专项与全量重叠测试不相加。

全仓 typecheck、lint、format:check、build、cargo fmt --check、git diff --check 通过。Rust 204 passed／2 ignored／3 filtered，日志 `%TEMP%/agent-efficiency-rust-tests.log`；真实 opt-in另1 passed。TS最终分类调整后重新执行全仓类型、Lint、构建和全量测试。源码无变更后仅更新交付文档并检查格式。保留既有 Vite 大 chunk 提示与相关 CRLF 提示，未扩范围改动其他业务。

状态：E1–E5均已实现／已测试；本轮真实已验证计划键、直接读回、完成、实际落盘、强杀恢复及产物内容，其他未真实覆盖项见前文。无用户项目迁移、删除或自动改写，没有打包、安装或替换本轮客户端。

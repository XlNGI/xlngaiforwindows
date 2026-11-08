# Agent 重复读取循环修复

日期：2026-11-03。用户确认修复。沿用项目检索、按需正文、本地 SQLite、草稿/正式区分、用户原文完整保留及原授权/CAS 规则。

## 现场与设计

任务 `85a54ae6-4ab3-45ce-8210-8390aad9f6c8` 对三份未变化且未截断的文档各完整读取 14 次，共 42 次；自动整理 39 次后在 58,805 Token 处失败。助手可见记录明确反复说明正文被压缩后重新读取。没有图片准备调用。

1. 软阈值整理优先处理导航和已保存回执；能够放进真实窗口的唯一正文继续保留。只有必要输入超过可适配输出后的容量，才省略有版本定位的旧正文。最近两份结果及其完整结果引用仍受保护。已因整理而重新取得的正文在当前工作阶段保留，放不下时明确报告容量不足，避免循环驱逐。
2. 重复结果以实际内容、来源、版本、状态、范围及 IR 判断，忽略临时句柄和引用编号。复用仍发生在 Worker 原授权/版本校验之后。正文被省略时同步更新引用，防止引用到已省略的全文。
3. 同一证据在没有新的用户指令或成功业务进展时取得四次，发送前停止无效循环并保留进度。不同版本、分页范围及 IR 不合并；不恢复任务级总调用/整理次数上限。
4. 任务来源按来源类型、对象、版本、状态和结构节点合并，保留正文读取标记与精确定位；原始工具审计不改写。

## 顺序与验证

- [x] R0 现场只读审计、修改前副本及设计。
- [x] R1 修改前失败回归：双协议三份正文保留、重复调用检测及同正文新句柄复用；实施中补齐版本/分页/IR、引用完整性及来源合并。
- [x] R2 实施并通过聚焦测试；双协议 Native/Pi 检查实际发送的上下文及停止边界。
- [x] R3 全仓 test/typecheck/lint/format/build、生产 Worker 重建及离线验证；如实记录既有失败和生效条件。

不发起真实供应商请求，不重发历史任务，不直接修改用户项目数据库，不手动重启应用。当前任务的正文只来自已经授权的按需读取。

### R0–R2 验证记录

- 修改前现场只读核对三份原文的来源、版本、长度、未截断标记与调用审计；源码原始副本保存在 `C:/Users/MSI/AppData/Local/Temp/agent-repeated-read-20261103`。修改前回归 4 项失败、39 项通过，失败分别是双协议正文轮转、重复循环漏检及新句柄不能复用。
- 整理先处理导航和已保存回执；唯一正文只在真实容量不足时省略。重新取得的正文在当前阶段保留，仍放不下则发送前报告容量不足。最近短引用保护完整目标；旧引用的完整目标被省略时同步改成带版本/范围的省略记录。
- Gateway 只失效被整理掉的完整副本，其余副本继续复用。重复读取检测检查 Pi 原始工具历史，不会被整理或 `identical_result` 隐藏；新用户输入、成功业务进展可重新开始，加载工具和失败写入不能重置。
- Worker 相关七组共 170 项通过，Desktop 会话与时间线 53 项通过。双协议真实 Native/Pi 信封回归在软阈值以上保留三份 5,918／6,109／4,703 字符正文，接续 `tools.load` 与三次模拟图片准备；没有重复读取或正文省略。另用真实 SQLite 检索/授权/工具审计模拟固执重读，四次读取后、下次发送前失败，仅保留一条界面来源，四条原始读取审计完整保留。
- 版本变化、分页范围、正文/IR 变化不合并；成功保存与用户补充允许继续。无任务级总请求/整理次数上限，原有超过 24 次请求及多次整理测试继续通过。图片准备仅模拟免费意图回执，没有真实图片生成。
- 最后补齐真实进展边界：分段写入的新 `rowVersion`、新草稿版本及图片任务状态均可继续；相同保存/图片回执再次返回以及 `stage.get/list` 不会重置重复检测。新增四项回归通过，预算/Native/Pi 三组共 119 项通过。

### R3 最终验证（2026-11-04）

- `pnpm test` 全仓 2,190 项通过；最后增加四项真实进展边界测试后，最终 Worker 全量 83 个文件／1,193 项通过。其他套件未改动，最终套件合计 2,194 项（Context 8、Contracts 44、LLM 32、Desktop 750、Generation Adapters 79、Persistence 88、Worker 1,193）。
- 最终 `pnpm typecheck`、`pnpm build`、`git diff --check` 通过；本次修改的 12 个代码/测试文件 ESLint、Prettier 通过。全仓 `pnpm lint` 仍有 14 个既有错误：`.m2-ui-conversation-check` 四个临时夹具、`App.test.tsx` 三处、`ProductionPanel.audio.test.tsx` 两处，以及 `shot-binding-summary.ts`、`dubbing-service.test.ts`、`project-service.test.ts`、`request-validation.ts`、`scene-structure-submission-service.ts` 各一处。全仓 `pnpm format:check` 仍有八个既有文件：`media-confirmation.tsx`、`SceneCastEditor.tsx`、`SceneShotDirectory.tsx`、`context-service.ts`、`domain-tool-gateway.ts`、`dubbing-service.test.ts`、`dubbing-service.ts`、`project-library-query.ts`。这些原有修改未在本次修复中改写。
- 最终 `pnpm worker:sidecar` 成功，SHA-256：`5CDCBC79C7781D3DDED4A50C741CAF8A029066C877E20073FCD312F3F4467D7C`。生产 Worker 离线八组通过，`providerRequests=0`；报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-S5FCZj/report.json`。
- 开发监视器因构建产物变化自动重载：Worker 编译于 `00:09:20`，桌面进程 PID `119408` 于 `00:09:33` 启动，子 Worker PID `118760` 于 `00:09:34` 启动并运行 `node dist/index.js`，晚于最终编译。当前开发实例已加载本次修复；没有手动终止/重启、历史任务重发或真实供应商验证。发布安装版需使用本次重建的 Worker。
- 日志保存在 `C:/Users/MSI/AppData/Local/Temp/agent-repeated-read-*.log`；`test.log` 为全仓结果，`worker-final.log` 为最终 Worker 全量结果，其他日志分别记录聚焦回归、类型、构建、代码规范、生产重建与离线验证。

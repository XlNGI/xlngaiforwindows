# Revision 34：Native 真实结构闭环

本次第一次在 Native Worker 入口完成真实供应商调用、结构封包、事务保存和 Worker 关闭后的独立 SQLite 读回。Agent task 用时 **377.530 秒**，Native Rust 测试用例用时 **379.25 秒**。12 个候选对象全部结构通过，保存回执唯一，独立读回 0 失败；数据库 `quick_check=ok`、外键错误 0、待办 0。按用户已确认的范围，只做结构校验，没有做提示词内容或语义审查。

完整机器记录见[JSON 证据](./2026-11-10-one-click-bundle-revision34-real-acceptance.json)。真实入口为 Native Rust 的 `context_management_real_bundle_agent_run`，由该宿主调用和 Desktop 按钮相同的 Worker `agent.run` RPC；没有物理点击 UI，也没有运行或替换安装实例。Provider 为 `ergou-gpt-chat` 配置对应 ID、模型 `gpt-5.6-terra` 配置对应 ID、Chat Completions 协议。使用新隔离目录 `C:/Users/MSI/AppData/Local/Temp/p22-bundle-real-20261110-revision34-a/app-data`。

请求基线与此前成功样本相同：完整提示词 SHA-256 为 `6e9f648565c60ed0c416901d39fd3ff9b25056adb9e4ff94231d2c9929aa280f`，9,034 个 Unicode 字符；固定同一供应商、模型及一份已选源稿版本。输入数据库由 `revision33-a` 用 SQLite backup API 复制到全新目录，副本启动前有 3 份源资料、0 场次和 0 镜头。调用期间未修改原项目或旧验收目录。

成功结果包含 7 份本次新建提示词资料（角色 2、地点 3、道具 1、音色 1）、2 个剧情场次和 3 个镜头；与原 3 份资料合计为 10 份文档。整包 revision 1 一次事务提交，生成唯一业务提交回执。关闭 Worker 后用只读 SQLite 连接重新打开数据库，再运行独立 `readbackBundle`：`bundle_readback_verified`、12 个对象、0 failures，pending deliverables 为 0。

15 次 Provider 请求中有 14 次返回 Token 用量；累计输入 371,932、缓存输入 99,682、输出 11,357 Token。另一请求因 Native `WINHTTP_RESPONSE_HEADERS` 传输失败；Runtime 对相同 108,415 字节、相同输入 hash 的请求重试一次后成功。全程有 5 次结构化工具参数拒绝，均未写入错误业务数据，Agent 随后恢复。触发点依次为旧形状整包参数、对不适用操作使用 prepared-argument 补丁、单次提交 13 个对象超过 12 项上限、向只有 12 项的数组写入 `/prompts/12`，以及把 `complete=false` 当作非最终分包标记。当前工具合同规定中间分包省略 `complete`，仅最终分包传 `complete=true`。最终候选成功封包，只有 1 次业务 commit。

每次 Provider 请求前账本均记录完整请求输入 Token 估算。14 次有实际用量请求的估算合计 396,751 Token，实际输入合计 371,932 Token；本地估算在个别请求低于供应商报告值，汇总高约 6.7%。上下文窗口记录为 512,000 Token；请求使用一次上下文整理，没有任务累计输入 Token 上限，真实累计输入通过 2M。

相同提示词 hash、供应商、模型和源版本的 `revision33-b` 成功运行耗时 987.872 秒，保存 10 份新增资料、4 个场次、13 个镜头。revision 34 是 377.530 秒，保存范围为 7 份资料、2 个场次、3 个镜头。两次范围不同，不是配对实验；只能记录各自结果，不能据此宣称稳定提速或 SLA。

离线验证方面，Worker 全量测试 1,556 项通过；随后针对参数签名和格式清理的 7 组定向测试 228 项通过，类型检查、Lint、格式及 workspace 构建通过。Native 真实测试为 1 passed。构建输出有 Vite 主 chunk 大于 500 kB 的既有提示。

尚未覆盖真实无声／无道具样本、超过每次 12 项上限的真实多批分包，以及第二个同范围成功样本。此前真实失败记录保留为历史证据；revision 34 没有内容审查或人工改成功状态。

# Agent 上下文重复计数修复

日期：2026-11-02，验证完成于 2026-11-03。顺序：审计 → 设计 → 失败回归 → 实施 → 验证。

## 审计

只读查询真实项目，截图对应 generation `75e38971-cf6e-4779-9294-1043ea682155`。两次模型请求成功；读取 `shot.continuity.read` 后，第三次请求在本地准备阶段失败，尚未发送 Provider。错误：估算 46,868 Token 超过输入预算 44,800。当前模型窗口来源为 `fallback`，64,000 不代表已核实的 GLM-5.2 官方上限。

输入预算：64,000 − 输出预留 16,000 − 协议余量 3,200 = 44,800。失败请求分段：系统 8,724、工具 4,599、原始输入 6,636、历史 14,219、3 张图片共 12,288，加少量协议开销。`measure` 将原始 `runtime.prompt` 和 Pi 第一条相同 user 消息重复计数；原生请求只有一条原始用户消息。当前 continuation 的补充文本也可能同时存在于历史与 `userMessages`。

`context` 分段为 0（冻结目录已合入 system），不是整库正文自动注入。会话约束 6,940 字属于用户输入，必须完整保留。没有证据支持删除图片、用户要求或放大未知模型窗口；此前相邻的 Provider HTTP 500 是另一类故障。

## 设计

- 只修复预算诊断，不修改真实请求、会话历史、用户输入、图片、模型配置或安全余量。
- Pi 历史首条 user 文本与 `runtime.prompt` 完全对应时，预算由 `user` 分段计入，历史不重复计入；不能凭文本相同删除后续用户消息。
- continuation 待发补充若完整对应 Pi 历史末尾连续的 user 消息，预算只计入历史；未出现在历史的待发补充仍完整计入。按顺序和出现次数比较，不使用集合去重，不合并用户重复发送的同样文字。
- 保留两协议远端上下文估计、最近读取／约束保护、版本／CAS／已保存进度、输出和协议余量、图片每张 4,096 的保守额度。Responses 整理后仍按实际重建请求复核。
- 回归覆盖截图相同规模的系统、输入、工具和三图，证明修复前误拦截、修复后未删改请求；补充在有／无历史两种情况下均计数，重复补充的次数保留，真正超预算仍明确拒绝。

## 检查清单

- [x] C0 审计与修改前副本、SHA256 清单。
- [x] C1 设计，保持检索计划与上下文计划既有要求。
- [x] C2 先运行失败回归，记录重复计数证据。
- [x] C3 实施并运行两协议、图片、补充、压缩／拒绝回归。
- [x] C4 相关运行时集成、全仓测试／类型／构建及静态门禁已执行，记录既有失败和生效条件；不代表全仓门禁全部通过。

审计副本：`C:/Users/MSI/AppData/Local/Temp/agent-budget-audit-39037bff/`。不修改真实项目或设置数据库，不重发失败任务，不调用真实 Provider，不手动重启用户应用。

C2：修复前新增 4 项两协议回归全部失败。三图请求被错误估算为 46,419 > 44,800；同样两条补充仅因同时出现在续轮字段，估算从 22,228 增为 29,429。日志：`C:/Users/MSI/AppData/Local/Temp/agent-budget-repro.log`。

C3：哈希比对确认真实请求的原始消息与 `user` 分段相同，Pi 首条结构化 user 又完全匹配 `history` 分段，重复 20,165 字节。修复只在估计副本中排除重复，真实输入／历史不改写。两协议三图 Native/Pi 集成测试完整保留原始长输入、唯一读取正文和 3 张不同图片，模拟模型请求继续完成；没有真实 Provider 调用。补充匹配按末尾连续消息的顺序和次数判断，不匹配或缺少历史时继续计入。

## C4 最终验证记录（2026-11-03）

- 预算单元与 Native/Pi 续轮专项 37 项通过（21 + 16），覆盖两协议与三图完整传递。全仓 `pnpm typecheck`、`pnpm build`、本次 3 个 TypeScript 文件的 ESLint、本次 6 个文件的 Prettier、`git diff --check` 通过。
- `pnpm test`：2,093 项通过、2 项既有失败。分包通过数为 Context 8、Contracts 44、LLM 32、Desktop 713、Generation Adapters 79、Persistence 87、Worker 1,130。失败均为 `agent-pipeline-remediation.test.ts` 的两协议旧资料整理用例：估算 28,001 超过 28,000，断言预期 `complete`、实际 `failed`。本轮不放宽预算或改动这些夹具。
- 全仓 `pnpm lint` 仍有 14 项既有错误；`pnpm format:check` 仍有 8 个既有文件未通过。均在本次修改范围外，不把全仓门禁记为全绿。
- `pnpm worker:sidecar` 重建成功。生产 Worker SHA-256：`D2A8EAA012F1C4DD91CF15090BF4C7F28883A79315B6ACDC7D57F1DF8735D5DA`。仅保留既有 Vite 包体积及 SQLite prebuild 提示。Rust 源码本轮未修改。
- 构建触发已有 Tauri 开发环境自动重载。新 Desktop PID 117172 于 00:08:51 启动，新 Worker PID 103236 于 00:08:52 运行 `node dist/index.js`，晚于预算模块 00:08:38 的构建时间；当前开发实例已加载修复。未手动重启，未重发历史任务，未调用真实 Provider。生产安装实例须使用包含新 Worker 的版本；本轮没有重新生成安装包。

验证日志位于 `C:/Users/MSI/AppData/Local/Temp/`，文件前缀为 `agent-budget-`：`focused-final.log`、`typecheck.log`、`all-tests.log`、`lint-all.log`、`format-all.log`、`eslint-final.log`、`format-focused.log`、`diff-check.log`、`build.log`、`sidecar.log`。离线回归验证了请求不再被重复计数误拦截，不代表真实供应商调用或提示词保存已成功。

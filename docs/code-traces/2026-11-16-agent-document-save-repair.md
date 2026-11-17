# Agent 新建文档空版本字段与恢复修复

## 现场证据

只读检查项目日志：首次 `document.submit_draft` 已携带完整正文（5268 个 UTF-16 码元），同时携带 `baseVersionId: null`。新建分支禁止该字段，Schema 拒绝；随后 `preparedArguments={resultId}` 复用原参数，未删除空字段，再次拒绝。最终模型重发整篇正文并省略该字段，才保存成功。引用解析本身成功，错误在于参数未被修正。

日志事件时间：首次生成约 162.09 秒；首次拒绝到最终保存约 136.9 秒；成功保存工具 started/succeeded 相差约 2 毫秒。该事件差值不是精密基准。保存后另有约 138.85 秒的模型 review 请求，本次不改变 review 语义，不承诺写作或审阅达到毫秒级。

## 不变量、契约与所有权

- 只规范化 `document.submit_draft` 中明确的新建工作区（documents/characters/novel）、没有 documentId、没有 expectedDocumentRowVersion 且 baseVersionId 为 null 的调用。空值等同于缺省；非空版本与真实目标 CAS 不自动删除、替换或刷新。
- 输入及已持久化的原始候选不变；正文、输出槽位和项目 revision 原样传递。规范化幂等，不请求模型，不写数据库。原始 Schema 与领域保存校验继续验证规范化后的参数。
- 含真实源版本或错误行版本的新建调用仍拒绝；错误指引给出实际存在字段的显式 deleteFields，由模型决定是否采用。已有文档或目标不明确时不建议删除版本字段。
- 原有任务/工具/项目范围、完整性、授权、幂等、回读及审阅门禁不变。继续复用当前项目 SQLite 的 Result Store，不另建正文存储。

## 状态与故障矩阵

| 输入/故障 | 行为 |
| --- | --- |
| 明确新建且仅有空 baseVersionId | 本地省略空字段，继续正常校验与保存 |
| 已有文档的 null 或非空 baseVersionId | 保留原 CAS；由 Schema/领域层校验 |
| 新建带真实版本、行版本或有歧义目标 | 不自动修正；拒绝后保留原候选 |
| prepared 引用与修正 | 校验范围和完整性后合并，再规范化；原候选不变 |
| 重放、重启、取消、切项目 | 不新增异步状态；沿用既有执行槽位、持久化和会话令牌隔离 |
| 关闭/断网/超时 | 本地规范化无外部请求；模型与保存事务继续遵守既有状态机 |

## 追踪与验证

| 不变量 | 实现 | 验证 |
| --- | --- | --- |
| 无歧义空字段本地处理，真实 CAS 保留 | prepared resolver / Provider gateway | gateway、prepared arguments 回归 |
| 失败指引可直接执行，无需重发正文 | gateway preparedInstruction | 从错误提取引用后实际执行 prepare |
| 两协议一次保存、重放不重复、重开完整 | Native scripted bridge → Pi → Worker → 临时 SQLite | pipeline 回归 |

## 验证结果

- 修复前：新增 gateway / prepared 回归 2 项失败，现场原因已复现；修复后两文件 38 项通过。
- 新增两协议 Native scripted bridge → Pi → Worker → 临时 SQLite 回归通过：首个带 null 的提交直接保存，无 validation failure，不需要模型修参；随后用省略字段的规范参数主动重放，同槽位仍是一份文档、一个版本，重开后正文与 draft 状态完整。另在原两协议直接 Worker 输出槽位回归中加入 null，验证绕过 Gateway 的入口也正确处理。
- 源码冻结后 Worker 全量：101 文件 / 1,621 项通过、0 失败；退出 0，耗时 427.97 秒。日志 `%TEMP%/agent-document-save-worker.log`。这是本轮实际执行结果，不把上一轮其他包及桌面测试冒称为重新执行。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check`、`pnpm build`：通过；本轮未修改 Rust，未重复执行 Rust 单元测试。生产构建保留已有 Vite 大 chunk 与 Rust 警告。
- `pnpm tauri:build`：退出 0；包含 Worker Sidecar、桌面前端、Rust Release 与 NSIS。日志 `%TEMP%/agent-document-save-package.log`。
- 本轮构建的 Sidecar：单项目兼容、多项目隔离、两协议制作链、独立重开读回、丢失应答重放、多段提交通过。日志 `%TEMP%/agent-document-save-sidecar-{single,multi,bundle}.log`。脚本 host，无真实模型/媒体调用；报告 Sidecar 摘要与实际构建文件一致。

## 交付产物

`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup-agent-document-save-fix-20261116.exe`，77,296,486 字节。

- 安装包 SHA-256：`C7AFED0C4B5D0C35133236A82CB0F4B8698DCA2F220C16755176956308BDB1D1`。
- Sidecar SHA-256：`E409DAC9F8E8F761E4FC52D406801A46705B1335C80A10B1182E4F2492486D2B`。
- 桌面 EXE SHA-256：`ABC9FE307B493CABE0C3FF27373FF55C466F353D2E4AD3E0E26D088A555AB5DA`。

未安装、覆盖、关闭或重启用户正在运行的实例，未修改现场项目与任务。该包承接上一轮 Native 字段修复；真实模型配对速度与内容验收仍需安装后验证。当前证据证明这条确定的参数失败链已消除，不能据此推断写作、审阅或其他格式错误全部消失。

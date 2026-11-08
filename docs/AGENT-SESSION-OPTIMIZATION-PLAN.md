# 会话保存回执与上下文优化

日期：2026-11-04。用户在完成只读会话审计后确认“开始优化”。沿用当前工作区，保留此前全部未提交改动。

现场：单镜头修改已经保存为 rowVersion=2，续轮仍重复写入旧版本，随后历史累计到 59,300 Token 而失败。64,000 是未核实模型的回退窗口，最大自适应输入为 58,752；旧错误只显示初始 44,800。另一次媒体读取自动附带四图后连续 HTTP 500，不能据此认定图片导致供应商错误。

## 不变量

- 用户原文、补充、约束、显式图片完整保留；正文按需检索，草稿/正式标记、本地 SQLite 索引、授权、版本与 CAS 检查不变。
- 原始工具审计不改写；成功写入保留准确回执和产物版本。局部保存与整任务完成分开，不因保存成功强制终止其他工作。
- 不假设未知模型窗口，不编造厂商推理参数，不调用真实 Provider、不重放历史任务、不直接修改真实项目/设置数据库、不手动重启应用。
- 制作读取提供精确目标、真实 ID、行版本与视图；结构化分页保留完整记录及版本检查，旧字符分页仍明确单位。

## 顺序清单

- [x] O0 只读审计和修改前备份。审计在系统临时目录 `agent-session-readonly-audit-20261104-lNJY9f`；源码副本与 hash 在 `agent-session-optimization-20261104`。
- [x] O1 保存回执：先复现后修复，保留 executionId、镜头/场次 ID、新版本及 changed/unchanged；最近回执原样保留，可独立压缩已保存调用的大参数。
- [x] O2 精确读取、完整记录分页、真实 Schema 边界及旧版本读取安全整理；验证双协议、版本变化、隔离与重读保护。
- [x] O3 查询持久化成功回执并显示局部保存，继续指令定位原 generation，先核对仅完成余项；连续性图片改为显式读取，保持来源校验和用户图片。
- [x] O4 预算诊断：显示初始/最大输入、安全余量、缺口、窗口来源及分段估计；区分本地预算拒绝与桥接/Provider 失败，展示现有推理用量。推理设置仍使用已支持的 provider_default。
- [x] O5 聚焦及全仓测试、类型、Lint、格式、构建、生产 Worker 重建和离线验证已执行；本次改动通过，范围外的全仓 Lint／格式失败及生效限制记录如下。

本计划为既有检索及上下文计划的顺序补修，无新的存储或检索产品规则，无对应 DOCX。

## 图片附件类型补修（2026-11-04）

现场任务 `b1decf22-9de0-44af-8af3-a36ae8b373b1` 先发生两次图片准备参数拒绝，随后本地估计 59,012 Token，超过最大输入 58,752（缺口 260）。只读核对用户引用的原文件为有效 PNG，2,358,559 字节；聊天端会按现有传输规则将它压缩为 JPEG，但仍发送原 `image/png`，Worker 因外层 MIME 与已验证的 JPEG 数据不一致而拒绝。未持久化历史附件数据，原始发送字节不作已恢复声明。五张连续性图片由模型显式 `includeImages=true` 获取，不是每轮自动上传整库文档。

- [x] A0 只读核源及修改前备份。源码副本和 hash 在系统临时目录 `agent-attachment-mime-repair-20261104`。确认原文件有效 PNG，代码可确定复现压缩后类型未更新。
- [x] A1 修改前 Desktop 2 项、Worker 2 项均复现 MIME 不一致；修复后压缩上传与序列化 2 项、图片/视频附件处理 2 项通过。类型跟随实际编码；Worker 保留签名、大小、哈希和附件白名单校验，冻结媒体文件字节及规范 MIME 与输入逐一对照。
- [x] A2 修改前两协议的隔离 SQLite 准备均拒绝；修复后各一次准备即打开选择表单，只产生一份选择记录和工具审计，不产生媒体任务及付费调用。4 项错误编码/损坏数据回归通过；其他未冻结图片仍拒绝，原提示词和图片完整保留。
- [x] A3 聚焦 10 项、Worker 全量 84 文件 / 1,215 项、Desktop 全量 83 文件 / 755 项、contracts 44 项通过；全仓类型检查、临时目录 Worker/桌面构建、变更格式和 diff 检查通过。全仓 Lint 仍为原有 14 项，格式仍为原有 8 文件，细节与生效限制如下。

本补修纠正已有附件传输合同，不扩充模型窗口、不降低未经核实的图片预算、不删除失败提示词历史或用户图片，不改变检索、存储及 DOCX 产品要求。

### A3 验证及生效边界

- `pnpm typecheck` 通过；Worker `tsc --outDir` 和 Desktop `vite build --outDir` 均输出到系统临时目录 `agent-attachment-mime-repair-20261104`，构建通过，保留已有 Vite chunk 大小提示。未重新构建或替换项目生产 `dist`、sidecar 或安装包。
- `App.tsx`、Worker 服务及两份 Worker 测试定向 ESLint 通过。`App.test.tsx` 仍有 3 处既有断言错误，已对修改前备份执行相同 ESLint 核对（原行号 256、1437、1548），新增代码无 Lint 错误；全仓总数保持 14。变更文件 Prettier 和 `git diff --check` 通过，全仓格式仍有原 8 文件。
- 测试日志：系统临时目录 `agent-attachment-desktop-red.log`、`agent-attachment-worker-red.log`、`agent-attachment-loop-red.log` 保留修改前失败；`agent-attachment-desktop-focused.log`、`agent-attachment-worker-focused.log` 保留聚焦通过；`agent-attachment-worker-all.log`、`agent-attachment-desktop-all.log`、`agent-attachment-contracts.log` 是最终全量结果。类型、临时构建、Lint、格式日志均使用 `agent-attachment-` 前缀。只读现场摘要在备份目录 `audit.json`，不保存附件正文或凭据。
- 14:07 和 14:09（UTC+08:00）只读核对发现真实生成持续运行，因此只验证隔离构建，未手动重启应用或触发 Worker 重新加载。界面源码可由现有开发服务器加载；运行中 Worker 的后端修复尚未部署，不能声称当前窗口已经验证修复。此次真实生成未用于回归，未发起真实 Provider 调用、重放任务或修改真实项目/设置数据库。

## O1–O4 验证记录

- 双协议保存回执回归修改前均失败（执行 ID 和 shots 新版本丢失）；修复后通过。旧结果摘要保留完整 shots 数组；最近两份回执不替换，已保存长参数独立压缩；原始 Pi/工具审计保持不变。
- 单镜头查询/完整记录分页回归修改前失败；修复后验证 25 镜跨页、实际 CAS/父场次、版本变化拒绝、recordLimit 上限、媒体记录及尾页单独读取不冒充整份已读。默认结构/媒体/问题视图按完整记录分页；字符分页兼容保留并标明 UTF-16 单位。
- 双协议旧制作正文整理回归修改前失败；修复后保留 target/version/CAS/锁定字段，软阈值不驱逐唯一正文；旧结构/媒体数组可无损表格化并已逐字段解码对照。版本/视图/目标/页范围变化不会被相同证据引用合并。碎片 JSON 无法识别保护字段时保留原文。
- 双协议真实临时 SQLite → Worker 授权 → Pi → Native 模拟 Provider：只读一次目标镜头、只保存一次；发送压缩后的准确成功回执后模拟最终 HTTP 400，任务保持失败且标为 partial。新任务 inspect 能读到原执行 ID、镜头 ID 和新版本，无重复产物、无再次写入。
- 回执读取按当前项目和 task/generation 筛选，仅成功保存；按最多 20 条且约 16 KiB 分页，不混入正文/凭据。25 次 × 30 镜的回执分页测试逐一校验 ID/版本；失败、只读 stage、损坏 JSON 和其他项目均排除。
- 连续性现有双协议真实本地帧测试通过：默认 metadata 无图片；includeImages=true 才读取像素，保留来源令牌、CAS、视觉能力检查、图片大小与脱敏审计。全组 20 项通过，未改变素材选择/绑定/生成流程。
- 双协议精确 59,300 Token 回归确认：初始 44,800、自适应上限 58,752、安全 3,200、最低输出 2,048、缺口 548。桥接回归确认本地预算拒绝标记 local_context，0 次传输。预算及桥接两组 102 项通过；新增制作表格回归随后通过。用量界面展示分段估计及现有推理用量，未添加厂商推理参数。
- 后续补齐双协议真实账本回归：本地预算拒绝保留完整用户原文，实际 Provider 请求数为 0，失败来源及预算参数进入持久化账本。还修正了真实镜头回执的进展识别：使用嵌套 `shots[].rowVersion` 区分后续保存，同一版本仅换 executionId 不算进展；该回归修改前失败、修改后通过。最终预算组 51 项、会话与用量 UI 44 项通过。

## O5 最终验收记录

本次修改范围完成；全仓门禁仍有既有 Lint／格式问题，未声明全部门禁通过。

| 检查 | 结果 |
| --- | --- |
| 包测试 | 共 2,209 项通过：context 8、contracts 44、LLM 32、Desktop 751、generation-adapters 79、persistence 88、Worker 1,207 |
| Worker 最终全量 | 冻结源码后重新启动完整测试，84 个文件、1,207 项通过；日志 `C:/Users/MSI/AppData/Local/Temp/agent-session-worker-current.log` |
| 类型 | `pnpm typecheck` 通过 |
| 本次文件检查 | 修改的代码文件定向 ESLint 通过，Prettier 通过；`git diff --check` 通过 |
| 全仓 Lint | `pnpm lint` 仍有 14 个既有错误，均在本次范围外，未为清空门禁改写其他工作 |
| 全仓格式 | `pnpm format:check` 仍有 8 个既有文件不符合格式，均在本次范围外 |
| 生产构建 | `pnpm build` 通过；保留 Vite 现有 chunk 大小警告 |
| Worker 打包 | `pnpm worker:sidecar` 通过，生成 Windows x64 可执行文件 |
| 打包离线验证 | `node apps/worker/scripts/validate-llm-intent-sidecar.mjs` 退出码 0；两协议 × 两入口 × 有／无 hint 共 8 组通过，`providerRequests=0` |

包测试最初有 4 项旧工作流文案断言失败，已随精确镜头读取说明更新；最终 Worker 全量通过。其余包的通过结果见 `C:/Users/MSI/AppData/Local/Temp/agent-session-test.log`，该文件同时保留修正前的 Worker 失败，不作为最终 Worker 结果。类型、构建、打包、离线、Lint 和格式日志分别为同目录的 `agent-session-typecheck.log`、`agent-session-build.log`、`agent-session-sidecar.log`、`agent-session-offline-validation.log`、`agent-session-lint.log` 和 `agent-session-format.log`。

既有 Lint 错误分布：`.m2-ui-conversation-check` 四个临时 UI 文件、`App.test.tsx` 三处断言、`ProductionPanel.audio.test.tsx` 两处无 await 的 async，以及 `shot-binding-summary.ts`、`dubbing-service.test.ts`、`project-service.test.ts`、`request-validation.ts`、`scene-structure-submission-service.ts`。既有格式文件：`media-confirmation.tsx`、`SceneCastEditor.tsx`、`SceneShotDirectory.tsx`、`context-service.ts`、`domain-tool-gateway.ts`、`dubbing-service.test.ts`、`dubbing-service.ts`、`project-library-query.ts`。

打包产物为 `apps/desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe`，76,546,566 字节，SHA256 `A9681DF640ACA17B04DAB2A548918C9A6136D93AE0E7E4E91E225EAB7D4EC53D`。离线报告为 `C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-efnQrV/report.json`。离线用例直接验证打包 Worker 的工具与版本／绑定行为；模型保存回执、预算整理和续接行为由上述模拟 Provider 的双协议集成测试覆盖，不将直接工具调用算作真实模型验收。

只读进程核对：本机时间（UTC+08:00）12:23:21 编译 Worker，12:23:38 现有开发监听器启动桌面进程 PID 123768，12:23:39 启动其子进程 PID 121552，命令为 `node dist/index.js`；该开发 Worker 的启动晚于本次编译。未手动重启应用，未制作或安装新的桌面安装包。

验证使用隔离临时项目和模拟 Provider；未调用真实供应商、未重放历史任务、未直接修改真实项目或设置数据库。真实供应商的延迟、费用、缓存率和画面质量未验收；未知模型仍使用已标识的回退窗口，不承诺任意长度会话都能发送。

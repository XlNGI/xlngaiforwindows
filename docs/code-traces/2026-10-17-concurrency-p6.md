# 并发 P6 验证与发布门禁

日期：2026-10-17。代码实施与可自动化验收已完成；完整发布签收为 HOLD，本文明确区分已执行与未执行的门禁。

## 最终状态与迁移

项目 Schema v53，应用 Schema v8。承接工作前已有大量未提交的 Rust、媒体合同、检索及 UI 修改；本轮保留这些变更，没有 reset、提交、推送或发布，没有修改用户真实项目，也没有真实付费调用。

v50 调度、v51 消息边界、v52 小说批次、v53 文件 owner 的新库、增量升级、重复迁移、故障回滚与完整性检查均有自动化证据。已有 ProjectService 升级备份继续生效。v53 数据不能交给旧二进制直接写；降级须使用升级前备份并核对新版本接受的远端任务，不删除 unknown/remote ID 记录来假装未提交。

## 故障与压力结果

| 门禁 | 实际证据 |
| --- | --- |
| 不同项目执行、卸载与旧 epoch | Runtime IPC 集成证明 A/B 分别写回；卸载 A 不影响 B；排队与迟到请求拒绝接管重开的 A |
| 同会话并行、有序跟进及补充 | 实际 agent.run / Pi / Native bridge 模拟请求重叠；有序跟进等待指定前置；补充只在轮次边界消费且不改变已发送请求 |
| 分支隔离 | 普通上下文与 library 内容/结构 search/read 排除其他活动分支，包括子 artifact task 经 parentTaskId 归属的草稿；之后完成入库也不扩大旧分支边界 |
| 独立确认与取消 | owner/token 队列，不串 resolver；等待人工确认释放文本名额，继续前重新取得许可；拒绝后保留无工具权限的最终文本 Provider step |
| 工具与业务容量 | 文本实测 2/project、4/app；只读工具实际重叠峰值 4；媒体提交和下载分别限制 2/app；语音/口型分别 2/app；FFmpeg 与文件阶段分别 1/app |
| 队列上限与公平进展 | 第 33 个项目任务拒绝；32 个排队任务全部取消且备份副作用为零；80 个跨项目文件任务全部完成；并发文本池 4 个项目各完成 20 项 |
| 响应延迟 | 80 项文件任务压力期间通过零时限定时器测量 health 完成延迟，样本 p50 11.45 ms、p95/max 17.05 ms；另有实际 64 MiB 导出期间 health <500 ms、B 项目短写和 A 导出取消回归。数据是本机样本，不是 SLA |
| 未知提交与恢复 | 超时/中断且无可核实远端 ID 时保存 unknown，禁止自动重发；已知 ID 只回查；取消排队项 Provider 为零；重复确认和完成不重复副作用 |
| 小说依赖与冲突 | draft/published 独立门槛、固定版本来源按需读取；同章锁/CAS 有效；完整冲突候选保留且原正文不变；取消无正文占位归档 |
| 图片和配音 | 多图全成后原子入库/失败补偿；并行片段倒序完成仍保持时间轴；慢口型不阻塞另一任务语音；unknown 片段不进入合成 |
| 文件与迁移故障 | 导出引用/hash 完整或明确失败；非空目标保留；导入取消零部分章节/索引；Markdown 异步写、实际回读校验、目录身份保护与重启 manifest 对账 |

## Windows Edge 双页面验收

运行 `apps/worker/scripts/validate-concurrency-browser.mjs`，使用实际构建的 Desktop 页面、真实 Worker 服务和模拟 Native Provider。Windows Edge headless 的两个独立页面通过：跨会话重叠、同会话显式并行、跨项目重叠、两项确认互不影响、仅停止选中 generation、关闭页面后 Worker 完成、刷新恢复本窗口原项目、刷新不重复提交 Provider，以及分支输出归属。页面错误列表为空；最终结果和确认截图已检查。

验证过程中实际发现并修复了拒绝确认缺少最终 step、并行分支非选中完成消息漏合并，以及窗口刷新取 Worker 全局 active 而丢失本窗口项目的问题。测试不把两次孤立 render 当作双页面验收。

复跑命令：

```powershell
$env:CONCURRENCY_BROWSER_NODE_MODULES='C:/Users/10698/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
node apps/worker/scripts/validate-concurrency-browser.mjs <独立验收输出目录>
```

截图与报告位于本任务外部验收目录 `C:/Users/10698/.codex/visualizations/2026/10/17/01a147d6-541f-7672-9a4d-c85dc20359ae/concurrency-qa`。这是浏览器/Worker 集成证明，未冒充真实 Tauri 窗口拖拽、休眠或干净系统安装验证。

## 完整质量命令

已执行：`pnpm build`、全仓串行文件测试、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check`；Rust fmt/check/test；`pnpm media:verify`、`pnpm worker:sidecar`、`pnpm tauri:build`；license 与 SBOM。

固定代码状态的最终全仓回合 1,405 项通过：Context 8、Contracts 24、LLM 32、Desktop 439、Generation Adapters 59、Persistence 70、Worker 773。随后补充图片取消后迟到 Native 文件清理，Image/Media 65 项通过（新增 1 项）；错误路径先复现，再修复并复验。Rust 157 项通过、1 项既有真实网络用例忽略。末次修改另有 Agent/Generation/Pi 148 项、App 80 项、Dubbing 21 项与容量/项目回归通过。

最终打包 Sidecar 通过多项目和单项目兼容脚本、M7 离线样例/诊断脱敏/完整性脚本，以及实际随包 FFmpeg 配音脚本（schema 53、paidRequests=0）。配音脚本修复为等待进程 close 并对 Windows 临时可执行文件解锁进行有限重试，避免成功验收后清理偶发 EBUSY。未打开项目时的 dubbing.runtime.get 兼容查询也已恢复。

## 依赖与安装包

`pnpm audit` 多次因其请求链 `fetch failed / ECONNREFUSED` 未能完成，不能写作通过。使用同一生产依赖树直接请求 npm 官方 bulk advisory API：96 个包名、97 个版本，返回 0 条公告、0 项 high/critical；没有忽略已返回的漏洞。独立可复跑入口：

```powershell
pnpm.cmd list -r --prod --depth Infinity --json > <临时生产依赖清单.json>
node scripts/audit-production-advisories.mjs <临时生产依赖清单.json> <可选报告.json>
```

license 检查通过 35 个直接许可条目；CycloneDX SBOM 已重新生成并格式化。Vite 大 chunk 提示、Rust 两处既有 atomic API 弃用与一个既有 release unused 变量警告仍存在，不影响本轮构建；本轮未顺手修改这些既有代码。

NSIS 安装包已生成：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，74,898,928 字节，SHA256 `396ed91e74e0ea1f9798d13614931ecded8482095344078e197d4fdc20454364`。Worker EXE SHA256 `d605f1246522f5a4b70baa7f2d5e89cf4993f192fdfdead5bb9938d3c99d5754`。只构建本地包，未安装、签名、上传或发布。

## DOCX 同步与尚未通过的完整签收项

素材库两份计划及通用文档工作流的 Markdown/DOCX 已同步追加同一并发实施说明，复读验证正文一致。未将渲染写作通过：按 documents 技能调用官方 render_docx.py 后，环境明确返回 `LibreOffice soffice.exe was not found on PATH`；Word COM 也不可用。

以下保留未完成：真实 Tauri 多窗口/系统休眠恢复、干净 Windows 安装、上一发行版升级与回滚、正式签名，以及 DOCX 逐页渲染/视觉验收。真实付费 Provider 已按范围排除，模拟调用不替代账号质量验收。P6 自动化完成不等于上述完整发布签收，计划总完成项保持 HOLD。

最终补记：全仓 Typecheck、ESLint、Prettier 与 diff 检查通过。NSIS 包已在最后的图片清理修复后重建，本文 hash 对应该包；重建后的多项目/单项目和配音 Sidecar 复验通过。未自动安装应用或替换用户现有版本。

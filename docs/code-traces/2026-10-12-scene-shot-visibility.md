# 场次与镜头：结构、工具与产物可见性

日期：2026-10-12（America/New_York）

## 问题和证据

用户反馈「提示已生成，页面里却找不到」。只修复父场次 ordinal 不足以覆盖此问题。代码检查确认：普通会话没有场次/镜头提交工具，`document.submit_draft` 却能接受独立 storyboard 文档；镜头页实际读取 `scenes` / `shots`，并不显示独立文档。资源目录只把镜头挂在页面下，没有父场次 ID。生成完成只刷新文档；待审核方案面板只在挂载时加载；批准方案后没有刷新 App 场次/镜头状态。

以上是可复现的代码缺口，本次未读取或修改用户项目数据库，不将其当作用户这次真实模型调用的审计证据。

## 实现

资源目录明确场次→镜头关系、真实 `sceneId` / `shotId` 和父资源 ID；空镜头页也说明写工具及审核流程。普通会话授权 `scene.submit_structure`，以 `resourceId=workspace:shots` 提交场次树，每镜头有独立提示词。目的地、revision、执行身份、嵌套结构及引用校验与变更集保存同事务完成。正文仍按需检索，未增加关键词语义路由。

返回真实 `changeSetId`、`locator.workspace=shots`、`reviewRequired=true`、`applied=false`。方案沿用现有 ChangeSetService，用户批准前不写场次/镜头实体。独立 storyboard 新建调用明确失败并指向结构工具；已有文档保留。普通任务详情列出本任务方案，生成完成按该 ID 打开并展开方案。面板支持重新加载，批准后按实际 `appliedEntityId` 刷新目录和提示词，并排除过期项目/请求。

旧显式授权结构工具与 Pi 计划工具的父场次 ordinal 已修正为混合列表中的场次位置，多场次回归验证批准后每个镜头归属正确。共享结构解析和引用校验提取到 `episode-structure.ts`，新工具复用相同限制。约束预算测试使用明确的短 systemInstruction，独立验证保留全部约束，不再依赖默认助理指令长度。

## 验证与边界

Worker 定向 117 项、Desktop 定向 62 项通过；全仓 997 项通过（Worker 560、Desktop 298、Persistence 50、Contracts 24、Context 8、LLM 32、Generation Adapters 25）。typecheck、lint、format:check、git diff --check 和 tauri:build 通过。Vite 包体积提示及 Rust 3 个既有警告保留。

`validate-llm-intent-sidecar.mjs` 使用最终生产 Worker，8 组隔离用例通过：两协议、两个普通入口、有/无 UI hint。每组检查结构工具可见、错页面无产物、真实方案 ID 进入 task detail、批准前目录为空、批准后两场三镜的父子关系及独立提示词。Provider 请求数为 0；测试重放工具调用，不代表真实模型语义效果已实测。

日志：仓库本地 `.scene-structure-tests.log`、`.scene-structure-typecheck.log`、`.scene-structure-lint.log`、`.scene-structure-package.log`、`.scene-structure-sidecar.log`（忽略文件）。隔离报告位置由 sidecar 日志返回。

安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。本次已重建，未安装或替换用户运行实例；已有独立 storyboard 文档未自动迁移。

安装包 SHA-256：`394A651A416B181C2F5EC3EEB22271A00D7205569FB290E5D27CCC22D4E6B39C`；包内 Worker 源 SHA-256：`95B8326A6ECA02BCAF8900004387A793B278FD87711EE828953D596E5FEBC1CC`。隔离报告：`C:/Users/10698/AppData/Local/Temp/unicomp-llm-intent-1Y6OxM/report.json`。

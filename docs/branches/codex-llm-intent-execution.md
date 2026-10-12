# 分支记录：codex/llm-intent-execution

更新日期：2026-10-12

目标仓库：`XlNGI/xlngaiforwindows`。本分支从 `main` 的 `a7463ad` 继续开发，集中处理 Agent 语义执行、项目资源定位与桌面界面体验。

## 已有提交

- `33aa3a6`：普通请求由 LLM 在正常 Agent 轮次中判断意图，移除活动调用链的关键词分流；修复图片响应处理。结构化工具仍校验身份、实际目标、版本、锁、幂等与预算。
- `061a5d2`：Windows 正式版主程序使用 GUI 子系统，Worker 以无可见控制台窗口方式启动；应用、安装器和卸载程序统一使用 unicomp 图标。

## 本次新增代码

1. **文档页面定位与结构校验**：资源目录区分小说、剧本、角色与场景、场次与镜头等工作区。新增草稿工具要求真实 `resourceId`，小说资料显式指定绑定类型；写入事务核对项目、结构节点、版本和行版本，避免小说大纲误存到剧本页。桌面端按实际产物 ID 定位结果。
2. **场次与镜头产物可见性**：普通 Agent 可通过 `scene.submit_structure` 提交待审核方案。结果返回真实方案 ID，生成完成后显示本任务方案，批准后刷新实体目录；修复多场次镜头父子关系，禁止用孤立 storyboard 文档冒充该页产物。
3. **场次绑定制作场景**：Schema v42 为场次及变更集增加 `sceneDocumentId`。多个场次可复用同一制作场景；Worker 校验真实 ID、项目、文档类型与有效状态。镜头参考图按场景文档 ID 继承，支持手动覆盖、清除和恢复，并隔离过期异步请求。
4. **完整图片预览**：共享页内图片查看器覆盖生成结果、角色/场景、镜头参考图和素材详情；图片完整显示，同次多图逐张预览，支持关闭、遮罩、Esc 和焦点返回。只读项目也可查看。
5. **会话窗口缩放**：移除拖到最小宽度时自动关闭会话的逻辑，保留最小尺寸与现有打开/关闭操作。
6. **浅色主题**：采用用户确认的暖白、柔灰和雾蓝配色，适配按钮、输入区、设置表单、任务状态与浮动窗口；深色主题及布局保持不变。
7. **计划与验证记录**：更新相关实施计划和代码追踪记录，同步素材方案的 Markdown 与 DOCX 预览要求。

## 本轮上传前验证

- `pnpm.cmd test`：1010 项通过。Worker 563、Desktop 306、Persistence 52、Contracts 24、Context 8、LLM 32、Generation Adapters 25。
- `pnpm.cmd typecheck`、`pnpm.cmd build`、`pnpm.cmd lint`、`pnpm.cmd format:check`、`git diff --check`：通过。
- 浅色主题浏览器复验：主按钮和关键选中/状态文字对比度高于 4.5；深色设置界面 439 个元素、工作区 362 个元素的样式与修改前一致，主题切换及存储正常。
- 本轮未重新执行 Rust、生产 sidecar 或 Windows 安装包验收；此前验证与产物哈希见各功能记录，不能视为包含最后浅色配色修改的新安装包证据。

## 数据与验收边界

运行时项目资料和索引继续保存在本地 SQLite；GitHub 仅管理源代码、文档和审查。普通会话仍按需检索正文，不自动注入章节、记忆或约束，不自动收录未导入/保存的聊天附件。

Schema v42 不按名称补绑旧场次。旧版回滚需要使用升级前的项目备份。真实 Provider 语义效果、正式签名和人工安装验收沿用相关计划中记录的未验证项。

## 详细记录

- [LLM 语义执行](../code-traces/2026-10-12-llm-intent-execution.md)
- [Windows 控制台与图标](../code-traces/2026-10-12-windows-console-and-installer-icons.md)
- [页面定位](../code-traces/2026-10-12-document-workspace-locators.md)
- [场次与镜头可见性](../code-traces/2026-10-12-scene-shot-visibility.md)
- [制作场景绑定](../code-traces/2026-10-12-scene-setting-bindings.md)
- [完整图片预览](../code-traces/2026-10-12-full-image-previews.md)
- [浅色配色](../code-traces/2026-10-12-light-theme-colors.md)

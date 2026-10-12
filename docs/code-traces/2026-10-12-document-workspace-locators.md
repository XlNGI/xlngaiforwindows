# 小说大纲误存剧本：页面定位与结构 ID 校验

日期：2026-10-12（America/New_York）

## 已确认事实

只读检查截图对应的 `xlngts/新建文件夹 (4)/project.sqlite`。`《剑开天门》玄幻短篇小说大纲` 的 documentId 为 `707a62fe-9b38-48e2-81b4-e96f9c16e43f`，kind 为 `outline`，没有 `document_bindings` 记录。2026-10-12T11:23:32Z 的 `document.submit_draft` 审计参数键只有 `contentMarkdown`、`documentKind`、`title`，结果为 `draft_saved`，没有目标工作区。此前 `project.get_context` 仅返回空 sources 与数据计数，没有空页面资源入口。

模型省略小说目的地后，Worker 把它作为通用大纲接受，Desktop 按数据库关系显示在剧本页。会话名、项目名和当前编辑页均不能代替明确资源定位。

## 此前遗漏

- 旧小说资料依赖 Worker 从提示词推断 `novelReference`。移除关键词语义路由后，新工具改成模型可选 `bindingRole`，但目的地未必填，工具描述也未充分区分小说资料与剧本。
- 已有资源合同类型和旧工具 schema 中的定位字段；实际 `project.structure.get` 未输出资源目录，旧 `parseToolArguments` 拒绝定位字段。2026-09-23 的计划文字把未完整落地的合同写成了实际能力，本次纠正记录。
- 旧测试直接模拟正确的 `bindingRole`，没有重放真实模型只传 `outline` 的调用。正确参数可保存不能证明遗漏目的地会被拦截。

## 实现

`project-resource-map.ts` 从当前 SQLite 生成元数据目录；七个页面始终有新建入口，文档依据章节关系/小说绑定定位，标题树使用 v41 节点 ID。目录和旧预览各自有字节预算及截断标记。校验直接查询数据库，不依赖预览是否包含对象；revision 覆盖预览之外的文档。

新草稿/章节工具必填 `resourceId`，新小说资料要求 `workspace:novel` 与合法 `bindingRole`；页面与类型/绑定必须一致。修订必须对应真实文档/章节和 CAS；节点、版本、行版本与目录 revision 在同一事务校验。旧显式授权工具兼容可选定位字段，提供时必须匹配已授权目标。结果返回真实文档/版本 ID 和 `locator.workspace`，失败无子产物残留。

Desktop 以本任务最后产物 ID 导航，覆盖已有资料修订、其他任务产物干扰、较早章节 target 干扰。小说参考结构 sourceId 改为 documentId，与检索/编辑器一致。语义仍由正常 LLM 轮次判断，助理指令明确页面区别，不增加关键词分类或正文注入。

## 验证

定向测试覆盖两种协议下缺失目的地、绑定/页面错配、正确三类页面保存、节点错配、过期回写、实际结果 ID，以及跨项目/归档、同名资料、目录截断与版本校验。Desktop 覆盖新建/修订小说大纲和两个导航干扰场景。

生产 sidecar：`node apps/worker/scripts/validate-llm-intent-sidecar.mjs` 8 组通过（2 协议 × 2 普通入口 × 有/无 UI hint）。每组先连续提交两章，再重放截图缺失目的地及错误页面绑定，最后正确提交小说大纲；检查实际绑定、结果工作区/文档版本 ID、失败无子任务残留、草稿检索、审核锁及零确认。Provider 请求数为 0。

全仓 `pnpm test` 997 项通过：Worker 557、Desktop 301、Persistence 50、Contracts 24、Context 8、LLM 32、Generation Adapters 25。`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check` 通过；`pnpm tauri:build` 成功。日志为仓库本地 `.resource-routing-*.log`（忽略文件）。Vite 保留主包体积提示，Rust 打包保留既有 3 个编译警告；无 Rust 源码变更。

最终安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`；SHA-256：`BE56D65B445B48B0B995E496AE537B8350E3D8DE9E82C4DD8DE2305D6FB84252`。包内 Worker 源 `apps/desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe`；SHA-256：`C2954B46E036BAEB5EAD1B627F84C1B98A72A2F663300DDCBAEE9838A509099A`。隔离报告路径见 `.resource-routing-sidecar.log`，该脚本还检查普通会话不授权绕过目的地校验的旧 `document.create_draft` 工具。

未修改用户项目数据库，未迁移既有误分类文档，未安装或重启用户应用。旧文档可通过已有“移至小说资料”重新绑定。测试使用模拟工具调用，未验证真实 Provider 的自然语言判断效果。

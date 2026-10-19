# 素材预览卡片样式验证 2026-10-16

用户要求调整素材库中央网格的预览卡片样式，不显示文件名。卡片改为 1:1 完整预览，保留 contain；仅在存在用户别名和标签时创建信息行，别名单行省略并保留悬停提示，底部保留日期和文件大小。无别名的卡片使用媒体类型和当前序号作为无障碍名称，不回退为物理文件名。文件名搜索、详情路径、文件存储和拖拽引用协议不变。

## 聚焦验证

- `AssetLibraryView.test.tsx` 10 项通过；原有图片与视频预览测试改为通过卡片的无障碍名称定位图片，不再依赖显示物理文件名。
- Edge/Playwright 使用真实 `AssetLibraryView` 与项目 CSS、隔离模拟 Worker，在 1440×900、1280×800、800×900、390×844、320×844 深色与 1440×900 浅色共 6 种布局验收。素材网格不显示文件名，方形预览完整显示横图、竖图与方图；长别名、标签和元数据不撑开卡片，无网格或页面水平溢出。
- 单选、Ctrl 多选、键盘 Enter 选择、保存别名与按物理文件名搜索通过，浏览器无页面异常。测试素材来自用户截图中的缩略图裁取与合成边界测试图；未修改真实项目数据或请求 Provider。
- 截图和报告保存于忽略目录 `apps/desktop/.m2-ui-asset-cards/`；临时浏览器入口和脚本在验收后改为 `.txt` 后缀保存，避免进入源码检查。

## 仓库门禁

- 本次改动的素材库 TSX 文件 ESLint、TSX/CSS Prettier、`git diff --check` 通过。
- 全仓 `pnpm typecheck`、`pnpm build` 通过；保留 Vite 大包提示。
- Rust `cargo test` 155 项通过，1 项既有忽略。
- 首次 `pnpm test` 的大检索数据测试达到 5 秒超时。顺序执行 `pnpm -r --no-bail --workspace-concurrency=1 --if-present test` 后 persistence 63 项全部通过；总计 1281 项通过，3 项失败（Desktop 404 通过 / 3 失败、Worker 696、persistence 63、generation 54、llm 32、contracts 24、context 8）。
- 失败项：`ProductionPanel` 的多张生成结果放大与素材引用提交测试、`ShotWorkspace` 的生成图片放大测试，涉及当前工作区另行修改中的图片缩略图链路。素材库 10 项通过。没有修改本次范围外的图片链路或测试。
- 全仓 `pnpm lint` 在 `AssetImagePreview.test.tsx`、`SceneWorkspace.test.tsx` 和 `scene-media.ts` 报 7 个错误；`pnpm format:check` 报本次范围外 16 个文件的格式问题。没有将这些结果表述为通过。
- 日志：`.asset-card-focused.log`、`.asset-card-tests.log`、`.asset-card-tests-sequential.log`、`.asset-card-typecheck.log`、`.asset-card-lint.log`、`.asset-card-format.log`、`.asset-card-rust.log`、`.asset-card-build.log`。

## 方案同步

两份素材方案 Markdown 与对应 DOCX 同步卡片显示规则，并保留既有 DOCX 样式；新增章节逐段内容检查、ZIP 完整性与 OOXML XML 结构检查通过。两份 DOCX 均尝试随附 `render_docx.py`；运行时缺少 LibreOffice `soffice.exe`，无法生成页面 PNG，版式仍待可用渲染器验收。未以文本检查代替版式复核。

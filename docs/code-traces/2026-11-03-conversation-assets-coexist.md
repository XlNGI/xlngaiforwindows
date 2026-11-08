# 会话与素材库并行显示

2026-11-03。用户确认会话和素材库应同时显示。

原实现按工作区宽度自动隐藏停靠会话：仅生产参数打开时小于 1150 px，素材库打开时小于 1440 px，二者均打开时小于 1800 px。会话入口只能再将其改为浮窗，导致打开素材库就丢失原有并排视图。

本次移除桌面自动隐藏门槛。打开素材库、生产参数、关闭重开会话均保持用户的停靠选择，已打开的会话不会因此卸载；独立系统窗口和 900 px 及以下的既有标签切换行为保持。粗剪入口原有的主动收起会话行为仍沿用该工作台的已确认规则。

工作区停靠容器按实际可见面板的最小宽度及 8 px 分隔条计算内容宽度：会话 360 px、素材 320 px、项目页 360 px（有生产参数时 320 px）、生产参数 320 px，收起时 44 px。总宽度不足时，仅工作区内部横向滚动；激活或重新打开的面板滚入可见位置。关闭项目页后，会话和素材库可单独并排。

修改涉及 conversation-window.ts、WorkspaceSurface.tsx、styles.css 及对应组件／App 回归。未改变 Worker、数据库、会话生成、素材存储或引用规则。

验证结果：

- 桌面 80 个文件的 736 项测试通过。全仓 pnpm test 的 2255 项 JavaScript／TypeScript 测试通过（context 8、contracts 44、LLM 32、Desktop 736、generation-adapters 79、persistence 88、Worker 1168）。最后补充活动面板层级触发滚动后，三个直接相关文件 148 项测试复核通过。
- 全仓 pnpm typecheck、pnpm build 和最终 Desktop 构建通过；Vite 保留已有主包体积提示。变更文件 Prettier、工作区四个 TS／TSX 文件 ESLint、git diff --check 通过。
- 全仓 pnpm lint 被 10 项范围外代码错误阻塞，涉及 App.test.tsx 既有类型断言、ProductionPanel.audio.test.tsx、shot-binding-summary.ts 和四个 Worker 文件；既有 apps/desktop/.m2-ui-conversation-check 夹具另有四项项目解析错误。本轮隔离夹具验证结束后移除，不引入新的夹具 Lint 失败。全仓 pnpm format:check 报告 8 个范围外文件：media-confirmation.tsx、SceneCastEditor.tsx、SceneShotDirectory.tsx、context-service.ts、domain-tool-gateway.ts、dubbing-service.test.ts、dubbing-service.ts、project-library-query.ts。
- 使用真实 WorkspaceSurface 和样式配合隔离合成内容，在浏览器验证 901、1100、1280、1440 px 的面板可见性和最小宽度。1100 px 下三面板无需滚动；四面板保持可访问且在工作区内滚动，重新打开会话时可见。生产参数收起到 44 px 后释放宽度；保留未发送会话和未保存正文。分隔条可调宽并保存本地比例，重新打开后恢复；390 px 使用原有标签切换，回到桌面宽度后恢复并排。截图为隔离夹具，未使用或改写真实项目。
- 素材库两份 Markdown 和 DOCX 已同步本次确认规则和实施记录。DOCX 原有段落保留、ZIP 完整性及 XML 解析检查通过。按 [documents 技能](C:/Users/MSI/.codex/plugins/cache/openai-primary-runtime/documents/26.1025.11240/skills/documents/SKILL.md) 的“Run render_docx.py to produce page-<N>.png images”要求尝试渲染两份 DOCX，均因缺少 LibreOffice soffice.exe 失败，未生成页面 PNG；版式验收保留待办。

未运行 Windows Tauri 安装包、系统窗口或发布实机验收，不将本次布局修复等同于整体发布验收完成。未修改真实项目数据库或发起付费生成。

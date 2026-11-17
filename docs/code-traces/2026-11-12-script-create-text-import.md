# 剧本新建与普通文本导入修复

## 问题与修复

- 新建只清空编辑器，没有已保存的目录行，无法填写标题，保存按钮始终禁用。新稿现在以“未命名文档”显示在目录，自动聚焦标题；清空标题后输入框仍保留，填写标题和正文后可保存为草稿。
- 原导入入口和原生读取仅接受 `.md` / `.markdown`，且保存请求未传 `kind`，默认成为剧本目录不展示的 `note`。入口改为“导入剧本”，支持 `.txt` / `.md` / `.markdown`，新建和导入均采用当前目录类型，无筛选时使用 `outline`。
- 角色与场景页的类型筛选不再作用于剧本目录，避免新稿或导入稿落入当前页面不可见的类型。
- TXT 复用本地小说导入的文本解码器，支持 UTF-8、UTF-8 BOM、UTF-16 LE/BE BOM 和 GBK/GB18030；保留正文、对白和原始换行，不要求 Markdown 标题或其他结构。剧本预览段落保留单行换行。
- 新建和导入前保护尚未保存的文档；文件选择、读取失败或取消保留原稿。导入期间阻止重复新建，切换项目后不会继续读取或保存原选择的文件。

继续使用现有本地文档草稿存储及 `markdown_import` IPC，不修改项目检索、发布规则、数据库 Schema 或运行时项目数据。

## 验证

- 第一轮桌面聚焦测试：136 项通过；涵盖新建、填写/清空标题、保存、导入后目录可见、类型筛选、失败/取消保稿及跨项目迟到回调。
- 最终原生导入回归：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml import --lib` 8 项通过；覆盖 TXT 五种编码/大小写扩展名、正文逐字保留、绝对路径、超限文件、原 Markdown 和小说 TXT/EPUB 导入。
- `pnpm build`、`pnpm typecheck`、`pnpm lint` 和 Rust 格式检查通过。构建保留既有 Vite 主包大小提示，Rust 测试保留既有五处 `unused_mut` 提示。
- 最终全仓 `pnpm test`：2,720 项通过（Desktop 863、Worker 1,585、persistence 102、generation-adapters 81、contracts 49、llm 32、context 8）。桌面最终覆盖从角色/场景筛选切回剧本后新建。
- 最终 `pnpm format:check` 和 `git diff --check` 通过。全仓测试日志为受 Git 忽略的 `.script-import-tests.log`。

本次未重新打包或安装 Windows 应用，已安装版本须使用包含本次原生修改的新构建。

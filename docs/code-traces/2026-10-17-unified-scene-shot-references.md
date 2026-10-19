# 场次目录与统一参考资料

日期：2026-10-17（America/New_York）

## 用户确认与实现

场次与镜头使用同一棵目录，每个场次下直接列出所属镜头并支持展开、收起。目录不再放置场景绑定控件。选择场次显示场次提示词及参考资料，选择镜头显示镜头提示词、参考资料与分镜说明。

场次和镜头共用 ReferenceCard：完整图片预览、素材拖入与选择控件保持一致。多个角色分别显示图片与声音，场景关联位于场景卡片中，保留完整对白和首帧。场次既有的其他参考素材也使用相同卡片。

镜头显式继承所属场次已确认的角色与场景资料，支持多个角色，不再出现已关联角色图片而镜头仍是空参考槽的情况。角色图片与声音修改可保存回所属场次；单镜图片覆盖和首帧继续按镜头保存。生成时解析实际参考图，传入全部角色图并去重；继承值不写成单镜覆盖。兼容既有单个 characterAssetId 和本地镜头参考记录。

拖入卡片先校验项目和单张数量，再经 Worker 查询实际素材状态、图片类型和文件可读性；拒绝跨项目、已删除、视频与缺失文件。异步请求在切换项目、镜头或目标后不更新旧卡片。角色与场景关联依据真实 ID，普通提示词不自动按名称建立关联。

目录的非活动场次按展开加载镜头，活动场次复用 App 已有镜头状态。场次页与镜头页各自滚动；窄屏仍保留目录父子关系和编辑操作。

## 验证

- 最终聚焦 7 个文件 109 项测试通过，覆盖目录父子关系、场次与镜头切换、绑定位置、多角色实际参考图、保存失败阻止生成、参考图继承与覆盖、拖拽校验、只读状态与过期响应。
- pnpm test 全仓 1421 项通过：Desktop 452、Worker 776、Persistence 70、Generation Adapters 59、LLM 32、Contracts 24、Context 8。随后参考素材展示的小幅修订再次通过上述 109 项聚焦回归。
- Rust cargo test 158 项通过、1 项既有忽略。
- pnpm typecheck、pnpm lint、pnpm format:check、git diff --check、pnpm build、pnpm tauri:build 通过。Vite 包体积提示和 Rust 3 个既有警告保留。
- Edge 无头浏览器使用实际组件与隔离示例数据，在 1440、1280、390 宽度验证无横向溢出、横竖图 contain 完整显示、全部角色参考图进入生成参数、场次与镜头视图切换和独立滚动。页面脚本错误为 0。验证不访问真实项目、不发起付费生成请求。
- Markdown 与两份 DOCX 的新增确认规则和验证状态一致；ZIP 完整性及 OOXML XML 校验通过。两份文档已尝试 render_docx.py，缺少 LibreOffice soffice.exe，未完成 DOCX 页面渲染验收。

## 构建产物与证据

安装包：apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe

SHA-256：032DB759CF0894AE296A22FEE9FAC294F38CAA2DBADAECD3EE7778594095D8DB

日志：仓库本地 .scene-reference-focused.log、.scene-reference-all-tests.log、.scene-reference-typecheck.log、.scene-reference-lint.log、.scene-reference-format.log、.scene-reference-build.log、.scene-reference-rust.log、.scene-reference-package.log、.scene-reference-docx-render.log、.scene-reference-docx-implementation-render.log（均忽略）。浏览器报告与页面截图位于 apps/desktop/.m2-ui-reference/；隔离验证脚本保存在本机临时目录 unicomp-reference-ui-2026-10-17。

本次未安装或替换正在运行的应用，未修改真实项目数据库。场次关联仍保存在本地项目 SQLite，既有素材引用、自动入库、手动素材组和拖拽快照合同保持有效。

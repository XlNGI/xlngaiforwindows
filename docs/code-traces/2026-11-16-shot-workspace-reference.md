# 镜头目录、双正文与参考图实施记录

日期：2026-11-16。用户授权按已确认效果图直接实施；方案为 [镜头页面与本镜参考图整理修复方案](../SHOT-WORKSPACE-REFERENCE-REFACTOR-PLAN.md)。未改现场项目数据、未调用真实供应商、未安装覆盖正在运行的软件。

## 实现

- 保留项目导航、场次与镜头目录及当前镜头三栏。目录可主动收起，按钮在窄窗口可见；旧目录的新建、选择、归档和删除入口继续复用。
- 视频提示词与本镜参考图使用两个页签。共享资料绑定只维护一处；静态创作明确选择本图实际人物、场景与道具，分镜说明位于底部折叠。
- 本镜参考图按参考来源、独立图片正文、本镜图片组织。保留项目图片/视频选择、显式导入、多视频选帧与人工基准确认；宽面板图片右置，窄面板顺序排列。
- 候选图片须明确确认采用才进入视频；顺序、普通参考和最多一个显式首帧独立保存。创作目标“末帧”不冒充模型实际尾帧输入能力。
- 图片与视频正文分别保存、编译、填表。空正文不借另一份兜底，显式空图片不恢复候选默认图；场次媒体视图保留原默认解析行为。生图来源变化不无条件使已采用输入未变的视频表单失效。
- 当前会话模板的来源、版本与未保存状态在页面展示，可直接查看编辑。可信页面用途传入 Worker，由 Worker 冻结当前会话对应模板；两协议均验证，清空模板不恢复默认，普通聊天仍按需读取资料。

## 数据和边界

`migration-v80.ts` 新增 `shot_image_prompts` 与 `shot_video_images`，旧 `shots.prompt` 保持视频正文所有权。旧连续性静态原文另存 `legacy_prompt`，旧两处首帧冲突保留两份引用并提示确认。事务回滚、只读旧库、项目触发器、CAS 和重复迁移保留用户新正文/采用项均有验证。

`shot.image.get/save`、`shot.videoImages.save`、`shot.prompt.preview` 为真实 IPC；Agent 使用 `shot.image.read/save`，旧连续性工具兼容投影到独立存储。来源指纹涵盖镜头版本、本图显式资料版本、源画面及素材状态；已采用输出不进入生图来源。实际像素读取前后验文件哈希并沿用视力能力、项目会话、FFmpeg 共享限额和传输大小限制；像素只进入当前模型请求，不保存到任务审计正文。

桌面草稿按项目与镜头保存并保留原 CAS；跨镜切换、页签切换和后台刷新不丢失未保存正文/采用项。迟到保存或预览不填入新项目或镜头。归档/删除确认后才丢弃对应草稿。制作表单中的最终人工参数继续优先，填表本身不生成付费任务。

主要实现：`ShotWorkspace.tsx`、`ShotImageWorkspace.tsx`、`App.tsx`、`shot-continuity-service.ts`、`shot-image-source.ts`、`production-service.ts`，以及合同、持久化、Agent 调用和素材引用删除保护的对应接入。

## 验证

最终各包 JavaScript/TypeScript 合计 2,791 项通过。前一次根 `pnpm test` 在收尾期间新增来源隔离用例时失败，之后完成补修并重新运行 Worker 全量；以下按最终各包与定向记录报告，不将失败的命令记为通过。

| 检查 | 结果 |
| --- | --- |
| Desktop 全量 | 98 文件，877 项通过 |
| 其余基础包 | Context 8、Contracts 49、LLM 32、Adapters 83、Persistence 105 项通过；Domain 无测试文件 |
| Schema 80 定向 | 旧原文/顺序/冲突、CAS、项目隔离、回滚、重复升级保留编辑均通过 |
| Worker 最终全量 | 102 文件、1,637 项全部通过，384.74 秒；图片来源不影响已采用输入未变的视频、实际采用变化使视频失效均有回归 |
| 类型、Lint、格式、diff | 最终 `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 和 `git diff --check` 全部通过 |
| Rust | `cargo fmt --check` 通过；`cargo test --lib` 223 通过、8 既有忽略 |
| React 浏览器 | 40 组布局及来源工具/双正文/页签切镜草稿/明确采用交互通过，无页面异常 |
| 打包 Worker | `validate:shot-workspace-sidecar` 通过：Schema 80、两正文、CAS、空输入、关闭重开、完整性；供应商调用 0 |
| 生产构建和 NSIS | 最终 `pnpm tauri:build` 成功，含 Worker sidecar、前端与 Rust release；未安装 |

安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，77,303,872 字节，生成于 2026-11-16 18:14:26。SHA-256：`12a0a259fc04e9abbd6871097ba63374740d51b60ac36b0643bf014c3fba571c`。

最终命令日志保留在下述会话效果目录：`shot-worker-completed-tests.log`、`shot-final-all-tests.log`、`shot-completed-typecheck.log`、`shot-completed-lint.log`、`shot-completed-format.log`、`shot-completed-diff.log`、`shot-rust-tests.log`、`shot-completed-nsis-build.log`、`shot-completed-sidecar-qa.log`。Schema 80 增补的重复升级保留记录回归另见 `shot-migration-final-tests.log`；最终打包 Worker 也重新验证通过。

浏览器夹具使用真实 React 组件、临时示例数据及拦截 RPC，不读取真实项目。检查记录与截图在当前会话效果目录 `C:/Users/MSI/.codex/visualizations/2026/11/13/01a1d307-6745-7c62-82f7-8b958fe66879`，包括 `shot-implemented-layout-qa.json`、深浅主题两页签及窄窗口截图。临时入口已移出仓库，常驻测试服务器已停止。

最初回归发现的旧用例混用正文、重复迁移建表、v79 夹具遗留 v80 ledger、窄窗口目录隐藏及图来源影响视频表单问题均已处理；保留最终检查证据，不用缩小测试范围掩盖失败。

## 交付限制

两份素材库 DOCX 保留原文并同步新增确认要求，已核对文本结构；随附文档渲染器缺少 LibreOffice，逐页排版验收尚未完成。本轮没有执行 Windows 安装包升级/独立窗口实机操作，也未调用真实模型验证画质、身份一致或跨镜连贯性。这些不影响本次代码与本地自动化结果，但不能将模拟结果等同实机或付费视频验收。

工作区存在本轮之前的其他改动；交付包包含当前工作区，不把那些改动全部归因于本轮实现。未执行提交、推送或部署。

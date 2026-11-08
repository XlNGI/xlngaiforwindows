# 镜头衔接多来源与批量参考实施计划

日期：2026-11-04。用户要求先审计代码，再设计计划，再实施。以下按 M0 → M1 → M2 → M3 → M4 顺序执行；未验证的阶段不勾选。

## 审计结论

- `ShotContinuityPanel.tsx` 在没有上一镜头时隐藏全部选帧入口，只允许单视频、逐张添加至多 4 帧，并以单选框绑定一张结果图片。
- `shot-continuity-service.ts` 的 get/source 双重限制来源必须为上一镜头的成功视频；来源令牌、确认、重新确认和 Agent 图片读取均依赖该单视频。仅改界面无法支持跨镜头、多视频和纯图片。
- `ShotContinuityBinding` 保存单个视频来源及单张结果引用，SQLite 已以 JSON + CAS 存储，可增量扩展并兼容旧绑定，无须改写用户数据库或新增迁移。
- `ShotWorkspace.tsx` 和 `ProductionService.defaultImages` 将普通衔接参考折叠为一张，必须与界面、Agent、表单一起修正。图片提示词仍独立于镜头视频正文。
- `asset.list` 已提供项目级搜索和游标分页；素材拖放已有 HTML 和 WebView 指针协议，可复用。Windows 外部文件拖放尚无接收器，须使用 Tauri 原生文件拖放事件，不能假设浏览器 File 含磁盘路径。
- 回收站引用保护使用 JSON 树遍历，新来源数组仍能被保护。现有本地 FFmpeg 限额、清理、哈希复验和文件补偿应继续复用。

## 确认需求与设计

项目全部有效图片和视频均可选择，提供搜索、分页、多选及素材库拖入；上一镜头仅为快捷推荐，没有上一镜头仍可使用。电脑文件支持 Windows 原生多文件拖入及选择文件，图片支持 PNG/JPEG/WebP，视频支持 MP4/MOV/M4V/MKV/WebM。明确导入的文件保存为项目本地副本并记录本地成功任务；现有项目素材只引用、不复制。导入不进入文档检索索引。

用户可对一个或多个已选视频一次均匀抽取 2–12 帧，也可保留精确定位的逐帧添加。预览请求逐张执行并显示进度，避免批量 Base64 超过 IPC 限制；候选最多 24 张、最终来源参考最多 12 张。候选画面由用户多选、移除并明确指定一张基准图；未确认候选不入库，确认后保存原尺寸 PNG。视频帧与项目/本地图片可混合，也可只用图片。取消批量抽帧停止后续请求并保留已完成候选。

新绑定保存多视频哈希、直接选用图片哈希及每帧真实来源；旧单视频绑定按原语义读取。新来源由用户明确指定，不再随上一镜头顺序推断。目标镜头改词仍需明确确认沿用；素材丢失、删除或哈希变化拒绝旧来源，CAS、项目运行会话、只读与迟到响应隔离继续有效。

最终本镜图片支持多张普通参考及最多一张显式首帧，保留顺序、预览、移除和用途。Agent 按需读元数据，显式要求时才读取像素，来源参考和最终图片均完整可读。静态参考图填表使用全部已确认来源图；本镜视频填表使用最终绑定图片及用途，不自动把来源帧当作视频首帧，也不自动提交付费生成。

## 阶段与验证

- [x] M0 审计与设计：完成上述源码核对，阅读素材库两份计划、衔接实施与改词重新确认计划；保留仓库已有未提交改动。
- [x] M1 合同与多来源核心：新确认合同、来源快照、旧绑定兼容、原尺寸批量确认、纯图片、CAS/失败补偿/重新确认；23 项真实合成视频/临时项目测试通过，日志 `.continuity-multi-m1.log`。范围包括多视频混合、纯图片首镜、重开、原尺寸像素、Agent 实际像素、源哈希、失败回滚及旧绑定。
- [x] M2 本地文件与项目选择：25 项 Worker 回归通过，含显式本地导入、重复复用、真实解码及失败补偿；桌面回归覆盖 Windows 多文件原生事件、缩放命中、解除监听、跨项目、只读、分页和搜索迟到响应。日志 `.continuity-multi-m2-worker.log`、`.continuity-multi-desktop.log`。
- [x] M3 人工流程与下游：桌面 64 项定向回归通过，含多视频一次抽帧、显式多选和基准、停止抽取、最终多图与首帧以及纯图片到静态生图／多图到视频的实际填表快照。Worker 实际像素、旧绑定与 CAS 回归保持通过；全仓类型检查通过。
- [ ] M4 最终验收：Markdown/DOCX 内容已同步，全部自动化门禁已执行；测试、类型、构建及 Rust 检查通过。全仓 Lint／格式仍有既有失败，Windows 安装包原生拖入与 DOCX 逐页版式尚未实机验收，因此保持未完成。

## 验证记录

2026-11-04 最终实现及验证：

- `pnpm test` 全仓 **2236 项通过**：Desktop 763、Worker 1222、contracts 44、generation-adapters 79、persistence 88、llm 32、context 8；共 205 个测试文件。日志 `.continuity-multi-all-tests-final.log`。
- `pnpm typecheck`、`pnpm build`、`cargo fmt --check`、`git diff --check` 通过；Rust `cargo test` **189 项通过、1 项既有忽略**。日志 `.continuity-multi-typecheck-final.log`、`.continuity-multi-build.log`、`.continuity-multi-rust-final.log`、`.continuity-multi-rust-format-final.log`。构建仅有既有主包超过 500 kB 提示。
- 最终 Worker 衔接 **27 项真实临时项目回归通过**，含新增 JPEG 原字节保留、独立预览文件、实际 MOV 容器导入及探测；桌面原生媒体类型补齐 MOV/MKV 白名单。日志 `.continuity-multi-import-regression.log`。此前联动 Worker 79 项、桌面 64 项及 App 相关 105 项定向回归通过，均由最终全仓测试覆盖。
- 原生拖入自动化验证包含多路径、设备缩放命中、跨项目拒绝、只读和监听清理。首轮全仓测试暴露不完整 Tauri 测试环境同步初始化抛错，已让初始化失败进入错误处理；最终 Desktop 全量 763 项通过。
- IAB 隔离页面使用真实面板和合成素材，验证纯图片首镜、多视频批量候选、多选及明确基准、多个最终图片及单一首帧、保存提示词与表单回调；320／390／1280 像素宽度无横向溢出。两段视频各 4 帧可一次生成 8 个候选并与直接图片共同确认。该页面的抽帧响应为模拟数据；真实 FFmpeg 行为由 Worker 测试验证。截图 `.m2-ui-continuity-multi/confirmed-mixed.png`。临时服务已停止，验证代码以忽略的文本夹具保留。
- 本次变更源码定向 ESLint 与格式检查通过，日志 `.continuity-multi-focused-lint-final.log`、`.continuity-multi-focused-format-final.log`。全仓 `pnpm lint` 仍有 **14 项既有错误**：4 个 `.m2-ui-conversation-check` 夹具解析错误，以及 App.test、ProductionPanel.audio.test、shot-binding-summary、dubbing-service.test、project-service.test、request-validation 原有 case 声明、scene-structure-submission-service 共 10 项源码问题。本次新增源码无新增 Lint 错误。日志 `.continuity-multi-lint-final.log`。
- `pnpm format:check` 仍报告 **8 个范围外文件**：media-confirmation、SceneCastEditor、SceneShotDirectory、context-service、domain-tool-gateway、dubbing-service.test、dubbing-service、project-library-query。本次变更文件已定向格式化，未改写其他工作的格式。日志 `.continuity-multi-format-final.log`。
- 两份素材库 Markdown 与对应 DOCX 的新增规则及实施状态同步，ZIP 完整性与 XML 结构通过。DOCX 渲染命令因缺少 LibreOffice `soffice.exe` 失败，未声明逐页视觉验收通过。日志 `.continuity-multi-docx-product.log`、`.continuity-multi-docx-implementation.log`。

本次代码实现完成；M4 的全仓静态门禁和实机／版式验收仍保留。未修改真实用户项目，未发起付费生成，未更新已安装应用或制作安装包；浏览器组件验证不代替 Windows 安装包原生拖入、视频播放与端到端验收。

## 界面精简补充 2026-11-05

- [x] 按用户“极简、减少文字”的要求，依次完成重复结构审计、紧凑视频与选帧布局、文案精简及验证；完整无障碍名称、人工确认和原有数据行为保留。
- [x] 衔接及镜头填表 51 项定向测试、Desktop 类型检查和生产构建、变更代码静态检查通过；隔离浏览器验证 320 / 390 / 576 / 900px、横竖视频、深浅主题、批量候选确认与填表回调。

详细记录：[镜头衔接界面精简](./code-traces/2026-11-05-continuity-minimal-layout.md)。本次为前端排版与文案调整，没有改变已确认的功能要求；M4 的原有未完成项保持不变。

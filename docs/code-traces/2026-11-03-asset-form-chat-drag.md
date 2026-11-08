# 素材拖入表单和会话

2026-11-03。用户反馈素材库文件无法拖进制作表单和会话输入框，要求像文件一样直接拖动。该修复补齐素材库计划 P4 的接收链路，延续本地优先、当前项目隔离及静态素材引用规则。

## 原因与修复

素材卡片已有应用内 Pointer Events 拖动，但只有素材组和粗剪接收；图片列表只监听原生自定义 MIME，结构化媒体字段未接收拖动，会话只识别操作系统 FileList。粗剪存在时，图片也进入指针链路，原生表单因此收不到事件；视频卡片原本关闭原生 draggable。

- 新增 `assets/use-asset-drop.ts`，统一原生自定义 MIME、text/plain 回退和应用内指针接收。指针命中使用实际可见元素及最近的接收区，避免遮罩后方或嵌套列表重复接收；提供高亮及取消反馈。禁用字段组和只读入口不写入。
- 素材卡片和素材组复用同一快照与拖动源。单个、多选和素材组保持创建时间及 ID 的稳定顺序；图片、视频和原生视频播放控制条仍有各自正常交互。视频支持原生协议回退，应用内指针激活后继续抑制重复原生拖动。
- 图片列表接收整组有序引用；单张落在具体图片行时只替换该行。结构化图片／视频位置保留原有用途与其他参数，列表空白处追加。普通参考图片优先使用 Schema 的参考图变体；只有首尾帧的表单依次填入可用首帧、尾帧，不能重复占用。视频单值字段与参考图卡片也接入相同接收机制。
- 所有目标通过拥有该项目的 Worker 解析 ID，复核类型、数量、项目会话及文件可读性。异步返回后若用户改值、更换项目／目标或卸载视图，不覆盖当前编辑。
- 会话素材经受控本地媒体地址读取，转换为既有附件。无 Content-Length 的分块响应也限制读取大小，保留单个 20 MiB、合计 40 MiB、最多 8 个的上限。读取和本地附件添加按序提交，避免并发突破限制；项目／会话切换、发送清空或卸载后丢弃旧结果。
- 读取附件期间显示进度文字并暂缓发送，避免视频首帧或大文件仍在读取时漏发附件；用户可以继续编辑文字。切换草稿上下文后，新附件队列无需等待旧项目的读取。
- 会话保留原文字、预览与主动发送流程，不自动发送或导入检索索引。视频仍走原附件处理与首帧分析能力，提取首帧增加超时清理。表单只保存 `asset://` 引用，不复制素材库文件。

未修改 Worker、SQLite、检索实现和跨项目同步；素材文件不会写入 GitHub。

## 验证

聚焦与集成测试覆盖真实组件之间的 pointer down／move／up、具体图片位置替换、参考卡片、图片／视频有序追加、嵌套目标只接收一次、素材组拖动、原生 text/plain 回退、类型／数量／项目／不可用文件拒绝、Escape、遮罩覆盖、只读入口，以及异步结果失效。会话主应用测试确认读取后显示真实 Data URL 附件，保留输入文字，无发送或草稿导入副作用；卸载后不再进入 FileReader。附件读取测试覆盖无 Content-Length、分块超限、总量超限及项目重开。

完整 `pnpm test` 通过 2165 项；随后针对最终补充的素材组及官方首尾帧用途回归重新执行完整 Desktop 测试，最终数量以本节补充记录为准。Worker 1168、contracts 44、context 8、LLM 32、generation-adapters 79、persistence 88 项均通过；domain 没有测试文件。初次全仓运行发现两处旧断言与新行为不符，更新视频 draggable 与异步错误断言后通过。一次声音绑定测试发生时序失败，定向及后续全量复测通过，未放宽测试阈值。

浏览器隔离夹具使用实际素材库、图片输入、结构化表单和 ChatPanel 组件与正式样式。通过真实鼠标拖动验证图片到首帧、视频到会话、视频到结构化媒体列表，保留输入文字且没有自动发送。素材与 Worker 响应为测试数据；浏览器夹具中的会话回调展示附件由组件接收，真实文件读取另由主应用及附件读取测试覆盖。临时夹具与 1421 服务已清理，没有操作用户项目或 1420 服务。

截图：`C:/Users/MSI/.codex/visualizations/2026/11/03/01a1a185-b8bc-7863-9a60-a194cf2697b7/asset-form-chat-drag.png`。

## 静态门禁与限制

最终 Desktop 全量 749 项、收尾聚焦 249 项通过；结合上述其他包的全量结果，共 2168 项。全仓类型检查、生产构建、变更代码 ESLint、格式与 diff 检查通过。App.test.tsx 的本轮新增代码未引入 Lint 错误，该文件仍有三处既有不必要断言。

全仓 Lint 仍有 10 项既有源码错误：App.test.tsx 三处断言、ProductionPanel.audio.test.tsx 两处 require-await、shot-binding-summary.ts 一处断言、Worker dubbing-service.test.ts／project-service.test.ts／request-validation.ts／scene-structure-submission-service.ts 各一处；另有 .m2-ui-conversation-check 中四个既有临时夹具解析失败。临时拖放夹具清理后，本轮没有新增该类失败。全仓格式仍报告 media-confirmation.tsx、SceneCastEditor.tsx、SceneShotDirectory.tsx、Worker context-service.ts／domain-tool-gateway.ts／dubbing-service.test.ts／dubbing-service.ts 以及 persistence project-library-query.ts 共八个范围外文件。不能据此声明整体发布验收完成，本次没有修正那些代码。

两份 Markdown 和对应 DOCX 的要求／实施记录同步，保留已有正文与结构；ZIP 完整性及 XML 解析通过。两份 DOCX 均尝试随附 render_docx.py，因环境缺少 LibreOffice soffice.exe 无法生成 PNG，文档版式验收继续待完成。

浏览器测试不替代 Windows Tauri 安装包实机验收。本次验证工作区同一文档内的应用内拖放；跨独立原生窗口和拖出到 Windows 外部程序的系统文件拖放没有完成端到端验收，不声称已提供系统级文件拖出能力。原有整体验收未完成项继续保留。

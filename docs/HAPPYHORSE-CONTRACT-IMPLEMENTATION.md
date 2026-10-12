# HappyHorse 官方合同接入

日期：2026-10-11

## 已确认要求

- 合同只同步阿里云百炼官方能力、参数、默认值、范围和请求/响应语义。
- UniComp 模型只绑定官方合同；不维护中转站模型参数工厂、HappyHorse 中转站适配器或模型 ID 白名单。
- 连接目录仍以该连接同步的远程 ID 为准。合同目录不会生成不存在的远程模型，也不会自动启用已关闭模型。

## 官方来源

- [文生视频](https://help.aliyun.com/zh/model-studio/happyhorse-text-to-video-api-reference)
- [首帧生视频](https://help.aliyun.com/zh/model-studio/happyhorse-image-to-video-api-reference)
- [参考生视频](https://help.aliyun.com/zh/model-studio/happyhorse-reference-to-video-api-reference)
- [视频编辑](https://help.aliyun.com/zh/model-studio/happyhorse-video-edit-api-reference)
- [异步任务管理与取消](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks)：官方仅允许取消 PENDING 状态任务。

官方模型：`happyhorse-1.0-t2v`、`happyhorse-1.1-t2v`、`happyhorse-1.0-i2v`、`happyhorse-1.1-i2v`、`happyhorse-1.0-r2v`、`happyhorse-1.1-r2v`、`happyhorse-1.0-video-edit`。

官方协议为 DashScope 异步视频：提交 `/api/v1/services/aigc/video-generation/video-synthesis`，查询 `/api/v1/tasks/{taskId}`，Bearer 鉴权，提交使用 `X-DashScope-Async: enable`。请求由 `model`、`input.prompt/media`、`parameters` 组成；结果为 `output.task_id/task_status/video_url`。官方地域和 API Key 必须一致，业务空间域名优先，旧 DashScope 域名仍可使用。

## 实施检查

- [x] P0 官方合同：七个独立修订，记录官方来源、核验日期、能力、Schema、生命周期和脱敏线协议样例。
- [x] P1 Schema 连接：从同一合同生成 AdapterDescriptor 和动态表单；JS/Ajv 与 Rust 原生层读取同一份 JSON 合同，拒绝额外字段。
- [x] P2 模型绑定：UniComp 仅登记远程模型 ID 到合同的 ModelBinding；已有空能力条目自动补齐合同元数据，清除错误旧模板绑定。
- [x] P3 执行链：通过现有 OpenAI 视频协议桥、任务确认、提交、轮询、结果下载、本地保存和取消流程执行。首帧图片投影复用协议规则；参考图片保留顺序及九张上限。没有 HappyHorse 中转站参数分支。
- [x] P4 历史与门禁：任务冻结合同、修订、Schema 和 Binding 快照。官方合同参数不能被手工/Agent Schema 覆盖；能力不能超出合同；停用合同/Binding 后阻止新提交。
- [x] P5 自动化验证：全量 TypeScript 测试、类型检查、lint、生产构建和 Rust 测试通过，详情见下。
- [ ] 实际付费生成：本轮未调用真实生成 API，渠道兼容性尚未通过真实调用验收。

## 参数边界

文生/参考生成支持 480P、720P、1080P（默认 1080P）；3–15 整数秒（默认 5）；九种画幅；水印默认开启；seed 为 0–2147483647。首帧模式不接受 ratio，输出比例取自图片，仅允许一张首帧，prompt 可选。参考模式必须有 prompt，允许 1–9 张图片，用 `[Image 1]` 等按顺序指代。

编辑模式必须有公开视频 URL 和 prompt；参考图 0–5 张；分辨率仅 720P/1080P；音频控制为 `auto/origin`；不接受生成时长或画幅参数。素材格式、大小、像素、帧率要求展示在官方字段说明中；公开 URL 指向的媒体内容由服务端验证，本轮不会提前抓取输入视频或远程图片。

业务参数保持官方命名。连接协议负责传输封装：现有 UniComp 通道使用通用 `/v1/videos` 提交/查询及一张首帧的 `image` 投影；官方 `input.media` 的语义和官方生命周期保存在合同中。没有将中转站 `seconds/size/generate_audio` 混入 HappyHorse Schema，也没有 Binding transportOverride。官方取消能力保留在合同，现有渠道尚无远端取消协议，Binding 标记 partial 并显式将 videoCancellation 设为 false。阿里云官方直连执行器没有在本次增设。

状态支持官方嵌套响应和现有通用响应；成功的公开视频链接优先走原生下载，没有链接时复用现有认证下载。合同任务遇到 `UNKNOWN` 按过期/无效任务失败处理，不永久轮询。远端取消不被假定可用，复用现有“停止本地轮询并显示远端取消结果”流程。

## 验证记录

- `pnpm test`：920 项通过（Contracts 12、Context 8、LLM 32、Adapters 25、Persistence 50、Desktop 272、Worker 522）。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- Rust：117 项通过；包含原生本地 HTTP 模拟的九张参考图提交及官方嵌套结果解析。现有 atomic API 弃用警告仍存在。
- `pnpm worker:sidecar`：通过；打包后的 Worker IPC 已在隔离临时设置目录中验证七个合同、七个合同 Adapter 和三个同步模型的能力/绑定，未触及用户设置或凭据。
- `pnpm tauri:build`：通过；生成 Windows NSIS 安装包 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。
- 现场失败复盘：文生视频最初被 Tauri 原生桥错误地要求读取 `AI_VIDEO_MEDIA_INPUT_ROOT`，即使请求没有本地输入；已修复为只有存在 `controlled-file://` 引用时才读取和校验该目录。针对 URL/纯文本视频提交的 Rust 回归测试通过。

## 千问/通义万相 Wan 3 扩展

同一合同机制已增加阿里云百炼官方 `wan3.0-video` 与 `wan3.0-video-prime`。官方来源为 [Wan 3 视频生成 API](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)。两者支持 `prompt`、`resolution`（1080P/720P/480P）、`ratio`（含 `adaptive`）、`duration`（2–30 秒）、`audio`、`prompt_extend`、`watermark` 和 `seed`（-1 或 0–2147483647）。UniComp 仅绑定这两个官方合同，没有添加 `generate_audio`、`seconds` 或其他中转站字段。

## 千问 Qwen Image 生图扩展

依据 [Qwen Image 官方 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)，新增 `qwen-image-3.0-pro`、`qwen-image-3.0`、`qwen-image-2.1-pro`、`qwen-image-2.1-turbo` 四个文生图合同。合同使用官方字段 `prompt`、`n`、`size`、`prompt_extend`、`prompt_extend_mode`、`enable_thinking`（3.0）、`negative_prompt`（3.0）、`watermark` 和 `seed`；不混入视频或中转站字段。UniComp 绑定后进入文生图制作，历史 `qwen-image-edit` 模板继续负责编辑路径。

现场验证发现 UniComp 对尺寸字段要求 `宽*高`，而官方合同使用 `宽x高`；这是绑定传输层的格式映射。UI 和合同仍使用官方 `1024x1024`，原生 UniComp 请求转换为 `1024*1024`；官方 `auto` 则省略该可选字段。
- 新增验证覆盖准确模型绑定、官方来源、未知字段拒绝、时长/分辨率/seed/中文提示词边界、一张首帧、九张参考图、编辑输入、旧目录迁移、制作界面、任务确认、合同快照和过期任务。

自动化测试验证的是合同、协议桥和本地任务管理，不代表真实渠道一定接受每个官方字段。真实渠道若不兼容，应修正共享协议实现或拒绝不兼容绑定，不回写或放宽官方合同。

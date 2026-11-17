# GPT 参考生图模型不可选补修

日期：2026-11-13，时区 Asia/Shanghai。

## 现场与原因

截图位于「图片制作 → 参考生图」，供应商连接只有 UniCompAPI 和万相。只读核对应用设置 SQLite 后确认，`gpt-image` 自定义连接仍启用且连接状态为 ready；`gpt-image-2`、`gpt-image-2.5`、`gpt-image-2.5-flare` 均启用，已声明图片生成和图片编辑能力。

此前适配器目录只有官方与自定义 OpenAI Images 的 `TEXT_TO_IMAGE`，没有 `REFERENCE_TO_IMAGE`。生产面板按当前制作模式筛选连接，因此参考生图会隐藏整个 GPT 连接。配置没有丢失，与 Agent 工具传输名称补修无关。

本轮没有读取凭据、修改用户模型设置、启用其他模型、提交真实生成或重跑原任务。

## 修复范围

1. 为 `openai` 与 `custom` 增加 `REFERENCE_TO_IMAGE:*:openai-images:v1`，通过动态 Schema 提供有序的 1–16 张参考图输入；移除仅适用于生成的 `style`。自定义服务继续允许自行声明的尺寸，不强制套用官方尺寸枚举。
2. 生产面板允许匹配适配器的官方 OpenAI 连接，并要求通用 Images 编辑适配器对应的模型明确声明 `imageEditing`。Worker 候选选择和提交前复核采用相同要求，继续排除停用、不可用的模型。
3. Native 将参考图编辑发送到所选连接 API 根路径下的 `/images/edits`，使用 multipart `image[]` 按顺序上传真实字节，并保留冻结的模型 ID。文生图继续使用原 JSON generation 路径。
4. 复用现有本地参考图受控文件、公开 HTTPS 下载、凭据隔离、图片格式验证、单张 25 MiB/请求 32 MiB 限制、五分钟接收超时、结果落地和错误分类。拒绝无效参数后再下载输入；保留提交确认与付费请求去重机制。

依据当日读取的 [OpenAI Images Edit 官方接口文档](https://developers.openai.com/api/reference/resources/images/methods/edit)：使用 `/images/edits` 和 multipart 参考文件，不向 GPT Image 2 注入不支持的 `input_fidelity`。本轮复用现有通用参数子集，不代表已经实现所有 GPT 图像模型的完整模型合同。

本轮未改变素材库、项目检索或已确认的产品要求，无需同步产品 DOCX。

## 实施与验证

- [x] R1 只读排查：确认已启用的连接、模型和编辑能力，定位当前模式缺少适配器。
- [x] R2 适配器和 Schema：generation-adapters 全部 6 文件、83 项通过，覆盖官方/自定义编辑适配器、缺少/过量参考图、禁止本地文件 URL、禁止 `style` 及尺寸约束。
- [x] R3 生产面板：ProductionPanel 7 文件 90 项与 Qwen 专项 1 项通过，合计 91 项；覆盖 GPT 连接显示、模型能力过滤、参考顺序和提交前停止。修正测试断言类型后，新文件 2 项复核通过，不重复计数。
- [x] R4 Worker 与 Native：Worker 的 media preparation、orchestration、handler、image generation 共 4 文件、140 项通过；Rust 库 218 项通过、8 项既有忽略。覆盖编辑专用模型、本地参考图受控快照、冻结的连接/模型、确认后提交、能力变更阻断、multipart 字节和尺寸限制。
- [x] R5 最终检查与安装包：全仓 typecheck、lint，变更文件 Prettier、Rust fmt 与 `git diff --check` 均通过；`pnpm tauri:build` 成功，重建 Worker sidecar、前端及 Rust release，生成 Windows x64 NSIS 安装包。保留既有 Rust unused 警告。

本机日志：`.codex-gpt-reference-adapters-all.log`、`.codex-gpt-reference-desktop-all.log`、`.codex-gpt-reference-qwen.log`、`.codex-gpt-reference-desktop-new.log`、`.codex-gpt-reference-worker-all.log`、`.codex-gpt-reference-rust-all.log`、`.codex-gpt-reference-typecheck.log`、`.codex-gpt-reference-lint.log`。

验证使用临时项目、模拟 Provider 和本地 HTTP 测试；没有调用用户的真实中转服务，不能据此声称已经完成真实付费生成。新增代码让已配置的编辑模型具备选择与提交路径，服务端是否支持其具体模型 ID 仍以实际服务为准。

## 安装包

2026-11-13 19:37:48 生成：

- 路径：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。
- 大小：77,281,859 字节。
- SHA256：`34AE3EFBA6C19D3CBA4019B8CD311864E5B4C273919EA8F45DFF72CDCA946937`。
- Native 应用 SHA256：`A0464F03070B74BE2BDB3E78D47AF19E5DFA329AD4280E9141A8B09FB3717CB5`。
- 构建日志：`.codex-gpt-reference-installer-build.log`。

安装包包含当前工作区已有改动，包括此前的 Agent 工具名称修复；未安装或重启用户正在运行的应用。

# UniCompAPI 集成与验收

日期：2026-09-18  
状态：模型目录改以 UniComp `GET /v1/models` 同步为准；自动化门禁覆盖协议 Agent、媒体模板和未知视频 ID 绑定。真实凭据冒烟待用户复验；安装包正式签名 `HOLD`

## 1. 用户流程

1. 在“供应商与模型”中点击 `UniCompAPI` 官方卡片。
2. 只填写 API Key；Base URL、协议和供应商类型由官方定义锁定。
3. 连接测试通过后，从 `GET /v1/models` 同步模型。
4. 在平铺模型列表中按模型 ID 或显示名称搜索。
5. 同步结果就是目录。未知 ID 也可以出现，默认关闭且能力为空；用户启用并勾选能力后才能用于 Chat / Agent / 媒体。
6. 媒体模型还要绑定参数模板后才会进入制作候选。LLM 不按模型名适配。

API Key 只保存在 Windows Credential Manager。请求发出去的 `model` 永远是该连接同步到的 `remoteModelId`，不做全球别名转换。

## 2. 内部能力合同

界面不做能力分类，内部仍使用显式合同控制入口和路由：

| 内部能力 | 生产能力 | 接口 |
| --- | --- | --- |
| `text-chat` / `text-reasoning` / `vision` | Chat | `POST /v1/chat/completions` |
| `text-to-image` | 文生图 | `POST /v1/images/generations` |
| `image-edit` | 图片编辑 | `POST /v1/images/generations`（华为云 ModelArts MaaS 图生图格式） |
| `text-to-video` | 文生视频 | `POST /v1/videos` |
| `image-to-video` | 图生视频 | `POST /v1/videos` |
| 视频任务查询 | 本地轮询 | `GET /v1/videos/{task_id}` |
| 视频结果下载 | 鉴权下载 | `GET /v1/videos/{task_id}/content` |

视频轮询保留 Provider 原始状态值：`unknown` 仅作为 UniCompAPI 初始暂态，`in_progress` 作为 OpenAI 兼容视频协议的标准活动状态；两者都只继续查询原 `task_id`，不会重新提交任务。

运行时目录权威是 UniComp `GET /v1/models` 同步进 `(connectionId, remoteModelId)`。代码不再维护 UniComp 模型 ID 白名单。

- LLM 只有 `openai-responses` / `openai-chat-completions` 两套协议。Agent 门禁是：协议属于上述之一、连接就绪、模型已启用且未下架、capabilities 含 text/streaming/tools。用户勾选即白名单，不再要求 5.6 家族。
- `gpt-5.6-sol` 已退休。不写死首选模型名；没有用户选择就弹出已启用且具备 tools 的目录模型，禁止静默切到其他供应商。
- 媒体候选要求：官方 UniComp 连接、模型已启用、已绑参数模板、模板支持该能力。新任务使用模板 Adapter Key；历史 per-model Key 只读可展示和轮询。
- Qwen 图编那种华为云平铺 `image` 投影是独立模板 `qwen-image-edit`，不按远程模型 ID 写死在路由里。

首次插入只对 `gpt-5.6*` 给出 text/streaming/tools/vision hint。未知 ID 默认同步为关闭且空能力。

## 3. 原生安全边界

- 官方配置必须精确匹配 `unicompapi`、`openai-chat-completions` 和 `https://unicompapi.com/v1`。
- Rust 固定请求主机、Bearer 鉴权、路径和模板字段白名单；`model` 由已启用目录行的 `remoteModelId` 注入，原生不再维护允许的模型 ID 列表。
- 新提交的 Adapter Key 必须为四段，并且第三段是已登记模板。历史任务轮询/下载接受格式正确的 UniComp 四段 Key。
- WebView 不能提交 `model`、API Key、Host、Endpoint 或任意附加字段。
- `qwen-image-edit` 模板在原生层校验 HTTPS URL 或 Data URL，并投影为华为云 ModelArts MaaS 的平铺 `model / prompt / image / size / response_format` JSON；通用图生视频模板投影为 JSON `image` 字段。
- 视频内容由原生层鉴权下载到系统临时目录；Worker 只接受该目录中的 MP4，校验大小、签名和 Hash 后移动到项目资产目录并删除临时源文件。
- Base64 图片会在任务快照中替换为 `local-image://omitted`；完整 Provider 响应、API Key 和视频临时路径不写入项目快照或诊断日志。
- UniCompAPI 未公开取消接口，应用只停止本地轮询并明确返回远端取消不受支持。

## 4. 自动验收证据

自动测试覆盖：

- 官方卡片配置锁定和 `/v1/models` 同步。
- 按模型 ID、显示名称搜索，不改变能力或启用状态。
- 未知模型可进目录，无能力且默认关闭；同步不覆盖用户已保存的能力勾选和模板绑定。
- 连接就绪、模型启用、能力勾选和模板绑定同时满足后才允许原生媒体路由。
- 目录行的远程模型 ID 原样注入；未知模板、能力错配、路径注入和额外字段被拒绝。
- 新同步的视频 ID 绑定 `openai-compatible-video` 后即可进入候选，无需改 Rust 加 ID。
- 图片生成、图片编辑、视频提交、查询和鉴权下载固定接口。
- 视频二进制临时文件的目录约束、MP4 签名、512 MiB 上限、资产提交和源文件清理。
- Vidu 原有 Adapter、Token 鉴权和路径白名单保持通过。

2026-08-11 发布候选复验：

- 独立 Worker Sidecar 重新打包成功；M7 Sidecar 生命周期确认损坏 JSON 恢复、离线示例、缓存边界、诊断脱敏和 SQLite 完整性。
- Tauri Release 与 NSIS 构建成功，安装包大小为 `20,562,761` 字节，SHA-256 为 `58BC379D496FC3E2AC728BDA3A4B5E132267470663B6F54C330D9F8199623029`。
- 临时目录干净安装通过：桌面程序和 `ai-video-worker.exe` 均存在，Worker 经启动检查保持存活，窗口可优雅关闭，Worker 随主进程退出，卸载后二进制清理完成。
- 安装包 Authenticode 状态为 `NotSigned`；正式签名门禁继续保持 `HOLD`。

推荐复验命令：

```powershell
pnpm -r build
pnpm -r typecheck
pnpm test
pnpm lint
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## 5. 真实环境人工验收

以下步骤会产生真实请求或费用，只能由用户使用自己的凭据执行：

- [x] 添加 UniCompAPI，只填写 API Key，确认连接测试和模型同步成功（2026-08-11 用户人工确认 `/v1/models` 可正常访问并显示全部模型）。
- [x] 搜索一个已知模型和一个未知模型，确认未知模型默认关闭且无生产入口（真实应用数据库共同步 32 个模型，其中 4 个未知能力模型全部关闭，未知模型启用数为 0）。
- [x] 使用一个聊天模型完成一次流式 Chat，记录模型 ID 和 HTTP 结果，不记录密钥或正文（2026-08-11 用户人工确认 `qwen3-32b` 真实流式调用成功）。
- [x] 使用 `qwen-image` 或 `doubao-seedream-5-0-260128` 完成一次生图并保存到素材库（2026-08-11 用户人工确认 `qwen-image` 真实生成成功并已保存到素材库）。
- [x] 使用 `qwen-image-edit-2509` 完成一次单图编辑，确认 Base64 不进入草稿和任务快照（2026-08-11 用户人工确认真实图片编辑成功；自动测试继续覆盖 Base64 脱敏）。
- [x] 使用一个视频模型完成提交、轮询、鉴权下载和本地素材登记（2026-08-11 用户人工确认 `viduq3-turbo` 真实生成成功；本地 MP4 已进入项目素材目录）。
- [x] 视频生成过程中重启应用，确认不会重复提交且能继续轮询（2026-08-11 用户进入最终验收阶段前确认视频流程均无异常）。
- [x] 检查诊断包、应用数据库和项目数据库，确认没有 API Key、完整 Provider 响应或视频临时路径（两份 SQLite 完整性和外键检查通过；Base64、Bearer/API Key、`X-Amz-*` 签名参数及临时视频路径均为 0 命中；诊断清单 Hash 校验通过；临时视频文件数为 0）。

2026-08-11 的真实凭据链路已通过，但 2026-09-18 起目录、Agent 门禁和媒体模板合同已改变。需要用户凭据重新同步后复验：任一已启用 tools 模型跑一轮 Agent；一个旧媒体回归；若目录出现 MiniMax / Hailuo，启用并绑定 `openai-compatible-video` 后再提交。剩余发布门禁仍为 Windows 安装包正式签名。

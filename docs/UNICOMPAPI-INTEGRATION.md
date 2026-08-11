# UniCompAPI 集成与验收

日期：2026-08-11  
状态：代码、自动化测试和生产构建 `PASS`；真实 UniCompAPI 凭据与额度调用 `HOLD`

## 1. 用户流程

1. 在“供应商与模型”中点击 `UniCompAPI` 官方卡片。
2. 只填写 API Key；Base URL、协议和供应商类型由官方定义锁定。
3. 连接测试通过后，从 `GET /v1/models` 同步模型。
4. 在平铺模型列表中按模型 ID 或显示名称搜索。
5. 已知模型显示能力标签，但不按能力分组；未知模型显示“能力未确认”。
6. 所有新同步模型默认关闭，用户只启用需要使用的模型。

API Key 只保存在 Windows Credential Manager。模型 ID 在同步、Adapter 解析、请求体和任务快照中保持原值，不做别名转换。

## 2. 内部能力合同

界面不做能力分类，内部仍使用显式合同控制入口和路由：

| 内部能力 | 生产能力 | 接口 |
| --- | --- | --- |
| `text-chat` / `text-reasoning` / `vision` | Chat | `POST /v1/chat/completions` |
| `text-to-image` | 文生图 | `POST /v1/images/generations` |
| `image-edit` | 图片编辑 | `POST /v1/images/edits/`（`multipart/form-data`） |
| `text-to-video` | 文生视频 | `POST /v1/videos` |
| `image-to-video` | 图生视频 | `POST /v1/videos` |
| 视频任务查询 | 本地轮询 | `GET /v1/videos/{task_id}` |
| 视频结果下载 | 鉴权下载 | `GET /v1/videos/{task_id}/content` |

当前媒体模型白名单来自 `packages/generation-adapters/src/index.ts`，能力事实来自 `apps/worker/src/provider-registry.ts`。两处变更必须同步评审和测试；仅出现在远端目录中的未知模型不会自动获得 Adapter。

## 3. 原生安全边界

- 官方配置必须精确匹配 `unicompapi`、`openai-chat-completions` 和 `https://unicompapi.com/v1`。
- Rust 固定请求主机、Bearer 鉴权、路径和每种能力的字段白名单。
- Adapter Key 必须为四段，供应商、版本、能力和模型组合都必须命中静态合同。
- WebView 不能提交 `model`、API Key、Host、Endpoint 或任意附加字段。
- 图片编辑和图生视频只接受一张参考图；图片编辑在原生层校验并解码 Data URL，以受限 multipart 二进制 `image` 文件字段发送，图生视频投影为 JSON `image` 字段。
- 视频内容由原生层鉴权下载到系统临时目录；Worker 只接受该目录中的 MP4，校验大小、签名和 Hash 后移动到项目资产目录并删除临时源文件。
- Base64 图片会在任务快照中替换为 `local-image://omitted`；完整 Provider 响应、API Key 和视频临时路径不写入项目快照或诊断日志。
- UniCompAPI 未公开取消接口，应用只停止本地轮询并明确返回远端取消不受支持。

## 4. 自动验收证据

自动测试覆盖：

- 官方卡片配置锁定和 `/v1/models` 同步。
- 按模型 ID、显示名称搜索，不改变能力或启用状态。
- 已知模型能力推断、未知模型无能力且默认关闭。
- 连接就绪、模型启用和精确能力三项同时满足后才允许原生媒体路由。
- 模型 ID 原样注入，能力错配、路径注入和额外字段被拒绝。
- 图片生成、图片编辑、视频提交、查询和鉴权下载固定接口。
- 视频二进制临时文件的目录约束、MP4 签名、512 MiB 上限、资产提交和源文件清理。
- Vidu 原有 Adapter、Token 鉴权和路径白名单保持通过。

2026-08-11 发布候选复验：

- 独立 Worker Sidecar 重新打包成功；M7 Sidecar 生命周期确认损坏 JSON 恢复、离线示例、缓存边界、诊断脱敏和 SQLite 完整性。
- Tauri Release 与 NSIS 构建成功，安装包大小为 `20,551,685` 字节，SHA-256 为 `C47BAF6404964609583D20ACF532A5D24CE326C2FA629D16350D2A99C739156D`。
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
- [ ] 搜索一个已知模型和一个未知模型，确认未知模型默认关闭且无生产入口。
- [x] 使用一个聊天模型完成一次流式 Chat，记录模型 ID 和 HTTP 结果，不记录密钥或正文（2026-08-11 用户人工确认 `qwen3-32b` 真实流式调用成功）。
- [x] 使用 `qwen-image` 或 `doubao-seedream-5-0-260128` 完成一次生图并保存到素材库（2026-08-11 用户人工确认 `qwen-image` 真实生成成功并已保存到素材库）。
- [ ] 使用 `qwen-image-edit-2509` 完成一次单图编辑，确认 Base64 不进入草稿和任务快照。
- [ ] 使用一个视频模型完成提交、轮询、鉴权下载和本地素材登记。
- [ ] 视频生成过程中重启应用，确认不会重复提交且能继续轮询。
- [ ] 检查诊断包、应用数据库和项目数据库，确认没有 API Key、完整 Provider 响应或视频临时路径。

完成前，UniCompAPI 的真实 Provider 验收状态保持 `HOLD`，自动 Mock 或本地服务器测试不能替代该结论。

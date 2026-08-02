# M4 适配器与动态参数

版本：4  
日期：2026-08-02

状态：M4 代码、自动化修复门禁、Release 同目录启动冒烟和 Vidu 官方失败响应 `PASS`；项目最终发布签收 `HOLD`。带真实凭据的 Vidu 成功调用属于 M5/M6 验收，不作为进入 M5 的循环前置条件。

## 1. 范围

M4 建立“生产方式 + 供应商 + 模型 + API 版本”到唯一适配器、参数 JSON Schema 和 UI Schema 的映射。当前阶段只保存经过校验的参数草稿，不提交真实生图或视频任务，不读取会话内容，也不允许 LLM 填写生产参数。

Registry 来自 Vidu 官方 [Model Map](https://platform.vidu.com/docs/model-map)、[Reference to Image](https://platform.vidu.com/docs/reference-to-image)、[Image to Video](https://platform.vidu.com/docs/image-to-video)，以及 2026-08-02 核对的 [Q3-Drama 发布说明](https://shengshu.feishu.cn/wiki/UFg3wlDdziaQ7ZkHafgcaCU5ntc) 和其链接的 [参考生 API（Q3）](https://shengshu.feishu.cn/wiki/URYzwxfMWizDM7kRlCwcRI3Ynzf)：

| 能力 | 模型 | 关键约束 |
|---|---|---|
| `TEXT_TO_IMAGE` | `viduq2` | 无参考图，1080p/2K/4K |
| `REFERENCE_TO_IMAGE` | `viduq2` | 1–7 张参考图，1080p/2K/4K |
| `REFERENCE_TO_IMAGE` | `viduq1` | 1–7 张参考图，仅 1080p |
| `TEXT_TO_VIDEO` | `viduq3-pro` | 无输入图片，1–16 秒，540p/720p/1080p |
| `REFERENCE_TO_VIDEO` | `viduq3` | 1–7 张参考图，3–16 秒，540p/720p/1080p |
| `REFERENCE_TO_VIDEO` | `viduq3-drama` | 1–7 张参考图，2–15 秒，720p/1080p，仅 9:16/16:9，支持音画直出 |
| `START_END_TO_VIDEO` | `viduq3-pro` | 严格 2 张首尾帧，1–16 秒，540p/720p/1080p |
| `IMAGE_TO_VIDEO` | `vidu2.0` | 1 张起始帧；4 秒支持 360p/720p/1080p，8 秒仅支持 720p |

未列出的能力、模型和字段不进行推测，也不会回退到相近适配器。

## 2. 不变量

- 适配器键固定为 `capability:provider:model:apiVersion`，Registry 内必须唯一。
- `modelLabel` 使用官方产品名；模型选择器不得把 `apiVersion` 拼进模型名。API 版本在适配器元信息中单独展示，并继续由完整 `adapterKey` 锁定。
- 已持久化任务使用过的旧视频适配器键只保留为兼容查找项，不再出现在新任务目录中；重启恢复不得因能力拆分而丢失旧任务。
- 解析结果必须恰好为一个；零个或多个匹配都视为错误。
- 参数对象必须通过适配器 JSON Schema，`additionalProperties` 固定为 `false`。
- 模型、时长、分辨率和素材数量的组合约束在 Worker 中复验，React 校验不能作为安全边界。
- 参数草稿属于唯一的 `shotId + adapterKey`，不得跨镜头或跨项目读取。
- 只读项目可以查看草稿，不能保存草稿。
- API Key 不得出现在 Worker IPC、参数对象、SQLite、项目目录、日志或错误详情中。
- WebView 只能提交完整 `adapterKey` 和参数；不能指定凭据供应商、目标主机、路径、认证头或模型。
- LLM、上下文编译器和会话产物不得自动修改参数草稿。

## 3. 数据与 IPC

Registry 由 `@ai-video/generation-adapters` 提供，Worker 暴露：

```text
adapter.catalog
adapter.resolve
adapter.validate
generation.draft.get
generation.draft.save
```

`generation_drafts` 使用现有 Schema v1 表，按 `shot_id + adapter_key` 唯一覆盖。保存前校验适配器存在、镜头属于当前项目、项目可写以及完整参数 Schema；失败时不执行 SQLite 写入。

## 4. 凭据边界

凭据流向固定为：

```text
React 凭据输入
-> Tauri credential_set 命令
-> Windows Credential Manager
```

提交生产请求时使用另一条仅限原生端的路径：

```text
React（adapterKey + 已校验参数）
-> Tauri provider_submit
-> Rust adapterKey/字段白名单 + 服务端模型注入
-> Windows Credential Manager 读取
-> WinHTTP HTTPS（Authorization: Token ...）
-> Vidu 固定主机和路径
```

凭据目标为 `com.ai-video.workspace:<provider>`。Rust 端只允许显式供应商白名单，目前为 `vidu`；状态命令只返回 `configured: boolean`，不向 WebView 返回密钥。`provider_submit` 只接受 Registry 中的完整 adapter key，主机固定为 `api.vidu.com`，路径按 adapter 固定，自动重定向关闭，WebView 传入的 `apiKey`、`endpoint`、`model` 和未知字段均拒绝。密钥只在 Rust 内存和 WinHTTP 认证头中短暂存在，不进入通用 Worker IPC。Windows 安全存储不可用时明确报错，不回退到文件、环境变量或 SQLite。

## 5. 故障矩阵

| 场景 | 结果 |
|---|---|
| 能力/供应商/模型无匹配 | 返回 `ADAPTER_NOT_FOUND`，不回退 |
| 参数包含 `apiKey` 或未知字段 | 返回 `INVALID_PARAMETERS`，不写草稿 |
| Vidu 2.0 选择 8 秒 + 1080p | 组合校验失败 |
| 参考图数量超出模型上限 | Schema 校验失败 |
| 镜头属于其他项目 | 拒绝读取和保存 |
| 项目只读 | 草稿保存失败 |
| 切换模型 | 只渲染新适配器声明的字段，并按新键读取草稿 |
| Windows 凭据管理器不可用 | 显示错误，不创建明文后备存储 |
| WebView 伪造 adapter、endpoint 或凭据字段 | Rust 白名单拒绝，不读取或发送凭据 |
| Vidu 返回重定向 | 原生传输拒绝自动重定向，认证头不转发到其他目标 |

## 6. 验证

- Registry 契约测试覆盖唯一解析、无回退、未知字段、素材上限和 Vidu 2.0 时长/分辨率组合。
- Worker 集成测试覆盖按镜头保存与读取、非法参数拒绝，以及敏感测试值不进入项目 SQLite。
- React 测试覆盖 Schema 字段渲染、专业参数区、完整 adapter key/API Version 锁定、保存前校验和非法参数不保存。
- Rust 测试覆盖凭据供应商白名单、adapter 到 Vidu 主机/路径的固定映射、服务端模型注入，以及凭据/endpoint 字段拒绝；真实凭据写入只在用户显式操作时执行，不在自动化测试中污染系统凭据。
- Sidecar 生命周期测试覆盖当前适配器目录解析、非法组合拒绝、草稿往返和数据库凭据排除。
- 2026-08-02 向固定 Vidu 官方端点发送无效测试令牌，得到 HTTP `403` 官方失败响应；未创建任务或消耗额度。

带真实凭据的 Vidu 成功请求属于 M5/M6，本轮未执行；M4 已验证安全桥的路由与拒绝规则，并取得无效测试令牌对应的官方 HTTP `403` 失败响应。

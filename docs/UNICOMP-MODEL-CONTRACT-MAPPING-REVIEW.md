# UniComp 模型合同映射审核清单

日期：2026-10-10  
状态：已确认并实施

## 1. 当前实际状态

目前代码中的 `ModelBinding` 主要绑定官方供应商模型，例如：

| Provider | 远程模型 ID | 当前合同 |
|---|---|---|
| `deepseek` | `deepseek-v4-pro` | `cn.deepseek.v4-pro` |
| `deepseek` | `deepseek-flash` | `cn.deepseek.v4.1-flash` |
| `zhipu` | `glm-5` | `cn.zhipu.glm-5` |
| `zhipu` | `glm-5.3` | `cn.zhipu.glm-5.3` |
| `zhipu` | `glm-5.3-flash` | `cn.zhipu.glm-5.3-flash` |
| `kimi` | `kimi-k3` | `cn.kimi.k3` |
| `minimax` | `MiniMax-M3` | `cn.minimax.m3` |
| `minimax` | `MiniMax-H3` | `cn.minimax.h3` |

这些不是 UniComp 模型绑定，只是官方供应商绑定。

## 2. UniComp LLM 映射候选

以下是建议审核的候选映射。`providerType` 必须是 `unicompapi`，`remoteModelId` 必须以该连接实际 `GET /v1/models` 返回值为准。没有实际目录 ID 的项目不能自动创建 Binding。

| 审核 | UniComp `remoteModelId` | 拟绑定官方合同 | 映射理由 | 需要确认 |
|---|---|---|---|---|
| [ ] | `deepseek-v4-pro` | `cn.deepseek.v4-pro` | 名称和官方模型 ID 一致 | UniComp 是否原样转发该 ID；工具、思考、流式字段是否兼容 |
| [ ] | `deepseek-flash` | `cn.deepseek.v4.1-flash` | DeepSeek 官方当前 API 使用该稳定 ID | UniComp 是否返回 `deepseek-flash`；视觉输入是否可用 |
| [ ] | `glm-5` | `cn.zhipu.glm-5` | 名称和官方模型 ID 一致 | thinking、工具调用、结构化输出是否原样支持 |
| [ ] | `glm-5.3` | `cn.zhipu.glm-5.3` | 名称和官方模型 ID 一致 | UniComp 目录是否已经提供该 ID |
| [ ] | `glm-5.3-flash` | `cn.zhipu.glm-5.3-flash` | 名称和官方模型 ID 一致 | 视觉、流式工具调用是否完整支持 |
| [ ] | `kimi-k3` | `cn.kimi.k3` | 名称和官方模型 ID 一致 | Kimi K3 的工具调用和上下文限制是否被中转站保留 |
| [ ] | `MiniMax-M3` | `cn.minimax.m3` | 名称和官方模型 ID 一致 | 大小写、连字符和真实目录 ID 是否一致 |
| [ ] | `MiniMax-H3` | `cn.minimax.h3` | 名称和官方模型 ID 一致 | H3 实际是文本模型还是其他媒体模型；协议能力是否一致 |
| [ ] | `<UniComp Qwen 最新 ID>` | `cn.qwen.text.latest`（待建立） | Qwen 官方模型合同族 | 目前缺少已核验的 Qwen 最新官方 API 模型 ID，暂不绑定 |
| [ ] | `<UniComp 豆包最新 ID>` | `cn.doubao.text.latest`（待建立） | 豆包官方模型合同族 | 目前缺少已核验的火山方舟 API 模型 ID，暂不绑定 |

## 3. UniComp 图片映射候选

图片模型必须先确认请求字段和响应结构；仅凭模型名相似不能绑定。

| 审核 | UniComp `remoteModelId` | 拟绑定合同 | 当前判断 |
|---|---|---|---|
| [ ] | `qwen-image` | `cn.qwen.image.latest` | 候选；需要确认是当前 Qwen Image 版本，以及 `prompt/images/size` 字段是否一致 |
| [ ] | `<UniComp Seedream 最新 ID>` | `cn.seedream.image.latest`（待建立） | 候选；需要官方当前 Seedream API 文档和实际目录 ID |
| [ ] | `<UniComp GLM-Image ID>` | `cn.zhipu.glm-image`（待建立） | 候选；需要确认图像合同和异步生命周期 |

当前已存在的模板合同：

| 模板 | 合同 |
|---|---|
| `openai-compatible-image` | `media.openai-compatible-image` |
| `qwen-image-edit` | `cn.qwen.image.latest` |

模板合同不等于具体 UniComp 模型 Binding。模型仍需要单独绑定模板或合同。

## 4. UniComp 视频映射候选

视频必须同时确认提交、轮询、输出和取消语义。不能只因为走 `/v1/videos` 就认定合同相同。

| 审核 | UniComp `remoteModelId` | 拟绑定合同/模板 | 当前判断 |
|---|---|---|---|
| [ ] | `viduq3` | `vidu.q3.reference-video` | 候选；需要确认 UniComp 是否保持 Vidu `images[]`、状态和输出结构 |
| [ ] | `<UniComp Kling 最新 ID>` | `media.openai-compatible-video` | 候选；需要确认时长、分辨率、图片字段和轮询状态 |
| [ ] | `<UniComp Seedance 最新 ID>` | `media.openai-compatible-video` | 候选；需要确认请求字段和异步响应 |
| [ ] | `<UniComp MiniMax/Hailuo 最新 ID>` | `media.openai-compatible-video` 或独立 MiniMax 视频合同 | 未确认；需要真实请求样本 |
| [ ] | `<UniComp Vidu 首尾帧 ID>` | `vidu.q3.start-end-video` | 候选；需要确认严格两张首尾帧和 Vidu 字段约束 |

当前已存在的视频模板合同：

| 模板 | 合同 |
|---|---|
| `openai-compatible-video` | `media.openai-compatible-video` |
| `vidu-compatible-reference` | `vidu.q3.reference-video` |
| `vidu-compatible-start-end` | `vidu.q3.start-end-video` |

## 5. 映射启用规则

只有满足以下条件，某条映射才能从审核清单进入 `model_bindings` 的 `enabled` 状态：

1. UniComp `/v1/models` 返回了精确的 `remoteModelId`。
2. 远程模型身份与官方合同确实对应，而不是只共享一个品牌名。
3. 请求字段、响应字段、流式/异步生命周期和错误语义通过脱敏样例验证。
4. 中转站缺失的能力已从 Binding 中显式覆盖，不能静默丢弃参数。
5. 用户确认合同和 Binding 后，才允许进入运行时选择器。

## 6. 请确认的最小决策

请逐条回复以下形式即可：

```text
deepseek-v4-pro -> 确认 / 拒绝 / 修改为 xxx
deepseek-flash -> 确认 / 拒绝 / 修改为 xxx
glm-5 -> 确认 / 拒绝 / 修改为 xxx
glm-5.3 -> 确认 / 拒绝 / 修改为 xxx
glm-5.3-flash -> 确认 / 拒绝 / 修改为 xxx
kimi-k3 -> 确认 / 拒绝 / 修改为 xxx
MiniMax-M3 -> 确认 / 拒绝 / 修改为 xxx
MiniMax-H3 -> 确认 / 拒绝 / 修改为 xxx
qwen-image -> 确认 / 拒绝 / 修改为 xxx
viduq3 -> 确认 / 拒绝 / 修改为 xxx
```

在确认前，这些 UniComp 映射保持未启用，不会改变当前运行时路由。

## 7. 已实施结果

用户已确认本清单中的明确模型映射。以下 Binding 已写入目录并启用：

| UniComp `remoteModelId` | 合同 |
|---|---|
| `deepseek-v4-pro` | `cn.deepseek.v4-pro` |
| `deepseek-flash` | `cn.deepseek.v4.1-flash` |
| `deepseek-v4-flash` | `cn.deepseek.v4.1-flash` |
| `deepseek-v4-flash-0731` | `cn.deepseek.v4.1-flash` |
| `glm-5` | `cn.zhipu.glm-5` |
| `glm-5.3` | `cn.zhipu.glm-5.3` |
| `glm-5.3-flash` | `cn.zhipu.glm-5.3-flash` |
| `kimi-k3` | `cn.kimi.k3` |
| `MiniMax-M3` | `cn.minimax.m3` |
| `MiniMax-H3` | `cn.minimax.h3` |
| `qwen-image` | `cn.qwen.image.latest` |
| `viduq3` | `vidu.q3.reference-video` |

Qwen、豆包、Kling、Seedance、Hailuo 的占位项没有被伪造为具体远程 ID，仍需等 UniComp `/v1/models` 返回精确 ID 后再新增 Binding。

## 8. HappyHorse 官方合同扩展（2026-10-11）

用户要求完整接入 HappyHorse，且合同只允许同步官方参数。新增七个官方合同及纯 ModelBinding；不新增 HappyHorse 中转站适配器，不写中转站参数 Schema。映射在已同步/手动导入的对应目录行存在时才生效，模型启用状态仍由用户管理。

| UniComp 远程 ID | 官方合同 |
|---|---|
| `happyhorse-1.0-t2v` | `cn.happyhorse.1.0.t2v` |
| `happyhorse-1.1-t2v` | `cn.happyhorse.1.1.t2v` |
| `happyhorse-1.0-i2v` | `cn.happyhorse.1.0.i2v` |
| `happyhorse-1.1-i2v` | `cn.happyhorse.1.1.i2v` |
| `happyhorse-1.0-r2v` | `cn.happyhorse.1.0.r2v` |
| `happyhorse-1.1-r2v` | `cn.happyhorse.1.1.r2v` |
| `happyhorse-1.0-video-edit` | `cn.happyhorse.1.0.video-edit` |

官方文档、参数边界和验证证据见 [HappyHorse 官方合同接入](HAPPYHORSE-CONTRACT-IMPLEMENTATION.md)。参数完整继承官方合同，现有视频协议负责通用传输；没有 `transportOverride`。官方仅支持取消 PENDING 任务；现有 UniComp 通道没有远端取消协议，因此绑定为 partial，并显式将 `videoCancellation` 覆盖为 false，不改动官方参数。自动化提交验证已通过，真实渠道付费验收仍未执行。

Wan 3（千问/通义万相视频）同样只登记官方合同：`wan3.0-video` → `cn.qwen.wan3-0-video`，`wan3.0-video-prime` → `cn.qwen.wan3-0-video-prime`。具体远程 ID 仍须出现在 UniComp `/v1/models` 同步结果中，未同步时不会进入制作候选。

Qwen Image 生图已按阿里云百炼官方 OpenAI 兼容图片 API 登记：

| UniComp 远程 ID | 官方合同 |
|---|---|
| `qwen-image-3.0-pro` | `cn.qwen.qwen-image-3-0-pro` |
| `qwen-image-3.0` | `cn.qwen.qwen-image-3-0` |
| `qwen-image-2.1-pro` | `cn.qwen.qwen-image-2-1-pro` |
| `qwen-image-2.1-turbo` | `cn.qwen.qwen-image-2-1-turbo` |

合同参数来源为官方文档；绑定出现于 UniComp `/v1/models` 同步结果后，进入文生图候选。已有 `qwen-image` 与 `qwen-image-edit-2509` 历史模板路径不自动改写。

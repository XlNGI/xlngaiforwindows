# UniComp 模型适配与 MiniMax 接入实施计划

版本：1.1  
日期：2026-09-18  
状态：P0-P4 自动化门禁已通过；真实 UniComp 冒烟待用户凭据复验  
适用范围：Desktop、Worker、Contracts、Generation Adapters、Provider Native Bridge

> 本文档是后续实施的单一事实来源。已确认决策实施中不得临时改成「按供应商家族 / 按全球同名映射 / 把 UniComp 模型表再抄进代码」方案。

## 1. 执行状态

- [x] P0 删多余适配：去掉过时硬编码目录，改以 UniComp `/v1/models` 同步结果为准
- [x] P1 LLM：Agent 走协议 + 启用；同步不再覆盖能力；Sol 下架收口
- [x] P2 媒体模板：少量协议/模板替代 per-model UniComp adapter；原生按模板校验字段，不再维护模型 ID 数组
- [x] P3 MiniMax：UniComp 托管 MiniMax 共用通用视频模板，不新增官方 MiniMax 卡片或模型 ID 数组
- [x] P4 验收：自动化门禁已通过（generation-adapters / worker / desktop / persistence / cargo test）。真实 UniComp 冒烟仍需用户凭据

## 2. 文档目的

UniComp 线上模型列表已经更新，仓库里的硬编码适配是过时快照。本轮目标：

1. **删掉多余适配**，不再把 UniComp 某个日期的模型表写进 TS / Rust。
2. 把还要用的能力收成**少量协议和 schema 模板**。LLM 不按模型适配；媒体按模板适配。
3. **新增 MiniMax 模板**，供 UniComp 同步到的 MiniMax 模型绑定。不把 MiniMax 再抄成另一份家族白名单。
4. UniComp 与 NewAPI 共用协议代码。UniComp 只作为推荐官方卡片。

UniComp 是自有中转站，和 NewAPI 本质都是 OpenAI 兼容协议。分开是为了推荐，不是因为请求格式不同。

## 3. 已确认的产品与架构决策

| 主题 | 决策 |
|---|---|
| 目录权威 | 运行时权威是 UniComp `GET /v1/models` 同步进 `(connectionId, remoteModelId)` 的目录。代码里的模型表不是权威源 |
| 删多余适配 | 删除 per-model UniComp adapter、过时能力表、Rust 模型 ID 白名单。UniComp 下架的模型不得继续占用适配器 |
| UniComp vs NewAPI | 同一套 LLM 协议适配器。UniComp 是官方推荐卡片（锁定 `https://unicompapi.com/v1` + Chat Completions）；NewAPI 走「自定义供应商」 |
| 不按家族适配 | 不为 UniComp 单独做 GPT-5.6 家族，也不为 NewAPI 再做一套 5.6 / MiniMax 家族 |
| 身份 | 模型身份是 `(connectionId, remoteModelId)`。请求发出去的永远是该连接同步到的远程 ID |
| 同名 | 不保证官方与中转站同名，不做全球别名表，不跨连接合并目录行 |
| 真正要映射的 | 媒体映射的是 **schema 模板**，不是名字。LLM 不需要名字映射 |
| LLM 适配器数量 | 只有两个：`openai-responses`、`openai-chat-completions` |
| Agent 门禁 | 协议是上述之一 + 连接就绪 + 模型已启用 + 具备 text/streaming/tools。用户勾选即白名单 |
| 下架模型 | `gpt-5.6-sol` 已下架，不得再作为 Agent 默认或推荐 |
| 默认 LLM | 有可用模型时优先 `gpt-5.6-terra`；没有则让用户选，禁止静默切到其他供应商 |
| 参数来源 | `/v1/models` 只给 ID（偶尔有展示名），**不给 JSON 参数表**。LLM 用协议字段；媒体用内置模板或用户确认的 `adapter_schemas` |
| 同步 | 远程同步不得覆盖用户已保存的能力勾选；推断只用于首次插入，允许不完整 |
| 故障 | 渠道没有 / 模型下架 → `model_unavailable` + 选择器。禁止静默 failover |
| 媒体执行 | 本轮媒体仍只走官方 UniComp / 官方 Vidu 主机。自定义供应商继续只支持 LLM |
| 原生安全 | 锁主机、路径、鉴权、模板字段白名单。`model` 由 Worker 已启用目录行注入，原生不再维护「允许的模型 ID 列表」 |
| MiniMax | 本轮只给 UniComp 托管 MiniMax 绑视频模板。官方 MiniMax 独立卡片不塞进本轮 |

## 4. 当前过时点：硬编码就是多余适配

2026-08-11 验收时 UniComp 同步了 32 个模型，随后被抄进三处。线上目录已经更新，这三处已经过时，而且会阻止新模型（包括 MiniMax）进入生产。

| 过时清单 | 位置 | 处理 |
|---|---|---|
| `UNICOMPAPI_MEDIA_MODELS` + `unicompApiAdapters()` | `packages/generation-adapters/src/index.ts` | **删除**。不再为每个 UniComp 模型生成 `TEXT_TO_*:unicompapi:<id>:v1` |
| `UNICOMPAPI_MODEL_FEATURES` | `apps/worker/src/provider-registry.ts` | **删除作为目录**。最多留极小的首次插入 hint，缺了也不能挡住同步模型 |
| `UNICOMPAPI_*_MODELS` 数组 | `apps/desktop/src-tauri/src/lib.rs` | **删除**。改成按能力/模板校验字段，注入目录行的 `remoteModelId` |
| `UNICOMPAPI_CHAT_COMPLETIONS_AGENT_MODEL_ALLOWLIST` | `provider-registry.ts` | **删除**。Agent 不再看 5.6 家族 |
| `gpt-5.6-sol` 路由常量作为运行时条件 | `unicompapi-chat-completions-gpt-5.6-sol-v1` | **删除或降为历史注释**。Sol 只保留退休拒绝 |
| 空能力占位 | `happyhorse-1.0-r2v` / `1.1-r2v` / `1.0-video-edit` | **删除**。没有模板就不要占适配位 |
| 三处不一致 | Rust 有 `viduq3-ad`，TS UniComp adapter/能力表没有 | **随硬编码清单一起删**，是否可用改由同步目录 + 模板绑定决定 |

官方 Vidu adapter（`vidu-global` / `vidu-china`）不是多余项，保留。删的是 **UniComp 那一层 per-model 复制**。

本地 `app-settings.sqlite` 当前没有已保存的 UniComp 连接，所以不能从本机再读出新目录。实施时以用户重新「测试并同步」的结果为准，而不是把旧 32 个模型再写回代码。

## 5. 当前基线与缺口

### 5.1 供应商分层（已存在，保持）

| 入口 | 代码位置 | 现状 |
|---|---|---|
| 官方 UniComp | `provider-registry.ts` 官方定义；`ProviderEditor` 官方卡片 | 推荐给用户；Base URL / 协议锁定 |
| 官方 OpenAI / Vidu | 同上 | 继续独立官方卡片 |
| NewAPI / 其他中转站 | `accessType: custom` + 用户选协议和 Base URL | 与 UniComp 共用两个 LLM 协议；**不能走媒体原生通道** |

自定义供应商今天被限制为 `category: llm`。本轮不把 NewAPI 扩成媒体通道。

### 5.2 LLM 缺口

| 项 | 现状 | 问题 |
|---|---|---|
| Agent 路由 | `resolveAgentToolLoopRoute` 把 UniComp 限制在 `gpt-5.6*`，并排除 Sol | 过时家族白名单；UniComp 新 LLM 进不来 |
| 能力推断 | `inferUniCompApiCapabilities` 依赖过时 `UNICOMPAPI_MODEL_FEATURES` | 新模型同步后能力全空或被错误覆盖 |
| 同步覆盖 | `synchronizeRemoteModels` / `listModels` 每次用推断覆盖 | 用户勾选会被冲掉 |
| 默认模型 | `packages/llm/src/index.ts` 默认 `gpt-5.6-terra` | 保留；Sol 不得回潮 |

LLM **不需要**按模型写 adapter。Chat Completions 已经能发。同步到什么 ID 就填什么 `model`。

### 5.3 媒体缺口

候选匹配现在赌供应商类型和远程 ID 完全一致：

```text
adapter.provider === profile.providerType
adapter.model === model.remoteModelId
```

这会逼出 UniComp 复制 Vidu / Kling / Seedance / Qwen / HappyHorse 的 adapter。线上模型一换，复制件全部过时。

参数 schema **不会**从 `/v1/models` 长出来。删掉 per-model adapter 之后，来源只剩：

1. 少量内置模板（OpenAI 兼容生图、OpenAI 兼容生视频、Qwen 图编投影、Vidu 兼容参考/首尾帧、MiniMax 视频）
2. `adapter.schema.propose` → 用户确认 → `adapter_schemas`
3. 都没有 → `schemaReady=false`，拦住提交

### 5.4 MiniMax 空白

仓库里没有任何 MiniMax / Hailuo 字符串。不要先猜官方 ID 写进白名单。

UniComp 现有视频走 `POST /v1/videos`。P3 只新增 **MiniMax 视频模板**；具体远程 ID 以同步目录为准。若某次同步出现 Hailuo / MiniMax 模型，用户启用并绑模板即可生产。

官方 MiniMax `POST /v1/video_generation` 不写进 UniComp 原生通道。

## 6. 目标架构

```text
GET /v1/models  ──同步──►  目录行 (connectionId, remoteModelId)
                              │ 用户启用 / 勾选能力 / 绑定模板
                              ▼
LLM：协议 adapter × 2  ──►  Native Chat Completions / Responses
                              model = remoteModelId

媒体：schema 模板（少量）──►  Native 按模板投影
                              host/path/fields 锁定
                              model = remoteModelId
                              无模板 = 不能提交
```

保留的适配器应该少到能数清：

| 保留 | 用途 |
|---|---|
| `openai-responses` / `openai-chat-completions` | 全部 LLM，包括 UniComp、OpenAI、NewAPI |
| 官方 Vidu HTTP adapter | Vidu 国际站 / 中国站 |
| UniComp 图像模板 | `POST /v1/images/generations` 通用字段 |
| UniComp 图编模板 | 仅 Qwen 图编那种特殊投影；没绑这个模板就走通用图像或不可用 |
| UniComp 视频模板 | `POST /v1/videos` 通用字段（Kling / Seedance / HappyHorse / MiniMax 先共用，除非实机证明字段不兼容） |
| Vidu 兼容视频模板 | 参考生 / 首尾帧仍要 `images[]` 的 UniComp 模型 |
| MiniMax 视频模板 | 仅当 UniComp 的 MiniMax 合同与通用视频字段不兼容时才独立；能共用就不要新模板 |

## 7. 参数如何获取（落地）

| 类型 | 怎么拿到 | 怎么用 |
|---|---|---|
| 模型有哪些 | 每次「测试并同步」拉 `/v1/models` | 写入该连接目录，下架标记 `unavailableAt` |
| LLM 请求体 | 不获取。协议固定 | `remoteModelId` 原样填 `model` |
| LLM 能力 | 首次插入可用粗规则提示；之后以模型管理页勾选为准 | Agent 看 text + streaming + tools + 已启用 |
| 媒体参数 | 少量内置模板，或 Agent propose 后用户确认 | `AgentParameterCard` / `ProductionPanel` |
| 媒体绑定 | 用户选模板；可选的首次插入 hint 允许过时 | 不绑就不进候选 |

显示名只给人看。跨连接同名最多碰巧绑同一模板，不是同一条模型。

## 8. 实施阶段

### P0 删掉多余适配

目标：代码不再携带一份过时的 UniComp 模型表。

删除：

- `unicompApiAdapters()` / `UNICOMPAPI_MEDIA_MODELS`
- `UNICOMPAPI_MODEL_FEATURES` 作为生产目录
- Rust `UNICOMPAPI_TEXT_TO_IMAGE_MODELS` 等 ID 数组
- Agent `gpt-5.6*` allowlist
- 空能力占位和 Rust 里对不上的 `viduq3-ad` UniComp 条目

同步行为：

- UniComp 连接「测试并同步」后，目录以远端为准
- 远端没有的旧模型标记不可用，不能启用
- 远端新出现的模型默认关闭，等待用户勾选能力和（若是媒体）绑定模板
- 不得因为代码里没有这个 ID 就拒绝写入目录

验收：

- generation-adapters 目录里不再出现 `TEXT_TO_IMAGE:unicompapi:<具体模型>:v1` 这种按模型展开的 key
- `cargo test` / Worker 测试不再断言「只有名单内模型才能组 UniComp payload」
- 同步一个代码里从未写过的模型 ID，目录能出现该行，且默认关闭

### P1 LLM：协议门禁，不按 5.6 家族

涉及：

- `apps/worker/src/provider-registry.ts`
- `apps/worker/src/app-settings-service.ts`
- `apps/desktop/src/ChatPanel.tsx`
- `packages/llm/src/index.ts`
- 对应测试

改动：

1. Agent 门禁改为：协议 ∈ {Responses, Chat Completions}，连接就绪，模型已启用且未下架，capabilities 含 text/streaming/tools。
2. `gpt-5.6-sol` 继续退休；默认 LLM 保持 `gpt-5.6-terra`。
3. 同步保留已有 `capabilitiesJson`；推断只用于首次插入。`listModels` 不再覆盖远程模型勾选。
4. 渠道没有 / 模型下架 → `model_unavailable`，打开选择器。
5. 不同步维护 DeepSeek / GLM / Kimi / Qwen3 名单。这些模型若还在 UniComp 目录里，用户启用即可当 LLM；是否给 Agent 用看 tools 勾选。

验收：

- UniComp 新同步的 LLM（名字不必是 5.6）只要用户启用并勾 tools，可进 Agent。
- Sol 不可选。
- 自定义 NewAPI 走同一门禁。
- 同步后用户勾选不被覆盖。

### P2 媒体：少量模板，不按模型复制

涉及：

- `packages/generation-adapters/src/index.ts`
- `apps/worker/src/media-preparation-service.ts`
- `apps/worker/src/handler.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- 模型管理 UI：目录行「参数模板」

改动：

1. 媒体候选改为：官方 UniComp 连接 + 模型已启用 + 已绑模板 + 模板支持该能力。
2. 原生 UniComp 通道按模板投影到 `/v1/images/generations` 或 `/v1/videos`，注入 `model = remoteModelId`，校验模板字段白名单。拒绝额外字段、错误图片数量。
3. Qwen 图编那种特殊投影保留为独立模板，不按模型 ID 写死在路由里；没绑该模板就不要走华为云平铺字段。
4. 官方 Vidu 通道不动。
5. 没有模板的媒体模型可以出现在目录里，但不能进入制作候选。

验收：

- 旧的 UniComp per-model adapter key 不再是新任务的解析目标；历史任务快照仍能只读展示。
- 给某个新同步的视频模型绑上通用视频模板后，可以进入候选（无需改 Rust 加 ID）。
- WebView 仍不能指定 host / path / key。

### P3 MiniMax 适配

前置：P0/P2 已删除 per-model 白名单。

本轮只做 **UniComp 托管 MiniMax**：

1. 若 MiniMax 请求体能塞进 UniComp 通用视频模板，就不要新建模板。
2. 只有字段不兼容时才增加 MiniMax 视频模板（文生 / 图生 / 首尾帧按实机合同）。
3. MiniMax LLM 只当 Chat Completions，不新建 LLM adapter。
4. 不把 `MiniMax-Hailuo-2.3` 这类官方名写进代码当身份。

验收：

- UniComp 同步出 MiniMax 视频模型后，启用 + 绑模板即可出现在视频候选。
- 自定义 NewAPI 即使同名也不能提交媒体。
- 代码里没有 MiniMax 模型 ID 数组。

P3 明确不做：官方 MiniMax 卡片、`api.minimax.io` 主机、官方 `/v1/video_generation`、自定义中转站媒体通道。

### P4 测试与文档

- 覆盖：删除 per-model adapter 后的回归、协议门禁、同步不覆盖能力、未知 ID 可进目录、模板绑定后可提交、Sol 下架。
- 更新 `docs/UNICOMPAPI-INTEGRATION.md`：目录以同步为准；去掉「已知模型白名单才有 Adapter」和「只有 5.6 才能 Agent」。
- 真实 UniComp 冒烟：重新同步；Terra 或用户启用的 tools 模型跑一轮 Agent；一个旧媒体回归；一个 MiniMax（若目录里有）绑模板后提交。

## 9. 阶段顺序与依赖

```text
P0 删除过时硬编码
  -> P1 LLM 协议门禁（可紧跟 P0）
  -> P2 媒体模板 + 原生改按模板校验
  -> P3 MiniMax 只在通用视频模板不够时加模板
  -> P4 门禁与真实冒烟
```

P3 不再阻塞于「先把 MiniMax ID 写进仓库」。没有 MiniMax 模板差异时，P2 完成后同步到就能绑通用视频模板。

## 10. 非目标

- 不把 UniComp `/v1/models` 再抄进代码当长期目录
- 不为 NewAPI / 任意中转站做媒体原生通道
- 不维护全球模型别名表
- 不在运行时爬厂商文档或从 `/v1/models` 推断参数 schema
- 不按 400 错误自动学习参数
- 不恢复 `gpt-5.6-sol`
- 不实现跨供应商自动 failover
- 不为已经从 UniComp 下架的模型保留 adapter「以防万一」

## 11. 实施时仍需要的实机信息

P0/P1/P2 可以先删硬编码、改协议门禁和模板机制。

若通用视频模板不够，P3 才需要看一次真实 MiniMax 请求体：

1. 同步结果里 MiniMax / Hailuo 的远程 ID（只记在目录，不写死进仓库）
2. 是否仍走 `POST /v1/videos`
3. 是否多了通用模板没有的字段

没有这三项，就先共用 UniComp 通用视频模板，不要猜测官方 Hailuo 字段。

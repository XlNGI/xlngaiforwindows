# 统一模型合同与适配计划

版本：0.2（架构审查修订与实施计划）  
日期：2026-10-10  
状态：架构方案已修订，尚未开始实现

## 1. 目标

将 LLM、图片模型和视频模型统一到“官方模型合同 + Provider ModelBinding + 轻量 Adapter”架构中，减少同一模型在官方渠道、中转站和不同协议下的重复实现。

核心关系：

```text
官方模型合同（Canonical Contract）
  ├── 官方能力与参数 JSON Schema
  ├── 官方文档中的必填项、默认值、枚举、注释和约束
  ├── 请求/响应语义
  └── 官方协议元数据
          ↓
Provider ModelBinding
  ├── providerProfileId / providerType
  ├── remoteModelId
  ├── contractId
  ├── protocol
  └── 请求/响应字段映射
          ↓
Adapter
  ├── 按任务能力挑选参数
  ├── 执行协议和字段转换
  └── 处理供应商特有状态、错误和轮询
```

JSON Schema 是参数校验和前端动态表单的唯一来源。传输映射放在合同的 `transport` 部分或 Provider Binding 中，不混入业务参数 Schema。

## 2. 当前系统盘点

当前已经存在的模型或模板包括：

| 类别 | 当前模型/模板 | 当前状态 |
|---|---|---|
| LLM | OpenAI Responses 模型（按模型 ID 推断能力） | 已有官方 Responses 路由 |
| LLM | UniCompAPI 动态目录模型 | 已有 Chat Completions 路由；部分旧逻辑仍按模型家族白名单判断 |
| 图片 | `viduq1`、`viduq2` | Vidu 固定适配器 |
| 视频 | `viduq3`、`viduq3-pro`、`viduq3-drama`、`viduq3-ad`、`viduq3-mix`、`viduq3-turbo`、`viduq2-pro`、`vidu2.0` | Vidu Schema 和视频生命周期已存在 |
| 图片 | `qwen-image`、`qwen-image-edit-2509`、`doubao-seedream-5-0-260128` | UniCompAPI/模板路径已有验收记录 |
| 视频 | UniCompAPI 通用视频模板、Seedance 相关模板 | 已有部分模板和 Agent 入口 |

当前主要问题：模型能力、参数 Schema、UI Schema、协议路由和供应商模型 ID 分散在不同层；同一官方模型通过中转站接入时容易重复写能力判断、参数映射和适配器代码。

## 3. 主流模型候选清单

以下是第一轮候选清单。清单表示“应优先建立官方合同的模型族”，不表示当前已经接入。实际合同必须以对应官方 API 文档和官方模型页复核后落库；未完成复核的模型不得进入可用目录。

### 3.1 文本、视觉、推理和工具调用模型

| 官方模型族 | 典型模型 | 主要能力 | 优先级 | 首批合同备注 |
|---|---|---|---|---|
| DeepSeek | `deepseek-v4-pro`（版本 DeepSeek-V4-Pro-0813）、`deepseek-flash`（版本 DeepSeek-V4.1-Flash） | 文本、流式、推理、工具；Flash 支持图像理解 | P0 | 官方当前 API 文档明确要求使用这两个模型 ID，旧 `deepseek-v4-flash` 已下线 |
| 智谱 | `glm-5.3`、`glm-5.3-flash`（并保留 `glm-5` 合同） | 文本、流式、工具、思考模式、结构化输出；Flash 支持视觉 | P0 | 以官方当前模型目录具体 ID 为准，5.3 与 Flash 分开合同 |
| 月之暗面 | `kimi-k3`（Kimi K3） | 文本、长上下文、工具、推理 | P0 | 旧 K2 不进入本阶段 |
| MiniMax | `MiniMax-M3`、`MiniMax-H3` | 文本、推理、工具、流式（按具体版本） | P0 | M3 与 H3 分开合同 |
| 阿里云 | Qwen 当前官方目录最新文本/推理模型 | 文本、视觉、工具、结构化输出（按具体版本） | P0 | 不把旧版号写死；以目录当日最新 ID 为准 |
| 字节跳动 | 豆包当前官方目录最新旗舰/推理模型 | 文本、视觉、工具、推理（按具体版本） | P0 | 只接受火山方舟当前目录 ID |
| 百川智能 | Baichuan 当前官方目录最新模型 | 按官方目录声明 | P1 | 完成官方目录核验后再启用 |

### 3.2 图片生成和编辑模型

| 官方模型族 | 典型模型 | 主要能力 | 优先级 |
|---|---|---|---|
| OpenAI Image | GPT Image 系列 | 文生图、图像编辑、参考图 | P0 |
| Google Imagen | Imagen 4 系列 | 文生图、编辑/变体（按公开 API 能力） | P0 |
| Black Forest Labs | FLUX.1/FLUX.2、Kontext 系列 | 文生图、图像编辑、参考图 | P0 |
| Stability AI | Stable Image 系列 | 文生图、编辑、放大和变体 | P1 |
| ByteDance | Seedream 系列 | 文生图、图像编辑 | P0 |
| Alibaba | Qwen-Image、Qwen-Image-Edit 系列 | 文生图、图像编辑 | P0 |
| Vidu | `viduq1`、`viduq2` | 文生图、参考图 | 已有 |

### 3.3 视频生成模型

| 官方模型族 | 典型模型 | 主要能力 | 优先级 |
|---|---|---|---|
| OpenAI | Sora 系列 | 文生视频、参考/编辑能力按官方 API | P0 |
| Google | Veo 3 系列 | 文生视频、图生视频、音频能力按具体版本 | P0 |
| Kling | Kling 2.x/3.x 系列 | 文生视频、图生视频、首尾帧、音频（按版本） | P0 |
| ByteDance | Seedance 系列 | 文生视频、图生视频、首尾帧 | P0 |
| Vidu | Q3/Q2 Pro/2.0 系列 | 文生视频、参考图、首尾帧 | 已有 |
| Runway | Gen-4 系列 | 文生视频、图生视频 | P1 |
| Luma | Ray 系列 | 文生视频、图生视频 | P1 |
| MiniMax | Hailuo Video 系列 | 文生视频、图生视频 | P1 |
| Alibaba | Wan 系列 | 文生视频、图生视频 | P1 |

## 4. 合同设计原则

1. `contractId + contractRevision` 表示不可变的官方模型语义合同；`remoteModelId` 表示某个供应商实际接受的模型 ID。
2. 模型合同、协议适配器、Provider Binding 和任务适配器分层；协议兼容不等于能力或语义兼容。
3. JSON Schema 必须覆盖官方文档中的必填项、类型、默认值、枚举、范围、条件约束和中文/英文参数说明；前端从 Schema 完全推导表单。
4. 合同 Schema 与传输映射分离：Schema 描述业务参数，`transport.request`/`transport.response` 描述线协议字段；映射只能使用受限 DSL，不允许任意脚本。
5. 不通过模型名正则推断能力；能力必须来自合同和 Binding 的显式声明。
6. 中转站模型默认只需绑定已有合同；只有参数、响应或语义确实不同，才增加映射或新合同。
7. Binding 必须声明 `exact`、`partial` 或 `incompatible`；部分兼容必须隐藏不支持字段并拒绝不支持参数。
8. 任务和生成草稿需要保存解析后的合同、修订号和 Binding 快照，避免目录变化影响历史任务。

## 5. 分阶段实施计划

### P0：合同领域模型和目录

- 定义 `ModelContract`、`ModelBinding`、`ContractTransport` 类型。
- 将现有 `ProviderModelInfo` 增加 `contractId` 和显式能力来源。
- 保留旧 `adapterKey` 解析能力，建立向新合同的兼容解析。
- 建立合同目录、Binding 目录和官方来源元数据。
- 建立 `contractRevision` 不可变快照、目录状态和人工启用门禁。
- 定义 `exact/partial/incompatible` 兼容级别和受限 transport 映射 DSL。
- 增加合同、Binding 的只读 Worker IPC 查询；未 `enabled` 的合同不得进入运行时。

### P1：Schema 驱动的参数和 UI

- 统一 JSON Schema 校验入口。
- 从 Schema 推导前端输入控件、必填标识、描述、枚举、范围和条件显示。
- 移除模型专属的重复 UI Schema；保留必要的通用布局元数据。
- 将官方文档字段说明作为验收内容。

### P2：LLM 合同迁移

- 本阶段只迁移中国供应商当前官方目录中的最新主力模型：DeepSeek V4 系列、GLM-5.x、Kimi K3、MiniMax M3/H3、Qwen 当前最新目录模型、豆包当前最新目录模型；国外 LLM 暂不实施。
- 将工具调用、流式事件、usage、响应 ID 和错误统一映射。
- 删除按模型名前缀推断 Agent 能力的旧逻辑。

### P3：图片合同迁移

- 迁移 GPT Image、Imagen、FLUX、Seedream、Qwen Image、Vidu。
- 统一文生图、参考图、编辑、尺寸、质量和输出格式参数。

### P4：视频合同迁移

- 迁移 Sora、Veo、Kling、Seedance、Vidu、Runway、Luma、Hailuo、Wan。
- 统一异步提交、轮询、取消、下载、状态和输出媒体字段。

### P5：中转站映射和清理

- 为 UniCompAPI、OpenAI-compatible 网关和其他中转站增加 ModelBinding。
- 删除重复的模型能力清单、重复参数工厂和供应商专属前端分支。
- 保留历史适配器兼容读取，禁止新任务继续产生旧重复键。

### P6：验证和官方一致性门禁

- 每个合同必须有官方文档来源、Schema 契约测试和请求/响应样本。
- 对官方通道和中转站通道分别做请求映射、错误映射和能力门禁测试。
- 完成全量 TypeScript、Rust、Worker、Desktop 和适配器质量门禁。

## 6. 第一轮落地顺序

建议先实现以下合同，以验证架构覆盖面：

1. DeepSeek V4-Pro / V4.1-Flash
2. GLM-5.x 当前官方目录版本
3. Kimi K3
4. MiniMax M3 / H3
5. Qwen、豆包当前官方目录最新主力模型
6. Qwen Image / Image Edit 与 Seedream 当前最新模型
7. Vidu 现有图片/视频合同迁移
8. Kling、Seedance、Veo 当前最新视频模型
9. （预留给其他已核验模型）

完成这批后，再扩展其他已核验的中国供应商模型和海外图片/视频模型；海外 LLM 另立阶段。

## 7. 清单状态

- [x] 现有模型和适配器初步盘点
- [x] 主流模型候选清单
- [x] 合同、Binding、Adapter 三层设计
- [ ] 逐模型核对官方 API 文档
- [ ] 合同 JSON Schema 定稿
- [ ] 合同目录和 Binding 数据结构实现
- [ ] LLM 合同迁移
- [ ] 图片合同迁移
- [ ] 视频合同迁移
- [ ] 中转站映射迁移
- [ ] 全量质量门禁

## 8. 重要限制

候选清单中的模型名称和能力仅用于规划。实现前必须逐个核对官方文档的当前版本、可用地区、认证方式、请求/响应协议、参数约束、异步生命周期和计费字段。没有完成官方来源核验的模型不能显示为可用模型，也不能由中转站映射直接启用。

## 9. 网上核验后的“最新主力”候选（2026-10-10）

本轮通过公开官方页面重新核对了型号方向。由于各家会用 `latest` 别名、分阶段发布和地区目录，合同落地仍必须以 API 模型目录和开发者文档为准；这里不再把旧型号列为首批目标。

### LLM / Agent（本阶段只纳入中国供应商）

| 供应商 | 首选合同目标 | 官方核验入口 | 备注 |
|---|---|---|---|
| DeepSeek | `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）、`deepseek-flash`（DeepSeek-V4.1-Flash） | [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) | 官方当前文档要求使用这两个模型 ID；旧 `deepseek-v4-flash` 只作兼容历史，不进入新绑定 |
| 阿里云 | Qwen 当前最新文本/推理主力 | [Model Studio](https://www.alibabacloud.com/help/en/model-studio/) | 不再把 Qwen3 写死为最新；以目录当日最新 ID 为准 |
| 智谱 | `glm-5.3`、`glm-5.3-flash` | [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[GLM-5.3 Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash) | `glm-5` 保留为兼容合同；新目录以 5.3 系列为主 |
| 月之暗面 | `kimi-k3` | [Kimi K3 API](https://platform.kimi.com/docs/guide/kimi-k3-quickstart) | K3 作为当前主力；旧 K2 不进入首批 |
| MiniMax | `MiniMax-M3`、`MiniMax-H3` | [MiniMax M3](https://www.minimax.cn/models/text/m3)、[MiniMax H3](https://www.minimax.io/blog/minimax-h3) | M3 与 H3 及其他推理/快速型号分别建立合同，以官方 API 目录具体 ID 为准 |
| 字节跳动 | 豆包当前旗舰和推理型号 | [火山引擎模型服务](https://www.volcengine.com/docs/82379) | 只接受火山方舟当前模型目录中的最新 ID |
| 百川智能 | Baichuan 当前主力模型 | [百川 API](https://platform.baichuan-ai.com/docs) | 待确认当前可用模型目录 |

### 图片

| 供应商 | 首选合同目标 | 官方核验入口 |
|---|---|---|
| OpenAI | GPT Image 当前主力 | [Image generation guide](https://platform.openai.com/docs/guides/image-generation) |
| Google | Imagen 当前最新代 | [Imagen](https://ai.google.dev/gemini-api/docs/imagen) |
| Black Forest Labs | FLUX 当前主力、Kontext 当前编辑主力 | [FLUX API](https://docs.bfl.ai/) |
| Alibaba | Qwen-Image 当前主力及 Image-Edit 当前主力 | [Model Studio](https://www.alibabacloud.com/help/en/model-studio/) |
| ByteDance | Seedream 当前最新代 | [火山引擎模型服务](https://www.volcengine.com/docs/82379) |
| Stability AI | Stable Image 当前主力 | [Stability API](https://platform.stability.ai/docs) |

### 视频

| 供应商 | 首选合同目标 | 官方核验入口 |
|---|---|---|
| OpenAI | Sora 2 当前视频 API 主力 | [Sora 2](https://openai.com/index/sora-2/) |
| Google | Veo 3.1 当前视频主力 | [Veo](https://ai.google.dev/gemini-api/docs/video) |
| Kling | Kling 当前最新代 | [Kling API](https://app.klingai.com/global/dev) |
| ByteDance | Seedance 当前最新代 | [火山引擎模型服务](https://www.volcengine.com/docs/82379) |
| Runway | Gen-4 当前主力 | [Runway API](https://docs.dev.runwayml.com/) |
| Luma | Ray 当前主力 | [Luma API](https://docs.lumalabs.ai/) |
| MiniMax | Hailuo 当前视频主力 | [MiniMax API](https://www.minimaxi.com/platform/document) |
| Alibaba | Wan 当前视频主力 | [Model Studio](https://www.alibabacloud.com/help/en/model-studio/) |
| Vidu | Q3 当前系列 | [Vidu API](https://platform.vidu.com/docs) |

### 本轮调整

- 删除首批目标中的旧版 Claude 3.5、Gemini 2.0、GPT-4o、Flux 1 等泛化表述。
- 不再把具体旧版本号写死为“最新”；合同目录必须从官方模型目录或人工核验结果登记。
- `latest` 别名不得直接作为历史任务合同 ID；系统内部仍保存具体远程模型 ID。
- OpenAI-compatible 中转站只绑定到上表的官方合同，不能因为接口兼容就自动获得全部能力。
- 国外大语言模型（OpenAI、Anthropic、Google、xAI）暂不进入本阶段 LLM/Agent 合同首批范围；相关条目保留为未来扩展方向，不进入当前实现清单。
- 旧型号（例如 Qwen3、GLM-4、Kimi K2、DeepSeek V3/R1、MiniMax M2）不再作为首批合同目标；只有官方当前目录确认的最新主力型号才能进入实现清单。




## 10. 架构审查补充决策

### 10.1 合同与协议分层

模型合同只描述官方模型的业务语义、能力和参数；协议适配器负责 Chat Completions、厂商官方协议、流式事件、工具调用、错误和 usage；Provider Binding 负责具体供应商模型 ID 与合同的绑定；任务适配器负责图片/视频任务生命周期。协议兼容不等于能力或语义兼容。

### 10.2 合同修订与历史快照

合同身份采用：

```text
contractId + contractRevision
```

`contractRevision` 不可变。任务和草稿保存合同、修订号、Binding 和解析后的 Schema/transport 快照，避免官方文档变化后重新解释历史任务。

### 10.3 结构化能力

能力不再只使用布尔值，至少包含 `reasoning`、`structuredOutput`、`parallelToolCalls`、`imageInput`、`audioInput`、`videoInput`、`maxContextTokens`、`maxOutputTokens`、`videoAsync`、`videoPolling` 和 `videoCancellation` 等限制。

### 10.4 受限 transport 映射

请求和响应映射只允许 `copy`、`rename`、`constant`、`template`、`enumMap`、`unitConvert`、`arrayMap`、`conditional`、`extract`。禁止任意 JavaScript 或动态脚本。每条映射都必须有输入/输出 Schema、脱敏样例和契约测试。

### 10.5 兼容级别

Binding 必须声明 `exact`、`partial` 或 `incompatible`。`partial` 绑定必须隐藏不支持的 Schema 字段并拒绝不支持参数，禁止静默丢弃；`incompatible` 不得进入可用目录。

### 10.6 视频生命周期

视频合同统一提供 `submit`、`getStatus`、`cancel`、`getOutput`、`normalizeStatus` 和 `normalizeFailure` 语义。供应商状态值、任务 ID、轮询、取消和下载方式由协议适配器或 Binding 声明。

### 10.7 目录启用状态

模型目录状态为 `discovered`、`verified`、`enabled`、`deprecated`、`rejected`。官方目录发现结果不能自动启用；必须经过官方来源核验、合同生成、人工确认后才进入选择器。`latest` 别名只能用于发现，不能作为持久化身份。

### 10.8 迁移策略

旧 `adapterKey` 保留只读解析能力：

```text
legacy adapterKey → legacy resolver → contractId + contractRevision + bindingId
```

新任务只写新合同标识；历史草稿、视频任务、价格记录和恢复任务继续通过兼容解析读取。迁移完成并审计后，才删除旧写入路径。

### 10.9 官方来源审计

每个合同必须保存 `sourceUrl`、`sourceTitle`、`checkedAt`、`sourceLocale`、`verificationStatus` 和脱敏请求/响应样例。官方文档变化时，合同进入 `revalidation_required`，不能自动覆盖已启用修订。

## 11. 修订后的实施门禁

- [x] 清理第 3 节和旧清单中暂不实施的国外 LLM 与旧型号，避免计划自相矛盾
- [x] 定义 `ModelContract`、`ModelBinding`、`ProtocolAdapter`、`TaskAdapter` 和 `contractRevision`（执行服务仍保留现有兼容实现）
- [x] 定义受限 transport DSL 及其 Schema 类型
- [x] 定义结构化能力矩阵和 `exact/partial/incompatible` 规则
- [~] 定义目录发现、人工确认、启用、下架和重新核验状态机（模型启用会确认已绑定合同，独立人工复核界面和重新核验流待完成）
- [~] 为 DeepSeek V4、GLM-5.x、Kimi K3、MiniMax M3、Qwen/豆包最新目录模型完成官方来源核验（DeepSeek、GLM 已核验；其余待官方目录/凭据复核）
- [x] 先迁移一个 LLM、一个图片模型、一个视频模型完成垂直切片验收
- [~] 迁移旧 adapterKey 只读兼容和任务快照（旧解析已保留，媒体任务快照已保存合同标识；LLM 任务快照和独立 Binding 快照仍待补齐）
- [~] 扩展全部中国供应商最新模型（第一批已接入，Qwen/豆包/MiniMax 具体远程 ID 仍以官方同步目录为准）
- [ ] 最后再评估海外图片/视频模型；海外 LLM 另立阶段



## 12. 实施记录

- [x] HappyHorse 垂直切片（2026-10-11）：以阿里云百炼官方文生、首帧、参考生及编辑 API 核验七个合同；完成共享 Schema、UniComp ModelBinding、目录迁移、动态表单、原生协议校验、任务快照和模拟提交/轮询验证。仅扩展已建立的合同架构，不将本计划其余模型迁移阶段标记完成。实现与验证详见 [HappyHorse 官方合同接入](HAPPYHORSE-CONTRACT-IMPLEMENTATION.md)。真实付费渠道验收未执行。

- [~] P0 合同领域模型与目录基础：已完成 `ModelContract`、`ModelBinding`、`ProtocolAdapter` 所需合同数据类型、合同修订字段、目录状态、兼容级别和受限映射类型；Worker 已加入 `deepseek-v4-pro`、`deepseek-flash`、`glm-5.3`、`glm-5.3-flash`、`glm-5`、`kimi-k3`、MiniMax M3/H3、Qwen Image、通用图像/视频、Vidu Q3 的候选合同/Binding 注册表。运行时启用门禁要求合同和 Binding 均为 `enabled`，当前候选保持 `discovered`，不会自动进入生产目录。
- [x] P0 定向验证：`@ai-video/contracts` build、Worker typecheck、`model-contract-registry.test.ts` 5 项测试通过。
- [~] P0 持久化：应用设置 SQLite Schema v7 已为 `provider_models` 增加合同元数据，并新增 `model_contracts`、`model_bindings` 表及仓库；当前内置合同/Binding 会以不可变修订键幂等播种，目录状态可持久保存；后续官方定义更新策略和人工审核界面仍待完成。
- [x] P0 IPC：新增 `model.contract.list/get/setEnabled`、`model.binding.list/setEnabled`、`model.protocol.list` 和 `model.task-adapter.list`；目录状态和启用操作均走 Worker，运行时仍拒绝未 `enabled` 项。
- [x] P0 同步接入：已知当前模型 ID 首次同步时从显式合同生成初始能力；后续同步保留用户能力勾选，不再重新推断覆盖。
- [x] P1 Schema 驱动表单基础：ProductionPanel 在没有显式 UI Schema 时从 JSON Schema 推导控件、必填项、枚举、数值范围、URL 图片列表和参数说明；已有 UI Schema 继续兼容。
- [~] P1 合同化 Adapter 元数据：UniComp 图像、通用视频、Qwen 图编、Vidu 兼容参考/首尾帧模板和 Vidu Q3/首尾帧适配器已写入 `contractId/contractRevision`；新增 `adapterDescriptorFromModelContract` 可将合同 JSON Schema 转换为旧 AdapterDescriptor 和动态 UI 字段，其余官方 Vidu per-model descriptors 仍待迁移。
- [x] P1 协议目录基础：新增 Chat Completions、Responses 和 Vidu v2 的 `ProtocolAdapter` 目录及只读 IPC，协议转换与模型合同保持分离。
- [x] P1 任务生命周期目录基础：新增图像同步、通用视频异步、Vidu 参考视频异步 `TaskAdapter` 描述及只读 IPC；实际执行仍由现有 Worker/Native 服务负责。
- [x] P2 UniComp 映射实施：用户确认并启用 `deepseek-v4-pro`、`deepseek-flash`、`glm-5`、`glm-5.3`、`glm-5.3-flash`、`kimi-k3`、`MiniMax-M3`、`MiniMax-H3`、`qwen-image`、`viduq3` 到对应官方合同；未提供具体 UniComp 远程 ID 的 Qwen/豆包/Kling/Seedance/Hailuo 项目继续保持待目录发现状态。
- [~] P0 人工启用确认和独立目录持久化：模型合同/Binding 已持久化到应用 SQLite，Worker/桌面客户端已提供启用 API，模型启用同步更新合同状态；复核界面和重新核验流尚未完成，P0 仍保持进行中。


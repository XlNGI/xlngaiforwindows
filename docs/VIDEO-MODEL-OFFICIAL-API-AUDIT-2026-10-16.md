# 视频模型与官方 API 一致性审计报告

日期：2026-10-16（Asia/Shanghai）  
状态：审计完成，未实施修复  
审计基准：当前工作区；HEAD 为 `8189488def3fda952a7a48e59684e78f8fc9fa02`，工作区已有未提交修改

## 1. 审计结论与范围

当前视频模型接入尚未与官方 API 完整对齐，确实存在“官方支持参考生视频，但本地无法选择模型”的情况。已确认的原因包括 Agent 候选筛选不识别官方嵌套输入、渠道绑定仍使用旧合同、模型能力登记缺失，以及参数 Schema 和原生字段白名单未覆盖官方字段。

本次重点核查参考生视频的模型目录、制作面板、Agent 候选筛选、合同和渠道绑定、请求参数校验及原生请求边界。核查依据为当前工作区代码、公开官方文档和本地内存中的函数复现，不代表所有供应商、所有模型、所有参数均已完成一致性认证。

原审计期间未修改代码或配置，未访问用户密钥、项目数据或运行中的设置数据库，未发起真实付费生成请求。本文件仅保存审计结果；不将审计建议视为实施授权，不改变既有产品决策或实施计划。

## 2. 发现汇总

| 编号 | 分类 | 发现 | 主要影响 |
| --- | --- | --- | --- |
| F1 | 已复现的功能缺陷 | Agent 输入筛选只识别顶层 `images` | 带参考图时，已接入的万相、Seedance、MiniMax 官方模型被排除 |
| F2 | 渠道能力覆盖差异 | UniComp 万相 3.0／Prime 仍绑定修订 1 | 该渠道仅出现文生视频，完整参考能力只登记在官方直连渠道 |
| F3 | 已确认的接入缺口 | Vidu Q1、Q2 仅登记为图片模型，缺少参考生视频适配器 | 官方支持的参考生视频无法选择 |
| F4 | 已确认的接入缺口 | Vidu Q4 Preview 仅有 `verified` 合同，无可执行绑定 | 模型无法进入可用选择器 |
| F5 | 已复现的参数缺口 | Vidu 缺少声音、视频参考字段和部分画幅取值 | 官方合法参数在本地被拒绝 |
| F6 | 已确认的同步限制 | Vidu 连接测试成功后不向 Worker 返回模型列表 | “测试并同步”无法自动补齐本地固定目录或模型能力 |

F2、F4 涉及现有渠道启用门禁。官方提供某项能力，不等于中转渠道已经兼容，也不等于账号已经开通权限；不能仅删除筛选条件或修改启用状态就认定接入完成。

## 3. 详细发现

### F1：Agent 候选筛选不识别官方嵌套媒体输入

代码位置：[media-preparation-service.ts](../apps/worker/src/media-preparation-service.ts#L811)，`adapterSupportsInputs`。

该函数只读取 `adapter.parameterSchema.properties.images`。有输入图片而没有这个顶层属性时，直接返回 `false`。现有官方合同分别使用：

- 万相：`media[]`，例如 `type=reference_image`。
- Seedance、MiniMax：`content[]`，例如 `type=image_url`、`role=reference_image`。

因此，这些模型虽然已经具有启用的官方合同和参考生视频适配器，仍会在 Agent 候选生成阶段被排除，无法进入后续参数转换和提交流程。

本地内存复现将连接设置为 `ready`、连接和模型均启用，并同时提供万相、Seedance、MiniMax、Vidu 四个候选：

| 输入图片数量 | 返回的候选 |
| --- | --- |
| 0 | 万相、Seedance、MiniMax 的文生视频模式 |
| 1 | 仅 Vidu Q3 的参考生视频模式 |
| 2 | 仅 Vidu Q3 的参考生视频模式 |

这是 Agent 入口的确定性筛选问题。制作面板的模型选项没有使用此函数，不能据此断言制作面板中的三家官方直连模型也全部不可选。

### F2：UniComp 万相 3.0／Prime 仍绑定旧合同

代码位置：[media-model-bindings.json](../packages/contracts/src/media-model-bindings.json#L94)、[旧万相合同](../packages/contracts/src/official-video-contracts.json#L1306)。

`unicomp-wan3.0-video` 和 `unicomp-wan3.0-video-prime` 的 `contractRevision` 均为 `1`。对应合同仅登记 `TEXT_TO_VIDEO`，没有媒体参考输入。

[万相 3 官方 API](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)支持 `reference_image`、`reference_video`、`reference_audio` 等媒体输入。本地的 `wan-video` 官方直连已经绑定完整修订 `3`，但这不会自动赋予 UniComp 相同能力。

目录函数复现结果：

```text
unicompapi / wan3.0-video       -> TEXT_TO_VIDEO
unicompapi / wan3.0-video-prime -> TEXT_TO_VIDEO
wan-video  / wan3.0-video      -> REFERENCE_TO_VIDEO, TEXT_TO_VIDEO,
                                 IMAGE_TO_VIDEO, START_END_TO_VIDEO
```

这一差异与仓库对渠道能力分别核验的设计一致，属于官方与渠道覆盖尚未统一的事实，不能直接认定中转站已经支持全部官方字段。后续处理应保留历史合同，并核实实际渠道协议和参数兼容性。

### F3：Vidu Q1、Q2 缺少视频能力与对应适配器

代码位置：[provider-registry.ts](../apps/worker/src/provider-registry.ts#L163)、[generation-adapters 目录](../packages/generation-adapters/src/index.ts)。

官方 [Vidu Q1 参考生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q1/reference-to-video)和 [Vidu Q2 参考生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q2/reference-to-video)均明确提供相应接口。

本地内置定义却使用：

```typescript
viduModel('viduq1', 'Vidu Q1', 'image');
viduModel('viduq2', 'Vidu Q2', 'image');
```

两者的 `videoGeneration` 均为 `false`，且缺少对应的 `REFERENCE_TO_VIDEO` 适配器。仅启用模型或勾选视频能力仍不足以补齐完整执行链。

目录函数复现结果：

```text
vidu / viduq1 -> REFERENCE_TO_IMAGE
vidu / viduq2 -> TEXT_TO_IMAGE, REFERENCE_TO_IMAGE
```

### F4：Vidu Q4 Preview 只有已核验定义，尚无可执行渠道

代码位置：[Q4 合同](../packages/contracts/src/official-video-audio-contracts.json#L3713)、[合同适配器构建](../packages/generation-adapters/src/index.ts#L1145)、[渠道绑定目录](../packages/contracts/src/media-model-bindings.json)。

[官方 Q4 Preview 文档](https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/reference-to-video)提供参考生视频接口，支持 1–15 张图片、`sounds[]` 声音参考等参数。

本地已有 `cn.vidu.q4-preview.reference-video` 合同及这些参数，但状态为 `verified`。适配器构建只纳入声音相关合同中状态为 `enabled` 的定义，同时要求匹配启用的渠道绑定。目前没有 Q4 Preview 可执行绑定，Vidu 内置模型列表也没有该型号。

目录匹配结果为：

```text
vidu / viduq4-preview -> []
```

这属于定义已建立、执行接入尚未完成；不能把 `verified` 当作可执行接入完成。

### F5：已接入 Vidu 模型仍缺少官方参数

代码位置：[参考视频参数工厂](../packages/generation-adapters/src/index.ts#L703)、[Q3 画幅取值](../packages/generation-adapters/src/index.ts#L170)、[原生字段白名单](../apps/desktop/src-tauri/src/lib.rs#L105)。

| 模型或能力 | 官方定义 | 当前内置实现 | 本地复现 |
| --- | --- | --- | --- |
| Vidu Q3-Mix 声音参考 | `sounds[]` | Schema 和原生白名单均缺少该字段 | `must NOT have additional properties` |
| Vidu Q2-Pro 视频参考 | `videos[]` | Schema 和原生白名单均缺少该字段 | `must NOT have additional properties` |
| Vidu Q3 自适应画幅 | `aspect_ratio=auto` | 枚举仅包含五种固定画幅 | `must be equal to one of the allowed values` |
| Vidu Q3 主体引用 | `auto_subjects`、`subjects` | 内置 Schema 不包含这些字段 | 两项额外字段校验失败 |

官方来源：[Q3 参考生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/reference-to-video)、[Q2 参考生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q2/reference-to-video)。

此外，参数工厂用 `spec.resolution[0]` 作为默认分辨率，使 Q3-Turbo 和 Q2-Pro 的本地默认值为 `540p`；本次读取的官方文档默认值为 `720p`。这是静态定义差异，未通过真实请求评估生成或计费影响。

本次没有将所有时长范围差异都列为确定错误：官方 Q3 页面部分文字存在 15 秒与 16 秒等交叉描述，需要进一步按具体模型、模式和官方计费范围核实。

### F6：Vidu 的“测试并同步”不会返回远程模型目录

代码位置：[provider_connector.rs](../apps/desktop/src-tauri/src/provider_connector.rs#L402)、[app-settings-service.ts](../apps/worker/src/app-settings-service.ts#L535)。

原生层对 Vidu 的成功响应执行：

```rust
200..=299 if provider_type == "vidu" => ProviderTestOutcome::ready(None),
```

这一路径不会把响应中的模型列表传给 Worker。Worker 仅在成功且 `params.models !== undefined` 时同步远程模型；没有列表时，`modelSyncStatus` 为 `unsupported`。

因此，连接测试通过不能证明模型目录、能力或 Schema 已与官方同步。现有 Vidu 目录仍依赖本地内置定义。此处记录的是现有同步限制；本次未使用真实凭据核验 `/ent/v2/models` 的实际响应格式，也不据此假定直接解析该响应即可安全启用新模型。

## 4. 已执行的验证

- 读取当前代码，追踪制作面板、Agent、合同绑定、参数校验及原生白名单。
- 读取万相 3、Vidu Q1／Q2／Q3／Q4 Preview、MiniMax 视频 V2 的公开官方文档。
- 在内存中调用 `getAdapterCatalog`、`adapterBindsCatalogModel`、`resolveModelBinding`、`listBuiltInProviderModels`，复现渠道模式与模型目录差异。
- 用模拟的启用连接和模型调用 `MediaPreparationService` 的候选生成逻辑，复现 F1；没有创建项目或打开设置数据库。
- 调用 `validateAdapterParameters`，复现 F5 的声音、视频、主体和画幅参数被拒绝。
- 对三份视频合同及绑定 JSON 比较源码与现有 `dist` 的解析结果，内容一致；字节差异来自序列化格式，不作为构建版本不一致的证据。

本次为只读审计，没有新增测试文件、执行全仓测试或重建应用。上述内存复现不能替代真实供应商成功请求、账号权限和付费样片验收。

## 5. 可复现方法

在仓库的 `apps/worker` 目录使用 PowerShell 执行以下脚本。脚本禁用 tsx 缓存，只使用内存模拟对象和公开代码，不读取用户项目、设置或凭据，也不发起网络请求。

```powershell
$env:TSX_DISABLE_CACHE='1'
@'
import { MediaPreparationService } from './src/media-preparation-service.ts';
import {
  getAdapterCatalog,
  adapterBindsCatalogModel,
  validateAdapterParameters,
} from '../../packages/generation-adapters/src/index.ts';

const definitions = [
  ['wan-video', 'wan3.0-video', 'dashscope-video', 'https://dashscope.aliyuncs.com'],
  ['seedance-video', 'doubao-seedance-2-0-260128', 'seedance-video', 'https://ark.cn-beijing.volces.com'],
  ['minimax-video', 'MiniMax-H3', 'minimax-video-v2', 'https://api.minimax.cn'],
  ['vidu', 'viduq3', 'vidu-v2', 'https://api.vidu.com'],
];
const profiles = definitions.map(([providerType, model, protocol, baseUrl], i) => ({
  id: String(i), name: providerType, providerType, protocol, baseUrl,
  accessType: 'official', enabled: true, connectionStatus: 'ready',
}));
const settings = {
  listProfiles: () => profiles,
  listModels: (id) => [{
    id: 'model-' + id, remoteModelId: definitions[Number(id)][1],
    enabled: true, contractStatus: 'enabled',
    capabilities: { videoGeneration: true },
  }],
  getAdapterSchemaRecord: () => undefined,
  listModelPricing: () => [],
};
const service = new MediaPreparationService({}, settings, { catalog: getAdapterCatalog }, {}, {});
for (const count of [0, 1, 2]) {
  console.log('Agent input images:', count, service.listCandidates('video', count).map(c => ({
    provider: c.providerType, model: c.remoteModelId,
    modes: c.adapters.map(a => a.capability),
  })));
}

const all = getAdapterCatalog().adapters;
for (const [providerType, remoteModelId] of [
  ['unicompapi', 'wan3.0-video'], ['unicompapi', 'wan3.0-video-prime'],
  ['wan-video', 'wan3.0-video'], ['vidu', 'viduq1'],
  ['vidu', 'viduq2'], ['vidu', 'viduq4-preview'],
]) {
  console.log('Catalog:', providerType, remoteModelId, all.filter(a =>
    adapterBindsCatalogModel(a, { providerType, remoteModelId, contractStatus: 'enabled' })
  ).map(a => a.capability));
}

const common = {
  images: ['https://example.com/a.png'], prompt: 'test', duration: 5,
  aspect_ratio: '16:9', resolution: '720p', audio: false,
};
for (const [model, extra] of [
  ['viduq3-mix', { sounds: ['https://example.com/a.mp3'] }],
  ['viduq2-pro', { videos: ['https://example.com/a.mp4'] }],
  ['viduq3', { aspect_ratio: 'auto' }],
  ['viduq3', { auto_subjects: true, subjects: [{ name: 'actor', images: common.images }] }],
]) {
  console.log('Validation:', model, validateAdapterParameters(
    `REFERENCE_TO_VIDEO:vidu:${model}:v2`, { ...common, ...extra },
  ));
}
'@ | node --import tsx --input-type=module
```

`listCandidates` 在 TypeScript 中是私有方法，此处仅利用运行时可访问性隔离复现候选筛选；脚本不是生产调用示例。

## 6. 核验边界与后续参考

以下事项不在本次已完成验证的范围内：

- 当前运行中的应用、打包 Sidecar 与本工作区是否为同一构建。
- 用户实际连接、模型启用状态、账号权限、区域和中转渠道兼容性。
- Seedance、可灵动态官方文档的完整逐字段在线核验；不能仅凭合同中的 `verified` 标记认定本次已完成重新核验。
- 所有其他视频、图片或文本模型的全量官方一致性检查。
- 真实提交、轮询、取消、下载、计费和付费样片成功路径。

若后续授权修复，可优先处理 F1，再分别补齐模型能力、渠道绑定及参数字段，并保留合同修订和历史任务兼容性。F2、F4 需先核实渠道执行条件；F5 需同时核对 Schema、前端输入、Worker 和原生请求边界。同步模型 ID、登记官方能力和验证实际渠道兼容性应分别验收。

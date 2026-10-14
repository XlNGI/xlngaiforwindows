# 视频声音样本合同补齐

日期：2026-10-14

## 范围与不变量

用户要求补齐缺少的视频声音样本参数，并与官方接口一致。本次补齐官方合同目录、嵌套 JSON Schema、媒体限制和请求映射；官方接口定义与具体渠道可执行能力分别记录。

- 已保存的 `contractId + contractRevision` 不改变。万相 3.0 的完整多模态定义使用新修订，原 UniComp 绑定继续使用旧修订。
- 声音参考、完整对白驱动和供应商音色／角色元素分别建模，不能把生成音频开关当作声音样本输入。
- 官方字段名、大小写、对象数组、枚举、模型差异和互斥关系均保留；未知字段拒绝。
- 新定义保存官方来源、核验日期及脱敏请求／响应样例。未核实的渠道不自动绑定或启用，也不发送付费请求。
- 合同只保存公开语义；用户样本继续属于当前项目。密钥、签名上传地址、音频正文和本地绝对路径不进入合同样例。
- 来源为官方创建任务接口。可灵采用当前按模型划分的 API，不把旧版 `voice_ids` 字段混入新版 `contents/settings`。

## 所有权、状态与故障

合同为版本化内置源数据，Worker 将目录播种到本机应用设置 SQLite。`verified` 表示官方语义核验，不能代替具体连接可用或真实样片验收；执行仍要求合同和 Binding 同时 `enabled`。

本次请求构造为纯函数，不新增付费调度器。无效组合、未知字段、未声明映射、合同修订不匹配均在构造阶段失败；不会回退到旧模型或静默丢弃参数。关闭／切换／恢复仍由已有制作运行时管理，本次不修改项目检索或素材库规则。

## 实施与验证清单

- [x] V1 核对万相 3.0／2.7、Seedance 2.0／2.5、Vidu Q4 Preview、MiniMax H3／H3 Max 和可灵最新接口。
- [x] V2 补齐官方嵌套 Schema、媒体数量与模式互斥、音色和角色元素合同，保留旧修订。
- [x] V3 接入只读目录、共享参数验证和官方请求映射；核实渠道门禁与历史兼容。
- [x] V4 正反请求样例、边界／互斥／嵌套未知字段／传输语义回归通过。
- [x] V5 运行相关类型、Lint、格式、构建及 Rust 检查，记录结果。

## 已补齐的定义

本合同基础阶段新增 14 个 `verified` 定义，未创建可执行渠道 Binding。随后用户授权的官方运行时阶段又增加 7 个 `enabled` 修订及对应官方 Binding，目前 `official-video-audio-contracts.json` 共 21 个版本化定义；原 14 个定义及已有渠道修订保留。具体执行状态见 [官方声音参考视频链路](./OFFICIAL-VOICE-VIDEO-RUNTIME-IMPLEMENTATION.md)。下表描述原合同基础阶段：

| 模型／接口 | 官方声音参数和限制 |
|---|---|
| Wan 3.0／Prime，修订 2 | `media[].type=reference_audio`；最多 5 段、单段和合计最多 15 秒；帧模式与参考模式互斥 |
| Wan 2.7 图生视频 | `media[].type=driving_audio`；完整对白驱动，可结合首帧／首尾帧；视频续写不能混入驱动音频 |
| MiniMax H3／H3 Max | `content[].audio_url`、`role=reference_audio`、`mm_file://`；模型分辨率／时长独立；严格帧模式与参考模式互斥 |
| Seedance 2.0／2.5 | `content[].audio_url`、`role=reference_audio`；2.0 需要图片或视频搭配，2.5 可只传音频；拒绝仅旧 1.0 支持的 seed／frames／camera_fixed |
| Vidu Q4 Preview | `sounds[]`；最多 3 段 MP3，单段 3–12 秒；同时保留官方图片和有声输出参数 |
| Kling 3.0 文生／图生、3.0 Omni | 最新 `prompt` 或 `contents[]`、`settings.audio`、`options`；通过 `contents[].element_id` 引用绑定声音的角色 |
| Kling 音色管理／角色元素 | `voice_url` 或 `video_id`；`element_voice_id`、图片／视频角色资料；声音样本要求 5–30 秒 |
| Vidu 声音克隆 | `audio_url`、`voice_id`、可选提示音频及对应文本、试听文字；样本 10 秒–5 分钟；168 小时激活条件记录为合同语义 |

文件格式、大小、时长和合计时长写入 `inputMediaLimits`；本次没有下载用户音频或探测外部 URL。真正接入渠道上传时仍需按这些限制做本地文件探测，不能把元数据定义当作文件已通过检查。

新增 `buildOfficialVideoAudioRequest` 仅构造经过 Schema 校验的官方请求，保留万相 `input/parameters`、其他供应商的对象数组和可灵按模型区分的端点。动态表单可编辑嵌套对象数组；Rust 原生校验接入相同 Schema 的递归子集。

## 官方来源

- [万相 3.0](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)
- [万相 2.7 图生视频](https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference)
- [HappyHorse 参考生视频](https://help.aliyun.com/zh/model-studio/happyhorse-reference-to-video-api-reference)：未发现独立声音样本参数，因此不添加推测字段。
- [Seedance 创建任务](https://www.volcengine.com/docs/82379/1520757)
- [Vidu Q4 Preview 参考生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/reference-to-video)
- [Vidu 声音克隆](https://platform.vidu.com/docs/api-reference/audio-generation/voice-clone)
- [MiniMax 视频 V2](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create)
- [可灵图生视频](https://klingai.com/document-api/api/video/3-0-omni/image-to-video)
- [可灵 Omni](https://klingai.com/document-api/api/video/3-0-omni/video-omni)
- [可灵音色管理](https://klingai.com/document-api/api/video/3-0-omni/voice-customization)
- [可灵角色元素](https://klingai.com/document-api/api/video/3-0-omni/elements)

可灵文档正文通过官方中国站的公开 CDN 读取；英文参数数据来自页面加载的 `api.ts` 编译数据，未使用中转站文档代替官方定义。

## 验证记录

- `pnpm test`：全仓通过；新增 22 项合同测试、2 项嵌套表单测试、1 项目录／历史绑定测试。Worker 673、Generation Adapters 47 项通过。
- 最终聚焦回归：Generation Adapters 47 项；StructuredParameterField／ProductionPanel／ChatPanel 合计 60 项通过。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：148 项通过，1 项既有忽略。新增校验测试覆盖全部 14 个官方请求及嵌套凭据、模式混用；最后修改的 Schema 再跑聚焦 2 项通过。
- 最终 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、Rust fmt check、`git diff --check` 通过。
- `pnpm build` 通过；最后的表单调整再跑 Desktop 生产构建通过。仅保留既有大 chunk 与 Rust 警告。

以上验证记录属于合同基础阶段。后续 [官方运行时里程碑](./OFFICIAL-VOICE-VIDEO-RUNTIME-IMPLEMENTATION.md) 已接通万相、Seedance、MiniMax 的角色样本入口、官方上传、提交、恢复查询和结果入库，并新增可执行官方 Binding。UniComp 万相绑定仍使用修订 1，不把官方声音参考能力推断为中转站已经支持。真实付费样片仍未执行。

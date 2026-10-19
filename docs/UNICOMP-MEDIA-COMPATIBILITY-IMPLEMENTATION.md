# UniComp 媒体兼容层补齐

日期：2026-10-16。范围：当前 UniComp 视频渠道、Wan 3.0／Prime 音频参考与既有 HappyHorse 回归。

## 依据与边界

用户要求 UniComp 也完成兼容层，反馈部分模型不能用，并追问 Wan 3.0／Prime 音频传参。现有 UniComp Wan 仅绑定旧 revision 1，不含 `media`；Native 又把合同入口硬编码为 `contract-1`，不能执行新修订。通用受控图片曾被替换成本地路径，无法作为供应商可读图片；视频输出解析遗漏顶层 `url` 和 `data.url`。

2026-10-16 只读核查 UniComp 公共 `/api/status` 给出的文档地址及 `/api/pricing` 目录。文档声明 `/v1/videos` 提交、查询和鉴权内容下载，以及 `/v1/video/generations` 的 metadata。对照 New API 当前 Alibaba 协议实现，Wan `media` 位于 `metadata.input.media`，官方生成参数放在 `metadata.parameters`；`audio` 是有声输出开关，`reference_audio` 才是声音参考。网关当前部署与上游版本一致性仍需真实渠道验收，不能由公共定价目录证明。

来源：[UniComp 创建视频](https://rz6jfb2cv7.apifox.cn/472080542e0)、[通用生成请求](https://rz6jfb2cv7.apifox.cn/472080540e0)、[New API Alibaba 协议](https://github.com/QuantumNous/new-api/blob/main/plugins/tasks/alibaba/plugin.js)。

不变量：官方 Schema 不因渠道兼容被改写；字段映射属于 Binding，固定主机/路径及原模型 ID 不变；不自动切渠道、不在失败后换参数重交计费任务；新任务选择当前绑定，历史任务保留旧修订查询；无上传协议的本地音频/视频在付费前说明缺口；密钥、Base64、签名输出地址不得进入项目存储。

## 顺序与验证

- [x] U0 审计当前目录、合同、输入/输出和公开协议，明确 Wan 声音开关与参考音频区别。
- [x] U1 绑定与参数：复用 Wan revision 3，独立 UniComp 字段投影；保留旧绑定读取，修复目录修订刷新。新修订继承旧绑定/合同停用意图；已绑定文本模型不能保留错误的视频能力。适配器和设置聚焦测试通过。
- [x] U2 输入与界面：参考图和音频 URL 可表达；本地图片受控物化为 Data URL，仅留在原生传输；不支持的本地音频/视频明确拒绝。Worker 真实本地媒体夹具及界面添加参考音频测试通过。
- [x] U3 生命周期：规范任务 ID、状态、输出 URL；实际文件下载校验后入库，不用封面冒充视频。Rust 157 项通过、1 项既有公网 smoke 忽略；新修订、URL、终态和本地图片夹具均通过。
- [x] U4 聚焦测试、全仓测试、TypeScript/Rust 静态检查和构建；记录真实付费验收边界，结果见下。

故障行为沿用现有状态机：提交结果未知不重交；已保存 ID 恢复查询；下载失败不入库；切换项目和取消隔离旧响应。测试使用临时 SQLite、本地 HTTP 服务和媒体夹具，不改写用户项目或调用付费 API。

## Wan 音频用法

制作表单选择 Wan 3.0 或 Prime，进入“参考素材”添加“参考音频”，填可被供应商访问的 HTTPS WAV/MP3 URL；也可添加参考图片。在提示词中明确“使用音频1的音色”。`audio=true` 表示输出有声，不是音频 URL。角色页已有本地音色不会自动上传到 UniComp；本地音频请使用万相官方连接的既有上传链路。

应用内官方参数：

```json
{
  "prompt": "人物使用音频1的音色说：你好。",
  "media": [{ "type": "reference_audio", "url": "https://example.com/voice.wav" }],
  "audio": true,
  "duration": 5,
  "resolution": "720P"
}
```

UniComp Binding 在原生提交时转换为：

```json
{
  "model": "wan3.0-video",
  "prompt": "人物使用音频1的音色说：你好。",
  "metadata": {
    "input": { "media": [{ "type": "reference_audio", "url": "https://example.com/voice.wav" }] },
    "parameters": { "audio": true, "duration": 5, "resolution": "720P" }
  }
}
```

Prime 使用同一结构，将 `model` 改为 `wan3.0-video-prime`。首尾帧模式不能与参考音频混用，继续由同一官方 Schema 拒绝。现有 HappyHorse 的请求参数不改写。

## 最终验证

- 适配器聚焦 55 项、Worker 设置/运行时/目录/准备聚焦 44 项、制作界面 11 项及输入组装 7 项通过。Agent 后续补充 10 项准备服务回归通过，覆盖图片/视频字段转为 media 并保留音频；付费草稿仍等待原有费用确认。
- 全仓按包及文件串行复验：1,328 项通过（context 8、contracts 24、LLM 32、generation-adapters 59、persistence 65、Desktop 423、Worker 717）。随后补齐 Agent 图片/视频转换与候选模式，完整 Worker 55 个文件 718 项再次通过；当前合计覆盖 1,329 项。
- 首次全仓运行发现既有 `use-production-instructions` 测试在 refill 后只等 `source===undefined`，可能在异步请求仍加载时提前断言。补上等待 `loading=false`，未放宽业务校验或超时；聚焦及全仓复验通过。
- Rust `cargo test --lib`：157 项通过、1 项既有公网下载 smoke 忽略。覆盖 Wan 3.0/Prime 的 revision 3、metadata 映射、旧合同读取、任务状态/URL、受控图片 Data URL，以及三家官方链路回归。
- 最终 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`cargo fmt --check`、`git diff --check` 通过。
- 最终 `pnpm tauri:build` 通过，包含实际 Worker Sidecar、桌面前端、Rust release 与 Windows NSIS 安装包。产物：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，74,791,340 字节。保留既有 Vite 包体和 Rust 警告；未安装覆盖用户运行实例。
- 未消费用户额度验证当前 UniComp 部署的 Wan 音色效果。公共网关文档和上游协议实现不替代真实渠道验收，不宣称所有同步模型均已真实生成成功。正式签名和整机发布 `HOLD` 边界不变。

# 万相、Seedance、MiniMax 官方声音参考视频链路

日期：2026-10-14

用户明确要求三家均完成实际模型适配，不能停留在合同目录。本里程碑接通官方视频连接、本地声音样本、角色绑定、提交／恢复／取消／下载和成功自动入库；复用既有项目后台运行时与一次性费用确认。

## 固定边界

- Native 持有 API Key 和外网传输，Worker 负责项目文件、音频探测、任务快照和唯一数据库写入。
- 角色样本按角色文档 ID 绑定并版本化；改名不换声音。样本属于独立 audio_files 仓储，不加入图片／视频素材库。
- 本地参考图、音频、视频只以受控文件句柄跨 IPC；Native 按实际文件核对哈希和大小。上传凭证、签名 URL、Base64 和密钥不进入数据库或日志。
- 万相按官方 getPolicy → OSS multipart → oss:// 临时 URI 上传，调用带官方异步与资源解析头；Seedance 按官方 content/audio_url 协议；MiniMax 按 video_generation_input 上传并使用 mm_file://。
- 万相连接可配置北京地域业务空间 ID，保存为 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`；上传授权、创建与查询使用同一冻结域名。既有 `dashscope.aliyuncs.com` 配置保留兼容，不自动跨地域或切换业务空间。
- 新请求按模型合同和连接显式匹配，不将 UniComp 绑定提升为官方能力。不自动提交付费样片或重交结果未知的请求。
- 费用确认前冻结角色、音频哈希、模型／合同／地域和所有输入；确认时重验。重启只查询已保存任务 ID，取消不恢复运行。
- 源视频不覆盖；只将成功落盘的新视频交给现有素材仓储。检索及普通会话上下文不改变。

## 阶段

- [x] R0 官方协议复核、范围与故障矩阵。2026-10-14 读取官方创建／查询／上传说明，确认万相 getPolicy 与 OSS 解析头、Seedance Base64 音频、MiniMax video_generation_input 与 mm_file。
- [x] R1 三家连接、模型目录、官方绑定和参数适配器。新增 7 个可执行合同修订和 Binding：Wan 3.0／Prime 修订 3，其余五个修订 2；保留原 14 个已核验定义及 UniComp 历史绑定。连接需保存自己的密钥并通过只读测试；内置模型仍可停用。目录与 Native 协议测试通过。
- [x] R2 本地样本与角色绑定、输入物化和官方文件传输。项目 Schema v45 增加角色参考声音版本及视频输入音频引用；音频继续使用独立仓储，受历史引用保护。真实 WAV／PNG／MP4、本地哈希、文件租约与三家上传协议夹具通过。
- [x] R3 原生提交／查询／本地取消／下载，接通现有后台任务恢复与入库。沿用一次性费用确认和 ProjectTaskRuntime，保存安全任务 ID 后重开项目恢复同一任务。复用 Native 取消注册表，拦截先到达的取消并在 Worker 退出时停止传输；远端取消能力保守标记为不支持，不承诺远端退款。提交 5xx／未知结果不重交；相关 Worker 与 Native 测试通过。
- [x] R4 角色页及制作界面完整操作，单角色及多角色输入快照。角色页导入、试听、替换样本，制作页显式选择角色并按音频顺序组合官方请求；场次角色可预选。Wan 2.7 单独导入完整对白。组件、三家参数组装及制作页回归通过。
- [x] R5 工程验收：三家协议夹具、真实本地媒体、项目切换／取消／恢复和最终质量门禁。全仓 1,210 项 JavaScript／TypeScript、155 项 Rust 通过（1 项既有公网下载 smoke 忽略）；最终原生聚焦 8 项通过。类型、Lint、格式、Rust fmt、diff 检查、生产构建／Sidecar、Windows NSIS 打包、生产依赖审计和许可证检查通过。真实付费质量验收仍按用户约定延期。

## 故障矩阵

| 触发 | 结果 |
|---|---|
| 文件变化、损坏、越界或跨项目 | 付费请求前拒绝，清理本次临时文件 |
| 上传失败或临时凭证过期 | 不提交生成，凭证不保存；明确重试时重新上传 |
| 生成提交超时、返回缺少 ID | 结果未知，不自动再次提交 |
| 保存任务 ID 后退出／断网 | 恢复同一个 ID，采用既有退避与期限 |
| 取消或切换项目 | 停止本地流程，旧回包不能写当前项目；不承诺远端退款 |
| 供应商成功但视频缺失／下载无效 | 不入库，保留阶段错误与安全任务 ID |

## 官方来源与验证

- [万相 3.0](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)
- [万相 2.7](https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference)
- [百炼本地文件与临时 URL](https://help.aliyun.com/zh/model-studio/get-temporary-file-url)
- [Seedance 创建任务](https://www.volcengine.com/docs/82379/1520757)
- [MiniMax 上传](https://platform.minimaxi.com/docs/api-reference/file-management-upload)
- [MiniMax 只读文件列表](https://platform.minimaxi.com/docs/api-reference/file-management-list)：连接测试使用 `GET /v1/files/list?purpose=video_generation_input`，不使用未在本次官方说明中核实的模型列表端点。
- [MiniMax 视频 V2](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create)
- [MiniMax 查询](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-query)

## 验证与使用边界

- 全仓 `pnpm test`：1,210 项通过（Contracts 24、Context 8、LLM 32、Adapters 54、Persistence 60、Desktop 353、Worker 679）。官方运行时 5 项覆盖三家真实本地媒体、确认前零请求、提交后重开恢复入库、旧声音版本／业务空间变化拦截及取消后的迟到任务 ID。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：155 项通过、1 项既有公网下载测试忽略；最后仅调整测试操作 ID，聚焦 8 项复验通过，避免并行测试共享取消 ID。原生夹具读取实际本地文件，验证三家不同上传正文、样本哈希和状态路径，且不读取用户凭据。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`cargo fmt --check`、`git diff --check` 通过。`pnpm build` 和最终 `pnpm tauri:build` 通过，NSIS 安装包位于 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。本扩展未再次执行安装／旧版本升级／签名验收，不把打包成功等同于发布验收。
- `validate:m7-sidecar` 与 `validate:dubbing-sidecar` 在独立临时项目通过；实际打包 Worker 报告 Schema v45、随包 FFmpeg、本地 H.264 合成、源文件保留、项目导出和完整性检查通过，`paidRequests=0`。新增官方链路另由 Worker／Native／UI 三层协议夹具验证，未假称此配音 smoke 已直连三家供应商。
- `pnpm audit --prod --audit-level=high` 报告生产依赖漏洞 0；许可证检查 35 个包通过。额外全依赖审计仍报告 25 项开发工具依赖问题，本次未变更 JavaScript 依赖或锁文件；这不计入生产审计通过的结论。构建保留既有 Vite chunk 及 Rust 警告。
- 只读连接测试不等于账号已经开通每一个模型。三家均走中国官方接口；其他地域和中转连接不自动回退。
- Seedance 本地声音和图片在 Native 转为官方 Base64 输入；参考视频须使用公网 URL 或供应商素材 ID。不会伪造本地视频上传能力。
- Wan 3.0、Seedance、MiniMax H3 的参考音频用于声音参考；Wan 2.7 的 `driving_audio` 使用完整对白，不能替代音色参考生成新台词。多角色顺序和素材数量受各模型合同约束；不静默裁剪音频或丢弃参数。
- 本次工程实现不使用用户额度。协议夹具、构建或安装包生成不能证明真实供应商已接受某账号请求，也不能保证人物音色百分之百相同。真实声音还原和口型观感仍按此前约定留待付费样片验收；原配音计划的发布 HOLD 不因此解除。

操作步骤见 [角色声音与场次配音说明](./CHARACTER-VOICE-DUBBING-USER-GUIDE.md#7-角色声音样本直接生成视频)。

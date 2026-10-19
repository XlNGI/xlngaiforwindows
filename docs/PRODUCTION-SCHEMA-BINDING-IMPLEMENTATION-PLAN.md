# 制作业务与模型 Schema 对接修复

日期：2026-10-18。

## 业务规则

| 业务内容 | 与当前模型的关联 |
| --- | --- |
| 人物、环境、动作、运镜、对白和连续性 | 编译为当前模型的提示词；不将业务结构字段直接当作 API 参数 |
| 画幅、分辨率、种子、水印和扩写偏好 | 仅向 Schema 声明的字段预填；不支持时给出不阻塞的说明，保留原业务设置 |
| 剧情预计时长 | 保留剧情时长；支持请求时长时按 Schema 计算，超限分段；无请求时长字段时不伪造参数或错误要求分段 |
| 负向约束 | 有独立字段则传入，没有则作为文字约束并入提示词 |
| 环境声、音乐、对白文字 | 保留在提示词；仅在 Schema 声明开关时发送声音开关，缺少开关不等于必须先准备录音 |
| 未指定声音模式的旧文本 | 使用 auto，沿用模型默认，不强制静音；新创作的业务 Schema 同时说明声音文字与录音输入的区别 |
| 明确选用的角色音色、完整对白录音和必需素材 | 校验实际支持的输入结构及素材；无法满足时阻止提交，不能用删除声音输入绕过 |
| 参数校验、必填项和条件约束 | 以实际所选 Adapter Schema 为准；业务偏好不能添加必填字段或放宽官方合同 |

## 不变量与故障处理

编译是当前项目的只读操作。适配说明单独返回，不混入阻塞错误；前端展示说明，提交端继续复验真正的错误、来源版本和必需输入。切换模型清除不属于新 Schema 的字段；保留该模型的人工编辑，异步旧结果不能覆盖新选择。原制作指令、项目默认值和历史任务不被改写。参数语义采用明确字段映射；复杂输入能力从正向 Schema 分支读取，不把 `not` 或条件中的枚举当作支持能力。

## 顺序清单

- [x] S0 审计：确认通用输出偏好被当作硬约束、声音能力写死名单、表单合并残留字段。
- [x] S1 编译：按 Schema 投影参数，区分阻塞错误和适配说明，保留文本约束。适配器全量 134 项通过，含当前目录全部 66 个 Adapter 的逐项参数投影回归。
- [x] S2 业务关联：声音输入按 Schema 的实际结构判断，保留明确素材要求与提交复验；聚焦覆盖 native/auto 与强制录音、默认值和不可变来源。
- [x] S3 界面：显示适配说明，过滤跨模型残留字段，保留有效人工覆盖；Desktop 全量 468 项通过，包含不附加未要求的已有音频、模型切换及不阻塞的说明。
- [x] S4 验证：聚焦回归、全仓按包串行测试 1,526 项、类型检查、Lint、格式检查和生产构建通过。

## 验证记录

- `pnpm -r --workspace-concurrency=1 --if-present test`：context 8、contracts 24、LLM 32、Desktop 468、generation-adapters 134、persistence 72、Worker 788，共 1,526 项通过。
- 适配器测试逐一检查当前目录 66 个 Adapter，确保只输出目标 Schema 中存在的字段；另覆盖不支持的画幅/种子/扩写、原生声音、auto、负向约束、无时长字段、真实音频输入及必需素材。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 和 `git diff --check` 通过。默认并行全仓测试曾使既有的 5,000 条检索数据用例超时；按包串行全部通过，没有放宽该测试的超时或断言。
- 日志：`.production-schema-tests-serial.log`、`.production-schema-typecheck.log`、`.production-schema-lint.log`、`.production-schema-format.log`、`.production-schema-build.log`。

验证使用临时项目和模拟 Provider；不调用付费接口，不改写用户项目。

本次未修改原生源码，未重打或安装 Windows 安装包；实际模型生成效果仍需样片验收。

## 职责收敛修复（审计后实施）

创作指令中的声音模式表达偏好；只有实际选用的声音版本、对白录音或 required 素材构成必须满足的输入。未准备录音时不得仅因 Agent 提前选择 dialogue-driven 就锁死其他模型；保留对白原文并明确说明采用本次模型声音方式，不改写原指令。素材用途必须从业务入口保留到模型投影，角色设定板不能自动变成首帧。

- [x] R1 共用输入映射：桌面预览、Worker 和 Agent 共用 production-inputs 投影；删除前端参考输入重建及 Hook 对旧 content 的再次追加，Agent 候选筛选同时识别 images/media/content，保留非图片输入和已有顺序。
- [x] R2 用途与来源：首帧模式从明确的 first-frame 选择中取图，角色/场景板不自动替代。图片用途与素材版本进入任务来源；Worker 复验实际首帧，Agent 复用同一编译来源，模型默认时长不再覆盖业务时长。
- [x] R3 声音和渠道：未选用录音且无 required 录音时，将提前选择的录音模式适配为 auto 并说明；保留原指令和对白。必需录音、已选声音版本继续校验；渠道上传能力从 ModelBinding.inputTransport 读取。三个官方渠道的 Agent 场次制作均通过真实本地媒体夹具验证，付费调用为零。
- [x] R4 时长：无生成时长字段的编辑模型不再参与生成分段规划；实际提交时长不能短于业务剧情要求。
- [x] R5 回归：全仓 1,539 项 TypeScript/JavaScript 测试及 Rust 158 项通过（1 项既有忽略）；类型检查、Lint、格式检查、git diff --check 和生产构建通过。

### 职责收敛验证

- 全仓按包串行测试：context 8、contracts 24、LLM 32、Desktop 469、generation-adapters 139、persistence 72、Worker 795，共 1,539 项。
- 新增回归覆盖 Seedance/MiniMax/Wan 的共用参考图映射、手动媒体保留、明确首帧选择、旧录音偏好与 required 素材的区别、Agent 已有镜头来源及业务时长、来源素材版本变化、编辑模型无生成时长、Hook 重新填入时不重复追加图片。
- 三个官方渠道的 Agent 场次制作使用实际本地图片和音频夹具，经同一个 Worker 准备入口冻结声音及来源；沿用既有模拟原生提交、确认、恢复及取消回归，不发起真实付费生成。
- 最后补齐 project-asset 图片句柄的 Schema 验证，素材仍由 Worker 校验项目归属、文件哈希并转成受控输入。最终适配器全量 139 项与 Worker 制作/媒体准备/官方运行时 37 项再次通过。
- 日志：`.production-unified-final-tests.log`、`.production-unified-adapters-final.log`、`.production-unified-worker-final.log`、`.production-unified-typecheck.log`、`.production-unified-lint.log`、`.production-unified-format.log`、`.production-unified-build.log`、`.production-unified-rust.log`。

本阶段未修改用户项目或安装应用；Windows 安装包未重新打包。保留了开始实施前已有的工作区改动。

## 提交复验上下文修复（2026-10-18）

- [x] 修复填表携带 inputImages，而提交前复验遗漏 inputImages，导致无实际变化也被拒绝的问题。预览、来源刷新和提交复验共用同一个请求构造函数，保留非空及空图片选择列表。
- [x] 新增参数敏感的回归先复现“制作来源已变化，请重新适配”；修复后两种选择列表都通过复验。制作面板回归验证带所选图片的镜头实际进入 video.generate.prepare，来源中保存同一组图片。
- [x] Desktop 全量 472 项、Worker 来源校验 15 项、变更源码 ESLint、Prettier、git diff --check 与 Desktop TypeScript/Vite 构建通过。素材/剧情真实变更仍由原有来源校验阻止提交。

界面测试使用模拟 Worker，不发起真实付费生成。未修改项目数据，未重新打包或安装 Windows 应用。日志：`.production-submit-context-desktop-tests.log`、`.production-submit-context-build.log`。

# 2026-11-16 提示词模板用途隔离与 Worker 统一组装

## 问题与结果

此前会话模板混合多个创作用途，Worker 的工具策略还会重复追加默认的角色、场景和视频规范。用户修改模板后，两份创作要求可能冲突；追问任务也可能继续继承旧会话模板。

现在按通用、角色图片、场景图片、道具图片、镜头静态图、镜头视频分别编辑。前端先保存完整草稿，再提交用户原文和保存版本；Worker 校验版本并冻结任务快照，通用要求随输入发送，Agent 通过 tools.load.workflow 声明用途后只发送对应专项模板。默认内容只作为可编辑初始值或用户主动套用的内容，后台不再重复附加。当前明确请求优先，无法判断的同层冲突才澄清。

## 实现与兼容

- Contracts 统一五种专项用途、标签、默认文字和结构校验；创作语义由 Agent 判断，不按用户关键词分类。
- Schema v79 新增 conversation_prompt_template_variants 侧表，保留原通用模板行与版本。通用和专项内容在同一事务、同一 CAS 下保存。旧客户端不传专项字段时保留原值，空对象/空字符串可显式清空。
- 旧模板原文保留在通用项，不擅自拆分；已保存空值不补默认。锁占用的 v78 只读项目没有新表时仍可读取原模板，不启动写迁移。
- Worker 内部保存完整模板快照；实际 Native 请求只映射普通 prompt、上下文和工具等合同字段，不发送整套 snapshot，也不增加机位等供应商 JSON 字段。
- 当前用途的专项模板进入 taskState.userRequirements，其他用途不投影；加载普通只读工具保留用途，跨整理/恢复沿用本任务快照。追问保留原始用户要求与明确补充，使用本次提交的会话模板。
- 初始仅有 tools.load 时即说明模板优先级和用途声明，避免尚未加载写工具时缺少该规则；不需要先进入媒体生成流程才能取得模板。
- 整包制作没有 tools.load，且固定同时产出角色、场景、道具和镜头视频提示词；按该明确工作流提供这四类分别标注的模板，不带入不适用的镜头静态图模板。两协议回归覆盖完整投影、持久化恢复及新任务全部清空。
- 浮动窗口操作携带编辑用途，避免异步切换后写错模板。会话及项目 epoch 继续隔离。

只要求提示词不会因此授权图片、视频或首帧生成。项目正文仍按需检索，draft/published、附件不自动入索引、本地 SQLite、工具授权、锁和 CAS 规则不变。本轮没有素材库行为或需同步 DOCX 的产品要求变更。

## 验证与失败记录

- 首轮全仓测试在 Persistence 停止：模拟 v77 的旧测试仅删除 v78 版本记录，留下 v79 导致迁移不执行。修正为删除所有大于等于 78 的记录后，Persistence 全量 25 文件／103 项通过。同类 Worker 只读 v77 夹具一起修正。
- Desktop 全量 97 文件／878 项通过；后续相关 11 文件／215 项通过。其他已通过工作区：context 8、contracts 49、llm 32、generation-adapters 83，domain 无测试。
- 首轮 Worker 全量 101 文件／1626 项，1622 通过、4 项失败：两项新增模板测试只查 prompt，未计入正常转入 contextTurns 的任务状态；一项旧版本模拟残留 v79；一项 FFmpeg 在默认并发和构建争用下超时，清理报 EBUSY。修正断言与夹具后，受控并发下两项 FFmpeg 及只读兼容均通过，没有放宽原超时或循环保护。
- 模板切换测试继续暴露模拟 tools.load 回执缺少真实 loaded 字段，四次加载都被正确识别为同一空集合的无进展准备。补齐真实字段后，两协议用途隔离和追问继承三项聚焦通过；没有改动四次停止阈值。
- 第二轮全量 101 文件／1628 项中 1627 通过；测试运行期间补充的初始入口规则回归读取了进程缓存的旧实现而失败。最终源码的策略／工具网关／上下文管理三文件 112 项已通过；冻结实现和测试后再次执行全量，结果见下方。
- 新增旧只读模板回归，在缺少专项模板表、Schema 78、其他实例占锁时读取原文成功，确认不创建表、不回填默认。
- 打包进程验证脚本：apps/worker/scripts/validate-prompt-template-sidecar.mjs。两协议 × 两入口四组均通过；检查版本冲突、准备后编辑、模板唯一投影、只读加载、清空与新任务、实际 Native 参数及独立 SQLite 重开。每组两个任务，0 个文档、0 个媒体任务、0 次真实供应商调用。

普通路径冻结源码全量 101 文件／1628 项通过（208.32 秒）后，补齐整包模板并增加两协议两项回归。最终冻结源码完整重跑 `pnpm --filter @ai-video/worker test --maxWorkers=4 --minWorkers=1`：101 文件／1630 项全部通过，退出 0，耗时 259.05 秒，日志 .prompt-template-worker-complete.log。其他工作区全量合计 1153 项，最终全仓覆盖 2783 项；后续 Desktop 215 项为重叠定向验证，不重复累加。

最终 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check` 和 `pnpm tauri:build`（含生产构建、Sidecar、Desktop 与 NSIS）均退出 0。日志分别为 .prompt-template-typecheck-complete.log、.prompt-template-lint-complete.log、.prompt-template-format-complete.log、.prompt-template-package-complete.log；已有 Vite chunk/Rust 编译警告没有作为失败或修复效果。未修改本轮 Rust 逻辑，未重复 Rust 单元测试。

最终 Sidecar 的普通四组验证再次通过（.prompt-template-sidecar-complete.log）。整包两协议的真实打包进程也通过四类模板唯一传递、静态图模板隔离、实际分段保存、丢失应答重放及独立 SQLite 重开读回（.prompt-template-bundle-sidecar.log）。六组均为本地 scripted host，报告 Sidecar SHA-256 与最终打包一致，未调用真实供应商或启动付费任务。

日志位于本地忽略的 .prompt-template-*.log，首轮失败记录保留。

## 安装包与生效范围

安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup-prompt-template-fix-20261116.exe`，77,293,613 字节；同目录保存同名 .sha256。

- 安装包 SHA-256：`6193F3DC6AC526E6B007BD00A3FB1E20CEC0A71BF860D004240EA8337C7CCC14`
- Sidecar SHA-256：`3FCA26E941FAAD7E6D2397FE4752479102AA9DE6CCD36D09BC3F1407162658F7`
- 桌面 EXE SHA-256：`A1FEB5961E0912D1A09F946072B6AC103FD3725FF281479B7C17F2043A5BA99D`

已独立命名保留，不覆盖此前导航修复包；没有安装、重启或替换用户当前实例，没有修改现场项目数据。安装新包并重启后生效。已有任务继续使用自身冻结快照，后续新任务使用新保存版本；真实模型对创作要求的遵循效果仍需新版复测，离线传输验证不能替代内容质量验收。

# Seedance UniComp 适配代码审计

日期：2026-10-28  
范围：`doubao-seedance-2-0-260128`、`doubao-seedance-2-5-260628`  
状态：实现完成；自动化验证通过；未执行真实计费生成。

## 业务链路

1. UniComp 模型同步写入远程模型目录。`AppSettingsService.listModels()` 按 `providerType + remoteModelId` 查找精确 ModelBinding，为已有模型目录行补充官方合同、能力和动态参数 Schema。模型行是否存在以及用户是否启用模型仍由目录同步和用户设置决定；Binding 不创建模型行。
2. `ProductionPanel` 根据已回填的合同能力选择文生视频、图生视频、参考生视频和首尾帧模式。表单 Schema 直接复用官方合同，参数保留官方 `content[]` 结构及顺序。
3. Adapter 校验绑定身份和官方参数。嵌套在 `content[]` 内的受控本地图片引用由 Worker 递归物化为 Native 可读的受控文件句柄；公网音频 URL 保留在结构化参数中。UniComp 的 Binding 声明音频 `url-only`，所以本地角色声音不会被悄悄上传或转成 URL。
4. Worker 先准备可编辑草稿，冻结模型、连接、合同修订和参数。用户批准费用后，现有视频任务服务经 Native 发起 `/v1/videos` 请求；异步查询、下载、任务恢复与本地归档沿用通用 OpenAI 兼容视频生命周期。
5. Seedance 2.0/2.5 复用同一官方能力模型，但各自的官方合同边界不同：2.0 时长为 `-1` 或 4–15 秒；2.5 为 `-1` 或 4–30 秒，并支持官方 `draft` 参数。

## 原缺口与修复

原目录没有这两个 UniComp 精确 ModelBinding，因此同步行无法关联已存在的官方 Seedance 合同，UI 只能显示未配置能力。单独添加绑定仍不足以完成适配：既有校验和 Worker 媒体物化主要针对官方连接及 Wan；Native 的通用视频回退又从顶层 `prompt/images` 取值，无法完整表达 Seedance 的嵌套 `content`。

本次为两个精确远程 ID 增加 `partial` Binding，并显式声明不可取消和音频 URL-only。请求映射将 `content[].text` 提升为 UniComp 的顶层 `prompt`，完整 `content` 放进 `metadata.content`，整数 `duration` 经显式 `integer-string` 编码映射到字符串 `seconds`，其余官方字段放入 `metadata`。Native 使用受限的 `array[].field` 提取与整数编码；不执行脚本映射，且完整复制 `content` 保留图像、音频、视频、文本的相对顺序。

所有已绑定结构化视频模式统一走递归引用规范化和物化路径。结构化表单现会按 Schema 自动填充单值枚举，因此 Seedance 音频素材会带上必填的 `role: reference_audio`。旧同步行回填保持用户原有启用状态，并且重同步不会改变该状态。

## 兼容边界

- 本地图片支持经受控句柄传输；公网音频 URL 支持保留和提交。本地音频上传尚未接入 UniComp，UI 和 Worker 会明确拒绝该路径。
- 本地视频文件不在此次 UniComp 适配范围内；视频参考沿用合同规定的公网 URL。
- UniComp Binding 不能取消远端视频任务，能力覆盖为 `videoCancellation: false`。
- 模拟提交和生命周期测试不证明 UniComp 实际账户、网关路由、远端参数接受情况或计费结果；需要后续由用户在真实连接上验收。

## 主要代码位置

- `packages/contracts/src/media-model-bindings.json`：两个精确 ModelBinding 与传输映射。
- `packages/contracts/src/official-media-contracts.ts`：基于启用合同和启用 Binding 的结构化视频识别。
- `packages/generation-adapters/src/index.ts`：嵌套引用校验归一化和字段标题。
- `apps/desktop/src/StructuredParameterField.tsx`：单值枚举默认值。
- `apps/worker/src/media-preparation-service.ts`、`apps/worker/src/official-video-inputs.ts`：递归媒体准备。
- `apps/desktop/src-tauri/src/model_contract.rs`：Native 请求字段投影。

## 验证记录

- `pnpm build` 与全仓 workspace TypeScript 检查通过；`pnpm worker:sidecar` 成功生成 Worker sidecar。
- Windows Tauri release build 成功，生成 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`；仅构建，未安装或重启应用。
- Contracts 与 Generation Adapters build/typecheck 通过；适配器包 71 项测试通过。
- Desktop typecheck 通过；表单、Seedance 目录/费用审批相关用例 42 项通过。
- Worker typecheck 通过；Worker 全包 77 个测试文件、1039 项通过；目录回填、准备媒体和官方视频恢复相关 59 项复测通过。
- Rust `model_contract` 6 项测试通过，包括两模型四种模式、完整参考素材顺序、时长映射和官方字段投影。
- 全仓 ESLint、Prettier 检查、Rust 格式检查及 `git diff --check` 通过。
- 这些验证均为本地自动化测试；没有调用真实生成接口或消费额度。

## 2026-11-02 真实失败补修

真实 Seedance 2.0 请求被 UniComp 拒绝：`json: cannot unmarshal number into Go struct field .Alias.seconds of type string`。原 Binding 直接复制数字时长，原有回归也错误地接受数字；上方原始“时长映射通过”仅反映当时测试结果，不能作为线协议类型正确的证据。

修复保持官方 `duration` 为整数，仅两个 UniComp Seedance Binding 在请求编码时转为字符串，包含 `-1`；未填时长时不添加 `seconds`。正确类型的原生提交入口回归先复现失败，再验证两模型四种模式。设计、检查清单和最终验证见 [Seedance 时长传输修复](../SEEDANCE-UNICOMP-SECONDS-REPAIR-PLAN.md)。

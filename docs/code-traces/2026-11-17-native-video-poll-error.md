# 视频查询被本地误判失败及原任务恢复

## 现场证据

2026-11-17 用户截图显示两个 Seedance 视频任务在 7–8 秒内失败，界面同时显示 `Native Provider error is invalid.` 和“无法连接生成服务，请检查网络后重试”。角色、场景参考图已经显示，本次不是上一轮表单漏图问题。

只读检查项目 `好合好散说/project.sqlite`：

| 本地任务 | 服务端任务 | 本地记录 |
| --- | --- | --- |
| `23dde007-30b9-46e3-bb94-479026bedf3f` | `task_wAo32epqn44TTU9QodBabw1v4hyGXEzP` | `failed`，`failureKind=transport`，`pollAttempts=0` |
| `15e1ad5c-8c1b-4e41-a4ae-1d3166f403dd` | `task_LOYZ7tnIjy0gqh2BSQuNLXvkUPmcjg6f` | 同上 |

两条记录均使用 `REFERENCE_TO_VIDEO:unicompapi:cn.bytedance.seedance2-0.video:contract-2`，已经保存服务端任务 ID。失败发生于首次本地查询结果解析。

随后使用现有连接凭据，仅对以上两个任务执行 HTTPS GET 状态查询；两次均返回 HTTP 200、`status=completed`。凭据只在进程内读取，不输出、不写文件；没有创建、取消、重新提交生成任务，也没有修改现场项目。GET 确认的是当时远端完成状态；尚未通过用户实例验证视频下载。

项目没有保存第一次查询的原始响应，不能据此断定那次 HTTP 状态或具体服务端状态。已确认本地“失败”不能代表远端失败，不应建议重新生成。

## 根因与修复

1. Native 错误 JSON 将不存在的可选错误码序列化为 `code: null`；Worker 只接受省略字段或字符串，因而抛出 `Native Provider error is invalid.`。Native 现在省略不存在的错误码，Worker 仅对这个旧版可选字段将 null 归一为缺省；错误对象、消息、类型及未知字段仍严格校验。
2. 通用查询入口把所有 `contract-N` 模型的服务渠道覆盖为 `official-contract`，导致 Unicomp 的 `unknown` 等待状态不能使用该渠道原有兼容语义。现在保留真实渠道；旧 `contract-1` 的严格 unknown 策略显式保留，不再误套到当前 `contract-2/3`。其他未识别／缺失状态返回查询错误，不凭空归为生成失败。该分支是明确代码缺陷，但没有第一次响应，不能声称它就是现场首次状态。
3. Worker 又使用 `providerState` 覆盖 Native 已归一的 `state`，导致 `failure` / `expired` 的具体错误丢失。现在以归一状态推进任务，HTTP 非 2xx 终态诊断也保留服务端消息与错误码。
4. 非重试型本地查询错误改为暂停查询，保存原服务端 ID 与脱敏诊断；不会把无法识别的响应当成远端已失败，也不会自动提交生成。普通瞬时传输错误仍按既有退避重试。服务端明确的失败仍结束任务并保存原因。
5. 官方视频查询的取消态不再附带仅属于失败态的错误对象；成功输出省略缺省 `contentType`，失败态复用同一套脱敏错误归一。
6. 桌面区分本地查询解析失败与网络故障，显示“恢复查询”和避免重复提交的说明；暂停时显示查询异常。已转入恢复的旧记录不会继续显示不可操作的恢复建议。

## 旧误判记录的恢复边界

数据库已有“媒体终态不可改写”触发器，本次保留它，不做数据库迁移或绕过。只对同时满足以下条件的旧记录提供恢复：已有服务端 ID、没有结果、`failed` + `failureKind=transport`，且错误是精确识别的 Native 查询合同错误。真实服务端失败、取消、下载失败、普通网络错误不通过该旧记录恢复入口。

点击后原子创建一条只查询原服务端 ID 的本地恢复记录，并通过 `pollRecoveryOfJobId` / `pollRecoveryJobId` 双向关联。保留旧记录的终态、错误和时间；新记录沿用冻结的模型、连接和参数快照，使用正常查询及结果保存链路。界面标明“恢复查询 · 沿用原服务端任务”。重复点击、重开项目都复用已有恢复记录，包括已成功的记录。恢复记录不复制付费提交确认或提交幂等键，也不调用生成提交接口。普通暂停任务仍在自身记录上继续查询。

## 验证

- 修复前新增回归准确复现：Rust 缺省错误码测试失败；Worker 10 项新回归失败，分别覆盖 null 错误码、原始诊断被丢弃、本地误判终态和旧任务无法恢复；桌面网络误提示回归失败。
- 初版直接重开旧失败行被数据库 `terminal media state is immutable` 拦截；已改为上述关联恢复记录，并加入重复点击与重开幂等性回归。未放开终态限制。
- Worker 查询运行时和视频服务聚焦回归：43 项通过，含真实临时 SQLite、调度启用／关闭、终态错误保留、本地异常暂停、旧记录恢复、原任务结果只入库一次和不重新提交。
- 桌面错误展示与生产面板聚焦回归：70 项通过。
- Rust→实际已编译 Worker 回归：Native 生成的失败、缺省码、`failure` / `expired`、HTTP 400、取消、Unicomp unknown JSON 实际进入 Worker 运行时与临时 SQLite。严格拒绝原始响应、敏感字段和错误类型的原有边界继续保留。
- 本次扩大 Worker 聚焦回归到查询运行时、视频服务、Native 桥、媒体编排和 handler：5 个文件共 192 项通过。合同包全量 59 项通过；桌面聚焦 70 项通过。没有把上一轮全仓 2810 项冒称为本次重新执行。
- 最终 `cargo test --lib`：224 项通过，11 项按原配置忽略；包括真实 Native JSON→实际已编译 Worker→临时 SQLite 以及旧／新模板版本状态策略验证。日志 `video-poll-fix-rust-final.log`。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check`、`cargo fmt --check` 通过；日志 `video-poll-fix-{typecheck,lint,format}.log`。
- 首次安装包构建成功；随后补充旧 `contract-1` 兼容测试和 Native 修正，首包不作为交付，以最终构建为准。
- 最终 `pnpm tauri:build` 退出 0，完成前端、Worker Sidecar、Native Release 和 NSIS。日志 `video-poll-fix-build-final.log`。
- 最终打包 Worker 离线验收再次通过：1 次原 ID 查询、0 次付费生成提交、1 个结果素材，重复点击及项目重开幂等、原失败终态保留、数据库完整性通过。日志 `video-poll-fix-sidecar-final.log`。上一轮镜头角色／场景参考图、双正文、显式清空和重开完整性验收也再次通过，日志 `video-poll-fix-reference-sidecar-final.log`。

新增 `apps/worker/scripts/validate-video-poll-recovery-sidecar.mjs` 用于打包后离线验收：真实 Worker EXE 与临时 SQLite，脚本 Native host 仅允许原任务 GET 类查询；验证结果落库、旧终态不变、重复点击／重开幂等、完整性。它不代表真实模型调用或用户实例安装升级验证。

## 交付

最终安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup-video-poll-fix-20261117.exe`，77,331,892 字节，生成于 2026-11-17 13:46:06。

- 安装包 SHA-256：`82C5ACCBAFA301BD84143C652EA3FD33C28FB45EA6983E1FA7A213086C12A602`。
- Native EXE SHA-256：`0D38984D1658972592274CDA9141800F754E79182DCD2F4C62D0027D516A3794`。
- Worker Sidecar SHA-256：`11EA8CA7FFA0614DE49FBA5BF3122C9C3D0D2E49E9FE2DF6DF45E9D55A072698`。

上述日志位于 `C:/Users/MSI/.codex/visualizations/2026/11/13/01a1d307-6745-7c62-82f7-8b958fe66879`。本次没有安装、关闭或重启用户实例，没有改写现场项目；安装新包并重启后，可在原失败记录旁点击“恢复查询”获取已有结果，无需重新提交生成。真实视频在用户实例中的下载与画面验收尚未执行。

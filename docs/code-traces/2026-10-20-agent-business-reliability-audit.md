# Agent 业务执行审计（2026-10-20）

基线 main `98ad96d`。真实失败轨迹为 15:00–15:11 的制作指令修订；只读 SQLite 核查和纯模拟复现，未修改运行时资料。本文只记录源码问题和有界统计，不上传运行时数据库或资料正文。

| 发现 | 代码位置 | 现场／复现证据 |
|---|---|---|
| 请求预算检查在响应后 | pi-conversation-runtime.ts prepareNextTurnWithContext | 配置 24 次，实际发出 25 次；最终 stop 后任务失败。23 工具响应加 stop 成功，24 工具响应加 stop 已发送后失败 |
| 自由文本状态精确比较，未知也算冲突 | production-service.ts inspectGraph、scene-production.ts compileSceneSequence | 五个对象执行 17 次单项修改，七次返回连续性问题；两条校验路径对缺少 key 的处理不一致 |
| 结果多份展开 | agent-system-tool-service.ts scene.read | 四镜场次结果为 71,219 bytes，超过 65,536 bytes；production.read 同目标为 48,073 bytes |
| 过期指令被隐藏 | production-service.ts read | 四个旧镜头都有 6/9/9/14 秒的 timing，却被报 MISSING_SHOT_TIMING |
| 汇总覆盖原目标 | production-service.ts execute | 镜头 targetTitle 对应的 target 被覆盖为场次 ID |
| 请求幂等未覆盖无变化写入 | production-service.ts execute | 新执行键下，镜头版本 4→5、6→7、5→6、2→3 的完整 instruction 与 source_hash 均未变化，仍增加业务版本 |
| 跨工具读取重合 | scene.read / production.read | 初始 scene.read.production 与 production.read 同目标经规范化比较完全相同；角色资料各读一次，后续重读目标已有变化，不能按参数相同盲目去重 |

25 次真实 Native 请求全部 complete，32 次业务额度使用 26 次；失败原因是轮次判定，不是授权重放或 Windows 12029。最后一次制作读取 issues=[]，修订保留，SQLite quick_check=ok、foreign_key_check 无违规。

现有保护仍需保留：调用身份回放、执行键同请求重放/不同请求拒绝、CAS、事务、项目/会话围栏、付费确认、64 KiB 工具结果和检索独立预算。已有 compactRepeatedResults 仅折叠历史完全相同全文，不缓存查询，不识别嵌套重合。

既有六响应批量成功测试覆盖授权续发及 19 次业务调用，未覆盖真实单项修订逼近 24/25 次边界、长正文结果及过期/时长交叉诊断。后续以故障轨迹而非理想模型调用顺序补齐测试。实施与追踪见 [可靠性计划](../AGENT-BUSINESS-RELIABILITY-IMPLEMENTATION-PLAN.md)。
